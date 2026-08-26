// share-target.spec.ts — the server-side Web Share Target receiver (Cloudflare Pages Function)
// WHAT: drives functions/share-target.js directly in Node (Playwright's test runner IS Node, and
//       Node 20+ ships Request/FormData/Blob/btoa), so the handoff is verified without wrangler,
//       without Cloudflare, and without a browser.
// WHY:  this function is the floor under the share-in path — the thing that answers when the
//       service worker is gone. It ships INERT (GitHub Pages ignores functions/), which means
//       nothing else would catch a regression in it until the day it finally matters. Tests are
//       the only proof it works before that day.
// DECIDED: assert the CONTRACT, not the prose — the cache name + item key must equal sw.js's (a
//       silent drift there means the page caches the audio where the app never looks), a missing
//       file must bounce into the app rather than error, and a GET must never be a 405.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Paths off process.cwd() (Playwright runs from the repo root) rather than import.meta.url —
// touching import.meta flips this spec into ESM mode and breaks Playwright's own transpiled
// requires.
const FN_PATH = join(process.cwd(), 'functions', 'share-target.js');
const SW_PATH = join(process.cwd(), 'sw.js');

interface ShareTargetModule {
  onRequestPost(context: { request: Request }): Promise<Response>;
  onRequestGet(): Promise<Response>;
}

// Playwright's loader transpiles an imported .js as CommonJS, which chokes on this file's ESM
// `export` (Cloudflare requires the .js extension, so renaming it to .mjs would stop Pages from
// routing it). So evaluate the REAL source instead: strip the export keywords and hand back the
// two handlers. Still the shipped bytes under test — only the module wrapper is swapped.
function loadFn(): ShareTargetModule {
  const source = readFileSync(FN_PATH, 'utf-8').replace(/^export\s+/gm, '');
  const factory = new Function(
    `${source}\nreturn { onRequestPost, onRequestGet };`
  ) as () => ShareTargetModule;
  return factory();
}

function postWith(form: FormData): { request: Request } {
  return {
    request: new Request('https://example.test/share-target', { method: 'POST', body: form }),
  };
}

test.describe('share-target Pages Function', () => {
  test('a shared audio file comes back as a handoff page whose bytes survive the round trip', async () => {
    const fn = loadFn();
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42, 7]);
    const form = new FormData();
    form.append('audio', new Blob([original], { type: 'audio/ogg' }), 'PTT-20260826-WA0001.opus');

    const res = await fn.onRequestPost(postWith(form));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    // The page carries her audio inline — it must never be stored by a cache along the way.
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const html = await res.text();
    expect(html).toContain('index.html?shared=1');
    expect(html).toContain('PTT-20260826-WA0001.opus');
    expect(html).toContain('audio/ogg');

    // Pull the base64 back out of the inline script and prove it decodes to the same bytes.
    const match = html.match(/var binary = atob\("([A-Za-z0-9+/=]*)"\)/);
    expect(match, 'the handoff page must inline the audio as base64').not.toBeNull();
    const decoded = Buffer.from(match![1], 'base64');
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  test('cache name and item key match sw.js — a drift here loses notes silently', async () => {
    const sw = readFileSync(SW_PATH, 'utf-8');
    const fnSource = readFileSync(FN_PATH, 'utf-8');

    const pick = (src: string, name: string): string | undefined =>
      src.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];

    const swCache = pick(sw, 'SHARE_CACHE');
    const swKey = pick(sw, 'SHARE_ITEM_KEY');
    expect(swCache, 'sw.js SHARE_CACHE not found — did it get renamed?').toBeTruthy();
    expect(swKey, 'sw.js SHARE_ITEM_KEY not found — did it get renamed?').toBeTruthy();

    expect(pick(fnSource, 'SHARE_CACHE')).toBe(swCache);
    expect(pick(fnSource, 'SHARE_ITEM_KEY')).toBe(swKey);
  });

  test('a POST with no usable file bounces into the app — never an error page', async () => {
    const fn = loadFn();
    const form = new FormData();
    form.append('text', 'just some shared text, no audio');

    const res = await fn.onRequestPost(postWith(form));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('index.html?shared=1');
  });

  test('a GET is a redirect, NOT a 405 — the 405 is the whole reason this exists', async () => {
    const fn = loadFn();
    const res = await fn.onRequestGet();
    expect(res.status).toBe(303);
    expect(res.status).not.toBe(405);
    expect(res.headers.get('Location')).toBe('index.html?shared=1');
  });

  test('a hostile filename cannot break out of the inline script', async () => {
    const fn = loadFn();
    const form = new FormData();
    const nasty = '</script><script>window.__pwned=1</script>.opus';
    form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/ogg' }), nasty);

    const html = await (await fn.onRequestPost(postWith(form))).text();
    // The property that matters is CONTAINMENT, not absence: the filename text may appear, but
    // only as inert characters inside a quoted JS string. So the page must still have exactly one
    // script element — one opener, one closer — with the angle brackets escaped out of harm's way.
    expect(html.match(/<script/gi)?.length).toBe(1);
    expect(html.match(/<\/script>/gi)?.length).toBe(1);
    expect(html).toContain('\\u003c/script\\u003e');
    // And the payload must NOT survive as executable markup.
    expect(html).not.toContain('<script>window.__pwned');
  });
});
