import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LABEL, removeContainer, runContainer } from "../src/docker.js";
import { DEFAULT_IMAGE, SANDBOX_ENV } from "../src/pipeline.js";
import { DockerSandbox, KEEPALIVE_CMD, WORKSPACE } from "../src/sandbox.js";
import { randomId } from "../src/util.js";
import { dockerAvailable, imagePresent } from "./helpers.js";

const ready = (await dockerAvailable()) && (await imagePresent(DEFAULT_IMAGE));

describe("DockerSandbox (needs Docker and the base image)", { skip: ready ? false : `Docker or ${DEFAULT_IMAGE} not available` }, () => {
  const name = `${LABEL}-test-${randomId(3)}`;
  let sb: DockerSandbox;

  before(async () => {
    await runContainer({
      name,
      image: DEFAULT_IMAGE,
      labels: { [LABEL]: "1", [`${LABEL}.role`]: "test" },
      env: SANDBOX_ENV,
      memoryBytes: 1024 ** 3,
      pidsLimit: 512,
      workdir: WORKSPACE,
      cmd: KEEPALIVE_CMD,
    });
    sb = new DockerSandbox(name, { TRYREPO_SECRET: "s3cr3t value 'with' \"quotes\"" });
  });

  after(async () => {
    await removeContainer(name);
  });

  test("exec reports exit codes and output, and runs in /workspace by default", async () => {
    const r = await sb.exec("pwd; echo out; echo err >&2; exit 3");
    assert.equal(r.exitCode, 3);
    assert.equal(r.output.trim(), "/workspace\nout\nerr");
    const ok = await sb.exec("true");
    assert.equal(ok.exitCode, 0);
  });

  test("commands are passed verbatim (quotes, $, newlines, unicode)", async () => {
    const r = await sb.exec(`x='a "b" $HOME'; printf '%s\\n' "$x"\necho "üñí 漢字"`);
    // Single quotes must survive the trip, so $HOME stays literal: the command is passed verbatim.
    assert.equal(r.output.trim(), 'a "b" $HOME\nüñí 漢字');
    // And without single quotes the sandbox's own shell expands it, proving it runs as a real shell.
    assert.equal((await sb.exec("echo $HOME")).output.trim(), "/root");
  });

  test("cwd parameter and missing directories", async () => {
    assert.equal((await sb.exec("pwd", { cwd: "/tmp" })).output.trim(), "/tmp");
    const missing = await sb.exec("pwd", { cwd: "/nope" });
    assert.equal(missing.exitCode, 97);
    assert.match(missing.output, /directory not found/);
  });

  test("stdin is closed, so prompts get EOF instead of hanging", async () => {
    const r = await sb.exec("read -r line; echo \"got:[$line] status:$?\"", { timeoutSec: 20 });
    assert.match(r.output, /got:\[\] status:1/);
  });

  test("timeouts stop the command", async () => {
    const started = Date.now();
    const r = await sb.exec("sleep 30", { timeoutSec: 2 });
    assert.equal(r.exitCode, 124);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 20_000);
  });

  test("a stray background process does not block exec", async () => {
    const started = Date.now();
    const r = await sb.exec("sleep 60 & echo started", { timeoutSec: 30 });
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /started/);
    assert.ok(Date.now() - started < 15_000, "exec waited for the background process");
  });

  test("huge output is truncated in the middle", async () => {
    const r = await sb.exec("seq 1 100000");
    assert.ok(r.output.length < 25_000, `got ${r.output.length} chars`);
    assert.match(r.output, /^1\n2\n/);
    assert.match(r.output, /100000\s*$/);
    assert.match(r.output, /bytes omitted/);
  });

  test("secret env vars are visible to commands but not part of the container config", async () => {
    const r = await sb.exec('printf "%s" "$TRYREPO_SECRET"');
    assert.equal(r.output, "s3cr3t value 'with' \"quotes\"");
    const plain = new DockerSandbox(name);
    assert.equal((await plain.exec('printf "[%s]" "${TRYREPO_SECRET:-}"')).output, "[]");
  });

  test("login shells source /etc/profile.d", async () => {
    await sb.writeFile("/etc/profile.d/tryrepo.sh", "export FROM_PROFILE=yes\n");
    assert.equal((await sb.exec('echo "$FROM_PROFILE"')).output.trim(), "yes");
  });

  test("writeFile handles relative paths, nested dirs and arbitrary content", async () => {
    const content = "line1\n'single' \"double\" $VAR `tick` \\ back\n漢字\n";
    const p = await sb.writeFile("deep/nested/file.txt", content);
    assert.equal(p, "/workspace/deep/nested/file.txt");
    assert.equal((await sb.exec("cat deep/nested/file.txt")).output, content);
    await assert.rejects(() => sb.writeFile("/workspace", "x"));
  });

  test("startBackground returns immediately and logs to a file", async () => {
    const started = Date.now();
    const bg = await sb.startBackground("echo hello-bg; sleep 120");
    assert.ok(Date.now() - started < 10_000);
    assert.match(bg.logFile, /^\/tmp\/tryrepo\/bg-[0-9a-f]+\.log$/);
    await new Promise((r) => setTimeout(r, 1000));
    assert.match((await sb.exec(`cat ${bg.logFile}`)).output, /hello-bg/);
  });

  test("verifyStart: missing script", async () => {
    await sb.exec("rm -f /tryrepo/start.sh");
    const r = await sb.verifyStart(8000, "/", 10);
    assert.equal(r.status, "missing");
  });

  test("verifyStart: a server on 0.0.0.0 passes and survives the check", async () => {
    await sb.writeFile("/tryrepo/start.sh", "cd /workspace && exec python3 -m http.server 8000 --bind 0.0.0.0\n");
    const r = await sb.verifyStart(8000, "/", 60);
    assert.equal(r.status, "ok", r.log);
    assert.equal(r.httpCode, "200");
    // The sandbox (PID 1) must still be alive after kill -1.
    assert.equal((await sb.exec("echo alive")).output.trim(), "alive");
    assert.match((await sb.exec("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/")).output, /200/);
  });

  test("verifyStart: a localhost-only server is detected", async () => {
    await sb.writeFile("/tryrepo/start.sh", "exec python3 -m http.server 8001 --bind 127.0.0.1\n");
    const r = await sb.verifyStart(8001, "/", 8);
    assert.equal(r.status, "timeout");
    assert.equal(r.localCode, "200");
  });

  test("verifyStart: a script that exits is detected with its output", async () => {
    await sb.writeFile("/tryrepo/start.sh", "echo 'boom: missing module' >&2; exit 1\n");
    const r = await sb.verifyStart(8002, "/", 30);
    assert.equal(r.status, "exited");
    assert.match(r.log, /boom: missing module/);
  });

  test("verifyStart passes the secret env to start.sh", async () => {
    await sb.writeFile(
      "/tryrepo/start.sh",
      'mkdir -p /tmp/s && printf "%s" "$TRYREPO_SECRET" > /tmp/s/index.html && cd /tmp/s && exec python3 -m http.server 8003\n',
    );
    const r = await sb.verifyStart(8003, "/index.html", 60);
    assert.equal(r.status, "ok", r.log);
    assert.equal((await sb.exec("cat /tmp/s/index.html")).output, "s3cr3t value 'with' \"quotes\"");
  });
});
