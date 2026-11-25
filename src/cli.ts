#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { claudeAvailable } from "./agents/claude.js";
import type { OpenAIConfig } from "./agents/openai.js";
import { runBench } from "./bench.js";
import {
  dockerInfo,
  imageExists,
  LABEL,
  listContainers,
  listImages,
  removeContainer,
  removeImage,
} from "./docker.js";
import { fetchRepoMeta, type RepoMeta } from "./github.js";
import { homeDir } from "./paths.js";
import { build, DEFAULT_IMAGE, type AgentKind } from "./pipeline.js";
import { deleteRecipe, listRecipes, loadRecipe, saveRecipe, type Recipe } from "./recipe.js";
import { followLogs, openBrowser, runShell, shellCommand, startWeb } from "./runner.js";
import { parseSource, type Source } from "./source.js";
import { consoleUi, type Ui } from "./ui.js";
import {
  errorMessage,
  formatCount,
  formatDuration,
  oneLine,
  parseEnvFlags,
  parseMemory,
  sanitize,
  UserError,
} from "./util.js";

const require = createRequire(import.meta.url);
const VERSION: string = (require("../../package.json") as { version: string }).version;

const HELP = `tryrepo ${VERSION} — paste a GitHub URL, your coding agent gets it running in a local Docker sandbox.

Usage
  tryrepo <repo> [options]       set up (or reuse) a sandbox for <repo> and start it
  tryrepo list                   saved builds and running apps
  tryrepo stop [name] [--all]    stop running apps
  tryrepo rm <repo> | --all      delete saved builds
  tryrepo bench <file>           run every repo listed in <file> and report how many work

<repo> can be owner/repo, owner/repo#ref, a GitHub/GitLab/... https URL, or a local ./directory.

Options
  --agent <claude|openai>   coding agent (default: claude if installed, else openai)
  --model <name>            model for the agent (claude: its default; openai: required or OPENAI_MODEL)
  --base-url <url>          OpenAI-compatible API base URL (default: OPENAI_BASE_URL or api.openai.com)
  -e, --env NAME[=VALUE]    pass an environment variable (e.g. an API key) into the sandbox
  --ref <ref>               branch, tag or commit to check out
  --port <n>                host port for web apps (default: random free port)
  --open                    open the app in your browser
  -d, --detach              keep the app running in the background and exit
  --refresh                 ignore the saved build and set up again
  --timeout <minutes>       time budget for the agent (default 30)
  --memory <size>           sandbox memory limit, e.g. 4g (default: 75% of Docker's memory, max 8g)
  --image <image>           base image for new sandboxes (default ${DEFAULT_IMAGE})
  --keep                    keep the build container afterwards (debugging)
  --json                    print a JSON result on stdout (implies --detach)
  --parallel <n>            bench: projects to set up at the same time (default 2)
  --out <dir>               bench: where to write results (default ./bench-results)
  -h, --help                show this help
  -v, --version             show the version

Examples
  tryrepo vitejs/vite --open
  tryrepo https://github.com/streamlit/streamlit-example
  tryrepo some/ai-app -e OPENAI_API_KEY
  tryrepo some/app --agent openai --base-url https://api.deepseek.com/v1 --model deepseek-chat

Everything runs inside Docker: the project never touches your files, and your agent's
credentials stay on your machine. State lives in ${homeDir()}.
`;

const OPTIONS = {
  agent: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  env: { type: "string", short: "e", multiple: true },
  ref: { type: "string" },
  port: { type: "string" },
  open: { type: "boolean" },
  detach: { type: "boolean", short: "d" },
  refresh: { type: "boolean" },
  timeout: { type: "string" },
  memory: { type: "string" },
  image: { type: "string" },
  keep: { type: "boolean" },
  json: { type: "boolean" },
  parallel: { type: "string" },
  out: { type: "string" },
  all: { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

const controller = new AbortController();
let interrupts = 0;

function onInterrupt() {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  process.stderr.write("\nStopping… (press Ctrl+C again to force)\n");
  controller.abort();
}

function intOption(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`--${name} must be a whole number between ${min} and ${max}`);
  return n;
}

function pickAgent(flag: string | undefined): AgentKind {
  if (flag !== undefined) {
    if (flag !== "claude" && flag !== "openai") throw new UserError(`Unknown agent "${flag}"`, "Use --agent claude or --agent openai.");
    return flag;
  }
  if (claudeAvailable()) return "claude";
  if (process.env.OPENAI_API_KEY) return "openai";
  throw new UserError(
    "No coding agent found.",
    "Install Claude Code (https://claude.com/claude-code), or set OPENAI_API_KEY for any OpenAI-compatible API and use --agent openai --model <name>.",
  );
}

function openaiConfig(values: Values): OpenAIConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = values.model ?? process.env.OPENAI_MODEL;
  if (!apiKey) throw new UserError("--agent openai needs OPENAI_API_KEY in your environment.");
  if (!model) throw new UserError("--agent openai needs a model: pass --model <name> or set OPENAI_MODEL.");
  const baseUrl = values["base-url"] ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new UserError(`Invalid --base-url: ${baseUrl}`);
  return { apiKey, model, baseUrl };
}

function memoryFor(values: Values, dockerMem: number): number {
  if (values.memory !== undefined) {
    const bytes = parseMemory(values.memory);
    if (!bytes || bytes < 512 * 1024 ** 2) throw new UserError("--memory must be a size of at least 512m, e.g. 4g");
    return bytes;
  }
  const cap = 8 * 1024 ** 3;
  return dockerMem > 0 ? Math.min(cap, Math.floor(dockerMem * 0.75)) : 4 * 1024 ** 3;
}

function header(ui: Ui, source: Source, meta?: RepoMeta) {
  const facts = meta ? [`★ ${formatCount(meta.stars)}`, meta.language].filter(Boolean).join(" · ") : "";
  ui.line(`${ui.bold("tryrepo")} ${ui.dim("›")} ${ui.bold(source.display)}${facts ? `  ${ui.dim(facts)}` : ""}`);
  if (meta?.description) ui.detail(oneLine(meta.description, 120));
  if (meta?.archived) ui.warn("This repository is archived; it may no longer build.");
}

function printUsage(ui: Ui, recipe: Recipe, secretEnv: Record<string, string>) {
  if (recipe.title) ui.line(`  ${oneLine(recipe.title, 120)}`);
  for (const line of sanitize(recipe.usage).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8)) {
    ui.line(`  ${ui.cyan("›")} ${oneLine(line, 160)}`);
  }
  const missing = recipe.requiredEnv.filter((e) => !(e.name in secretEnv));
  if (missing.length) {
    ui.line();
    for (const e of missing) {
      ui.warn(`${e.name}${e.required ? " (required)" : ""}${e.description ? `: ${oneLine(e.description, 100)}` : ""}`);
    }
    ui.detail(`Provide it with: tryrepo ${recipe.display} ${missing.map((e) => `-e ${e.name}`).join(" ")}`);
  }
  if (recipe.notes) ui.detail(`Note: ${oneLine(recipe.notes, 300)}`);
}

async function cmdRun(input: string, values: Values, ui: Ui): Promise<number> {
  const source = parseSource(input, { ref: values.ref });
  const secretEnv = parseEnvFlags(values.env);
  const hostPort = intOption(values.port, "port", 1, 65535);
  const timeoutMin = intOption(values.timeout, "timeout", 5, 240) ?? 30;
  const json = values.json === true;
  const detach = values.detach === true || json;
  const isGitHub = source.type === "git" && source.host === "github.com" && source.owner && source.repo;
  const [info, meta] = await Promise.all([
    dockerInfo(),
    isGitHub ? fetchRepoMeta(source.owner!, source.repo!) : Promise.resolve(undefined),
  ]);
  header(ui, source, meta);
  const memoryBytes = memoryFor(values, info.memTotal);

  let recipe: Recipe | undefined;
  let cached = false;
  let buildSeconds: number | undefined;
  let costUsd: number | undefined;
  if (source.type === "git" && !values.refresh) {
    const saved = loadRecipe(source.key);
    if (saved && (await imageExists(saved.image))) {
      recipe = saved;
      cached = true;
      const when = new Date(saved.createdAt).toLocaleDateString();
      ui.ok(`Using the saved build from ${when}${saved.commit ? ` (commit ${saved.commit.slice(0, 7)})` : ""} ${ui.dim("· --refresh to rebuild")}`);
    }
  }

  if (!recipe) {
    const agent = pickAgent(values.agent);
    const openai = agent === "openai" ? openaiConfig(values) : undefined;
    const result = await build({
      source,
      meta,
      agent,
      model: values.model,
      openai,
      timeoutMin,
      baseImage: values.image ?? DEFAULT_IMAGE,
      memoryBytes,
      secretEnv,
      keep: values.keep === true,
      ui,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      ui.warn("Cancelled.");
      return 130;
    }
    const log = `${result.runDir}`;
    if (result.error || !result.report) {
      ui.fail(`Setup did not finish: ${result.error ?? "no result"}`);
      ui.detail(`Details: ${log}`);
      if (json) printJson({ ok: false, repo: source.display, error: result.error, runDir: result.runDir });
      return 1;
    }
    if (result.report.outcome === "failure") {
      const label = result.report.reason === "unsupported" ? "Can't run this one in a sandbox" : "Couldn't get it running";
      ui.fail(`${label}: ${oneLine(result.report.summary, 400)}`);
      ui.detail(`Details: ${log}`);
      if (json) printJson({ ok: false, repo: source.display, reason: result.report.reason, summary: result.report.summary, runDir: result.runDir });
      return 1;
    }
    recipe = result.recipe!;
    if (source.type === "git") saveRecipe(recipe);
    buildSeconds = recipe.buildSeconds;
    costUsd = result.outcome?.costUsd;
    const spend = result.outcome
      ? [
          result.outcome.costUsd !== undefined ? `$${result.outcome.costUsd.toFixed(2)}` : undefined,
          `${formatCount(result.outcome.inputTokens + result.outcome.cacheReadTokens)} tokens in`,
          `${formatCount(result.outcome.outputTokens)} out`,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    ui.ok(`Set up in ${formatDuration(result.buildMs)} ${ui.dim(`· ${spend}`)}`);
  }

  if (recipe.kind === "web") {
    const started = await startWeb({
      recipe,
      hostPort,
      secretEnv,
      memoryBytes,
      healthTimeoutSec: 240,
      signal: controller.signal,
      ui,
    });
    if (!started.ok) {
      await removeContainer(started.container);
      if (controller.signal.aborted) return 130;
      ui.fail(`The app did not come up: ${started.error ?? "unknown error"}`);
      if (started.logs) for (const l of sanitize(started.logs).split("\n").slice(-25)) ui.line(ui.dim(`│ ${l}`));
      if (cached) ui.detail(`The saved build may be stale. Try: tryrepo ${source.display} --refresh`);
      if (json) printJson({ ok: false, repo: source.display, error: started.error });
      return 1;
    }
    ui.line();
    ui.ok(`${ui.bold("Running")} at ${ui.cyan(started.url!)}`);
    printUsage(ui, recipe, secretEnv);
    ui.line();
    if (json) {
      printJson({
        ok: true,
        repo: source.display,
        cached,
        kind: "web",
        url: started.url,
        container: started.container,
        image: recipe.image,
        usage: recipe.usage,
        requiredEnv: recipe.requiredEnv,
        buildSeconds,
        costUsd,
      });
    }
    if (values.open) openBrowser(started.url!);
    if (detach) {
      ui.detail(`Running in the background. Stop it with: tryrepo stop ${started.container}`);
      return 0;
    }
    ui.detail("App logs follow. Press Ctrl+C to stop.");
    return followLogs(started.container, ui, controller.signal);
  }

  ui.line();
  ui.ok(`${ui.bold("Ready")}: command-line project`);
  printUsage(ui, recipe, secretEnv);
  ui.line();
  if (json) {
    printJson({ ok: true, repo: source.display, cached, kind: "cli", image: recipe.image, shell: shellCommand(recipe, Object.keys(secretEnv)), usage: recipe.usage, buildSeconds, costUsd });
    return 0;
  }
  if (!detach && process.stdin.isTTY && process.stdout.isTTY) {
    ui.detail("Opening a shell in the sandbox. Type exit to leave.");
    return runShell(recipe, secretEnv, memoryBytes);
  }
  ui.detail(`Open a shell in the sandbox with: ${shellCommand(recipe, Object.keys(secretEnv))}`);
  return 0;
}

function printJson(obj: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function cmdList(ui: Ui): Promise<number> {
  const recipes = listRecipes();
  const [images, containers] = await Promise.all([listImages("tryrepo/*"), listContainers(LABEL)]);
  const sizes = new Map(images.map((i) => [i.ref, i.size]));
  if (!recipes.length) ui.line(ui.dim("No saved builds yet. Try: tryrepo owner/repo"));
  else {
    ui.line(ui.bold("Saved builds"));
    for (const r of recipes) {
      const size = sizes.get(r.image);
      const where = r.kind === "web" ? `web :${r.port}` : "cli";
      ui.line(`  ${r.display.padEnd(36)} ${where.padEnd(10)} ${(size ?? "missing").padEnd(8)} ${new Date(r.createdAt).toLocaleDateString()}`);
    }
  }
  const running = containers.filter((c) => c.labels[`${LABEL}.role`] === "run" || c.labels[`${LABEL}.role`] === "build");
  if (running.length) {
    ui.line();
    ui.line(ui.bold("Containers"));
    for (const c of running) {
      const port = /127\.0\.0\.1:(\d+)->/.exec(c.ports)?.[1];
      ui.line(`  ${c.name.padEnd(44)} ${(port ? `http://127.0.0.1:${port}` : c.labels[`${LABEL}.role`] ?? "").padEnd(24)} ${c.status}`);
    }
  }
  return 0;
}

async function cmdStop(name: string | undefined, all: boolean, ui: Ui): Promise<number> {
  const containers = (await listContainers(LABEL)).filter((c) => ["run", "build", "shell"].includes(c.labels[`${LABEL}.role`] ?? ""));
  let targets = containers;
  if (name) targets = containers.filter((c) => c.name === name || c.name.startsWith(name));
  else if (!all && containers.length > 1) {
    ui.line("Several tryrepo containers exist; name one or use --all:");
    for (const c of containers) ui.line(`  ${c.name}  ${ui.dim(c.status)}`);
    return 1;
  }
  if (!targets.length) {
    ui.line(ui.dim(name ? `No tryrepo container matches "${name}".` : "Nothing is running."));
    return name ? 1 : 0;
  }
  for (const c of targets) {
    await removeContainer(c.name);
    ui.ok(`Stopped ${c.name}`);
  }
  return 0;
}

async function cmdRm(input: string | undefined, all: boolean, ui: Ui): Promise<number> {
  if (all) {
    for (const c of await listContainers(LABEL)) await removeContainer(c.name);
    for (const r of listRecipes()) {
      await removeImage(r.image);
      deleteRecipe(r.key);
    }
    for (const img of await listImages("tryrepo/*")) await removeImage(img.ref);
    ui.ok("Removed all saved builds and tryrepo containers.");
    return 0;
  }
  if (!input) throw new UserError("Which build? Usage: tryrepo rm <repo>  (or --all)");
  const source = parseSource(input);
  const recipe = loadRecipe(source.key);
  if (!recipe) {
    ui.line(ui.dim(`No saved build for ${source.display}.`));
    return 1;
  }
  await removeImage(recipe.image);
  deleteRecipe(recipe.key);
  ui.ok(`Removed the saved build of ${recipe.display}.`);
  return 0;
}

async function cmdBench(file: string | undefined, values: Values, ui: Ui): Promise<number> {
  if (!file) throw new UserError("Usage: tryrepo bench <file-with-one-repo-per-line>");
  const info = await dockerInfo();
  const agent = pickAgent(values.agent);
  const rows = await runBench({
    file,
    parallel: intOption(values.parallel, "parallel", 1, 8) ?? 2,
    outDir: values.out ?? "bench-results",
    agent,
    model: values.model,
    openai: agent === "openai" ? openaiConfig(values) : undefined,
    timeoutMin: intOption(values.timeout, "timeout", 5, 240) ?? 30,
    baseImage: values.image ?? DEFAULT_IMAGE,
    memoryBytes: memoryFor(values, info.memTotal),
    keepImages: values.keep === true,
    ui,
    signal: controller.signal,
  });
  const works = rows.filter((r) => r.status === "works").length;
  ui.line();
  ui.ok(`${works}/${rows.length} work. Results: ${values.out ?? "bench-results"}/results.md`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "__mcp") {
    const { runMcpProxy } = await import("./mcp.js");
    const port = Number(argv[1]);
    const token = process.env.TRYREPO_BRIDGE_TOKEN;
    if (!Number.isInteger(port) || port <= 0 || !token) {
      process.stderr.write("tryrepo __mcp: missing bridge port or token\n");
      return 2;
    }
    runMcpProxy(port, token, VERSION);
    return -1; // keep running; the proxy exits on its own
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UserError(errorMessage(err).replace(/^TypeError \[\w+\]: /, ""), "Run tryrepo --help for usage.");
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command, arg] = positionals;
  if (values.help || !command || command === "help") {
    process.stdout.write(HELP);
    return command || values.help ? 0 : 1;
  }
  const ui = consoleUi(values.json ? process.stderr : process.stdout, { verbose: values.verbose });
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  switch (command) {
    case "list":
    case "ls":
      return cmdList(ui);
    case "stop":
      return cmdStop(arg, values.all === true, ui);
    case "rm":
      return cmdRm(arg, values.all === true, ui);
    case "bench":
      return cmdBench(arg, values, ui);
    default:
      if (positionals.length > 1) throw new UserError(`Unexpected argument: ${positionals[1]}`, "Run tryrepo --help for usage.");
      return cmdRun(command, values, ui);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
    if (code >= 0) setTimeout(() => process.exit(code), 200).unref();
  },
  (err: unknown) => {
    const ui = consoleUi(process.stderr);
    if (err instanceof UserError) {
      ui.fail(err.message);
      if (err.hint) ui.detail(err.hint);
    } else {
      ui.fail(`Unexpected error: ${errorMessage(err)}`);
      if (process.env.TRYREPO_DEBUG && err instanceof Error && err.stack) ui.detail(err.stack);
    }
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200).unref();
  },
);
