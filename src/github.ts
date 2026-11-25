export interface RepoMeta {
  stars: number;
  description?: string;
  language?: string;
  defaultBranch?: string;
  sizeKb?: number;
  archived: boolean;
}

/** Best-effort repository metadata from the GitHub API. Never throws. */
export async function fetchRepoMeta(owner: string, repo: string, timeoutMs = 5000): Promise<RepoMeta | undefined> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tryrepo",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return undefined;
    const j = (await res.json()) as Record<string, unknown>;
    return {
      stars: typeof j.stargazers_count === "number" ? j.stargazers_count : 0,
      description: typeof j.description === "string" ? j.description : undefined,
      language: typeof j.language === "string" ? j.language : undefined,
      defaultBranch: typeof j.default_branch === "string" ? j.default_branch : undefined,
      sizeKb: typeof j.size === "number" ? j.size : undefined,
      archived: j.archived === true,
    };
  } catch {
    return undefined;
  }
}
