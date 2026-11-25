import { spawn } from "node:child_process";
import { request } from "node:http";
import { createInterface } from "node:readline";
import {
  containerState,
  LABEL,
  logsTail,
  publishedPort,
  removeContainer,
  runContainer,
} from "./docker.js";
import { killTree, spawnProcess } from "./proc.js";
import type { Recipe } from "./recipe.js";
import { START_SCRIPT, WORKSPACE } from "./sandbox.js";
import { PIDS_LIMIT, SANDBOX_ENV } from "./pipeline.js";
import type { Ui } from "./ui.js";
import { randomId, sanitize, sleep } from "./util.js";

export interface StartWebOptions {
  recipe: Recipe;
  hostPort?: number;
  secretEnv: Record<string, string>;
  memoryBytes: number;
  healthTimeoutSec: number;
  signal: AbortSignal;
  ui: Ui;
}

export interface StartWebResult {
  ok: boolean;
  container: string;
  url?: string;
  httpStatus?: number;
  error?: string;
  logs?: string;
}

/** Any HTTP response counts as "up"; returns the status code, or undefined when nothing answered. */
export function probeHttp(url: string, timeoutMs = 4000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const req = request(url, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

export function containerName(recipe: Recipe): string {
  const base = recipe.image.replace(/^tryrepo\//, "").replace(/:.*$/, "").slice(0, 40);
  return `${LABEL}-run-${base}-${randomId(2)}`;
}

export async function startWeb(opts: StartWebOptions): Promise<StartWebResult> {
  const { recipe, ui } = opts;
  const name = containerName(recipe);
  const port = recipe.port;
  if (!port) return { ok: false, container: name, error: "the recipe has no port" };
  await runContainer(
    {
      name,
      image: recipe.image,
      labels: { [LABEL]: "1", [`${LABEL}.role`]: "run", [`${LABEL}.key`]: recipe.key },
      env: SANDBOX_ENV,
      passEnv: Object.keys(opts.secretEnv),
      memoryBytes: opts.memoryBytes,
      pidsLimit: PIDS_LIMIT,
      publish: [{ containerPort: port, hostPort: opts.hostPort }],
      init: true,
      workdir: WORKSPACE,
      cmd: ["bash", "-l", START_SCRIPT],
    },
    opts.secretEnv,
  );
  const hostPort = (await publishedPort(name, port)) ?? opts.hostPort;
  if (!hostPort) {
    return { ok: false, container: name, error: "Docker did not publish the port", logs: await logsTail(name) };
  }
  const url = `http://127.0.0.1:${hostPort}${recipe.path || "/"}`;
  ui.step(`Starting the app…`);
  const until = Date.now() + opts.healthTimeoutSec * 1000;
  let checks = 0;
  while (Date.now() < until && !opts.signal.aborted) {
    const status = await probeHttp(url);
    if (status !== undefined) return { ok: true, container: name, url, httpStatus: status };
    if (++checks % 3 === 0) {
      const state = await containerState(name);
      if (!state?.running) {
        return {
          ok: false,
          container: name,
          url,
          error: `the app exited (code ${state?.exitCode ?? "?"}) before answering`,
          logs: await logsTail(name),
        };
      }
    }
    await sleep(1000, opts.signal);
  }
  return {
    ok: false,
    container: name,
    url,
    error: opts.signal.aborted ? "cancelled" : `no HTTP answer on ${url} within ${opts.healthTimeoutSec}s`,
    logs: await logsTail(name),
  };
}

/** Stream the app's logs until Ctrl+C (or until it exits), then remove the container. */
export async function followLogs(name: string, ui: Ui, signal: AbortSignal): Promise<number> {
  const child = spawnProcess("docker", ["logs", "-f", "--tail", "40", name], { stdio: ["ignore", "pipe", "pipe"] });
  const print = (line: string) => ui.line(ui.dim(`│ ${sanitize(line)}`));
  createInterface({ input: child.stdout! }).on("line", print);
  createInterface({ input: child.stderr! }).on("line", print);
  const onAbort = () => killTree(child);
  signal.addEventListener("abort", onAbort, { once: true });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  signal.removeEventListener("abort", onAbort);
  const state = await containerState(name);
  await removeContainer(name);
  if (signal.aborted) return 0;
  ui.warn(`The app stopped (exit code ${state?.exitCode ?? "?"}).`);
  return 1;
}

/** Open an interactive shell in a fresh container of the image (for CLI projects). */
export async function runShell(recipe: Recipe, secretEnv: Record<string, string>, memoryBytes: number): Promise<number> {
  const args = [
    "run",
    "-it",
    "--rm",
    "--init",
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL}.role=shell`,
    "--memory",
    String(memoryBytes),
    "--pids-limit",
    String(PIDS_LIMIT),
    "-w",
    WORKSPACE,
  ];
  for (const [k, v] of Object.entries(SANDBOX_ENV)) if (k !== "TERM" && k !== "NO_COLOR") args.push("-e", `${k}=${v}`);
  for (const k of Object.keys(secretEnv)) args.push("-e", k);
  args.push(recipe.image, "bash", "-l");
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: "inherit", env: { ...process.env, ...secretEnv } });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export function shellCommand(recipe: Recipe, envNames: string[]): string {
  const env = envNames.map((n) => ` -e ${n}`).join("");
  return `docker run -it --rm --init${env} ${recipe.image} bash -l`;
}

/** Open a URL in the default browser without going through a shell. */
export function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: process.platform !== "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* opening a browser is a convenience only */
  }
}
