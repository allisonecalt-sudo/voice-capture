# Voice Capture

**WHAT:** A one-screen phone app: tap a big button to record a voice dump, it transcribes
the audio with Google Gemini, you edit the transcript and copy it to paste into Claude.
That is the whole flow — no database, no auto-upload, no routing, no login.

**WHY:** Allison loses long voice dumps when a keyboard mic silently stops recording. This
app makes "it's recording" **impossible to miss** — a running `mm:ss` timer, a pulsing
record button, and a live waveform — so she never again talks for ten minutes into a dead mic.

**DECIDED (do not re-litigate):**

- **No backend, no DB, no Supabase.** Pure static site (TS → `dist/`, served as files).
- **Gemini key lives in `localStorage` only** (device-only). Never hardcoded, never committed,
  never logged. It travels only from her phone straight to Google's API.
- **Audio = 16 kHz mono WAV encoded in-browser** (see `wav.ts`), sent as `audio/wav`.
  Gemini's documented MIME types include wav but **not** `audio/webm` (Android Chrome's
  MediaRecorder default), so we never rely on webm.
- **Model:** `gemini-2.0-flash` (fast, free-tier, strong multilingual).
- **Transcript prompt:** verbatim, language-preserving (keep Hebrew Hebrew, English English,
  no translation), transcript-only output.

**BUILT:**

- `index.html` / `styles.css` — RTL shell, calm dark UI, big touch targets.
- `app.ts` — state machine (idle → recording → transcribing → result + settings),
  Web Audio capture, timer/pulse/waveform, copy-to-clipboard.
- `wav.ts` — PCM → 16 kHz mono WAV encoder + base64 helper.
- `gemini.ts` — the `generateContent` request + response parser.
- `sw.js` + `manifest.webmanifest` + icons — installable PWA (shell cached; Gemini always live).
  Also a **Web Share Target**: a voice note shared INTO the app (e.g. from WhatsApp) POSTs to
  `./share-target`; the SW catches it, parks the file in a cache, and redirects to `?shared=1`,
  which `app.ts` (`ingestSharedAudio`) reads back and transcribes via the same path as a recording.
- `tests/app.spec.ts` — Playwright, fully mocked (no real mic / key / API).
- `.github/workflows/ci.yml` — lint → build → test.

**NEXT:** v0 is complete. A public GitHub repo + GitHub Pages deploy is a **separate
confirmed step** (not done here). If long dumps become routine, add the Gemini File API
upload path (currently inline-only).

---

## How Allison uses it

1. Open the app. First time, it asks for a **Gemini API key** — get a free one at
   [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), paste it in
   Settings, Save. (Stored only on your phone.)
2. Tap the big **הקלטה / Record** button. You'll see a red **REC** pill, a running `mm:ss`
   timer, and a moving waveform — that's your proof the mic is on.
3. Tap **עצירה / Stop** when done. It sends the audio to Gemini and shows a spinner.
4. The transcript appears in an editable box. Fix anything you want.
5. Tap **Copy** (it says "Copied ✓"), then paste into Claude.

### Or: share a WhatsApp voice note (no recording)

1. In WhatsApp, **long-press** the voice note → **Share** → pick **Voice Capture**.
2. The app opens, transcribes it automatically, and (like a recording) saves it to the inbox.
   _Note: the share target only appears once the PWA is installed and opened at least once after
   this update; needs a network connection to transcribe._

## Limits

- **Recordings up to ~10 minutes.** Inline audio has a request-size ceiling; a 16 kHz mono
  WAV is ~1.9 MB/min, so the app warns you past ~10 min and auto-stops at 12 min to protect
  the request. For longer dumps, stop and send, then start a new one.
- **Needs a network connection** to transcribe (the app shell itself works offline).

## Dev

```bash
npm install
npm run build          # tsc → dist/
npm run lint           # eslint
npm run format:check   # prettier
npm test               # playwright (headless, fully mocked)
npm run serve          # serve at http://localhost:3100
npm run rasterize-icons  # regenerate PNG icons from the SVGs
```
