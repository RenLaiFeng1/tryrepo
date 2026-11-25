import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { startBridge } from "../src/bridge.js";
import { handleMessage } from "../src/mcp.js";
import { ToolHost } from "../src/tools.js";
import { CLI, FakeSandbox } from "./helpers.js";

test("handleMessage covers the MCP lifecycle", async () => {
  const call = async () => ({ text: "ok", isError: false });
  const init = handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, call, "9.9.9");
  assert.deepEqual(init, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "tryrepo", version: "9.9.9" } },
  });
  assert.equal(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, call, "x"), undefined);
  const unknown = handleMessage({ jsonrpc: "2.0", id: "d", method: "server/discover" }, call, "x") as Record<string, unknown>;
  assert.equal((unknown.error as { code: number }).code, -32601);
  const list = handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, call, "x") as { result: { tools: unknown[] } };
  assert.equal(list.result.tools.length, 6);
  const res = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "exec", arguments: {} } }, call, "x");
  assert.deepEqual(res, { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }], isError: false } });
});

test("bridge rejects connections with a wrong token", async () => {
  const bridge = await startBridge(async () => ({ text: "should not run", isError: false }));
  const { connect } = await import("node:net");
  const reply = await new Promise<string>((resolve) => {
    const s = connect({ host: "127.0.0.1", port: bridge.port }, () => {
      s.write(`${JSON.stringify({ token: "wrong", id: 1, name: "exec", args: {} })}\n`);
    });
    let data = "";
    s.on("data", (d) => (data += d.toString()));
    s.on("close", () => resolve(data));
    s.on("error", () => resolve(data));
  });
  assert.equal(reply, "");
  await bridge.close();
});

test("the real MCP proxy process forwards tool calls to the main process", async () => {
  const sandbox = new FakeSandbox();
  const host = new ToolHost(sandbox, { startedAt: Date.now(), deadline: Date.now() + 600_000 });
  const bridge = await startBridge((name, args) => host.call(name, args));
  const child = spawn(process.execPath, [CLI, "__mcp", String(bridge.port)], {
    env: { ...process.env, TRYREPO_BRIDGE_TOKEN: bridge.token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map<number, Record<string, unknown>>();
  const waiters = new Map<number, (v: Record<string, unknown>) => void>();
  const nonJson: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      nonJson.push(line);
      return;
    }
    const id = msg.id as number;
    responses.set(id, msg);
    waiters.get(id)?.(msg);
  });
  const send = (msg: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (id: number, method: string, params?: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });

  try {
    const init = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, "tryrepo");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await request(2, "tools/list");
    assert.equal((list.result as { tools: unknown[] }).tools.length, 6);
    // Two concurrent calls must both come back with the right ids.
    const [a, b] = await Promise.all([
      request(3, "tools/call", { name: "exec", arguments: { command: "echo one" } }),
      request(4, "tools/call", { name: "write_file", arguments: { path: "/tryrepo/start.sh", content: "exec x\n" } }),
    ]);
    const textOf = (m: Record<string, unknown>) => ((m.result as { content: { text: string }[] }).content[0]?.text ?? "");
    assert.match(textOf(a), /ran: echo one/);
    assert.match(textOf(b), /wrote \/tryrepo\/start\.sh \(7 bytes\)/);
    const bad = await request(5, "tools/call", { name: "verify_start", arguments: { port: "x" } });
    assert.equal((bad.result as { isError: boolean }).isError, true);
    assert.deepEqual(nonJson, [], "stdout must only carry JSON-RPC");
    assert.equal(sandbox.calls.length, 2);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    await bridge.close();
  }
});
