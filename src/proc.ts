import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import crossSpawn from "cross-spawn";

export interface RunOptions {
  input?: string | Buffer;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Max characters kept per stream; older output is dropped first. */
  maxOutput?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError?: Error;
}

/**
 * Spawn a program without a shell. cross-spawn resolves npm-style .cmd shims on Windows
 * and escapes arguments correctly for them.
 */
export function spawnProcess(cmd: string, args: string[], options: SpawnOptions): ChildProcess {
  return crossSpawn(cmd, args, { windowsHide: true, ...options });
}

/** Run a program to completion and capture its output. Never rejects. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxOutput = opts.maxOutput ?? 4_000_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnProcess(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, stdout, stderr, timedOut, aborted, spawnError: err as Error });
      return;
    }
    const append = (cur: string, chunk: string) => {
      const next = cur + chunk;
      return next.length > maxOutput ? next.slice(next.length - maxOutput) : next;
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (stdout = append(stdout, c)));
    child.stderr?.on("data", (c: string) => (stderr = append(stderr, c)));

    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, spawnError });
    };
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, opts.timeoutMs)
        : undefined;
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));

    child.stdin?.on("error", () => {
      /* the child may exit before reading all input */
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Kill a process and everything it started (cmd.exe shims on Windows start grandchildren). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const k = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      k.on("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 5000).unref();
}

/** Look for an executable on PATH (handles PATHEXT on Windows). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir.replace(/[\\/]+$/, "")}${process.platform === "win32" ? "\\" : "/"}${name}${ext}`;
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
