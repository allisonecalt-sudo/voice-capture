// history.ts — local transcript history + Supabase sync retry
// WHAT: the localStorage-backed list of saved transcripts (newest first, capped), plus the
//       sync logic that pushes unsynced items to the voice_captures inbox and flips them to
//       synced. The one rule: a transcript is ALWAYS written locally first, then synced —
//       so an offline phone never loses a note.
// WHY:  anon RLS is INSERT-only (can't read Supabase back), so the in-app History view must
//       come from localStorage. This module owns that store so app.ts stays about UI/state
//       and the Playwright tests can seed/inspect the store directly.
// DECIDED: key = 'vc.history'; cap 200 (oldest dropped); each item carries `synced` so a
//          failed save just stays false and retries next load / next save. id via crypto
//          .randomUUID with a timestamp fallback. createdAt = new Date().toISOString().
// BUILT:  HistoryItem type, load/save store, addCapture, deleteCapture, syncPending.
// NEXT:   none — stable. If history ever needs cross-device, that's an authed read surface.

import { saveCapture } from './supabase.js';

const HISTORY_KEY = 'vc.history';
const MAX_ITEMS = 200;

export interface HistoryItem {
  id: string;
  transcript: string;
  createdAt: string; // ISO string (new Date().toISOString())
  durationSeconds?: number;
  synced: boolean;
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
 * Try to POST every unsynced item to Supabase; flip each to synced on success.
 * Resilient by design: a failed item just stays unsynced and is retried next time.
 * Returns the number of items newly synced this pass.
 */
export async function syncPending(): Promise<number> {
  const items = loadHistory();
  let syncedCount = 0;
  for (const item of items) {
    if (item.synced) continue;
    try {
      await saveCapture(item.transcript, item.durationSeconds);
      item.synced = true;
      syncedCount++;
    } catch {
      // Offline / Supabase down: leave it unsynced for the next attempt.
    }
  }
  if (syncedCount > 0) saveHistory(items);
  return syncedCount;
}
