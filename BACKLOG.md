# Voice-capture BACKLOG — parked deliberately, with reasons

**What this is:** upgrades + open tensions from the 2026-07-17 QA sweep (90 agents) and the
2026-07-20 v34 fix-everything round, parked here so they stay pullable. v34 shipped every
QA-confirmed BUG + the privacy fix + recording auto-split; these are the extras she has NOT
asked for yet. Her rule: ship lean; defer loudly.
**Decided (v34, her calls):** archive-everywhere per tab · auto-split long recordings (keep the
12-min ceiling) · README/doc drift fixed. Fix depth was "D — everything" (bugs only, not extras).

## Parked upgrades (recommended by the sweep, small, awaiting her word)

- **Share target that survives a dead service worker** (2026-08-26 — HER CALL, has a real cost)
  — the share-in path POSTs to `./share-target`, and GitHub Pages answers any POST with a bare
  "405 Not Allowed", so the service worker is the only thing that can catch it. Shipped that day:
  v34.3 persistent storage (Android stops evicting the worker) + v34.3b self-heal (an eviction is
  detected on next open and announced, never silent). That is the **ceiling on GitHub Pages**.

  **An edge-function share target was offered and is NOT BUILDABLE** — checked after offering it,
  which was the wrong order. The Web Share Target spec pins `action` inside the manifest's own
  scope: _"If action is not within scope of scope URL, issue a developer warning that action is
  outside of the navigation scope, and return undefined"_
  ([spec](https://w3c.github.io/web-share-target/level-2/)). Out of scope = the whole
  `share_target` is discarded and the app stops being a share target at all. The POST can never
  be aimed at another origin.

  **The only real fix is a host that accepts POST — now BUILT, NOT SWITCHED ON.**
  `functions/share-target.js` (Cloudflare Pages Function) + `_routes.json` + 5 tests are in the
  repo and green; the function is inert while GitHub Pages serves the app, so it changed nothing
  about the current deploy. Step-by-step in `MIGRATION-cloudflare.md`.
  What is left needs HER login and only hers: create the Cloudflare account, connect the repo.
  The cost is a NEW ORIGIN — reinstall the PWA, re-enter the Gemini key, log in again; her notes
  are safe in Supabase and re-sync, but any recording still pending on the phone is lost. Worth
  pairing with a custom domain so it is the LAST origin move. GitHub Pages keeps running
  throughout, so it rolls back by just re-installing the old icon.

  **Correction on the stated damage:** this was first written up as "Aug 21 → Aug 26 = five days
  of captures lost." The live table does not support that — her real gaps between capture days
  were 1, 2, 5, 8, 8, 10 (median 6.5d, longest 10d), so a 5-day gap is INSIDE normal. The 405 was
  real and reproducible; the loss figure was inference, not evidence. What actually justifies the
  work is that the failure was **invisible**, not that five days were provably lost.

- **Persist the half-typed compose draft** — a glance away currently blanks a half-typed thought.
- **Recording-Cancel gets an Undo (or moves away from Stop)** — the one destructive action
  without the Undo net; a one-handed mis-tap kills a long dump.
- **"✓ Claude saw it" receipt on her own captures** — replies already show read receipts; a plain
  brain-dump just says Saved. Only ever show "seen" when genuinely true.
- **Version-tag CI check** — one assert so APP_VERSION / BUILD_DATE / sw VERSION can't drift
  (three hand-synced constants across 34+ deploys).
- **"✓ Notifications on" self-check** — v34 made the button re-tappable; a real self-heal would
  verify the server row on Settings open.

## Open tensions (HER calls, not made — do not resolve without her)

- **Keep capture audio so Claude can re-hear a garbled name?** Today audio is deleted after
  transcription; "flag garbled, don't guess" can't re-listen. For: closes the loop, tandem-readable.
  Against: storage growth, raw audio at rest is more sensitive than text, cuts against ship-lean.
- **Split the 103KB app.ts?** Lean: don't big-bang it — peel a module only when already in that code.

## Accepted residuals (known, documented, not bugs to re-report)

- **Consumed-then-deleted reply can be re-inserted by a retry** whose original response was lost
  (no client-side tombstone can distinguish it from never-landed). Rare double-fault; worst case a
  session re-reads a reply; no note loss. Documented in supabase.ts saveCapture.
- **Shared (non-WAV) clips over the size cap can't be split** — they fail loudly with the
  Save-file escape. WhatsApp voice notes are near-always far below the cap.
