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
//          Plus: To-Do/Thought routing chips (result screen + tap-to-cycle in History) that
//          tag each note LOCALLY; the tag reaches Supabase only via the note's INSERT (anon is
//          insert-only — no update path). The Supabase SEND is deferred until she LEAVES the
//          result screen, so the final tag rides along in the insert. History filter
//          (All / To-Do / Thoughts) + sort (Newest / Oldest), pure client-side.
//          Plus a Web Share Target path: a WhatsApp voice note shared INTO the app is picked up
//          (ingestSharedAudio) and run through the SAME Gemini → inbox tail (transcribeBlob).
// NEXT:   v0 complete. Long-recording File API upload path is deliberately out of scope.
import { transcribeAudio } from './gemini.js';
import { TARGET_SAMPLE_RATE, downsampleBuffer, mergeChunks, encodeWav, blobToBase64, wavByteLength, } from './wav.js';
import { addCapture, deleteCapture, loadHistory, setCategory, syncPending, } from './history.js';
// ── Constants ───────────────────────────────────────────────────────────────
const KEY_STORAGE = 'voice-capture.gemini-key';
// Inline base64 ceiling. A 16 kHz mono 16-bit WAV is ~32 KB/sec ≈ 1.9 MB/min, and
// Gemini's inline request cap is ~20 MB. We warn well before that, at 10 minutes.
const SOFT_LIMIT_SECONDS = 10 * 60; // start nudging her to stop
const HARD_LIMIT_SECONDS = 12 * 60; // auto-stop to protect the payload
const WAVEFORM_BARS = 32;
// Web Share Target hand-off — must match the names the service worker uses in handleShareTarget.
const SHARE_CACHE = 'voice-capture-share';
const SHARE_ITEM_KEY = 'shared-audio';
const state = {
    screen: 'idle',
    elapsedSeconds: 0,
    transcript: '',
    error: null,
    copied: false,
    levels: new Array(WAVEFORM_BARS).fill(0),
    saveStatus: 'none',
    copiedHistoryId: null,
    resultItemId: null,
    historyFilter: 'all',
    historySort: 'newest',
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
    state.resultItemId = null;
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
    let wavBlob;
    try {
        wavBlob = await recorder.stop();
    }
    catch (err) {
        recorder = null;
        state.error = err instanceof Error ? err.message : 'Recording failed. Please try again.';
        state.screen = 'result';
        render();
        return;
    }
    recorder = null;
    await transcribeBlob(wavBlob, 'audio/wav', durationSeconds);
}
/**
 * Shared transcription tail used by BOTH a mic recording (16 kHz WAV) and a shared WhatsApp
 * voice note (ogg/opus, etc.). Sends the audio to Gemini, shows the transcript, and saves it
 * locally — the inbox/Save path is identical for both sources.
 *   @param mimeType        Gemini audio type ('audio/wav' for a recording; normalizeAudioMime() for a share)
 *   @param durationSeconds recording length for the History label; 0 when unknown (shares)
 */
async function transcribeBlob(blob, mimeType, durationSeconds) {
    state.screen = 'transcribing';
    render();
    try {
        const base64 = await blobToBase64(blob);
        const transcript = await transcribeAudio(getKey(), base64, mimeType);
        state.transcript = transcript;
        state.screen = 'result';
        render();
        // A transcript is a message to Claude: write it to local history NOW (never lose it). The
        // Supabase SEND is deferred until she leaves the result screen — so the To-Do/Thought tag she
        // picks here rides along in the single INSERT (anon is insert-only; there's no later update).
        saveLocal(transcript, durationSeconds);
    }
    catch (err) {
        state.error = err instanceof Error ? err.message : 'Transcription failed. Please try again.';
        state.screen = 'result';
        render();
    }
}
// ── Share target: a WhatsApp voice note shared INTO the app ───────────────────
/**
 * Pick up a voice note that was shared into the app from another app (Android: long-press a
 * WhatsApp voice note → Share → Voice Capture). The service worker has already stashed the audio
 * in SHARE_CACHE and redirected here with ?shared=1; we read it back out and run the SAME
 * Gemini → inbox path a recording uses. One-shot: the cached file is deleted on pickup and the
 * ?shared flag is stripped, so a refresh can't re-transcribe a stale share.
 */
async function ingestSharedAudio() {
    const params = new URLSearchParams(location.search);
    if (!params.has('shared'))
        return;
    // Strip the flag immediately so a reload doesn't try to re-ingest.
    history.replaceState(null, '', location.pathname);
    let res;
    try {
        const cache = await caches.open(SHARE_CACHE);
        res = (await cache.match(SHARE_ITEM_KEY)) ?? undefined;
        await cache.delete(SHARE_ITEM_KEY); // one-shot
    }
    catch {
        // Cache API unavailable (e.g. insecure origin) — nothing to ingest.
        return;
    }
    if (!res)
        return;
    if (!hasKey()) {
        // No key yet → can't transcribe. Send her to Settings with a clear next step.
        state.error = 'Add your Gemini key in Settings, then share the voice note again.';
        state.screen = 'settings';
        render();
        return;
    }
    const blob = await res.blob();
    const filename = decodeURIComponent(res.headers.get('X-Shared-Filename') ?? '');
    const mimeType = normalizeAudioMime(res.headers.get('Content-Type') ?? blob.type, filename);
    // Duration is unknown for a shared file (no decode) → 0; History just shows no length.
    await transcribeBlob(blob, mimeType, 0);
}
/**
 * Map a shared file's reported type (often empty, or an opus alias) to a mime Gemini's inline
 * audio accepts (wav/mp3/aiff/aac/ogg/flac). WhatsApp voice notes are ogg-opus → audio/ogg, which
 * is also the fallback. Uses the file extension when the type is missing/unhelpful.
 */
function normalizeAudioMime(rawType, filename) {
    const t = rawType.toLowerCase().split(';')[0].trim();
    if (t === 'audio/opus' || t === 'audio/x-opus+ogg' || t === 'application/ogg')
        return 'audio/ogg';
    if (t === 'audio/mpeg')
        return 'audio/mp3';
    const geminiOk = ['audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac'];
    if (geminiOk.includes(t))
        return t;
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
            return 'audio/ogg'; // WhatsApp's format — the most likely share
    }
}
// ── Save: local history is the guarantee; the Supabase send happens on leave ──
function saveLocal(transcript, durationSeconds) {
    // Persist locally — this is the never-lose-a-transcript guarantee AND the only save that
    // happens here. The Supabase send is deferred to when she leaves the result screen (so the
    // final To-Do/Thought tag is included in the single insert), via void syncPending() in the
    // leave handlers + the pagehide/visibilitychange flush.
    const item = addCapture(transcript, durationSeconds);
    // Remember which local row this is so the result-screen To-Do/Thought chips can tag it.
    state.resultItemId = item.id;
    // The local save is the truth she sees: it's safely on the phone and will send automatically.
    state.saveStatus = 'saved';
    if (state.screen === 'result')
        render();
}
// ── Tagging: to-do / thought routing chips (LOCAL ONLY) ───────────────────────
/**
 * Set or clear the routing tag on a history item. LOCAL ONLY — writes localStorage and
 * re-renders. There is no network call here: anon is insert-only (no UPDATE), so the tag
 * reaches Supabase only via the note's eventual INSERT. The normal flow tags on the result
 * screen BEFORE leaving, and the send fires on leave, so the chosen tag always lands in the
 * insert. (Re-tagging a note in History after it's already been sent updates only the phone
 * copy — known, accepted v0 limitation; see history.ts setCategory.)
 * Tapping the already-active chip clears the tag back to unsorted (null).
 */
function setItemCategory(id, next) {
    const updated = setCategory(id, next);
    if (!updated)
        return;
    // Re-render so the active chip + history chip reflect the new tag right away.
    render();
}
/** Toggle a category on a row: tapping the active tag clears it, otherwise sets the new one. */
function toggleCategory(id, tag) {
    const current = loadHistory().find((h) => h.id === id)?.category;
    setItemCategory(id, current === tag ? null : tag);
}
/** Cycle a row's tag in place: unsorted → To-Do → Thought → unsorted (for the history chip). */
function cycleCategory(id) {
    const current = loadHistory().find((h) => h.id === id)?.category ?? null;
    const next = current === null ? 'todo' : current === 'todo' ? 'thought' : null;
    setItemCategory(id, next);
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
        <p class="record-hint record-hint-share">Or share a WhatsApp voice note to this app.</p>
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
    const current = state.resultItemId
        ? (loadHistory().find((h) => h.id === state.resultItemId)?.category ?? null)
        : null;
    // Only offer tagging once we have a saved local row to attach the tag to.
    const tagBlock = state.resultItemId
        ? `<div class="tag-row" role="group" aria-label="Route this note">
         <span class="tag-row-label">Route to Claude as</span>
         <div class="tag-chips">
           ${categoryChip('todo', current === 'todo')}
           ${categoryChip('thought', current === 'thought')}
         </div>
       </div>`
        : '';
    return `
    ${header()}
    <main class="screen screen-result">
      ${errorBlock}
      <label class="field-label" for="transcript">Transcript</label>
      <textarea class="transcript" id="transcript" dir="auto" spellcheck="false"
                aria-label="Transcript">${escapeHtml(state.transcript)}</textarea>
      <p class="save-status ${saveStatusClass()}" id="save-status" aria-live="polite">${saveStatusText()}</p>
      ${tagBlock}
      <div class="result-actions">
        <button class="btn btn-primary copy-btn" id="copy-btn">
          ${state.copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button class="btn btn-secondary" id="again-btn">Record again</button>
      </div>
    </main>`;
}
/** A To-Do / Thought toggle chip. `active` paints it as the selected route. */
function categoryChip(tag, active) {
    const label = tag === 'todo' ? '📝 To-Do' : '💭 Thought';
    return `<button class="tag-chip ${active ? 'is-active' : ''}" data-tag="${tag}"
            aria-pressed="${active ? 'true' : 'false'}">${label}</button>`;
}
function saveStatusText() {
    switch (state.saveStatus) {
        case 'saved':
            // Local save is the guarantee; the send to Claude happens when she leaves this screen.
            return 'Saved ✓';
        case 'pending':
            // Safety branch — normally unused now that the save here is local-only.
            return 'Saved on phone — will sync';
        default:
            return 'Saving…';
    }
}
function saveStatusClass() {
    return state.saveStatus === 'pending' ? 'is-pending' : 'is-saved';
}
function renderHistory() {
    const all = loadHistory();
    const items = sortHistory(filterHistory(all, state.historyFilter), state.historySort);
    // Empty state distinguishes "nothing saved" from "nothing matches this filter".
    let list;
    if (items.length) {
        list = `<ul class="history-list">${items.map(renderHistoryRow).join('')}</ul>`;
    }
    else if (all.length) {
        list = `<p class="history-empty">No ${state.historyFilter === 'todo' ? 'to-dos' : 'thoughts'} yet.</p>`;
    }
    else {
        list = `<p class="history-empty">No saved notes yet.</p>`;
    }
    return `
    ${header()}
    <main class="screen screen-history">
      <div class="history-head">
        <h2 class="settings-title">History</h2>
      </div>
      <div class="history-controls">
        <div class="filter-chips" role="group" aria-label="Filter notes">
          ${filterChip('all', 'All')}
          ${filterChip('todo', '📝 To-Do')}
          ${filterChip('thought', '💭 Thoughts')}
        </div>
        <button class="sort-toggle" id="sort-toggle"
                aria-label="Sort order, currently ${state.historySort}">
          ${state.historySort === 'newest' ? 'Newest ↓' : 'Oldest ↑'}
        </button>
      </div>
      ${list}
      <button class="btn btn-secondary back-btn" id="history-back-btn">Back</button>
    </main>`;
}
/** A History filter chip (All / To-Do / Thoughts). `active` paints the current selection. */
function filterChip(value, label) {
    const active = state.historyFilter === value;
    return `<button class="filter-chip ${active ? 'is-active' : ''}" data-filter="${value}"
            aria-pressed="${active ? 'true' : 'false'}">${label}</button>`;
}
/** Keep only items matching the active filter ('all' keeps everything). */
function filterHistory(items, filter) {
    if (filter === 'all')
        return items;
    return items.filter((i) => i.category === filter);
}
/** Sort a COPY of the list by createdAt. The store itself stays newest-first untouched. */
function sortHistory(items, sort) {
    const copy = items.slice();
    copy.sort((a, b) => {
        const ta = Date.parse(a.createdAt);
        const tb = Date.parse(b.createdAt);
        return sort === 'newest' ? tb - ta : ta - tb;
    });
    return copy;
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
        <div class="history-meta-right">
          ${historyTagChip(item)}
          ${syncDot}
        </div>
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
/**
 * A small tap-to-cycle tag chip on a history row: unsorted → To-Do → Thought → unsorted.
 * Same local+Supabase update path as the result screen. Label shows the current tag (or
 * a faint "Tag" prompt when unsorted) so she can change it right there in the list.
 */
function historyTagChip(item) {
    const cat = item.category;
    const label = cat === 'todo' ? '📝 To-Do' : cat === 'thought' ? '💭 Thought' : '＋ Tag';
    const cls = cat ? 'is-tagged' : 'is-untagged';
    return `<button class="history-tag-chip ${cls}" data-id="${escapeHtml(item.id)}"
            aria-label="Tag: ${cat ?? 'none'}, tap to change">${label}</button>`;
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
function barHeight(level) {
    // Map 0..1 → 8..100% so even silence shows a baseline bar.
    return Math.round(8 + level * 92);
}
// ── Event wiring ─────────────────────────────────────────────────────────────
function wireScreen() {
    document.getElementById('open-settings')?.addEventListener('click', () => {
        // Leaving the result screen → send any not-yet-sent notes to Claude now, with their final
        // tag baked into the insert (anon is insert-only; the tag can't be set after the send).
        void syncPending();
        state.screen = 'settings';
        render();
    });
    document.getElementById('open-history')?.addEventListener('click', () => {
        // Leaving the result screen → flush pending notes (tag included in the insert) before we go.
        void syncPending();
        state.copiedHistoryId = null;
        // Open History at the calm default each time: everything, newest first.
        state.historyFilter = 'all';
        state.historySort = 'newest';
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
        // To-Do / Thought routing chips: tap to set, tap the active one to clear.
        document.querySelectorAll('.tag-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                const id = state.resultItemId;
                const tag = chip.dataset.tag;
                if (!id || (tag !== 'todo' && tag !== 'thought'))
                    return;
                toggleCategory(id, tag);
            });
        });
        document.getElementById('again-btn')?.addEventListener('click', () => {
            // Leaving the result screen → send any not-yet-sent notes to Claude now, with their final
            // tag included in the insert (anon is insert-only; the tag can't be set after the send).
            void syncPending();
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
        // Filter chips: All / To-Do / Thoughts (pure client-side over the local list).
        document.querySelectorAll('.filter-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                const f = chip.dataset.filter;
                if (f === 'all' || f === 'todo' || f === 'thought') {
                    state.historyFilter = f;
                    render();
                }
            });
        });
        // Sort toggle: Newest ↔ Oldest.
        document.getElementById('sort-toggle')?.addEventListener('click', () => {
            state.historySort = state.historySort === 'newest' ? 'oldest' : 'newest';
            render();
        });
        // Row tag chips: tap to cycle unsorted → To-Do → Thought → unsorted.
        document.querySelectorAll('.history-tag-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                const id = chip.dataset.id;
                if (id)
                    cycleCategory(id);
            });
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
// If we were opened by a Web Share (a WhatsApp voice note shared into the app), pick the audio
// up and transcribe it. No-op on a normal open (no ?shared flag).
void ingestSharedAudio();
// On load, flush any transcripts that were saved locally but never reached the inbox
// (e.g. recorded while offline, or left a previous session unsent). Failures stay unsynced
// and retry next load — fire and forget so a slow/absent network never blocks the UI.
void syncPending().then((n) => {
    // If she's looking at History when a backlog clears, refresh the sync dots.
    if (n > 0 && state.screen === 'history')
        render();
});
// Best-effort flush when she closes / backgrounds the app (e.g. taps a result note's tag, then
// just leaves without hitting a leave button). pagehide fires on navigation/close; the
// visibilitychange→hidden mirror covers tab-switch / app-background on mobile. Both are
// fire-and-forget — the local copy is already safe and the on-load sync is the backstop.
window.addEventListener('pagehide', () => {
    void syncPending();
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        void syncPending();
    }
});
