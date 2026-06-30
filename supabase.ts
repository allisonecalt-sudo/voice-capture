// supabase.ts — send a finished transcript to Allison's Claude inbox (Supabase)
// WHAT: REST (fetch) helper for the `voice_captures` table — no supabase-js, no deps, like
//       the rest of the app. saveCapture() POSTs one transcript row (insert-only). This is the
//       "send to Claude" half: each saved transcript is a message Claude reads and routes, and
//       the category — set IN the insert — tells Claude HOW to route it (to-do → task list,
//       thought → thinking notes).
// WHY:  copy-paste loses things; saving puts every note in one inbox that survives the session.
//       Dependency-free fetch keeps the app a single static bundle.
// DECIDED: anon key is the PUBLIC client key (safe to commit, exactly like the budget app).
//          The anon role is INSERT-ONLY by privacy design — it has NO select, NO update, NO
//          delete on voice_captures (it can't read anyone's inbox back, and can't change a row
//          after the fact). Two hard consequences:
//            1) We CANNOT ask for the row back: `Prefer: return=representation` requires SELECT,
//               which anon lacks, so PostgREST 401s the insert. We use `return=minimal` and read
//               nothing back — saveCapture returns void.
//            2) The to-do/thought tag MUST be part of the single INSERT — there is no PATCH path
//               (a later UPDATE would need a SELECT policy to locate the row; anon has none). So
//               the tag is chosen on the result screen and the send is deferred until she leaves
//               it, guaranteeing the final tag rides along in the insert. (See history.ts /
//               app.ts.) Throw on any non-2xx so the caller can fall back to "saved — will sync".
// BUILT:  SUPABASE_URL, SUPABASE_ANON_KEY constants + saveCapture() (insert-only).
// NEXT:   none — stable. If reads/updates are ever needed, that's an authed surface, not this key.

// Public Supabase project endpoint for the voice_captures table. The anon key below is the
// PUBLIC client key — safe to ship in client code (same posture as the budget app). RLS on the
// table allows INSERT ONLY for anon (no select/update/delete), so this key can save a row but
// can never read, change, or delete existing rows.
export const SUPABASE_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/voice_captures';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';

// The routing tag Claude reads: 'todo' → her task list, 'thought' → her thinking notes,
// null/absent → unsorted (Claude decides). Mirrored onto each localStorage HistoryItem and set
// at insert time (anon can't change it afterward).
export type Category = 'todo' | 'thought';

// How the capture entered the app: a spoken+transcribed note ('voice') or one she typed
// straight in ('text'). Claude can treat them differently — typed text is trustworthy as-is,
// a voice transcript may carry mishears. Stored in the row's `source` column.
export type CaptureSource = 'voice' | 'text';

// A threaded voice/text reply to a "Note from Claude" (v15). `reply_to` is the parent row's id
// (self-FK on the table); `reply_snippet` is the first ~120 chars of that parent's text, carried
// along so Claude can sort the reply in context AND so her own reply card can show "↩ re: …"
// without a SELECT (anon can't read the parent back). One level deep — a reply is never replied-to.
export interface ReplyContext {
  replyTo: string;
  replySnippet: string;
}

interface CapturePayload {
  transcript: string;
  source: CaptureSource;
  duration_seconds?: number;
  category?: Category;
  reply_to?: string;
  reply_snippet?: string;
}

/**
 * POST one transcript to the voice_captures inbox. Insert-only: anon has no SELECT, so we send
 * `Prefer: return=minimal` and read nothing back (asking for the row back would 401). The
 * routing tag — and any reply context — is part of THIS insert, because there is no later update.
 * @param transcript       the verbatim text to send to Claude (required, non-empty)
 * @param durationSeconds  optional recording length; omitted from the body when undefined
 * @param category         optional routing tag ('todo' | 'thought'); omitted when undefined
 * @param source           how it entered the app ('voice' | 'text'); defaults to 'voice'
 * @param reply            optional thread context (parent id + snippet) when this is a reply
 * @throws on any non-2xx (or network failure) so the caller can mark it "will sync".
 */
export async function saveCapture(
  transcript: string,
  durationSeconds?: number,
  category?: Category,
  source: CaptureSource = 'voice',
  reply?: ReplyContext
): Promise<void> {
  const payload: CapturePayload = { transcript, source };
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    payload.duration_seconds = Math.round(durationSeconds);
  }
  if (category === 'todo' || category === 'thought') {
    payload.category = category;
  }
  if (reply && reply.replyTo) {
    payload.reply_to = reply.replyTo;
    payload.reply_snippet = reply.replySnippet;
  }

  const res = await fetch(SUPABASE_URL, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Supabase save failed: HTTP ${res.status}`);
  }
}

// One inbox row read BACK (authenticated SELECT). Mirrors the columns we insert plus the
// server-assigned id + created_at. Anon can't read these — this needs a logged-in token.
export interface RemoteCapture {
  id: string;
  transcript: string;
  source?: CaptureSource;
  category?: Category | null;
  duration_seconds?: number;
  created_at: string;
  // "Notes from Claude" extras (Claude-pushed rows): a voice-note URL she can play, a flag that
  // splits these from her own captures, and the have-I-heard-it state (shown as "✓ Listened").
  from_claude?: boolean;
  audio_url?: string | null;
  listened?: boolean;
  listened_at?: string | null;
  // v15: soft-archive (archived rows drop out of every view, never deleted — pullable later) +
  // threaded-reply context (parent id + the snippet shown as "↩ re: …" on her own reply card).
  archived?: boolean;
  reply_to?: string | null;
  reply_snippet?: string | null;
}

/**
 * Read recent inbox rows back (newest first). Authenticated-only: the anon RLS policy grants INSERT
 * but no SELECT, so this requires a valid login token. The READ is the "see it on every device"
 * half — it's how a note typed on the phone shows up on the computer.
 * @param token a valid access token from auth.getToken()
 * @param limit max rows to read (default 200, matching the local history cap)
 * @throws on any non-2xx so the caller can fall back to local-only history.
 */
export async function fetchRemoteCaptures(token: string, limit = 200): Promise<RemoteCapture[]> {
  // Archived rows (soft-deleted) are filtered server-side so they never reach any view. They still
  // exist in the table (pullable later); the app simply never reads them back.
  const url = `${SUPABASE_URL}?select=*&archived=eq.false&order=created_at.desc&limit=${limit}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Supabase read failed: HTTP ${res.status}`);
  }
  const rows = (await res.json()) as RemoteCapture[];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Mark one "Note from Claude" as listened (authenticated UPDATE). Anon is insert-only, so this
 * needs a login token — same surface as fetchRemoteCaptures. Sets `listened=true` + `listened_at`
 * so "✓ Listened" sticks across her devices. Throws on any non-2xx so the caller can stay quiet.
 * @param token a valid access token from auth.getToken()
 * @param id    the voice_captures row id to mark
 */
export async function markListened(token: string, id: string): Promise<void> {
  const url = `${SUPABASE_URL}?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ listened: true, listened_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`Supabase markListened failed: HTTP ${res.status}`);
  }
}

/**
 * Set a row's `archived` flag (authenticated UPDATE — anon is insert-only). Archiving is the app's
 * "delete": the row drops out of every view but is never destroyed (her "archive nicely, pullable"
 * rule), so the Undo snackbar can flip it straight back. Works on HER captures AND Claude's notes.
 * @param token a valid access token from auth.getToken()
 * @param id    the voice_captures row id
 * @param archived true to archive (hide), false to restore (Undo)
 */
async function setArchived(token: string, id: string, archived: boolean): Promise<void> {
  const url = `${SUPABASE_URL}?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) {
    throw new Error(`Supabase setArchived failed: HTTP ${res.status}`);
  }
}

/** Soft-archive a capture (hide it from every view; never deletes — pullable later). */
export function archiveCapture(token: string, id: string): Promise<void> {
  return setArchived(token, id, true);
}

/** Restore an archived capture back into view (the Undo of archive). */
export function unarchiveCapture(token: string, id: string): Promise<void> {
  return setArchived(token, id, false);
}
