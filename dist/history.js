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
//         NO mass-wipe primitive on purpose (v34): logged in, pruneSyncedLocal has already dropped
//         every synced copy, so this buffer holds ONLY notes that reached nowhere else — wiping it
//         destroyed exactly what had no backup. "Clear" is now an Undo-able server-side ARCHIVE
//         (app.ts archiveRows); per-note local delete is deleteCapture.
// NEXT:   none — stable. If history ever needs cross-device, that's an authed read surface.
import { saveCapture } from './supabase.js';
const HISTORY_KEY = 'vc.history';
const MAX_ITEMS = 200;
function newId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    }
    catch {
        // fall through to the timestamp id below
    }
    return `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
/** Read the full history (newest first). Returns [] on any parse/storage error. */
export function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter(isHistoryItem);
    }
    catch {
        return [];
    }
}
function saveHistory(items) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
    }
    catch {
        // Storage full / disabled: nothing more we can do here. The in-memory list the
        // caller holds is still correct for this session; we fail quiet, not loud.
    }
}
function isHistoryItem(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    return (typeof v.id === 'string' &&
        typeof v.transcript === 'string' &&
        typeof v.createdAt === 'string' &&
        typeof v.synced === 'boolean');
}
/**
 * Append a new transcript to local history (newest first) and return the created item.
 * Writes to localStorage immediately — this is the never-lose-it guarantee. Syncing is
 * the caller's next step (addCapture does NOT touch the network).
 */
export function addCapture(transcript, durationSeconds, source = 'voice', reply) {
    const item = {
        id: newId(),
        transcript,
        createdAt: new Date().toISOString(),
        durationSeconds,
        synced: false,
        source,
    };
    if (reply && reply.replyTo) {
        item.replyTo = reply.replyTo;
        item.replySnippet = reply.replySnippet;
        if (reply.sessionId)
            item.sessionId = reply.sessionId;
    }
    const items = loadHistory();
    items.unshift(item);
    saveHistory(items);
    return item;
}
/** Remove one item from local history (localStorage only — never touches Supabase). */
export function deleteCapture(id) {
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
export function setCategory(id, category) {
    const items = loadHistory();
    const item = items.find((i) => i.id === id);
    if (!item)
        return null;
    if (category === 'todo' || category === 'thought') {
        item.category = category;
    }
    else {
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
 *
 * v34 — race-proofed, three ways. The old version could ERASE a note captured mid-sync: it
 * wrote its whole stale snapshot back over the store after awaiting the network, wiping any
 * item addCapture had added meanwhile (gone locally, never sent — with "Saved ✓" already shown).
 *  1. SINGLE-FLIGHT: a second call while one is running returns the same promise, so two loops
 *     can never double-send the same items.
 *  2. MARK-BY-ID: each success re-reads the live store and flips just that id — a stale snapshot
 *     is never written back, so a mid-sync capture survives.
 *  3. IDEMPOTENT SEND: the item's UUID rides as the row id, so a retry of a send whose response
 *     was lost 409s server-side instead of duplicating the note in Claude's inbox.
 */
let syncInFlight = null;
export function syncPending() {
    if (syncInFlight)
        return syncInFlight;
    syncInFlight = doSyncPending().finally(() => {
        syncInFlight = null;
    });
    return syncInFlight;
}
async function doSyncPending() {
    // Snapshot is for ITERATION only — never written back (see markSynced).
    const items = loadHistory();
    let syncedCount = 0;
    for (const item of items) {
        if (item.synced)
            continue;
        try {
            const reply = item.replyTo != null
                ? {
                    replyTo: item.replyTo,
                    replySnippet: item.replySnippet ?? '',
                    sessionId: item.sessionId ?? null,
                }
                : undefined;
            await saveCapture(item.transcript, item.durationSeconds, item.category, item.source, reply, item.id);
            markSynced(item.id);
            syncedCount++;
        }
        catch (err) {
            // 23503 = this is a REPLY whose parent note was deleted server-side (Claude consumed it /
            // a purge). The insert was rejected and always will be — retrying forever would strand the
            // note unsynced until the phone buffer eventually dropped it. Strip the dead thread context
            // (fresh-read write, same discipline as markSynced) so the NEXT sync pass delivers it as a
            // plain capture: the transcript survives, only the threading is lost.
            if (err.pgCode === '23503' && item.replyTo != null) {
                stripReplyContext(item.id);
            }
            // Anything else (offline / Supabase down): leave it unsynced for the next attempt.
        }
    }
    return syncedCount;
}
/** Remove the reply-thread fields from ONE stored item (its parent note no longer exists), so it
 *  can sync as a plain capture. Fresh read → targeted write — never touches other items. */
function stripReplyContext(id) {
    const items = loadHistory();
    const item = items.find((i) => i.id === id);
    if (item && item.replyTo != null) {
        delete item.replyTo;
        delete item.replySnippet;
        delete item.sessionId;
        saveHistory(items);
    }
}
/** Flip ONE item to synced against the CURRENT store (fresh read → targeted write). This is the
 *  only write syncPending ever makes, so notes captured while a send was in flight are untouched. */
function markSynced(id) {
    const items = loadHistory();
    const item = items.find((i) => i.id === id);
    if (item && !item.synced) {
        item.synced = true;
        saveHistory(items);
    }
}
/**
 * After a successful logged-in inbox read, drop every local copy that has already SYNCED. Once a
 * note reaches the inbox the server copy is the single source of truth: if it's still pending it
 * shows via the remote read, and if Claude has filed it it's simply gone — either way the local
 * duplicate is just clutter. This is what makes the Log IDENTICAL on every logged-in device (it
 * shows the shared inbox) and makes a filed note vanish from the phone. UNSYNCED notes (not yet
 * delivered) are always kept as the offline buffer. Returns the number of local copies dropped.
 */
export function pruneSyncedLocal() {
    const items = loadHistory();
    const kept = items.filter((i) => !i.synced);
    const pruned = items.length - kept.length;
    if (pruned > 0)
        saveHistory(kept);
    return pruned;
}
