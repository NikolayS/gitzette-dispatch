/**
 * One-off: generate a single illustration and save to R2 + cache.
 * Usage: bun scripts/gen-one-illustration.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import sharp from "sharp";
// Load .env manually
const envPath = path.join(import.meta.dir, "../.env");
try {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const CF_ACCOUNT = "a3265e0d0db71fdece29365819452f00";
const CF_R2_BUCKET = "gitzette-dispatches";
const CF_TOKEN = process.env.CF_TOKEN!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;

const ILLUS_CACHE_DIR = path.join(import.meta.dir, "../.cache/illustrations");
mkdirSync(ILLUS_CACHE_DIR, { recursive: true });

const STYLE = `Victorian-era woodcut engraving with detailed cross-hatching. PORTRAIT orientation — taller than wide. Pure black ink lines on pure white background. NO background shading, NO dark fills, NO border, NO frame, NO text or labels. CRITICAL: the object must have a COMPLEX IRREGULAR SILHOUETTE — protruding parts, curves, asymmetry. NOT a rectangle or simple box shape. Think: an hourglass with ornate scrollwork stand, a tree with sprawling branches, a figure holding tools at different angles, a compass with extended arms. The silhouette edge must be interesting and non-rectangular so text can wrap around it. Subject: `;

// Each entry: subject (used for slug + prompt), headline (used for cache key)
const ILLUSTRATIONS = [
  // torvalds W15 opus dispatch — overwrite dark Gemini images
  {
    subject: "a weathered lighthouse beam sweeping across a stormy sea with tall dramatic waves",
    headline: "torvalds-w15-opus-lighthouse",
  },
  {
    subject: "an intricate mechanical clockwork with exposed gears and a winding escapement mechanism",
    headline: "torvalds-w15-opus-clockwork",
  },
  {
    subject: "a Victorian automaton writing with a quill pen at a small wooden writing desk",
    headline: "torvalds-w15-opus-automaton",
  },
  // karpathy W15 opus dispatch — overwrite dark Gemini images
  {
    subject: "a magnifying glass held over a handwritten ledger with ink notes and margin annotations",
    headline: "karpathy-w15-opus-magnifying",
  },
  {
    subject: "a Victorian era town square gazebo with ornate lattice railing and decorative iron scrollwork",
    headline: "karpathy-w15-opus-gazebo",
  },
  {
    subject: "an antique brass stencil set with interchangeable letter plates in a fitted wooden case",
    headline: "karpathy-w15-opus-stencil",
  },
  // DHH W15 opus dispatch — overwrite dark Gemini images
  {
    subject: "a frayed electrical cord with exposed copper wires wrapped around a porcelain insulator",
    headline: "dhh-w15-opus-cord",
  },
  {
    subject: "a Victorian gentleman slumped asleep in an armchair with a pipe and open book on his lap",
    headline: "dhh-w15-opus-sleeping",
  },
  {
    subject: "an ornate grandfather clock with roman numerals and a swinging pendulum in an ornate case",
    headline: "dhh-w15-opus-clock",
  },
  // simonw W15 — overwrite dark Gemini images
  {
    subject: "a cord being unplugged from a wall socket still held in a hand with trailing wire loops",
    headline: "simonw-w15-cord-unplugged",
  },
  {
    subject: "a hand holding a rubber eraser hovering over a sheet of paper with smudged pencil marks",
    headline: "simonw-w15-eraser",
  },
  {
    subject: "a river flowing around a large rock water splitting and rejoining downstream with small rapids",
    headline: "simonw-w15-river",
  },
];

function toSlug(s: string, maxLen = 60): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, maxLen);
}

async function uploadToR2(slug: string, buf: Buffer): Promise<string> {
  const key = encodeURIComponent(`illustrations/${slug}.png`);
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets/${CF_R2_BUCKET}/objects/${key}`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "image/png" },
      body: buf,
    }
  );
  const json = await res.json() as any;
  if (!json.success) throw new Error(`R2 upload failed: ${JSON.stringify(json)}`);
  const publicUrl = `https://gitzette.online/img/${slug}.png`;
  console.log(`  uploaded → ${publicUrl}`);
  return publicUrl;
}

async function threshold(buf: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const cornerSamples = [
    [20,20],[width-20,20],[20,height-20],[width-20,height-20],
    [100,100],[width-100,100],[100,height-100],[width-100,height-100],
  ];
  const darkOpaqueCount = cornerSamples.filter(([x,y]) => {
    const o = (y * width + x) * channels;
    const isOpaque = channels < 4 || data[o + 3] > 20;
    const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    return isOpaque && lum < 100;
  }).length;
  if (darkOpaqueCount >= 6) return null;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const o = i * channels;
    const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (channels >= 4 && data[o + 3] < 20) { data[o + 3] = 0; continue; }
    if (lum > 145) { data[o + 3] = 0; }
    else { data[o] = 15; data[o + 1] = 15; data[o + 2] = 15; data[o + 3] = 255; }
  }
  return sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 8 }).toBuffer();
}

async function generateOne(subject: string, headline: string): Promise<void> {
  const prompt = STYLE + subject;
  const slug = toSlug(subject);
  const cacheSlug = toSlug(headline);
  const cachePath = path.join(ILLUS_CACHE_DIR, `${cacheSlug}.txt`);

  console.log(`\nGenerating: "${headline.slice(0, 60)}..."`);
  console.log(`  slug: ${slug}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        n: 1,
        size: "1024x1024",
        background: "transparent",
        output_format: "png",
      }),
    });
    const data = await res.json() as any;
    if (!data.data?.[0]?.b64_json) {
      console.warn(`  attempt ${attempt + 1} failed: ${JSON.stringify(data).slice(0, 200)}`);
      continue;
    }

    const rawBuf = Buffer.from(data.data[0].b64_json, "base64");
    const processed = await threshold(rawBuf);
    if (!processed) {
      console.warn(`  attempt ${attempt + 1}: dark-bg rejected, retrying...`);
      continue;
    }

    const url = await uploadToR2(slug, processed);
    writeFileSync(cachePath, url, "utf8");
    console.log(`  cache saved → ${cachePath}`);
    console.log(`  ✓ Done: ${url}`);
    return;
  }
  throw new Error(`Failed to generate illustration after 3 attempts: "${subject}"`);
}

async function run(): Promise<void> {
  for (const { subject, headline } of ILLUSTRATIONS) {
    await generateOne(subject, headline);
  }
  console.log("\nAll done.");
}

run().catch(e => { console.error(e); process.exit(1); });
