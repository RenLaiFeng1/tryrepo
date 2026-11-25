import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { recipesDir } from "./paths.js";
import type { EnvRequirement } from "./tools.js";

/** Everything needed to start a finished build again without the agent. */
export interface Recipe {
  version: 1;
  key: string;
  display: string;
  url?: string;
  ref?: string;
  commit?: string;
  image: string;
  kind: "web" | "cli";
  port?: number;
  path: string;
  title?: string;
  usage: string;
  requiredEnv: EnvRequirement[];
  notes?: string;
  agent: string;
  model?: string;
  buildSeconds: number;
  createdAt: string;
}

function fileFor(key: string): string {
  const safe = key.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return join(recipesDir(), `${safe}-${hash}.json`);
}

function isRecipe(v: unknown): v is Recipe {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r.version === 1 &&
    typeof r.key === "string" &&
    typeof r.image === "string" &&
    (r.kind === "web" || r.kind === "cli") &&
    typeof r.usage === "string" &&
    (r.kind === "cli" || (typeof r.port === "number" && Number.isInteger(r.port) && r.port > 0 && r.port < 65536))
  );
}

export function loadRecipe(key: string): Recipe | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileFor(key), "utf8"));
    if (!isRecipe(parsed) || parsed.key !== key) return undefined;
    return { ...parsed, path: typeof parsed.path === "string" ? parsed.path : "/", requiredEnv: parsed.requiredEnv ?? [] };
  } catch {
    return undefined;
  }
}

export function saveRecipe(recipe: Recipe): void {
  const file = fileFor(recipe.key);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(recipe, null, 2)}\n`);
  renameSync(tmp, file);
}

export function deleteRecipe(key: string): void {
  rmSync(fileFor(key), { force: true });
}

export function listRecipes(): Recipe[] {
  const dir = recipesDir();
  const out: Recipe[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isRecipe(parsed)) out.push(parsed);
    } catch {
      /* skip unreadable files */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
