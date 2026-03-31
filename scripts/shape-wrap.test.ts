import { describe, test, expect } from "bun:test";
import {
  scanContourProfile,
  getOccupiedWidthForBand,
  splitTextAndTags,
} from "./shape-wrap";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a flat RGBA buffer filled with a single color+alpha. */
function solidRGBA(
  w: number,
  h: number,
  r = 0,
  g = 0,
  b = 0,
  a = 255,
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

/** Set a single pixel's alpha in a flat RGBA buffer. */
function setAlpha(
  buf: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
  a: number,
) {
  buf[(y * w + x) * 4 + 3] = a;
}

/** Set a pixel to fully opaque black. */
function setOpaque(
  buf: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
) {
  const i = (y * w + x) * 4;
  buf[i] = 0;
  buf[i + 1] = 0;
  buf[i + 2] = 0;
  buf[i + 3] = 255;
}

// ── scanContourProfile ───────────────────────────────────────────────────────

describe("scanContourProfile", () => {
  test("fully transparent image → all zeros", () => {
    const rgba = solidRGBA(100, 80, 0, 0, 0, 0); // all transparent
    const profile = scanContourProfile(rgba, 100, 80);
    expect(profile).toHaveLength(80);
    expect(profile.every((v) => v === 0)).toBe(true);
  });

  test("solid opaque rectangle → all equal to width", () => {
    const rgba = solidRGBA(80, 60, 0, 0, 0, 255); // fully opaque
    const profile = scanContourProfile(rgba, 80, 60);
    expect(profile).toHaveLength(60);
    expect(profile.every((v) => v === 80)).toBe(true);
  });

  test("triangle contour — right edge narrows toward bottom", () => {
    // 100x100, transparent background
    const w = 100,
      h = 100;
    const rgba = solidRGBA(w, h, 0, 0, 0, 0);
    // Fill a right-leaning triangle: row y has opaque pixels from x=0 to x=(99 - y)
    for (let y = 0; y < h; y++) {
      const rightEdge = 99 - y; // row 0: x=0..99, row 99: x=0..0
      for (let x = 0; x <= rightEdge; x++) {
        setOpaque(rgba, w, x, y);
      }
    }
    const profile = scanContourProfile(rgba, w, h);
    expect(profile).toHaveLength(100);
    // Row 0: rightmost opaque at x=99 → occupied = 100
    expect(profile[0]).toBe(100);
    // Row 50: rightmost opaque at x=49 → occupied = 50
    expect(profile[50]).toBe(50);
    // Row 99: rightmost opaque at x=0 → occupied = 1
    expect(profile[99]).toBe(1);
    // Profile is strictly decreasing
    for (let y = 1; y < h; y++) {
      expect(profile[y]).toBeLessThan(profile[y - 1]);
    }
  });

  test("circle contour — wider in middle, narrower at top/bottom", () => {
    const w = 100,
      h = 100;
    const cx = 50,
      cy = 50,
      r = 40;
    const rgba = solidRGBA(w, h, 0, 0, 0, 0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx,
          dy = y - cy;
        if (dx * dx + dy * dy <= r * r) {
          setOpaque(rgba, w, x, y);
        }
      }
    }
    const profile = scanContourProfile(rgba, w, h);
    // Rows outside circle (top and bottom) should be 0
    expect(profile[0]).toBe(0); // y=0: outside circle
    expect(profile[9]).toBe(0); // y=9: outside circle (cy-r=10)
    // Row at center should be widest
    expect(profile[50]).toBeGreaterThan(profile[15]);
    // Symmetric: top and bottom should be roughly equal
    expect(Math.abs(profile[20] - profile[80])).toBeLessThanOrEqual(1);
  });

  test("alpha threshold filtering — low alpha treated as transparent", () => {
    const w = 10,
      h = 5;
    const rgba = solidRGBA(w, h, 0, 0, 0, 0);
    // Row 0: pixel at x=9 with alpha=5 (below default threshold 10)
    setAlpha(rgba, w, 9, 0, 5);
    // Row 1: pixel at x=9 with alpha=20 (above threshold)
    setOpaque(rgba, w, 9, 1);
    setAlpha(rgba, w, 9, 1, 20);

    const profile = scanContourProfile(rgba, w, h, 10);
    expect(profile[0]).toBe(0); // alpha=5 < 10 → transparent
    expect(profile[1]).toBe(10); // alpha=20 > 10 → opaque, rightmost at x=9 → width=10
  });

  test("single pixel at right edge is detected", () => {
    const w = 100,
      h = 50;
    const rgba = solidRGBA(w, h, 0, 0, 0, 0);
    setOpaque(rgba, w, 99, 25); // single pixel at far right, row 25
    const profile = scanContourProfile(rgba, w, h);
    expect(profile[25]).toBe(100); // rightmost at x=99 → width=100
    expect(profile[24]).toBe(0); // adjacent rows still 0
    expect(profile[26]).toBe(0);
  });
});

// ── getOccupiedWidthForBand ──────────────────────────────────────────────────

describe("getOccupiedWidthForBand", () => {
  test("band within image → returns scaled max + gap", () => {
    // Profile: 100px natural image, each row occupied 80px
    const profile = new Array(100).fill(80);
    const result = getOccupiedWidthForBand(
      profile,
      0, // bandTopPx (display)
      25, // bandBottomPx (display)
      200, // imgDisplayW (scaled 2x)
      200, // imgDisplayH (scaled 2x)
      100, // imgNaturalW
      100, // imgNaturalH
      18, // gap
    );
    // Max natural occupied = 80. Scaled: 80 * (200/100) = 160. Plus gap: 178
    expect(result).toBe(178);
  });

  test("band beyond image height → returns 0", () => {
    const profile = new Array(100).fill(80);
    const result = getOccupiedWidthForBand(
      profile,
      250, // beyond imgDisplayH=200
      275,
      200,
      200,
      100,
      100,
      18,
    );
    expect(result).toBe(0);
  });

  test("band partially overlapping image bottom → uses available rows", () => {
    // 100-row image displayed at 200px height. Band at display y=190..210 overlaps rows 95-100.
    const profile = new Array(100).fill(0);
    profile[95] = 50;
    profile[96] = 60;
    profile[97] = 40;
    profile[98] = 30;
    profile[99] = 20;
    const result = getOccupiedWidthForBand(
      profile,
      190,
      210,
      200,
      200,
      100,
      100,
      18,
    );
    // Rows 95-99 in natural coords. Max = 60. Scaled: 60 * (200/100) = 120. Plus gap: 138
    expect(result).toBe(138);
  });

  test("band with varying contour → takes maximum", () => {
    // Profile varies: [10, 50, 30, 80, 20, ...]. Band spans rows 0-4.
    const profile = [10, 50, 30, 80, 20];
    // Display=natural (1:1 scale), 5px image
    const result = getOccupiedWidthForBand(
      profile,
      0,
      5,
      5, // imgDisplayW
      5, // imgDisplayH
      5, // imgNaturalW
      5, // imgNaturalH
      10, // gap
    );
    // Max = 80. Scaled: 80 * (5/5) = 80. Plus gap: 90
    expect(result).toBe(90);
  });

  test("fully transparent band → returns 0 (no gap added)", () => {
    const profile = new Array(100).fill(0);
    const result = getOccupiedWidthForBand(
      profile,
      0,
      25,
      200,
      200,
      100,
      100,
      18,
    );
    expect(result).toBe(0);
  });
});

// ── splitTextAndTags ─────────────────────────────────────────────────────────

describe("splitTextAndTags", () => {
  test("plain text — no HTML tags", () => {
    const result = splitTextAndTags("Hello world");
    expect(result).toEqual([{ type: "text", content: "Hello world" }]);
  });

  test("text with inline link and code", () => {
    const result = splitTextAndTags(
      'See <a href="#">this PR</a> and <code>config.ts</code> for details',
    );
    expect(result).toEqual([
      { type: "text", content: "See " },
      { type: "tag", content: '<a href="#">' },
      { type: "text", content: "this PR" },
      { type: "tag", content: "</a>" },
      { type: "text", content: " and " },
      { type: "tag", content: "<code>" },
      { type: "text", content: "config.ts" },
      { type: "tag", content: "</code>" },
      { type: "text", content: " for details" },
    ]);
  });

  test("adjacent tags with no text between", () => {
    const result = splitTextAndTags("<b><i>bold italic</i></b>");
    expect(result).toEqual([
      { type: "tag", content: "<b>" },
      { type: "tag", content: "<i>" },
      { type: "text", content: "bold italic" },
      { type: "tag", content: "</i>" },
      { type: "tag", content: "</b>" },
    ]);
  });

  test("empty string → empty array", () => {
    const result = splitTextAndTags("");
    expect(result).toEqual([]);
  });

  test("self-closing tags", () => {
    const result = splitTextAndTags("line one<br/>line two");
    expect(result).toEqual([
      { type: "text", content: "line one" },
      { type: "tag", content: "<br/>" },
      { type: "text", content: "line two" },
    ]);
  });

  test("preserves tag attributes", () => {
    const result = splitTextAndTags(
      '<a href="https://example.com" class="link">click</a>',
    );
    expect(result).toEqual([
      {
        type: "tag",
        content: '<a href="https://example.com" class="link">',
      },
      { type: "text", content: "click" },
      { type: "tag", content: "</a>" },
    ]);
  });
});
