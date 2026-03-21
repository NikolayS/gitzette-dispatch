/**
 * GitLab data fetcher for the dispatch generator.
 * Returns the same RepoData[] shape as the GitHub fetcher.
 */

// Re-use the same interface shape (duplicated here so gitlab.ts is self-contained)
interface Release {
  tag: string;
  name: string;
  date: string;
  body: string;
  url: string;
}

interface PR {
  number: number;
  title: string;
  state: "open" | "merged";
  date?: string;
  mergedAt?: string;
  url: string;
  author: string;
  body?: string | null;
}

interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  date: string;
  url: string;
  author: string;
}

export interface RepoData {
  name: string;
  description: string | null;
  url: string;
  stars: number;
  releases: Release[];
  mergedPRs: PR[];
  openPRs: PR[];
  openIssues: Issue[];
  commitCount: number;
  topContributors: string[];
  demoImages: string[];
}

// ── GitLab API ────────────────────────────────────────────────────────────────

const GL_BASE = "https://gitlab.com/api/v4";

async function glGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${GL_BASE}${path}`, {
    headers: { "PRIVATE-TOKEN": token },
  });
  if (!res.ok) return []; // graceful fallback for disabled features / 404s
  return res.json();
}

// ── main fetcher ──────────────────────────────────────────────────────────────

export async function fetchGitLabData(
  owner: string,
  from: Date,
  to: Date,
  token: string
): Promise<RepoData[]> {
  // 1. List user's own projects (non-forked)
  const projects = await glGet(
    `/users/${owner}/projects?owned=true&per_page=100`,
    token
  );

  if (!Array.isArray(projects)) {
    console.warn("  GitLab: unexpected response for user projects (check token / username)");
    return [];
  }

  const nonForks = projects.filter((p: any) => !p.forked_from_project);

  const results: RepoData[] = [];

  for (const project of nonForks) {
    const fromStr = from.toISOString();
    const toStr = to.toISOString();

    // ── commits by owner ──────────────────────────────────────────────────
    const commits: any[] = await glGet(
      `/projects/${project.id}/repository/commits?since=${fromStr}&until=${toStr}&per_page=100`,
      token
    ).catch(() => []);

    const ownerCommits = commits.filter(
      (c: any) =>
        c.author_name?.toLowerCase().includes(owner.toLowerCase()) ||
        c.author_email?.toLowerCase().includes(owner.toLowerCase())
    );

    if (ownerCommits.length === 0) continue; // quiet week — skip

    // ── merged MRs ────────────────────────────────────────────────────────
    const mrs: any[] = await glGet(
      `/projects/${project.id}/merge_requests?state=merged&updated_after=${fromStr}&per_page=50`,
      token
    ).catch(() => []);

    const ownerMRs = mrs.filter(
      (mr: any) =>
        mr.merged_at &&
        new Date(mr.merged_at) >= from &&
        new Date(mr.merged_at) <= to
    );

    // ── releases ──────────────────────────────────────────────────────────
    const releases: any[] = await glGet(
      `/projects/${project.id}/releases?per_page=10`,
      token
    ).catch(() => []);

    const weekReleases = releases.filter((r: any) => {
      const d = new Date(r.released_at || r.created_at);
      return d >= from && d <= to;
    });

    // ── top contributors (from commits this week) ─────────────────────────
    const contributorMap: Record<string, number> = {};
    for (const c of ownerCommits) {
      const name = c.author_name || c.committer_name || "unknown";
      contributorMap[name] = (contributorMap[name] || 0) + 1;
    }
    const topContributors = Object.entries(contributorMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    results.push({
      name: project.path,
      description: project.description || null,
      url: project.web_url,
      stars: project.star_count || 0,
      commitCount: ownerCommits.length,
      commits: ownerCommits.slice(0, 5).map((c: any) => ({
        sha: c.id,
        message: c.title,
        date: c.created_at,
        url: `${project.web_url}/-/commit/${c.id}`,
      })),
      releases: weekReleases.map((r: any) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        date: r.released_at || r.created_at,
        body: r.description || "",
        url: r._links?.self || project.web_url,
      })),
      mergedPRs: ownerMRs.map((mr: any) => ({
        number: mr.iid,
        title: mr.title,
        state: "merged" as const,
        date: mr.merged_at,
        mergedAt: mr.merged_at,
        url: mr.web_url,
        author: mr.author?.username || owner,
        body: mr.description || null,
      })),
      openPRs: [],
      openIssues: [],
      demoImages: [],
      topContributors,
    });
  }

  return results;
}
