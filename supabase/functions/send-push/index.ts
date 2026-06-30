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
//   VAPID_PUBLIC_KEY   — the public key shipped in push.ts (kept here too for the webpush lib)
//   VAPID_PRIVATE_KEY  — the PRIVATE half (secret; generated alongside the public key)
//   VAPID_SUBJECT      — a mailto: or https: contact (e.g. mailto:allisonecalt@gmail.com)
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

Deno.serve(async (req: Request): Promise<Response> => {
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

  // Build the VAPID application server from the secrets.
  const appServer = await webpush.ApplicationServer.new({
    contactInformation: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:allisonecalt@gmail.com',
    vapidKeys: await webpush.importVapidKeys(
      {
        publicKey: Deno.env.get('VAPID_PUBLIC_KEY')!,
        privateKey: Deno.env.get('VAPID_PRIVATE_KEY')!,
      },
      { extractable: false }
    ),
  });

  const isVoice = !!row.audio_url;
  const notification = {
    title: 'A new note from Claude',
    body: isVoice
      ? 'A voice note is waiting — whenever you want it, no rush.'
      : 'Claude left you a note — whenever you want it, no rush.',
    tag: 'note-from-claude',
    url: './index.html',
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
