import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OpenAIConfig } from "./agents/openai.js";
import { removeContainer, removeImage } from "./docker.js";
import { fetchRepoMeta } from "./github.js";
import { build, type AgentKind } from "./pipeline.js";
import { startWeb } from "./runner.js";
import { parseSource } from "./source.js";
import { silentUi, type Ui } from "./ui.js";
import { errorMessage, formatDuration, oneLine } from "./util.js";

export interface BenchOptions {
  file: string;
  parallel: number;
  outDir: string;
  agent: AgentKind;
  model?: string;
  openai?: OpenAIConfig;
  timeoutMin: number;
  baseImage: string;
  memoryBytes: number;
  keepImages: boolean;
  ui: Ui;
  signal: AbortSignal;
}

export interface BenchRow {
  repo: string;
  status: "works" | "unsupported" | "failed" | "error";
  kind?: string;
  httpStatus?: number;
  minutes: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  turns?: number;
  toolCalls?: number;
  detail: string;
  runDir?: string;
}

export function readRepoList(file: string): string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

async function benchOne(repo: string, opts: BenchOptions): Promise<BenchRow> {
  const started = Date.now();
  const minutes = () => Math.round((Date.now() - started) / 6000) / 10;
  let source;
  try {
    source = parseSource(repo);
  } catch (err) {
    return { repo, status: "error", minutes: 0, detail: errorMessage(err) };
  }
  const meta = source.type === "git" && source.host === "github.com" && source.owner && source.repo
    ? await fetchRepoMeta(source.owner, source.repo)
    : undefined;
  const result = await build({
    source,
    meta,
    agent: opts.agent,
    model: opts.model,
    openai: opts.openai,
    timeoutMin: opts.timeoutMin,
    baseImage: opts.baseImage,
    memoryBytes: opts.memoryBytes,
    secretEnv: {},
    keep: false,
    ui: silentUi(),
    signal: opts.signal,
  });
  const base = {
    repo,
    costUsd: result.outcome?.costUsd,
    inputTokens: result.outcome?.inputTokens,
    outputTokens: result.outcome?.outputTokens,
    cacheReadTokens: result.outcome?.cacheReadTokens,
    turns: result.outcome?.turns,
    runDir: result.runDir,
  };
  const report = result.report;
  if (!report || result.error) {
    return { ...base, status: "error", minutes: minutes(), detail: result.error ?? "no report" };
  }
  if (report.outcome === "failure") {
    return { ...base, status: report.reason === "unsupported" ? "unsupported" : "failed", minutes: minutes(), detail: oneLine(report.summary, 300) };
  }
  const recipe = result.recipe;
  if (!recipe) return { ...base, status: "error", minutes: minutes(), detail: "no recipe was saved" };
  let row: BenchRow;
  if (recipe.kind === "web") {
    // Prove it from the host, exactly like a user would open it.
    const run = await startWeb({ recipe, secretEnv: {}, memoryBytes: opts.memoryBytes, healthTimeoutSec: 180, signal: opts.signal, ui: silentUi() });
    await removeContainer(run.container);
    row = run.ok
      ? { ...base, status: "works", kind: "web", httpStatus: run.httpStatus, minutes: minutes(), detail: oneLine(recipe.usage, 200) }
      : { ...base, status: "failed", kind: "web", minutes: minutes(), detail: `host check failed: ${run.error ?? "?"}` };
  } else {
    row = { ...base, status: "works", kind: "cli", minutes: minutes(), detail: oneLine(recipe.usage, 200) };
  }
  if (!opts.keepImages) await removeImage(recipe.image);
  return row;
}

export function markdownTable(rows: BenchRow[]): string {
  const icon: Record<BenchRow["status"], string> = { works: "✅", unsupported: "⚪", failed: "❌", error: "⚠️" };
  const lines = [
    "| Repository | Result | Kind | Time | Cost | Notes |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.repo} | ${icon[r.status]} ${r.status} | ${r.kind ?? ""} | ${r.minutes} min | ${r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : ""} | ${r.detail.replace(/\|/g, "\\|")} |`,
    ),
  ];
  const works = rows.filter((r) => r.status === "works").length;
  const runnable = rows.filter((r) => r.status !== "unsupported").length;
  const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  lines.push(
    "",
    `Works: ${works}/${rows.length} overall, ${works}/${runnable} excluding unsupported projects. ` +
      `Median time: ${median(rows.filter((r) => r.status === "works").map((r) => r.minutes))} min. Total cost: $${cost.toFixed(2)}.`,
  );
  return lines.join("\n");
}

function median(values: number[]): string {
  if (!values.length) return "-";
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  return String(Math.round(m * 10) / 10);
}

export async function runBench(opts: BenchOptions): Promise<BenchRow[]> {
  const repos = readRepoList(opts.file);
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const rows: BenchRow[] = new Array(repos.length);
  let next = 0;
  const save = () => {
    const done = rows.filter(Boolean);
    writeFileSync(join(outDir, "results.json"), `${JSON.stringify(done, null, 2)}\n`);
    writeFileSync(join(outDir, "results.md"), `${markdownTable(done)}\n`);
  };
  const worker = async () => {
    while (!opts.signal.aborted) {
      const i = next++;
      const repo = repos[i];
      if (repo === undefined) return;
      opts.ui.step(`[${i + 1}/${repos.length}] ${repo}`);
      let row: BenchRow;
      try {
        row = await benchOne(repo, opts);
      } catch (err) {
        row = { repo, status: "error", minutes: 0, detail: errorMessage(err) };
      }
      rows[i] = row;
      const line = `${repo}: ${row.status}${row.kind ? ` (${row.kind})` : ""} in ${formatDuration(row.minutes * 60_000)}${row.costUsd !== undefined ? `, $${row.costUsd.toFixed(2)}` : ""} — ${oneLine(row.detail, 120)}`;
      if (row.status === "works") opts.ui.ok(line);
      else if (row.status === "unsupported") opts.ui.warn(line);
      else opts.ui.fail(line);
      save();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel, repos.length)) }, worker));
  save();
  return rows.filter(Boolean);
}
