// supabase/functions/send-push/index.ts — Web Push sender (v15 push, STAGED)
//
// WHAT: a Supabase Edge Function (Deno) that, on a `voice_captures` INSERT where from_claude=true,
//       sends a gentle Web Push to every stored device subscription. GitHub Pages is static and
//       can't push — this function is the one non-static piece. It is fired by a Database Webhook
//       (HTTP request on INSERT); see PUSH-SETUP.md for wiring it.
//
// WHY:  a "Note from Claude" should arrive as a welcome, not a nag (her anti-shame register): quiet
//       copy, no badge counts, no "UNREAD". Only from_claude rows notify — her own captures never
//       buzz her own phone.
//
// SECRETS (set via `supabase secrets set` — NEVER commit these):
//   VAPID_KEYS         — the ExportedVapidKeys JSON: {"publicKey":<JWK>,"privateKey":<JWK>}. This is
//                        what @negrel/webpush importVapidKeys() expects (JWK objects, ONE JSON blob —
//                        NOT two base64url strings). The matching client applicationServerKey (the
//                        base64url public point in push.ts) is derived from the SAME keypair.
//   VAPID_SUBJECT      — a mailto: or https: contact (e.g. mailto:allisonecalt@gmail.com)
//   PUSH_WEBHOOK_SECRET — a long random string; the DB Webhook must send it as the
//                         `x-webhook-secret` header. The function FAILS CLOSED (401) without it, so a
//                         random POST to the public function URL can't fire pushes to every device.
//   SUPABASE_URL       — auto-injected by the platform
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected; used to read push_subscriptions
//
// DECIDED: guarded to from_claude===true (no self-notifications); dead subscriptions (410/404) are
//          pruned; failures are logged but never 500 the webhook (a push failure must not block the
//          insert). One push per note, coalesced by tag on the device.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import * as webpush from 'jsr:@negrel/webpush';

interface VoiceCaptureRow {
  id: string;
  title: string | null;
  transcript: string | null;
  from_claude: boolean | null;
  audio_url: string | null;
}

// Supabase Database Webhook payload shape (INSERT).
interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: VoiceCaptureRow | null;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Constant-time string compare — avoids leaking the secret via response-timing. Length-mismatch
 *  still folds into the constant-time loop (compared against itself) so it never early-returns. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Webhook authentication: a public Edge Function URL is callable by anyone, so without a check a
  // direct POST could fire pushes to every subscriber. Require a shared secret that ONLY the DB
  // Webhook knows (set it as a custom header on the hook; store it as the PUSH_WEBHOOK_SECRET
  // secret). Compared in constant time. If the secret isn't configured we FAIL CLOSED (401) rather
  // than silently trust the body — push is staged, so a missing secret means "not wired yet".
  const expected = Deno.env.get('PUSH_WEBHOOK_SECRET');
  const provided = req.headers.get('x-webhook-secret') ?? req.headers.get('X-Webhook-Secret') ?? '';
  if (!expected || !timingSafeEqual(expected, provided)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: WebhookPayload;
  try {
    payload = (await req.json()) as WebhookPayload;
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const row = payload.record;
  // Guard: only NEW Claude notes notify. Her own captures (from_claude=false) never buzz her.
  if (payload.type !== 'INSERT' || !row || row.from_claude !== true) {
    return json({ skipped: 'not a from_claude insert' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('id,endpoint,p256dh,auth');
  if (error) {
    console.error('[send-push] read subscriptions failed:', error.message);
    return json({ error: 'read subscriptions failed' }, 200); // 200 so the webhook isn't retried forever
  }
  if (!subs || subs.length === 0) return json({ sent: 0, note: 'no subscriptions' });

  // Build the VAPID application server from the secrets. importVapidKeys() takes the ExportedVapidKeys
  // shape ({publicKey: JWK, privateKey: JWK}) as ONE object — stored as the VAPID_KEYS JSON secret and
  // parsed here. (Two separate base64url env strings do NOT work with this library.)
  const vapidKeysJson = Deno.env.get('VAPID_KEYS');
  if (!vapidKeysJson) {
    console.error('[send-push] VAPID_KEYS secret is not set');
    return json({ error: 'push not configured' }, 200); // 200 so the webhook isn't retried forever
  }
  let exportedVapidKeys: { publicKey: JsonWebKey; privateKey: JsonWebKey };
  try {
    exportedVapidKeys = JSON.parse(vapidKeysJson) as {
      publicKey: JsonWebKey;
      privateKey: JsonWebKey;
    };
  } catch {
    console.error('[send-push] VAPID_KEYS is not valid JSON');
    return json({ error: 'push misconfigured' }, 200);
  }
  const appServer = await webpush.ApplicationServer.new({
    contactInformation: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:allisonecalt@gmail.com',
    vapidKeys: await webpush.importVapidKeys(exportedVapidKeys, { extractable: false }),
  });

  const isVoice = !!row.audio_url;
  const subject = (row.title ?? '').trim();
  const kind = isVoice ? 'Voice note' : 'Memo';
  const notification = {
    // Lead with the SUBJECT so she knows which session/topic just arrived (her ask: "notifications
    // should tell me which thing came in"). Fall back to the gentle generic copy when there's no title.
    title: subject || 'A new note from Claude',
    body: subject
      ? `${kind} from Claude · tap to open it`
      : isVoice
        ? 'A voice note is waiting — whenever you want it, no rush.'
        : 'Claude left you a note — whenever you want it, no rush.',
    // Per-note tag so distinct notes don't coalesce into one — she wants to see each subject.
    tag: `note-${row.id}`,
    // Deep-link straight to THIS note (her ask: "tapping takes me right to it").
    url: `./index.html?note=${row.id}`,
  };
  const message = new TextEncoder().encode(JSON.stringify(notification));

  let sent = 0;
  const dead: string[] = [];
  for (const s of subs as SubscriptionRow[]) {
    try {
      const subscriber = appServer.subscribe({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      });
      await subscriber.pushMessage(message, {});
      sent++;
    } catch (err) {
      // 404/410 = the subscription is gone (uninstalled / expired) → prune it.
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 410) dead.push(s.id);
      else console.error('[send-push] push failed for', s.id, err);
    }
  }

  if (dead.length) {
    await supabase.from('push_subscriptions').delete().in('id', dead);
  }

  return json({ sent, pruned: dead.length });
});
