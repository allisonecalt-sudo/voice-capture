// memos.ts — Memos widget controller (memos.html)
// WHAT: a persistent, always-visible list of short "memo to self" notes — things Allison must
//       remember to ASK or BRING at a specific moment ("ask Dr. Marar for gastro hafnaya").
//       Typed OR spoken, optionally tagged ("Dr. Marar Wed"), grouped by tag, pinned until
//       checked off. Distinct from brain-dump captures: a capture is a thought fired at Claude;
//       a memo is a note pinned for HER, at a future moment.
// WHY:  before an appointment she accumulates 5-7 questions scattered across chat, phone notes
//       and the task DB. One warm list, one tap from the capture app, ends the scatter.
// DECIDED: Supabase `memos` table in the app's existing project (tandem rule — Claude can read
//       and write it with the service key; localStorage-only state is banned). Posture mirrors
//       voice_captures: anon INSERT-only, authenticated SELECT+UPDATE, NO delete path — checking
//       off sets status='done' + done_at (archived, pullable in the Done fold), never a hard
//       DELETE. Voice reuses the app's transcription path: wav.ts + gemini.ts are imported as-is;
//       only the small mic-capture loop is copied here (app.ts's AudioRecorder isn't exported).
//       `?db=test` switches every read/write to the `memos_test` twin (anon-open) so Playwright
//       never touches prod — default is prod `memos`.
// BUILT: load/render loop, typed add (Enter submits), voice add (record → transcribe →
//       auto-add, matching the app's 2026-06-23 auto-save call), tag chips as filters, tag
//       groups (untagged = General), check-off → collapsible Done (with undo), fail-loud
//       load/logged-out/empty states.
// NEXT:  none for v1. Editing a memo's text and offline queueing are deliberate future polish.

import { transcribeAudio } from './gemini.js';
import {
  TARGET_SAMPLE_RATE,
  downsampleBuffer,
  mergeChunks,
  encodeWav,
  blobToBase64,
} from './wav.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
import { getToken, isLoggedIn } from './auth.js';

// ── Constants ───────────────────────────────────────────────────────────────

// Visible build tag (topbar) — version + date + TIME, her rule, so she knows which build loaded.
const MEMOS_VERSION = 'v1';
const MEMOS_BUILD = 'Jul 20, 2026 · 3:45pm JDT';

// Same-origin key the main app already stores (Brain dump → Settings). Read-only reuse here.
const GEMINI_KEY_STORAGE = 'voice-capture.gemini-key';

// Memos are short asks, not brain dumps — 2 minutes is generous and keeps the WAV well under
// Gemini's inline cap (16 kHz mono ≈ 1.92 MB/min), so no chunk-splitting is ever needed here.
const HARD_LIMIT_SECONDS = 120;

// REST base for this project, derived the same way supabase.ts derives session_presence.
const REST_BASE = SUPABASE_URL.replace('/voice_captures', '');

// `?db=test` → every read/write goes to the memos_test twin (anon-open, test rows only).
const IS_TEST_DB = new URLSearchParams(window.location.search).get('db') === 'test';
const TABLE_URL = `${REST_BASE}/${IS_TEST_DB ? 'memos_test' : 'memos'}`;

// Untagged memos cluster under this label; it renders last, after the named tag groups.
const GENERAL_GROUP = 'General';

type MemoStatus = 'active' | 'done';
type MemoSource = 'typed' | 'voice';

interface Memo {
  id: string;
  content: string;
  tag: string | null;
  status: MemoStatus;
  source: MemoSource;
  created_at: string;
  done_at: string | null;
}

type LoadState = 'loading' | 'ready' | 'error' | 'logged-out';

interface MemosState {
  load: LoadState;
  loadError: string | null; // human-readable reason shown in the fail-loud banner
  memos: Memo[];
  filterTag: string | null; // active tag-chip filter; null = All
  tagDraft: string; // sticky tag input — survives adds so 5 questions tag once
  recording: boolean;
  transcribing: boolean;
  elapsedSeconds: number;
  needsKeyPrompt: boolean; // mic tapped without a Gemini key → inline explainer, not a bounce
  busyIds: Set<string>; // memo ids with an in-flight check-off/undo (guards double-taps)
}

const state: MemosState = {
  load: 'loading',
  loadError: null,
  memos: [],
  filterTag: null,
  tagDraft: '',
  recording: false,
  transcribing: false,
  elapsedSeconds: 0,
  needsKeyPrompt: false,
  busyIds: new Set<string>(),
};

// ── Data layer (REST, mirrors supabase.ts's raw-fetch style) ────────────────

/**
 * The bearer for reads/updates. Test db → the anon key (memos_test is anon-open so tests run
 * without a login). Prod → the app's session token (auth.ts, shared vc.session); null when
 * logged out — the caller then shows the honest logged-out state instead of a silent [].
 */
async function readBearer(): Promise<string | null> {
  if (IS_TEST_DB) return SUPABASE_ANON_KEY;
  return getToken();
}

async function fetchMemos(): Promise<void> {
  state.load = 'loading';
  state.loadError = null;
  render();
  const bearer = await readBearer();
  if (!bearer) {
    // RLS would answer an anon SELECT with an empty 200 — a silent lie. Say it plainly instead.
    state.load = 'logged-out';
    render();
    return;
  }
  try {
    const res = await fetch(`${TABLE_URL}?select=*&order=created_at.asc`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as Memo[];
    state.memos = Array.isArray(rows) ? rows : [];
    state.load = 'ready';
  } catch (err) {
    state.load = 'error';
    state.loadError = err instanceof Error ? err.message : 'network problem';
  }
  render();
}

/**
 * Insert one memo. Insert rides the anon key (mirrors voice_captures: capture is never blocked
 * by login), `Prefer: return=minimal` so it works under the insert-only anon posture. The list
 * is re-fetched afterwards for canonical order — except when logged out on prod, where reads
 * are impossible; the add still lands and the toast says so honestly.
 */
async function insertMemo(content: string, tag: string, source: MemoSource): Promise<void> {
  const payload: { content: string; source: MemoSource; tag?: string } = { content, source };
  const cleanTag = tag.trim();
  if (cleanTag) payload.tag = cleanTag;
  const res = await fetch(TABLE_URL, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Check off / restore one memo. NEVER a hard delete (her rule: archived nicely, pullable) —
 * done = status:'done' + done_at stamp; undo flips it back. Authenticated on prod (anon has
 * no UPDATE), anon on the test twin.
 */
async function setMemoStatus(id: string, status: MemoStatus): Promise<void> {
  const bearer = await readBearer();
  if (!bearer) throw new Error('not logged in');
  const body =
    status === 'done' ? { status, done_at: new Date().toISOString() } : { status, done_at: null };
  const res = await fetch(`${TABLE_URL}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Mic capture (minimal copy of app.ts's unexported AudioRecorder) ─────────
// app.ts keeps its recorder private, and that file is mid-work in another session — so the
// smallest necessary capture loop is copied here; the WAV encode + Gemini call are IMPORTED.

class MemoRecorder {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private inputSampleRate = 44100;

  async start(): Promise<void> {
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new Ctx();
    this.inputSampleRate = this.audioContext.sampleRate;
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    // ScriptProcessorNode: deprecated but universal on Android Chrome, no worklet file needed.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      const input = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input)); // copy — the audio thread reuses the buffer
    };
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  /** Stop capture, free the mic, and return a 16 kHz mono WAV blob (app's exact pipeline). */
  async stop(): Promise<Blob> {
    this.teardownNodes();
    if (this.audioContext) await this.audioContext.close();
    const merged = mergeChunks(this.chunks);
    const downsampled = downsampleBuffer(merged, this.inputSampleRate, TARGET_SAMPLE_RATE);
    this.reset();
    return encodeWav(downsampled, TARGET_SAMPLE_RATE);
  }

  abort(): void {
    this.teardownNodes();
    if (this.audioContext) void this.audioContext.close();
    this.reset();
  }

  private teardownNodes(): void {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
    }
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
  }

  private reset(): void {
    this.chunks = [];
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
  }
}

let recorder: MemoRecorder | null = null;
let timerId: number | null = null;
let recordingStartMs = 0;

function geminiKey(): string {
  try {
    return window.localStorage.getItem(GEMINI_KEY_STORAGE)?.trim() ?? '';
  } catch {
    return '';
  }
}

async function beginRecording(): Promise<void> {
  if (recorder) return; // double-tap guard — same hole app.ts v34 closed
  if (!geminiKey()) {
    state.needsKeyPrompt = true;
    render();
    return;
  }
  recorder = new MemoRecorder();
  try {
    await recorder.start();
  } catch (err) {
    recorder = null;
    showToast('Mic blocked — check browser permission');
    console.warn('[memos] mic error:', err);
    return;
  }
  state.recording = true;
  state.elapsedSeconds = 0;
  recordingStartMs = Date.now();
  render();
  timerId = window.setInterval(() => {
    state.elapsedSeconds = Math.floor((Date.now() - recordingStartMs) / 1000);
    const el = document.getElementById('memo-timer');
    if (el) el.textContent = formatTime(state.elapsedSeconds);
    if (state.elapsedSeconds >= HARD_LIMIT_SECONDS) void finishRecording();
  }, 1000);
}

function stopTimer(): void {
  if (timerId !== null) window.clearInterval(timerId);
  timerId = null;
}

function cancelRecording(): void {
  stopTimer();
  if (recorder) recorder.abort();
  recorder = null;
  state.recording = false;
  render();
}

async function finishRecording(): Promise<void> {
  if (!recorder) return;
  stopTimer();
  const rec = recorder;
  recorder = null;
  state.recording = false;
  state.transcribing = true;
  render();
  try {
    const wav = await rec.stop();
    const base64 = await blobToBase64(wav);
    const transcript = await transcribeAudio(geminiKey(), base64, 'audio/wav');
    // Auto-add (her 2026-06-23 call for the main app: "auto-save, i don't really look").
    // A mishear is one check-off away from gone; a lost memo is gone forever.
    await addMemo(transcript, 'voice');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Transcription failed — try again');
    console.warn('[memos] voice error:', err);
  }
  state.transcribing = false;
  render();
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function addMemo(content: string, source: MemoSource): Promise<void> {
  const text = content.trim();
  if (!text) return;
  try {
    await insertMemo(text, state.tagDraft, source);
  } catch (err) {
    showToast('Couldn’t save the memo — try again');
    console.warn('[memos] insert failed:', err);
    return;
  }
  if (state.load === 'logged-out') {
    // The add landed (anon insert), but prod reads need the app login — say so, don't fake it.
    showToast('Saved ✓ — log in to see the list');
    return;
  }
  showToast('Added ✓');
  await fetchMemos();
}

async function toggleMemo(id: string, to: MemoStatus): Promise<void> {
  if (state.busyIds.has(id)) return;
  state.busyIds.add(id);
  try {
    await setMemoStatus(id, to);
    const row = state.memos.find((m) => m.id === id);
    if (row) {
      row.status = to;
      row.done_at = to === 'done' ? new Date().toISOString() : null;
    }
    showToast(to === 'done' ? 'Done ✓ (kept in Done below)' : 'Back on the list');
  } catch (err) {
    showToast('Couldn’t update — try again');
    console.warn('[memos] status change failed:', err);
  }
  state.busyIds.delete(id);
  render();
}

// ── Grouping / formatting helpers ───────────────────────────────────────────

function activeMemos(): Memo[] {
  return state.memos.filter((m) => m.status === 'active');
}

function doneMemos(): Memo[] {
  return state.memos
    .filter((m) => m.status === 'done')
    .sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? ''));
}

function distinctTags(): string[] {
  const tags = new Set<string>();
  for (const m of activeMemos()) {
    if (m.tag && m.tag.trim()) tags.add(m.tag.trim());
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

/** Tag groups in render order: named tags A→Z, then General (untagged) last. Within a group,
 *  rows keep the fetch order (created_at asc) — newest lands last, so the list stays stable. */
function groupedActive(): Array<{ label: string; memos: Memo[] }> {
  const filter = state.filterTag;
  const groups: Array<{ label: string; memos: Memo[] }> = [];
  const byTag = new Map<string, Memo[]>();
  const untagged: Memo[] = [];
  for (const m of activeMemos()) {
    const tag = m.tag?.trim() ?? '';
    if (!tag) untagged.push(m);
    else {
      const list = byTag.get(tag) ?? [];
      list.push(m);
      byTag.set(tag, list);
    }
  }
  for (const tag of distinctTags()) {
    if (filter && tag !== filter) continue;
    groups.push({ label: tag, memos: byTag.get(tag) ?? [] });
  }
  if (!filter && untagged.length) groups.push({ label: GENERAL_GROUP, memos: untagged });
  return groups;
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderChips(): string {
  const tags = distinctTags();
  if (!tags.length) return '';
  const all = `<button type="button" class="chip${state.filterTag === null ? ' is-active' : ''}"
      data-chip="">All</button>`;
  const chips = tags
    .map(
      (t) => `<button type="button" class="chip${state.filterTag === t ? ' is-active' : ''}"
        data-chip="${escapeHtml(t)}" dir="auto">${escapeHtml(t)}</button>`
    )
    .join('');
  return `<div class="chip-row" role="tablist" aria-label="Filter by tag">${all}${chips}</div>`;
}

function renderMemoCard(m: Memo): string {
  const busy = state.busyIds.has(m.id);
  return `
    <div class="memo-card" data-id="${m.id}">
      <button type="button" class="memo-check" data-check="${m.id}" ${busy ? 'disabled' : ''}
        aria-label="Check off">◯</button>
      <div class="memo-body">
        <p class="memo-text" dir="auto">${escapeHtml(m.content)}</p>
        ${m.source === 'voice' ? '<span class="memo-src" title="Spoken">🎤</span>' : ''}
      </div>
    </div>`;
}

function renderDoneFold(): string {
  const done = doneMemos();
  if (!done.length) return '';
  const rows = done
    .map(
      (m) => `
      <div class="done-row" data-id="${m.id}">
        <div class="done-body">
          <p class="done-text" dir="auto">${escapeHtml(m.content)}</p>
          <span class="done-meta">${m.tag ? `${escapeHtml(m.tag)} · ` : ''}done ${formatWhen(m.done_at)}</span>
        </div>
        <button type="button" class="btn-text undo-btn" data-undo="${m.id}"
          ${state.busyIds.has(m.id) ? 'disabled' : ''}>↩ undo</button>
      </div>`
    )
    .join('');
  return `
    <details class="done-fold">
      <summary class="done-summary">✓ Done (${done.length})</summary>
      ${rows}
    </details>`;
}

function renderList(): string {
  if (state.load === 'loading') {
    return `<p class="memos-status">Loading memos…</p>`;
  }
  if (state.load === 'error') {
    return `
      <div class="error-banner" role="alert">
        Couldn’t load memos (${escapeHtml(state.loadError ?? 'unknown')}).
        <button type="button" class="btn-text" id="retry-load">↻ Retry</button>
      </div>`;
  }
  if (state.load === 'logged-out') {
    return `
      <div class="error-banner" role="alert">
        Memos need the app login to load. Open <a class="inline-link" href="index.html">Brain
        dump</a> → ⚙ Settings → Log in, then come back. Adding below still works — new memos
        land safely.
      </div>`;
  }
  const groups = groupedActive();
  const done = renderDoneFold();
  if (!groups.length && !done) {
    return `<p class="memos-status">No memos yet — add the first one below.</p>`;
  }
  const groupHtml = groups
    .map(
      (g) => `
      <section class="memo-group">
        <h2 class="memo-group-title" dir="auto">${g.label === GENERAL_GROUP ? '🗂 ' : '📌 '}${escapeHtml(g.label)}</h2>
        ${g.memos.map(renderMemoCard).join('')}
      </section>`
    )
    .join('');
  const emptyFiltered =
    !groups.length && done ? `<p class="memos-status">Nothing active — all checked off. ✓</p>` : '';
  return groupHtml + emptyFiltered + done;
}

function renderComposer(): string {
  if (state.recording) {
    return `
      <div class="memo-rec" role="status" aria-live="polite">
        <span class="rec-dot"></span>
        <span class="rec-timer" id="memo-timer">${formatTime(state.elapsedSeconds)}</span>
        <span class="rec-label">Listening…</span>
        <button type="button" class="btn btn-ghost" id="rec-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="rec-stop">Stop</button>
      </div>`;
  }
  if (state.transcribing) {
    return `
      <div class="memo-rec" role="status" aria-live="polite">
        <span class="spinner spinner-sm"></span>
        <span class="rec-label">Transcribing…</span>
      </div>`;
  }
  return `
    ${
      state.needsKeyPrompt
        ? `<div class="key-prompt" role="status">
        <p class="key-prompt-text">🎤 Voice memos use the same free Gemini key as Brain dump.
        Set it up there once (⚙ Settings) — typing works without it.</p>
        <div class="key-prompt-actions">
          <a class="btn btn-primary" href="index.html">Open Brain dump →</a>
          <button type="button" class="btn-text" id="dismiss-key-prompt">Not now</button>
        </div>
      </div>`
        : ''
    }
    <form class="memo-composer" id="memo-form" autocomplete="off">
      <input class="tag-input" id="tag-input" type="text" dir="auto"
        placeholder="tag · optional (e.g. Dr. Marar Wed)" aria-label="Optional tag"
        value="${escapeHtml(state.tagDraft)}" />
      <div class="memo-input-row">
        <input class="memo-input" id="memo-input" type="text" dir="auto"
          placeholder="Ask or bring…" aria-label="New memo" />
        <button type="submit" class="composer-action is-send" id="memo-add" hidden
          aria-label="Add memo">➤</button>
        <button type="button" class="composer-action is-mic" id="memo-mic"
          aria-label="Speak a memo">🎤</button>
      </div>
    </form>`;
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="index.html" aria-label="Back to Brain dump" title="Brain dump">←</a>
      <h1 class="topbar-title">Memos <span class="app-version">${MEMOS_VERSION} · ${MEMOS_BUILD}${IS_TEST_DB ? ' · TEST DB' : ''}</span></h1>
      <div class="topbar-actions"></div>
    </header>
    <main class="screen screen-memos">
      ${renderChips()}
      <div class="memos-list" id="memos-list">${renderList()}</div>
      ${renderComposer()}
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>`;
  wire();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function wire(): void {
  const form = document.getElementById('memo-form') as HTMLFormElement | null;
  const input = document.getElementById('memo-input') as HTMLInputElement | null;
  const tagInput = document.getElementById('tag-input') as HTMLInputElement | null;
  const mic = document.getElementById('memo-mic');
  const add = document.getElementById('memo-add');

  if (input && mic && add) {
    // Morphing action, same muscle memory as Brain dump: mic on empty, ➤ send once she types.
    const syncAction = (): void => {
      const hasText = input.value.trim().length > 0;
      add.hidden = !hasText;
      (mic as HTMLButtonElement).hidden = hasText;
    };
    input.addEventListener('input', syncAction);
    syncAction();
  }
  if (tagInput) {
    tagInput.addEventListener('input', () => {
      state.tagDraft = tagInput.value;
    });
  }
  if (form && input) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      void addMemo(text, 'typed');
    });
  }
  if (mic) mic.addEventListener('click', () => void beginRecording());

  document.getElementById('rec-stop')?.addEventListener('click', () => void finishRecording());
  document.getElementById('rec-cancel')?.addEventListener('click', () => cancelRecording());
  document.getElementById('retry-load')?.addEventListener('click', () => void fetchMemos());
  document.getElementById('dismiss-key-prompt')?.addEventListener('click', () => {
    state.needsKeyPrompt = false;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.chip ?? '';
      state.filterTag = tag === '' ? null : tag;
      // A chip tap also pre-fills the tag input — dumping 5 questions for one visit tags once.
      state.tagDraft = tag;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-check]').forEach((btn) => {
    btn.addEventListener('click', () => void toggleMemo(btn.dataset.check ?? '', 'done'));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-undo]').forEach((btn) => {
    btn.addEventListener('click', () => void toggleMemo(btn.dataset.undo ?? '', 'active'));
  });
}

let toastTimer: number | null = null;
function showToast(message: string): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

// ── Boot ────────────────────────────────────────────────────────────────────

// isLoggedIn() is sync and cheap — used only to pick the first paint (the async token check in
// fetchMemos() is the real gate), so a stale session still resolves to the honest state.
if (!IS_TEST_DB && !isLoggedIn()) {
  state.load = 'logged-out';
  render();
} else {
  void fetchMemos();
}
