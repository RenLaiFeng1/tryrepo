import assert from "node:assert/strict";
import { test } from "node:test";
import { runOpenAIAgent, trimHistory } from "../src/agents/openai.js";
import { ToolHost } from "../src/tools.js";
import { fakeApi, FakeSandbox } from "./helpers.js";

test("the built-in loop drives tools until a report arrives", async () => {
  const api = await fakeApi([
    { status: 503 }, // transient error -> retried
    { content: "Looking at the README.", calls: [{ name: "exec", args: { command: "cat README.md" } }] },
    {
      calls: [
        { name: "write_file", args: { path: "/tryrepo/start.sh", content: "exec python3 -m http.server 8000\n" } },
        { name: "verify_start", args: { port: 8000 } },
      ],
    },
    { calls: [{ name: "report_success", args: { kind: "web", port: 8000, usage: "Open the page" } }] },
  ]);
  const sandbox = new FakeSandbox();
  const host = new ToolHost(sandbox, { startedAt: Date.now(), deadline: Date.now() + 600_000 });
  const texts: string[] = [];
  try {
    const outcome = await runOpenAIAgent({
      system: "sys",
      task: "task",
      host,
      runDir: ".",
      deadline: Date.now() + 600_000,
      signal: new AbortController().signal,
      onText: (t) => texts.push(t),
      log: () => {},
      config: { baseUrl: api.url, apiKey: "sk-test", model: "fake-model" },
    });
    assert.equal(outcome.error, undefined);
    assert.equal(host.report?.outcome, "success");
    assert.equal(outcome.turns, 3);
    assert.equal(outcome.inputTokens, 300);
    assert.deepEqual(texts, ["Looking at the README."]);
    assert.deepEqual(sandbox.calls.map((c) => c.op), ["exec", "write", "verify"]);
    assert.equal(api.requests.length, 4);
    const last = api.requests[3]!.body as { model: string; stream: boolean; messages: { role: string; tool_call_id?: string }[]; tools: unknown[] };
    assert.equal(api.requests[1]!.auth, "Bearer sk-test");
    assert.equal(last.model, "fake-model");
    assert.equal(last.stream, true);
    assert.equal(last.tools.length, 6);
    // system, user, assistant(exec), tool, assistant(write+verify), tool, tool
    assert.deepEqual(last.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "tool", "tool"]);
    assert.ok(last.messages.filter((m) => m.role === "tool").every((m) => typeof m.tool_call_id === "string"));
  } finally {
    await api.close();
  }
});

test("a fatal API error stops the loop with a clear message", async () => {
  const api = await fakeApi([{ status: 401 }]);
  const host = new ToolHost(new FakeSandbox(), { startedAt: Date.now(), deadline: Date.now() + 600_000 });
  try {
    const outcome = await runOpenAIAgent({
      system: "s",
      task: "t",
      host,
      runDir: ".",
      deadline: Date.now() + 600_000,
      signal: new AbortController().signal,
      log: () => {},
      config: { baseUrl: api.url, apiKey: "bad", model: "m" },
    });
    assert.match(outcome.error ?? "", /HTTP 401/);
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});

test("a model that stops calling tools is nudged, then given up on", async () => {
  const api = await fakeApi([{ content: "I think it works." }]);
  const host = new ToolHost(new FakeSandbox(), { startedAt: Date.now(), deadline: Date.now() + 600_000 });
  try {
    const outcome = await runOpenAIAgent({
      system: "s",
      task: "t",
      host,
      runDir: ".",
      deadline: Date.now() + 600_000,
      signal: new AbortController().signal,
      log: () => {},
      config: { baseUrl: api.url, apiKey: "k", model: "m" },
    });
    assert.match(outcome.error ?? "", /stopped using tools/);
    assert.equal(api.requests.length, 4);
  } finally {
    await api.close();
  }
});

test("trimHistory shortens old tool outputs only", () => {
  const big = "x".repeat(5000);
  const messages = [
    { role: "system" as const, content: big },
    ...Array.from({ length: 12 }, (_, i) => ({ role: "tool" as const, content: `${i}:${big}`, tool_call_id: String(i) })),
  ];
  trimHistory(messages);
  assert.equal(messages[0]!.content, big);
  const tools = messages.slice(1);
  assert.ok(tools.slice(0, 4).every((m) => m.content.length < 1000));
  assert.ok(tools.slice(4).every((m) => m.content.length > 5000));
});
