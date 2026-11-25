import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { listContainers, LABEL, removeContainer, removeImage } from "../src/docker.js";
import { build, DEFAULT_IMAGE } from "../src/pipeline.js";
import { startWeb } from "../src/runner.js";
import { parseSource } from "../src/source.js";
import { silentUi } from "../src/ui.js";
import { dockerAvailable, fakeApi, FIXTURES, imagePresent, isolateHome } from "./helpers.js";

const ready = (await dockerAvailable()) && (await imagePresent(DEFAULT_IMAGE));

describe("full pipeline with a scripted model (needs Docker and the base image)", { skip: ready ? false : `Docker or ${DEFAULT_IMAGE} not available` }, () => {
  isolateHome();
  const cleanup: (() => Promise<unknown>)[] = [];
  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  });

  test("local project: agent sets it up, image is saved, app answers from the host", async () => {
    const api = await fakeApi([
      { content: "Reading the README first.", calls: [{ name: "exec", args: { command: "ls -la && cat README.md" } }] },
      {
        calls: [
          { name: "write_file", args: { path: "/tryrepo/start.sh", content: "cd /workspace\nexec python3 -m http.server 8000 --bind 0.0.0.0\n" } },
        ],
      },
      { calls: [{ name: "report_success", args: { kind: "web", port: 8000, usage: "too early" } }] }, // must be refused
      { calls: [{ name: "verify_start", args: { port: 8000, timeout_sec: 60 } }] },
      { calls: [{ name: "report_success", args: { kind: "web", port: 8000, title: "Static page", usage: "Open the page in your browser." } }] },
    ]);
    cleanup.push(api.close);
    const source = parseSource(join(FIXTURES, "pyhttp"));
    const result = await build({
      source,
      agent: "openai",
      openai: { baseUrl: api.url, apiKey: "sk-test", model: "scripted" },
      timeoutMin: 10,
      baseImage: DEFAULT_IMAGE,
      memoryBytes: 1024 ** 3,
      secretEnv: {},
      keep: false,
      ui: silentUi(),
      signal: new AbortController().signal,
    });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.report?.outcome, "success");
    const recipe = result.recipe!;
    cleanup.push(() => removeImage(recipe.image));
    assert.match(recipe.image, /^tryrepo\/local-pyhttp:/);
    assert.equal(recipe.port, 8000);

    // The premature report_success must have been rejected before verify_start passed.
    const toolMessages = (api.requests.at(-1)!.body.messages as { role: string; content: string }[]).filter((m) => m.role === "tool");
    assert.ok(toolMessages.some((m) => /verify_start has not passed/.test(m.content)));

    // The build container is gone.
    const builders = (await listContainers(LABEL)).filter((c) => c.name === result.builder);
    assert.equal(builders.length, 0);

    const run = await startWeb({
      recipe,
      secretEnv: {},
      memoryBytes: 1024 ** 3,
      healthTimeoutSec: 90,
      signal: new AbortController().signal,
      ui: silentUi(),
    });
    cleanup.push(() => removeContainer(run.container));
    assert.equal(run.ok, true, run.error);
    assert.match(run.url!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await (await fetch(run.url!)).text();
    assert.match(page, /tryrepo fixture works/);
  });

  test("a failed clone is reported as an error, not a crash", async () => {
    const api = await fakeApi([{ content: "unused" }]);
    cleanup.push(api.close);
    const result = await build({
      source: parseSource("tryrepo-test-owner-that-does-not-exist/nope-nope"),
      agent: "openai",
      openai: { baseUrl: api.url, apiKey: "k", model: "m" },
      timeoutMin: 5,
      baseImage: DEFAULT_IMAGE,
      memoryBytes: 1024 ** 3,
      secretEnv: {},
      keep: false,
      ui: silentUi(),
      signal: new AbortController().signal,
    });
    assert.match(result.error ?? "", /git clone failed/);
    assert.equal(api.requests.length, 0, "the agent must not start when the clone fails");
  });
});
