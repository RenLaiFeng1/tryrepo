import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, Sandbox, VerifyResult } from "../src/sandbox.js";
import { run } from "../src/proc.js";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CLI = join(ROOT, "dist", "src", "cli.js");
export const FIXTURES = join(ROOT, "test", "fixtures");

/** Use a throwaway TRYREPO_HOME so tests never touch the real one. */
export function isolateHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tryrepo-test-"));
  process.env.TRYREPO_HOME = dir;
  return dir;
}

export class FakeSandbox implements Sandbox {
  readonly name = "fake";
  readonly calls: { op: string; arg: unknown }[] = [];
  execResult: Partial<ExecResult> = {};
  verifyResult: VerifyResult = { status: "ok", httpCode: "200", localCode: "000", seconds: 1, log: "listening" };

  async exec(command: string, opts?: { cwd?: string; timeoutSec?: number }): Promise<ExecResult> {
    this.calls.push({ op: "exec", arg: { command, ...opts } });
    return { exitCode: 0, output: `ran: ${command}`, timedOut: false, durationMs: 5, ...this.execResult };
  }
  async startBackground(command: string): Promise<{ pid?: number; logFile: string }> {
    this.calls.push({ op: "bg", arg: command });
    return { pid: 42, logFile: "/tmp/tryrepo/bg-x.log" };
  }
  async writeFile(path: string, content: string): Promise<string> {
    this.calls.push({ op: "write", arg: { path, content } });
    return path.startsWith("/") ? path : `/workspace/${path}`;
  }
  async verifyStart(port: number, path: string, timeoutSec: number): Promise<VerifyResult> {
    this.calls.push({ op: "verify", arg: { port, path, timeoutSec } });
    return this.verifyResult;
  }
}

export type ApiStep = { content?: string; calls?: { name: string; args: Record<string, unknown> }[]; status?: number };

/** A fake OpenAI-compatible server that streams scripted responses and records requests. */
export async function fakeApi(steps: ApiStep[]) {
  const requests: { auth?: string; url?: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    for await (const c of req) body += c;
    requests.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(body) as Record<string, unknown> });
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step.status) {
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "try again" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (step.content) {
      // Split the text over two chunks to exercise accumulation.
      const half = Math.floor(step.content.length / 2);
      send({ choices: [{ delta: { content: step.content.slice(0, half) } }] });
      send({ choices: [{ delta: { content: step.content.slice(half) } }] });
    }
    (step.calls ?? []).forEach((c, index) => {
      const args = JSON.stringify(c.args);
      send({ choices: [{ delta: { tool_calls: [{ index, id: `call_${i}_${index}`, type: "function", function: { name: c.name, arguments: args.slice(0, 5) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] });
    });
    send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(r)) };
}

let dockerState: boolean | undefined;
/** True when a Docker daemon is reachable and TRYREPO_SKIP_DOCKER is not set. */
export async function dockerAvailable(): Promise<boolean> {
  if (process.env.TRYREPO_SKIP_DOCKER) return false;
  if (dockerState === undefined) {
    const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    dockerState = r.code === 0 && r.stdout.trim().length > 0;
  }
  return dockerState;
}

export async function imagePresent(image: string): Promise<boolean> {
  const r = await run("docker", ["image", "inspect", image], { timeoutMs: 20_000 });
  return r.code === 0;
}
