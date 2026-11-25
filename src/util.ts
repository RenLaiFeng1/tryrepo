import { randomBytes } from "node:crypto";

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export const randomId = (bytes = 4): string => randomBytes(bytes).toString("hex");

/** Keep the beginning and (mostly) the end of a long text; errors usually sit at the end. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n... [${omitted} characters omitted] ...\n\n${text.slice(-tail)}`;
}

/**
 * Remove terminal control sequences and control characters from text that came from
 * the sandbox or the model, so it cannot rewrite the user's terminal when printed.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "") // OSC sequences
    .replace(/\u001b[@-_]/g, "") // other escapes
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** One line, sanitized, cut to `max` characters. */
export function oneLine(text: string, max = 100): string {
  const line = sanitize(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m${String(rest).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Parse "4g", "512m", "2048" (MiB) into bytes. Returns undefined when invalid. */
export function parseMemory(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(value.trim());
  if (!m || !m[1]) return undefined;
  const num = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const mult =
    unit === "k" ? 1024 : unit === "m" || unit === "" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1024 ** 4;
  const bytes = Math.round(num * mult);
  return bytes > 0 ? bytes : undefined;
}

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class UserError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}

/** `-e NAME=VALUE` or `-e NAME` (value taken from the given environment). */
export function parseEnvFlags(flags: string[] | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const flag of flags ?? []) {
    const eq = flag.indexOf("=");
    const name = eq >= 0 ? flag.slice(0, eq) : flag;
    if (!ENV_NAME_RE.test(name)) throw new UserError(`Invalid environment variable name: "${name}"`);
    const value = eq >= 0 ? flag.slice(eq + 1) : env[name];
    if (value === undefined) {
      throw new UserError(`-e ${name}: ${name} is not set in your environment`, `Use -e ${name}=value or set it first.`);
    }
    out[name] = value;
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
