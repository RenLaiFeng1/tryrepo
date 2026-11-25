import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root for all tryrepo state. Override with TRYREPO_HOME. */
export function homeDir(): string {
  return process.env.TRYREPO_HOME || join(homedir(), ".tryrepo");
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const recipesDir = (): string => ensure(join(homeDir(), "recipes"));
export const runsDir = (): string => ensure(join(homeDir(), "runs"));
/** Fixed working directory for agent CLIs, so their sessions are grouped in one place. */
export const agentCwd = (): string => ensure(join(homeDir(), "agent"));

export function newRunDir(runId: string): string {
  return ensure(join(runsDir(), runId));
}
