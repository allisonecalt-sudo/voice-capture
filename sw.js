// sw.js — Voice Capture service worker
// WHAT: caches the static shell so the app opens instantly / offline. There is NO data
//       to cache (no backend, no DB) — the only network call is the live Gemini POST,
//       which is deliberately passthrough (never cached, never intercepted).
// WHY:  Allison installs this as a PWA on her Pixel; the shell should boot offline. But
//       a transcription must always hit the live API with her current key.
// DECIDED: code (HTML + dist/app.js + modules) network-first so a stale build can't
//          strand her; CSS/icons/manifest cache-first. generativelanguage.googleapis.com
//          is never touched by the SW.
// BUILT:  install/activate/fetch with the two strategies above.
// NEXT:   bump VERSION when shipping a new build.

const VERSION = 'voice-capture-v2';
const SHELL_CACHE = `${VERSION}-shell`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './dist/app.js',
  './dist/wav.js',
  './dist/gemini.js',
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
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
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
    url.pathname.endsWith('/index.html')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method.toUpperCase() !== 'GET') return; // Gemini POST etc. passthrough
  const url = new URL(request.url);

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
