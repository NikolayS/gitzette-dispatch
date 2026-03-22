# Gitzette Dispatch — Editorial Style Guide

This file defines the voice, standards, and hard rules for generated dispatches.
**The generator reads this file at runtime.** Edit here to change output — no code changes needed.

---

## Voice

Think: a senior engineer who writes well. Not a marketer. Not a release notes bot.

The target reader runs this software in production. They can read commit messages. They need context and judgment, not PR titles with adjectives added.

Reference tone: a good Hacker News comment written by someone who actually read the code. Sharp, specific, occasionally dry — but never cute at the expense of accuracy.

---

## Headlines

**Rule: vary the structure.** Do not write every headline as "[project] [verb]s [noun]". Mix:
- Consequence-first: "a 200ms blip was enough to lose a primary — not anymore"
- Observation: "the backoff patroni needed to stop over-eager failovers"
- Mechanism: "etcd v3's Unavailable exception now lands somewhere safe"
- Question (sparingly): "what happens when the thread pool shuts down too early?"

**Rule: name the mechanism, not just the outcome.**
- Bad: "patroni prevents false failovers"
- Bad: "patroni learns to count to three before pulling the failover trigger" ← too cute, engineers roll their eyes
- Good: "the backoff patroni needed to stop over-eager failovers"

**Rule: sentence case only.** No Title Case.

---

## Body Copy

Every article body must answer three questions:
1. What was the situation before?
2. What specifically changed?
3. What is the effect?

**Bad** (no facts, no mechanism):
> @owner merged #123 which fixes a race condition that caused failures.

**Also bad** (accurate but flat and lifeless):
> @owner merged #123 — patroni previously demoted the primary immediately. The new backoff waits before acting.

**Good** (before + mechanism + effect + light voice):
> @owner merged [#3453](url) — patroni used to pull the failover trigger the moment a heartbeat gap appeared, even fleeting ones. The new primary race backoff waits out the gap before acting, so a 200ms network hiccup doesn't demote your primary. The fix sits in the leader race detection path, adding delay before declaring the leader dead.

**One metaphor per article max** — grounded in the actual technical reality, not decoration.

---

## What to Ban

- Vague drama: "haunted", "plagued", "for years", "momentarily silent", "in the wild"
- Cute anthropomorphization that trivializes serious work: "learns to count to three"
- Bundling unrelated PRs into one article because they landed the same week
- PENDING articles about open issues in someone else's repo (those aren't the author's news)
- Pure test/CI-only PRs as standalone articles (removing time.sleep, fixing flaky tests) — skip unless only activity that week
- Inventing class names, method names, or configuration keys not present in the data

---

## Stats

- Commits, PRs, releases: show these — they're meaningful signals of activity
- Lines of code / additions / deletions: never show — meaningless metric, engineers know it
- Star counts: fine to show as relative popularity signal

---

## Illustrations

Style: vintage newspaper engraving, 1920s editorial. Soft ink wash, fine cross-hatching, warm gray midtones. Not harsh pure black/white contrast. Aged newsprint feel.

Subject rules:
- ONE clear focal object or scene — simple, readable at small size
- Good: "a hand turning a large gear", "two server towers facing each other", "a padlock on a stack of disks"
- Bad: tangled cables, complex network diagrams, abstract patterns, psychedelic swirls
- No text, words, labels, signs, or numbers anywhere in the image

When to illustrate:
- LLM picks at most 2 articles per dispatch that most benefit visually
- Lead story (h1) usually gets one
- Abstract tooling / pending work benefits more than releases (which often have README screenshots)

---

## What Good Looks Like

Reference dispatch: https://gitzette.online/cyberdem0n/2026-W13 (March 22, 2026)

Headlines from that dispatch:
- "the backoff patroni needed to stop over-eager failovers" ✓
- "etcd v3 stops throwing patroni into the dark" ✓
- "global thread pool now survives shutdown in the right order" ✓
- "python 3.11+ threading changes no longer trip patroni" ✓

What makes them work: varied structure, specific mechanism, no cute wordplay that undermines the technical seriousness.

---

## Lessons Learned (append as we go)

**2026-03-22:**
- First version used LLM copy that rewrote PR titles with dramatic prose ("haunted", "plagued") — no real technical content
- Overcorrected to dry changelog tone — "accurate but flat and lifeless" per review
- Sweet spot: Hacker News voice + before/after explanation
- "counts to three" headline was too cute for HA engineers — they forwarded an eye-roll, not the link
- Illustrations: Gemini 2.5 Flash Image produces psychedelic tangles if style prompt is too vague — need explicit "NO tangled cables, NO swirls"
- LLM was bundling unrelated PRs (threading compat + test cleanup) into one article — fixed with explicit rule
- PENDING articles about open issues in foreign repos are filler — removed
