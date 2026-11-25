import type { Writable } from "node:stream";
import type { ToolEvent } from "./tools.js";
import { formatDuration, oneLine, sanitize } from "./util.js";

export interface Ui {
  /** Plain line. */
  line(text?: string): void;
  step(text: string): void;
  ok(text: string): void;
  warn(text: string): void;
  fail(text: string): void;
  /** Dimmed, indented detail. */
  detail(text: string): void;
  tool(e: ToolEvent): void;
  agentText(text: string): void;
  bold(text: string): string;
  dim(text: string): string;
  cyan(text: string): string;
}

function useColor(stream: Writable & { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return stream.isTTY === true && process.env.TERM !== "dumb";
}

export function consoleUi(stream: Writable & { isTTY?: boolean } = process.stdout, opts: { verbose?: boolean } = {}): Ui {
  const color = useColor(stream);
  const paint = (code: string) => (text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const bold = paint("1");
  const dim = paint("2");
  const green = paint("32");
  const red = paint("31");
  const yellow = paint("33");
  const cyan = paint("36");
  const write = (text: string) => stream.write(`${text}\n`);
  return {
    line: (text = "") => write(text),
    step: (text) => write(`${cyan("●")} ${text}`),
    ok: (text) => write(`${green("✔")} ${text}`),
    warn: (text) => write(`${yellow("!")} ${text}`),
    fail: (text) => write(`${red("✗")} ${text}`),
    detail: (text) => write(dim(`  ${text}`)),
    tool: (e) => {
      if (e.phase === "start") {
        write(dim(`  ${e.summary}`));
        return;
      }
      const slow = (e.ms ?? 0) >= 15_000;
      if (!e.ok) write(`    ${red("↳")} ${dim(`${e.detail ?? "failed"} · ${formatDuration(e.ms ?? 0)}`)}`);
      else if (slow || opts.verbose) write(`    ${dim(`↳ ${e.detail ? `${e.detail} · ` : ""}${formatDuration(e.ms ?? 0)}`)}`);
    },
    agentText: (text) => {
      const first = sanitize(text)
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
      if (first) write(dim(`  » ${oneLine(first, 140)}`));
    },
    bold,
    dim,
    cyan,
  };
}

export function silentUi(): Ui {
  const noop = () => {};
  const id = (t: string) => t;
  return { line: noop, step: noop, ok: noop, warn: noop, fail: noop, detail: noop, tool: noop, agentText: noop, bold: id, dim: id, cyan: id };
}
