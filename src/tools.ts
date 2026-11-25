import type { Sandbox } from "./sandbox.js";
import { START_SCRIPT, WORKSPACE } from "./sandbox.js";
import { ENV_NAME_RE, errorMessage, formatDuration, oneLine } from "./util.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface EnvRequirement {
  name: string;
  description?: string;
  required: boolean;
}

export type Report =
  | {
      outcome: "success";
      kind: "web" | "cli";
      port?: number;
      path: string;
      title?: string;
      usage: string;
      requiredEnv: EnvRequirement[];
      notes?: string;
    }
  | { outcome: "failure"; reason: "unsupported" | "failed"; summary: string };

export interface ToolEvent {
  phase: "start" | "end";
  tool: string;
  summary: string;
  ok?: boolean;
  ms?: number;
  detail?: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "exec",
    description:
      "Run a bash command inside the sandbox (fresh login shell, default cwd /workspace, no stdin). " +
      "Returns the exit code and output (long output is truncated in the middle). " +
      "Use start_background for servers or anything that does not exit.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command(s) to run" },
        cwd: { type: "string", description: "Working directory (default /workspace)" },
        timeout_sec: { type: "integer", minimum: 1, maximum: 1800, description: "Kill after this many seconds (default 600)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "start_background",
    description:
      "Start a long-running command (e.g. a dev server) detached from the tool call. Returns immediately with the path of the log file that receives its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to start" },
        cwd: { type: "string", description: "Working directory (default /workspace)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the sandbox. Relative paths are relative to /workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_start",
    description:
      `Check that ${START_SCRIPT} works the way the user will run it: stops ALL processes in the sandbox (like a fresh container), ` +
      `runs ${START_SCRIPT} from ${WORKSPACE}, then polls http://<sandbox-ip>:<port><path> until any HTTP response arrives. ` +
      "Required before report_success for web apps.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Port the app listens on (must be bound to 0.0.0.0)" },
        path: { type: "string", description: "URL path to request (default /)" },
        timeout_sec: { type: "integer", minimum: 5, maximum: 900, description: "How long to wait for the app (default 120)" },
      },
      required: ["port"],
      additionalProperties: false,
    },
  },
  {
    name: "report_success",
    description:
      "Finish: the project is set up. For kind=web, verify_start must have passed on the same port. Call exactly once, as the very last action.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["web", "cli"], description: "web = serves HTTP; cli = command-line tool or library" },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "kind=web: the port verify_start passed on" },
        path: { type: "string", description: "kind=web: URL path to open first (default /)" },
        title: { type: "string", description: "What the project is, in one short line" },
        usage: {
          type: "string",
          description: "1-5 short lines for the user: what to open or click, or the exact commands to type in the sandbox shell",
        },
        required_env: {
          type: "array",
          description: "Environment variables the user should provide (API keys etc.)",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean", description: "true if the app does not work at all without it" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
        notes: { type: "string", description: "Limitations, placeholders used, code you had to patch" },
      },
      required: ["kind", "usage"],
      additionalProperties: false,
    },
  },
  {
    name: "report_failure",
    description: "Finish: the project cannot be run here. Call exactly once, as the very last action.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: ["unsupported", "failed"],
          description: "unsupported = needs GPU/desktop GUI/phone/special hardware/paid account, or is not runnable software; failed = you tried and could not make it work",
        },
        summary: { type: "string", description: "One to three sentences explaining why" },
      },
      required: ["reason", "summary"],
      additionalProperties: false,
    },
  },
];

const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/?-]{0,500}$/;

export interface ToolHostOptions {
  /** Epoch ms after which only report tools are accepted. */
  deadline: number;
  startedAt: number;
  onEvent?: (e: ToolEvent) => void;
  /** Full transcript of tool calls, for debugging. */
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

type Args = Record<string, unknown>;

export class ToolHost {
  report?: Report;
  /** port -> path that verify_start passed on */
  readonly verified = new Map<number, string>();
  calls = 0;
  private readonly now: () => number;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly opts: ToolHostOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  private footer(): string {
    const used = this.now() - this.opts.startedAt;
    const total = this.opts.deadline - this.opts.startedAt;
    return `\n[tryrepo] ${formatDuration(used)} of ${formatDuration(total)} used`;
  }

  private overTime(): boolean {
    return this.now() > this.opts.deadline;
  }

  async call(name: string, rawArgs: unknown): Promise<ToolResult> {
    this.calls++;
    const args: Args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Args) : {};
    const started = this.now();
    let result: ToolResult;
    let summary = name;
    try {
      if (this.report && name !== "report_success" && name !== "report_failure") {
        result = { text: "The task is already finished (a report was submitted). Stop now.", isError: true };
      } else if (this.overTime() && name !== "report_success" && name !== "report_failure") {
        result = {
          text:
            "Time is up. Call report_success now if verify_start already passed (or the CLI works); otherwise call report_failure with what you learned.",
          isError: true,
        };
      } else {
        switch (name) {
          case "exec":
            summary = `$ ${oneLine(String(args.command ?? ""), 90)}`;
            this.opts.onEvent?.({ phase: "start", tool: name, summary });
            result = await this.exec(args);
            break;
          case "start_background":
            summary = `& ${oneLine(String(args.command ?? ""), 90)}`;
            this.opts.onEvent?.({ phase: "start", tool: name, summary });
            result = await this.startBackground(args);
            break;
          case "write_file":
            summary = `✎ ${oneLine(String(args.path ?? ""), 90)}`;
            this.opts.onEvent?.({ phase: "start", tool: name, summary });
            result = await this.writeFile(args);
            break;
          case "verify_start":
            summary = `▶ verify port ${String(args.port ?? "?")}${typeof args.path === "string" ? args.path : "/"}`;
            this.opts.onEvent?.({ phase: "start", tool: name, summary });
            result = await this.verifyStart(args);
            break;
          case "report_success":
            result = this.reportSuccess(args);
            break;
          case "report_failure":
            result = this.reportFailure(args);
            break;
          default:
            result = { text: `Unknown tool: ${name}`, isError: true };
        }
      }
    } catch (err) {
      result = { text: `tryrepo internal error: ${errorMessage(err)}`, isError: true };
    }
    const ms = this.now() - started;
    if (name !== "report_success" && name !== "report_failure") {
      this.opts.onEvent?.({ phase: "end", tool: name, summary, ok: !result.isError, ms });
      result = { ...result, text: result.text + this.footer() };
    }
    this.opts.log?.({ at: new Date(started).toISOString(), tool: name, args, ms, isError: result.isError, result: result.text });
    return result;
  }

  private str(args: Args, key: string, required: true): string;
  private str(args: Args, key: string, required?: false): string | undefined;
  private str(args: Args, key: string, required = false): string | undefined {
    const v = args[key];
    if (v === undefined || v === null || v === "") {
      if (required) throw new ArgError(`"${key}" is required`);
      return undefined;
    }
    if (typeof v !== "string") throw new ArgError(`"${key}" must be a string`);
    return v;
  }

  private int(args: Args, key: string, min: number, max: number): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw new ArgError(`"${key}" must be an integer between ${min} and ${max}`);
    }
    return n;
  }

  private cwd(args: Args): string | undefined {
    const cwd = this.str(args, "cwd");
    if (cwd === undefined) return undefined;
    if (cwd.includes("\0")) throw new ArgError(`"cwd" is invalid`);
    return cwd.startsWith("/") ? cwd : `${WORKSPACE}/${cwd}`;
  }

  private async exec(args: Args): Promise<ToolResult> {
    try {
      const command = this.str(args, "command", true);
      const timeoutSec = this.int(args, "timeout_sec", 1, 1800) ?? 600;
      const r = await this.sandbox.exec(command, { cwd: this.cwd(args), timeoutSec });
      let status = `exit code: ${r.exitCode} (${formatDuration(r.durationMs)})`;
      if (r.exitCode === 124) status += ` — timed out after ${timeoutSec}s and was stopped`;
      else if (r.exitCode === 137) status += " — killed (timeout or out of memory)";
      const output = r.output.trim() ? r.output.replace(/\s+$/, "") : "(no output)";
      return { text: `${status}\n${output}`, isError: r.exitCode !== 0 };
    } catch (err) {
      return argErrorResult(err);
    }
  }

  private async startBackground(args: Args): Promise<ToolResult> {
    try {
      const command = this.str(args, "command", true);
      const { pid, logFile } = await this.sandbox.startBackground(command, { cwd: this.cwd(args) });
      return {
        text: `started${pid ? ` (pid ${pid})` : ""}. Output goes to ${logFile} — check it with: tail -n 50 ${logFile}`,
        isError: false,
      };
    } catch (err) {
      return argErrorResult(err);
    }
  }

  private async writeFile(args: Args): Promise<ToolResult> {
    try {
      const path = this.str(args, "path", true);
      const content = args.content;
      if (typeof content !== "string") throw new ArgError(`"content" must be a string`);
      if (path.includes("\0")) throw new ArgError(`"path" is invalid`);
      const written = await this.sandbox.writeFile(path, content);
      return { text: `wrote ${written} (${Buffer.byteLength(content, "utf8")} bytes)`, isError: false };
    } catch (err) {
      return argErrorResult(err);
    }
  }

  private async verifyStart(args: Args): Promise<ToolResult> {
    try {
      const port = this.int(args, "port", 1, 65535);
      if (port === undefined) throw new ArgError(`"port" is required`);
      const path = this.str(args, "path") ?? "/";
      if (!PATH_RE.test(path)) throw new ArgError(`"path" must start with / and contain only URL characters`);
      const timeoutSec = this.int(args, "timeout_sec", 5, 900) ?? 120;
      const r = await this.sandbox.verifyStart(port, path, timeoutSec);
      const log = r.log.trim() ? `\n--- start.sh output (last lines) ---\n${r.log.trim()}` : "\n(start.sh printed nothing)";
      switch (r.status) {
        case "ok":
          this.verified.set(port, path);
          return {
            text: `PASSED: port ${port}${path} answered HTTP ${r.httpCode} after ${r.seconds}s in a fresh start.${log}`,
            isError: false,
          };
        case "missing":
          return { text: `FAILED: ${START_SCRIPT} does not exist. Write it with write_file first.`, isError: true };
        case "exited":
          return {
            text: `FAILED: ${START_SCRIPT} exited after ${r.seconds}s before anything answered on port ${port}. It must keep the app running in the foreground.${log}`,
            isError: true,
          };
        case "timeout":
          if (r.localCode !== "000") {
            return {
              text: `FAILED: the app answers on 127.0.0.1:${port} (HTTP ${r.localCode}) but not on the sandbox network address, so the user's browser could not reach it. Make it listen on 0.0.0.0 instead of localhost/127.0.0.1.${log}`,
              isError: true,
            };
          }
          return {
            text: `FAILED: nothing answered HTTP on port ${port} within ${timeoutSec}s. Check the port, whether it is still starting (raise timeout_sec), and the output below.${log}`,
            isError: true,
          };
        default:
          return { text: `FAILED: verification could not run: ${r.log}`, isError: true };
      }
    } catch (err) {
      return argErrorResult(err);
    }
  }

  private reportSuccess(args: Args): ToolResult {
    try {
      const kind = this.str(args, "kind", true);
      if (kind !== "web" && kind !== "cli") throw new ArgError(`"kind" must be "web" or "cli"`);
      const usage = this.str(args, "usage", true).slice(0, 2000);
      const title = this.str(args, "title")?.slice(0, 200);
      const notes = this.str(args, "notes")?.slice(0, 3000);
      const requiredEnv = parseEnvRequirements(args.required_env);
      let port: number | undefined;
      let path = "/";
      if (kind === "web") {
        port = this.int(args, "port", 1, 65535);
        if (port === undefined) throw new ArgError(`"port" is required for kind=web`);
        const verifiedPath = this.verified.get(port);
        if (verifiedPath === undefined) {
          throw new ArgError(
            `verify_start has not passed for port ${port}. Call verify_start with port ${port} and make it pass before reporting success.`,
          );
        }
        path = this.str(args, "path") ?? verifiedPath;
        if (!PATH_RE.test(path)) throw new ArgError(`"path" must start with / and contain only URL characters`);
      }
      this.report = { outcome: "success", kind, port, path, title, usage, requiredEnv, notes };
      return { text: "Recorded. You are done: do not call any more tools. Reply with one short sentence.", isError: false };
    } catch (err) {
      return argErrorResult(err);
    }
  }

  private reportFailure(args: Args): ToolResult {
    try {
      const reason = this.str(args, "reason", true);
      if (reason !== "unsupported" && reason !== "failed") throw new ArgError(`"reason" must be "unsupported" or "failed"`);
      const summary = this.str(args, "summary", true).slice(0, 3000);
      this.report = { outcome: "failure", reason, summary };
      return { text: "Recorded. You are done: do not call any more tools. Reply with one short sentence.", isError: false };
    } catch (err) {
      return argErrorResult(err);
    }
  }
}

class ArgError extends Error {}

function argErrorResult(err: unknown): ToolResult {
  if (err instanceof ArgError) return { text: `Invalid arguments: ${err.message}`, isError: true };
  return { text: `Error: ${errorMessage(err)}`, isError: true };
}

function parseEnvRequirements(value: unknown): EnvRequirement[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ArgError(`"required_env" must be an array`);
  const out: EnvRequirement[] = [];
  for (const item of value.slice(0, 30)) {
    if (!item || typeof item !== "object") throw new ArgError(`"required_env" items must be objects`);
    const { name, description, required } = item as Record<string, unknown>;
    if (typeof name !== "string" || !ENV_NAME_RE.test(name)) {
      throw new ArgError(`"required_env" names must look like ENV_VAR_NAME`);
    }
    out.push({
      name,
      description: typeof description === "string" ? description.slice(0, 300) : undefined,
      required: required === true,
    });
  }
  return out;
}
