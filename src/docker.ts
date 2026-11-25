import { spawnProcess, run, type RunResult } from "./proc.js";
import { UserError } from "./util.js";

export const LABEL = "tryrepo";

export interface DockerInfo {
  serverVersion: string;
  memTotal: number;
  ncpu: number;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
  os: string;
}

export async function docker(args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
  return run("docker", args, opts);
}

function describeFailure(r: RunResult): string {
  if (r.spawnError) return r.spawnError.message;
  if (r.timedOut) return "timed out";
  return (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n") || `exit code ${r.code}`;
}

export async function dockerInfo(): Promise<DockerInfo> {
  const r = await docker(["info", "--format", "{{json .}}"], { timeoutMs: 30_000 });
  if (r.spawnError) {
    throw new UserError(
      "Docker is not installed (the `docker` command was not found).",
      "Install Docker Desktop (https://docs.docker.com/get-docker/) or Docker Engine, then retry.",
    );
  }
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  const serverVersion = typeof info.ServerVersion === "string" ? info.ServerVersion : "";
  if (r.code !== 0 || !serverVersion) {
    throw new UserError(
      "Docker is not running.",
      `Start Docker Desktop (or the Docker daemon) and retry. Details: ${describeFailure(r)}`,
    );
  }
  return {
    serverVersion,
    memTotal: typeof info.MemTotal === "number" ? info.MemTotal : 0,
    ncpu: typeof info.NCPU === "number" ? info.NCPU : 0,
    httpProxy: typeof info.HTTPProxy === "string" ? info.HTTPProxy : "",
    httpsProxy: typeof info.HTTPSProxy === "string" ? info.HTTPSProxy : "",
    noProxy: typeof info.NoProxy === "string" ? info.NoProxy : "",
    os: typeof info.OperatingSystem === "string" ? info.OperatingSystem : "",
  };
}

export async function imageExists(ref: string): Promise<boolean> {
  const r = await docker(["image", "inspect", "--format", "{{.Id}}", ref], { timeoutMs: 30_000 });
  return r.code === 0;
}

export async function imageSize(ref: string): Promise<number | undefined> {
  const r = await docker(["image", "inspect", "--format", "{{.Size}}", ref], { timeoutMs: 30_000 });
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(n) ? n : undefined;
}

/** Pull an image, reporting how many layers are done. */
export function pullImage(ref: string, onProgress?: (doneLayers: number, totalLayers: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("docker", ["pull", ref], { stdio: ["ignore", "pipe", "pipe"] });
    const layers = new Map<string, boolean>();
    let tail = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        const m = /^([0-9a-f]{12}): (.+)$/.exec(line.trim());
        if (!m || !m[1] || !m[2]) continue;
        const done = /Pull complete|Already exists/.test(m[2]);
        layers.set(m[1], done || layers.get(m[1]) === true);
        onProgress?.([...layers.values()].filter(Boolean).length, layers.size);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new UserError(`Failed to pull image ${ref}`, tail.trim().split("\n").slice(-3).join("\n")));
    });
  });
}

export interface ContainerSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  /** Non-secret environment, passed as NAME=value. */
  env?: Record<string, string>;
  /** Secret environment variable names; values are taken from `secretEnv` and never put on the command line. */
  passEnv?: string[];
  memoryBytes?: number;
  pidsLimit?: number;
  publish?: { containerPort: number; hostPort?: number }[];
  init?: boolean;
  workdir?: string;
  cmd: string[];
}

export function runArgs(spec: ContainerSpec): string[] {
  const args = ["run", "-d", "--name", spec.name];
  for (const [k, v] of Object.entries(spec.labels)) args.push("--label", `${k}=${v}`);
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const name of spec.passEnv ?? []) args.push("-e", name);
  if (spec.memoryBytes) args.push("--memory", String(spec.memoryBytes));
  if (spec.pidsLimit) args.push("--pids-limit", String(spec.pidsLimit));
  for (const p of spec.publish ?? []) {
    // Bind to loopback only: the app is reachable from this machine, not from the network.
    args.push("-p", `127.0.0.1:${p.hostPort ?? ""}:${p.containerPort}`);
  }
  if (spec.init) args.push("--init");
  if (spec.workdir) args.push("-w", spec.workdir);
  args.push(spec.image, ...spec.cmd);
  return args;
}

export async function runContainer(spec: ContainerSpec, secretEnv: Record<string, string> = {}): Promise<string> {
  const r = await docker(runArgs(spec), { timeoutMs: 120_000, env: { ...process.env, ...secretEnv } });
  if (r.code !== 0) {
    const msg = describeFailure(r);
    if (/port is already allocated|address already in use/i.test(msg)) {
      throw new UserError("The requested host port is already in use.", "Pick another one with --port, or omit --port.");
    }
    throw new UserError(`Failed to start a container: ${msg}`);
  }
  return r.stdout.trim();
}

export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", "-v", name], { timeoutMs: 60_000 });
}

export async function containerState(name: string): Promise<{ running: boolean; exitCode?: number } | undefined> {
  const r = await docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", name], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) return undefined;
  const [running, exitCode] = r.stdout.trim().split(" ");
  return { running: running === "true", exitCode: exitCode === undefined ? undefined : Number(exitCode) };
}

/** Host port Docker assigned for a published container port. */
export async function publishedPort(name: string, containerPort: number): Promise<number | undefined> {
  const r = await docker(["port", name, `${containerPort}/tcp`], { timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  for (const line of r.stdout.split("\n")) {
    const m = /:(\d+)\s*$/.exec(line.trim());
    if (m && m[1]) return Number(m[1]);
  }
  return undefined;
}

export async function logsTail(name: string, lines = 60): Promise<string> {
  const r = await docker(["logs", "--tail", String(lines), name], { timeoutMs: 30_000 });
  return `${r.stdout}${r.stderr}`.trim();
}

export async function commitContainer(name: string, tag: string, changes: string[]): Promise<void> {
  const args = ["commit"];
  for (const c of changes) args.push("--change", c);
  args.push(name, tag);
  const r = await docker(args, { timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw new UserError(`Failed to save the sandbox as an image: ${describeFailure(r)}`);
}

export async function removeImage(ref: string): Promise<boolean> {
  const r = await docker(["rmi", ref], { timeoutMs: 120_000 });
  return r.code === 0;
}

export interface ContainerRow {
  name: string;
  image: string;
  status: string;
  labels: Record<string, string>;
  ports: string;
}

export async function listContainers(label = LABEL): Promise<ContainerRow[]> {
  const r = await docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{json .}}"], { timeoutMs: 30_000 });
  if (r.code !== 0) return [];
  const rows: ContainerRow[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Record<string, string>;
      const labels: Record<string, string> = {};
      for (const pair of (j.Labels ?? "").split(",")) {
        const i = pair.indexOf("=");
        if (i > 0) labels[pair.slice(0, i)] = pair.slice(i + 1);
      }
      rows.push({ name: j.Names ?? "", image: j.Image ?? "", status: j.Status ?? "", labels, ports: j.Ports ?? "" });
    } catch {
      /* skip */
    }
  }
  return rows;
}

export async function listImages(reference: string): Promise<{ ref: string; size: string; created: string }[]> {
  const r = await docker(["images", "--filter", `reference=${reference}`, "--format", "{{json .}}"], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) return [];
  const out: { ref: string; size: string; created: string }[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Record<string, string>;
      out.push({ ref: `${j.Repository}:${j.Tag}`, size: j.Size ?? "", created: j.CreatedSince ?? "" });
    } catch {
      /* skip */
    }
  }
  return out;
}
