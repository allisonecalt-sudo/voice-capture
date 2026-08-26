# Voice-capture BACKLOG — parked deliberately, with reasons

**What this is:** upgrades + open tensions from the 2026-07-17 QA sweep (90 agents) and the
2026-07-20 v34 fix-everything round, parked here so they stay pullable. v34 shipped every
QA-confirmed BUG + the privacy fix + recording auto-split; these are the extras she has NOT
asked for yet. Her rule: ship lean; defer loudly.
**Decided (v34, her calls):** archive-everywhere per tab · auto-split long recordings (keep the
12-min ceiling) · README/doc drift fixed. Fix depth was "D — everything" (bugs only, not extras).

## Parked upgrades (recommended by the sweep, small, awaiting her word)

- **Share target that survives a dead service worker** (added 2026-08-26, ~1hr, NOT small) — the
  share-in path POSTs to `./share-target`, and GitHub Pages answers any POST with a bare
  "405 Not Allowed". Today only the SW stands between her and that page. v34.3 requested
  persistent storage so Android stops evicting the worker, but that is hardening, not a fix — a
  manual "clear site data" still wipes it. Real fix: move the share target to a Supabase edge
  function that can actually receive the POST, park the file, and redirect into the app. Her call,
  offered and deferred 2026-08-26.
  **The failure mode is the reason this matters:** it is SILENT. Aug 21 → Aug 26 = five days of
  shared captures lost with no signal; she found it only by hitting the 405 herself.
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
