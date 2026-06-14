// history.ts — local transcript history + Supabase sync retry + to-do/thought tagging
// WHAT: the localStorage-backed list of saved transcripts (newest first, capped), plus the
//       sync logic that pushes unsynced items to the voice_captures inbox and flips them to
//       synced. Each item also carries a routing tag (`category`: 'todo' | 'thought' | none).
//       The one rule: a transcript is ALWAYS written locally first, then synced — so an offline
//       phone never loses a note (or a tag).
// WHY:  anon RLS is INSERT-ONLY (can't read Supabase back, can't update it either), so the
//       in-app History view must come from localStorage. This module owns that store so app.ts
//       stays about UI/state and the Playwright tests can seed/inspect the store directly. The
//       category is how Claude routes the note (to-do → task list, thought → thinking notes).
// DECIDED: key = 'vc.history'; cap 200 (oldest dropped); each item carries `synced` so a failed
//          save just stays false and retries next load / next sync. id via crypto.randomUUID
//          with a timestamp fallback. createdAt = new Date().toISOString(). NO supabaseId is
//          kept — anon can't update a row after insert, so there's nothing to address later; the
//          tag rides along IN the INSERT body. The send is deferred (by app.ts) until she leaves
//          the result screen, so the final tag is the one that lands.
// BUILT:  HistoryItem type, load/save store, addCapture, deleteCapture, setCategory, syncPending.
// NEXT:   none — stable. If history ever needs cross-device, that's an authed read surface.

import { saveCapture, type Category } from './supabase.js';

const HISTORY_KEY = 'vc.history';
const MAX_ITEMS = 200;

export interface HistoryItem {
  id: string;
  transcript: string;
  createdAt: string; // ISO string (new Date().toISOString())
  durationSeconds?: number;
  synced: boolean;
  category?: Category; // routing tag: 'todo' | 'thought'; absent = unsorted
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the timestamp id below
  }
  return `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Read the full history (newest first). Returns [] on any parse/storage error. */
export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryItem);
  } catch {
    return [];
  }
}

function saveHistory(items: HistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    // Storage full / disabled: nothing more we can do here. The in-memory list the
    // caller holds is still correct for this session; we fail quiet, not loud.
  }
}

function isHistoryItem(value: unknown): value is HistoryItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.transcript === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.synced === 'boolean'
  );
}

/**
 * Append a new transcript to local history (newest first) and return the created item.
 * Writes to localStorage immediately — this is the never-lose-it guarantee. Syncing is
 * the caller's next step (addCapture does NOT touch the network).
 */
export function addCapture(transcript: string, durationSeconds?: number): HistoryItem {
  const item: HistoryItem = {
    id: newId(),
    transcript,
    createdAt: new Date().toISOString(),
    durationSeconds,
    synced: false,
  };
  const items = loadHistory();
  items.unshift(item);
  saveHistory(items);
  return item;
}

/** Remove one item from local history (localStorage only — never touches Supabase). */
export function deleteCapture(id: string): void {
  const items = loadHistory().filter((i) => i.id !== id);
  saveHistory(items);
}

/**
 * Set (or clear, with null) the routing tag on a local history item and return the updated
 * item (or null if no such item). LOCAL ONLY — writes localStorage and never touches the
 * network. There is no server-side update path (anon can't UPDATE): the tag reaches Supabase
 * only when this item is first sent, riding along in the INSERT body. So tagging a not-yet-sent
 * item before it syncs is fully captured; re-tagging an already-sent item updates only the phone
 * copy (known, accepted v0 limitation — the normal flow tags on the result screen before the
 * send, so the tag always lands).
 */
export function setCategory(id: string, category: Category | null): HistoryItem | null {
  const items = loadHistory();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  if (category === 'todo' || category === 'thought') {
    item.category = category;
  } else {
    delete item.category;
  }
  saveHistory(items);
  return item;
}

/**
 * Try to POST every unsynced item to Supabase (insert-only); flip each to synced on success.
 * The item's `category` rides along in the INSERT body so the tag lands WITH the row — there is
 * no later PATCH (anon can't update). Resilient by design: a failed item just stays unsynced and
 * is retried next time. Returns the number of items newly synced this pass.
 */
export async function syncPending(): Promise<number> {
  const items = loadHistory();
  let syncedCount = 0;
  for (const item of items) {
    if (item.synced) continue;
    try {
      await saveCapture(item.transcript, item.durationSeconds, item.category);
      item.synced = true;
      syncedCount++;
    } catch {
      // Offline / Supabase down: leave it unsynced for the next attempt.
    }
  }
  if (syncedCount > 0) saveHistory(items);
  return syncedCount;
}
