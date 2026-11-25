import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge.js";
import { agentCwd } from "../paths.js";
import { findOnPath, killTree, spawnProcess } from "../proc.js";
import { sleep, UserError } from "../util.js";
import { REPORT_GRACE_MS, type AgentOutcome, type AgentRunOptions } from "./types.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const MAX_ATTEMPTS = 5;

export function claudeAvailable(): boolean {
  return findOnPath("claude") !== undefined;
}

interface AttemptResult {
  exitCode: number | null;
  resultEvent?: Record<string, unknown>;
  apiError?: string;
  stderrTail: string;
  spawnError?: Error;
  initModel?: string;
  toolsOk: boolean;
  mcpStatus?: string;
}

/** Errors that will not go away by retrying. */
function isFatalApiError(text: string): boolean {
  return /\b(401|403)\b|authentication|invalid api key|not logged in|please run \/login|no available channel|model[^.]*(not found|not exist|unavailable|not supported)|invalid model|credit balance|quota|billing/i.test(
    text,
  );
}

export async function runClaudeAgent(opts: AgentRunOptions): Promise<AgentOutcome> {
  if (!claudeAvailable()) {
    throw new UserError(
      "Claude Code (`claude`) was not found on PATH.",
      "Install it (npm i -g @anthropic-ai/claude-code) or use --agent openai with an OpenAI-compatible API.",
    );
  }
  const outcome: AgentOutcome = {
    agent: "claude",
    model: opts.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
  };
  const bridge = await startBridge((name, args) => opts.host.call(name, args));
  const mcpPath = join(opts.runDir, "mcp.json");
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        tryrepo: {
          type: "stdio",
          command: process.execPath,
          args: [CLI_PATH, "__mcp", String(bridge.port)],
          env: { TRYREPO_BRIDGE_TOKEN: bridge.token },
        },
      },
    }),
  );
  const sessionId = randomUUID();
  let nudges = 0;
  let input = `${opts.system}\n\n## Your task\n${opts.task}`;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (opts.signal.aborted) break;
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--mcp-config",
        mcpPath,
        "--strict-mcp-config",
        "--tools",
        "",
        "--allowedTools",
        "mcp__tryrepo",
        "--permission-mode",
        "dontAsk",
        "--disable-slash-commands",
        ...(attempt === 1 ? ["--session-id", sessionId] : ["--resume", sessionId]),
        ...(opts.model ? ["--model", opts.model] : []),
      ];
      opts.log(`[claude] attempt ${attempt}: claude ${args.join(" ")}`);
      const r = await runAttempt(args, input, opts);
      if (r.initModel) outcome.model = r.initModel;
      const ev = r.resultEvent;
      if (ev) {
        if (typeof ev.total_cost_usd === "number") outcome.costUsd = (outcome.costUsd ?? 0) + ev.total_cost_usd;
        if (typeof ev.num_turns === "number") outcome.turns += ev.num_turns;
        const usage = (ev.usage ?? {}) as Record<string, unknown>;
        outcome.inputTokens += num(usage.input_tokens) + num(usage.cache_creation_input_tokens);
        outcome.cacheReadTokens += num(usage.cache_read_input_tokens);
        outcome.outputTokens += num(usage.output_tokens);
      }
      if (opts.host.report || opts.signal.aborted) break;
      if (Date.now() > opts.deadline + REPORT_GRACE_MS) {
        outcome.error = "the agent ran out of time without reporting";
        break;
      }
      if (r.spawnError) {
        outcome.error = `could not start claude: ${r.spawnError.message}`;
        break;
      }
      if (!r.toolsOk) {
        outcome.error = `the tryrepo tools did not load in Claude Code (MCP status: ${r.mcpStatus ?? "unknown"}). ${r.stderrTail}`.trim();
        break;
      }
      const errText = r.apiError ?? (ev?.is_error === true ? String(ev.result ?? "") : undefined);
      if (errText || (!ev && r.exitCode !== 0)) {
        const message = errText || r.stderrTail || `claude exited with code ${r.exitCode}`;
        if (isFatalApiError(message)) {
          outcome.error = `Claude Code could not reach its model: ${message}`;
          break;
        }
        if (attempt === MAX_ATTEMPTS) {
          outcome.error = `Claude Code kept failing: ${message}`;
          break;
        }
        const wait = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
        opts.log(`[claude] transient error, retrying in ${wait / 1000}s: ${message}`);
        opts.onText?.(`(agent interrupted: ${message.slice(0, 120)} — resuming)`);
        await sleep(wait, opts.signal);
        input =
          "Continue the task from where you stopped (your previous turn was interrupted by an API error). Finish with report_success or report_failure.";
        continue;
      }
      // The agent ended its turn normally but never reported.
      if (nudges >= 2) {
        outcome.error = "the agent stopped without reporting a result";
        break;
      }
      nudges++;
      input =
        "You stopped before calling report_success or report_failure. Continue the task now, and finish by calling one of them.";
    }
  } finally {
    await bridge.close();
    try {
      unlinkSync(mcpPath);
    } catch {
      /* ignore */
    }
  }
  return outcome;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function runAttempt(args: string[], input: string, opts: AgentRunOptions): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const result: AttemptResult = { exitCode: null, stderrTail: "", toolsOk: true };
    let child: ChildProcess;
    try {
      child = spawnProcess("claude", args, {
        cwd: agentCwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      result.spawnError = err as Error;
      resolve(result);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => killTree(child);
    opts.signal.addEventListener("abort", onAbort, { once: true });

    // Stop the CLI shortly after a report arrives, or when the time is over.
    let reportSeenAt = 0;
    const watch = setInterval(() => {
      const now = Date.now();
      if (opts.host.report && !reportSeenAt) reportSeenAt = now;
      if ((reportSeenAt && now - reportSeenAt > 20_000) || now > opts.deadline + REPORT_GRACE_MS) killTree(child);
    }, 1000);

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      opts.log(`[claude:out] ${line.length > 4000 ? `${line.slice(0, 4000)}…` : line}`);
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (ev.type === "system" && ev.subtype === "init") {
        if (typeof ev.model === "string") result.initModel = ev.model;
        const tools = Array.isArray(ev.tools) ? (ev.tools as unknown[]) : [];
        const servers = Array.isArray(ev.mcp_servers) ? (ev.mcp_servers as Record<string, unknown>[]) : [];
        const ours = servers.find((s) => s.name === "tryrepo");
        result.mcpStatus = typeof ours?.status === "string" ? ours.status : undefined;
        if (!tools.includes("mcp__tryrepo__exec")) {
          result.toolsOk = false;
          killTree(child);
        }
      } else if (ev.type === "assistant") {
        const message = ev.message as { content?: unknown[] } | undefined;
        for (const block of message?.content ?? []) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            if (/^API Error/i.test(b.text.trim())) result.apiError = b.text.trim();
            else opts.onText?.(b.text);
          }
        }
      } else if (ev.type === "result") {
        result.resultEvent = ev;
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      result.stderrTail = (result.stderrTail + c).slice(-2000);
      opts.log(`[claude:err] ${c.trimEnd()}`);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    let childClosed = false;
    let linesDone = false;
    rl.on("close", () => {
      linesDone = true;
      if (childClosed) finish();
    });
    child.on("error", (err) => {
      result.spawnError = err;
      finish();
    });
    child.on("close", (code) => {
      result.exitCode = code;
      result.stderrTail = result.stderrTail.trim();
      childClosed = true;
      if (linesDone) finish();
      else setTimeout(finish, 2000);
    });
  });
}
