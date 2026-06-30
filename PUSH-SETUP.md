# Push notifications — setup + handoff (v15, STAGED)

**What this is:** the remaining manual steps to turn on "Notes from Claude" push notifications. The
app code, the service-worker handlers, the `push_subscriptions` table, and the `send-push` Edge
Function are all BUILT and shipped on the `v15-notes-redesign` branch. Push is fully optional and
inert until these steps are done — it can never break the core capture app.

**Why staged:** GitHub Pages is static and can't send a push; only a Supabase Edge Function can. And
the final on/off is a user gesture on Allison's own phone (browser permission). So the last mile
needs (1) the Edge Function deployed + secrets set, (2) a Database Webhook wired, (3) her tapping
"🔔 Notify me" on her Pixel.

---

## What's already done (in code / in the DB)

- **`push_subscriptions` table** — created with RLS (anon INSERT-only, authenticated SELECT/DELETE)
  and the GRANT block. (Applied via the Management API.)
- **Client subscribe flow** — `push.ts` + a "🔔 Notify me" card in Settings. On tap (user gesture)
  it asks permission, subscribes via the SW `PushManager` with the VAPID **public** key, and upserts
  the subscription (idempotent on `endpoint`).
- **Service worker** — `push` + `notificationclick` handlers in `sw.js` (gentle copy, no badge
  counter, coalesced by `tag`). Tap → focuses/opens the app.
- **Edge Function** — `supabase/functions/send-push/index.ts` (Deno, `jsr:@negrel/webpush`), guarded
  to `from_claude === true`, prunes dead subscriptions, never 500s the webhook.
- **VAPID keypair** — generated. The **public** key is in `push.ts` + the Edge Function secrets. The
  **private** key lives ONLY in the gitignored `supabase/.env.push-secrets` (never committed — this
  repo is public).

## Step 1 — deploy the Edge Function (needs the Supabase CLI)

From the repo root, with the CLI logged in (`supabase login`):

```bash
supabase functions deploy send-push --project-ref hpiyvnfhoqnnnotrmwaz
```

## Step 2 — set the secrets

The values are in `supabase/.env.push-secrets` (gitignored). Set them on the project:

```bash
# Generate a long random webhook secret first (the function fails closed without it):
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "$WEBHOOK_SECRET"   # save this — you paste it into the webhook header in Step 3

supabase secrets set --project-ref hpiyvnfhoqnnnotrmwaz \
  VAPID_PUBLIC_KEY=<from supabase/.env.push-secrets> \
  VAPID_PRIVATE_KEY=<from supabase/.env.push-secrets> \
  VAPID_SUBJECT=mailto:allisonecalt@gmail.com \
  PUSH_WEBHOOK_SECRET="$WEBHOOK_SECRET"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — don't set those.

`PUSH_WEBHOOK_SECRET` authenticates the webhook: the function is a public URL, so it rejects (401)
any request that doesn't carry the matching `x-webhook-secret` header — a random POST to the function
URL can't fire pushes. `supabase/config.toml` pins `verify_jwt = false` for the function (a DB
Webhook doesn't send a user JWT — the shared secret is the auth).

## Step 3 — wire the Database Webhook (fires the function on a new Claude note)

In the Supabase dashboard → **Database → Webhooks → Create a new hook**:

- **Table:** `voice_captures`
- **Events:** `INSERT` only
- **Type:** Supabase Edge Function → `send-push`
- **Method:** `POST`
- **HTTP Headers:** add `x-webhook-secret` = the `WEBHOOK_SECRET` you generated in Step 2. Without a
  matching header the function returns 401 and sends nothing (it fails closed).

(The function itself re-checks `from_claude === true`, so even if the webhook fires on every insert,
only Claude notes notify — her own captures never buzz her phone.)

Optional: scope the webhook to `from_claude=true` rows if the dashboard exposes a filter — belt and
suspenders, but the function already guards it.

## Step 4 — HER one step: turn it on + test (on the Pixel)

1. Open the app on her Pixel (installed PWA), go to **Settings → Notes from Claude → 🔔 Notify me**,
   and accept the browser permission prompt. The button flips to "✓ Notifications on".
2. Test: have Claude push a note (`scripts/push-claude-note.py` writes a `from_claude=true` row) →
   the webhook fires `send-push` → a gentle notification arrives. Tapping it opens her Log.

## Verifying / debugging

- Confirm a subscription was stored: it's a row in `push_subscriptions` (anon can't read it back; use
  the service key or the dashboard).
- Edge Function logs: `supabase functions logs send-push --project-ref hpiyvnfhoqnnnotrmwaz`.
- A returned `{ sent: N }` is success; `{ sent: 0, note: "no subscriptions" }` means Step 4 hasn't
  happened yet.

## Rotating the VAPID keys (if ever needed)

Regenerate BOTH halves together (they're a pair), update `VAPID_PUBLIC_KEY` in `push.ts` **and** the
Edge Function secrets, redeploy, and have her re-subscribe (the old subscription is invalidated).
