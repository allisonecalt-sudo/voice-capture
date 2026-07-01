// sw.js — Voice Capture service worker
// WHAT: caches the static shell so the app opens instantly / offline. There is NO data
//       to cache (no backend, no DB) — the only network call is the live Gemini POST,
//       which is deliberately passthrough (never cached, never intercepted).
// WHY:  Allison installs this as a PWA on her Pixel; the shell should boot offline. But
//       a transcription must always hit the live API with her current key.
// DECIDED: code (HTML + dist/app.js + modules) network-first so a stale build can't
//          strand her; CSS/icons/manifest cache-first. generativelanguage.googleapis.com
//          is never touched by the SW.
// ALSO:   Web Share Target — a WhatsApp voice note shared into the app POSTs to ./share-target;
//          the SW catches that POST, parks the file in SHARE_CACHE, and redirects to ?shared=1
//          (GitHub Pages has no server to receive the POST itself).
// BUILT:  install/activate/fetch with the two strategies above + handleShareTarget().
// NEXT:   bump VERSION when shipping a new build.

const VERSION = 'voice-capture-v27';
const SHELL_CACHE = `${VERSION}-shell`;

// Web Share Target hand-off cache. When a voice note is shared INTO the app (Android:
// long-press a WhatsApp voice note → Share → Voice Capture), GitHub Pages has no server to
// POST to — so this SW catches the POST, stashes the audio file here, and redirects the app
// to ?shared=1, which reads it back out. Fixed name (NOT version-suffixed) so the page can
// always find it; explicitly preserved across activate() cache cleanup below.
const SHARE_CACHE = 'voice-capture-share';
const SHARE_ITEM_KEY = 'shared-audio';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './dist/app.js',
  './dist/wav.js',
  './dist/gemini.js',
  './dist/supabase.js',
  './dist/history.js',
  './dist/push.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Individual adds so one missing asset doesn't abort the whole install.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache shell asset', url, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Keep the current shell cache AND the share hand-off cache; drop stale shells.
      await Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Web Push (v15, STAGED) ────────────────────────────────────────────────────
// A "Note from Claude" arrives as a gift, never a nag (her anti-shame register): gentle copy,
// no badge counter, no "UNREAD". The push payload is sent by the Supabase Edge Function
// `send-push` (which holds the VAPID private key) on a from_claude row INSERT. The SW just shows
// it. Both handlers are inert until she taps "Notify me" in the app and a subscription exists —
// they never affect the core capture flow.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON / empty payload — fall back to the gentle default below.
  }
  const title = data.title || 'A new note from Claude';
  const body = data.body || 'It’s waiting whenever you want it — no rush.';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      // A quiet tag so repeated notes coalesce rather than stack into a guilt pile.
      tag: data.tag || 'note-from-claude',
      renotify: false,
      data: { url: data.url || './index.html' },
    })
  );
});

// Tapping the notification opens (or focuses) the app — straight to her Log.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './index.html';
  const targetUrl = new URL(target, self.registration.scope).href;
  const noteId = new URL(targetUrl).searchParams.get('note');
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          await client.focus();
          // The app may already be running (past boot), so the URL param alone won't fire — tell it
          // live which note to open so it switches to the right tab + scrolls to that card.
          if (noteId) client.postMessage({ type: 'open-note', id: noteId });
          return;
        }
      }
      // No window open → cold-start at the deep link; the app reads ?note= on boot.
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })()
  );
});

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith(self.registration.scope.replace(self.location.origin, ''));
}

// Code = the HTML document + the app bundle/modules. Kept fresh when online so a
// stale cached build can't strand the app. CSS/icons stay cache-first.
function isCodeRequest(url, request) {
  if (request.mode === 'navigate') return true;
  return (
    url.pathname.endsWith('/dist/app.js') ||
    url.pathname.endsWith('/dist/wav.js') ||
    url.pathname.endsWith('/dist/gemini.js') ||
    url.pathname.endsWith('/dist/supabase.js') ||
    url.pathname.endsWith('/dist/history.js') ||
    url.pathname.endsWith('/dist/push.js') ||
    url.pathname.endsWith('/index.html')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Web Share Target: a shared voice note arrives as a multipart POST to ./share-target.
  // Catch it, stash the file, and redirect into the app — must run BEFORE the GET-only guard.
  if (request.method.toUpperCase() === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method.toUpperCase() !== 'GET') return; // Gemini POST etc. passthrough

  // Never intercept the Gemini API — always live.
  if (url.hostname.endsWith('generativelanguage.googleapis.com')) return;

  if (isShellRequest(url)) {
    if (isCodeRequest(url, request)) {
      event.respondWith(handleCodeNetworkFirst(request));
    } else {
      event.respondWith(handleShell(request));
    }
  }
});

async function handleCodeNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

// Web Share Target receiver. Reads the shared audio file out of the multipart POST, parks it
// in SHARE_CACHE under a known key (with its original mime + filename in headers so the app can
// pick the right Gemini audio type), then 303-redirects so the browser turns the POST into a GET
// navigation to ./index.html?shared=1. The app's ingestSharedAudio() takes it from there.
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('audio');
    if (file && typeof file !== 'string') {
      const cache = await caches.open(SHARE_CACHE);
      const headers = new Headers();
      headers.set('Content-Type', file.type || 'application/octet-stream');
      headers.set('X-Shared-Filename', encodeURIComponent(file.name || 'voice-note'));
      await cache.put(SHARE_ITEM_KEY, new Response(file, { headers }));
    }
  } catch (err) {
    // Malformed share / cache failure: fall through to the redirect; the app will simply
    // find nothing to ingest rather than getting stranded on a dead POST.
    console.warn('[SW] share-target ingest failed', err);
  }
  const redirectUrl = new URL('index.html?shared=1', self.registration.scope).href;
  return Response.redirect(redirectUrl, 303);
}

async function handleShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) {
    fetch(request)
      .then((res) => {
        if (res && res.ok) cache.put(request, res.clone());
      })
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}
