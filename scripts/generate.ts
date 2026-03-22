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
const CONFIG_PATH = join(ROOT, "dispatch.config.json");

// ── config ──────────────────────────────────────────────────────────────────

interface Config {
  owner: string;
  repos: { exclude?: string[]; include?: string[] };
  model: string;
  output: string;
  knownIncidents?: string[];
  imageGen?: { provider: string; model: string; style: string };
}

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
    from = new Date(to);
    from.setDate(from.getDate() - 7);
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

    return images.slice(0, 1); // max 1 image per repo
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
async function uploadIllustrationToR2(slug: string, buf: Buffer): Promise<string | null> {
  const cfToken = process.env.CF_TOKEN;
  if (!cfToken) { console.warn("  no CF_TOKEN — can't upload illustration"); return null; }
  const key = encodeURIComponent(`illustrations/${slug}.jpg`);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets/${CF_R2_BUCKET}/objects/${key}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${cfToken}`, "Content-Type": "image/jpeg" },
        body: buf,
      }
    );
    const data: any = await res.json();
    if (!data.success) { console.warn(`  R2 upload failed: ${JSON.stringify(data)}`); return null; }
    return `https://gitzette.online/img/${slug}.jpg`;
  } catch (e) {
    console.warn(`  R2 upload error: ${e}`);
    return null;
  }
}

/** Generate an illustration via Google Gemini 2.5 Flash Image.
 *  Uploads to R2, caches the URL to disk — on quota/error, returns cached URL if available.
 *  Never throws. */
async function generateIllustration(subject: string): Promise<string | null> {
  const cfg = (config as any).imageGen;
  if (!cfg) return null;

  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const cachePath = illusCachePath(subject); // stores the URL (not data URI)

  const googleKey = process.env.GOOGLE_AI_KEY;
  if (!googleKey) {
    console.warn("  no GOOGLE_AI_KEY — trying cache");
    try { return await fs.readFile(cachePath, "utf8"); } catch { return null; }
  }

  const prompt = cfg.style + subject;

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
        const processed = await sharp(rawBuf)
          .grayscale().normalise()
          .modulate({ brightness: 0.92, saturation: 0 })
          .sharpen({ sigma: 0.8 })
          .jpeg({ quality: 82, progressive: true })
          .toBuffer();
        const url = await uploadIllustrationToR2(slug, processed);
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

// ── llm copy ─────────────────────────────────────────────────────────────────

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY not set");

async function generateCopy(
  reposData: RepoData[],
  from: Date,
  to: Date,
  owner: string = "NikolayS",
  knownIncidents: string[] = [],
  quietWeekNote: string | null = null
): Promise<{
  masthead: string;
  tagline: string;
  editionNote: string;
  articles: Array<{
    repo: string;
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
      mergedPRs: r.mergedPRs.slice(0, 10).map((p) => ({ title: p.title, author: p.author, url: p.url, number: p.number })),
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
Return a JSON object with this exact structure:
{
  "masthead": "the dispatch",
  "tagline": "a one-line tagline for this week (witty, specific to what happened)",
  "editionNote": "one sentence edition note (e.g. 'Six releases. Two repos. One very productive week.')",
  "articles": [
    {
      "repo": "repo name",
      "headline": "punchy newspaper headline",
      "deck": "one-sentence italic subheading expanding on the headline",
      "body": "2-4 sentence article body. Reference specific features/PRs from the data. Mention pending work if notable.",
      "tag": "RELEASE | FEATURE | SECURITY | PENDING | COMMUNITY",
      "illustrationPrompt": "simple concrete subject for a stark black-and-white woodcut (8-12 words). ONE clear focal object or scene. Avoid tangled cables, complex networks, abstract patterns. Good examples: 'a hand turning a large gear', 'two server towers facing each other', 'a padlock resting on a stack of disks'. No text, signs, or labels.",
      "illustrate": false
    }
  ],
  "closingNote": "one-line sign-off at the bottom of the paper (dry, funny)"
}

Order articles by newsworthiness (releases > big features > pending work).
Maximum 8 articles total — pick the most newsworthy, drop the rest.
For "illustrate": set true on at most 2 articles that would most benefit visually — prefer the lead story (h1) and one other with a vivid, illustrable subject. Articles that already have a README screenshot don't need it (but you don't know which ones do, so use editorial judgment: releases and security incidents tend to have good screenshots; abstract tools/pending work benefit more from illustration).
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
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]+\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    throw new Error(`LLM returned non-JSON: ${text.slice(0, 300)}`);
  }
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
    const tlH = allReleases.length > 3 ? 100 : 80;
    const lineY = tlH - 22;
    const drawW = tlW - PAD * 2;

    const dayTicks = [];
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const x = PAD + Math.round(((d.getTime() - fromMs) / rangeMs) * drawW);
      dayTicks.push(`<line x1="${x}" y1="${lineY - 4}" x2="${x}" y2="${lineY + 4}" stroke="#aaa" stroke-width="1"/>`);
      dayTicks.push(`<text x="${x}" y="${tlH - 4}" font-family="IBM Plex Mono,monospace" font-size="8" fill="#aaa" text-anchor="middle">${d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}</text>`);
    }

    // group releases by day to stagger overlapping labels
    const dots = allReleases.map((rel, i) => {
      const x = PAD + Math.round(((new Date(rel.date).getTime() - fromMs) / rangeMs) * drawW);
      const row = i % 3; // up to 3 rows to spread crowded dates
      const dotY = lineY - 20 - row * 22;
      // clamp label x so it never goes outside viewBox
      const lx = Math.min(Math.max(x, PAD + 20), tlW - PAD - 20);
      return `
        <line x1="${x}" y1="${dotY + 6}" x2="${x}" y2="${lineY}" stroke="#bbb" stroke-width="0.8" stroke-dasharray="2,2"/>
        <circle cx="${x}" cy="${dotY}" r="5" fill="#0f0f0f"/>
        <text x="${lx}" y="${dotY - 7}" font-family="IBM Plex Mono,monospace" font-size="8" fill="#0f0f0f" text-anchor="middle" font-weight="600">${rel.repo} ${rel.tag}</text>`;
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

function renderArticle(
  article: { repo: string; headline: string; deck: string; body: string; tag: string },
  repoData: RepoData,
  level: "h1" | "h2" | "h3",
  imageIndex: number = 0 // which demo image to use (if any)
): string {
  const releaseLinks = repoData.releases
    .map(
      (r) =>
        `<a href="${r.url}" class="release-link">${r.tag}</a> <span class="muted">${formatDate(r.date)}</span>`
    )
    .join(" &nbsp;·&nbsp; ");

  const prLinks = repoData.mergedPRs
    .slice(0, 5)
    .map((p) => `<a href="${p.url}" class="pr-link">#${p.number}</a>`)
    .join(" ");

  const openPRNote =
    repoData.openPRs.length > 0
      ? `<div class="pending-note">${repoData.openPRs.length} open PR${repoData.openPRs.length > 1 ? "s" : ""}: ${repoData.openPRs
          .slice(0, 3)
          .map((p) => `<a href="${p.url}">#${p.number} ${p.title}</a>`)
          .join(", ")}</div>`
      : "";

  const img = repoData.demoImages[imageIndex];
  // All images: natural aspect ratio, full column width, no cropping
  const imageHtml = img
    ? `<div class="article-image" style="border:1px solid var(--rule);margin:10px 0;overflow:hidden;max-width:100%;">
        <img src="${img}" alt="" style="width:100%;max-width:100%;height:auto;display:block;">
      </div>`
    : "";

  return `
    <div class="article">
      <div class="tag">${article.tag}</div>
      <${level}><a href="${repoData.url}" class="headline-link">${article.headline}</${level}>
      <p class="deck">${article.deck}</p>
      ${imageHtml}
      <p class="body-text">${article.body.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/`/g, '')}</p>
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
    const toIllustrate = copy.articles.filter((a: any) => a.illustrate === true).slice(0, 2);
    if (toIllustrate.length > 0) {
      console.log(`generating ${toIllustrate.length} illustration(s)...`);
      for (const a of toIllustrate) {
        const subject = (a as any).illustrationPrompt ?? `abstract editorial scene related to ${a.repo} software project`;
        process.stdout.write(`  illustration for "${a.headline}"... `);
        const url = await generateIllustration(subject);
        illustrationCache[a.headline] = url ?? null;
        console.log(url ? "✓" : "skipped");
      }
    } else {
      console.log("no illustrations requested by LLM this week");
    }
  }

  // 1 image per project max — track which repos have had their image shown
  // cap: max MAX_REPO_IMAGES repo (README) images per dispatch
  const imageShown = new Set<string>();
  let repoImageCount = 0;
  const splitAt = Math.ceil(copy.articles.length / 2); // ~half on each page

  const renderedArticles = copy.articles.map((a, i) => {
      const repo = repoMap[a.repo];
      if (!repo) return "";
      const level = i === 0 ? "h1" : i < 3 ? "h2" : "h3";
      // allow repo image only if: repo has one, not yet shown, and under the cap
      const hasRepoImg = repo.demoImages[0] && !imageShown.has(a.repo) && repoImageCount < MAX_REPO_IMAGES;
      if (hasRepoImg) {
        imageShown.add(a.repo);
        repoImageCount++;
      }
      // build a per-article demoImages array: repo screenshot (first use) or illustration
      const articleImages = hasRepoImg
        ? repo.demoImages
        : illustrationCache[a.headline]
          ? [illustrationCache[a.headline]!]
          : [];
      const articleRepo = { ...repo, demoImages: articleImages };
      return renderArticle(a, articleRepo, level as "h1" | "h2" | "h3", 0);
    });

  const articles = renderedArticles.slice(0, splitAt).join("\n");
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
    /* on broadsheet, hide p2 articles from page 1 (they move to page 2) */
    .broadsheet-wrap .paper:first-child .articles-p2 { display: none; }
    /* on broadsheet, hide the sidebar from page 1 (stats + p2 articles move to page 2) */
    .broadsheet-wrap .paper:first-child .grid-2-1 { grid-template-columns: 1fr; }
    .broadsheet-wrap .paper:first-child .grid-2-1 .col:last-child { display: none; }
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
  .masthead { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: clamp(32px,7vw,64px); letter-spacing: -.03em; line-height: 1; }
  .masthead span { color: var(--muted); font-weight: 400; }
  .tagline { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--muted); margin-top: 6px; letter-spacing: .04em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .edition-bar { margin-top: 12px; padding: 6px 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .05em; display: flex; flex-wrap: nowrap; gap: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .edition-bar::-webkit-scrollbar { display: none; }
  .edition-bar span { white-space: nowrap; padding: 0 16px 0 0; }
  .edition-bar span::before { content: "▸ "; color: var(--muted); }

  /* body */
  .body { padding: 0 24px 32px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 0; }
  @media (min-width: 640px) { .grid-2-1 { grid-template-columns: 3fr 1fr; } .grid-3 { grid-template-columns: 1fr 1fr 1fr; } }
  .col { padding: 20px 20px 0 0; }
  .col:last-child { padding-right: 0; }
  @media (min-width: 640px) { .col { border-right: 1px solid var(--rule); } .col:last-child { border-right: none; padding-left: 20px; } .grid-3 .col { padding: 20px 16px 0; } .grid-3 .col:first-child { padding-left: 0; } .grid-3 .col:last-child { padding-right: 0; } }

  /* tags */
  .tag { display: inline-block; font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; background: var(--tag-bg); color: var(--tag-fg); padding: 2px 7px; margin-bottom: 8px; }

  /* articles */
  .article { margin-bottom: 24px; }
  h1 { font-family: 'IBM Plex Serif', serif; font-size: clamp(22px,4vw,36px); font-weight: 700; line-height: 1.1; margin-bottom: 8px; }
  h2 { font-family: 'IBM Plex Serif', serif; font-size: clamp(16px,3vw,22px); font-weight: 700; line-height: 1.15; margin-bottom: 6px; }
  h3 { font-family: 'IBM Plex Serif', serif; font-size: 15px; font-weight: 700; line-height: 1.2; margin-bottom: 4px; }
  .headline-link { color: var(--ink); text-decoration: none; }
  .headline-link:hover { text-decoration: underline; }
  .deck { font-family: 'IBM Plex Serif', serif; font-style: italic; font-size: 14px; line-height: 1.55; color: #333; margin-bottom: 10px; }
  .body-text { font-size: 14px; line-height: 1.65; margin-bottom: 8px; text-decoration: none; }
  .body-text a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--rule); }
  .body-text a:hover { border-bottom-color: var(--ink); }
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
</head>
<body>
<div class="broadsheet-wrap">
<div class="paper">
  <div class="header">
    <div class="header-kicker">
      <span class="kicker-text"><a href="https://github.com/${ownerHandle}" style="font-size:14px;font-weight:700;letter-spacing:.06em;">@${ownerHandle}</a> <span style="font-weight:400;letter-spacing:.12em;">— open-source digest</span></span>
      <span class="kicker-date">${fromLabel} – ${toLabel}</span>
    </div>
    <div class="header-meta">
      <span class="meta-left">Vol. ${vol}, No. ${issue}</span>
      <span class="meta-right">github.com/${ownerHandle}</span>
    </div>
    <div class="masthead">the <span>dispatch</span></div>
    <div style="font-family:'IBM Plex Mono',monospace;font-size:clamp(13px,2.5vw,18px);font-weight:700;letter-spacing:.06em;margin-top:4px;"><a href="https://github.com/${ownerHandle}" style="color:var(--ink);text-decoration:none;">@${ownerHandle}</a></div>
    <div class="tagline">${copy.tagline}</div>
    <div class="edition-bar">
      <span>${totalCommits} commits</span>
      <span>${totalMerged + totalOpenPRs} PRs</span>
      <span>${totalReleases} release${totalReleases !== 1 ? "s" : ""}</span>
      <span>${reposData.length} repo${reposData.length !== 1 ? "s" : ""}</span>
    </div>
  </div>
  <div class="body">
    <div class="grid grid-2-1">
      <div class="col">
        ${copy.editionNote ? `<p style="font-family:'IBM Plex Serif',serif;font-style:italic;font-size:13px;color:var(--muted);margin-bottom:16px;">${copy.editionNote}</p>` : ""}
        ${articles}
      </div>
    </div>
  </div>
  <div class="footer">
    <span>${copy.closingNote}</span>
    <span>generated ${new Date().toISOString().slice(0, 10)}</span>
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
    ${buildDataGraphics(reposData, from, to)}
    <div style="padding-top:24px;border-top:2px solid var(--ink);margin-top:8px;">
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
    <span>github.com/NikolayS/dispatch</span>
  </div>
</div><!-- /paper page 2 -->

</div><!-- /broadsheet-wrap -->
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
    copy = JSON.parse(readFileSync(copyFile, "utf8"));
  } else {
    console.log(`\ngenerating copy via LLM (${config.model})...`);
    // only inject knownIncidents for the configured owner, not arbitrary --owner overrides
    const incidents = (owner === config.owner) ? (config.knownIncidents || []) : [];
    copy = await generateCopy(reposData, from, to, owner, incidents, quietWeekNote);
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
