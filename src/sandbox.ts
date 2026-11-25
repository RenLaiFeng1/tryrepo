import { docker } from "./docker.js";
import { randomId } from "./util.js";

export interface ExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export type VerifyStatus = "ok" | "exited" | "timeout" | "missing" | "error";

export interface VerifyResult {
  status: VerifyStatus;
  httpCode: string;
  /** HTTP code when probing 127.0.0.1 instead of the container IP (detects localhost-only servers). */
  localCode: string;
  seconds: number;
  log: string;
}

/** What the agent tools need from a sandbox. Implemented by Docker; faked in tests. */
export interface Sandbox {
  readonly name: string;
  exec(command: string, opts?: { cwd?: string; timeoutSec?: number }): Promise<ExecResult>;
  startBackground(command: string, opts?: { cwd?: string }): Promise<{ pid?: number; logFile: string }>;
  writeFile(path: string, content: string): Promise<string>;
  verifyStart(port: number, path: string, timeoutSec: number): Promise<VerifyResult>;
}

export const WORKSPACE = "/workspace";
export const START_SCRIPT = "/tryrepo/start.sh";
const MAX_OUTPUT_BYTES = 20_000;
const EXIT_MARK = "\n__TRYREPO_EXIT__=";

/** PID 1 of a build sandbox: reaps orphans and survives `kill -1`. */
export const KEEPALIVE_CMD = ["bash", "-c", 'trap "exit 0" TERM INT; while :; do sleep 86400 & wait $!; done'];

// Each script receives its parameters as positional arguments, never by string interpolation.
const EXEC_SCRIPT = `set -u
d=/tmp/tryrepo; mkdir -p "$d"
f="$d/cmd-$3.sh"; o="$d/out-$3.log"
cat > "$f"
if ! cd "$1" 2>/dev/null; then
  printf 'tryrepo: directory not found: %s\\n' "$1"
  printf '\\n__TRYREPO_EXIT__=%s\\n' 97
  exit 0
fi
timeout -k 10 "$2" bash -l "$f" </dev/null >"$o" 2>&1
code=$?
size=$(wc -c <"$o")
max=$4
if [ "$size" -gt "$max" ]; then
  head -c $((max / 4)) "$o"
  printf '\\n\\n... [%s bytes omitted; full output: %s] ...\\n\\n' $((size - max)) "$o"
  tail -c $((max * 3 / 4)) "$o"
else
  cat "$o"
fi
printf '\\n__TRYREPO_EXIT__=%s\\n' "$code"`;

const BACKGROUND_SCRIPT = `set -u
d=/tmp/tryrepo; mkdir -p "$d"
f="$d/bg-$3.sh"
cat > "$f"
# Check the directory in the foreground: once setsid backgrounds the process, a failure
# there would be invisible and the tool would report a successful start.
cd "$1" 2>/dev/null || { printf 'tryrepo: directory not found: %s\\n' "$1" >&2; exit 97; }
setsid bash -l -c 'cd "$1" && exec bash -l "$2"' -- "$1" "$f" </dev/null >"$2" 2>&1 &
printf '%s\\n' "$!"`;

const WRITE_SCRIPT = `set -eu
p="$1"
case "$p" in /*) ;; *) p="${WORKSPACE}/$p" ;; esac
mkdir -p "$(dirname "$p")"
cat > "$p"
printf '%s\\n' "$p"`;

const VERIFY_SCRIPT = `set -u
d=/tmp/tryrepo; mkdir -p "$d"
log="$d/start.log"
if [ ! -f ${START_SCRIPT} ]; then echo "__VERIFY__=missing http=000 local=000 seconds=0"; exit 0; fi
# Behave like a fresh container: stop every process except PID 1 and this script.
kill -TERM -1 2>/dev/null; sleep 2; kill -KILL -1 2>/dev/null; sleep 1
: > "$log"
cd ${WORKSPACE}
setsid bash -l ${START_SCRIPT} </dev/null >"$log" 2>&1 &
pid=$!
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ip" ] || ip=127.0.0.1
url="http://$ip:$1$2"
status=timeout; code=000; SECONDS=0
while [ "$SECONDS" -lt "$3" ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)
  [ -n "$code" ] || code=000
  if [ "$code" != "000" ]; then status=ok; break; fi
  if ! kill -0 "$pid" 2>/dev/null; then status=exited; break; fi
  sleep 1
done
local=000
if [ "$status" != ok ]; then
  local=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$1$2" 2>/dev/null || true)
  [ -n "$local" ] || local=000
fi
printf '__VERIFY__=%s http=%s local=%s seconds=%s\\n' "$status" "$code" "$local" "$SECONDS"
tail -c 6000 "$log"`;

export class DockerSandbox implements Sandbox {
  constructor(
    readonly name: string,
    /** Secret env vars made available to every command without putting values on a command line. */
    private readonly secretEnv: Record<string, string> = {},
  ) {}

  private envArgs(): string[] {
    return Object.keys(this.secretEnv).flatMap((k) => ["-e", k]);
  }

  private dockerEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.secretEnv };
  }

  async exec(command: string, opts: { cwd?: string; timeoutSec?: number } = {}): Promise<ExecResult> {
    const timeoutSec = Math.max(1, Math.min(opts.timeoutSec ?? 600, 3600));
    const started = Date.now();
    const r = await docker(
      [
        "exec",
        "-i",
        ...this.envArgs(),
        this.name,
        "bash",
        "-c",
        EXEC_SCRIPT,
        "tryrepo",
        opts.cwd || WORKSPACE,
        String(timeoutSec),
        randomId(6),
        String(MAX_OUTPUT_BYTES),
      ],
      { input: command, timeoutMs: (timeoutSec + 60) * 1000, env: this.dockerEnv(), maxOutput: 200_000 },
    );
    const durationMs = Date.now() - started;
    const at = r.stdout.lastIndexOf(EXIT_MARK);
    if (at < 0) {
      const why = r.timedOut ? "the sandbox did not respond in time" : (r.stderr || r.stdout).trim() || "no output";
      return { exitCode: -1, output: `tryrepo: command could not run in the sandbox: ${why}`, timedOut: r.timedOut, durationMs };
    }
    const exitCode = Number.parseInt(r.stdout.slice(at + EXIT_MARK.length).trim(), 10);
    return {
      exitCode: Number.isNaN(exitCode) ? -1 : exitCode,
      output: r.stdout.slice(0, at),
      timedOut: exitCode === 124,
      durationMs,
    };
  }

  async startBackground(command: string, opts: { cwd?: string } = {}): Promise<{ pid?: number; logFile: string }> {
    const id = randomId(6);
    const logFile = `/tmp/tryrepo/bg-${id}.log`;
    const r = await docker(
      ["exec", "-i", ...this.envArgs(), this.name, "bash", "-c", BACKGROUND_SCRIPT, "tryrepo", opts.cwd || WORKSPACE, logFile, id],
      { input: command, timeoutMs: 60_000, env: this.dockerEnv() },
    );
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `failed to start (exit ${r.code})`);
    const pid = Number.parseInt(r.stdout.trim(), 10);
    return { pid: Number.isNaN(pid) ? undefined : pid, logFile };
  }

  async writeFile(path: string, content: string): Promise<string> {
    const r = await docker(["exec", "-i", this.name, "bash", "-c", WRITE_SCRIPT, "tryrepo", path], {
      input: content,
      timeoutMs: 60_000,
    });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `write failed (exit ${r.code})`);
    return r.stdout.trim();
  }

  async verifyStart(port: number, path: string, timeoutSec: number): Promise<VerifyResult> {
    const r = await docker(
      ["exec", ...this.envArgs(), this.name, "bash", "-c", VERIFY_SCRIPT, "tryrepo", String(port), path, String(timeoutSec)],
      { timeoutMs: (timeoutSec + 90) * 1000, env: this.dockerEnv() },
    );
    const text = r.stdout;
    const m = /__VERIFY__=(\w+) http=(\d+) local=(\d+) seconds=(\d+)\n?/.exec(text);
    if (!m) {
      return {
        status: "error",
        httpCode: "000",
        localCode: "000",
        seconds: 0,
        log: (r.stderr || text).trim() || "verification did not run",
      };
    }
    return {
      status: (["ok", "exited", "timeout", "missing"].includes(m[1] ?? "") ? m[1] : "error") as VerifyStatus,
      httpCode: m[2] ?? "000",
      localCode: m[3] ?? "000",
      seconds: Number(m[4] ?? 0),
      log: text.slice((m.index ?? 0) + m[0].length),
    };
  }
}

/** POSIX single-quote a string for a shell command line. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
