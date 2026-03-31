/**
 * Shape-wrap pure functions — testable without browser APIs.
 *
 * These compute the contour profile from raw RGBA pixel data and map it
 * to per-line occupied widths for pretext's layoutNextLine.
 */

/**
 * Scan an RGBA pixel buffer row-by-row and return the rightmost opaque
 * x-coordinate for each row (0-based). Returns 0 for fully transparent rows.
 *
 * @param rgba      - Flat RGBA array (4 bytes per pixel), row-major
 * @param width     - Image width in pixels
 * @param height    - Image height in pixels
 * @param threshold - Alpha value above which a pixel is considered opaque (default 10)
 * @returns Array of length `height`, each entry is the rightmost opaque x + 1 (i.e. occupied width in pixels)
 */
export function scanContourProfile(
  rgba: Uint8ClampedArray | number[],
  width: number,
  height: number,
  threshold: number = 10,
): number[] {
  const profile = new Array(height);
  for (let y = 0; y < height; y++) {
    let rightmost = 0;
    const rowOffset = y * width * 4;
    // Scan right-to-left for efficiency — stop at first opaque pixel
    for (let x = width - 1; x >= 0; x--) {
      if (rgba[rowOffset + x * 4 + 3] > threshold) {
        rightmost = x + 1; // occupied width = rightmost x + 1
        break;
      }
    }
    profile[y] = rightmost;
  }
  return profile;
}

/**
 * For a horizontal band of text (one line-height), compute how much display
 * width the image occupies by sampling the contour profile.
 *
 * Takes the max occupied width across all image rows that fall within the band,
 * scales from image-natural to display coordinates, and adds a gap.
 *
 * @param profile       - Per-row occupied widths from scanContourProfile (in natural image pixels)
 * @param bandTopPx     - Top of the text band in display coordinates (px from image top)
 * @param bandBottomPx  - Bottom of the text band in display coordinates
 * @param imgDisplayW   - Rendered width of the image element
 * @param imgDisplayH   - Rendered height of the image element
 * @param imgNaturalW   - Natural width of the image
 * @param imgNaturalH   - Natural height of the image
 * @param gap           - Horizontal gap between image edge and text (px)
 * @returns Occupied width in display px (image + gap), or 0 if band is below image
 */
export function getOccupiedWidthForBand(
  profile: number[],
  bandTopPx: number,
  bandBottomPx: number,
  imgDisplayW: number,
  imgDisplayH: number,
  imgNaturalW: number,
  imgNaturalH: number,
  gap: number = 18,
): number {
  // Band is entirely below the image
  if (bandTopPx >= imgDisplayH) return 0;

  // Map display coordinates to natural image rows
  const scale = imgNaturalH / imgDisplayH;
  const startRow = Math.floor(bandTopPx * scale);
  const endRow = Math.min(
    Math.ceil(Math.min(bandBottomPx, imgDisplayH) * scale),
    profile.length,
  );

  // Find the maximum occupied width across all rows in this band
  let maxNatural = 0;
  for (let row = startRow; row < endRow; row++) {
    if (profile[row] > maxNatural) maxNatural = profile[row];
  }

  if (maxNatural === 0) return 0;

  // Scale from natural image pixels to display pixels, add gap
  const displayWidth = maxNatural * (imgDisplayW / imgNaturalW);
  return Math.round(displayWidth + gap);
}

/**
 * Split an HTML string into alternating text and tag segments.
 * This lets us feed only the text to pretext for measurement, while
 * tracking tag positions so we can reinsert them into output lines.
 *
 * @param html - HTML string (may contain <a>, <code>, etc.)
 * @returns Array of segments with type 'text' or 'tag'
 */
export function splitTextAndTags(
  html: string,
): Array<{ type: "text" | "tag"; content: string }> {
  if (!html) return [];

  const segments: Array<{ type: "text" | "tag"; content: string }> = [];
  const tagRegex = /<\/?[a-zA-Z][^>]*\/?>/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    // Text before the tag
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: html.slice(lastIndex, match.index) });
    }
    // The tag itself
    segments.push({ type: "tag", content: match[0] });
    lastIndex = tagRegex.lastIndex;
  }

  // Trailing text after last tag
  if (lastIndex < html.length) {
    segments.push({ type: "text", content: html.slice(lastIndex) });
  }

  return segments;
}
