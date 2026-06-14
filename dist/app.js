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
import { TARGET_SAMPLE_RATE, downsampleBuffer, mergeChunks, encodeWav, blobToBase64, wavByteLength, } from './wav.js';
import { addCapture, deleteCapture, loadHistory, syncPending, } from './history.js';
// ── Constants ───────────────────────────────────────────────────────────────
const KEY_STORAGE = 'voice-capture.gemini-key';
// Inline base64 ceiling. A 16 kHz mono 16-bit WAV is ~32 KB/sec ≈ 1.9 MB/min, and
// Gemini's inline request cap is ~20 MB. We warn well before that, at 10 minutes.
const SOFT_LIMIT_SECONDS = 10 * 60; // start nudging her to stop
const HARD_LIMIT_SECONDS = 12 * 60; // auto-stop to protect the payload
const WAVEFORM_BARS = 32;
const state = {
    screen: 'idle',
    elapsedSeconds: 0,
    transcript: '',
    error: null,
    copied: false,
    levels: new Array(WAVEFORM_BARS).fill(0),
    saveStatus: 'none',
    copiedHistoryId: null,
};
// ── Key storage (localStorage only) ─────────────────────────────────────────
function getKey() {
    try {
        return localStorage.getItem(KEY_STORAGE)?.trim() ?? '';
    }
    catch {
        return '';
    }
}
function setKey(value) {
    try {
        if (value.trim()) {
            localStorage.setItem(KEY_STORAGE, value.trim());
        }
        else {
            localStorage.removeItem(KEY_STORAGE);
        }
    }
    catch {
        // Private-mode / storage-disabled: surface nothing here; the no-key prompt
        // will simply keep showing, which is the honest signal.
    }
}
function hasKey() {
    return getKey().length > 0;
}
// ── Audio recorder (Web Audio → PCM → WAV) ──────────────────────────────────
class AudioRecorder {
    constructor() {
        this.audioContext = null;
        this.stream = null;
        this.source = null;
        this.processor = null;
        this.chunks = [];
        this.inputSampleRate = 44100;
        /** Called every audio frame with a 0..1 amplitude for the live waveform. */
        this.onLevel = null;
    }
    async start() {
        this.chunks = [];
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const Ctx = window.AudioContext ??
            window.webkitAudioContext;
        this.audioContext = new Ctx();
        this.inputSampleRate = this.audioContext.sampleRate;
        this.source = this.audioContext.createMediaStreamSource(this.stream);
        // ScriptProcessorNode is deprecated but universally supported on Android Chrome
        // and needs no extra worklet file — fine for a capture-only app.
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            // Copy — the underlying buffer is reused by the audio thread.
            this.chunks.push(new Float32Array(input));
            if (this.onLevel)
                this.onLevel(rms(input));
        };
        this.source.connect(this.processor);
        // ScriptProcessor only fires when connected to a destination.
        this.processor.connect(this.audioContext.destination);
    }
    /** Stop capture, free the mic, and return a 16 kHz mono WAV blob. */
    async stop() {
        if (this.processor) {
            this.processor.disconnect();
            this.processor.onaudioprocess = null;
        }
        if (this.source)
            this.source.disconnect();
        if (this.stream)
            this.stream.getTracks().forEach((t) => t.stop());
        if (this.audioContext)
            await this.audioContext.close();
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
    estimatedWavBytes() {
        let inputSamples = 0;
        for (const c of this.chunks)
            inputSamples += c.length;
        const targetSamples = Math.round(inputSamples * (TARGET_SAMPLE_RATE / this.inputSampleRate));
        return wavByteLength(targetSamples);
    }
    abort() {
        if (this.processor) {
            this.processor.disconnect();
            this.processor.onaudioprocess = null;
        }
        if (this.source)
            this.source.disconnect();
        if (this.stream)
            this.stream.getTracks().forEach((t) => t.stop());
        if (this.audioContext)
            void this.audioContext.close();
        this.chunks = [];
    }
}
function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++)
        sum += buf[i] * buf[i];
    const r = Math.sqrt(sum / buf.length);
    // Light gain so quiet speech still moves the bars; clamp to 1.
    return Math.min(1, r * 4);
}
// ── Recording lifecycle ─────────────────────────────────────────────────────
let recorder = null;
let timerId = null;
let recordingStartMs = 0;
async function beginRecording() {
    state.error = null;
    state.transcript = '';
    state.copied = false;
    state.saveStatus = 'none';
    state.levels = new Array(WAVEFORM_BARS).fill(0);
    recorder = new AudioRecorder();
    recorder.onLevel = (level) => {
        state.levels.push(level);
        if (state.levels.length > WAVEFORM_BARS)
            state.levels.shift();
        updateLiveMeters();
    };
    try {
        await recorder.start();
    }
    catch (err) {
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
        }
        else if (state.elapsedSeconds === SOFT_LIMIT_SECONDS) {
            updateLimitWarning();
        }
    }, 1000);
}
async function finishRecording() {
    if (!recorder)
        return;
    if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
    }
    // Capture the recording length now — the live timer stops counting after this.
    const durationSeconds = state.elapsedSeconds;
    state.screen = 'transcribing';
    render();
    try {
        const wavBlob = await recorder.stop();
        recorder = null;
        const base64 = await blobToBase64(wavBlob);
        const transcript = await transcribeAudio(getKey(), base64, 'audio/wav');
        state.transcript = transcript;
        state.screen = 'result';
        render();
        // A transcript is a message to Claude: write it to local history FIRST (never lose it),
        // then try to sync. The status on the result screen reflects whether the sync landed.
        void autoSave(transcript, durationSeconds);
    }
    catch (err) {
        state.error = err instanceof Error ? err.message : 'Transcription failed. Please try again.';
        state.screen = 'result';
        render();
    }
}
// ── Auto-save: local history first, then sync to the Claude inbox ─────────────
async function autoSave(transcript, durationSeconds) {
    // 1) Always persist locally first — this is the never-lose-a-transcript guarantee.
    const item = addCapture(transcript, durationSeconds);
    // 2) Try to push this item (and any earlier unsynced ones) to Supabase.
    try {
        await syncPending();
    }
    catch {
        // syncPending swallows per-item failures; this guard is belt-and-suspenders.
    }
    // 3) Reflect the result of THIS item on the result screen, if she's still there.
    const synced = loadHistory().find((h) => h.id === item.id)?.synced ?? false;
    state.saveStatus = synced ? 'saved' : 'pending';
    if (state.screen === 'result')
        updateSaveStatus();
}
function cancelRecording() {
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
async function copyTranscript() {
    const text = readTranscriptFromTextarea();
    state.transcript = text;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        }
        else {
            legacyCopy(text);
        }
        state.copied = true;
        updateCopiedState();
        window.setTimeout(() => {
            state.copied = false;
            updateCopiedState();
        }, 2000);
    }
    catch (err) {
        state.error = 'Could not copy automatically — long-press the text to copy it manually.';
        render();
        console.warn('[voice-capture] clipboard error:', err);
    }
}
function legacyCopy(text) {
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
function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60)
        .toString()
        .padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}
function root() {
    const el = document.getElementById('app');
    if (!el)
        throw new Error('#app mount point missing');
    return el;
}
function render() {
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
        case 'history':
            el.innerHTML = renderHistory();
            break;
    }
    wireScreen();
}
function header() {
    return `
    <header class="app-header">
      <h1>Voice Capture</h1>
      <div class="header-actions">
        <button class="icon-btn" id="open-history" aria-label="History" title="History">🕘</button>
        <button class="icon-btn" id="open-settings" aria-label="Settings" title="Settings">⚙️</button>
      </div>
    </header>`;
}
function renderIdle() {
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
function renderRecording() {
    return `
    ${header()}
    <main class="screen screen-recording">
      <div class="recording-indicator" role="status" aria-live="polite">
        <span class="rec-pill"><span class="rec-blink"></span> REC</span>
        <span class="timer" id="timer" aria-label="Recording time">${formatTime(state.elapsedSeconds)}</span>
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
function renderTranscribing() {
    return `
    ${header()}
    <main class="screen screen-transcribing">
      <div class="spinner" role="status" aria-live="polite" aria-label="Transcribing"></div>
      <p class="transcribing-text">Transcribing… sending to Gemini</p>
      <p class="record-hint">Don't close the app — this takes a few seconds.</p>
    </main>`;
}
function renderResult() {
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
      <p class="save-status ${saveStatusClass()}" id="save-status" aria-live="polite">${saveStatusText()}</p>
      <div class="result-actions">
        <button class="btn btn-primary copy-btn" id="copy-btn">
          ${state.copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button class="btn btn-secondary" id="again-btn">Record again</button>
      </div>
    </main>`;
}
function saveStatusText() {
    switch (state.saveStatus) {
        case 'saved':
            return 'Saved ✓';
        case 'pending':
            return 'Saved on phone — will sync';
        default:
            return 'Saving…';
    }
}
function saveStatusClass() {
    return state.saveStatus === 'pending' ? 'is-pending' : 'is-saved';
}
function renderHistory() {
    const items = loadHistory();
    const list = items.length
        ? `<ul class="history-list">${items.map(renderHistoryRow).join('')}</ul>`
        : `<p class="history-empty">No saved notes yet.</p>`;
    return `
    ${header()}
    <main class="screen screen-history">
      <div class="history-head">
        <h2 class="settings-title">History</h2>
      </div>
      ${list}
      <button class="btn btn-secondary back-btn" id="history-back-btn">Back</button>
    </main>`;
}
function renderHistoryRow(item) {
    const copied = state.copiedHistoryId === item.id;
    const syncDot = item.synced
        ? '<span class="sync-dot is-synced" title="Synced" aria-label="Synced">✓</span>'
        : '<span class="sync-dot is-pending" title="Pending sync" aria-label="Pending sync">●</span>';
    return `
    <li class="history-item" data-id="${escapeHtml(item.id)}">
      <div class="history-meta">
        <span class="history-time">${escapeHtml(relativeTime(item.createdAt))}</span>
        ${syncDot}
      </div>
      <p class="history-text" dir="auto">${escapeHtml(item.transcript)}</p>
      <div class="history-actions">
        <button class="btn btn-secondary history-copy" data-id="${escapeHtml(item.id)}">
          ${copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button class="btn btn-ghost history-delete" data-id="${escapeHtml(item.id)}"
                aria-label="Delete note">Delete</button>
      </div>
    </li>`;
}
function renderSettings() {
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
function updateTimerText() {
    const t = document.getElementById('timer');
    if (t)
        t.textContent = formatTime(state.elapsedSeconds);
}
function updateLiveMeters() {
    const wf = document.getElementById('waveform');
    if (!wf)
        return;
    const bars = wf.querySelectorAll('.wave-bar');
    for (let i = 0; i < bars.length; i++) {
        const level = state.levels[i] ?? 0;
        bars[i].style.height = `${barHeight(level)}%`;
    }
}
function updateLimitWarning() {
    const w = document.getElementById('limit-warning');
    if (w)
        w.hidden = false;
}
function updateCopiedState() {
    const btn = document.getElementById('copy-btn');
    if (btn)
        btn.textContent = state.copied ? 'Copied ✓' : 'Copy';
}
function updateSaveStatus() {
    const el = document.getElementById('save-status');
    if (!el)
        return;
    el.textContent = saveStatusText();
    el.classList.remove('is-saved', 'is-pending');
    el.classList.add(saveStatusClass());
}
function barHeight(level) {
    // Map 0..1 → 8..100% so even silence shows a baseline bar.
    return Math.round(8 + level * 92);
}
// ── Event wiring ─────────────────────────────────────────────────────────────
function wireScreen() {
    document.getElementById('open-settings')?.addEventListener('click', () => {
        state.screen = 'settings';
        render();
    });
    document.getElementById('open-history')?.addEventListener('click', () => {
        state.copiedHistoryId = null;
        state.screen = 'history';
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
            }
            else {
                state.screen = 'idle';
                render();
            }
        });
    }
    if (state.screen === 'settings') {
        document.getElementById('save-key')?.addEventListener('click', () => {
            const input = document.getElementById('api-key');
            const status = document.getElementById('settings-status');
            const value = input?.value ?? '';
            if (!value.trim()) {
                if (status)
                    status.textContent = 'Paste a key first.';
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
    if (state.screen === 'history') {
        document.getElementById('history-back-btn')?.addEventListener('click', () => {
            state.copiedHistoryId = null;
            state.screen = 'idle';
            render();
        });
        document.querySelectorAll('.history-copy').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                if (id)
                    void copyHistoryItem(id);
            });
        });
        document.querySelectorAll('.history-delete').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                if (!id)
                    return;
                deleteCapture(id);
                if (state.copiedHistoryId === id)
                    state.copiedHistoryId = null;
                render();
            });
        });
    }
}
async function copyHistoryItem(id) {
    const item = loadHistory().find((h) => h.id === id);
    if (!item)
        return;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(item.transcript);
        }
        else {
            legacyCopy(item.transcript);
        }
        state.copiedHistoryId = id;
        render();
        window.setTimeout(() => {
            if (state.copiedHistoryId === id) {
                state.copiedHistoryId = null;
                if (state.screen === 'history')
                    render();
            }
        }, 2000);
    }
    catch (err) {
        state.error = 'Could not copy automatically — long-press the text to copy it manually.';
        render();
        console.warn('[voice-capture] history clipboard error:', err);
    }
}
function readTranscriptFromTextarea() {
    const ta = document.getElementById('transcript');
    return ta?.value ?? state.transcript;
}
// ── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/** Short, human relative timestamp ("just now", "5m ago", "3h ago", "2d ago", or a date). */
function relativeTime(iso) {
    const then = Date.parse(iso);
    if (Number.isNaN(then))
        return '';
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 45)
        return 'just now';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60)
        return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24)
        return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7)
        return `${diffDay}d ago`;
    return new Date(then).toLocaleDateString();
}
// ── Boot ─────────────────────────────────────────────────────────────────────
render();
// On load, flush any transcripts that were saved locally but never reached the inbox
// (e.g. recorded while offline). Failures stay unsynced and retry next load — fire and
// forget so a slow/absent network never blocks the UI.
void syncPending().then((n) => {
    // If she's looking at History when a backlog clears, refresh the sync dots.
    if (n > 0 && state.screen === 'history')
        render();
});
