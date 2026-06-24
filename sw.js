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

const VERSION = 'voice-capture-v13';
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
