#!/usr/bin/env bun
/**
 * dispatch generator
 * pulls live data from github, writes creative copy via llm, outputs index.html
 *
 * usage:
 *   bun scripts/generate.ts --from 2026-03-15 --to 2026-03-21
 *   bun scripts/generate.ts  # defaults to last 7 days
 *
 * env:
 *   GITHUB_TOKEN   — required (gh api calls)
 *   ANTHROPIC_API_KEY — required (copy generation)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";

// Load .env from project root — overrides placeholder env vars injected by host process
const _envPath = join(import.meta.dir, "../.env");
if (existsSync(_envPath)) {
  for (const line of readFileSync(_envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      const val = m[2].replace(/^['"]|['"]$/g, "");
      // Always override if current value looks like a placeholder
      if (!process.env[m[1]] || process.env[m[1]]?.includes("PLACEHOLDER")) {
        process.env[m[1]] = val;
      }
    }
  }
}
import { prepare, layout } from "@chenglou/pretext";

// Load editorial style guide (EDITORIAL.md) — injected into LLM prompt at runtime
const EDITORIAL_PATH = join(dirname(import.meta.dir), "EDITORIAL.md");
const EDITORIAL_GUIDE = existsSync(EDITORIAL_PATH)
  ? readFileSync(EDITORIAL_PATH, "utf8")
  : "";
import fs from "fs/promises";
import { join, dirname } from "path";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── config ──────────────────────────────────────────────────────────────────

interface Config {
  owner: string;
  repos: { exclude?: string[]; include?: string[] };
  model: string;
  output: string;
  knownIncidents?: string[];
  knownIncidentsByWeek?: Record<string, string[]>; // week_key (e.g. "2026-W13") → incidents only for that week
  imageGen?: { provider: string; model: string; style: string };
}

// Support --config <path> before full arg parse so config is available at module level
const _configArgIdx = process.argv.indexOf("--config");
const CONFIG_PATH = _configArgIdx !== -1 && process.argv[_configArgIdx + 1]
  ? (process.argv[_configArgIdx + 1].startsWith("/")
    ? process.argv[_configArgIdx + 1]
    : join(ROOT, process.argv[_configArgIdx + 1]))
  : join(ROOT, "dispatch.config.json");

const config: Config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

// ── cli args ─────────────────────────────────────────────────────────────────

function parseArgs(): { from: Date; to: Date; noFetch: boolean; noLlm: boolean; provider: string } {
  const args = process.argv.slice(2);
  let from: Date | undefined;
  let to: Date | undefined;
  let noFetch = false;
  let noLlm = false;
  let noIllustrations = false;
  let owner: string | undefined;
  let output: string | undefined;
  let provider = "github"; // default provider

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) from = new Date(args[++i]);
    if (args[i] === "--to" && args[i + 1]) to = new Date(args[++i]);
    if (args[i] === "--no-fetch") noFetch = true;
    if (args[i] === "--no-llm") noLlm = true;
    if (args[i] === "--no-illustrations") noIllustrations = true;
    if (args[i] === "--owner" && args[i + 1]) owner = args[++i];
    if (args[i] === "--output" && args[i + 1]) output = args[++i];
    if (args[i] === "--provider" && args[i + 1]) provider = args[++i];
  }

  if (!to) to = new Date();
  if (!from) {
    // Default: Monday 00:00 AoE (= Monday 12:00 UTC) of current week.
    // AoE (UTC-12) ensures the week doesn't roll until everyone on Earth finishes their Sunday.
    const AOE_MS = 12 * 60 * 60 * 1000;
    const nowAoE = new Date(Date.now() - AOE_MS);
    const dayOfWeek = (nowAoE.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    const mondayAoE = new Date(nowAoE);
    mondayAoE.setUTCDate(nowAoE.getUTCDate() - dayOfWeek);
    mondayAoE.setUTCHours(0, 0, 0, 0);
    from = new Date(mondayAoE.getTime() + AOE_MS); // Mon 00:00 AoE = Mon 12:00 UTC
  }

  return { from, to, noFetch, noLlm, noIllustrations, owner, output, provider };
}

// ── provider tokens ───────────────────────────────────────────────────────────

const GH_TOKEN = process.env.GITHUB_TOKEN;
const GL_TOKEN = process.env.GITLAB_TOKEN;

// github api ──────────────────────────────────────────────────────────────────

async function ghGet(path: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  if (!GH_TOKEN) throw new Error("GITHUB_TOKEN not set");
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

async function listRepos(owner: string): Promise<string[]> {
  const data = await ghGet(`/users/${owner}/repos?per_page=100&sort=pushed`);
  // skip forks — they add noise and inflate scan time
  return data.filter((r: any) => !r.fork).map((r: any) => r.name);
}

// Returns "owner/repo" strings for repos the user contributed to but doesn't own
// Uses GitHub search API: commits authored by user in the date window
async function listContributedRepos(owner: string, from: Date, to: Date): Promise<string[]> {
  const since = from.toISOString().slice(0, 10);
  const until = to.toISOString().slice(0, 10);
  const query = `author:${owner}+committer-date:${since}..${until}`;
  const data = await ghGet(
    `/search/commits?q=${query}&per_page=100&sort=committer-date&order=desc`,
    { Accept: "application/vnd.github.cloak-preview" }
  ).catch(() => ({ items: [] }));
  const items = data.items || [];
  const repoFullNames = new Set<string>();
  for (const item of items) {
    const fullName: string = item.repository?.full_name;
    if (fullName && !fullName.startsWith(`${owner}/`)) {
      repoFullNames.add(fullName); // only foreign repos
    }
  }
  return Array.from(repoFullNames).slice(0, 10); // cap at 10 foreign repos
}

// ── issue context enrichment ──────────────────────────────────────────────────

/** Parse "fixes #N", "closes #N", "refs #N", "resolves #N" from PR body text */
function parseLinkedIssues(prBody: string | null): number[] {
  if (!prBody) return [];
  const matches = prBody.matchAll(/(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|ref(?:erences)?)\s+#(\d+)/gi);
  const nums = new Set<number>();
  for (const m of matches) nums.add(parseInt(m[1], 10));
  return Array.from(nums);
}

/** Fetch PR body from GitHub API (uses cached reposData.mergedPRs body if present) */
async function fetchPrBody(repoOwner: string, repoName: string, prNumber: number): Promise<string | null> {
  try {
    const data = await ghGet(`/repos/${repoOwner}/${repoName}/pulls/${prNumber}`);
    return data.body ?? null;
  } catch {
    return null;
  }
}

/** Fetch issue title + body + first 3 comments.
 *  Date-gate: if the issue was created AND closed before `fromDate`, skip it —
 *  it's a stale incident that pre-dates the current week and shouldn't colour
 *  this week's copy (e.g. a security leak fixed three weeks ago). */
async function fetchIssueContext(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  fromDate?: string   // ISO date string, e.g. "2026-03-23"
): Promise<string> {
  try {
    const [issue, comments] = await Promise.all([
      ghGet(`/repos/${repoOwner}/${repoName}/issues/${issueNumber}`),
      ghGet(`/repos/${repoOwner}/${repoName}/issues/${issueNumber}/comments?per_page=3`).catch(() => []),
    ]);

    // Date-gate: skip stale closed issues that pre-date the current week
    if (fromDate && issue.closed_at) {
      const closedAt = new Date(issue.closed_at);
      const createdAt = new Date(issue.created_at);
      const from = new Date(fromDate);
      if (closedAt < from && createdAt < from) {
        // Issue was opened and closed entirely before this week — skip it
        return "";
      }
    }

    const lines: string[] = [
      `Issue #${issueNumber}: ${issue.title}`,
      issue.body ? issue.body.slice(0, 1500) : "(no body)",
    ];
    for (const c of (comments as any[]).slice(0, 5)) {
      if (c.body) lines.push(`Comment: ${c.body.slice(0, 600)}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

interface ArticleIssueContext {
  repo: string;        // repo short name
  issueContexts: string[]; // one string per linked issue
}

/**
 * After LLM picks articles, fetch linked issue context for chosen repos.
 * Deduplicates by repo — fetches each repo's PR bodies once regardless of
 * how many articles reference it. Only fetches for repos that appear in
 * the chosen article list (efficiency: skip repos that got cut entirely).
 */
async function enrichArticlesWithIssueContext(
  articles: Array<{ repo: string; repos?: string[]; headline: string }>,
  reposData: RepoData[],
  repoOwner: string,  // GitHub owner of the repos (e.g. "cyberdem0n")
  fromDate?: Date     // Date object for date-gating stale issue context
): Promise<ArticleIssueContext[]> {
  const fromDateStr = fromDate?.toISOString().slice(0, 10);
  // Deduplicate repos — one fetch pass per repo, not per article
  // Include all repos from multi-repo articles (repos array)
  const chosenRepoNames = [...new Set(articles.flatMap(a => a.repos && a.repos.length > 0 ? a.repos : [a.repo]))];
  const results: ArticleIssueContext[] = [];

  for (const repoName of chosenRepoNames) {
    const repoData = reposData.find(r => r.name === repoName);
    if (!repoData) continue;

    const candidatePRs = repoData.mergedPRs.slice(0, 20);
    if (candidatePRs.length === 0) continue;

    // PR bodies are already in cache from getRepoData; fetchPrBody only as fallback
    const prBodies = await Promise.all(
      candidatePRs.map(async pr => {
        const body = pr.body ?? await fetchPrBody(repoOwner, repoData.name, pr.number);
        return body;
      })
    );

    // Collect all linked issue numbers across this repo's candidate PRs
    const linkedIssueNums = new Set<number>();
    for (const body of prBodies) {
      for (const n of parseLinkedIssues(body)) linkedIssueNums.add(n);
    }

    if (linkedIssueNums.size === 0) continue;

    // Fetch issue context in parallel (cap at 10 issues per repo)
    // Pass fromDate so stale closed issues are excluded (date-gate)
    const issueContexts = (await Promise.all(
      Array.from(linkedIssueNums).slice(0, 10).map(num =>
        fetchIssueContext(repoOwner, repoData.name, num, fromDateStr)
      )
    )).filter(Boolean);

    if (issueContexts.length > 0) {
      results.push({ repo: repoName, issueContexts });
    }
  }

  return results;
}

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
  date: string;
  url: string;
  author: string;
  body: string | null;
}

interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  date: string;
  url: string;
  author: string;
}

interface RepoData {
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
  demoImages: string[]; // resolved raw URLs to screenshots/GIFs from README
}

import sharp from "sharp";
import { fetchGitLabData } from "./gitlab.ts";

/** Fetch an image URL and convert to newspaper style:
 *  grayscale + contrast boost + slight grain. Returns data URI or null. */
async function newspaperifyBuffer(buf: Buffer): Promise<string | null> {
  try {
    const processed = await sharp(buf)
      .grayscale()
      .normalise() // auto levels
      .modulate({ brightness: 0.92, saturation: 0 })
      .sharpen({ sigma: 0.8 }) // crisp edges like newsprint
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
    return `data:image/jpeg;base64,${processed.toString("base64")}`;
  } catch (e) {
    console.warn(`  failed to process image buffer: ${e}`);
    return null;
  }
}

const IMAGES_CACHE_DIR = path.join(import.meta.dir, "../.cache/images");
await fs.mkdir(IMAGES_CACHE_DIR, { recursive: true });
const IMAGES_RAW_BASE = "https://raw.githubusercontent.com/NikolayS/gitzette-dispatch/main/.cache/images";

/** Fetch a remote image, newspaperify it, save to .cache/images/<slug>.jpg, return GitHub raw URL. */
async function newspaperify(url: string, cacheSlug: string): Promise<string | null> {
  const cachePath = path.join(IMAGES_CACHE_DIR, `${cacheSlug}.jpg`);
  // return cached URL if already on disk
  try {
    await fs.access(cachePath);
    return `${IMAGES_RAW_BASE}/${cacheSlug}.jpg`;
  } catch {}
  try {
    const res = await fetch(url, {
      headers: { Authorization: `token ${GH_TOKEN}` },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const processed = await sharp(buf)
      .grayscale()
      .normalise()
      .modulate({ brightness: 0.92, saturation: 0 })
      .sharpen({ sigma: 0.8 })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
    await fs.writeFile(cachePath, processed);
    return `${IMAGES_RAW_BASE}/${cacheSlug}.jpg`;
  } catch (e) {
    console.warn(`  failed to process image ${url}: ${e}`);
    return null;
  }
}

/** Extract non-badge image URLs from a repo's README */
async function getReadmeImages(owner: string, repo: string): Promise<string[]> {
  try {
    const readme = await ghGet(`/repos/${owner}/${repo}/readme`);
    const content = Buffer.from(readme.content, "base64").toString("utf8");
    const defaultBranch = readme.url.includes("main") ? "main" : "master";

    // extract all markdown images: ![alt](url)
    const matches = [...content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
    const images: string[] = [];

    // patterns to skip
    const skipPatterns = [
      /shields\.io/,
      /badge/i,
      /codecov/,
      /github\.com\/[^/]+\/[^/]+\/actions/,
      /githubusercontent\.com\/[^/]+\/[^/]+\/actions/,
      /img\.shields/,
      /badgen/,
      /\.gif$/i, // no GIFs — static only
    ];

    for (const [, alt, url] of matches) {
      if (skipPatterns.some((p) => p.test(url) || p.test(alt))) continue;

      let resolved = url;
      if (!url.startsWith("http")) {
        resolved = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${url.replace(/^\.\//, "")}`;
      }
      // fetch + process to newspaper style, cache to git
      const slug = `${owner}-${repo}-${images.length}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const imgUrl = await newspaperify(resolved, slug);
      if (imgUrl) images.push(imgUrl);
    }

    return images; // no per-repo cap; MAX_REPO_IMAGES in buildHtml limits total shown
  } catch {
    return [];
  }
}

async function getRepoData(owner: string, repo: string, from: Date, to: Date, authorFilter?: string): Promise<RepoData | null> {
  try {
    const info = await ghGet(`/repos/${owner}/${repo}`);

    // releases in window
    const allReleases = await ghGet(`/repos/${owner}/${repo}/releases?per_page=20`).catch(() => []);
    const releases: Release[] = allReleases
      .filter((r: any) => {
        const d = new Date(r.published_at);
        return d >= from && d <= to;
      })
      .map((r: any) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        date: r.published_at,
        body: r.body || "",
        url: r.html_url,
      }));

    // PRs — merged in window
    const allPRs = await ghGet(`/repos/${owner}/${repo}/pulls?state=closed&per_page=50&sort=updated&direction=desc`).catch(() => []);
    const mergedPRs: PR[] = allPRs
      .filter((p: any) => {
        if (!p.merged_at) return false;
        const d = new Date(p.merged_at);
        if (!(d >= from && d <= to)) return false;
        // only count PRs authored by the target contributor
        const author = p.user?.login || "";
        const expectedAuthor = (authorFilter || owner).toLowerCase();
        return author.toLowerCase() === expectedAuthor;
      })
      .map((p: any) => ({
        number: p.number,
        title: p.title,
        state: "merged" as const,
        date: p.merged_at,
        url: p.html_url,
        author: p.user?.login || "unknown",
        body: p.body,
      }));

    // PRs — opened within this week's window (not all currently open)
    const openPRsRaw = await ghGet(`/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=created&direction=desc`).catch(() => []);
    const openPRs: PR[] = openPRsRaw
      .filter((p: any) => {
        const d = new Date(p.created_at);
        return d >= from && d <= to;
      })
      .map((p: any) => ({
        number: p.number,
        title: p.title,
        state: "open" as const,
        date: p.created_at,
        url: p.html_url,
        author: p.user?.login || "unknown",
        body: p.body,
      }));

    // Issues — currently open (exclude PRs)
    const openIssuesRaw = await ghGet(`/repos/${owner}/${repo}/issues?state=open&per_page=20`).catch(() => []);
    const openIssues: Issue[] = openIssuesRaw
      .filter((i: any) => !i.pull_request)
      .map((i: any) => ({
        number: i.number,
        title: i.title,
        state: "open" as const,
        date: i.created_at,
        url: i.html_url,
        author: i.user?.login || "unknown",
      }));

    // commit count in window
    const fromStr = from.toISOString();
    const toStr = to.toISOString();
    let commitCount = 0;
    const contributorMap: Record<string, number> = {};
    try {
      const commitAuthor = authorFilter || owner;
      const commits = await ghGet(
        `/repos/${owner}/${repo}/commits?since=${fromStr}&until=${toStr}&per_page=100&author=${commitAuthor}`
      );
      commitCount = commits.length;
      for (const c of commits) {
        const login = c.author?.login || c.commit?.author?.name || "unknown";
        contributorMap[login] = (contributorMap[login] || 0) + 1;
      }
    } catch (_) {
      // empty repo or no commits
    }

    const topContributors = Object.entries(contributorMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([login]) => login);

    // skip repos with nothing happening THIS WEEK
    if (
      releases.length === 0 &&
      mergedPRs.length === 0 &&
      commitCount === 0
    ) {
      return null;
    }

    const demoImages = await getReadmeImages(owner, repo);

    return {
      name: repo,
      description: info.description,
      url: info.html_url,
      stars: info.stargazers_count ?? 0,
      releases,
      mergedPRs,
      openPRs,
      openIssues,
      commitCount,
      topContributors,
      demoImages,
    };
  } catch (err) {
    console.error(`  skipping ${repo}: ${err}`);
    return null;
  }
}

// ── image generation ──────────────────────────────────────────────────────────

const ILLUS_CACHE_DIR = path.join(import.meta.dir, "../.cache/illustrations");
await fs.mkdir(ILLUS_CACHE_DIR, { recursive: true });

function illusCachePath(subject: string): string {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  return path.join(ILLUS_CACHE_DIR, `${slug}.txt`);
}

const CF_ACCOUNT = "a3265e0d0db71fdece29365819452f00";
const CF_R2_BUCKET = "gitzette-dispatches";

/** Upload a JPEG buffer to R2 at illustrations/<slug>.jpg, return public Worker URL. */
async function uploadIllustrationToR2(slug: string, buf: Buffer, contentType = "image/jpeg"): Promise<string | null> {
  const cfToken = process.env.CF_TOKEN;
  if (!cfToken) { console.warn("  no CF_TOKEN — can't upload illustration"); return null; }
  const ext = contentType === "image/png" ? "png" : "jpg";
  const key = encodeURIComponent(`illustrations/${slug}.${ext}`);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets/${CF_R2_BUCKET}/objects/${key}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${cfToken}`, "Content-Type": contentType },
        body: buf,
      }
    );
    const data: any = await res.json();
    if (!data.success) { console.warn(`  R2 upload failed: ${JSON.stringify(data)}`); return null; }
    return `https://gitzette.online/img/${slug}.${ext}`;
  } catch (e) {
    console.warn(`  R2 upload error: ${e}`);
    return null;
  }
}

/** Generate an illustration via GPT-Image-1 (preferred) or Gemini fallback.
 *  Uses OPENAI_API_KEY if set, else falls back to GOOGLE_AI_KEY (Gemini).
 *  Uploads transparent PNG to R2, caches the URL to disk. Never throws. */
async function generateIllustration(subject: string, cacheKey?: string): Promise<string | null> {
  const cfg = (config as any).imageGen;
  if (!cfg) return null;

  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const cachePath = illusCachePath(cacheKey ?? subject); // stores the URL (not data URI)

  // Check cache first — return immediately if we have a valid URL
  try {
    const cached = (await fs.readFile(cachePath, "utf8")).trim();
    if (cached.startsWith("http")) {
      console.log(`  using cached illustration for "${subject.slice(0, 50)}..."`);
      return cached;
    }
  } catch { /* cache miss, continue */ }

  const prompt = cfg.style + subject;

  // ── OpenAI gpt-image-1 (preferred when OPENAI_API_KEY is set) ───────────────
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt,
          n: 1,
          size: "1024x1024",
          background: "transparent",
          output_format: "png",
        }),
      });
      const data: any = await res.json();
      if (data.data?.[0]?.b64_json) {
        const rawBuf = Buffer.from(data.data[0].b64_json, "base64");
        // Post-process: keep only dark ink pixels (lum < 80), transparent everywhere else.
        // Validate: if >50% of pixels are very dark (lum<30), GPT generated a dark-bg failure — skip.
        const threshold = async (buf: Buffer): Promise<Buffer | null> => {
          const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const { width, height, channels } = info;
          // Reject if corners are dark AND opaque — means GPT painted a dark background.
          // Transparent corners (alpha=0) are fine — that's what we asked for.
          const cornerSamples = [
            [20,20],[width-20,20],[20,height-20],[width-20,height-20],
            [100,100],[width-100,100],[100,height-100],[width-100,height-100],
          ];
          // Only reject if MOST corners are opaque AND dark (a real dark background).
          // A few dark corners from illustration content near edges is OK.
          const darkOpaqueCount = cornerSamples.filter(([x,y]) => {
            const o=(y*width+x)*channels;
            const isOpaque = channels < 4 || data[o+3] > 20;
            const lum = 0.299*data[o]+0.587*data[o+1]+0.114*data[o+2];
            return isOpaque && lum < 100;
          }).length;
          if (darkOpaqueCount >= 6) return null; // 6+ of 8 corners dark+opaque = dark background
          const total = width * height;
          for (let i = 0; i < total; i++) {
            const o = i * channels;
            const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
            if (channels >= 4 && data[o + 3] < 20) { data[o + 3] = 0; continue; } // already transparent — keep it
            // Hard cutoff — no semi-transparent gradients. Clean edges for contour detection.
            if (lum > 145) { data[o + 3] = 0; } // light → fully transparent
            else { data[o] = 15; data[o + 1] = 15; data[o + 2] = 15; data[o + 3] = 255; } // dark/mid → fully opaque black ink
          }
          return sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 8 }).toBuffer();
        };
        let processed = await threshold(rawBuf);
        if (!processed) {
          console.warn("    ⚠ dark-bg generation rejected, retrying...");
          // retry once with same prompt
          const retry = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", quality: "low", background: "transparent", output_format: "png" }),
          });
          const r2 = await retry.json() as any;
          if (r2?.data?.[0]?.b64_json) {
            const retryBuf = Buffer.from(r2.data[0].b64_json, "base64");
            processed = await threshold(retryBuf);
          }
        }
        if (!processed) { console.warn("    ✗ illustration rejected after retry, skipping"); return null; }
        const url = await uploadIllustrationToR2(slug, processed, "image/png");
        if (url) {
          await fs.writeFile(cachePath, url, "utf8");
          return url;
        }
      } else {
        console.warn(`  OpenAI image failed: ${JSON.stringify(data).slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`  OpenAI image error: ${e}`);
    }
  }

  // ── Gemini fallback (when OPENAI_API_KEY is absent or failed) ────────────────
  const googleKey = process.env.GOOGLE_AI_KEY;
  if (!googleKey) {
    console.warn(`  no OPENAI_API_KEY or GOOGLE_AI_KEY — trying cache`);
    try { return await fs.readFile(cachePath, "utf8"); } catch { return null; }
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${googleKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
        }),
      }
    );
    const data: any = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const rawBuf = Buffer.from(part.inlineData.data, "base64");
        // Convert to grayscale engraving with transparent background.
        // Steps: grayscale → normalise contrast → make near-white pixels transparent
        // (threshold: pixels with luminance > 220 become alpha=0) → sharpen → PNG.
        // This lets illustrations sit directly on the paper background like
        // real newspaper engravings rather than rectangular photo boxes.
        // Pre-check: reject images with dark backgrounds (corners dark = dark bg, not ink)
        const { data: rawData, info: rawInfo } = await sharp(rawBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const { width: rw, height: rh, channels: rc } = rawInfo;
        const cornerSamplesG = [[20,20],[rw-20,20],[20,rh-20],[rw-20,rh-20],[100,100],[rw-100,100],[100,rh-100],[rw-100,rh-100]];
        const darkOpaqueCntG = cornerSamplesG.filter(([x,y]) => {
          const o = (y*rw+x)*rc;
          const isOpaque = rc < 4 || rawData[o+3] > 20;
          const lum = 0.299*rawData[o]+0.587*rawData[o+1]+0.114*rawData[o+2];
          return isOpaque && lum < 100;
        }).length;
        if (darkOpaqueCntG >= 6) {
          console.warn(`  ✗ Gemini returned dark-bg image, skipping`);
          continue;
        }
        const processed = await sharp(rawBuf)
          .grayscale()
          .normalise()
          .modulate({ brightness: 0.92, saturation: 0 })
          .sharpen({ sigma: 0.8 })
          // ensureAlpha adds alpha channel; then use a raw pixel transform to
          // make bright (near-white) pixels transparent.
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
          .then(({ data, info }) => {
            const { width, height, channels } = info;
            const threshold = 170; // pixels brighter than this become transparent
            for (let i = 0; i < width * height; i++) {
              const o = i * channels;
              const r = data[o];
              // use channels-1 for alpha byte (works for both 2-channel gray+alpha and 4-channel RGBA)
              if (r > threshold) data[o + channels - 1] = 0;
            }
            return sharp(data, { raw: { width, height, channels } })
              .png({ compressionLevel: 8 })
              .toBuffer();
          });
        const url = await uploadIllustrationToR2(slug, processed, "image/png");
        if (url) {
          await fs.writeFile(cachePath, url, "utf8"); // cache the URL
          return url;
        }
      }
    }
    console.warn(`  Gemini image failed: ${JSON.stringify(data).slice(0, 200)}`);
  } catch (e) {
    console.warn(`  Gemini image error: ${e}`);
  }

  // fallback: return cached URL if we have one
  try {
    const cached = await fs.readFile(cachePath, "utf8");
    console.warn(`  using cached illustration URL for "${subject}"`);
    return cached;
  } catch {
    return null;
  }
}

// ── feedback examples ─────────────────────────────────────────────────────────

type ExampleArticle = { headline: string; body: string };

const EXAMPLES_CACHE_PATH = path.join(ROOT, ".cache/examples.json");
const EXAMPLES_API_URL = "https://gitzette.online/review/examples";

/**
 * Fetch gold/bad article examples from the gitzette feedback API.
 * Falls back to .cache/examples.json if the API is unavailable.
 * Returns { gold: [], bad: [] } on any failure (non-blocking).
 */
async function fetchExamples(): Promise<{ gold: ExampleArticle[]; bad: ExampleArticle[] }> {
  // Try local cache first (written by previous successful fetch)
  let cached: { gold: ExampleArticle[]; bad: ExampleArticle[] } | null = null;
  try {
    const raw = await fs.readFile(EXAMPLES_CACHE_PATH, "utf8");
    cached = JSON.parse(raw);
  } catch {
    // no cache yet
  }

  try {
    const res = await fetch(EXAMPLES_API_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json() as { gold: ExampleArticle[]; bad: ExampleArticle[] };
      if (Array.isArray(data.gold) && Array.isArray(data.bad)) {
        // Persist to cache
        await fs.mkdir(path.dirname(EXAMPLES_CACHE_PATH), { recursive: true });
        await fs.writeFile(EXAMPLES_CACHE_PATH, JSON.stringify(data, null, 2), "utf8");
        return data;
      }
    }
  } catch (e) {
    console.warn(`fetchExamples: API unavailable (${e}), using cache`);
  }

  return cached ?? { gold: [], bad: [] };
}

function buildExamplesBlock(gold: ExampleArticle[], bad: ExampleArticle[]): string {
  if (gold.length === 0 && bad.length === 0) return "";
  const lines: string[] = [""];
  if (gold.length > 0) {
    lines.push("GOLD EXAMPLES (approved by humans — imitate this quality and voice):");
    for (const a of gold) {
      lines.push(`HEADLINE: ${a.headline}`);
      lines.push(`BODY: ${a.body}`);
      lines.push("");
    }
  }
  if (bad.length > 0) {
    lines.push("BAD EXAMPLES (rejected by humans — never write like this):");
    for (const a of bad) {
      lines.push(`HEADLINE: ${a.headline}`);
      lines.push(`BODY: ${a.body}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ── llm copy ─────────────────────────────────────────────────────────────────

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY not set");

async function generateCopy(
  reposData: RepoData[],
  from: Date,
  to: Date,
  owner: string = "NikolayS",
  knownIncidents: string[] = [],
  quietWeekNote: string | null = null,
  correctionNote: string | null = null,
  examples: { gold: ExampleArticle[]; bad: ExampleArticle[] } = { gold: [], bad: [] },
  issueContext: ArticleIssueContext[] = []
): Promise<{
  masthead: string;
  tagline: string;
  editionNote: string;
  articles: Array<{
    repo: string;
    repos?: string[];    // all repos this article touches (1-3); falls back to [repo]
    date?: string;       // YYYY-MM-DD of the key event (release date or merged PR date)
    headline: string;
    deck: string;
    body: string;
    tag: string;
    illustrationPrompt?: string; // subject for AI illustration
    illustrate?: boolean;        // true = LLM picked this article for an illustration
  }>;
  closingNote: string;
}> {
  const dataJson = JSON.stringify(
    reposData.map((r) => ({
      repo: r.name,
      description: r.description,
      releases: r.releases.map((rel) => ({
        tag: rel.tag,
        date: rel.date,
        highlights: rel.body.replace(/`/g, "'").replace(/\\/g, "/").slice(0, 2000),
      })),
      mergedPRs: r.mergedPRs.slice(0, 20).map((p) => ({ title: p.title, author: p.author, url: p.url, number: p.number, date: p.date })),
      openPRs: r.openPRs.slice(0, 5).map((p) => ({ title: p.title, author: p.author, url: p.url, number: p.number })),
      openIssues: r.openIssues.slice(0, 5).map((i) => ({ title: i.title })),
      commitCount: r.commitCount,
    })),
    null,
    2
  );

  const fromLabel = from.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const toLabel = to.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const quietWeekBlock = quietWeekNote ? `\n${quietWeekNote}\n` : "";
  const examplesBlock = buildExamplesBlock(examples.gold, examples.bad);

  // Build issue context block — injected per-repo so LLM can match to articles
  const issueContextBlock = issueContext.length > 0
    ? `\nLINKED ISSUE CONTEXT — use this to write richer "before" descriptions for these repos:\n${
        issueContext.map(ic =>
          `[${ic.repo}]\n${ic.issueContexts.join("\n---\n")}`
        ).join("\n\n")
      }\n`
    : "";

  // Read EDITORIAL.md fresh each run so edits take effect without code changes
  const editorialGuide = existsSync(EDITORIAL_PATH)
    ? readFileSync(EDITORIAL_PATH, "utf8")
    : EDITORIAL_GUIDE;

  const prompt = `You are writing the editorial copy for a weekly engineering newspaper called "the dispatch" — a digest of GitHub activity by @${owner}.

The newspaper covers his GitHub projects for the week of ${fromLabel} – ${toLabel}.

EDITORIAL STYLE GUIDE — follow every rule in this document strictly:
${editorialGuide}

ATTRIBUTION RULES:
- Always refer to the author as "@${owner}" — never by full name, "the developer", "the author"
- Repo/project names are ALWAYS lowercase: "rpg" not "RPG", "pg_ash" not "PG_ash"

AVAILABLE REPOS (use ONLY these exact names in the "repo" field — no others):
${reposData.map(r => `- ${r.name}${r.description ? ` (${r.description.slice(0,80)})` : ""}`).join("\n")}

FORKS/MIRRORS: Some repos may be forks of upstream projects (e.g. "postgres" is a mirror of PostgreSQL). Only write about @${owner}'s OWN commits and PRs in those repos. Do not attribute upstream activity to @${owner}.

Here is the raw data:
${dataJson}

${knownIncidents.length ? `KNOWN INCIDENTS THIS WEEK (confirmed by the author — must include as articles):\n${knownIncidents.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}
${quietWeekBlock}
${issueContextBlock}${correctionNote ? `\n${correctionNote}\n` : ""}${examplesBlock}
Return a JSON object with this exact structure:
{
  "masthead": "the dispatch",
  "tagline": "a one-line tagline for this week — dry, specific, the kind of thing a senior engineer would put on a t-shirt or mutter under their breath. Not 'exciting week' or 'lots of fixes'. Something like: 'turns out the parser wasn't walking all the way down' or 'OIDs: still 32 bits in someone's head, 64 bits in reality'",
  "editionNote": "one punchy sentence. Engineer humor — self-aware, slightly dark, grounded in what actually happened. Not 'busy week'. Example: 'Three data corruption bugs fixed. One of them existed since day one.'",
  "articles": [
    {
      "repo": "primary repo name (exactly as listed in AVAILABLE REPOS)",
      "repos": ["primary repo", "other repo if cross-repo work"],
      "date": "YYYY-MM-DD of the key event — use the release date or merged PR date from the data",
      "headline": "punchy newspaper headline",
      "deck": "one-sentence italic subheading expanding on the headline",
      "body": "2-4 sentences. Lead with the situation or failure mode — not '@owner merged #N'. Name what was broken and why it mattered, then what specifically changed, then what happens now. Be specific (name the PR, the error code, the function if it's known). Write with personality: a dry aside, an unexpected consequence, or a line that makes an engineer snort is better than a third sentence of neutral explanation. Think: sharp Hacker News comment by someone who actually read the diff.",
      "tag": "RELEASE | FEATURE | SECURITY | PENDING | COMMUNITY",
      "illustrationPrompt": "a single CONCRETE PHYSICAL OBJECT with an IRREGULAR NON-RECTANGULAR SILHOUETTE for a Victorian woodcut engraving (8-12 words). The object MUST have protruding parts, curves, or asymmetric edges — NOT a box, rectangle, or simple geometric shape. Good: 'an ornate hourglass on a wrought-iron stand with scrollwork legs', 'a gnarled oak tree with sprawling bare branches', 'a Victorian gentleman holding a pocket watch on a chain', 'an octopus wrapping tentacles around an anchor'. Bad: 'a stack of books', 'a server rack', 'a balance scale' (too rectangular). No screens, dashboards, monitors, or UI elements. No text, signs, or labels.",
      "illustrate": false
    }
  ],
  "closingNote": "one-line sign-off. Dry engineer humor — the kind of thing that makes you exhale through your nose. Something like 'shipping is easy; reading your own query tree is hard' or 'data arrived N times. now it arrives once. progress.' Not inspirational. Not corporate."
}

FIELD RULES:
- "repos": list ALL repos the article meaningfully touches. Single-repo work: just ["repo"]. Cross-repo work (e.g. a fix that affects two projects): list both. Never list more than 3.
- "date": pick the most relevant event date from the data (release date, or merged PR date). Use ISO format YYYY-MM-DD. If multiple events, use the most recent one for this article.
- "repo": must match exactly one of the AVAILABLE REPOS names. Use the first entry of "repos" as primary.

Order articles by newsworthiness (releases > big features > pending work).
Maximum 8 articles total — pick the most newsworthy, drop the rest.
For "illustrate": set true on EXACTLY 3 articles. Always illustrate the lead story (h1) plus two others with vivid, illustrable subjects. Every dispatch needs visual variety — never skip this.
Return ONLY the JSON object, no markdown fences.`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 6000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter API error: ${err}`);
  }

  const data: any = await res.json();
  const raw = data.choices[0].message.content.trim();
  // strip control chars that break JSON.parse
  const text = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

  try {
    return sanitizeCopy(JSON.parse(text));
  } catch {
    const match = text.match(/\{[\s\S]+\}/);
    if (match) {
      try { return sanitizeCopy(JSON.parse(match[0])); } catch {}
    }
    throw new Error(`LLM returned non-JSON: ${text.slice(0, 300)}`);
  }
}

// ── copy sanitizer — convert LLM markdown slip-ups to HTML ───────────────────

function sanitizeCopy(copy: any): any {
  if (!copy?.articles) return copy;
  copy.articles = copy.articles.map((a: any) => {
    if (a.body) {
      // Convert markdown links [text](url) → <a href="url">text</a>
      a.body = a.body.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
      // Strip markdown bold **text** → text
      a.body = a.body.replace(/\*\*([^*]+)\*\*/g, '$1');
      // Strip markdown italic *text* (but not opening * in sentences)
      a.body = a.body.replace(/\*([^*\n]+)\*/g, '$1');
      // Strip backtick code that wasn't in a <code> tag already
      a.body = a.body.replace(/`([^`]+)`/g, '<code>$1</code>');
    }
    return a;
  });
  return copy;
}

// ── post-generation evals ─────────────────────────────────────────────────────

type EvalResult = { pass: boolean; complaints: string[] };

async function evalCopy(copy: any, evalType: "kukushkin" | "anti-boring"): Promise<EvalResult> {
  const summary = copy.articles.map((a: any) =>
    `HEADLINE: ${a.headline}\nDECK: ${a.deck}\nBODY (first 2 sentences): ${a.body.replace(/<[^>]+>/g, "").split(/\. /).slice(0, 2).join(". ")}.`
  ).join("\n\n");

  const prompts: Record<string, string> = {
    kukushkin: `You are reviewing AI-generated engineering newsletter copy for factual accuracy. Be lenient about style and wit — the goal is entertainment, not a dry changelog.

Evaluate ONLY for these hard failures:
- Does a headline or body invent technical terms, class names, method names, or PR numbers not in the data?
- Is any article a PENDING piece about open issues in someone else's repo (not the author's work)?
- Does any body contain raw markdown syntax like [text](url) or **bold** instead of HTML?
- Are multiple clearly unrelated PRs bundled into one article with no connecting narrative?

DO NOT flag: wit, humor, metaphors, colloquialisms, dramatic language, or punchy phrasing — these are features, not bugs.
DO NOT flag: vague-sounding language unless it's factually wrong.
DO NOT flag: headlines that are outcome-focused rather than mechanism-focused — both styles are valid.

Copy to evaluate:
${summary}

Respond with JSON only: {"pass": true/false, "complaints": ["specific complaint 1", "specific complaint 2"]}
Only fail if there are hard accuracy or structural problems. Max 2 complaints. Be specific.`,

    "anti-boring": `You are a sharp tech editor evaluating whether an engineering newsletter is worth reading.

Evaluate this dispatch copy for ENGAGEMENT (the anti-boring test):
- Do headlines vary in structure, or do they all follow the same "[project] [verb]s [noun]" pattern?
- Is there at least one line a senior engineer would forward to a colleague?
- Does it read like a person wrote it, or like a template executed?
- Is the closing note dry and memorable, or generic?
- Is there any voice or personality, or is it just a changelog with punctuation?

Copy to evaluate:
${summary}
Closing note: ${copy.closingNote}

Respond with JSON only: {"pass": true/false, "complaints": ["specific complaint 1", "specific complaint 2"]}
Pass if there is genuine voice and at least some variety. Be specific.`,
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompts[evalType] }],
    }),
  });

  if (!res.ok) return { pass: true, complaints: [] }; // don't block on eval failure
  const data: any = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  try {
    const match = raw.match(/\{[\s\S]+\}/);
    return match ? JSON.parse(match[0]) : { pass: true, complaints: [] };
  } catch {
    return { pass: true, complaints: [] };
  }
}

async function runEvals(
  copy: any,
  reposData: RepoData[],
  from: Date,
  to: Date,
  owner: string,
  incidents: string[],
  quietWeekNote?: string,
  issueCtx: ArticleIssueContext[] = []
): Promise<any> {
  if (copy.articles.length === 0) return copy; // nothing to eval on quiet weeks

  console.log("running evals...");
  const [kukushkin, antiBoring] = await Promise.all([
    evalCopy(copy, "kukushkin"),
    evalCopy(copy, "anti-boring"),
  ]);

  const allComplaints: string[] = [];
  if (!kukushkin.pass) {
    console.log(`  ✗ kukushkin test FAILED:`);
    kukushkin.complaints.forEach(c => console.log(`    - ${c}`));
    allComplaints.push(...kukushkin.complaints.map(c => `[SLOP] ${c}`));
  } else {
    console.log(`  ✓ kukushkin test passed`);
  }

  if (!antiBoring.pass) {
    console.log(`  ✗ anti-boring test FAILED:`);
    antiBoring.complaints.forEach(c => console.log(`    - ${c}`));
    allComplaints.push(...antiBoring.complaints.map(c => `[BORING] ${c}`));
  } else {
    console.log(`  ✓ anti-boring test passed`);
  }

  if (allComplaints.length === 0) return copy; // both passed — done

  // One retry with complaints injected
  console.log(`  → retrying copy with eval feedback...`);
  const correctionNote = `CORRECTION REQUIRED — previous attempt failed editorial review:\n${allComplaints.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nFix ALL of the above. Do not repeat the same mistakes.`;
  const retryCopy = await generateCopy(reposData, from, to, owner, incidents, quietWeekNote, correctionNote, { gold: [], bad: [] }, issueCtx);

  // Run evals once more — log but don't retry again
  const [k2, ab2] = await Promise.all([
    evalCopy(retryCopy, "kukushkin"),
    evalCopy(retryCopy, "anti-boring"),
  ]);
  console.log(`  retry kukushkin: ${k2.pass ? "✓ passed" : "✗ still failing — proceeding anyway"}`);
  console.log(`  retry anti-boring: ${ab2.pass ? "✓ passed" : "✗ still failing — proceeding anyway"}`);

  return retryCopy;
}

// ── data graphics ─────────────────────────────────────────────────────────────

function buildDataGraphics(reposData: RepoData[], from: Date, to: Date): string {
  const totalMerged = reposData.reduce((s, r) => s + r.mergedPRs.length, 0);
  const totalOpen = reposData.reduce((s, r) => s + r.openPRs.length, 0);
  const totalPRs = totalMerged + totalOpen; // all PRs touched this week
  const totalCommits = reposData.reduce((s, r) => s + r.commitCount, 0);
  const totalReleases = reposData.reduce((s, r) => s + r.releases.length, 0);
  const activeRepos = reposData.filter((r) => r.commitCount > 0);
  const maxCommits = Math.max(...activeRepos.map((r) => r.commitCount), 1);

  // ── 1. Big ticker — oversized stat blocks ─────────────────────────────────
  const ticker = `
  <div style="display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--rule);margin-bottom:20px;">
    ${[
      [String(totalCommits), "commits"],
      [String(totalPRs), "pull requests"],
      [String(totalReleases), "releases"],
    ].map(([val, label], i) => `
      <div style="padding:14px 10px 12px;${i < 2 ? "border-right:1px solid var(--rule);" : ""}text-align:center;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:clamp(28px,8vw,52px);font-weight:700;line-height:1;letter-spacing:-.03em;color:#333;">${val}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-top:4px;">${label}</div>
      </div>`).join("")}
  </div>`;

  // ── 2. Commit bar chart — softer newspaper style ─────────────────────────
  const barH = 18;
  const barGap = 7;
  const labelW = 110; // wider to fit names like "oak-tree-buzzer"
  const chartW = 240;
  const numW = 32;
  const svgW = labelW + chartW + numW;
  const svgH = activeRepos.length * (barH + barGap) + 22;

  const sortedRepos = [...activeRepos].sort((a, b) => b.commitCount - a.commitCount);
  const bars = sortedRepos.map((r, i) => {
    const barW = Math.max(3, Math.round((r.commitCount / maxCommits) * chartW));
    const y = i * (barH + barGap) + 18;
    // graduated grey fills: leader = #555, rest progressively lighter
    const greys = ["#555", "#888", "#999", "#aaa", "#bbb", "#ccc", "#ddd"];
    const fill = greys[Math.min(i, greys.length - 1)];
    const textFill = i === 0 ? "#333" : "#666";
    return `
    <text x="${labelW - 6}" y="${y + barH - 4}" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="10" fill="${textFill}" font-weight="${i === 0 ? "600" : "400"}">${r.name}</text>
    <rect x="${labelW}" y="${y}" width="${barW}" height="${barH}" fill="${fill}" rx="1"/>
    <text x="${labelW + barW + 5}" y="${y + barH - 4}" font-family="IBM Plex Mono,monospace" font-size="10" fill="#888" font-weight="${i === 0 ? "600" : "400"}">${r.commitCount}</text>`;
  }).join("");

  const commitChart = `
  <div style="margin-bottom:20px;">
    <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">commits by repo</div>
    <svg width="100%" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
      <text x="0" y="11" font-family="IBM Plex Mono,monospace" font-size="8" fill="#ccc" letter-spacing="1">REPO</text>
      <text x="${svgW}" y="11" font-family="IBM Plex Mono,monospace" font-size="8" fill="#ccc" text-anchor="end" letter-spacing="1">COMMITS</text>
      <line x1="0" y1="14" x2="${svgW}" y2="14" stroke="#e8e4dc" stroke-width="0.5"/>
      ${bars}
    </svg>
  </div>`;

  // ── 3. Star leaderboard — ★ glyph fill ───────────────────────────────────
  const starredRepos = [...reposData].filter((r) => r.stars > 0).sort((a, b) => b.stars - a.stars);
  const maxStars = Math.max(...starredRepos.map((r) => r.stars), 1);
  const starRows = starredRepos.map((r) => {
    const pct = Math.round((r.stars / maxStars) * 100);
    return `<tr style="border-bottom:1px solid var(--rule);">
      <td style="font-family:'IBM Plex Mono',monospace;font-size:11px;padding:8px 12px 8px 0;white-space:nowrap;vertical-align:middle;"><a href="${r.url}" style="color:var(--ink);text-decoration:none;">${r.name}</a></td>
      <td style="vertical-align:middle;padding:8px 10px 8px 0;width:120px;">
        <div style="background:#e0ddd6;border-radius:2px;height:6px;width:100%;">
          <div style="background:var(--ink);border-radius:2px;height:6px;width:${pct}%;"></div>
        </div>
      </td>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:700;color:var(--ink);white-space:nowrap;vertical-align:middle;text-align:right;padding:8px 0;">${r.stars.toLocaleString()}</td>
    </tr>`;
  }).join("");

  const starLeaderboard = starredRepos.length > 0 ? `
  <div style="margin-bottom:20px;">
    <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">github stars</div>
    <table style="width:100%;border-collapse:collapse;">
      ${starRows}
    </table>
  </div>` : "";

  // ── 4. Release timeline ───────────────────────────────────────────────────
  const allReleases = reposData
    .flatMap((r) => r.releases.map((rel) => ({ repo: r.name, ...rel })))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  let releaseTimeline = "";
  if (allReleases.length > 0) {
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const rangeMs = toMs - fromMs;
    const PAD = 30; // horizontal padding so edge labels don't clip
    const tlW = 400;
    const drawW = tlW - PAD * 2;

    // Compute lane assignments first so we know how tall the SVG needs to be.
    const oneDayPx = drawW / 7;
    const releaseXs = allReleases.map((rel) =>
      PAD + Math.round(((new Date(rel.date).getTime() - fromMs) / rangeMs) * drawW)
    );
    // Count prior releases within 1 day — use as unique lane index (no modulo so same-day labels don't collide).
    const lanes = allReleases.map((_, i) => {
      let cluster = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (Math.abs(releaseXs[i] - releaseXs[j]) <= oneDayPx) {
          cluster++;
        } else {
          break;
        }
      }
      return cluster;
    });
    const maxLane = Math.max(2, ...lanes); // at least 3 lanes
    const numLanes = maxLane + 1;
    const tlH = 22 + numLanes * 22 + 30; // dynamic height based on busiest day
    const lineY = tlH - 22;

    const dayTicks = [];
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const x = PAD + Math.round(((d.getTime() - fromMs) / rangeMs) * drawW);
      dayTicks.push(`<line x1="${x}" y1="${lineY - 4}" x2="${x}" y2="${lineY + 4}" stroke="#aaa" stroke-width="1"/>`);
      dayTicks.push(`<text x="${x}" y="${tlH - 4}" font-family="IBM Plex Mono,monospace" font-size="8" fill="#aaa" text-anchor="middle">${d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}</text>`);
    }
    const dots = allReleases.map((rel, i) => {
      const x = releaseXs[i];
      const row = lanes[i];
      const dotY = lineY - 20 - row * 22;
      // clamp label x so it never goes outside viewBox
      const lx = Math.min(Math.max(x, PAD + 20), tlW - PAD - 20);
      return `
        <line x1="${x}" y1="${lineY}" x2="${x}" y2="${dotY + 7}" stroke="#bbb" stroke-width="0.8" stroke-dasharray="2,2"/>
        <circle cx="${x}" cy="${lineY}" r="4" fill="#0f0f0f"/>
        <circle cx="${x}" cy="${dotY}" r="3" fill="#0f0f0f"/>
        <text x="${lx}" y="${dotY - 5}" font-family="IBM Plex Mono,monospace" font-size="8" fill="#0f0f0f" text-anchor="middle" font-weight="600">${rel.repo} ${rel.tag}</text>`;
    });

    releaseTimeline = `
  <div style="margin-bottom:4px;overflow:hidden;">
    <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">release timeline</div>
    <svg width="100%" viewBox="0 0 ${tlW} ${tlH}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">
      <line x1="${PAD}" y1="${lineY}" x2="${tlW - PAD}" y2="${lineY}" stroke="#0f0f0f" stroke-width="1.5"/>
      ${dayTicks.join("")}
      ${dots.join("")}
    </svg>
  </div>`;
  }

  return `
<div style="padding:20px 0 0;border-top:3px double var(--ink);">
  <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--ink);padding-bottom:10px;margin-bottom:14px;display:flex;align-items:center;gap:8px;">
    <span>stats corner</span>
    <span style="flex:1;border-top:1px solid var(--rule);display:inline-block;"></span>
  </div>
  ${ticker}
  ${commitChart}
  ${starLeaderboard}
  ${releaseTimeline}
</div>`;
}

// ── html template ─────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// ── pretext-based column balancing ───────────────────────────────────────────

// Approximate column widths in px (paper 960px, body padding 24px each side,
// grid-2-1 splits 3fr:1fr with 20px col padding).
const COL1_WIDTH = 660;
const COL2_WIDTH = 200;

// Body text spec used in dispatches: IBM Plex Serif 15px, line-height 1.6
const BODY_FONT = "15px IBM Plex Serif";
const BODY_LINE_HEIGHT = 24; // 15 * 1.6

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
}

function measureHeight(text: string, width: number): number {
  if (!text.trim()) return 0;
  try {
    const prepared = prepare(text, BODY_FONT);
    return layout(prepared, width, BODY_LINE_HEIGHT).height;
  } catch {
    // Fallback: estimate ~80 chars per line, ~24px per line
    const charsPerLine = Math.max(1, Math.floor(width / 8));
    return Math.ceil(text.length / charsPerLine) * BODY_LINE_HEIGHT;
  }
}

/**
 * Greedy height-balancing: assign each article to the shorter column.
 * Heights are measured at COL1_WIDTH for both accumulators so the greedy
 * decision is based on text volume rather than column-width-inflated heights
 * (col2 is 3x narrower, so measuring there would always make col1 look cheaper).
 * The goal is to match total text volume across columns, not pixel-perfect
 * visual height (which depends on the browser's actual rendering).
 */
function balanceColumns(
  htmlArticles: string[]
): { col1: string[]; col2: string[] } {
  const col1: string[] = [];
  const col2: string[] = [];
  let h1 = 0;
  let h2 = 0;

  for (const html of htmlArticles) {
    const text = stripHtml(html);
    const height = measureHeight(text, COL1_WIDTH);
    if (h1 <= h2) {
      col1.push(html);
      h1 += height;
    } else {
      col2.push(html);
      h2 += height;
    }
  }

  return { col1, col2 };
}

function renderArticle(
  article: { repo: string; repos?: string[]; date?: string; headline: string; deck: string; body: string; tag: string },
  repoData: RepoData,
  level: "h1" | "h2" | "h3",
  imageIndex: number = 0, // which demo image to use (if any)
  showMeta: boolean = true, // false = skip release/PR links (already shown for this repo)
  imgAlign: "left" | "right" = "left", // alternate illustration alignment
  allRepos?: RepoData[],  // full repo list for resolving multi-repo links
): string {
  const releaseLinks = showMeta ? repoData.releases
    .map(
      (r) =>
        `<a href="${r.url}" class="release-link">${r.tag}</a> <span class="muted">${formatDate(r.date)}</span>`
    )
    .join(" &nbsp;·&nbsp; ") : "";

  const prLinks = showMeta ? repoData.mergedPRs
    .slice(0, 5)
    .map((p) => `<a href="${p.url}" class="pr-link">#${p.number}</a>`)
    .join(" ") : "";

  const openPRNote = showMeta && repoData.openPRs.length > 0
      ? `<div class="pending-note">${repoData.openPRs.length} open PR${repoData.openPRs.length > 1 ? "s" : ""}: ${repoData.openPRs
          .slice(0, 3)
          .map((p) => `<a href="${p.url}">#${p.number} ${p.title}</a>`)
          .join(", ")}</div>`
      : "";

  // Find illustration (from gitzette.online/img/) and repo screenshot separately
  const illustration = repoData.demoImages.find(u => u?.includes("gitzette.online/img/"));
  const repoScreenshot = repoData.demoImages.find(u => u && !u.includes("gitzette.online/img/"));
  const repoImageHtml = repoScreenshot
    ? `<div class="article-image" style="border:1px solid var(--rule);margin:10px 0;overflow:hidden;max-width:100%;max-height:40vh;">
          <img src="${repoScreenshot}" alt="" style="width:100%;max-width:100%;height:auto;max-height:40vh;object-fit:cover;display:block;">
        </div>`
    : "";

  // Shape-wrap: illustration floats left or right, JS progressively enhances with contour-following.
  // Fallback: regular float layout (text always visible even if JS fails).
  const bodyContent = article.body.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/`/g, '');

  const floatMargin = imgAlign === 'left' ? 'margin:4px 18px 14px 0' : 'margin:4px 0 12px 18px';
  const bodyHtml = illustration
    ? `<div class="shape-wrap-block" data-img="${illustration}" data-align="${imgAlign}">
        <img src="${illustration}" class="shape-img" crossorigin="anonymous" alt="" style="float:${imgAlign};width:42%;max-width:220px;height:auto;${floatMargin};display:block;">
        <p class="body-text shape-wrap-fallback">${bodyContent}</p>
        <div style="clear:both"></div>
      </div>`
    : `<p class="body-text">${bodyContent}</p>`;

  // Repo chips — show all repos if multi-repo, just primary if single
  const repoList = article.repos && article.repos.length > 0 ? article.repos : [article.repo];
  const repoChips = repoList.map(rname => {
    const rd = allRepos?.find(r => r.name === rname) ?? (rname === repoData.name ? repoData : null);
    const url = rd?.url ?? repoData.url;
    return `<a href="${url}" class="repo-chip">${rname}</a>`;
  }).join(" ");

  // Date stamp — shown only if LLM provided it
  const dateStamp = article.date
    ? `<span class="article-date">${new Date(article.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>`
    : "";

  return `
    <div class="article">
      <div class="article-meta">${repoChips}${dateStamp}</div>
      <div class="tag">${article.tag}</div>
      <${level}><a href="${(() => { const m = article.body.match(/href="(https:\/\/github\.com\/[^"]+\/(?:pull|releases\/tag|issues)\/[^"]+)"/); return m ? m[1] : repoData.url; })()}" class="headline-link">${article.headline}</${level}>
      <p class="deck">${article.deck}</p>
      ${bodyHtml}
      ${repoImageHtml}
      ${releaseLinks ? `<div class="release-links">${releaseLinks}</div>` : ""}
      ${prLinks ? `<div class="pr-links">merged: ${prLinks}</div>` : ""}
      ${openPRNote}
    </div>`;
}

async function buildHtml(
  copy: Awaited<ReturnType<typeof generateCopy>>,
  reposData: RepoData[],
  from: Date,
  to: Date,
  vol: number,
  issue: number,
  ownerHandle: string = "NikolayS",
  skipIllustrations: boolean = false
): string {
  const repoMap = Object.fromEntries(reposData.map((r) => [r.name, r]));

  const totalCommits = reposData.reduce((s, r) => s + r.commitCount, 0);
  const totalReleases = reposData.reduce((s, r) => s + r.releases.length, 0);
  const totalMerged = reposData.reduce((s, r) => s + r.mergedPRs.length, 0);
  const totalOpenPRs = reposData.reduce((s, r) => s + r.openPRs.length, 0);

  const fromLabel = from.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const toLabel = to.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // generate AI illustrations — only for articles LLM flagged with illustrate:true
  // LLM picks up to 2 based on editorial judgment (most visually compelling)
  const MAX_REPO_IMAGES = 3;
  const illustrationCache: Record<string, string | null> = {};
  if (!skipIllustrations) {
    // Always illustrate the lead article (first h1) — LLM picks up to 1 more
    const llmPicked = copy.articles.filter((a: any) => a.illustrate === true);
    const leadArticle = copy.articles[0];
    if (leadArticle && !llmPicked.find((a: any) => a.headline === leadArticle.headline)) {
      leadArticle.illustrate = true; // force lead to be illustrated
      // Only use LLM's illustrationPrompt if it doesn't contain abstract/signal keywords
      const abstractKeywords = /icon|signal|wave|wireless|dotted|line|symbol|abstract|routing|flow|path|split/i;
      if (!leadArticle.illustrationPrompt || abstractKeywords.test(leadArticle.illustrationPrompt)) {
        // Generate a concrete fallback from the headline
        leadArticle.illustrationPrompt = `a single mechanical object related to "${leadArticle.headline.slice(0, 40)}", drawn as a 1920s technical engraving — one clear physical object, no abstract symbols`;
      }
    }
    // Ensure at least 3 articles are flagged for illustration
    const flagged = copy.articles.filter((a: any) => a.illustrate === true);
    if (flagged.length < 3) {
      // Pick unflagged articles from different repos to reach 3
      const flaggedRepos = new Set(flagged.map((a: any) => a.repo));
      for (const a of copy.articles) {
        if (flagged.length >= 3) break;
        if (!(a as any).illustrate && !flaggedRepos.has(a.repo)) {
          (a as any).illustrate = true;
          if (!(a as any).illustrationPrompt) {
            (a as any).illustrationPrompt = `an ornate Victorian-era scientific instrument related to measurement or precision`;
          }
          flaggedRepos.add(a.repo);
          flagged.push(a);
        }
      }
    }
    const toIllustrate = copy.articles.filter((a: any) => a.illustrate === true).slice(0, 3);
    if (toIllustrate.length > 0) {
      console.log(`generating ${toIllustrate.length} illustration(s)...`);
      for (const a of toIllustrate) {
        const illustrationPrompt = (a as any).illustrationPrompt ?? `an ornate Victorian-era scientific instrument related to measurement or precision`;
        process.stdout.write(`  illustration for "${a.headline}"... `);
        // Use headline as cache key so changing the prompt style clears correctly
        const url = await generateIllustration(illustrationPrompt, a.headline);
        illustrationCache[a.headline] = url ?? null;
        console.log(url ? "✓" : "skipped");
      }
    } else {
      console.log("no illustrations requested by LLM this week");
    }
  }

  // cycle through a repo's images across its articles — each article from the same
  // repo picks the next image (index 0, 1, 2...) until images run out or the global
  // cap of MAX_REPO_IMAGES total repo images is reached.
  const repoImageIdx = new Map<string, number>(); // repo → next image index to use
  let repoImageCount = 0;
  const splitAt = Math.ceil(copy.articles.length / 2); // ~half on each page

  // Track which repos have already shown release/PR metadata (dedup)
  const repoMetaShown = new Set<string>();
  let illustrationAlignIdx = 0; // alternates left/right for AI illustrations

  const renderedArticles = copy.articles.map((a, i) => {
      const repo = repoMap[a.repo];
      if (!repo) return "";
      const level = i === 0 ? "h1" : i < 3 ? "h2" : "h3";
      // allow repo image only if: repo has images remaining and global cap not reached
      const imgIdx = repoImageIdx.get(a.repo) ?? 0;
      const hasRepoImg = repo.demoImages[imgIdx] != null && repoImageCount < MAX_REPO_IMAGES;
      if (hasRepoImg) {
        repoImageIdx.set(a.repo, imgIdx + 1);
        repoImageCount++;
      }
      // Build per-article image list:
      // - AI illustration goes first (used for shape-wrap)
      // - Repo screenshot is ALSO included (shown full-width below body text)
      // Both can coexist — illustration for visual flair, screenshot for actual UI
      const illustrationUrl = illustrationCache[a.headline];
      const articleImages: string[] = [];
      if (illustrationUrl) articleImages.push(illustrationUrl);
      if (hasRepoImg) articleImages.push(repo.demoImages[imgIdx]!);
      const articleRepo = { ...repo, demoImages: articleImages };
      // Only show release/PR metadata on first article per repo
      const showMeta = !repoMetaShown.has(a.repo);
      if (showMeta) repoMetaShown.add(a.repo);
      // TODO: re-enable right-align once shape-wrap contour scanning is fixed (issue #7)
      // For now, always left-align — right-align has text overlap bugs
      const align: "left" | "right" = "left";
      return renderArticle(a, articleRepo, level as "h1" | "h2" | "h3", 0, showMeta, align, reposData);
    });

  // Split page-1 articles into two balanced columns using pretext height measurement.
  const page1Articles = renderedArticles.slice(0, splitAt);
  const { col1: col1Articles, col2: col2Articles } = balanceColumns(page1Articles);
  const articlesCol1 = col1Articles.join("\n");
  const articlesCol2 = col2Articles.join("\n");
  const articlesPage2 = renderedArticles.slice(splitAt).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<title>${copy.masthead} — Vol. ${vol}, No. ${issue}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,600;0,700;1,400&family=IBM+Plex+Serif:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --ink: #0f0f0f; --paper: #f7f4ee; --rule: #c8c2b4;
    --muted: #666; --tag-bg: #0f0f0f; --tag-fg: #f7f4ee;
    --link: #1a1a8c;
  }
  body { background: #e8e4dc; font-family: 'IBM Plex Sans', sans-serif; color: var(--ink); font-size: 15px; line-height: 1.6; }
  a { color: var(--ink); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .paper { max-width: 960px; margin: 24px auto; background: var(--paper); border: 1px solid var(--rule); box-shadow: 0 2px 12px rgba(0,0,0,.15); overflow-x: hidden; }
  .paper img { max-width: 100%; height: auto; display: block; }
  /* broadsheet: two pages side by side on very wide screens */
  .page-2 { display: block; }
  /* articles-p2: always visible on page 1; moves to page 2 in broadsheet */
  .articles-p2 { display: block; }
  @media (min-width: 1400px) {
    body { background: #d8d4cc; }
    .broadsheet-wrap { display: flex; align-items: flex-start; gap: 0; max-width: 1900px; margin: 32px auto; }
    .broadsheet-wrap .paper { max-width: none; flex: 1; margin: 0; box-shadow: 0 4px 24px rgba(0,0,0,.2); }
    .broadsheet-wrap .paper.page-2 { display: block; border-left: 3px double var(--rule); margin-left: -1px; }
    .broadsheet-wrap .paper.page-2 .body { display: grid; grid-template-columns: 3fr 2fr; gap: 0 24px; }
    .broadsheet-wrap .paper.page-2 .body > .articles-p2 { grid-column: 1; }
    .broadsheet-wrap .paper.page-2 .body > .data-graphics-wrap { grid-column: 2; grid-row: 1 / span 3; }
    .broadsheet-wrap .paper.page-2 .body > .repo-index-wrap { grid-column: 1 / -1; }
    /* on broadsheet, hide p2 articles from page 1 (they move to page 2) */
    .broadsheet-wrap .paper:first-child .articles-p2 { display: none; }
    /* grid-2 stays two-column on broadsheet (both cols have articles) */
  }

  /* header */
  .header { padding: 20px 24px 14px; border-bottom: 3px solid var(--ink); }
  .header-kicker { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--ink); border-bottom: 1px solid var(--rule); padding-bottom: 8px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; overflow: hidden; }
  .header-kicker .kicker-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .header-kicker .kicker-date { white-space: nowrap; flex-shrink: 0; color: var(--muted); font-weight: 400; }
  .header-kicker a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--ink); }
  .header-kicker a:hover { color: var(--link); border-color: var(--link); }
  .header-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; overflow: hidden; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
  .header-meta .meta-left { white-space: nowrap; }
  .header-meta .meta-right { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
  .masthead { line-height: 1; display: flex; align-items: baseline; gap: 6px; }
  .masthead .mh-the { font-family: 'IBM Plex Serif', serif; font-style: italic; font-weight: 400; font-size: clamp(16px,3vw,28px); color: var(--muted); }
  .masthead .mh-title { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: clamp(34px,7.5vw,68px); letter-spacing: -.03em; color: var(--ink); }
  .tagline { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--muted); margin-top: 6px; letter-spacing: .04em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .edition-bar { margin-top: 12px; padding: 6px 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .05em; display: flex; flex-wrap: nowrap; gap: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .edition-bar::-webkit-scrollbar { display: none; }
  .edition-bar span { white-space: nowrap; padding: 0 16px 0 0; }
  .edition-bar span::before { content: "▸ "; color: var(--muted); }

  /* body */
  .body { padding: 0 24px 32px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 0; }
  @media (min-width: 640px) { .grid-2 { grid-template-columns: 1fr 1fr; } .grid-2-1 { grid-template-columns: 3fr 1fr; } .grid-3 { grid-template-columns: 1fr 1fr 1fr; } }
  .col { padding: 20px 20px 0 0; }
  .col:last-child { padding-right: 0; }
  @media (min-width: 640px) { .col { border-right: 1px solid var(--rule); } .col:last-child { border-right: none; padding-left: 20px; } .grid-3 .col { padding: 20px 16px 0; } .grid-3 .col:first-child { padding-left: 0; } .grid-3 .col:last-child { padding-right: 0; } }

  /* tags */
  .tag { display: inline-block; font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; background: var(--tag-bg); color: var(--tag-fg); padding: 2px 7px; margin-bottom: 8px; }

  /* articles */
  .article { margin-bottom: 24px; }
  .article-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
  .repo-chip { font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600; color: var(--muted); text-decoration: none; letter-spacing: .04em; border-bottom: 1px solid var(--rule); }
  .repo-chip:hover { color: var(--ink); border-bottom-color: var(--ink); }
  .article-date { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--muted); margin-left: auto; white-space: nowrap; }
  h1 { font-family: 'IBM Plex Serif', serif; font-size: clamp(22px,4vw,36px); font-weight: 700; line-height: 1.1; margin-bottom: 8px; }
  h2 { font-family: 'IBM Plex Serif', serif; font-size: clamp(16px,3vw,22px); font-weight: 700; line-height: 1.15; margin-bottom: 6px; }
  h3 { font-family: 'IBM Plex Serif', serif; font-size: 15px; font-weight: 700; line-height: 1.2; margin-bottom: 4px; }
  .headline-link { color: var(--ink); text-decoration: none; }
  .headline-link:hover { text-decoration: underline; }
  .deck { font-family: 'IBM Plex Serif', serif; font-style: italic; font-size: 14px; line-height: 1.55; color: #333; margin-bottom: 10px; }
  .body-text { font-size: 14px; line-height: 1.65; margin-bottom: 8px; text-decoration: none; text-align: justify; }
  .body-text a { color: var(--link); text-decoration: none; border-bottom: 1px solid var(--link); }
  .body-text a:hover { border-bottom-color: var(--ink); color: var(--ink); }
  .body-text code { font-family: 'IBM Plex Mono', monospace; font-size: 12px; background: rgba(0,0,0,.06); padding: 1px 4px; border-radius: 2px; }
  .release-links, .pr-links { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--muted); margin-top: 6px; }
  .release-link { font-weight: 600; color: var(--ink); }
  .pending-note { font-size: 12px; color: var(--muted); font-style: italic; margin-top: 6px; border-left: 2px solid var(--rule); padding-left: 8px; }

  /* infographics */
  .infographic { margin-bottom: 4px; }
  .infographic-label { font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }

  /* rule */
  .rule { border: none; border-top: 1px solid var(--rule); margin: 0 0 0; }

  /* footer */
  .footer { padding: 12px 24px; border-top: 2px solid var(--ink); font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px; }
</style>
<script type="module">
import { prepareWithSegments, layoutNextLine } from 'https://esm.sh/@chenglou/pretext@0.0.3';

// ── Per-row alpha contour scan (same logic as scripts/shape-wrap.ts) ──
function scanContourProfile(rgba, width, height, threshold) {
  const raw = new Array(height);
  for (let y = 0; y < height; y++) {
    let rightmost = 0;
    const rowOffset = y * width * 4;
    for (let x = width - 1; x >= 0; x--) {
      if (rgba[rowOffset + x * 4 + 3] > threshold) {
        rightmost = x + 1;
        break;
      }
    }
    raw[y] = rightmost;
  }
  // Dilate: each row takes the max of ±radius neighbors.
  // This fills gaps in thin cross-hatching (tripod legs, watch chains, coat edges).
  const radius = Math.max(20, Math.round(height * 0.04));
  const dilated = new Array(height);
  for (let y = 0; y < height; y++) {
    let mx = raw[y];
    for (let dy = -radius; dy <= radius; dy++) {
      const ny = y + dy;
      if (ny >= 0 && ny < height && raw[ny] > mx) mx = raw[ny];
    }
    dilated[y] = mx;
  }
  // Vertical fill: if rows above AND below a gap have content, fill the gap.
  // This prevents contour from dropping to 0 between e.g. a table top and its legs.
  const profile = [...dilated];
  let lastOccupied = -1;
  for (let y = 0; y < height; y++) {
    if (profile[y] > 0) {
      // Fill any gap between lastOccupied and here
      if (lastOccupied >= 0 && y - lastOccupied > 1) {
        const fillW = Math.max(profile[lastOccupied], profile[y]);
        for (let fy = lastOccupied + 1; fy < y; fy++) {
          profile[fy] = Math.max(profile[fy], fillW);
        }
      }
      lastOccupied = y;
    }
  }
  // Bottom padding: extend the contour below the last detected row.
  // Illustrations have fading cross-hatching at the bottom that pixel detection
  // always misses. Add 8% of image height as extra protected rows.
  if (lastOccupied > 0) {
    const bottomPad = Math.round(height * 0.15);
    const padWidth = profile[lastOccupied];
    for (let y = lastOccupied + 1; y < Math.min(height, lastOccupied + bottomPad); y++) {
      profile[y] = Math.max(profile[y], padWidth);
    }
  }
  return profile;
}

function getOccupiedWidthForBand(profile, bandTopPx, bandBottomPx, imgDisplayW, imgDisplayH, imgNaturalW, imgNaturalH, gap) {
  if (bandTopPx >= imgDisplayH) return 0;
  const scale = imgNaturalH / imgDisplayH;
  const startRow = Math.floor(bandTopPx * scale);
  const endRow = Math.min(Math.ceil(Math.min(bandBottomPx, imgDisplayH) * scale), profile.length);
  let maxNatural = 0;
  for (let row = startRow; row < endRow; row++) {
    if (profile[row] > maxNatural) maxNatural = profile[row];
  }
  if (maxNatural === 0) return 0;
  return Math.round(maxNatural * (imgDisplayW / imgNaturalW) + gap);
}

// ── HTML tag/text splitting for preserving inline links ──
function splitTextAndTags(html) {
  if (!html) return [];
  const segments = [];
  const re = /<\\/?[a-zA-Z][^>]*\\/?>/g;
  let last = 0, m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) segments.push({ type: 'text', content: html.slice(last, m.index) });
    segments.push({ type: 'tag', content: m[0] });
    last = re.lastIndex;
  }
  if (last < html.length) segments.push({ type: 'text', content: html.slice(last) });
  return segments;
}

async function shapeWrap(block) {
  const imgEl = block.querySelector('.shape-img');
  const fallbackEl = block.querySelector('.shape-wrap-fallback');
  if (!imgEl || !fallbackEl) return;

  const htmlBody = fallbackEl.innerHTML;
  const segments = splitTextAndTags(htmlBody);
  const plainText = segments.filter(s => s.type === 'text').map(s => s.content).join('');
  if (!plainText.trim()) return;

  // Wait for font to be ready
  await document.fonts.ready;

  // Read font from CSS computed style (matches .body-text exactly)
  const cs = getComputedStyle(fallbackEl);
  const fontSize = parseFloat(cs.fontSize) || 14;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.65;
  const font = fontSize + 'px "IBM Plex Serif", Georgia, serif';

  // Load image into canvas for alpha scanning
  const imgSrc = block.dataset.img;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = imgSrc; });
  } catch { return; } // CORS or network fail → keep float fallback

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch { return; } // tainted canvas → keep float fallback

  const align = block.dataset.align || 'left';
  // Scan alpha contour per row.
  // For right-aligned images, we need to scan from the right edge inward (leftmost opaque pixel).
  // Flip the image data horizontally so scanContourProfile still finds "rightmost" but in mirror.
  let scanData = imageData.data;
  if (align === 'right') {
    scanData = new Uint8ClampedArray(imageData.data);
    const w = canvas.width, h = canvas.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < Math.floor(w / 2); x++) {
        const l = (y * w + x) * 4;
        const r = (y * w + (w - 1 - x)) * 4;
        for (let c = 0; c < 4; c++) {
          const tmp = scanData[l + c];
          scanData[l + c] = scanData[r + c];
          scanData[r + c] = tmp;
        }
      }
    }
  }
  const profile = scanContourProfile(scanData, canvas.width, canvas.height, 5);

  // Get display dimensions
  const imgRect = imgEl.getBoundingClientRect();
  const imgDisplayW = imgRect.width;
  const imgDisplayH = imgRect.height;
  const containerW = block.parentElement.clientWidth || 600;
  const gap = 36;

  // Lay out text line by line with per-row contour widths
  const prepared = prepareWithSegments(plainText, font);
  let cursor = { segmentIndex: 0, graphemeIndex: 0 };
  let y = 0;
  const linesContainer = document.createElement('div');

  // Track character position for HTML tag reinsertion
  let charPos = 0;
  const lines = [];

  while (true) {
    const occupied = getOccupiedWidthForBand(
      profile, y, y + lineHeight,
      imgDisplayW, imgDisplayH,
      canvas.width, canvas.height, gap
    );
    // Only stop shape-wrapping when we're truly past the image bottom
    if (y >= imgDisplayH && occupied === 0) break;
    const availW = Math.max(containerW - occupied - 20, 80);
    const line = layoutNextLine(prepared, cursor, availW);
    if (!line) break;

    lines.push({ text: line.text, occupied, y });
    cursor = line.end;
    y += lineHeight;
    charPos += line.text.length;
  }

  // Rebuild lines with HTML tags reinserted
  let globalCharIdx = 0;
  let segIdx = 0;
  let segCharIdx = 0; // position within current text segment

  for (const lineInfo of lines) {
    const div = document.createElement('div');
    const marginProp = align === 'right' ? 'margin-right' : 'margin-left';
    div.style.cssText = marginProp + ':' + lineInfo.occupied + 'px;font:' + font + ';line-height:' + lineHeight + 'px;';

    let lineHtml = '';
    let remaining = lineInfo.text.length;

    while (remaining > 0 && segIdx < segments.length) {
      const seg = segments[segIdx];
      if (seg.type === 'tag') {
        lineHtml += seg.content;
        segIdx++;
      } else {
        const avail = seg.content.length - segCharIdx;
        const take = Math.min(avail, remaining);
        lineHtml += seg.content.slice(segCharIdx, segCharIdx + take);
        segCharIdx += take;
        remaining -= take;
        if (segCharIdx >= seg.content.length) { segIdx++; segCharIdx = 0; }
      }
    }
    // Flush any tags at end of text
    while (segIdx < segments.length && segments[segIdx].type === 'tag') {
      lineHtml += segments[segIdx].content;
      segIdx++;
    }

    div.innerHTML = lineHtml;
    linesContainer.appendChild(div);
  }

  // Remaining text (below the image) goes into a normal reflowing paragraph
  if (segIdx < segments.length || segCharIdx > 0) {
    let remainingHtml = '';
    // Partial current text segment
    if (segCharIdx > 0 && segIdx < segments.length && segments[segIdx].type === 'text') {
      remainingHtml += segments[segIdx].content.slice(segCharIdx);
      segIdx++; segCharIdx = 0;
    }
    // All remaining segments
    for (; segIdx < segments.length; segIdx++) {
      remainingHtml += segments[segIdx].content;
    }
    if (remainingHtml.trim()) {
      const p = document.createElement('p');
      p.className = 'body-text';
      // The shaped divs may not extend to the image bottom (image is position:absolute).
      // Add padding to push this paragraph below the image.
      const extraPad = Math.max(0, imgDisplayH - y);
      p.style.cssText = 'clear:both;' + (extraPad > 0 ? 'padding-top:' + Math.ceil(extraPad) + 'px;' : '');
      p.innerHTML = remainingHtml.trim();
      linesContainer.appendChild(p);
    }
  }

  // Replace fallback paragraph with positioned lines
  fallbackEl.style.display = 'none';
  imgEl.style.position = 'absolute';
  imgEl.style.top = '0';
  if (align === 'right') { imgEl.style.right = '0'; imgEl.style.left = 'auto'; }
  else { imgEl.style.left = '0'; }
  block.style.position = 'relative';
  block.insertBefore(linesContainer, fallbackEl);
  block.style.minHeight = Math.max(imgDisplayH, y) + 'px';
  const clearDiv = block.querySelector('[style*="clear:both"]');
  if (clearDiv) clearDiv.remove();

  // Store data for relayout on resize
  block._shapeWrapData = { profile, canvas, segments, plainText, font, lineHeight, gap, linesContainer, fallbackEl, imgEl };
}

function relayout(block) {
  const d = block._shapeWrapData;
  if (!d) return;
  const imgRect = d.imgEl.getBoundingClientRect();
  const imgDisplayW = imgRect.width;
  const imgDisplayH = imgRect.height;
  const containerW = block.parentElement.clientWidth || 600;

  const prepared = prepareWithSegments(d.plainText, d.font);
  let cursor = { segmentIndex: 0, graphemeIndex: 0 };
  let y = 0;
  const lines = [];
  while (true) {
    const occupied = getOccupiedWidthForBand(d.profile, y, y + d.lineHeight, imgDisplayW, imgDisplayH, d.canvas.width, d.canvas.height, d.gap);
    const availW = Math.max(containerW - occupied - 20, 80);
    const line = layoutNextLine(prepared, cursor, availW);
    if (!line) break;
    lines.push({ text: line.text, occupied, y });
    cursor = line.end;
    y += d.lineHeight;
  }
  d.linesContainer.innerHTML = '';
  let segIdx = 0, segCharIdx = 0;
  for (const lineInfo of lines) {
    const div = document.createElement('div');
    div.style.cssText = 'margin-left:' + lineInfo.occupied + 'px;font:' + d.font + ';line-height:' + d.lineHeight + 'px;';
    let lineHtml = '';
    let remaining = lineInfo.text.length;
    while (remaining > 0 && segIdx < d.segments.length) {
      const seg = d.segments[segIdx];
      if (seg.type === 'tag') { lineHtml += seg.content; segIdx++; }
      else {
        const avail = seg.content.length - segCharIdx;
        const take = Math.min(avail, remaining);
        lineHtml += seg.content.slice(segCharIdx, segCharIdx + take);
        segCharIdx += take; remaining -= take;
        if (segCharIdx >= seg.content.length) { segIdx++; segCharIdx = 0; }
      }
    }
    while (segIdx < d.segments.length && d.segments[segIdx].type === 'tag') { lineHtml += d.segments[segIdx].content; segIdx++; }
    div.innerHTML = lineHtml;
    d.linesContainer.appendChild(div);
  }
  block.style.minHeight = Math.max(imgDisplayH, y) + 'px';
}

// Run on all shape-wrap blocks after fonts are loaded
document.fonts.ready.then(() => {
  document.querySelectorAll('.shape-wrap-block').forEach(block => {
    shapeWrap(block).catch(err => console.warn('shape-wrap failed, using float fallback:', err));
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll('.shape-wrap-block').forEach(block => relayout(block));
    }, 150);
  });
});
</script>
</head>
<body>
<div class="broadsheet-wrap">
<div class="paper">
  <div class="header">
    <div class="header-kicker">
      <span class="kicker-text"><a href="https://github.com/${ownerHandle}" style="font-size:14px;font-weight:700;letter-spacing:.06em;">@${ownerHandle}</a></span>
      <span style="display:flex;align-items:center;gap:14px;flex-shrink:0;">
        <button onclick="document.getElementById('dark-modal').style.display='flex'" style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;background:none;border:1px solid var(--ink);color:var(--ink);cursor:pointer;padding:2px 7px;border-radius:2px;" title="switch theme">◑ DARK</button>
        <span class="kicker-date">${fromLabel} – ${toLabel}</span>
      </span>
    </div>
    <div class="header-meta">
      <span class="meta-left">Vol. ${vol}, No. ${issue}</span>
      <span class="meta-right"><a href="https://github.com/${ownerHandle}" style="color:var(--muted);">github.com/${ownerHandle}</a></span>
    </div>
    <div class="masthead"><span class="mh-the">the</span><span class="mh-title">dispatch</span></div>
    <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:400;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-top:6px;">open-source digest</div>
    <div class="tagline">${copy.tagline}</div>
    <div class="edition-bar">
      <span>${totalCommits} commits</span>
      <span>${totalMerged + totalOpenPRs} PRs</span>
      <span>${totalReleases} release${totalReleases !== 1 ? "s" : ""}</span>
      <span>${reposData.length} repo${reposData.length !== 1 ? "s" : ""}</span>
    </div>
  </div>
  <div class="body">
    <div class="grid grid-2">
      <div class="col">
        ${copy.editionNote ? `<p style="font-family:'IBM Plex Serif',serif;font-style:italic;font-size:13px;color:var(--muted);margin-bottom:16px;">${copy.editionNote}</p>` : ""}
        ${articlesCol1}
      </div>
      <div class="col">${articlesCol2}</div>
    </div>
  </div>
  <div class="footer">
    <span>${copy.closingNote}</span>
    <span>${new Date().getFullYear()} &copy; AISlopMedia, Inc.</span>
  </div>
</div><!-- /paper page 1 -->

<!-- page 2: stats + index (only visible as separate page on broadsheet layout) -->
<div class="paper page-2">
  <div class="header" style="border-bottom:none;">
    <div class="header-meta" style="margin-bottom:0;padding-bottom:10px;border-bottom:1px solid var(--rule);">
      <span class="meta-left">the dispatch — Vol. ${vol}, No. ${issue}</span>
      <span class="meta-right">${fromLabel} – ${toLabel}</span>
    </div>
  </div>
  <div class="body">
    <div class="articles-p2">${articlesPage2}</div>
    <div class="data-graphics-wrap">${buildDataGraphics(reposData, from, to)}</div>
    <div class="repo-index-wrap" style="padding-top:24px;border-top:2px solid var(--ink);margin-top:8px;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;padding-bottom:10px;margin-bottom:14px;display:flex;align-items:center;gap:8px;">
        <span>repo index</span>
        <span style="flex:1;border-top:1px solid var(--rule);display:inline-block;"></span>
      </div>
      <ul style="list-style:none;">
        ${reposData.map((r) => `<li style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--rule);">
          <a href="${r.url}" style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:var(--ink);">${r.name}</a>
          ${r.description ? `<div style="font-size:12px;color:var(--muted);line-height:1.4;margin-top:2px;">${r.description}</div>` : ""}
          <div style="font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace;margin-top:3px;">${r.commitCount} commits · ${r.releases.length} release${r.releases.length !== 1 ? "s" : ""} · ★ ${r.stars}</div>
        </li>`).join("")}
      </ul>
    </div>
  </div>
  <div class="footer">
    <span>the dispatch is generated weekly from live GitHub data</span>
    <span>${new Date().getFullYear()} &copy; AISlopMedia, Inc.</span>
  </div>
</div><!-- /paper page 2 -->

</div><!-- /broadsheet-wrap -->

<!-- dark mode modal -->
<div id="dark-modal" style="display:none;position:fixed;inset:0;background:rgba(15,15,15,.75);z-index:9999;align-items:center;justify-content:center;padding:24px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="background:#f7f4ee;max-width:380px;width:100%;padding:32px 28px 28px;font-family:'IBM Plex Mono',monospace;border:1px solid #c8c2b4;position:relative;">
    <div style="font-size:28px;margin-bottom:14px;line-height:1;">🖨️</div>
    <p style="font-size:13px;font-weight:700;line-height:1.5;margin-bottom:10px;">dark mode would consume too much ink.</p>
    <p style="font-size:11px;line-height:1.75;color:#666;margin-bottom:22px;">we're a print publication. rendering dark backgrounds requires significantly more ink per page. we'd love to support it, but we need donations first.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <a href="https://github.com/NikolayS/gitzette" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;background:#0f0f0f;color:#f7f4ee;padding:10px 18px;text-decoration:none;white-space:nowrap;">donate to ink fund →</a>
      <button onclick="document.getElementById('dark-modal').style.display='none'" style="font-family:'IBM Plex Mono',monospace;font-size:11px;background:none;border:1px solid #c8c2b4;padding:10px 18px;cursor:pointer;color:#555;white-space:nowrap;">keep it light ☀</button>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── main ──────────────────────────────────────────────────────────────────────

import { existsSync } from "fs";

async function main() {
  const { from, to, noFetch, noLlm, noIllustrations, owner: ownerOverride, output: outputOverride, provider } = parseArgs();

  const owner = ownerOverride || config.owner;
  // Use owner-specific output file to prevent cross-user content bleed via shared index.html
  const outputFile = outputOverride || (ownerOverride ? `${ownerOverride}.html` : config.output);

  const cacheKey = `${provider}_${owner}_${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
  const cacheDir = join(ROOT, ".cache");

  // Compute ISO week key (e.g. "2026-W14") using AoE (UTC-12) so week rolls only
  // after everyone on Earth has finished their Sunday.
  function isoWeekKeyAoE(d: Date): string {
    const aoe = new Date(d.getTime() - 12 * 60 * 60 * 1000);
    // Thursday of this ISO week
    const thu = new Date(aoe);
    thu.setUTCDate(aoe.getUTCDate() - ((aoe.getUTCDay() + 6) % 7) + 3);
    const y = thu.getUTCFullYear();
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const mon1 = new Date(jan4);
    mon1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
    const week = Math.floor((thu.getTime() - mon1.getTime()) / (7 * 86400000)) + 1;
    return `${y}-W${String(week).padStart(2, "0")}`;
  }
  const weekKey = isoWeekKeyAoE(to);
  const cacheFile = join(cacheDir, `${cacheKey}.json`);

  let reposData: RepoData[];

  if (noFetch && existsSync(cacheFile)) {
    console.log(`\nusing cached data from ${cacheFile}`);
    reposData = JSON.parse(readFileSync(cacheFile, "utf8"));
  } else if (provider === "gitlab") {
    // ── GitLab path ───────────────────────────────────────────────────────
    if (!GL_TOKEN) throw new Error("GITLAB_TOKEN not set (required for --provider gitlab)");
    console.log(`\nfetching GitLab repos for ${owner}...`);
    console.log(`window: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}\n`);
    reposData = await fetchGitLabData(owner, from, to, GL_TOKEN);
    console.log(`found ${reposData.length} active repo(s) on GitLab`);

    // cap at top 10
    if (reposData.length > 10) {
      reposData = reposData
        .sort((a, b) => (b.commitCount + b.releases.length * 3 + b.mergedPRs.length) -
                        (a.commitCount + a.releases.length * 3 + a.mergedPRs.length))
        .slice(0, 10);
      console.log(`trimmed to top 10 most active repos`);
    }

    await Bun.write(cacheFile, JSON.stringify(reposData, null, 2));
    console.log(`cached to ${cacheFile}`);
  } else {
    // ── GitHub path (default) ─────────────────────────────────────────────
    if (!GH_TOKEN) throw new Error("GITHUB_TOKEN not set");
    console.log(`\nfetching repos for ${owner}...`);
    const allRepos = await listRepos(owner);

    const excludeSet = new Set((config.repos.exclude || []).map((r) => r.toLowerCase()));
    const includeSet = config.repos.include ? new Set(config.repos.include.map((r) => r.toLowerCase())) : null;

    const repos = allRepos.filter((r) => {
      if (excludeSet.has(r.toLowerCase())) return false;
      if (includeSet && !includeSet.has(r.toLowerCase())) return false;
      return true;
    });

    // also find repos the user contributed to but doesn't own (e.g. pgdogdev/pgdog for levkk)
    const foreignRepoFullNames = await listContributedRepos(owner, from, to).catch(() => []);
    if (foreignRepoFullNames.length > 0) {
      console.log(`foreign repos with contributions: ${foreignRepoFullNames.join(", ")}`);
    }

    console.log(`repos to scan: ${repos.join(", ")}`);
    console.log(`window: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}\n`);

    reposData = [];
    for (const repo of repos) {
      process.stdout.write(`  ${repo}... `);
      const data = await getRepoData(owner, repo, from, to);
      if (data) {
        reposData.push(data);
        console.log(`✓ (${data.commitCount} commits, ${data.releases.length} releases, ${data.mergedPRs.length} merged PRs)`);
      } else {
        console.log("(quiet week, skipped)");
      }
    }

    // scan foreign repos (contributions to other orgs/users)
    for (const fullName of foreignRepoFullNames) {
      const [repoOwner, repoName] = fullName.split("/");
      process.stdout.write(`  ${fullName} (foreign)... `);
      const data = await getRepoData(repoOwner, repoName, from, to, owner);
      if (data) {
        // tag as foreign so LLM knows
        (data as any).foreign = true;
        (data as any).fullName = fullName;
        reposData.push(data);
        console.log(`✓ (${data.commitCount} commits, ${data.releases.length} releases, ${data.mergedPRs.length} merged PRs)`);
      } else {
        console.log("(no owner commits, skipped)");
      }
    }

    // cap at top 10 most active repos to keep LLM input + HTML manageable
    if (reposData.length > 10) {
      reposData = reposData
        .sort((a, b) => (b.commitCount + b.releases.length * 3 + b.mergedPRs.length) -
                        (a.commitCount + a.releases.length * 3 + a.mergedPRs.length))
        .slice(0, 10);
      console.log(`\ntrimmed to top 10 most active repos`);
    }

    // save cache
    await Bun.write(cacheFile, JSON.stringify(reposData, null, 2));
    console.log(`\ncached to ${cacheFile}`);
  }

  if (reposData.length === 0) {
    console.log("nothing happened this week. that's news too, but not dispatch news.");
    process.exit(0);
  }

  // ── slow news week detection ───────────────────────────────────────────────
  const totalActivity = reposData.reduce(
    (sum, r) => sum + r.commitCount + r.mergedPRs.length + r.releases.length,
    0
  );
  const isQuietWeek = totalActivity < 3;
  if (isQuietWeek) {
    console.log(`\n⚠️  quiet week detected (${totalActivity} total commits/PRs/releases) — slow news week mode`);
  }

  // CRITICAL: if zero repos data and quiet week, don't call LLM at all
  // The LLM with empty data will hallucinate content from other users (e.g. from system prompt examples)
  if (reposData.length === 0) {
    console.error(`\n✗ No activity found for ${owner} in ${from.toISOString().slice(0,10)} – ${to.toISOString().slice(0,10)}. Aborting to prevent content bleed.`);
    process.exit(1);
  }

  const quietWeekNote = isQuietWeek
    ? `NOTE: This was a very quiet week with minimal activity (${totalActivity} total commits/PRs/releases). Write a witty, self-aware 'slow news week' edition. Hero headline should acknowledge the quiet. Use ONLY the repos listed in the data — do NOT invent or reference any other repos or people. Pull quote should be philosophical about rest/thinking time. Keep it short and charming, not apologetic.`
    : null;

  // load cached copy if --no-llm
  const copyFile = join(cacheDir, `${cacheKey}.copy.json`);
  let copy: Awaited<ReturnType<typeof generateCopy>>;

  if (noLlm && existsSync(copyFile)) {
    console.log(`\nusing cached copy from ${copyFile}`);
    copy = sanitizeCopy(JSON.parse(readFileSync(copyFile, "utf8")));
  } else {
    console.log(`\ngenerating copy via LLM (${config.model})...`);
    // only inject knownIncidents for the configured owner, not arbitrary --owner overrides
    // knownIncidentsByWeek: only inject incidents that match the current ISO week (prevents stale incidents bleeding into future weeks)
    const incidents = (owner === config.owner)
      ? [
          ...(config.knownIncidents || []),
          ...((config.knownIncidentsByWeek || {})[weekKey] || []),
        ]
      : [];
    // fetch human-approved/rejected examples to guide the LLM
    const examples = await fetchExamples();
    if (examples.gold.length > 0 || examples.bad.length > 0) {
      console.log(`  injecting ${examples.gold.length} gold + ${examples.bad.length} bad examples into prompt`);
    }
    // Pass 1: LLM picks articles (no issue context yet — just titles/numbers)
    const pass1Copy = await generateCopy(reposData, from, to, owner, incidents, quietWeekNote, null, examples);

    // Enrich chosen articles with linked issue context (fetched from GitHub API)
    console.log("fetching linked issue context for chosen articles...");
    const issueCtx = await enrichArticlesWithIssueContext(pass1Copy.articles, reposData, owner, from)
      .catch(e => { console.warn(`  issue context fetch failed: ${e.message}`); return []; });
    if (issueCtx.length > 0) {
      console.log(`  found issue context for ${issueCtx.length} repo(s) — regenerating with enriched data`);
    }

    // Pass 2: regenerate with issue context injected (or reuse pass1 if no context found)
    const rawCopy = issueCtx.length > 0
      ? await generateCopy(reposData, from, to, owner, incidents, quietWeekNote, null, examples, issueCtx)
      : pass1Copy;

    copy = await runEvals(rawCopy, reposData, from, to, owner, incidents, quietWeekNote ?? undefined, issueCtx);
    await Bun.write(copyFile, JSON.stringify(copy, null, 2));
  }

  // determine vol/issue
  const vol = 1;
  const issue = Math.ceil((to.getTime() - new Date("2026-03-15").getTime()) / (7 * 86400 * 1000)) + 1;

  console.log(`building html...`);
  // skip illustration generation on quiet weeks
  const html = await buildHtml(copy, reposData, from, to, vol, issue, owner, noIllustrations || isQuietWeek);

  const outPath = join(ROOT, outputFile);
  writeFileSync(outPath, html, "utf8");
  console.log(`\n✓ written to ${outPath}`);
  console.log(`\nheadlines:`);
  copy.articles.forEach((a) => console.log(`  [${a.tag}] ${a.headline}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
