import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaudeAgent } from "./agents/claude.js";
import { runOpenAIAgent, type OpenAIConfig } from "./agents/openai.js";
import type { AgentOutcome } from "./agents/types.js";
import {
  commitContainer,
  docker,
  imageExists,
  LABEL,
  pullImage,
  removeContainer,
  runContainer,
} from "./docker.js";
import type { RepoMeta } from "./github.js";
import { newRunDir } from "./paths.js";
import { buildPrompt } from "./prompt.js";
import type { Recipe } from "./recipe.js";
import { DockerSandbox, KEEPALIVE_CMD, shQuote, START_SCRIPT, WORKSPACE } from "./sandbox.js";
import { slugFor, type Source } from "./source.js";
import { ToolHost, type Report } from "./tools.js";
import type { Ui } from "./ui.js";
import { errorMessage, formatDuration, oneLine, randomId, UserError } from "./util.js";

export const DEFAULT_IMAGE = "node:22-bookworm";
export const PIDS_LIMIT = 8192;

/** Non-secret environment for every sandbox: keep tools non-interactive and logs plain. */
export const SANDBOX_ENV: Record<string, string> = {
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PYTHONUNBUFFERED: "1",
  npm_config_yes: "true",
  npm_config_fund: "false",
  npm_config_audit: "false",
  NO_COLOR: "1",
  TERM: "dumb",
};

export type AgentKind = "claude" | "openai";

export interface BuildOptions {
  source: Source;
  meta?: RepoMeta;
  agent: AgentKind;
  model?: string;
  openai?: OpenAIConfig;
  timeoutMin: number;
  baseImage: string;
  memoryBytes: number;
  secretEnv: Record<string, string>;
  keep: boolean;
  ui: Ui;
  signal: AbortSignal;
}

export interface BuildResult {
  runId: string;
  runDir: string;
  report?: Report;
  recipe?: Recipe;
  outcome?: AgentOutcome;
  commit?: string;
  buildMs: number;
  /** Infrastructure problem (clone failed, agent unavailable...), as opposed to a project that can't run. */
  error?: string;
  builder?: string;
}

const DEFAULT_PATH_ENTRIES = new Set(["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]);

/** Debian's /etc/profile resets PATH for login shells; keep the image's extra PATH entries. */
async function preserveImagePath(sandboxName: string): Promise<void> {
  const r = await docker(["exec", sandboxName, "printenv", "PATH"], { timeoutMs: 30_000 });
  const extra = r.stdout
    .trim()
    .split(":")
    .filter((p) => p && !DEFAULT_PATH_ENTRIES.has(p) && /^\/[A-Za-z0-9_.\/+-]*$/.test(p));
  const script = extra.length ? `export PATH="${extra.join(":")}:$PATH"\n` : "# nothing to add\n";
  await docker(["exec", "-i", sandboxName, "sh", "-c", "mkdir -p /etc/profile.d /tryrepo /tmp/tryrepo && cat > /etc/profile.d/00-tryrepo-path.sh"], {
    input: script,
    timeoutMs: 30_000,
  });
}

function cloneCommand(source: Extract<Source, { type: "git" }>): string {
  const url = shQuote(source.url);
  const ref = source.ref;
  if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
    return [
      "git init -q .",
      `git remote add origin ${url}`,
      `git fetch -q --depth 1 origin ${shQuote(ref)}`,
      "git checkout -q FETCH_HEAD",
      "git submodule update -q --init --recursive --depth 1",
    ].join(" && ");
  }
  if (ref && /^[0-9a-f]{7,39}$/i.test(ref)) {
    return `git clone -q --recurse-submodules ${url} . && git checkout -q ${shQuote(ref)} && git submodule update -q --init --recursive`;
  }
  const branch = ref ? ` --branch=${shQuote(ref)}` : "";
  return `git clone -q --depth 1 --recurse-submodules --shallow-submodules${branch} ${url} .`;
}

export function imageTagFor(source: Source, commit: string | undefined, runId: string): string {
  const tag = commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 12).toLowerCase() : runId.toLowerCase();
  return `tryrepo/${slugFor(source)}:${tag}`;
}

export async function ensureImage(image: string, ui: Ui): Promise<void> {
  if (await imageExists(image)) return;
  ui.step(`Downloading the sandbox image ${image} (first run only)…`);
  let last = -1;
  await pullImage(image, (done, total) => {
    const pct = total ? Math.floor((done / total) * 10) : 0;
    if (pct !== last && total > 2) {
      last = pct;
      ui.detail(`layers ${done}/${total}`);
    }
  });
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const { source, ui } = opts;
  const started = Date.now();
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomId(3)}`;
  const runDir = newRunDir(runId);
  const logFile = join(runDir, "agent.log");
  const log = (line: string) => {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      /* logging must never break a run */
    }
  };
  const result: BuildResult = { runId, runDir, buildMs: 0 };
  const name = `${LABEL}-build-${slugFor(source).slice(0, 40)}-${randomId(2)}`;
  let created = false;

  try {
    await ensureImage(opts.baseImage, ui);
    if (opts.signal.aborted) return result;

    ui.step("Starting a sandbox container…");
    await runContainer({
      name,
      image: opts.baseImage,
      labels: { [LABEL]: "1", [`${LABEL}.role`]: "build", [`${LABEL}.run`]: runId },
      env: SANDBOX_ENV,
      memoryBytes: opts.memoryBytes,
      pidsLimit: PIDS_LIMIT,
      workdir: WORKSPACE,
      cmd: KEEPALIVE_CMD,
    });
    created = true;
    result.builder = name;
    await preserveImagePath(name);
    const sandbox = new DockerSandbox(name, opts.secretEnv);

    // Fetch the source inside the sandbox.
    if (source.type === "git") {
      ui.step(`Cloning ${source.display}…`);
      const r = await sandbox.exec(cloneCommand(source), { timeoutSec: 20 * 60 });
      if (r.exitCode !== 0) {
        result.error = `git clone failed: ${oneLine(r.output, 400) || `exit ${r.exitCode}`}`;
        return result;
      }
      const head = await sandbox.exec("git rev-parse HEAD", { timeoutSec: 60 });
      const sha = head.output.trim().split("\n").pop()?.trim();
      if (head.exitCode === 0 && sha && /^[0-9a-f]{40}$/.test(sha)) result.commit = sha;
    } else {
      ui.step(`Copying ${source.path} into the sandbox…`);
      const r = await docker(["cp", `${source.path}${source.path.endsWith("/") || source.path.endsWith("\\") ? "" : "/"}.`, `${name}:${WORKSPACE}`], {
        timeoutMs: 20 * 60_000,
      });
      if (r.code !== 0) {
        result.error = `copying the directory failed: ${oneLine(r.stderr || r.stdout, 400)}`;
        return result;
      }
    }
    if (opts.signal.aborted) return result;

    const startedAgent = Date.now();
    const deadline = startedAgent + opts.timeoutMin * 60_000;
    const host = new ToolHost(sandbox, {
      startedAt: startedAgent,
      deadline,
      onEvent: (e) => ui.tool(e),
      log: (entry) => log(JSON.stringify(entry)),
    });
    const prompt = buildPrompt({
      display: source.display,
      url: source.type === "git" ? source.url.replace(/\.git$/, "") : undefined,
      commit: result.commit,
      description: opts.meta?.description,
      subdir: source.type === "git" ? source.subdir : undefined,
      minutes: opts.timeoutMin,
      envNames: Object.keys(opts.secretEnv),
      baseImage: opts.baseImage,
    });
    writeFileSync(join(runDir, "prompt.md"), `${prompt.system}\n\n## Your task\n${prompt.task}\n`);

    ui.step(`Agent (${opts.agent}${opts.model ? `, ${opts.model}` : ""}) is setting it up — budget ${opts.timeoutMin} min`);
    const agentOpts = {
      system: prompt.system,
      task: prompt.task,
      host,
      runDir,
      deadline,
      model: opts.model,
      signal: opts.signal,
      onText: (t: string) => ui.agentText(t),
      log,
    };
    try {
      result.outcome =
        opts.agent === "claude"
          ? await runClaudeAgent(agentOpts)
          : await runOpenAIAgent({ ...agentOpts, config: requireConfig(opts.openai) });
    } catch (err) {
      if (err instanceof UserError) throw err;
      result.error = `the agent crashed: ${errorMessage(err)}`;
      return result;
    }
    result.report = host.report;
    if (!host.report) {
      result.error = result.outcome.error ?? (opts.signal.aborted ? "cancelled" : "the agent finished without a result");
      return result;
    }
    if (host.report.outcome !== "success" || opts.signal.aborted) return result;

    // Save the finished sandbox as an image so the next start takes seconds.
    ui.step("Saving the build for next time…");
    await docker(["exec", name, "bash", "-c", "kill -TERM -1 2>/dev/null; sleep 5; kill -KILL -1 2>/dev/null; sync; true"], {
      timeoutMs: 60_000,
    });
    const image = imageTagFor(source, result.commit, runId);
    await commitContainer(name, image, [
      `WORKDIR ${WORKSPACE}`,
      `CMD ["bash", "-l", "${START_SCRIPT}"]`,
      `LABEL ${LABEL}="1"`,
    ]);
    const report = host.report;
    result.recipe = {
      version: 1,
      key: source.key,
      display: source.display,
      url: source.type === "git" ? source.url : undefined,
      ref: source.type === "git" ? source.ref : undefined,
      commit: result.commit,
      image,
      kind: report.kind,
      port: report.port,
      path: report.path,
      title: report.title,
      usage: report.usage,
      requiredEnv: report.requiredEnv,
      notes: report.notes,
      agent: opts.agent,
      model: result.outcome.model,
      buildSeconds: Math.round((Date.now() - started) / 1000),
      createdAt: new Date().toISOString(),
    };
    return result;
  } finally {
    result.buildMs = Date.now() - started;
    // A cancelled run keeps the container only when the user asked to; otherwise it leaks.
    if (created && !(opts.keep && !opts.signal.aborted)) await removeContainer(name);
    writeFileSync(
      join(runDir, "result.json"),
      `${JSON.stringify({ ...result, source: source.display, buildTime: formatDuration(result.buildMs) }, null, 2)}\n`,
    );
  }
}

function requireConfig(cfg: OpenAIConfig | undefined): OpenAIConfig {
  if (!cfg) throw new UserError("The openai agent needs OPENAI_API_KEY and a model (--model or OPENAI_MODEL).");
  return cfg;
}
