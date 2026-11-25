import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isValidRef, parseSource, slugFor } from "../src/source.js";

test("owner/repo shorthand", () => {
  const s = parseSource("vitejs/vite");
  assert.equal(s.type, "git");
  if (s.type !== "git") return;
  assert.equal(s.url, "https://github.com/vitejs/vite.git");
  assert.equal(s.display, "vitejs/vite");
  assert.equal(s.key, "github.com/vitejs/vite");
  assert.equal(s.ref, undefined);
});

test("owner/repo#ref and --ref", () => {
  const a = parseSource("vitejs/vite#v5.0.0");
  assert.equal(a.type === "git" && a.ref, "v5.0.0");
  assert.equal(a.key, "github.com/vitejs/vite@v5.0.0");
  const b = parseSource("vitejs/vite", { ref: "main" });
  assert.equal(b.type === "git" && b.ref, "main");
});

test("GitHub URLs in many shapes", () => {
  for (const input of [
    "https://github.com/Owner/Repo",
    "https://github.com/Owner/Repo/",
    "https://github.com/Owner/Repo.git",
    "http://github.com/Owner/Repo",
    "github.com/Owner/Repo",
    "https://www.github.com/Owner/Repo",
    "git@github.com:Owner/Repo.git",
    "https://github.com/Owner/Repo?tab=readme-ov-file",
  ]) {
    const s = parseSource(input);
    assert.equal(s.type, "git", input);
    if (s.type !== "git") continue;
    assert.equal(s.url, "https://github.com/Owner/Repo.git", input);
    assert.equal(s.key, "github.com/owner/repo", input);
  }
});

test("tree URL gives ref and subdir", () => {
  const s = parseSource("https://github.com/vercel/next.js/tree/canary/examples/hello-world");
  assert.equal(s.type, "git");
  if (s.type !== "git") return;
  assert.equal(s.ref, "canary");
  assert.equal(s.subdir, "examples/hello-world");
  const blob = parseSource("https://github.com/a/b/blob/main/docs/README.md");
  assert.equal(blob.type === "git" && blob.subdir, "docs");
});

test("generic https hosts", () => {
  const s = parseSource("https://gitlab.com/group/sub/project");
  assert.equal(s.type, "git");
  if (s.type !== "git") return;
  assert.equal(s.url, "https://gitlab.com/group/sub/project.git");
  assert.equal(s.repo, "project");
  assert.equal(s.owner, "group/sub");
  const c = parseSource("https://codeberg.org/forgejo/forgejo.git");
  assert.equal(c.type === "git" && c.url, "https://codeberg.org/forgejo/forgejo.git");
});

test("rejects dangerous or malformed input", () => {
  for (const bad of [
    "",
    "   ",
    "owner/repo; rm -rf /",
    "owner/re po",
    "https://user:pass@github.com/a/b",
    "ftp://example.com/a/b",
    "https://github.com/onlyowner",
    "-x/repo",
    "owner/repo#--upload-pack=evil",
    "owner/repo#a..b",
    "https://example.com/a/$(id)",
    "file:///etc/passwd",
    "owner/..",
  ]) {
    assert.throws(() => parseSource(bad), Error, `should reject: ${JSON.stringify(bad)}`);
  }
});

test("ref validation", () => {
  for (const ok of ["main", "v1.2.3", "feature/x", "release-2026.11", "0123abc", "a".repeat(40)]) assert.ok(isValidRef(ok), ok);
  for (const bad of ["-rf", "--branch", "a..b", "a b", "x/", "x.lock", "@{1}", "/abs"]) assert.ok(!isValidRef(bad), bad);
});

test("local directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "tryrepo-src-"));
  const s = parseSource(dir);
  assert.equal(s.type, "local");
  assert.equal(s.type === "local" && s.path, dir);
  assert.throws(() => parseSource(join(dir, "missing")));
  const rel = parseSource(".", { cwd: dir });
  assert.equal(rel.type === "local" && rel.path, dir);
});

test("slugs are docker-safe", () => {
  assert.equal(slugFor(parseSource("Vercel/Next.js")), "vercel-next-js");
  assert.match(slugFor(parseSource("a_b/C--D")), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(slugFor(parseSource(`x/${"y".repeat(100)}`)).length <= 60);
});
