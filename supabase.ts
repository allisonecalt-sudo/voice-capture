// supabase.ts — send a finished transcript to Allison's Claude inbox (Supabase)
// WHAT: one function, saveCapture(), that POSTs a transcript row to the `voice_captures`
//       table over plain REST (fetch) — no supabase-js, no dependencies, like the rest of
//       the app. This is the "send to Claude" half: each saved transcript is a message
//       Claude reads and routes (to-do, food log, etc.).
// WHY:  copy-paste loses things; saving puts every note in one inbox that survives the
//       session. Dependency-free fetch keeps the app a single static bundle.
// DECIDED: anon key is the PUBLIC client key (safe to commit, exactly like the budget app);
//          RLS makes it INSERT-only, so it can't read anyone's data. Reads are blocked —
//          the in-app history list comes from localStorage, never from reading Supabase back.
//          Throw on any non-2xx so the caller can fall back to "saved on phone — will sync".
// BUILT:  SUPABASE_URL, SUPABASE_ANON_KEY constants + saveCapture().
// NEXT:   none — stable. If reads are ever needed, that's an authed surface, not this key.

// Public Supabase project endpoint for the voice_captures table. The anon key below is the
// PUBLIC client key — safe to ship in client code (same posture as the budget app). RLS on
// the table allows INSERT only for anon, so this key can never read or modify existing rows.
export const SUPABASE_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/voice_captures';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';

interface CapturePayload {
  transcript: string;
  source: 'voice';
  duration_seconds?: number;
}

/**
 * POST one transcript to the voice_captures inbox.
 * @param transcript       the verbatim text to send to Claude (required, non-empty)
 * @param durationSeconds  optional recording length; omitted from the body when undefined
 * @throws on any non-2xx (or network failure) so the caller can mark it "will sync".
 */
export async function saveCapture(transcript: string, durationSeconds?: number): Promise<void> {
  const payload: CapturePayload = { transcript, source: 'voice' };
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    payload.duration_seconds = Math.round(durationSeconds);
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
