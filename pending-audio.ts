// pending-audio.ts — durable hold for a recording whose transcription FAILED
// WHAT: a tiny IndexedDB store (audio blobs are megabytes — localStorage can't hold them) that
//       keeps the most recent failed recording so it SURVIVES the app being closed or evicted.
// WHY:  v34 fix — the app used to say "your recording is safe — try again" while holding the
//       audio only in a state variable. Android evicts backgrounded PWAs constantly, so switching
//       to WhatsApp could destroy the recording right after the app promised the opposite. Voice
//       is Allison's main input; a failed transcription must never cost the audio. Now the words
//       are true: the blob lands here the moment transcription fails, and boot offers it back.
// DECIDED: ONE slot (a newer failure replaces an older one — the rare double-failure keeps the
//          newest, and the download escape exists before that point). Cleared on transcription
//          success or explicit Discard. Every function swallows storage errors and returns a
//          harmless value — a broken IndexedDB must never break capture itself.
// BUILT:  storePendingAudio, loadPendingAudio, clearPendingAudio.
// NEXT:   none — if multi-item recovery is ever wanted, key by id instead of the fixed slot.

const DB_NAME = 'vc-pending-audio';
const DB_VERSION = 1;
const STORE = 'pending';
const SLOT_KEY = 'latest';

export interface PendingAudioRecord {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  source: 'voice' | 'whatsapp';
  failedAt: string; // ISO — shown so she knows WHICH recording this is
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/** Persist the failed recording (replaces any older one). Never throws. */
export async function storePendingAudio(record: PendingAudioRecord): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, SLOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    });
    db.close();
  } catch (err) {
    // Storage broken/full: the in-memory copy still exists this session; nothing more we can do.
    console.warn('[pending-audio] store failed:', err);
  }
}

/** Read back the held recording, or null. Never throws. */
export async function loadPendingAudio(): Promise<PendingAudioRecord | null> {
  try {
    const db = await openDb();
    const record = await new Promise<PendingAudioRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(SLOT_KEY);
      req.onsuccess = () => resolve((req.result as PendingAudioRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
    });
    db.close();
    if (record && record.blob instanceof Blob && typeof record.mimeType === 'string') {
      return record;
    }
    return null;
  } catch (err) {
    console.warn('[pending-audio] load failed:', err);
    return null;
  }
}

/** Drop the held recording (transcription succeeded, or she chose Discard). Never throws. */
export async function clearPendingAudio(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(SLOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
    });
    db.close();
  } catch (err) {
    console.warn('[pending-audio] clear failed:', err);
  }
}
