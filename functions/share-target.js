// functions/share-target.js — server-side Web Share Target receiver (Cloudflare Pages Function)
//
// WHAT: accepts the multipart POST that Android sends when Allison shares a WhatsApp voice note
//       into the app, and hands the audio to the client through the SAME cache slot the service
//       worker uses — so index.html's ingestSharedAudio() picks it up completely unchanged.
//
// WHY:  the share-in path only ever worked because sw.js intercepted the POST. GitHub Pages is a
//       static host and answers every POST with a bare "405 Not Allowed", so the moment Android
//       evicted the worker, sharing a voice note in dead-ended on an nginx error page (2026-08-26).
//       v34.3 (persistent storage) made eviction rare and v34.3b made it announce itself, but
//       neither removes the dependency: no worker, no share. A host that can actually RECEIVE the
//       POST does remove it.
//
// WHY NOT AN EDGE FUNCTION ELSEWHERE: the Web Share Target spec pins share_target.action inside
//       the manifest's own scope — "If action is not within scope of scope URL … return undefined"
//       (https://w3c.github.io/web-share-target/level-2/), and an out-of-scope action discards the
//       whole share_target, so the app stops appearing in the share sheet at all. The POST can
//       never be aimed at another origin. It has to be handled by whoever serves the app. Hence a
//       Pages Function rather than the Supabase edge function first proposed.
//
// HOW THE HANDOFF WORKS: a server cannot write the browser's CacheStorage, so this responds with a
//       tiny HTML page that does it — decode the audio, cache.put() it under the exact key sw.js
//       uses, then replace() into index.html?shared=1. The audio rides inline as base64 because the
//       POST body is the only copy that exists (no KV/R2 binding required, nothing to provision).
//       Typical WhatsApp voice notes are tens to hundreds of KB; the app's own ceiling is 10 MB.
//
// LAYERED, NOT REPLACING: sw.js still catches the POST whenever the worker is alive, and wins —
//       it never touches the network. This is the floor underneath it, for when the worker is gone.
//
// INERT ON GITHUB PAGES: Pages Functions only execute on Cloudflare. While the app is served from
//       github.io this file is just an unused static asset, so it can ship safely before any
//       migration and changes nothing about the current deploy.

// Same constants as sw.js — these three MUST stay in sync with it or the handoff silently misses.
const SHARE_CACHE = 'voice-capture-share';
const SHARE_ITEM_KEY = 'shared-audio';
const REDIRECT_TO = 'index.html?shared=1';

// btoa() takes a binary string, and String.fromCharCode(...bytes) blows the stack on a large
// spread — so walk the buffer in chunks. 0x8000 is the usual safe argument count.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// JSON.stringify handles quotes/backslashes; the escapes below stop a "</script>" or a U+2028 in
// a filename from breaking out of the inline script.
function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Nothing usable in the POST (empty share, wrong field name, a text-only share): do NOT strand her
// on an error page. Send her into the app, which finds no cached item and simply opens normally.
function bounceToApp() {
  return new Response(null, { status: 303, headers: { Location: REDIRECT_TO } });
}

function handoffPage(base64Audio, mimeType, filename) {
  // No ?shared=1 on THIS page — the flag goes on the redirect, so a reload of the app can't
  // re-trigger an ingest that already consumed the cache entry.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Adding your note…</title>
<style>
  html { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
         justify-content: center; background: #15171a;
         color: rgba(255,255,255,0.6);
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
</style>
</head>
<body>
<p>Adding your note…</p>
<script>
(async function () {
  var CACHE = ${jsString(SHARE_CACHE)};
  var KEY = ${jsString(SHARE_ITEM_KEY)};
  var NEXT = ${jsString(REDIRECT_TO)};
  try {
    var binary = atob(${jsString(base64Audio)});
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var type = ${jsString(mimeType)};
    // Resolve the key against THIS page so it lands on the same cache URL index.html reads.
    // Both live at the site root on Cloudflare Pages, so they agree.
    var url = new URL(KEY, location.href).href;
    var cache = await caches.open(CACHE);
    await cache.put(url, new Response(new Blob([bytes], { type: type }), {
      headers: {
        'Content-Type': type || 'application/octet-stream',
        'X-Shared-Filename': encodeURIComponent(${jsString(filename)})
      }
    }));
  } catch (err) {
    // Cache unavailable / quota / decode failure: fall through to the app rather than dead-end.
    // The app finds nothing to ingest and opens normally — the note is lost, but she is not stuck,
    // and she still has the original in WhatsApp to share again.
    console.warn('[share-target] handoff failed', err);
  }
  location.replace(NEXT);
})();
</script>
</body>
</html>`;
}

export async function onRequestPost(context) {
  let file;
  try {
    const form = await context.request.formData();
    file = form.get('audio');
  } catch {
    return bounceToApp(); // malformed multipart
  }
  if (!file || typeof file === 'string') return bounceToApp();

  let base64Audio;
  try {
    base64Audio = toBase64(await file.arrayBuffer());
  } catch {
    return bounceToApp();
  }

  return new Response(handoffPage(base64Audio, file.type || '', file.name || 'voice-note'), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The page carries her audio inline — never let anything keep a copy.
      'Cache-Control': 'no-store',
    },
  });
}

// A GET on /share-target means someone opened the URL directly (or a share arrived without a
// body). Send them into the app instead of showing a bare 405 — the exact failure this file exists
// to end.
export async function onRequestGet() {
  return bounceToApp();
}
