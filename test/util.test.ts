import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, oneLine, parseEnvFlags, parseMemory, sanitize, truncateMiddle } from "../src/util.js";

test("sanitize strips terminal escapes and control characters", () => {
  assert.equal(sanitize("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitize("a\u001b]0;evil title\u0007b"), "ab");
  assert.equal(sanitize("x\u0007\u0008y\r\nz"), "xy\nz");
  assert.equal(sanitize("tab\tkept\nnewline"), "tab\tkept\nnewline");
  assert.equal(sanitize("\u009b31m"), "31m");
});

test("oneLine collapses whitespace and truncates", () => {
  assert.equal(oneLine("a\n  b\tc"), "a b c");
  assert.equal(oneLine("x".repeat(20), 10), `${"x".repeat(9)}…`);
});

test("truncateMiddle keeps head and tail", () => {
  const text = `${"a".repeat(1000)}MIDDLE${"z".repeat(1000)}`;
  const out = truncateMiddle(text, 200);
  assert.ok(out.startsWith("a".repeat(50)));
  assert.ok(out.endsWith("z".repeat(150)));
  assert.match(out, /characters omitted/);
  assert.equal(truncateMiddle("short", 100), "short");
});

test("parseMemory", () => {
  assert.equal(parseMemory("4g"), 4 * 1024 ** 3);
  assert.equal(parseMemory("512m"), 512 * 1024 ** 2);
  assert.equal(parseMemory("1.5G"), 1.5 * 1024 ** 3);
  assert.equal(parseMemory("2048"), 2048 * 1024 ** 2);
  assert.equal(parseMemory("lots"), undefined);
  assert.equal(parseMemory("0"), undefined);
});

test("parseEnvFlags", () => {
  assert.deepEqual(parseEnvFlags(["A=1", "B=x=y", "C"], { C: "from-env" }), { A: "1", B: "x=y", C: "from-env" });
  assert.deepEqual(parseEnvFlags(["EMPTY="], {}), { EMPTY: "" });
  assert.throws(() => parseEnvFlags(["MISSING"], {}), /not set/);
  assert.throws(() => parseEnvFlags(["1BAD=x"], {}), /Invalid/);
  assert.throws(() => parseEnvFlags(["A-B=x"], {}), /Invalid/);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_400), "59s");
  assert.equal(formatDuration(61_000), "1m01s");
  assert.equal(formatDuration(3_600_000), "1h00m");
});
