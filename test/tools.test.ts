import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_DEFS, ToolHost, type ToolEvent } from "../src/tools.js";
import { FakeSandbox } from "./helpers.js";

function host(sandbox = new FakeSandbox(), now = () => 1_000_000, deadline = 1_000_000 + 600_000) {
  const events: ToolEvent[] = [];
  const h = new ToolHost(sandbox, { startedAt: 1_000_000, deadline, now, onEvent: (e) => events.push(e) });
  return { h, sandbox, events };
}

test("tool definitions are well-formed JSON schemas", () => {
  const names = TOOL_DEFS.map((d) => d.name);
  assert.deepEqual(names, ["exec", "start_background", "write_file", "verify_start", "report_success", "report_failure"]);
  for (const d of TOOL_DEFS) {
    assert.equal((d.inputSchema as { type: string }).type, "object");
    assert.ok(d.description.length > 20);
  }
});

test("exec returns exit code, output and a time footer", async () => {
  const { h, sandbox, events } = host();
  const r = await h.call("exec", { command: "npm ci", cwd: "app", timeout_sec: 30 });
  assert.equal(r.isError, false);
  assert.match(r.text, /^exit code: 0/);
  assert.match(r.text, /ran: npm ci/);
  assert.match(r.text, /\[tryrepo\] 0s of 10m used/);
  assert.deepEqual(sandbox.calls[0], { op: "exec", arg: { command: "npm ci", cwd: "/workspace/app", timeoutSec: 30 } });
  assert.deepEqual(events.map((e) => e.phase), ["start", "end"]);
  assert.equal(events[0]?.summary, "$ npm ci");
});

test("exec failures and timeouts are reported as errors", async () => {
  const { h, sandbox } = host();
  sandbox.execResult = { exitCode: 124, output: "partial" };
  const r = await h.call("exec", { command: "sleep 999", timeout_sec: 5 });
  assert.equal(r.isError, true);
  assert.match(r.text, /timed out after 5s/);
});

test("invalid arguments are rejected without touching the sandbox", async () => {
  const { h, sandbox } = host();
  for (const [name, args] of [
    ["exec", {}],
    ["exec", { command: 5 }],
    ["exec", { command: "x", timeout_sec: 99999 }],
    ["write_file", { path: "a" }],
    ["verify_start", { port: 0 }],
    ["verify_start", { port: 80, path: "no-slash" }],
    ["verify_start", { port: 80, path: "/a b" }],
  ] as const) {
    const r = await h.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.text, /Invalid arguments/);
  }
  assert.equal(sandbox.calls.length, 0);
  assert.equal((await h.call("nope", {})).isError, true);
});

test("web success requires a passing verify_start on the same port", async () => {
  const { h, sandbox } = host();
  let r = await h.call("report_success", { kind: "web", port: 3000, usage: "open it" });
  assert.equal(r.isError, true);
  assert.match(r.text, /verify_start has not passed for port 3000/);
  assert.equal(h.report, undefined);

  sandbox.verifyResult = { status: "timeout", httpCode: "000", localCode: "200", seconds: 120, log: "" };
  r = await h.call("verify_start", { port: 3000 });
  assert.equal(r.isError, true);
  assert.match(r.text, /listen on 0\.0\.0\.0/);

  sandbox.verifyResult = { status: "ok", httpCode: "200", localCode: "000", seconds: 3, log: "ready" };
  r = await h.call("verify_start", { port: 3000, path: "/app" });
  assert.equal(r.isError, false);
  assert.match(r.text, /PASSED/);

  r = await h.call("report_success", { kind: "web", port: 4000, usage: "x" });
  assert.equal(r.isError, true);

  r = await h.call("report_success", {
    kind: "web",
    port: 3000,
    usage: "Open the page",
    title: "Demo",
    required_env: [{ name: "OPENAI_API_KEY", description: "chat", required: false }],
  });
  assert.equal(r.isError, false);
  assert.deepEqual(h.report, {
    outcome: "success",
    kind: "web",
    port: 3000,
    path: "/app",
    title: "Demo",
    usage: "Open the page",
    requiredEnv: [{ name: "OPENAI_API_KEY", description: "chat", required: false }],
    notes: undefined,
  });
  // After the report, other tools refuse to work.
  const after = await h.call("exec", { command: "ls" });
  assert.equal(after.isError, true);
  assert.match(after.text, /already finished/);
});

test("verify_start explains each failure mode", async () => {
  const { h, sandbox } = host();
  sandbox.verifyResult = { status: "missing", httpCode: "000", localCode: "000", seconds: 0, log: "" };
  assert.match((await h.call("verify_start", { port: 1 })).text, /does not exist/);
  sandbox.verifyResult = { status: "exited", httpCode: "000", localCode: "000", seconds: 2, log: "Error: boom" };
  const exited = await h.call("verify_start", { port: 1 });
  assert.match(exited.text, /exited after 2s/);
  assert.match(exited.text, /Error: boom/);
  sandbox.verifyResult = { status: "timeout", httpCode: "000", localCode: "000", seconds: 120, log: "" };
  assert.match((await h.call("verify_start", { port: 1, timeout_sec: 120 })).text, /nothing answered HTTP on port 1 within 120s/);
});

test("cli success and failure reports", async () => {
  const { h } = host();
  assert.equal((await h.call("report_success", { kind: "cli", usage: "tool --help" })).isError, false);
  assert.equal(h.report?.outcome, "success");

  const other = host().h;
  assert.equal((await other.call("report_failure", { reason: "maybe", summary: "x" })).isError, true);
  assert.equal((await other.call("report_failure", { reason: "unsupported", summary: "needs a GPU" })).isError, false);
  assert.deepEqual(other.report, { outcome: "failure", reason: "unsupported", summary: "needs a GPU" });
});

test("bad required_env entries are rejected", async () => {
  const { h } = host();
  const r = await h.call("report_success", { kind: "cli", usage: "x", required_env: [{ name: "not valid" }] });
  assert.equal(r.isError, true);
});

test("after the deadline only reports are accepted", async () => {
  let now = 1_000_000;
  const { h, sandbox } = host(new FakeSandbox(), () => now, 1_000_000 + 60_000);
  now += 61_000;
  const r = await h.call("exec", { command: "ls" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Time is up/);
  assert.equal(sandbox.calls.length, 0);
  assert.equal((await h.call("report_failure", { reason: "failed", summary: "slow" })).isError, false);
});
