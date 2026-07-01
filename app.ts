// app.ts — Brain Dump (voice-capture) main controller
// WHAT: a compose-first capture app. The home screen IS a compose field with a single
//       morphing action button: when the field is EMPTY it's a 🎤 mic (tap → record →
//       transcribe → keep-or-toss); the moment she types it becomes a ➤ send (tap → the
//       typed thought is fired straight to her Claude inbox). A minimal Log lists what
//       she's saved; Settings holds the Gemini key (voice only).
// WHY:  this app is her "door to Claude" — a brain-dump channel for CURRENT THOUGHTS, modelled
//       on how she fires notes into WhatsApp-to-self and brings them to Claude. Two truths shaped
//       this rebuild (her words, 2026-06-16): "it's not really where i track my to-do list… it's
//       just like current thoughts". Voice was originally OPT-IN to save; 2026-06-23 she reversed
//       that ("it's fine, auto-save, i don't really look") — voice now AUTO-SAVES like typed text,
//       so a note can never strand on the phone unsent. Typing has always sent on tap.
// DECIDED: compose-first (Drafts pattern); ONE morphing bar (WhatsApp/Telegram pattern: mic when
//          empty, send when typed); typing needs NO key (only voice does); a finished voice
//          transcript AUTO-SAVES straight to the inbox (no review gate — 2026-06-23); calm dark
//          theme, ONE accent, few surfaces (compose ↔ log ↔ settings), no tabs/FAB/tag-trees.
//          Captures land in the Supabase voice_captures inbox (anon INSERT-only) tagged
//          source='text'|'voice'; Claude reads + routes server-side. Web Share Target (a WhatsApp
//          voice note shared in) is kept and funnels into the same record→auto-save path.
// BUILT:  state machine + render(), AudioRecorder (getUserMedia → 16 kHz mono WAV), Gemini call,
//          compose bar w/ morphing action + auto-grow, voice auto-save on transcription, Log
//          (copy/delete/clear-all), Settings, share-target ingest, local-first history + sync.
// NEXT:   hardware back-button integration + delete-undo are deliberate future polish.

import { transcribeAudio } from './gemini.js';
import {
  TARGET_SAMPLE_RATE,
  downsampleBuffer,
  mergeChunks,
  encodeWav,
  blobToBase64,
} from './wav.js';
import {
  addCapture,
  clearHistory,
  deleteCapture,
  loadHistory,
  pruneSyncedLocal,
  syncPending,
} from './history.js';
import {
  archiveCapture,
  fetchRemoteCaptures,
  fetchSessionPresence,
  markListened,
  unarchiveCapture,
  type RemoteCapture,
  type SessionPresence,
} from './supabase.js';
import { currentEmail, getToken, isLoggedIn, login, logout } from './auth.js';
import { isPushSupported, pushPermission, subscribeToPush } from './push.js';

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

// Visible build version (shown in the topbar) so she can tell at a glance whether a new
// build actually loaded. BUMP THIS TOGETHER WITH sw.js VERSION on every deploy.
const APP_VERSION = 'v25';
// Build stamp shown next to the version — DATE + TIME so she knows exactly which build she's on (her
// rule: version tags carry the time, not just the date). Update with APP_VERSION on every deploy.
const BUILD_DATE = 'Jul 1, 2026 · 12:36pm JDT';

// Playback-speed cycle for Claude voice notes (her ask: speed up / slow down). 1× first so the
// default is unchanged; remembered across sessions in localStorage so her choice sticks.
const SPEED_STEPS = [1, 1.25, 1.5, 2, 0.75] as const;
const SPEED_KEY = 'vc.playbackRate';

// Set ONLY after a subscription row actually lands in Supabase — NOT on a bare permission grant.
// "✓ Notifications on" reads off this, so a silent store failure can't latch a false "on" (it used
// to, off Notification.permission alone, which hid the retry). Cleared if a later store fails.
const PUSH_SUBSCRIBED_KEY = 'vc.pushSubscribed';

// How long the "Archived — Undo" snackbar stays up before it commits (no confirm dialog — Undo IS
// the safety, per her "archive nicely, pullable" rule). ~6s matches Material's undo window.
const UNDO_WINDOW_MS = 6000;

// The reply snippet length carried with a threaded reply (first ~120 chars of the parent note).
const REPLY_SNIPPET_MAX = 120;

type Screen = 'compose' | 'recording' | 'transcribing' | 'log' | 'settings';

// The three content segments of the Log (her proven top-segmented-control pattern). Views of ONE
// inbox, never a tab bar: 🎤 her own captures · 🎧 Claude voice notes · 📝 Claude written memos.
type Segment = 'mine' | 'voice' | 'info';

interface AppState {
  screen: Screen;
  draft: string; // compose textarea text, kept across renders so a re-render never loses it
  elapsedSeconds: number; // recording timer
  error: string | null;
  levels: number[]; // 0..1 amplitude history for the live waveform
  copiedId: string | null; // which Log row last flashed "Copied ✓"
  confirmingClear: boolean; // Log: "Clear all" is armed (two-tap guard)
  needsKeyPrompt: boolean; // mic tapped without a key → show an inline explainer, not a cold bounce
  paused: boolean; // recording is paused (mic held but not capturing)
  // Last recording whose transcription FAILED (e.g. Gemini "busy" 503). Held so the failure
  // message ("your recording is safe — try again") is true: she taps Retry, no re-recording.
  pendingVoice: { blob: Blob; mimeType: string; durationSeconds: number } | null;
  // v15 — the active Log segment (which of the 3 views is showing). null until first opened, so
  // the Log can default-land on the segment that actually has unheard items.
  segment: Segment | null;
  // v15 — a reply she's recording: the parent Claude-note id + its snippet ride along on the next
  // capture so it lands threaded. Cleared after the capture saves (or she cancels).
  replyContext: { replyTo: string; replySnippet: string } | null;
  // v15 — the row currently in its ~6s "Archived — Undo" window (so Undo can restore it). The row
  // is already hidden from the list; this just keeps the snackbar + the restore handle alive.
  pendingUndo: { id: string; remote: boolean } | null;
  // v19 — a note to open + scroll to (from a notification tap / ?note= deep link). Held until the
  // inbox read lands and the card is in the DOM, then consumed by tryOpenPendingNote().
  pendingOpenNote: string | null;
  // v20 — the id of the Claude note currently loaded in the PERSISTENT player bar. The player lives
  // OUTSIDE #app, so it keeps playing while she navigates (Log → compose to write a reply, etc.) and a
  // re-render of #app never tears out the audio — this is what fixes the listen-lag AND lets her "go
  // off the voice-note page and still listen." Cards read this to show a ▶/⏸ playing state.
  playingId: string | null;
  // v22 — the session she's filtered the Voice/Info tab to (a session_label), or null for "All".
  // null = show every session, grouped by session divider; a value = show only that session's notes.
  sessionFilter: string | null;
}

const state: AppState = {
  screen: 'compose',
  draft: '',
  elapsedSeconds: 0,
  error: null,
  levels: new Array(WAVEFORM_BARS).fill(0),
  copiedId: null,
  confirmingClear: false,
  needsKeyPrompt: false,
  paused: false,
  pendingVoice: null,
  segment: null,
  replyContext: null,
  pendingUndo: null,
  pendingOpenNote: null,
  playingId: null,
  sessionFilter: null,
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

// ── Playback speed (remembered, device-only) ─────────────────────────────────

/** The remembered playback rate (defaults to 1×). Validated against SPEED_STEPS so a stray value
 *  can never set an absurd rate. */
function getSpeed(): number {
  try {
    const raw = Number(localStorage.getItem(SPEED_KEY));
    if ((SPEED_STEPS as readonly number[]).includes(raw)) return raw;
  } catch {
    // storage disabled — fall through to the default
  }
  return 1;
}

function setSpeed(rate: number): void {
  try {
    localStorage.setItem(SPEED_KEY, String(rate));
  } catch {
    // storage disabled — the rate just won't persist; this session still uses it.
  }
}

/** True only if a subscription row was confirmed stored (set by the notify handler on real success).
 *  Decoupled from Notification.permission so a granted-but-failed-store can't show a false "on". */
function isPushSubscribed(): boolean {
  try {
    return localStorage.getItem(PUSH_SUBSCRIBED_KEY) === 'true';
  } catch {
    return false;
  }
}

function setPushSubscribed(on: boolean): void {
  try {
    if (on) localStorage.setItem(PUSH_SUBSCRIBED_KEY, 'true');
    else localStorage.removeItem(PUSH_SUBSCRIBED_KEY);
  } catch {
    // storage disabled — the card just falls back to the default "Notify me" CTA.
  }
}

/** The next rate in the cycle (wraps): 1× → 1.25× → 1.5× → 2× → 0.75× → 1× … */
function nextSpeed(rate: number): number {
  const i = (SPEED_STEPS as readonly number[]).indexOf(rate);
  return SPEED_STEPS[(i + 1) % SPEED_STEPS.length];
}

/** "1×" / "1.25×" label for the speed button. */
function speedLabel(rate: number): string {
  return `${rate}×`;
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

  /** Pause capture — suspends the context so no frames (and no paused silence) are recorded. */
  async pause(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'running') {
      await this.audioContext.suspend();
    }
  }

  /** Resume capture from a pause — picks up appending frames where it left off. */
  async resume(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
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
let pauseStartedMs = 0;

/** The 1-second recording tick — shared by begin and resume so pause math stays in one place. */
function startTimerLoop(): void {
  timerId = window.setInterval(() => {
    state.elapsedSeconds = Math.floor((Date.now() - recordingStartMs) / 1000);
    updateTimerText();
    if (state.elapsedSeconds >= HARD_LIMIT_SECONDS) void finishRecording();
    else if (state.elapsedSeconds === SOFT_LIMIT_SECONDS) updateLimitWarning();
  }, 1000);
}

async function beginRecording(): Promise<void> {
  state.error = null;
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
  state.paused = false;
  recordingStartMs = Date.now();
  render();

  startTimerLoop();
}

async function finishRecording(): Promise<void> {
  if (!recorder) return;
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  state.paused = false;
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
  state.paused = false;
  render();
}

/** Pause the live recording — freezes the timer + waveform, keeps the mic+buffer alive. */
function pauseRecording(): void {
  if (!recorder || state.paused) return;
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  pauseStartedMs = Date.now();
  state.paused = true;
  void recorder.pause();
  render();
}

/** Resume after a pause — shifts the start forward by the paused gap so elapsed excludes it. */
function resumeRecording(): void {
  if (!recorder || !state.paused) return;
  recordingStartMs += Date.now() - pauseStartedMs;
  state.paused = false;
  void recorder.resume();
  render();
  startTimerLoop();
}

/**
 * Shared transcription tail for BOTH a mic recording and a shared WhatsApp voice note. Sends the
 * audio to Gemini and AUTO-SAVES the transcript straight to the Claude inbox — no opt-in review.
 * (Her call 2026-06-23: "it's fine, auto-save, i don't really look" — an unsaved note that never
 * reached the inbox was the real failure mode, so voice now behaves like typed text: saved on
 * arrival.) On failure we drop her back to compose with a clear message (never a dead end).
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
    state.error = null;
    const text = transcript.trim();
    if (!text) {
      // Empty transcription (silence / no speech) — nothing to save; quietly return to compose.
      state.screen = 'compose';
      render();
      showToast('Nothing to save');
      return;
    }
    addCapture(text, durationSeconds, 'voice', consumeReplyContext()); // local-first, never lose it
    state.pendingVoice = null; // succeeded — nothing left to retry
    state.screen = 'compose';
    render();
    showToast('Saved ✓');
    buzz();
    void syncPending();
  } catch (err) {
    // Hold the audio so the failure message ("recording is safe") is honest and Retry can re-send.
    state.pendingVoice = { blob, mimeType, durationSeconds };
    failTranscription(err);
  }
}

function failTranscription(err: unknown): void {
  state.error = err instanceof Error ? err.message : 'Transcription failed. Please try again.';
  state.screen = 'compose';
  render();
  showToast('Transcription failed');
}

/** Re-run transcription on the held-back recording from a prior failed attempt. */
function retryPendingVoice(): void {
  const pending = state.pendingVoice;
  if (!pending) return;
  state.error = null;
  void transcribeBlob(pending.blob, pending.mimeType, pending.durationSeconds);
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

/** Take the pending reply context (if she tapped Reply on a Claude note) and clear it, so the next
 *  capture lands threaded exactly once. Returns undefined when this isn't a reply. */
function consumeReplyContext(): { replyTo: string; replySnippet: string } | undefined {
  const rc = state.replyContext;
  if (!rc) return undefined;
  state.replyContext = null;
  return { replyTo: rc.replyTo, replySnippet: rc.replySnippet };
}

/** Fire the typed thought straight to the Claude inbox (no screen change — keep the keyboard up). */
function sendComposed(): void {
  const text = state.draft.trim();
  if (!text) return;
  const reply = consumeReplyContext();
  addCapture(text, 0, 'text', reply); // local-first, never lose it
  state.draft = '';
  state.needsKeyPrompt = false;
  // A reply changes the composer chrome (the "replying to" banner) — re-render to clear it.
  if (reply) render();
  const ta = document.getElementById('draft') as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = '';
    autoGrow(ta);
    ta.focus();
  }
  syncComposeAction();
  // A visible "it landed" beat — typed capture's #1 need is nothing-lost, and a
  // 1.6s toast alone was thin reassurance. This chip lingers (~4s) + is tappable
  // to the Log so she can SEE it saved. DOM-direct (no render) so the keyboard
  // stays up for rapid capture. (Replaces the old transient "Sent ✓" toast.)
  showSavedConfirm();
  buzz();
  void syncPending();
}

/** The mic in the compose bar. Typing needs no key; voice does. With no key, show
 * an INLINE explainer on the compose screen (why + a one-tap path to set it up) —
 * never a cold bounce into Settings at the moment she has a thought to capture. */
function startVoice(): void {
  if (!hasKey()) {
    state.needsKeyPrompt = true;
    render();
    return;
  }
  state.needsKeyPrompt = false;
  void beginRecording();
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

// ── Cross-device history (logged-in read of the inbox) ───────────────────────
// Logged OUT, the Log is local-only — identical to before. Logged IN, it merges her inbox (every
// device) with any local-only notes that haven't synced yet, so a note typed on the phone shows on
// the computer. Remote rows are READ-only here (Claude clears them server-side after routing).

interface LogRow {
  id: string;
  transcript: string;
  createdAt: string;
  synced: boolean;
  source?: string;
  remote: boolean; // from the server inbox (read-only) vs the local buffer (deletable)
  fromClaude?: boolean; // a Claude-pushed "Note from Claude" (vs one of her own captures)
  title?: string | null; // the session SUBJECT, shown as a bold header on Claude notes
  sessionId?: string | null; // v23: the session's stable slug — stamped onto her reply so it routes back
  sessionLabel?: string | null; // v22: which session sent it — groups + filters the Voice/Info tabs
  audioUrl?: string | null; // voice-note she can play (Claude notes only)
  listened?: boolean; // has she heard this Claude note yet
  replySnippet?: string | null; // v15: if this is HER reply to a Claude note, the parent snippet
}

let remoteCache: RemoteCapture[] | null = null; // last successful inbox read (null = none yet)
let presenceCache: SessionPresence[] = []; // last session-presence read (which sessions are "listening")

/** Session labels whose heartbeat is fresh (<90s) + watching — shown with a 🟢 "listening" dot so she
 *  can see which sessions will actually read a reply. */
function liveSessionLabels(): Set<string> {
  const live = new Set<string>();
  const now = Date.now();
  for (const p of presenceCache) {
    if (!p.watching || !p.session_label) continue;
    if (now - Date.parse(p.last_seen_at) < 90_000) live.add(p.session_label.trim());
  }
  return live;
}

/** The list the Log renders: local-only when logged out / no inbox read yet, else inbox ∪ local.
 *  A row in its Undo window is held out so it stays hidden during the ~6s grace period (the row is
 *  already gone from view; this keeps it gone even before the remote archive PATCH lands). */
function buildLogRows(): LogRow[] {
  const local = loadHistory();
  const localRows = (synced = true): LogRow[] =>
    local.map((l) => ({
      id: l.id,
      transcript: l.transcript,
      createdAt: l.createdAt,
      synced: synced && l.synced,
      source: l.source,
      remote: false,
      fromClaude: false,
      replySnippet: l.replySnippet ?? null,
    }));

  let rows: LogRow[];
  if (!isLoggedIn() || remoteCache === null) {
    rows = localRows();
  } else {
    const remoteRows: LogRow[] = remoteCache.map((r) => ({
      id: r.id,
      transcript: r.transcript,
      createdAt: r.created_at,
      synced: true,
      source: r.source,
      remote: true,
      fromClaude: r.from_claude === true,
      title: r.title ?? null,
      sessionId: r.session_id ?? null,
      sessionLabel: r.session_label ?? null,
      audioUrl: r.audio_url ?? null,
      listened: r.listened === true,
      replySnippet: r.reply_snippet ?? null,
    }));
    // Only local notes the inbox doesn't already have (offline / not-yet-synced) ride alongside.
    const remoteTexts = new Set(remoteCache.map((r) => r.transcript.trim()));
    const localOnly = localRows().filter((l) => !remoteTexts.has(l.transcript.trim()));
    rows = [...remoteRows, ...localOnly].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );
  }
  // Hold out the row that's mid-Undo so it doesn't flicker back in before the PATCH commits.
  if (state.pendingUndo) rows = rows.filter((r) => r.id !== state.pendingUndo?.id);
  return rows;
}

/** Pull the inbox in the background and re-render the Log when it lands. Silent on failure. */
async function refreshRemoteLog(): Promise<void> {
  if (!isLoggedIn()) return;
  const token = await getToken();
  if (!token) {
    if (state.screen === 'log') render(); // session expired → reflect logged-out
    return;
  }
  try {
    remoteCache = await fetchRemoteCaptures(token);
    // The inbox read is now the source of truth for everything that's synced — drop local copies
    // of synced notes so every logged-in device shows the SAME shared list and filed notes vanish.
    pruneSyncedLocal();
    // Best-effort: which sessions are live + listening (for the 🟢 dot). Never blocks the inbox.
    try {
      presenceCache = await fetchSessionPresence(token);
    } catch {
      /* presence is a nicety — ignore a failed read */
    }
    if (state.screen === 'log') render();
    // If a notification deep-link is waiting on this note, the inbox now has it → open + scroll to it.
    tryOpenPendingNote();
  } catch (err) {
    console.warn('[brain-dump] inbox read failed:', err);
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function root(): HTMLElement {
  const el = document.getElementById('app');
  if (!el) throw new Error('#app mount point missing');
  return el;
}

let lastRenderedScreen: string | null = null;
function render(): void {
  const el = root();
  // Preserve scroll across a SAME-screen re-render (archive/copy/etc. in the Log). The innerHTML swap
  // rebuilds the scrolling `.screen` element, which would otherwise snap back to the top — her
  // feedback: "every time I delete it scrolls to the top, that's annoying." Capture the current
  // scroll, then restore it onto the freshly-built element after wiring.
  const sameScreen = state.screen === lastRenderedScreen;
  const prevScroll = sameScreen ? (el.querySelector('.screen')?.scrollTop ?? 0) : 0;
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
    case 'log':
      el.innerHTML = renderLog();
      break;
    case 'settings':
      el.innerHTML = renderSettings();
      break;
  }
  wireScreen();
  if (sameScreen && prevScroll > 0) {
    const next = el.querySelector<HTMLElement>('.screen');
    if (next) next.scrollTop = prevScroll;
  }
  lastRenderedScreen = state.screen;
  rememberView(); // persist screen+segment so a reload returns her here
}

function errorBanner(): string {
  return state.error ? `<p class="error-banner" role="alert">${escapeHtml(state.error)}</p>` : '';
}

function renderCompose(): string {
  const hasText = state.draft.trim().length > 0;
  return `
    <header class="topbar">
      <h1 class="topbar-title">Brain dump <span class="app-version">${APP_VERSION} · ${BUILD_DATE}</span></h1>
      <div class="topbar-actions">
        <button class="icon-btn" id="open-log" aria-label="Log" title="Log">🗒️</button>
      </div>
    </header>
    <main class="screen screen-compose">
      ${errorBanner()}
      ${
        state.replyContext
          ? `<div class="reply-banner" role="status">
        <span class="reply-banner-text" dir="auto">↩ Replying to: ${escapeHtml(
          truncate(state.replyContext.replySnippet, 80)
        )}</span>
        <button type="button" class="reply-cancel" id="cancel-reply" aria-label="Cancel reply">✕</button>
      </div>`
          : ''
      }
      ${
        state.pendingVoice
          ? `<div class="retry-prompt" role="status">
        <button type="button" class="btn btn-primary" id="retry-voice">↻ Retry transcription</button>
        <button type="button" class="btn btn-ghost" id="discard-voice" aria-label="Discard recording">✕ Discard</button>
      </div>`
          : ''
      }
      <div class="canvas">
        <p class="canvas-hint">${
          state.replyContext
            ? 'Reply by voice or text.<br />It threads back to that note.'
            : "Say it or type it.<br />It's saved to your Claude inbox."
        }</p>
      </div>
      ${
        state.needsKeyPrompt
          ? `<div class="key-prompt" role="status">
        <p class="key-prompt-text">🎤 Voice needs a free Gemini key — about 30 seconds, one time. Typing works without it.</p>
        <div class="key-prompt-actions">
          <button type="button" class="btn btn-primary" id="setup-voice">Set it up →</button>
          <button type="button" class="btn-text" id="dismiss-key-prompt">Not now</button>
        </div>
      </div>`
          : ''
      }
      <form class="composer" id="composer" autocomplete="off">
        <textarea class="composer-input" id="draft" rows="1" dir="auto"
                  placeholder="What's on your mind?" aria-label="Type a thought"
                  spellcheck="false">${escapeHtml(state.draft)}</textarea>
        <button type="button" class="composer-action ${hasText ? 'is-send' : 'is-mic'}"
                id="compose-action" aria-label="${hasText ? 'Send' : 'Record'}">${
                  hasText ? '➤' : '🎤'
                }</button>
      </form>
      <button type="button" class="compose-confirm" id="compose-confirm" hidden></button>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>`;
}

function renderRecording(): string {
  const paused = state.paused;
  return `
    <main class="screen screen-recording">
      <div class="rec-status" role="status" aria-live="polite">
        <span class="rec-dot${paused ? ' paused' : ''}"></span>
        <span class="rec-timer" id="timer">${formatTime(state.elapsedSeconds)}</span>
        <span class="rec-label">${paused ? 'Paused' : 'Listening…'}</span>
      </div>
      <div class="waveform" id="waveform" aria-hidden="true">
        ${state.levels.map((l) => `<span class="wave-bar" style="height:${barHeight(l)}%"></span>`).join('')}
      </div>
      <p class="limit-warning" id="limit-warning" hidden>Getting long — stop soon (~10 min).</p>
      <div class="rec-actions">
        <button class="btn btn-subtle btn-pause" id="pause-btn">${paused ? '▶ Resume' : '⏸ Pause'}</button>
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

// ── Segments (the 3-view Log) ─────────────────────────────────────────────────

/** Which of the 3 segments a row belongs to: 🎤 Mine (her captures) · 🎧 Voice (Claude audio) ·
 *  📝 Info (Claude written memos — the מכונים/כללית lists live here). */
function segmentOf(it: LogRow): Segment {
  if (!it.fromClaude) return 'mine';
  return it.audioUrl ? 'voice' : 'info';
}

/** Rows for one segment, in STABLE newest-first order (as built). Listened items are NOT reordered —
 *  they dim in place (via the is-listened class) so a note never jumps or "disappears" the moment she
 *  plays / marks it. (Her feedback: "if I click mark as listened I don't know where it is, it's
 *  confusing"; "I don't want this to move to the end.") What's new still surfaces: newest is at top,
 *  the segmented control lands her on the tab that has unheard items, and unheard cards carry the
 *  accent — none of which requires shuffling the list under her. */
function rowsForSegment(items: LogRow[], seg: Segment): LogRow[] {
  return items.filter((it) => segmentOf(it) === seg);
}

// ── v22: organize the Claude tabs (Voice/Info) BY SESSION ────────────────────────────────────────
// Her ask: "voice notes sorted by session" + "find a way to do that dropdown — it's too overwhelming
// all in one place." Notes carry session_label; the Voice/Info tabs get a dropdown to filter to one
// session, and when showing All they group under light dividers. A null session → an "Earlier" bucket.

const EARLIER_KEY = '__earlier__';

/** A stable grouping key for a row's session (its label, or the "Earlier" bucket for untagged notes). */
function sessionKeyOf(it: LogRow): string {
  return (it.sessionLabel ?? '').trim() || EARLIER_KEY;
}

/** Distinct sessions present in a Claude segment, newest-session-first, with counts. Rows arrive
 *  newest-first (buildLogRows sorts desc), so first-seen order == newest-session-first. */
function claudeSessions(
  items: LogRow[],
  seg: Segment
): { label: string; key: string; count: number }[] {
  const order: string[] = [];
  const map = new Map<string, { label: string; key: string; count: number }>();
  for (const it of items) {
    if (segmentOf(it) !== seg) continue;
    const key = sessionKeyOf(it);
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, { label: key === EARLIER_KEY ? 'Earlier' : key, key, count: 1 });
      order.push(key);
    }
  }
  return order.map((k) => map.get(k) as { label: string; key: string; count: number });
}

/** The by-session dropdown for a Claude tab (only worth showing with 2+ sessions). */
function renderSessionDropdown(
  sessions: { label: string; key: string; count: number }[],
  active: string | null
): string {
  const total = sessions.reduce((n, s) => n + s.count, 0);
  const live = liveSessionLabels();
  const opt = (val: string, text: string, sel: boolean): string =>
    `<option value="${escapeHtml(val)}"${sel ? ' selected' : ''}>${escapeHtml(text)}</option>`;
  const opts = [opt('', `All sessions · ${total}`, !active)].concat(
    // 🟢 = that session is live + reading her replies right now.
    sessions.map((s) =>
      opt(s.key, `${live.has(s.label) ? '🟢 ' : ''}${s.label} · ${s.count}`, active === s.key)
    )
  );
  return `<label class="session-filter-wrap">
      <span class="session-filter-icon" aria-hidden="true">🗂️</span>
      <select class="session-filter" id="session-filter" aria-label="Filter by session">${opts.join('')}</select>
    </label>`;
}

/** Render a segment's cards grouped under session dividers (newest session first). */
function renderGroupedCards(rows: LogRow[]): string {
  const order: string[] = [];
  const groups = new Map<string, LogRow[]>();
  for (const r of rows) {
    const key = sessionKeyOf(r);
    const g = groups.get(key);
    if (g) {
      g.push(r);
    } else {
      groups.set(key, [r]);
      order.push(key);
    }
  }
  const live = liveSessionLabels();
  return order
    .map((key) => {
      const groupRows = groups.get(key) as LogRow[];
      const label = key === EARLIER_KEY ? 'Earlier' : key;
      const dot = key !== EARLIER_KEY && live.has(label) ? '🟢 ' : '';
      const divider = `<li class="session-divider" role="presentation">${dot}${escapeHtml(label)} · ${groupRows.length}</li>`;
      return divider + groupRows.map(renderLogCard).join('');
    })
    .join('');
}

/** "Unheard" = a Claude note she hasn't listened to yet. Her own notes are never "unheard" (the
 *  concept is about Claude reaching her), so Mine has no unheard count. */
function isUnheard(it: LogRow): boolean {
  return it.fromClaude === true && it.listened !== true;
}

/** Count of unheard items in a segment (drives the per-tab "N unheard" header + the tab badge). */
function unheardCount(items: LogRow[], seg: Segment): number {
  return items.filter((it) => segmentOf(it) === seg && isUnheard(it)).length;
}

/** Pick the segment to land on: the first Claude segment that has unheard items, else Mine. So she
 *  opens straight onto what's new from Claude, but never gets pulled away from her own list when
 *  there's nothing new. (Order: Voice, then Info — voice notes are the more time-sensitive ask.) */
function defaultSegment(items: LogRow[]): Segment {
  if (unheardCount(items, 'voice') > 0) return 'voice';
  if (unheardCount(items, 'info') > 0) return 'info';
  return 'mine';
}

const SEGMENT_META: Record<Segment, { icon: string; label: string }> = {
  mine: { icon: '🎤', label: 'My Notes' },
  voice: { icon: '🎧', label: 'Voice' },
  info: { icon: '📝', label: 'Info' },
};

/** The top segmented control — her proven ptab/htabs pattern. Active = shadow/weight lift + the one
 *  accent (NOT a loud fill); a small unheard count rides on the two Claude tabs (a count, never a
 *  red dot). Views of ONE inbox — never a bottom tab bar. */
function renderSegmentedControl(items: LogRow[], active: Segment): string {
  const seg = (s: Segment): string => {
    const meta = SEGMENT_META[s];
    const n = s === 'mine' ? 0 : unheardCount(items, s);
    const badge = n > 0 ? `<span class="seg-badge">${n}</span>` : '';
    return `<button class="seg${s === active ? ' is-active' : ''}" data-seg="${s}"
              role="tab" aria-selected="${s === active}">
        <span class="seg-icon" aria-hidden="true">${meta.icon}</span><span class="seg-label">${meta.label}</span>${badge}
      </button>`;
  };
  return `<div class="segmented" role="tablist">${seg('mine')}${seg('voice')}${seg('info')}</div>`;
}

/** The per-segment header: "N unheard" for the Claude tabs, "All caught up ✓" when zero. Mine just
 *  shows a plain count of her notes. Counts stated, never scolded (anti-quit register). */
function segmentHeader(items: LogRow[], seg: Segment): string {
  if (seg === 'mine') {
    const n = items.filter((it) => segmentOf(it) === 'mine').length;
    const label = n === 0 ? 'No notes yet' : `${n} note${n === 1 ? '' : 's'}`;
    return `<p class="segment-header">${label}</p>`;
  }
  const n = unheardCount(items, seg);
  const label = n === 0 ? 'All caught up ✓' : `${n} unheard`;
  return `<p class="segment-header${n === 0 ? ' is-clear' : ''}">${label}</p>`;
}

function renderLog(): string {
  const items = buildLogRows();
  // Resolve the active segment. Default-land happens ONCE per open: as soon as the data the Log
  // lands on is available (the inbox read has landed, or we're logged out with only local notes),
  // latch the chosen segment into state so later action re-renders (mark-listened, archive) don't
  // jump the view away. Until then we show the computed default but DON'T latch (so the async
  // inbox read can still re-home onto an unheard Claude tab when it arrives).
  const dataReady = remoteCache !== null || !isLoggedIn();
  const activeSegment: Segment = state.segment ?? defaultSegment(items);
  if (state.segment === null && dataReady) state.segment = activeSegment;
  // v22 — organize the Claude tabs by session: a dropdown to focus one session, dividers when All.
  const isClaudeSeg = activeSegment === 'voice' || activeSegment === 'info';
  const sessions = isClaudeSeg ? claudeSessions(items, activeSegment) : [];
  // A stale filter (she picked a session that's no longer present) falls back to All.
  const activeFilter =
    state.sessionFilter && sessions.some((s) => s.key === state.sessionFilter)
      ? state.sessionFilter
      : null;
  let segRows = rowsForSegment(items, activeSegment);
  if (isClaudeSeg && activeFilter) {
    segRows = segRows.filter((it) => sessionKeyOf(it) === activeFilter);
  }
  // The dropdown only earns its place with 2+ sessions; below that, one flat list is calmer.
  const sessionDropdown =
    isClaudeSeg && sessions.length >= 2 ? renderSessionDropdown(sessions, activeFilter) : '';
  const grouped = isClaudeSeg && !activeFilter && sessions.length >= 2;
  // A "listening now" line so she can SEE which sessions are live + reading her replies (even with
  // just one session, where the dropdown doesn't show). Her ask: "a way I know a session is connected
  // and that it's reading replies."
  const liveLabels = [...liveSessionLabels()];
  const presenceLine =
    isClaudeSeg && liveLabels.length
      ? `<p class="presence-line">🟢 Listening now — ${liveLabels.map((l) => escapeHtml(l)).join(', ')}</p>`
      : '';
  const hasLocal = loadHistory().length > 0;
  const syncState = isLoggedIn()
    ? `<p class="log-sync" id="log-sync">✓ Synced — your notes from every device</p>`
    : `<button class="btn-text log-sync-cta" id="log-login">↻ Log in to see notes from your other devices</button>`;
  // "Clear all" only clears THIS device's local buffer; gate it on local items existing.
  const tools = hasLocal
    ? `<div class="log-tools">
           <button class="btn-text ${state.confirmingClear ? 'is-armed' : ''}" id="clear-all">${
             state.confirmingClear ? 'Tap again to clear all' : 'Clear all'
           }</button>
         </div>`
    : '';
  // The active segment renders as ONE list (unheard up top, listened dimmed + sunk below). Empty
  // states are gentle + segment-specific (anti-quit register — never "you missed", just calm).
  const emptyCopy: Record<Segment, string> = {
    mine: 'Nothing captured yet.',
    voice: 'No voice notes from Claude yet.',
    info: 'No memos from Claude yet.',
  };
  const list = segRows.length
    ? `<ul class="log-list">${
        grouped ? renderGroupedCards(segRows) : segRows.map(renderLogCard).join('')
      }</ul>`
    : `<p class="log-empty">${emptyCopy[activeSegment]}</p>`;
  // Only "My Notes" can be cleared (her local buffer) — hide the tool on the Claude tabs.
  const toolsForSegment = activeSegment === 'mine' ? tools : '';
  return `
    <header class="topbar">
      <button class="icon-btn" id="log-back" aria-label="Back" title="Back">←</button>
      <h1 class="topbar-title">Log</h1>
      <div class="topbar-actions">
        <button class="icon-btn" id="log-refresh" aria-label="Refresh" title="Check for new notes">↻</button>
        <button class="icon-btn" id="open-settings" aria-label="Settings" title="Settings">⚙️</button>
      </div>
    </header>
    <main class="screen screen-log">
      ${renderSegmentedControl(items, activeSegment)}
      ${syncState}
      ${segmentHeader(items, activeSegment)}
      ${presenceLine}
      ${sessionDropdown}
      ${toolsForSegment}
      ${list}
      ${renderUndoSnackbar()}
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>`;
}

/** The "Archived — Undo" snackbar (shown ~6s after an archive; tap Undo to restore). No confirm
 *  dialog — Undo IS the safety. Rendered only while a row is in its grace window. */
function renderUndoSnackbar(): string {
  if (!state.pendingUndo) return '';
  return `<div class="undo-snackbar" id="undo-snackbar" role="status" aria-live="polite">
      <span class="undo-text">Archived</span>
      <button type="button" class="undo-btn" id="undo-archive">Undo</button>
    </div>`;
}

function renderLogCard(it: LogRow): string {
  if (it.fromClaude) return renderClaudeCard(it);
  const icon = it.source === 'text' ? '✍️' : '🎤';
  const copied = state.copiedId === it.id;
  // Archive button on every card (her "delete" = soft-archive, pullable). Remote/synced rows archive
  // server-side (authenticated PATCH); a local-only note that never reached the inbox is removed
  // from the device buffer instead (nothing to archive yet) — both via the one 🗑 control.
  const archiveAttr = it.remote ? 'data-archive' : 'data-local-del';
  const del = `<button class="icon-btn sm log-archive" ${archiveAttr}="${escapeHtml(
    it.id
  )}" aria-label="Archive">🗑</button>`;
  const syncing = !it.remote && !it.synced ? ' · syncing' : '';
  // If this is HER reply to a Claude note, tag it so the thread is visible at a glance.
  const replyTag = it.replySnippet
    ? `<p class="reply-tag" dir="auto">↩ re: ${escapeHtml(truncate(it.replySnippet, 80))}</p>`
    : '';
  return `
    <li class="log-card">
      ${replyTag}
      <p class="log-text" dir="auto">${escapeHtml(it.transcript)}</p>
      <div class="log-meta">
        <span class="log-time">${icon} ${relativeTime(it.createdAt)}${syncing}</span>
        <span class="log-card-actions">
          <button class="icon-btn sm log-copy" data-id="${it.id}" aria-label="Copy">${
            copied ? 'Copied ✓' : '⧉'
          }</button>
          ${del}
        </span>
      </div>
    </li>`;
}

/** A "Note from Claude": a short context line (what + when), the text, an optional voice-note
 *  player (with a speed control + reply button), a listened state, and an archive control. Unheard
 *  notes carry the one accent until she plays or marks them; listened ones dim + sink. */
function renderClaudeCard(it: LogRow): string {
  const copied = state.copiedId === it.id;
  // SUBJECT first (the play button needs it for the now-playing bar). Prefer the explicit `title` (the
  // session subject); for older notes without one, derive it from the first line. Body = the remaining
  // text — with an explicit title the full transcript; without one, the lines after the subject (no
  // duplication), or the full text for a single long line (never drop content).
  const rawTitle = (it.title ?? '').trim();
  const lines = it.transcript.split('\n');
  const firstLine = (lines[0] ?? '').trim();
  const rest = lines.slice(1).join('\n').trim();
  const subject = rawTitle || truncate(firstLine, 70);
  const body = rawTitle ? it.transcript : rest || (firstLine.length > 70 ? it.transcript : '');
  // Voice notes play in the PERSISTENT bar (outside #app), so playback survives navigation and a
  // re-render never tears the audio out. A ▶ Play button hands the note to playNote() instead of
  // embedding an <audio> in the (rebuilt) list.
  const playing = state.playingId === it.id;
  const player = it.audioUrl
    ? `<button type="button" class="card-play${playing ? ' is-playing' : ''}" data-id="${escapeHtml(
        it.id
      )}" data-url="${escapeHtml(it.audioUrl)}" data-subject="${escapeHtml(subject)}">${
        playing ? '▶ Playing' : '▶ Play'
      }</button>`
    : '';
  const listened = it.listened
    ? `<span class="listened-badge">✓ Listened</span>`
    : `<button class="btn-text mark-listened" data-id="${escapeHtml(it.id)}">Mark as listened</button>`;
  // Reply (one level): records a voice/text note that lands threaded with reply_to + a snippet.
  const reply = `<button class="btn-text reply-btn" data-id="${escapeHtml(
    it.id
  )}" data-snippet="${escapeHtml(truncate(it.transcript, REPLY_SNIPPET_MAX))}">🎙️ Reply</button>`;
  const contextLine = `<p class="claude-context">${
    it.audioUrl ? '🎧 Voice note' : '📝 Memo'
  } from Claude · ${escapeHtml(absoluteTime(it.createdAt))}</p>`;
  const bodyHtml = body ? `<p class="log-text" dir="auto">${escapeHtml(body)}</p>` : '';
  const meta = `<div class="log-meta">
        ${listened}
        <span class="log-card-actions">
          ${reply}
          <button class="icon-btn sm log-copy" data-id="${escapeHtml(it.id)}" aria-label="Copy">${
            copied ? 'Copied ✓' : '⧉'
          }</button>
          <button class="icon-btn sm log-archive" data-archive="${escapeHtml(
            it.id
          )}" aria-label="Archive">🗑</button>
        </span>
      </div>`;
  const cardOpen = `<li class="log-card claude-card${
    it.listened ? ' is-listened' : ' is-unlistened'
  }" data-card-id="${escapeHtml(it.id)}">`;
  // MEMOS (Info — no audio) collapse under a tappable title: just the subject shows, tap to expand the
  // text (her ask: "make the info memo with title I can click to expand"). Voice notes keep their
  // always-visible layout with the ▶ Play button.
  if (it.fromClaude && !it.audioUrl) {
    return `${cardOpen}
      <details class="memo">
        <summary class="claude-subject memo-summary" dir="auto">${escapeHtml(subject)}</summary>
        ${contextLine}
        ${bodyHtml}
      </details>
      ${meta}
    </li>`;
  }
  return `${cardOpen}
      <p class="claude-subject" dir="auto">${escapeHtml(subject)}</p>
      ${contextLine}
      ${player}
      ${bodyHtml}
      ${meta}
    </li>`;
}

/** First `n` characters, ellipsised. Used for the reply snippet + the "↩ re: …" tag. */
function truncate(text: string, n: number): string {
  const t = text.trim();
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`;
}

/** Absolute "Jun 30, 7:36 PM"-style stamp for a Claude note (her "what time" context line). */
function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderSettings(): string {
  const status = hasKey() ? 'Key saved ✓' : 'No key yet';
  const account = isLoggedIn()
    ? `<div class="card">
        <p class="settings-label">Sync</p>
        <p class="settings-help">
          Signed in as <strong>${escapeHtml(currentEmail())}</strong>. Your notes show up on every
          device you log in on.
        </p>
        <div class="settings-actions">
          <button class="btn btn-ghost" id="logout-btn">Log out</button>
        </div>
      </div>`
    : `<div class="card">
        <p class="settings-label">Sync across devices</p>
        <p class="settings-help">
          Log in to see your notes on every device. Same email + password as your budget app.
        </p>
        <input class="settings-input" id="login-email" type="email" inputmode="email"
               autocomplete="username" placeholder="Email" />
        <input class="settings-input stacked" id="login-password" type="password"
               autocomplete="current-password" placeholder="Password" />
        <div class="settings-actions">
          <button class="btn btn-primary" id="login-btn">Log in</button>
        </div>
        <p class="settings-status" id="login-status"></p>
      </div>`;
  return `
    <header class="topbar">
      <button class="icon-btn" id="settings-back" aria-label="Back" title="Back">←</button>
      <h1 class="topbar-title">Settings</h1>
      <div class="topbar-actions"></div>
    </header>
    <main class="screen screen-settings">
      ${account}
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
      ${renderNotifyCard()}
    </main>`;
}

/** The "🔔 Notify me" card (v15 push, STAGED). Gift-framed copy — a note from Claude arrives as a
 *  welcome, never a nag. Hidden where Web Push isn't supported. The actual send needs the Edge
 *  Function deployed (see PUSH-SETUP.md); the button only registers THIS device. */
function renderNotifyCard(): string {
  if (!isPushSupported()) return '';
  const perm = pushPermission();
  // "On" requires BOTH the OS permission AND a confirmed stored subscription — not permission alone.
  // If permission was granted but the device row never landed (silent 401/network), we stay on the
  // "🔔 Notify me" CTA so the retry is reachable instead of falsely claiming it's set up.
  const subscribed = perm === 'granted' && isPushSubscribed();
  const cta = subscribed
    ? `<button class="btn btn-ghost" id="notify-btn" disabled>✓ Notifications on</button>`
    : `<button class="btn btn-primary" id="notify-btn">🔔 Notify me</button>`;
  return `
      <div class="card">
        <p class="settings-label">Notes from Claude</p>
        <p class="settings-help">
          Get a gentle heads-up when Claude leaves you a new note — no rush, no badges, just a
          quiet “it’s waiting whenever you want it.”
        </p>
        <div class="settings-actions">
          ${cta}
        </div>
        <p class="settings-status" id="notify-status"></p>
      </div>`;
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

let confirmTimer: number | null = null;
/** The lingering, tappable "it's in your Log" beat after a typed save. */
function showSavedConfirm(): void {
  const el = document.getElementById('compose-confirm');
  if (!el) return;
  el.textContent = '✓ Saved to your Log — tap to see it';
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  if (confirmTimer !== null) window.clearTimeout(confirmTimer);
  confirmTimer = window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => {
      el.hidden = true;
    }, 250);
  }, 4000);
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
      document.getElementById('pause-btn')?.addEventListener('click', () => {
        if (state.paused) resumeRecording();
        else pauseRecording();
      });
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
    state.segment = null; // recompute default-land each fresh open (lands on unheard, else Mine)
    // Invalidate the inbox cache too, so default-land does NOT latch off a STALE remoteCache before
    // the fresh read lands. With remoteCache null, renderLog's dataReady is false on first paint (it
    // shows the computed default but doesn't latch), letting refreshRemoteLog re-home onto a newly
    // unheard Claude tab when the read arrives. (Matches handleLogin, which also nulls the cache.)
    remoteCache = null;
    state.pendingUndo = null;
    state.screen = 'log';
    render();
    void refreshRemoteLog(); // pull cross-device notes; re-renders the Log when they land
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

  // Retry a recording whose transcription failed (held in state.pendingVoice).
  document.getElementById('retry-voice')?.addEventListener('click', retryPendingVoice);

  // Throw away a held recording she doesn't want — no save, no nag. (Her 2026-06-24 ask.)
  document.getElementById('discard-voice')?.addEventListener('click', () => {
    state.pendingVoice = null;
    state.error = null;
    render();
    showToast('Discarded');
  });

  // Keyless-mic explainer: go set up voice, or dismiss and keep typing.
  document.getElementById('setup-voice')?.addEventListener('click', () => {
    state.needsKeyPrompt = false;
    state.screen = 'settings';
    render();
  });
  document.getElementById('dismiss-key-prompt')?.addEventListener('click', () => {
    state.needsKeyPrompt = false;
    render();
  });

  // The "it landed" confirmation chip — tap to jump to the Log and SEE it saved.
  document.getElementById('compose-confirm')?.addEventListener('click', () => {
    state.screen = 'log';
    render();
  });

  // Drop a reply she changed her mind about — back to a plain capture.
  document.getElementById('cancel-reply')?.addEventListener('click', () => {
    state.replyContext = null;
    render();
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
  // Refresh — pull any new notes. Safe while listening: the player bar is outside #app, so the
  // re-render doesn't touch the audio (her ask: "refresh in case new stuff comes in, but keep playing").
  document.getElementById('log-refresh')?.addEventListener('click', () => {
    showToast('Checking for new notes…');
    void refreshRemoteLog();
  });
  document.getElementById('log-login')?.addEventListener('click', () => {
    state.screen = 'settings';
    render();
  });
  document.getElementById('clear-all')?.addEventListener('click', clearLog);

  // Segmented control — switch which of the 3 views is showing (state.segment), then re-render.
  document.querySelectorAll<HTMLButtonElement>('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      const seg = btn.dataset.seg as Segment | undefined;
      if (!seg) return;
      state.segment = seg;
      state.sessionFilter = null; // a session filter is per-tab; reset when she switches tabs
      state.copiedId = null;
      render();
    });
  });

  // v22 — the by-session dropdown: focus one session's notes (or All).
  document.getElementById('session-filter')?.addEventListener('change', (e) => {
    state.sessionFilter = (e.target as HTMLSelectElement).value || null;
    render();
  });

  // Undo an archive within the grace window — restore the row + dismiss the snackbar.
  document.getElementById('undo-archive')?.addEventListener('click', () => void undoArchive());

  document.querySelectorAll<HTMLButtonElement>('.log-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      const item = buildLogRows().find((h) => h.id === id);
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

  // Archive (the visible 🗑 on every card). A REMOTE/synced row soft-archives (authenticated PATCH)
  // with an Undo snackbar; a local-only note that never reached the inbox is just dropped from the
  // device buffer (nothing to archive yet, no Undo needed).
  document.querySelectorAll<HTMLButtonElement>('.log-archive').forEach((btn) => {
    btn.addEventListener('click', () => {
      const remoteId = btn.dataset.archive;
      const localId = btn.dataset.localDel;
      if (remoteId) {
        void archiveRow(remoteId);
      } else if (localId) {
        deleteCapture(localId);
        if (state.copiedId === localId) state.copiedId = null;
        render();
        showToast('Removed');
      }
    });
  });

  // Reply to a Claude note — stash the parent context and drop into compose to record/type.
  document.querySelectorAll<HTMLButtonElement>('.reply-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const snippet = btn.dataset.snippet ?? '';
      if (!id) return;
      state.replyContext = { replyTo: id, replySnippet: snippet };
      state.screen = 'compose';
      render();
    });
  });

  // ▶ Play a Claude voice note — hand it to the PERSISTENT bar (playNote), which keeps playing while
  // she navigates. The old inline <audio> + per-card speed chip are gone; speed now lives on the bar.
  document.querySelectorAll<HTMLButtonElement>('.card-play').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const url = btn.dataset.url;
      const subject = btn.dataset.subject ?? '';
      if (!id || !url) return;
      playNote(id, url, subject);
    });
  });

  // Notes from Claude — "Mark as listened" → persist + re-render (so the unheard count/badge/header
  // update too). This is safe now: the list is STABLE-ordered (the card no longer sinks/moves) and
  // render() preserves scroll — so the card just dims in place while the counts stay correct. (Her
  // earlier confusion — "I don't know where it went" — was the old sink-on-listen reorder, now gone.)
  document.querySelectorAll<HTMLButtonElement>('.mark-listened').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      void persistListened(id);
      render();
    });
  });

  // (Playback + listened-marking now live on the persistent player bar — wirePlayerBar(), wired once
  // at boot — so there is no per-card <audio> to attach here.)
}

/** Soft-archive a remote/synced row: hide it immediately (optimistic), show the Undo snackbar, and
 *  commit the authenticated PATCH after the grace window unless she undoes. */
async function archiveRow(id: string): Promise<void> {
  // If the note being archived is the one playing in the bar, stop it (it's leaving the inbox).
  if (state.playingId === id) stopPlayer();
  // Optimistically drop it from view + open the Undo window.
  state.pendingUndo = { id, remote: true };
  if (state.copiedId === id) state.copiedId = null;
  render();
  buzz();
  // Fire the PATCH right away (so it's archived server-side); Undo flips it back if she taps.
  try {
    const token = await getToken();
    if (token) await archiveCapture(token, id);
    // Reflect in the local cache so a re-render after the window keeps it gone.
    if (remoteCache) remoteCache = remoteCache.filter((r) => r.id !== id);
  } catch (err) {
    console.warn('[brain-dump] archive failed:', err);
  }
  scheduleUndoDismiss(id);
}

let undoTimer: number | null = null;
/** Close the Undo window after ~6s — the archive is now committed; clear the snackbar. */
function scheduleUndoDismiss(id: string): void {
  if (undoTimer !== null) window.clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => {
    if (state.pendingUndo?.id === id) {
      state.pendingUndo = null;
      if (state.screen === 'log') render();
    }
  }, UNDO_WINDOW_MS);
}

/** Undo a just-archived row: restore it (authenticated PATCH archived=false), re-read the inbox so
 *  it reappears, and dismiss the snackbar. */
async function undoArchive(): Promise<void> {
  const pending = state.pendingUndo;
  if (!pending) return;
  if (undoTimer !== null) {
    window.clearTimeout(undoTimer);
    undoTimer = null;
  }
  state.pendingUndo = null;
  render();
  try {
    const token = await getToken();
    if (token) {
      await unarchiveCapture(token, pending.id);
      await refreshRemoteLog(); // pull it back into the list
    }
  } catch (err) {
    console.warn('[brain-dump] undo archive failed:', err);
  }
  showToast('Restored');
}

/** Flip a Claude note to listened: optimistic local-cache update + the authenticated PATCH.
 *  Never throws (offline just shows it again next read) — the UI has already moved on. */
async function persistListened(id: string): Promise<void> {
  if (remoteCache) {
    const row = remoteCache.find((r) => r.id === id);
    if (row) row.listened = true;
  }
  try {
    const token = await getToken();
    if (token) await markListened(token, id);
  } catch (err) {
    console.warn('[brain-dump] markListened failed:', err);
  }
}

/** Mark one Claude card listened in the DOM without a full re-render (so the audio keeps playing):
 *  drop the unheard accent and swap the button for the "✓ Listened" badge. */
function markListenedInDom(id: string): void {
  const card = document.querySelector<HTMLElement>(
    `.claude-card[data-card-id="${CSS.escape(id)}"]`
  );
  if (!card) return;
  card.classList.remove('is-unlistened');
  card.classList.add('is-listened'); // dim in place — the card keeps its position (never sinks/moves)
  const btn = card.querySelector('.mark-listened');
  if (btn) {
    const badge = document.createElement('span');
    badge.className = 'listened-badge';
    badge.textContent = '✓ Listened';
    btn.replaceWith(badge);
  }
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

  document.getElementById('login-btn')?.addEventListener('click', () => void handleLogin());
  document.getElementById('login-password')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void handleLogin();
  });
  document.getElementById('logout-btn')?.addEventListener('click', () => {
    logout();
    remoteCache = null;
    state.screen = 'settings';
    render();
    showToast('Logged out');
  });

  // "🔔 Notify me" (v15 push, STAGED) — a user gesture so the permission prompt is allowed. Asks,
  // subscribes through the SW, and stores the subscription. Inert until the Edge Function is live;
  // this only registers the device, so it can never affect the core capture flow.
  document.getElementById('notify-btn')?.addEventListener('click', () => {
    const statusEl = document.getElementById('notify-status');
    const btn = document.getElementById('notify-btn') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Setting up…';
    }
    void subscribeToPush(currentEmail() || undefined).then((result) => {
      if (result.ok) {
        setPushSubscribed(true); // confirmed stored — only now does the card show "✓ Notifications on"
        render();
        showToast('Notifications on ✓');
        return;
      }
      setPushSubscribed(false); // store failed — don't latch a false "on"; keep retry reachable
      const msg =
        result.reason === 'denied'
          ? 'Notifications are blocked — turn them on in your browser settings.'
          : result.reason === 'unsupported'
            ? 'This browser can’t do notifications.'
            : 'Couldn’t set up notifications — try again.';
      if (statusEl) statusEl.textContent = msg;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔔 Notify me';
      }
    });
  });
}

/** Sign in from Settings, warm the inbox, then jump to the Log so she SEES the synced notes. */
async function handleLogin(): Promise<void> {
  const emailEl = document.getElementById('login-email') as HTMLInputElement | null;
  const pwEl = document.getElementById('login-password') as HTMLInputElement | null;
  const statusEl = document.getElementById('login-status');
  const btn = document.getElementById('login-btn') as HTMLButtonElement | null;
  const email = emailEl?.value.trim() ?? '';
  const password = pwEl?.value ?? '';
  if (!email || !password) {
    if (statusEl) statusEl.textContent = 'Enter your email and password.';
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Logging in…';
  }
  try {
    await login(email, password);
    remoteCache = null;
    await refreshRemoteLog(); // warm the inbox before we show the Log
    state.screen = 'log';
    render();
    showToast('Synced ✓');
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err instanceof Error ? err.message : 'Login failed.';
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
  }
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

// ── v19: notification deep-link + remember-last-view ─────────────────────────

const LAST_VIEW_KEY = 'last-view';

/** Remember the current screen + segment so a reload returns her there instead of bouncing to the
 *  compose screen. Her feedback: "when I click refresh I want it to stay on Voice, not the main
 *  screen." Only the Log's landing spot is worth restoring; transient screens aren't persisted. */
function rememberView(): void {
  try {
    if (state.screen === 'log' || state.screen === 'compose') {
      localStorage.setItem(
        LAST_VIEW_KEY,
        JSON.stringify({ screen: state.screen, segment: state.segment })
      );
    }
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** On boot, restore the last screen/segment so a refresh keeps her where she was. */
function restoreLastView(): void {
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return;
    const v = JSON.parse(raw) as { screen?: string; segment?: Segment | null };
    if (v.screen === 'log') {
      state.screen = 'log';
      if (v.segment === 'mine' || v.segment === 'voice' || v.segment === 'info') {
        state.segment = v.segment;
      }
    }
  } catch {
    /* malformed — ignore */
  }
}

/** Read a ?note=<id> deep link (a notification tap that cold-started the app): open the Log and queue
 *  the note to scroll to once the inbox lands. Strips the param so a later refresh won't re-fire. */
function handleNoteDeepLink(): void {
  const id = new URLSearchParams(location.search).get('note');
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  state.screen = 'log';
  state.pendingOpenNote = id;
}

/** Open + scroll to a specific note (from a notification). Switches to the note's segment, scrolls the
 *  card into view, and flashes it. Stays queued (no-op) until the inbox read actually has the note. */
function tryOpenPendingNote(): void {
  const id = state.pendingOpenNote;
  if (!id) return;
  const note = buildLogRows().find((r) => r.id === id);
  if (!note) return; // inbox not loaded yet (or archived) — a later read retries
  state.screen = 'log';
  const seg = segmentOf(note);
  if (state.segment !== seg || state.screen !== lastRenderedScreen) {
    state.segment = seg;
    render(); // rebuild on the right tab so the card is in the DOM
  }
  const card = document.querySelector<HTMLElement>(
    `.claude-card[data-card-id="${CSS.escape(id)}"]`
  );
  if (!card) return; // still not rendered — leave it queued
  card.scrollIntoView({ block: 'center' });
  card.classList.add('note-flash');
  window.setTimeout(() => card.classList.remove('note-flash'), 1800);
  state.pendingOpenNote = null;
}

// Live "open this note" when the app is ALREADY running and she taps a notification (SW postMessage).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; id?: string } | null;
    if (data?.type === 'open-note' && data.id) {
      state.pendingOpenNote = data.id;
      state.screen = 'log';
      render();
      tryOpenPendingNote();
    }
  });
}

// ── v20: persistent "now playing" player bar (lives OUTSIDE #app; survives navigation) ──────────
// The bar's <audio> is never rebuilt by render(), so a voice note keeps playing while she moves
// around the app (Log → compose to write a reply). This is what fixes the listen-lag AND delivers
// "go off the voice-note page and still listen." Cards just hand a note to playNote().

let playerWired = false;
let currentNoteId: string | null = null;
let pendingResume = 0; // seconds to seek to once the media loads (resume-where-you-left-off)
let lastSavedPos = 0; // throttles position saves during timeupdate

// v22 — remember each note's playback position, so if she clicks away / closes the bar she can pick
// up where she left off ("if I accidentally click away it should save where I left off so I can
// continue"). Kept per-note in localStorage; cleared when a note plays to the end.
const POS_KEY = 'vc.playpos';
function loadPositions(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}
function savePosition(id: string, t: number, duration: number): void {
  try {
    const map = loadPositions();
    // Only a MID position is worth resuming — past the first few seconds, before the end.
    if (t > 4 && (!duration || t < duration - 3)) map[id] = t;
    else delete map[id];
    localStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — non-fatal */
  }
}
function getPosition(id: string): number {
  return loadPositions()[id] ?? 0;
}
function clearPosition(id: string): void {
  try {
    const map = loadPositions();
    delete map[id];
    localStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch {
    /* non-fatal */
  }
}

/** Play a Claude voice note in the persistent bar: load src, show the bar with the subject, apply the
 *  remembered speed, and mark it listened (playing counts as heard). Keeps playing across navigation. */
function playNote(id: string, url: string, subject: string): void {
  const bar = document.getElementById('player-bar');
  const audio = document.getElementById('player-audio') as HTMLAudioElement | null;
  const subjEl = document.getElementById('player-subject');
  if (!bar || !audio) return;
  currentNoteId = id;
  state.playingId = id;
  lastSavedPos = 0;
  if (subjEl) subjEl.textContent = subject;
  const srcChanged = audio.getAttribute('src') !== url;
  if (srcChanged) {
    audio.src = url;
    pendingResume = getPosition(id); // fresh load → resume where she left off (seeked on loadedmetadata)
  } else {
    pendingResume = 0; // same note still loaded → keep its live position, don't rewind
  }
  bar.hidden = false;
  // Reserve room so the fixed bar doesn't cover the composer/last card — her bug: "I can't reply
  // while listening because the audio strip covers the writing area." Measure the bar + lift content.
  document.body.classList.add('player-open');
  document.documentElement.style.setProperty('--player-h', `${bar.offsetHeight}px`);
  audio.playbackRate = getSpeed();
  void audio.play().catch(() => {
    /* a gesture/autoplay hiccup — the native controls in the bar still work */
  });
  setMediaSession(subject);
  // Playing no longer marks it listened — only FINISHING does (the 'ended' handler). Her bug: "I
  // listen for 5 seconds, I leave, and it's already marked listened — I didn't even finish it."
  updatePlayButtonsInDom();
}

/** Wire OS media controls (lock screen + notification) so a voice note plays like a music app — her
 *  ask: "can a voice play like YouTube Music, plays over everything." Metadata per note; the audio
 *  element itself already keeps playing in the background on Android Chrome. */
function setMediaSession(subject: string): void {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: subject || 'Note from Claude',
      artist: 'Note from Claude',
    });
  } catch {
    /* MediaMetadata unavailable — the audio still plays */
  }
}

/** Reflect which card is playing (▶ Playing) on the visible cards, without a full re-render. */
function updatePlayButtonsInDom(): void {
  document.querySelectorAll<HTMLElement>('.card-play').forEach((b) => {
    const on = b.dataset.id === state.playingId;
    b.classList.toggle('is-playing', on);
    b.textContent = on ? '▶ Playing' : '▶ Play';
  });
}

/** Stop + hide the bar (her ✕). Remembers the position first so a reopen resumes where she left off. */
function stopPlayer(): void {
  const bar = document.getElementById('player-bar');
  const audio = document.getElementById('player-audio') as HTMLAudioElement | null;
  if (audio) {
    if (currentNoteId) savePosition(currentNoteId, audio.currentTime, audio.duration);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  if (bar) bar.hidden = true;
  document.body.classList.remove('player-open', 'player-min');
  document.documentElement.style.setProperty('--player-h', '0px');
  currentNoteId = null;
  state.playingId = null;
  updatePlayButtonsInDom();
}

/** Wire the persistent bar ONCE — its elements are static in index.html and never rebuilt. */
function wirePlayerBar(): void {
  if (playerWired) return;
  const audio = document.getElementById('player-audio') as HTMLAudioElement | null;
  const speedBtn = document.getElementById('player-speed');
  const closeBtn = document.getElementById('player-close');
  if (!audio) return; // bar absent (e.g. a test harness without the shell) — no-op
  playerWired = true;
  // OS media controls (lock screen + notification): play/pause + ±10s, so a voice note behaves like
  // a music app and can be controlled without opening the app. Wired once.
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => void audio.play());
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('seekbackward', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 10);
    });
    ms.setActionHandler('seekforward', () => {
      const end = audio.duration || audio.currentTime + 10;
      audio.currentTime = Math.min(end, audio.currentTime + 10);
    });
  }
  // Tap the now-playing subject → jump to that note in the Log (YouTube-Music-style: the mini-player
  // takes you to the track). Her ask: "if I click on the audio strip it takes me to the voice note."
  document.getElementById('player-subject')?.addEventListener('click', () => {
    if (!currentNoteId) return;
    state.pendingOpenNote = currentNoteId;
    state.screen = 'log';
    render();
    tryOpenPendingNote();
  });
  // Re-assert the remembered speed whenever the media (re)loads or starts. Browsers reset
  // playbackRate to 1 when a new src loads, which was silently wiping her speed choice ("I can't
  // control the speed"). Applying it on loadedmetadata + play makes the speed actually stick.
  const applyRate = (): void => {
    audio.playbackRate = getSpeed();
  };
  audio.addEventListener('loadedmetadata', () => {
    applyRate();
    // Resume where she left off (only set on a fresh src load, so it never rewinds a live note).
    if (pendingResume > 0) {
      audio.currentTime = pendingResume;
      pendingResume = 0;
    }
  });
  audio.addEventListener('play', () => {
    applyRate();
    if (currentNoteId) state.playingId = currentNoteId;
    updatePlayButtonsInDom();
  });
  // Remember the position as it plays (throttled) + on pause, so a click-away/close can resume it.
  audio.addEventListener('timeupdate', () => {
    if (!currentNoteId) return;
    if (audio.currentTime - lastSavedPos >= 4) {
      lastSavedPos = audio.currentTime;
      savePosition(currentNoteId, audio.currentTime, audio.duration);
    }
  });
  audio.addEventListener('pause', () => {
    if (currentNoteId) savePosition(currentNoteId, audio.currentTime, audio.duration);
  });
  audio.addEventListener('ended', () => {
    if (currentNoteId) {
      void persistListened(currentNoteId);
      markListenedInDom(currentNoteId);
      clearPosition(currentNoteId); // heard to the end — no resume point to keep
    }
    state.playingId = null; // finished — cards go back to ▶ Play (replay re-sets it on 'play')
    updatePlayButtonsInDom();
  });
  speedBtn?.addEventListener('click', () => {
    const rate = nextSpeed(getSpeed());
    setSpeed(rate);
    audio.playbackRate = rate;
    speedBtn.textContent = speedLabel(rate);
    buzz();
  });
  // ±10s skip (her ask). Clamp to the media bounds.
  document.getElementById('player-back')?.addEventListener('click', () => {
    audio.currentTime = Math.max(0, audio.currentTime - 10);
  });
  document.getElementById('player-fwd')?.addEventListener('click', () => {
    const end = audio.duration || audio.currentTime + 10;
    audio.currentTime = Math.min(end, audio.currentTime + 10);
  });
  // Minimize — collapse the bar to a slim strip (audio keeps playing) so it's out of the way, then
  // re-measure the reserved room so the composer/list sit right against the smaller bar.
  document.getElementById('player-min')?.addEventListener('click', () => {
    const bar = document.getElementById('player-bar');
    const minBtn = document.getElementById('player-min');
    const min = document.body.classList.toggle('player-min');
    if (minBtn) minBtn.innerHTML = min ? '&#9652;' : '&#9662;'; // ▴ expand / ▾ minimize
    if (bar) document.documentElement.style.setProperty('--player-h', `${bar.offsetHeight}px`);
  });
  closeBtn?.addEventListener('click', stopPlayer);
  if (speedBtn) speedBtn.textContent = speedLabel(getSpeed());
}

// ── Boot ─────────────────────────────────────────────────────────────────────

wirePlayerBar(); // the persistent player is live from boot, independent of the #app render cycle
restoreLastView(); // a refresh keeps her on the tab she was on...
handleNoteDeepLink(); // ...unless a notification deep-link says open a specific note.
render();

// If opened by a Web Share (a WhatsApp voice note shared in), pick it up and transcribe.
void ingestSharedAudio();

// Flush any locally-saved captures that never reached the inbox (offline / left unsent).
void syncPending().then((n) => {
  if (n > 0 && state.screen === 'log') render();
});

// If she's already logged in, warm the inbox read so the Log shows cross-device notes instantly.
void refreshRemoteLog();

// Best-effort flush when she backgrounds / closes the app. The local copy is already safe; the
// on-load sync above is the backstop.
window.addEventListener('pagehide', () => void syncPending());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void syncPending();
});
