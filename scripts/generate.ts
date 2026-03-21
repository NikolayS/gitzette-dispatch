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

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
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

function parseArgs(): { from: Date; to: Date; noFetch: boolean; noLlm: boolean } {
  const args = process.argv.slice(2);
  let from: Date | undefined;
  let to: Date | undefined;
  let noFetch = false;
  let noLlm = false;
  let owner: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) from = new Date(args[++i]);
    if (args[i] === "--to" && args[i + 1]) to = new Date(args[++i]);
    if (args[i] === "--no-fetch") noFetch = true;
    if (args[i] === "--no-llm") noLlm = true;
    if (args[i] === "--owner" && args[i + 1]) owner = args[++i];
    if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }

  if (!to) to = new Date();
  if (!from) {
    from = new Date(to);
    from.setDate(from.getDate() - 7);
  }

  return { from, to, noFetch, noLlm, owner, output };
}

// ── github api ───────────────────────────────────────────────────────────────

const GH_TOKEN = process.env.GITHUB_TOKEN;
if (!GH_TOKEN) throw new Error("GITHUB_TOKEN not set");

async function ghGet(path: string): Promise<any> {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

async function listRepos(owner: string): Promise<string[]> {
  const data = await ghGet(`/users/${owner}/repos?per_page=100&sort=pushed`);
  return data.map((r: any) => r.name);
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

async function newspaperify(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `token ${GH_TOKEN}` },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return newspaperifyBuffer(buf);
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
      // fetch + process to newspaper style
      const dataUri = await newspaperify(resolved);
      if (dataUri) images.push(dataUri);
    }

    return images.slice(0, 1); // max 1 image per repo
  } catch {
    return [];
  }
}

async function getRepoData(owner: string, repo: string, from: Date, to: Date): Promise<RepoData | null> {
  try {
    const info = await ghGet(`/repos/${owner}/${repo}`);

    // releases in window
    const allReleases = await ghGet(`/repos/${owner}/${repo}/releases?per_page=20`);
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
    const allPRs = await ghGet(`/repos/${owner}/${repo}/pulls?state=closed&per_page=50&sort=updated&direction=desc`);
    const mergedPRs: PR[] = allPRs
      .filter((p: any) => {
        if (!p.merged_at) return false;
        const d = new Date(p.merged_at);
        return d >= from && d <= to;
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
    const openPRsRaw = await ghGet(`/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=created&direction=desc`);
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
    const openIssuesRaw = await ghGet(`/repos/${owner}/${repo}/issues?state=open&per_page=20`);
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
      const commits = await ghGet(
        `/repos/${owner}/${repo}/commits?since=${fromStr}&until=${toStr}&per_page=100`
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

/** Generate an illustration via Imagen 4 (Google) or gpt-image-1 (OpenAI fallback).
 *  Returns a data: URI string or null on failure. Never throws. */
async function generateIllustration(subject: string): Promise<string | null> {
  const cfg = (config as any).imageGen;
  if (!cfg) return null;

  const prompt = cfg.style + subject;
  const googleKey = process.env.GOOGLE_AI_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // try Google Imagen 4 first
  if (googleKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=${googleKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1, aspectRatio: "16:9" },
          }),
        }
      );
      const data: any = await res.json();
      if (data.predictions?.[0]?.bytesBase64Encoded) {
        const b64 = data.predictions[0].bytesBase64Encoded;
        const buf = Buffer.from(b64, "base64");
        return newspaperifyBuffer(buf);
      }
      console.warn(`  Imagen 4 unavailable: ${data.error?.message?.slice(0, 80) ?? "unknown"}`);
    } catch (e) {
      console.warn(`  Imagen 4 error: ${e}`);
    }
  }

  // fallback: OpenAI gpt-image-1
  if (openaiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt,
          n: 1,
          size: "1536x1024",
          output_format: "jpeg",
          quality: "medium",
        }),
      });
      const data: any = await res.json();
      if (data.data?.[0]?.b64_json) {
        const buf = Buffer.from(data.data[0].b64_json, "base64");
        return newspaperifyBuffer(buf);
      }
      console.warn(`  gpt-image-1 error: ${JSON.stringify(data.error ?? data).slice(0, 120)}`);
    } catch (e) {
      console.warn(`  gpt-image-1 error: ${e}`);
    }
  }

  return null;
}

// ── llm copy ─────────────────────────────────────────────────────────────────

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY not set");

async function generateCopy(
  reposData: RepoData[],
  from: Date,
  to: Date,
  owner: string = "NikolayS",
  knownIncidents: string[] = []
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
    illustrationPrompt?: string; // subject for AI illustration (if no README screenshot)
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

  const prompt = `You are writing the editorial copy for a weekly engineering newspaper called "the dispatch" — a digest of GitHub activity by @${owner}.

The newspaper covers his GitHub projects for the week of ${fromLabel} – ${toLabel}.

RULES — STYLE:
- Be creative with form: punchy headlines, dry wit, newspaper voice
- Be strict with facts: never invent numbers, dates, features, or PR titles not in the data
- Write like a real tech newspaper editor, not a PR person or a release notes bot
- Headlines: specific and surprising, not generic. Bad: "rpg gets new features". Good: "rpg teaches EXPLAIN to read its own X-rays"
- Short sentences. Active voice. No hedge words.
- No emoji anywhere
- Sentence case for headlines (not Title Case)

RULES — ATTRIBUTION:
- Always refer to the author as "@${owner}" — never by full name, "the developer", "the author"
- Repo/project names are ALWAYS lowercase, no exceptions, even at sentence start: "rpg" not "RPG", "sqlever" not "Sqlever", "pg_ash" not "PG_ash", "leandex" not "Leandex"

RULES — CONTENT:
- For release articles: name specific features from the release notes. "Automatic warnings for seq scans on large tables" is better than "improved EXPLAIN". Use the actual feature names.
- For PR articles: only reference PRs opened THIS WEEK (they are pre-filtered). Do not discuss old open PRs as if they are news.
- When mentioning specific PRs or issues, link them inline as HTML: <a href="URL">#NUMBER title</a>
- article body is plain text with optional inline HTML links — do NOT use markdown
- body text must never use markdown formatting (no **bold**, no backticks) — use plain prose only

RULES — STRUCTURE:
- Order by newsworthiness: releases first, then features, security, pending, community
- editionNote: punchy 1-sentence summary of the whole week (e.g. "Four releases, one leaked key, and a migration tool that arrived fully armed.")
- closingNote: dry one-liner, like a newspaper colophon

Here is the raw data:
${dataJson}

${knownIncidents.length ? `KNOWN INCIDENTS THIS WEEK (confirmed by the author — must include as articles):\n${knownIncidents.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}

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
      "illustrationPrompt": "short subject description for an editorial illustration (10-15 words). Only for stories without obvious screenshots. E.g. 'robot reading a PostgreSQL query plan with magnifying glass' or 'lock and key with database cylinder'. Skip for repos that have demo screenshots."
    }
  ],
  "closingNote": "one-line sign-off at the bottom of the paper (dry, funny)"
}

Order articles by newsworthiness (releases > big features > pending work).
Return ONLY the JSON object, no markdown fences.`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2000,
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
  const STAR_COLS = 10; // max filled stars per row
  const starRows = starredRepos.map((r) => {
    const filled = Math.max(1, Math.round((r.stars / maxStars) * STAR_COLS));
    const empty = STAR_COLS - filled;
    const starFill = "★".repeat(filled);
    const starEmpty = "☆".repeat(empty);
    return `<tr style="border-bottom:1px solid var(--rule);">
      <td style="font-family:'IBM Plex Mono',monospace;font-size:11px;padding:10px 12px 10px 0;white-space:nowrap;vertical-align:middle;"><a href="${r.url}" style="color:var(--ink);text-decoration:none;">${r.name}</a></td>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:36px;letter-spacing:4px;line-height:1;vertical-align:middle;padding:12px 14px 12px 0;">${starFill}<span style="color:#ddd;">${starEmpty}</span></td>
      <td style="font-family:'IBM Plex Mono',monospace;font-size:28px;font-weight:700;color:var(--ink);white-space:nowrap;vertical-align:middle;text-align:right;padding:12px 0;">${r.stars.toLocaleString()}</td>
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
    ? `<div class="article-image" style="border:1px solid var(--rule);margin:10px 0;">
        <img src="${img}" alt="" style="width:100%;display:block;">
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
  ownerHandle: string = "NikolayS"
): string {
  const repoMap = Object.fromEntries(reposData.map((r) => [r.name, r]));

  const totalCommits = reposData.reduce((s, r) => s + r.commitCount, 0);
  const totalReleases = reposData.reduce((s, r) => s + r.releases.length, 0);
  const totalMerged = reposData.reduce((s, r) => s + r.mergedPRs.length, 0);
  const totalOpenPRs = reposData.reduce((s, r) => s + r.openPRs.length, 0);

  const fromLabel = from.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const toLabel = to.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // generate AI illustrations for articles without README screenshots
  console.log("generating illustrations...");
  const illustrationCache: Record<string, string | null> = {};
  for (const a of copy.articles) {
    const repo = repoMap[a.repo];
    if (!repo) continue;
    const imgIdx = 0;
    if (!repo.demoImages[imgIdx] && a.illustrationPrompt) {
      process.stdout.write(`  illustration for ${a.repo}... `);
      const dataUri = await generateIllustration(a.illustrationPrompt);
      illustrationCache[a.repo] = dataUri;
      console.log(dataUri ? "✓" : "skipped");
    }
  }

  // 1 image per project max — track which repos have had their image shown
  const imageShown = new Set<string>();
  const splitAt = Math.ceil(copy.articles.length / 2); // ~half on each page

  const renderedArticles = copy.articles.map((a, i) => {
      const repo = repoMap[a.repo];
      if (!repo) return "";
      const level = i === 0 ? "h1" : i < 3 ? "h2" : "h3";
      const imgIdx = imageShown.has(a.repo) ? -1 : 0;
      if (imgIdx === 0) {
        imageShown.add(a.repo);
        if (!repo.demoImages[0] && illustrationCache[a.repo]) {
          repo.demoImages[0] = illustrationCache[a.repo]!;
        }
      }
      return renderArticle(a, repo, level as "h1" | "h2" | "h3", imgIdx < 0 ? 99 : imgIdx);
    });

  const articles = renderedArticles.slice(0, splitAt).join("\n");
  const articlesPage2 = renderedArticles.slice(splitAt).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .paper { max-width: 960px; margin: 24px auto; background: var(--paper); border: 1px solid var(--rule); box-shadow: 0 2px 12px rgba(0,0,0,.15); }
  /* broadsheet: two pages side by side on very wide screens */
  .page-2 { display: none; }
  /* on narrow: show all articles on page 1 */
  .articles-p2 { display: none; }
  @media (min-width: 1400px) {
    body { background: #d8d4cc; }
    .broadsheet-wrap { display: flex; align-items: flex-start; gap: 0; max-width: 1900px; margin: 32px auto; }
    .broadsheet-wrap .paper { max-width: none; flex: 1; margin: 0; box-shadow: 0 4px 24px rgba(0,0,0,.2); }
    .broadsheet-wrap .paper.page-2 { display: block; border-left: 3px double var(--rule); margin-left: -1px; }
    .broadsheet-wrap .articles-p2 { display: block; }
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
  .body-text a { color: var(--link); text-decoration: none; }
  .body-text a:hover { text-decoration: underline; }
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
      <span class="kicker-text"><a href="https://github.com/${ownerHandle}">@${ownerHandle}</a> — open-source digest</span>
      <span class="kicker-date">${fromLabel} – ${toLabel}</span>
    </div>
    <div class="header-meta">
      <span class="meta-left">Vol. ${vol}, No. ${issue}</span>
      <span class="meta-right">github.com/${ownerHandle}</span>
    </div>
    <div class="masthead">the <span>dispatch</span></div>
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
      <div class="col">
        ${buildDataGraphics(reposData, from, to)}
        <div style="padding-top:20px;">
          <div class="tag">repos</div>
          <ul style="list-style:none;margin-top:8px;">
            ${reposData
              .map(
                (r) => `<li style="margin-bottom:12px;">
              <a href="${r.url}" style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:var(--ink);">${r.name}</a>
              ${r.description ? `<div style="font-size:12px;color:var(--muted);line-height:1.4;">${r.description}</div>` : ""}
              <div style="font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace;margin-top:2px;">
                ${r.commitCount} commits &nbsp;·&nbsp; ${r.releases.length} release${r.releases.length !== 1 ? "s" : ""}
              </div>
            </li>`
              )
              .join("")}
          </ul>
        </div>
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
  const { from, to, noFetch, noLlm, owner: ownerOverride, output: outputOverride } = parseArgs();

  const owner = ownerOverride || config.owner;
  const outputFile = outputOverride || config.output;

  const cacheKey = `${owner}_${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
  const cacheDir = join(ROOT, ".cache");
  const cacheFile = join(cacheDir, `${cacheKey}.json`);

  let reposData: RepoData[];

  if (noFetch && existsSync(cacheFile)) {
    console.log(`\nusing cached data from ${cacheFile}`);
    reposData = JSON.parse(readFileSync(cacheFile, "utf8"));
  } else {
    console.log(`\nfetching repos for ${owner}...`);
    const allRepos = await listRepos(owner);

    const excludeSet = new Set((config.repos.exclude || []).map((r) => r.toLowerCase()));
    const includeSet = config.repos.include ? new Set(config.repos.include.map((r) => r.toLowerCase())) : null;

    const repos = allRepos.filter((r) => {
      if (excludeSet.has(r.toLowerCase())) return false;
      if (includeSet && !includeSet.has(r.toLowerCase())) return false;
      return true;
    });

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

    // save cache
    await Bun.write(cacheFile, JSON.stringify(reposData, null, 2));
    console.log(`\ncached to ${cacheFile}`);
  }

  if (reposData.length === 0) {
    console.log("nothing happened this week. that's news too, but not dispatch news.");
    process.exit(0);
  }

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
    copy = await generateCopy(reposData, from, to, owner, incidents);
    await Bun.write(copyFile, JSON.stringify(copy, null, 2));
  }

  // determine vol/issue
  const vol = 1;
  const issue = Math.ceil((to.getTime() - new Date("2026-03-15").getTime()) / (7 * 86400 * 1000)) + 1;

  console.log(`building html...`);
  const html = await buildHtml(copy, reposData, from, to, vol, issue, owner);

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
