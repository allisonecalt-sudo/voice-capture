// app.ts — Brain Dump (voice-capture) main controller
// WHAT: a compose-first capture app. The home screen IS a compose field with a single
//       morphing action button: when the field is EMPTY it's a 🎤 mic (tap → record →
//       transcribe → keep-or-toss); the moment she types it becomes a ➤ send (tap → the
//       typed thought is fired straight to her Claude inbox). A minimal Log lists what
//       she's saved; Settings holds the Gemini key (voice only).
// WHY:  this app is her "door to Claude" — a brain-dump channel for CURRENT THOUGHTS, modelled
//       on how she fires notes into WhatsApp-to-self and brings them to Claude. Two truths shaped
//       this rebuild (her words, 2026-06-16): "it's not really where i track my to-do list… it's
//       just like current thoughts", and voice notes are "more for just transcribing" → voice is
//       OPT-IN to save (Save/Discard), typed text is the trustworthy stream and sends on tap.
// DECIDED: compose-first (Drafts pattern); ONE morphing bar (WhatsApp/Telegram pattern: mic when
//          empty, send when typed); typing needs NO key (only voice does); voice transcript drops
//          into an editable field so a mishear is fixable before Save; calm dark theme, ONE accent,
//          few surfaces (compose ↔ log ↔ settings), no tabs/FAB/tag-trees. Captures land in the
//          Supabase voice_captures inbox (anon INSERT-only) tagged source='text'|'voice'; Claude
//          reads + routes server-side. Web Share Target (a WhatsApp voice note shared in) is kept
//          and funnels into the same record→review path.
// BUILT:  state machine + render(), AudioRecorder (getUserMedia → 16 kHz mono WAV), Gemini call,
//          compose bar w/ morphing action + auto-grow, voice Save/Discard review, Log (copy/delete/
//          clear-all), Settings, share-target ingest, local-first history + deferred Supabase sync.
// NEXT:   hardware back-button integration + delete-undo are deliberate future polish.

import { transcribeAudio } from './gemini.js';
import {
  TARGET_SAMPLE_RATE,
  downsampleBuffer,
  mergeChunks,
  encodeWav,
  blobToBase64,
} from './wav.js';
import { addCapture, clearHistory, deleteCapture, loadHistory, syncPending } from './history.js';

// ── Constants ───────────────────────────────────────────────────────────────

const KEY_STORAGE = 'voice-capture.gemini-key';
// Inline base64 ceiling. A 16 kHz mono 16-bit WAV is ~1.9 MB/min and Gemini's inline cap is
// ~20 MB; we nudge to stop at 10 min and hard-stop at 12 to protect the request.
const SOFT_LIMIT_SECONDS = 10 * 60;
const HARD_LIMIT_SECONDS = 12 * 60;
const WAVEFORM_BARS = 28;

// Web Share Target hand-off — must match the names the service worker uses in handleShareTarget.
const SHARE_CACHE = 'voice-capture-share';
const SHARE_ITEM_KEY = 'shared-audio';

type Screen = 'compose' | 'recording' | 'transcribing' | 'review' | 'log' | 'settings';

interface AppState {
  screen: Screen;
  draft: string; // compose textarea text, kept across renders so a re-render never loses it
  elapsedSeconds: number; // recording timer
  transcript: string; // voice transcript currently under review
  reviewDuration: number; // length (s) of the recording under review, for the saved row
  error: string | null;
  levels: number[]; // 0..1 amplitude history for the live waveform
  copiedId: string | null; // which Log row last flashed "Copied ✓"
  confirmingClear: boolean; // Log: "Clear all" is armed (two-tap guard)
}

const state: AppState = {
  screen: 'compose',
  draft: '',
  elapsedSeconds: 0,
  transcript: '',
  reviewDuration: 0,
  error: null,
  levels: new Array(WAVEFORM_BARS).fill(0),
  copiedId: null,
  confirmingClear: false,
};

// ── Key storage (localStorage only, device-only) ─────────────────────────────

function getKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE)?.trim() ?? '';
  } catch {
    return '';
  }
}

function setKey(value: string): void {
  try {
    if (value.trim()) localStorage.setItem(KEY_STORAGE, value.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private-mode / storage-disabled: the no-key state simply persists, which is honest.
  }
}

function hasKey(): boolean {
  return getKey().length > 0;
}

// ── Audio recorder (Web Audio → PCM → 16 kHz mono WAV) ───────────────────────

class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private inputSampleRate = 44100;
  /** Called every audio frame with a 0..1 amplitude for the live waveform. */
  onLevel: ((level: number) => void) | null = null;

  async start(): Promise<void> {
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new Ctx();
    this.inputSampleRate = this.audioContext.sampleRate;
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but universally supported on Android Chrome and needs
    // no worklet file — fine for a capture-only app.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      const input = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input)); // copy — the audio thread reuses the buffer
      if (this.onLevel) this.onLevel(rms(input));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination); // ScriptProcessor only fires when connected
  }

  /** Stop capture, free the mic, and return a 16 kHz mono WAV blob. */
  async stop(): Promise<Blob> {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
    }
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.audioContext) await this.audioContext.close();
    const merged = mergeChunks(this.chunks);
    const downsampled = downsampleBuffer(merged, this.inputSampleRate, TARGET_SAMPLE_RATE);
    this.chunks = [];
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    return encodeWav(downsampled, TARGET_SAMPLE_RATE);
  }

  abort(): void {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
    }
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.audioContext) void this.audioContext.close();
    this.chunks = [];
  }
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const r = Math.sqrt(sum / buf.length);
  return Math.min(1, r * 4); // light gain so quiet speech still moves the bars
}

// ── Recording lifecycle ──────────────────────────────────────────────────────

let recorder: AudioRecorder | null = null;
let timerId: number | null = null;
let recordingStartMs = 0;

async function beginRecording(): Promise<void> {
  state.error = null;
  state.transcript = '';
  state.levels = new Array(WAVEFORM_BARS).fill(0);

  recorder = new AudioRecorder();
  recorder.onLevel = (level: number): void => {
    state.levels.push(level);
    if (state.levels.length > WAVEFORM_BARS) state.levels.shift();
    updateLiveMeters();
  };

  try {
    await recorder.start();
  } catch (err) {
    recorder = null;
    state.error = 'Could not access the microphone. Check the browser has mic permission.';
    state.screen = 'compose';
    render();
    showToast('Mic blocked');
    console.warn('[brain-dump] mic error:', err);
    return;
  }

  state.screen = 'recording';
  state.elapsedSeconds = 0;
  recordingStartMs = Date.now();
  render();

  timerId = window.setInterval(() => {
    state.elapsedSeconds = Math.floor((Date.now() - recordingStartMs) / 1000);
    updateTimerText();
    if (state.elapsedSeconds >= HARD_LIMIT_SECONDS) void finishRecording();
    else if (state.elapsedSeconds === SOFT_LIMIT_SECONDS) updateLimitWarning();
  }, 1000);
}

async function finishRecording(): Promise<void> {
  if (!recorder) return;
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  const durationSeconds = state.elapsedSeconds;
  state.screen = 'transcribing';
  render();

  let wavBlob: Blob;
  try {
    wavBlob = await recorder.stop();
  } catch (err) {
    recorder = null;
    failTranscription(err);
    return;
  }
  recorder = null;
  await transcribeBlob(wavBlob, 'audio/wav', durationSeconds);
}

function cancelRecording(): void {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  if (recorder) {
    recorder.abort();
    recorder = null;
  }
  state.screen = 'compose';
  state.elapsedSeconds = 0;
  render();
}

/**
 * Shared transcription tail for BOTH a mic recording and a shared WhatsApp voice note. Sends the
 * audio to Gemini and lands on the REVIEW screen — voice is opt-in, so nothing is saved until she
 * taps Save. On failure we drop her back to compose with a clear message (never a dead end).
 */
async function transcribeBlob(
  blob: Blob,
  mimeType: string,
  durationSeconds: number
): Promise<void> {
  state.screen = 'transcribing';
  render();
  try {
    const base64 = await blobToBase64(blob);
    const transcript = await transcribeAudio(getKey(), base64, mimeType);
    state.transcript = transcript;
    state.reviewDuration = durationSeconds;
    state.error = null;
    state.screen = 'review';
    render();
  } catch (err) {
    failTranscription(err);
  }
}

function failTranscription(err: unknown): void {
  state.error = err instanceof Error ? err.message : 'Transcription failed. Please try again.';
  state.transcript = '';
  state.screen = 'compose';
  render();
  showToast('Transcription failed');
}

// ── Share target: a WhatsApp voice note shared INTO the app ───────────────────

/**
 * Pick up a voice note shared into the app (Android: long-press a WhatsApp voice note → Share →
 * this app). The service worker stashed it in SHARE_CACHE and redirected with ?shared=1; we read
 * it back and run the same record→review path. One-shot: consumed on pickup, flag stripped.
 */
async function ingestSharedAudio(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);

  let res: Response | undefined;
  try {
    const cache = await caches.open(SHARE_CACHE);
    res = (await cache.match(SHARE_ITEM_KEY)) ?? undefined;
    await cache.delete(SHARE_ITEM_KEY);
  } catch {
    return; // Cache API unavailable — nothing to ingest.
  }
  if (!res) return;

  if (!hasKey()) {
    state.screen = 'settings';
    render();
    showToast('Add your Gemini key, then share again');
    return;
  }

  const blob = await res.blob();
  const filename = decodeURIComponent(res.headers.get('X-Shared-Filename') ?? '');
  const mimeType = normalizeAudioMime(res.headers.get('Content-Type') ?? blob.type, filename);
  await transcribeBlob(blob, mimeType, 0);
}

/**
 * Map a shared file's reported type (often empty / an opus alias) to a mime Gemini's inline audio
 * accepts (wav/mp3/aiff/aac/ogg/flac). WhatsApp voice notes are ogg-opus → audio/ogg (the default).
 */
function normalizeAudioMime(rawType: string, filename: string): string {
  const t = rawType.toLowerCase().split(';')[0].trim();
  if (t === 'audio/opus' || t === 'audio/x-opus+ogg' || t === 'application/ogg') return 'audio/ogg';
  if (t === 'audio/mpeg') return 'audio/mp3';
  const geminiOk = ['audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac'];
  if (geminiOk.includes(t)) return t;
  switch (filename.toLowerCase().split('.').pop() ?? '') {
    case 'opus':
    case 'ogg':
      return 'audio/ogg';
    case 'mp3':
    case 'mpeg':
      return 'audio/mp3';
    case 'm4a':
    case 'aac':
    case 'mp4':
      return 'audio/aac';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'aiff':
    case 'aif':
      return 'audio/aiff';
    default:
      return 'audio/ogg';
  }
}

// ── Compose actions (typed capture + voice entry) ─────────────────────────────

/** Fire the typed thought straight to the Claude inbox (no screen change — keep the keyboard up). */
function sendComposed(): void {
  const text = state.draft.trim();
  if (!text) return;
  addCapture(text, 0, 'text'); // local-first, never lose it
  state.draft = '';
  const ta = document.getElementById('draft') as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = '';
    autoGrow(ta);
    ta.focus();
  }
  syncComposeAction();
  showToast('Sent ✓');
  buzz();
  void syncPending();
}

/** The mic in the compose bar. Typing needs no key; voice does — bounce to Settings if missing. */
function startVoice(): void {
  if (!hasKey()) {
    state.screen = 'settings';
    render();
    showToast('Add your Gemini key for voice');
    return;
  }
  void beginRecording();
}

// ── Review actions (voice is opt-in to save) ──────────────────────────────────

function saveVoice(): void {
  const ta = document.getElementById('review-text') as HTMLTextAreaElement | null;
  const text = (ta?.value ?? state.transcript).trim();
  if (!text) {
    discardVoice();
    return;
  }
  addCapture(text, state.reviewDuration, 'voice');
  state.transcript = '';
  state.error = null;
  state.screen = 'compose';
  render();
  showToast('Saved ✓');
  buzz();
  void syncPending();
}

function discardVoice(): void {
  state.transcript = '';
  state.error = null;
  state.screen = 'compose';
  render();
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else legacyCopy(text);
    return true;
  } catch (err) {
    console.warn('[brain-dump] clipboard error:', err);
    return false;
  }
}

function legacyCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ── Log actions ───────────────────────────────────────────────────────────────

function clearLog(): void {
  if (!state.confirmingClear) {
    // First tap arms it; auto-disarm after a few seconds so it can't stay hot.
    state.confirmingClear = true;
    render();
    window.setTimeout(() => {
      if (state.confirmingClear) {
        state.confirmingClear = false;
        if (state.screen === 'log') render();
      }
    }, 4000);
    return;
  }
  clearHistory();
  state.confirmingClear = false;
  render();
  showToast('Log cleared');
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function root(): HTMLElement {
  const el = document.getElementById('app');
  if (!el) throw new Error('#app mount point missing');
  return el;
}

function render(): void {
  const el = root();
  switch (state.screen) {
    case 'compose':
      el.innerHTML = renderCompose();
      break;
    case 'recording':
      el.innerHTML = renderRecording();
      break;
    case 'transcribing':
      el.innerHTML = renderTranscribing();
      break;
    case 'review':
      el.innerHTML = renderReview();
      break;
    case 'log':
      el.innerHTML = renderLog();
      break;
    case 'settings':
      el.innerHTML = renderSettings();
      break;
  }
  wireScreen();
}

function errorBanner(): string {
  return state.error ? `<p class="error-banner" role="alert">${escapeHtml(state.error)}</p>` : '';
}

function renderCompose(): string {
  const hasText = state.draft.trim().length > 0;
  return `
    <header class="topbar">
      <h1 class="topbar-title">Brain dump</h1>
      <div class="topbar-actions">
        <button class="icon-btn" id="open-log" aria-label="Log" title="Log">🗒️</button>
      </div>
    </header>
    <main class="screen screen-compose">
      ${errorBanner()}
      <div class="canvas">
        <p class="canvas-hint">Say it or type it.<br />It goes straight to Claude.</p>
      </div>
      <form class="composer" id="composer" autocomplete="off">
        <textarea class="composer-input" id="draft" rows="1" dir="auto"
                  placeholder="What's on your mind?" aria-label="Type a thought"
                  spellcheck="false">${escapeHtml(state.draft)}</textarea>
        <button type="button" class="composer-action ${hasText ? 'is-send' : 'is-mic'}"
                id="compose-action" aria-label="${hasText ? 'Send' : 'Record'}">${
                  hasText ? '➤' : '🎤'
                }</button>
      </form>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>`;
}

function renderRecording(): string {
  return `
    <main class="screen screen-recording">
      <div class="rec-status" role="status" aria-live="polite">
        <span class="rec-dot"></span>
        <span class="rec-timer" id="timer">${formatTime(state.elapsedSeconds)}</span>
        <span class="rec-label">Listening…</span>
      </div>
      <div class="waveform" id="waveform" aria-hidden="true">
        ${state.levels.map((l) => `<span class="wave-bar" style="height:${barHeight(l)}%"></span>`).join('')}
      </div>
      <p class="limit-warning" id="limit-warning" hidden>Getting long — stop soon (~10 min).</p>
      <div class="rec-actions">
        <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="stop-btn">Stop &amp; transcribe</button>
      </div>
    </main>`;
}

function renderTranscribing(): string {
  return `
    <main class="screen screen-transcribing">
      <div class="spinner" role="status" aria-live="polite" aria-label="Transcribing"></div>
      <p class="transcribing-text">Transcribing…</p>
      <p class="muted-hint">Turning your voice into text.</p>
    </main>`;
}

function renderReview(): string {
  return `
    <main class="screen screen-review">
      ${errorBanner()}
      <label class="field-label" for="review-text">Transcript</label>
      <textarea class="review-text" id="review-text" dir="auto" spellcheck="false"
                aria-label="Transcript">${escapeHtml(state.transcript)}</textarea>
      <p class="muted-hint">Fix anything, then keep it or toss it.</p>
      <div class="review-actions">
        <button class="btn btn-ghost" id="discard-btn">Discard</button>
        <button class="btn btn-subtle" id="review-copy">Copy</button>
        <button class="btn btn-primary" id="save-btn">Save to Claude</button>
      </div>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>`;
}

function renderLog(): string {
  const items = loadHistory();
  const tools =
    items.length > 0
      ? `<div class="log-tools">
           <button class="btn-text ${state.confirmingClear ? 'is-armed' : ''}" id="clear-all">${
             state.confirmingClear ? 'Tap again to clear all' : 'Clear all'
           }</button>
         </div>`
      : '';
  const list = items.length
    ? `<ul class="log-list">${items.map(renderLogCard).join('')}</ul>`
    : `<p class="log-empty">Nothing captured yet.</p>`;
  return `
    <header class="topbar">
      <button class="icon-btn" id="log-back" aria-label="Back" title="Back">←</button>
      <h1 class="topbar-title">Log</h1>
      <div class="topbar-actions">
        <button class="icon-btn" id="open-settings" aria-label="Settings" title="Settings">⚙️</button>
      </div>
    </header>
    <main class="screen screen-log">
      ${tools}
      ${list}
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>`;
}

function renderLogCard(it: {
  id: string;
  transcript: string;
  createdAt: string;
  synced: boolean;
  source?: string;
}): string {
  const icon = it.source === 'text' ? '✍️' : '🎤';
  const copied = state.copiedId === it.id;
  return `
    <li class="log-card">
      <p class="log-text" dir="auto">${escapeHtml(it.transcript)}</p>
      <div class="log-meta">
        <span class="log-time">${icon} ${relativeTime(it.createdAt)}${it.synced ? '' : ' · syncing'}</span>
        <span class="log-card-actions">
          <button class="icon-btn sm log-copy" data-id="${it.id}" aria-label="Copy">${
            copied ? 'Copied ✓' : '⧉'
          }</button>
          <button class="icon-btn sm log-del" data-id="${it.id}" aria-label="Delete">🗑</button>
        </span>
      </div>
    </li>`;
}

function renderSettings(): string {
  const status = hasKey() ? 'Key saved ✓' : 'No key yet';
  return `
    <header class="topbar">
      <button class="icon-btn" id="settings-back" aria-label="Back" title="Back">←</button>
      <h1 class="topbar-title">Settings</h1>
      <div class="topbar-actions"></div>
    </header>
    <main class="screen screen-settings">
      <div class="card">
        <p class="settings-label">Gemini API key</p>
        <p class="settings-help">
          Voice transcription uses your own free Google Gemini key, stored only on this phone.
          Typing works without it.
        </p>
        <input class="settings-input" id="api-key" type="password" inputmode="text"
               placeholder="Paste your key" autocomplete="off" />
        <div class="settings-actions">
          <button class="btn btn-primary" id="save-key">Save</button>
          <button class="btn btn-ghost" id="clear-key">Clear</button>
        </div>
        <p class="settings-status" id="settings-status">${status}</p>
        <a class="settings-link" href="https://aistudio.google.com/app/apikey"
           target="_blank" rel="noopener">Get a free key →</a>
      </div>
    </main>`;
}

// ── Live DOM updates (no full re-render — keep focus/keyboard) ─────────────────

function syncComposeAction(): void {
  const btn = document.getElementById('compose-action');
  if (!btn) return;
  const hasText = state.draft.trim().length > 0;
  btn.classList.toggle('is-send', hasText);
  btn.classList.toggle('is-mic', !hasText);
  btn.textContent = hasText ? '➤' : '🎤';
  btn.setAttribute('aria-label', hasText ? 'Send' : 'Record');
}

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  // Only show a scrollbar once it has grown past the cap — otherwise it's a stray artifact at rest.
  ta.style.overflowY = ta.scrollHeight > 140 ? 'auto' : 'hidden';
}

function updateLiveMeters(): void {
  const wf = document.getElementById('waveform');
  if (!wf) return;
  wf.innerHTML = state.levels
    .map((l) => `<span class="wave-bar" style="height:${barHeight(l)}%"></span>`)
    .join('');
}

function updateTimerText(): void {
  const t = document.getElementById('timer');
  if (t) t.textContent = formatTime(state.elapsedSeconds);
}

function updateLimitWarning(): void {
  const w = document.getElementById('limit-warning');
  if (w) w.hidden = false;
}

let toastTimer: number | null = null;
function showToast(message: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove('show');
  }, 1600);
}

function buzz(): void {
  try {
    if (navigator.vibrate) navigator.vibrate(10);
  } catch {
    // vibration unsupported — silent
  }
}

function barHeight(level: number): number {
  return Math.round(8 + level * 92); // 0..1 → 8..100% so silence still shows a baseline bar
}

// ── Event wiring ───────────────────────────────────────────────────────────────

function wireScreen(): void {
  switch (state.screen) {
    case 'compose':
      wireCompose();
      break;
    case 'recording':
      document.getElementById('stop-btn')?.addEventListener('click', () => void finishRecording());
      document.getElementById('cancel-btn')?.addEventListener('click', cancelRecording);
      break;
    case 'review':
      wireReview();
      break;
    case 'log':
      wireLog();
      break;
    case 'settings':
      wireSettings();
      break;
  }
}

function wireCompose(): void {
  document.getElementById('open-log')?.addEventListener('click', () => {
    void syncPending();
    state.copiedId = null;
    state.confirmingClear = false;
    state.screen = 'log';
    render();
  });

  const ta = document.getElementById('draft') as HTMLTextAreaElement | null;
  if (ta) {
    autoGrow(ta);
    ta.addEventListener('input', () => {
      state.draft = ta.value;
      autoGrow(ta);
      syncComposeAction();
    });
  }

  document.getElementById('compose-action')?.addEventListener('click', () => {
    if (state.draft.trim().length > 0) sendComposed();
    else startVoice();
  });
}

function wireReview(): void {
  document.getElementById('save-btn')?.addEventListener('click', saveVoice);
  document.getElementById('discard-btn')?.addEventListener('click', discardVoice);
  document.getElementById('review-copy')?.addEventListener('click', () => {
    const ta = document.getElementById('review-text') as HTMLTextAreaElement | null;
    void copyText(ta?.value ?? state.transcript).then((ok) =>
      showToast(ok ? 'Copied ✓' : 'Long-press to copy')
    );
  });
}

function wireLog(): void {
  document.getElementById('log-back')?.addEventListener('click', () => {
    state.copiedId = null;
    state.confirmingClear = false;
    state.screen = 'compose';
    render();
  });
  document.getElementById('open-settings')?.addEventListener('click', () => {
    state.confirmingClear = false;
    state.screen = 'settings';
    render();
  });
  document.getElementById('clear-all')?.addEventListener('click', clearLog);

  document.querySelectorAll<HTMLButtonElement>('.log-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      const item = loadHistory().find((h) => h.id === id);
      if (!item) return;
      void copyText(item.transcript).then((ok) => {
        if (!ok) {
          showToast('Long-press to copy');
          return;
        }
        state.copiedId = id;
        render();
        window.setTimeout(() => {
          if (state.copiedId === id && state.screen === 'log') {
            state.copiedId = null;
            render();
          }
        }, 1600);
      });
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.log-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      deleteCapture(id);
      if (state.copiedId === id) state.copiedId = null;
      render();
      showToast('Deleted');
    });
  });
}

function wireSettings(): void {
  document.getElementById('settings-back')?.addEventListener('click', () => {
    state.screen = 'compose';
    render();
  });
  document.getElementById('save-key')?.addEventListener('click', () => {
    const input = document.getElementById('api-key') as HTMLInputElement | null;
    const statusEl = document.getElementById('settings-status');
    const value = input?.value ?? '';
    if (!value.trim()) {
      if (statusEl) statusEl.textContent = 'Paste a key first.';
      return;
    }
    setKey(value);
    state.error = null;
    state.screen = 'compose';
    render();
    showToast('Key saved ✓');
  });
  document.getElementById('clear-key')?.addEventListener('click', () => {
    setKey('');
    render();
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Compact recording clock: 0:07, 1:23, 12:00. */
function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/** Short, human relative timestamp ("just now", "5m ago", "3h ago", "2d ago", or a date). */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(then).toLocaleDateString();
}

// ── Boot ─────────────────────────────────────────────────────────────────────

render();

// If opened by a Web Share (a WhatsApp voice note shared in), pick it up and transcribe.
void ingestSharedAudio();

// Flush any locally-saved captures that never reached the inbox (offline / left unsent).
void syncPending().then((n) => {
  if (n > 0 && state.screen === 'log') render();
});

// Best-effort flush when she backgrounds / closes the app. The local copy is already safe; the
// on-load sync above is the backstop.
window.addEventListener('pagehide', () => void syncPending());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void syncPending();
});
