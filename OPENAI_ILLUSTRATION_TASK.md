# Task: Switch illustration generation to GPT-Image-1 with transparent PNG

## Context
Dispatch generator at `/tmp/gl-dispatch/dispatch/scripts/generate.ts`.
Currently uses `gemini-2.5-flash-image` for illustrations (opaque JPEG/PNG).
We want to switch to `gpt-image-1` which supports transparent PNG natively.

## Goal
`generateIllustration()` should:
1. Use OpenAI Images API (`gpt-image-1`) if `OPENAI_API_KEY` is set
2. Fall back to Gemini if not
3. Output transparent PNG
4. Upload to R2 as `.png`

## OpenAI Images API call
```typescript
const res = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-image-1",
    prompt: "<your prompt>",
    n: 1,
    size: "1024x1024",
    background: "transparent",
    output_format: "png",
  }),
});
const data = await res.json();
// Response: data.data[0].b64_json (base64 PNG)
const buf = Buffer.from(data.data[0].b64_json, "base64");
```

## Illustration prompt style update
For transparent PNG, update the style in `dispatch.config.json` (field: `imageGen.style`):
```
Vintage newspaper engraving illustration, editorial style. Single focal object drawn in fine black ink lines and cross-hatching on a TRANSPARENT background. No background fill, no white box, no color. Pure ink drawing of the subject only. The subject: 
```
(note: subject gets appended by the code)

## Steps
1. Read `scripts/generate.ts`, find `generateIllustration()` function
2. Add OpenAI branch: if `OPENAI_API_KEY` env var present, use GPT-Image-1
3. Keep Gemini as fallback
4. Update `dispatch.config.json` style prompt for transparent/ink style
5. Make sure the upload still goes to R2 as PNG via `uploadIllustrationToR2()`

## Also fix: repo image count
Currently only 1 repo image appears even though 3 are allowed. 
Find `newspaperify()` or wherever repo images are selected — check if there's an off-by-one or early-exit bug limiting it to 1.

## Test
```bash
cd /tmp/gl-dispatch/dispatch
export $(grep -v '^#' .env | xargs)
bun scripts/generate.ts --from 2026-03-23 --to 2026-03-29 --owner NikolayS --no-fetch --no-llm 2>&1 | grep -E "illustration|image|✓|✗|error"
```
Verify: 2 illustration lines showing ✓, and the generated URLs end in `.png`.

## Commit
```bash
cd /tmp/gl-dispatch/dispatch
git add scripts/generate.ts dispatch.config.json
git commit -m "feat: GPT-Image-1 transparent PNG illustrations + fix repo image count"
git push origin main
```

## When done
Run: `openclaw system event --text "Done: GPT-Image-1 transparent PNG illustrations implemented" --mode now`
