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

**Rule: never open with "@author merged #NNN —".** That's the same boilerplate every time. A reader scanning three articles sees the identical sentence structure three times. Lead with the bug, the behavior, the failure mode — then attribute mid-sentence or after. The PR link belongs in the body, not the first word.

- Bad opener: "@cyberdem0n merged #3453 — patroni used to pull the failover trigger..."
- Also bad opener: "#3562 adds proper handling for..." — leading with a PR number is the same problem, just without the author name. The reader doesn't know what #3562 is.
- Also bad opener: "#3569 reorders shutdown sequence..." — same issue.
- Good opener: "Patroni used to pull the failover trigger the moment a heartbeat gap appeared, even fleeting ones. @cyberdem0n's #3453 adds the backoff it needed."
- Good opener: "The Unavailable exception from etcd v3 was propagating uncaught, leaving patroni blind to cluster state. #3562 catches it now."

**The test:** read the first 8 words of every article opener. If any of them start with `#`, `@`, or a PR number — rewrite. Every article must open with a situation, a behavior, or a fact about the software.

**Bad** (no facts, no mechanism):
> @owner merged #123 which fixes a race condition that caused failures.

**Also bad** (accurate but flat and lifeless):
> @owner merged #123 — patroni previously demoted the primary immediately. The new backoff waits before acting.

**Also bad** (boilerplate opener, same first words in every article):
> @owner merged #3453 — [thing]. @owner merged #3562 — [thing]. @owner merged #3563 — [thing].

**Good** (before + mechanism + effect + light voice, leads with the situation):
> Patroni used to pull the failover trigger the moment a heartbeat gap appeared, even fleeting ones. @NikolayS's [#3453](url) adds a primary race backoff — now a 200ms network hiccup doesn't demote your primary. The delay sits in the leader race detection path, buying time before declaring the leader dead.

**One metaphor per article max** — grounded in the actual technical reality, not decoration.

---

## Finding the Angle

Every article needs a hook — the thing that makes a reader pause. Ask: what's surprising, counterintuitive, or reveals something about how the software works that most users don't know?

- A static library build isn't news. The fact that it unlocks embedding ghostty in other apps — that's the angle.
- Nine AUR sync commits aren't news. Skip it or merge it into a one-liner in the closing note.
- VT state persistence sounds dry. The angle: your terminal was silently losing track of escape sequences mid-stream. Now it doesn't.

**If you can't find an angle — the article shouldn't exist.** A quiet week with nothing interesting is better covered by the closing note than by stretching bot-opened PRs into fake articles.

**The entertainment test:** would a senior engineer forward this to a colleague? If the honest answer is "no, it's just a changelog", rewrite or cut.

## What to Ban

- Vague drama: "haunted", "plagued", "for years", "momentarily silent", "in the wild"
- Cute anthropomorphization that trivializes serious work: "learns to count to three"
- Bundling unrelated PRs into one article because they landed the same week
- PENDING articles about open issues in someone else's repo (those aren't the author's news)
- Pure test/CI-only PRs as standalone articles (removing time.sleep, fixing flaky tests) — skip unless only activity that week
- Bot-opened dependency/sync PRs as standalone articles — they're noise, not news
- Padding a quiet week with minor activity articles — better to write fewer, better articles and let the closing note acknowledge the quiet
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

**2026-03-23:**
- DHH W12 was boring: "nine commits keep the package mirror in sync" — bot PR + AUR sync, not real news. Should have been 0 articles with a quiet-week closing note.
- mitchellh W12 was better (real VT state machine content) but still no wit — technically accurate but nobody would forward it.
- Root cause: LLM is optimizing to fill the template rather than find the angle. Added "Finding the Angle" section — if you can't find a hook, don't write the article.

**2026-03-22:**
- First version used LLM copy that rewrote PR titles with dramatic prose ("haunted", "plagued") — no real technical content
- Overcorrected to dry changelog tone — "accurate but flat and lifeless" per review
- Sweet spot: Hacker News voice + before/after explanation
- "counts to three" headline was too cute for HA engineers — they forwarded an eye-roll, not the link
- Illustrations: Gemini 2.5 Flash Image produces psychedelic tangles if style prompt is too vague — need explicit "NO tangled cables, NO swirls"
- LLM was bundling unrelated PRs (threading compat + test cleanup) into one article — fixed with explicit rule
- PENDING articles about open issues in foreign repos are filler — removed
- cyberdem0n W13 review (2026-03-22): all 3 article openers started with "@cyberdem0n merged #XXXX —" — identical boilerplate, feels like a changelog bot. Rule added: lead with the situation/bug, attribute after.
