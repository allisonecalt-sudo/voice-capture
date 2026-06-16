# Brain Dump (voice-capture)

**WHAT:** A one-screen phone app that is Allison's **door to Claude** — a place to fire off a
current thought. Open it and you're on a compose screen with one bar: **type** a thought and tap
**send**, or tap the **mic** to speak it. Typed thoughts go straight to her Claude inbox; voice
notes transcribe first and she chooses **Save** or **Discard**. A minimal **Log** lists what she
saved; **Settings** holds the (voice-only) Gemini key.

**WHY:** This is modelled on how she fires notes into WhatsApp-to-self and brings them to Claude.
It's a brain-dump channel for **current thoughts** — _not_ a to-do tracker. Capture must be
frictionless and never lost; Claude reads the inbox and routes each item to its real home.

**DECIDED (do not re-litigate):**

- **Compose-first.** The home screen IS the compose field (Drafts pattern). No dashboard, no
  "new note" step.
- **One morphing action button** (WhatsApp/Telegram pattern): 🎤 **mic** when the field is empty,
  ➤ **send** the moment she types. Same position, never two competing buttons.
- **Typing needs no key.** Only voice transcription uses the Gemini key (localStorage, device-only).
- **Voice is opt-in to save.** A transcript drops into an editable field; she taps **Save to Claude**
  or **Discard**. A mishear is fixable before saving. (Voice-to-text can hallucinate proper nouns;
  this gate is deliberate.)
- **Captures land in Supabase `voice_captures`** (project `hpiyvnfhoqnnnotrmwaz`), tagged
  `source = 'text' | 'voice'`. **Anon RLS is INSERT-ONLY** — the phone writes, only Claude's service
  key reads. No login, no friction; transcripts aren't publicly readable.
- **Calm dark UI, one accent, few surfaces** (compose ↔ log ↔ settings) — the workout-tracker /
  budget-2026 north star. English chrome; content fields use `dir="auto"` for Hebrew/English mixing.
- **Web Share Target:** a WhatsApp voice note shared into the app (long-press → Share → Brain dump)
  POSTs to `./share-target`; the service worker catches it, parks the file in a cache, and redirects
  to `?shared=1`, which transcribes it through the same record→review path.

**BUILT:**

- `index.html` / `styles.css` — calm dark shell, token-based theme, big thumb-reach compose bar.
- `app.ts` — state machine (`compose → recording → transcribing → review`, plus `log` / `settings`),
  Web Audio capture, morphing compose action + auto-grow, voice Save/Discard, Log (copy/delete/
  clear-all), Settings, share-target ingest, local-first history + deferred Supabase sync.
- `wav.ts` — PCM → 16 kHz mono WAV encoder + base64 helper.
- `gemini.ts` — the `generateContent` transcription request + parser (model `gemini-2.5-flash`).
- `history.ts` — localStorage log + Supabase sync retry. `supabase.ts` — insert-only `saveCapture`.
- `sw.js` + `manifest.webmanifest` + icons — installable PWA (shell cached; Gemini always live;
  Web Share Target).
- `tests/app.spec.ts` — Playwright, fully mocked (no real mic / key / API; never writes prod).
- `.github/workflows/ci.yml` — lint → build → test.

**NEXT:** hardware back-button integration and a delete-undo toast are deliberate future polish.

---

## How Allison uses it

1. **First time:** voice needs a free **Gemini API key** —
   [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) → Settings → paste →
   Save. (Stored only on this phone. Typing works without it.)
2. **Type a thought** → tap the blue **send** (➤). It's in your Claude inbox. The field clears,
   ready for the next thought.
3. **Speak a thought** → tap the **mic** (🎤) → a recording strip shows a live timer + waveform →
   tap **Stop & transcribe** → the transcript appears, editable → **Save to Claude** or **Discard**.
4. **Or share from WhatsApp:** long-press a voice note → **Share** → **Brain dump** → it transcribes
   into the review screen; Save or Discard.
5. **Log** (🗒️ top-right) shows everything you saved, newest first, with copy / delete / clear-all.

## Limits

- **Recordings up to ~10 minutes** (inline audio request-size ceiling; warns past ~10 min,
  auto-stops at 12). For longer dumps, stop and send, then start a new one.
- **Needs a network connection** to transcribe or send (the app shell works offline; saved notes
  sync when you're back online).

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
