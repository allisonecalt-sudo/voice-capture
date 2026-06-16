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

interface CapturePayload {
  transcript: string;
  source: CaptureSource;
  duration_seconds?: number;
  category?: Category;
}

/**
 * POST one transcript to the voice_captures inbox. Insert-only: anon has no SELECT, so we send
 * `Prefer: return=minimal` and read nothing back (asking for the row back would 401). The
 * routing tag — when set — is part of THIS insert, because there is no later update path.
 * @param transcript       the verbatim text to send to Claude (required, non-empty)
 * @param durationSeconds  optional recording length; omitted from the body when undefined
 * @param category         optional routing tag ('todo' | 'thought'); omitted when undefined
 * @throws on any non-2xx (or network failure) so the caller can mark it "will sync".
 */
export async function saveCapture(
  transcript: string,
  durationSeconds?: number,
  category?: Category,
  source: CaptureSource = 'voice'
): Promise<void> {
  const payload: CapturePayload = { transcript, source };
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    payload.duration_seconds = Math.round(durationSeconds);
  }
  if (category === 'todo' || category === 'thought') {
    payload.category = category;
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
