# Moving the app to Cloudflare Pages — the real fix for the 405

**Status: BUILT, NOT SWITCHED ON.** Everything in the repo is ready. Nothing has moved.
The app is still on GitHub Pages and still works exactly as it does today.
The last step needs your login, so it's yours to take — or not.

---

## What this fixes

Sharing a WhatsApp voice note into the app sends it as a POST. GitHub Pages is a static
host: it answers **every** POST with a bare `405 Not Allowed`. The only reason share-in
ever worked is that the service worker caught the POST before it left the phone.

So when Android evicted the service worker (2026-08-26), share-in died.

Two fixes already shipped and are live on GitHub Pages:

- **v34.3** — asks Chrome for persistent storage, so Android stops evicting the worker.
- **v34.3b** — if it gets evicted anyway, the app notices on next open, repairs itself,
  and tells you instead of failing silently.

That is the ceiling on GitHub Pages. Both make the break rarer and louder. **Neither
removes it** — a manual "clear site data" still wipes the worker, and until you next open
the app, share-in is dead.

Cloudflare Pages removes it, because a Cloudflare Pages Function can actually receive the
POST. Worker alive → the worker handles it (fast, no network). Worker gone → the server
handles it. There is no longer a state where sharing dies.

**Why not just point the share at a Supabase edge function?** Not allowed. The Web Share
Target spec requires the share URL to sit inside the app's own scope, and an out-of-scope
URL makes the browser discard the share target completely — the app would stop appearing
in Android's share sheet at all. Whoever serves the app has to handle the POST. That is
why this is a hosting change and not a small patch.

---

## What it costs you

**A new web address.** Today: `allisonecalt-sudo.github.io/voice-capture`.
After: something like `voice-capture.pages.dev`.

A new address means the browser treats it as a different site, so this does not come along:

| Thing                          | What happens                                                 |
| ------------------------------ | ------------------------------------------------------------ |
| Your Gemini key                | Re-enter it once in Settings. Claude has a copy on your PC.  |
| Your login                     | Log in once. Same email and password.                        |
| Your notes                     | **Safe.** They live in Supabase and re-sync when you log in. |
| On-phone note history          | Rebuilds from Supabase after you log in.                     |
| A recording still in "pending" | Lost. Check the app is empty before you switch.              |
| The installed app icon         | Remove it, then re-install from the new address.             |

**Do this once and never again:** put a custom domain on it while you're there. Then the
address is yours, and you can move hosts any time in the future for free.

---

## The steps

Roughly 15 minutes.

1. Go to **dash.cloudflare.com** → sign up (free).
2. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Authorize GitHub, pick the **voice-capture** repo.
4. Build settings — leave everything blank:
   - Framework preset: **None**
   - Build command: **(blank)**
   - Build output directory: **/**
5. **Save and Deploy.** You get a `*.pages.dev` address.
6. Open the new address on your phone → log in → paste your Gemini key → install to home
   screen.
7. **Test the actual thing:** share a WhatsApp voice note into it. It should transcribe.
8. Only once that works: delete the old home-screen icon.

Nothing in the repo needs editing. Every path in the manifest is already relative, so it
works at the root of a new domain unchanged. `functions/share-target.js` starts working
the moment Cloudflare serves it, and `_routes.json` keeps every other request on the
static path.

---

## If it goes wrong

GitHub Pages keeps running the whole time — this doesn't turn it off. Re-install from the
old address and you're back exactly where you started. Nothing is deleted, nothing is
one-way.

---

## What's already in the repo

- `functions/share-target.js` — the server-side receiver. Reads the shared file and hands
  it to the app through the exact same cache slot the service worker uses, so the app's
  own `ingestSharedAudio()` needed zero changes. Inert on GitHub Pages.
- `_routes.json` — only `/share-target` runs the function; everything else stays static.
- `tests/share-target.spec.ts` — 5 tests: bytes survive the round trip, the cache key
  can't drift away from `sw.js`, a file-less share bounces into the app instead of
  erroring, a GET is a redirect and never a 405, and a hostile filename can't break out
  of the page.
