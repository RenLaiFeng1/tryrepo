import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { UserError } from "./util.js";

export interface GitSource {
  type: "git";
  /** https clone URL */
  url: string;
  host: string;
  owner?: string;
  repo?: string;
  ref?: string;
  /** Subdirectory the user pointed at (from a /tree/<ref>/<dir> URL). */
  subdir?: string;
  /** Short human name, e.g. "owner/repo" */
  display: string;
  /** Stable cache key */
  key: string;
}

export interface LocalSource {
  type: "local";
  path: string;
  display: string;
  key: string;
}

export type Source = GitSource | LocalSource;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.\/+-]{0,199}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::\d{1,5})?$/;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_.@+-]{1,200}$/;

export function isValidRef(ref: string): boolean {
  return (
    REF_RE.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock") &&
    !ref.includes("@{")
  );
}

function validRepoName(repo: string): boolean {
  return REPO_RE.test(repo) && repo !== "." && repo !== "..";
}

function looksLocal(input: string): boolean {
  return (
    input === "." ||
    input === ".." ||
    input === "~" ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith(".\\") ||
    input.startsWith("..\\") ||
    input.startsWith("~/") ||
    input.startsWith("~\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(input) ||
    input.startsWith("\\\\")
  );
}

function gitHubSource(owner: string, repo: string, ref?: string, subdir?: string): GitSource {
  repo = repo.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner)) throw new UserError(`Invalid GitHub owner: "${owner}"`);
  if (!validRepoName(repo)) throw new UserError(`Invalid GitHub repository name: "${repo}"`);
  if (ref !== undefined && !isValidRef(ref)) throw new UserError(`Invalid git ref: "${ref}"`);
  const display = `${owner}/${repo}${ref ? `@${ref}` : ""}`;
  return {
    type: "git",
    url: `https://github.com/${owner}/${repo}.git`,
    host: "github.com",
    owner,
    repo,
    ref,
    subdir,
    display,
    key: `github.com/${owner}/${repo}${ref ? `@${ref}` : ""}`.toLowerCase(),
  };
}

/**
 * Accepts: owner/repo, owner/repo#ref, github.com/owner/repo, https://github.com/owner/repo[.git][/tree/ref[/dir]],
 * git@github.com:owner/repo.git, other https git URLs, and local directories (./dir, /abs/dir, C:\dir).
 */
export function parseSource(raw: string, opts: { ref?: string; cwd?: string } = {}): Source {
  const input = raw.trim();
  if (!input) throw new UserError("Missing repository. Example: tryrepo owner/repo");
  if (/[\s\u0000-\u001f\u007f]/.test(input)) throw new UserError(`Invalid repository: "${raw}"`);
  if (opts.ref !== undefined && !isValidRef(opts.ref)) throw new UserError(`Invalid git ref: "${opts.ref}"`);

  if (looksLocal(input)) {
    const expanded = input === "~" || input.startsWith("~/") || input.startsWith("~\\")
      ? resolve(homedir(), input.slice(2))
      : input;
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(opts.cwd ?? process.cwd(), expanded);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new UserError(`Local directory not found: ${abs}`);
    }
    return { type: "local", path: abs, display: basename(abs) || abs, key: `local:${abs}` };
  }

  // git@host:owner/repo.git
  const scp = /^git@([^:]+):(.+)$/.exec(input);
  if (scp && scp[1] && scp[2]) {
    return fromUrl(`https://${scp[1]}/${scp[2]}`, opts.ref);
  }

  // owner/repo or owner/repo#ref
  const short = /^([^/#:]+)\/([^/#:]+?)(?:#(.+))?$/.exec(input);
  if (short && short[1] && short[2] && !short[1].includes(".")) {
    return gitHubSource(short[1], short[2], opts.ref ?? short[3]);
  }

  if (/^https?:\/\//i.test(input)) return fromUrl(input, opts.ref);
  // github.com/owner/repo, gitlab.com/x/y
  if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\//.test(input)) return fromUrl(`https://${input}`, opts.ref);

  throw new UserError(`Not a repository: "${raw}"`, "Use owner/repo, a GitHub URL, a git URL, or ./local-dir");
}

function fromUrl(text: string, refOverride?: string): Source {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UserError(`Invalid URL: "${text}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserError(`Unsupported URL: "${text}"`);
  if (url.username || url.password) {
    throw new UserError("URLs with credentials are not supported (the sandbox only clones public repositories).");
  }
  const host = url.host.toLowerCase();
  if (!HOST_RE.test(host)) throw new UserError(`Invalid host in URL: "${text}"`);
  const segments = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const fragmentRef = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;

  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, kind, ref, ...rest] = segments;
    if (!owner || !repo) throw new UserError(`Not a GitHub repository URL: "${text}"`);
    let pathRef: string | undefined;
    let subdir: string | undefined;
    if ((kind === "tree" || kind === "blob" || kind === "commit") && ref) {
      pathRef = ref;
      const dirParts = kind === "blob" ? rest.slice(0, -1) : rest;
      if (dirParts.length && dirParts.every((p) => SAFE_PATH_SEGMENT_RE.test(p) && p !== "." && p !== "..")) {
        subdir = dirParts.join("/");
      }
    }
    return gitHubSource(owner, repo, refOverride ?? pathRef ?? fragmentRef, subdir);
  }

  // Generic https git host (GitLab, Codeberg, Gitee, self-hosted...).
  if (!segments.length || !segments.every((s) => SAFE_PATH_SEGMENT_RE.test(s) && s !== "." && s !== "..")) {
    throw new UserError(`Unsupported repository URL: "${text}"`);
  }
  const ref = refOverride ?? fragmentRef;
  if (ref !== undefined && !isValidRef(ref)) throw new UserError(`Invalid git ref: "${ref}"`);
  const clean = segments.join("/").replace(/\.git$/i, "");
  const parts = clean.split("/");
  const repo = parts[parts.length - 1];
  const owner = parts.length > 1 ? parts.slice(0, -1).join("/") : undefined;
  return {
    type: "git",
    url: `https://${host}/${clean}.git`,
    host,
    owner,
    repo,
    ref,
    display: `${host === "gitlab.com" ? "" : `${host}/`}${clean}${ref ? `@${ref}` : ""}`,
    key: `${host}/${clean}${ref ? `@${ref}` : ""}`.toLowerCase(),
  };
}

/** Docker-safe slug, e.g. "owner-repo". */
export function slugFor(source: Source): string {
  const base =
    source.type === "local"
      ? `local-${source.display}`
      : source.owner && source.repo
        ? `${source.owner}-${source.repo}`
        : source.repo ?? source.host;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "repo";
}
