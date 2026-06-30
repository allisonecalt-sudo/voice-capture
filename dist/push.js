// push.ts — Web Push subscribe flow (v15, STAGED)
// WHAT: the client half of "🔔 Notify me" — on a user gesture, ask for notification permission,
//       subscribe via the service worker's PushManager with the app's VAPID PUBLIC key, and upsert
//       the resulting subscription into the `push_subscriptions` Supabase table (anon INSERT, same
//       posture as voice_captures). The SEND half is the Supabase Edge Function `send-push`, fired
//       by a Database Webhook on a from_claude row INSERT — see PUSH-SETUP.md.
// WHY:  GitHub Pages is static and can't push; only the Edge Function can. This module just makes a
//       device subscribable. It is fully OPTIONAL and inert until she taps the button — it never
//       touches the capture flow, so it can't break the core build.
// DECIDED: VAPID public key is safe to ship in client code (it's the PUBLIC half). The private key
//          lives ONLY as an Edge Function secret (never in the repo). Subscription rows are
//          insert-only for anon (a device can register itself but can't read the table back).
// BUILT:  isPushSupported(), pushPermission(), subscribeToPush() (gesture → permission → subscribe
//          → store). NEXT: nothing client-side — the remaining step is HER tapping the button on
//          her Pixel + the device test (see PUSH-SETUP.md).
import { SUPABASE_ANON_KEY } from './supabase.js';
// The app's VAPID PUBLIC key (safe to commit — it's the public half of the keypair). The matching
// PRIVATE key is an Edge Function secret, never stored here. Regenerate both together if rotated.
export const VAPID_PUBLIC_KEY = 'BNsy1DewJLGlZKsjkr0JRhebiUm4dW_C_861phjW8fX4w6bxJoz75xx_8w1xggxWz-GZvuIoWTD1ow0E6xOD9uo';
const SUBSCRIPTIONS_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/push_subscriptions';
/** True when this browser can do Web Push at all (Android Chrome: yes). */
export function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
/** Current notification permission ('granted' | 'denied' | 'default'), or 'unsupported'. */
export function pushPermission() {
    if (!isPushSupported())
        return 'unsupported';
    return Notification.permission;
}
/** Decode the URL-safe-base64 VAPID public key to the bytes PushManager wants. Backed by a fresh
 *  ArrayBuffer (not SharedArrayBuffer) so it satisfies the BufferSource type for applicationServerKey. */
function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(normalized);
    const buffer = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < raw.length; i++)
        view[i] = raw.charCodeAt(i);
    return buffer;
}
/** Read a subscription key (p256dh / auth) as URL-safe base64 for storage. */
function keyToBase64(sub, name) {
    const key = sub.getKey(name);
    if (!key)
        return '';
    const bytes = new Uint8Array(key);
    let bin = '';
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/**
 * The full subscribe flow — MUST be called from a user gesture (a button click) so the permission
 * prompt is allowed. Asks for permission, subscribes through the active service worker, and stores
 * the subscription. Returns a small result so the UI can show the right message.
 * @param userEmail optional — tags the row so a multi-device send can be scoped to her later.
 */
export async function subscribeToPush(userEmail) {
    if (!isPushSupported())
        return { ok: false, reason: 'unsupported' };
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted')
            return { ok: false, reason: 'denied' };
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const sub = existing ??
            (await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            }));
        const stored = await storeSubscription(sub, userEmail);
        // If the row didn't actually land, the device is NOT subscribed — report that honestly so the
        // UI never shows "✓ Notifications on" off a permission grant alone (a silent store failure used
        // to falsely latch the success state). 'error' lets the user retry.
        return stored ? { ok: true } : { ok: false, reason: 'error' };
    }
    catch (err) {
        console.warn('[push] subscribe failed:', err);
        return { ok: false, reason: 'error' };
    }
}
/** Store the subscription into Supabase (anon INSERT, insert-only — same posture as voice_captures).
 *  Returns true when the device is registered, false when the store failed (so the caller can report
 *  the truth instead of a permission-only optimistic "on").
 *
 *  NOTE: this is a PLAIN insert, NOT an upsert. The old `Prefer: resolution=merge-duplicates` path
 *  compiled to `ON CONFLICT DO UPDATE`, which PostgREST gates behind an anon UPDATE RLS policy the
 *  table deliberately doesn't have (anon is insert-only) — so every subscribe 401'd and no device
 *  was ever stored. `endpoint` is UNIQUE, so re-subscribing the same device returns HTTP 409; that
 *  means "already registered" → treat it as success (idempotent without needing an UPDATE policy). */
async function storeSubscription(sub, userEmail) {
    const body = {
        endpoint: sub.endpoint,
        p256dh: keyToBase64(sub, 'p256dh'),
        auth: keyToBase64(sub, 'auth'),
        user_email: userEmail ?? null,
    };
    const res = await fetch(SUBSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
        },
        body: JSON.stringify(body),
    });
    // 2xx = inserted; 409 = this device's endpoint is already on file (UNIQUE conflict) = already
    // subscribed. Both mean "registered". Anything else (401/403/5xx) is a real failure.
    if (res.ok || res.status === 409)
        return true;
    console.warn(`[push] subscription store failed: HTTP ${res.status}`);
    return false;
}
