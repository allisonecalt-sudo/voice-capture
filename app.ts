// app.ts — Voice Capture main controller
// WHAT: the whole single-screen flow — idle → recording (loud timer + pulse + live
//       waveform) → transcribing (spinner) → result (editable transcript + copy) — plus
//       a Settings view for the Gemini key. Captures mic via Web Audio, encodes a
//       16 kHz mono WAV in-browser, sends it to Gemini, shows the transcript to copy.
// WHY:  Allison loses long voice dumps when a keyboard mic silently stops. The #1 job is
//       UNMISTAKABLE "it's recording" proof (running mm:ss + pulse + waveform) so she
//       never again talks for 10 minutes into a dead mic. Then: copy → paste into Claude.
// DECIDED: no backend, no DB, no login. Key in localStorage ONLY (device-only), never
//          hardcoded/committed/logged. WAV path (not webm) because Gemini guarantees wav.
//          Inline ceiling ~10 min (warn past it). Hebrew RTL; transcript output dir=auto.
// BUILT:  state machine + render(), AudioRecorder (getUserMedia + ScriptProcessor PCM
//          capture + RMS for the waveform), Gemini call, copy-to-clipboard, Settings.
// NEXT:   v0 complete. Long-recording File API upload path is deliberately out of scope.

import { transcribeAudio } from './gemini.js';
import {
  TARGET_SAMPLE_RATE,
  downsampleBuffer,
  mergeChunks,
  encodeWav,
  blobToBase64,
  wavByteLength,
} from './wav.js';

// ── Constants ───────────────────────────────────────────────────────────────

const KEY_STORAGE = 'voice-capture.gemini-key';
// Inline base64 ceiling. A 16 kHz mono 16-bit WAV is ~32 KB/sec ≈ 1.9 MB/min, and
// Gemini's inline request cap is ~20 MB. We warn well before that, at 10 minutes.
const SOFT_LIMIT_SECONDS = 10 * 60; // start nudging her to stop
const HARD_LIMIT_SECONDS = 12 * 60; // auto-stop to protect the payload
const WAVEFORM_BARS = 32;

type Screen = 'idle' | 'recording' | 'transcribing' | 'result' | 'settings';

interface AppState {
  screen: Screen;
  elapsedSeconds: number;
  transcript: string;
  error: string | null;
  copied: boolean;
  levels: number[]; // 0..1 amplitude history for the live waveform
}

const state: AppState = {
  screen: 'idle',
  elapsedSeconds: 0,
  transcript: '',
  error: null,
  copied: false,
  levels: new Array(WAVEFORM_BARS).fill(0),
};

// ── Key storage (localStorage only) ─────────────────────────────────────────

function getKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE)?.trim() ?? '';
  } catch {
    return '';
  }
}

function setKey(value: string): void {
  try {
    if (value.trim()) {
      localStorage.setItem(KEY_STORAGE, value.trim());
    } else {
      localStorage.removeItem(KEY_STORAGE);
    }
  } catch {
    // Private-mode / storage-disabled: surface nothing here; the no-key prompt
    // will simply keep showing, which is the honest signal.
  }
}

function hasKey(): boolean {
  return getKey().length > 0;
}

// ── Audio recorder (Web Audio → PCM → WAV) ──────────────────────────────────

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
    // ScriptProcessorNode is deprecated but universally supported on Android Chrome
    // and needs no extra worklet file — fine for a capture-only app.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      const input = e.inputBuffer.getChannelData(0);
      // Copy — the underlying buffer is reused by the audio thread.
      this.chunks.push(new Float32Array(input));
      if (this.onLevel) this.onLevel(rms(input));
    };

    this.source.connect(this.processor);
    // ScriptProcessor only fires when connected to a destination.
    this.processor.connect(this.audioContext.destination);
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

  /** Recorded sample count so far at the target rate (for size estimates). */
  estimatedWavBytes(): number {
    let inputSamples = 0;
    for (const c of this.chunks) inputSamples += c.length;
    const targetSamples = Math.round(inputSamples * (TARGET_SAMPLE_RATE / this.inputSampleRate));
    return wavByteLength(targetSamples);
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
  // Light gain so quiet speech still moves the bars; clamp to 1.
  return Math.min(1, r * 4);
}

// ── Recording lifecycle ─────────────────────────────────────────────────────

let recorder: AudioRecorder | null = null;
let timerId: number | null = null;
let recordingStartMs = 0;

async function beginRecording(): Promise<void> {
  state.error = null;
  state.transcript = '';
  state.copied = false;
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
    state.error =
      'Could not access the microphone. Check that the browser has mic permission, then try again.';
    state.screen = 'idle';
    render();
    console.warn('[voice-capture] mic error:', err);
    return;
  }

  state.screen = 'recording';
  state.elapsedSeconds = 0;
  recordingStartMs = Date.now();
  render();

  timerId = window.setInterval(() => {
    state.elapsedSeconds = Math.floor((Date.now() - recordingStartMs) / 1000);
    updateTimerText();
    if (state.elapsedSeconds >= HARD_LIMIT_SECONDS) {
      void finishRecording();
    } else if (state.elapsedSeconds === SOFT_LIMIT_SECONDS) {
      updateLimitWarning();
    }
  }, 1000);
}

async function finishRecording(): Promise<void> {
  if (!recorder) return;
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  state.screen = 'transcribing';
  render();

  try {
    const wavBlob = await recorder.stop();
    recorder = null;
    const base64 = await blobToBase64(wavBlob);
    const transcript = await transcribeAudio(getKey(), base64, 'audio/wav');
    state.transcript = transcript;
    state.screen = 'result';
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Transcription failed. Please try again.';
    state.screen = 'result';
    console.warn('[voice-capture] transcription error:', err);
  }
  render();
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
  state.screen = 'idle';
  state.elapsedSeconds = 0;
  render();
}

// ── Clipboard ───────────────────────────────────────────────────────────────

async function copyTranscript(): Promise<void> {
  const text = readTranscriptFromTextarea();
  state.transcript = text;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      legacyCopy(text);
    }
    state.copied = true;
    updateCopiedState();
    window.setTimeout(() => {
      state.copied = false;
      updateCopiedState();
    }, 2000);
  } catch (err) {
    state.error = 'Could not copy automatically — long-press the text to copy it manually.';
    render();
    console.warn('[voice-capture] clipboard error:', err);
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

// ── Rendering ───────────────────────────────────────────────────────────────

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function root(): HTMLElement {
  const el = document.getElementById('app');
  if (!el) throw new Error('#app mount point missing');
  return el;
}

function render(): void {
  const el = root();
  switch (state.screen) {
    case 'idle':
      el.innerHTML = renderIdle();
      break;
    case 'recording':
      el.innerHTML = renderRecording();
      break;
    case 'transcribing':
      el.innerHTML = renderTranscribing();
      break;
    case 'result':
      el.innerHTML = renderResult();
      break;
    case 'settings':
      el.innerHTML = renderSettings();
      break;
  }
  wireScreen();
}

function header(): string {
  return `
    <header class="app-header">
      <h1>Voice Capture</h1>
      <button class="icon-btn" id="open-settings" aria-label="Settings" title="Settings">⚙️</button>
    </header>`;
}

function renderIdle(): string {
  const keyMissing = !hasKey();
  const errorBlock = state.error
    ? `<p class="error-banner" role="alert">${escapeHtml(state.error)}</p>`
    : '';
  const keyPrompt = keyMissing
    ? `<div class="card key-prompt" id="key-prompt">
         <p class="key-prompt-title">One-time Gemini key needed</p>
         <p class="key-prompt-body">
           This app sends your recording straight to Google Gemini to transcribe it.
           You need a free API key (kept only on this phone).
         </p>
         <button class="btn btn-secondary" id="goto-settings-from-prompt">Open Settings</button>
       </div>`
    : '';
  return `
    ${header()}
    <main class="screen screen-idle">
      ${errorBlock}
      ${keyPrompt}
      <div class="record-stage">
        <button class="record-btn ${keyMissing ? 'is-disabled' : ''}" id="record-btn"
                ${keyMissing ? 'disabled aria-disabled="true"' : ''}
                aria-label="Start recording">
          <span class="record-dot"></span>
          <span class="record-label">Record</span>
        </button>
        <p class="record-hint">Tap to record. Tap again to stop and transcribe.</p>
      </div>
    </main>`;
}

function renderRecording(): string {
  return `
    ${header()}
    <main class="screen screen-recording">
      <div class="recording-indicator" role="status" aria-live="polite">
        <span class="rec-pill"><span class="rec-blink"></span> REC</span>
        <span class="timer" id="timer" aria-label="Recording time">${formatTime(
          state.elapsedSeconds
        )}</span>
      </div>
      <div class="waveform" id="waveform" aria-hidden="true">
        ${state.levels.map((l) => `<span class="wave-bar" style="height:${barHeight(l)}%"></span>`).join('')}
      </div>
      <p class="limit-warning" id="limit-warning" hidden>
        Recording is getting long — stop and send soon (~10 min limit).
      </p>
      <div class="record-stage">
        <button class="record-btn is-recording" id="stop-btn" aria-label="Stop recording">
          <span class="stop-square"></span>
          <span class="record-label">Stop</span>
        </button>
        <p class="record-hint">Recording… mic is ON. Tap to stop &amp; transcribe.</p>
        <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
      </div>
    </main>`;
}

function renderTranscribing(): string {
  return `
    ${header()}
    <main class="screen screen-transcribing">
      <div class="spinner" role="status" aria-live="polite" aria-label="Transcribing"></div>
      <p class="transcribing-text">Transcribing… sending to Gemini</p>
      <p class="record-hint">Don't close the app — this takes a few seconds.</p>
    </main>`;
}

function renderResult(): string {
  const errorBlock = state.error
    ? `<p class="error-banner" role="alert">${escapeHtml(state.error)}</p>`
    : '';
  return `
    ${header()}
    <main class="screen screen-result">
      ${errorBlock}
      <label class="field-label" for="transcript">Transcript</label>
      <textarea class="transcript" id="transcript" dir="auto" spellcheck="false"
                aria-label="Transcript">${escapeHtml(state.transcript)}</textarea>
      <div class="result-actions">
        <button class="btn btn-primary copy-btn" id="copy-btn">
          ${state.copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button class="btn btn-secondary" id="again-btn">Record again</button>
      </div>
    </main>`;
}

function renderSettings(): string {
  const key = getKey();
  const masked = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '';
  return `
    ${header()}
    <main class="screen screen-settings">
      <h2 class="settings-title">Settings</h2>
      <div class="card">
        <label class="field-label" for="api-key">Gemini API key</label>
        <input class="text-input" id="api-key" type="password" inputmode="text"
               autocomplete="off" dir="ltr"
               placeholder="${key ? 'Saved: ' + masked : 'Paste your key here'}" />
        <p class="settings-help">
          Get a free key at
          <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">
            aistudio.google.com</a>.
          It's stored only on this phone (localStorage) and sent straight to Google — never
          to any server of ours.
        </p>
        <div class="settings-actions">
          <button class="btn btn-primary" id="save-key">Save key</button>
          ${key ? '<button class="btn btn-ghost" id="clear-key">Remove key</button>' : ''}
        </div>
        <p class="settings-status" id="settings-status" aria-live="polite"></p>
      </div>
      <button class="btn btn-secondary back-btn" id="back-btn">Back</button>
    </main>`;
}

// ── Live DOM updates (avoid full re-render mid-recording) ────────────────────

function updateTimerText(): void {
  const t = document.getElementById('timer');
  if (t) t.textContent = formatTime(state.elapsedSeconds);
}

function updateLiveMeters(): void {
  const wf = document.getElementById('waveform');
  if (!wf) return;
  const bars = wf.querySelectorAll<HTMLElement>('.wave-bar');
  for (let i = 0; i < bars.length; i++) {
    const level = state.levels[i] ?? 0;
    bars[i].style.height = `${barHeight(level)}%`;
  }
}

function updateLimitWarning(): void {
  const w = document.getElementById('limit-warning');
  if (w) w.hidden = false;
}

function updateCopiedState(): void {
  const btn = document.getElementById('copy-btn');
  if (btn) btn.textContent = state.copied ? 'Copied ✓' : 'Copy';
}

function barHeight(level: number): number {
  // Map 0..1 → 8..100% so even silence shows a baseline bar.
  return Math.round(8 + level * 92);
}

// ── Event wiring ─────────────────────────────────────────────────────────────

function wireScreen(): void {
  document.getElementById('open-settings')?.addEventListener('click', () => {
    state.screen = 'settings';
    render();
  });

  if (state.screen === 'idle') {
    document.getElementById('record-btn')?.addEventListener('click', () => {
      if (!hasKey()) {
        state.screen = 'settings';
        render();
        return;
      }
      void beginRecording();
    });
    document.getElementById('goto-settings-from-prompt')?.addEventListener('click', () => {
      state.screen = 'settings';
      render();
    });
  }

  if (state.screen === 'recording') {
    document.getElementById('stop-btn')?.addEventListener('click', () => {
      void finishRecording();
    });
    document.getElementById('cancel-btn')?.addEventListener('click', cancelRecording);
  }

  if (state.screen === 'result') {
    document.getElementById('copy-btn')?.addEventListener('click', () => {
      void copyTranscript();
    });
    document.getElementById('again-btn')?.addEventListener('click', () => {
      state.transcript = '';
      state.error = null;
      state.copied = false;
      if (hasKey()) {
        void beginRecording();
      } else {
        state.screen = 'idle';
        render();
      }
    });
  }

  if (state.screen === 'settings') {
    document.getElementById('save-key')?.addEventListener('click', () => {
      const input = document.getElementById('api-key') as HTMLInputElement | null;
      const status = document.getElementById('settings-status');
      const value = input?.value ?? '';
      if (!value.trim()) {
        if (status) status.textContent = 'Paste a key first.';
        return;
      }
      setKey(value);
      state.error = null;
      state.screen = 'idle';
      render();
    });
    document.getElementById('clear-key')?.addEventListener('click', () => {
      setKey('');
      render();
    });
    document.getElementById('back-btn')?.addEventListener('click', () => {
      state.screen = hasKey() ? 'idle' : 'idle';
      render();
    });
  }
}

function readTranscriptFromTextarea(): string {
  const ta = document.getElementById('transcript') as HTMLTextAreaElement | null;
  return ta?.value ?? state.transcript;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Boot ─────────────────────────────────────────────────────────────────────

render();
