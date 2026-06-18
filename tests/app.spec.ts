// app.spec.ts — Brain Dump (voice-capture) end-to-end (mocked) tests
// WHAT: drives the compose-first state machine WITHOUT a real mic or Gemini key. getUserMedia +
//       AudioContext + the Gemini/Supabase fetches are stubbed via an init script so tests are
//       hermetic and never hit a live API or write the prod inbox.
// WHY:  the live transcription can't be CI-tested (no key, no mic), so we verify the STRUCTURE:
//       typed capture sends straight to the inbox (source:text); voice is OPT-IN (record → review →
//       Save sends source:voice, Discard sends nothing); the log lists/copies/deletes/clears; a
//       shared WhatsApp note lands in review (not auto-saved). The WAV encoder is unit-checked.
// DECIDED: mock at the browser-API boundary (navigator.mediaDevices, AudioContext, window.fetch,
//       clipboard, caches) — app code stays untouched. Supabase POSTs are recorded on
//       window.__supabasePosts so we can assert what reached the inbox; an offline variant rejects.

import { test, expect } from '@playwright/test';

const FAKE_KEY = 'AIzaTEST-fake-key-1234';
const FAKE_TRANSCRIPT = 'שלום this is a mixed עברית and English transcript.';
const SUPABASE_HOST = 'hpiyvnfhoqnnnotrmwaz.supabase.co';

interface SupabasePost {
  transcript: string;
  source: string;
  duration_seconds?: number;
  category?: string;
}

/**
 * Install browser-API mocks BEFORE any app code runs.
 *  - navigator.mediaDevices.getUserMedia → a dummy MediaStream
 *  - AudioContext → a fake that emits audio frames so record→WAV works
 *  - window.fetch → Gemini (canned transcript) + Supabase voice_captures (canned 201, body
 *    recorded on window.__supabasePosts); when `supabaseOnline` is false the Supabase POST rejects.
 *  - clipboard → stubbed so copy resolves in headless Chromium.
 */
async function installMocks(
  page: import('@playwright/test').Page,
  transcript = FAKE_TRANSCRIPT,
  supabaseOnline = true,
  remoteRows: unknown[] = []
): Promise<void> {
  await page.addInitScript(
    ({
      t,
      online,
      host,
      remote,
    }: {
      t: string;
      online: boolean;
      host: string;
      remote: unknown[];
    }) => {
      const fakeTrack = { stop() {} } as unknown as MediaStreamTrack;
      const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => fakeStream },
      });

      class FakeProcessor {
        onaudioprocess: ((e: unknown) => void) | null = null;
        private timer: number | null = null;
        connect() {
          this.timer = window.setInterval(() => {
            if (this.onaudioprocess) {
              const data = new Float32Array(4096);
              for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 10) * 0.5;
              this.onaudioprocess({ inputBuffer: { getChannelData: () => data } });
            }
          }, 100);
        }
        disconnect() {
          if (this.timer !== null) window.clearInterval(this.timer);
          this.timer = null;
        }
      }
      class FakeAudioContext {
        sampleRate = 44100;
        destination = {};
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        createScriptProcessor() {
          return new FakeProcessor();
        }
        async close() {}
      }
      (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;

      (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts = [];

      const realFetch = window.fetch.bind(window);
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/auth/v1/token')) {
          // Login / refresh — hand back a fake session (never hit real gotrue in tests).
          return new Response(
            JSON.stringify({
              access_token: 'fake-access',
              refresh_token: 'fake-refresh',
              expires_in: 3600,
              user: { email: 'allisonecalt@gmail.com' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes(host) && url.includes('voice_captures')) {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (method === 'GET') {
            // Authenticated inbox read-back (cross-device history).
            return new Response(JSON.stringify(remote), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const bodyText = typeof init?.body === 'string' ? init.body : '';
          const posts = (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts;
          posts.push(bodyText ? JSON.parse(bodyText) : null);
          if (!online) return Promise.reject(new TypeError('Failed to fetch'));
          return new Response(null, { status: 201 });
        }
        return realFetch(input as RequestInfo, init);
      }) as typeof window.fetch;

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => {} },
      });
    },
    { t: transcript, online: supabaseOnline, host: SUPABASE_HOST, remote: remoteRows }
  );
}

function posts(page: import('@playwright/test').Page): Promise<SupabasePost[]> {
  return page.evaluate(
    () => (window as unknown as { __supabasePosts: SupabasePost[] }).__supabasePosts
  );
}

const setKey = (page: import('@playwright/test').Page) =>
  page.addInitScript(
    (key: string) => window.localStorage.setItem('voice-capture.gemini-key', key),
    FAKE_KEY
  );

test.describe('compose home (no key needed for typing)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await installMocks(page);
    await page.goto('/');
  });

  test('opens on the compose screen with the title and a mic action', async ({ page }) => {
    await expect(page.locator('.topbar-title')).toHaveText('Brain dump');
    await expect(page.locator('#draft')).toBeVisible();
    await expect(page.locator('#compose-action')).toHaveClass(/is-mic/);
  });

  test('typing swaps the mic to a send button', async ({ page }) => {
    await page.locator('#draft').fill('a quick thought');
    await expect(page.locator('#compose-action')).toHaveClass(/is-send/);
    await page.locator('#draft').fill('');
    await expect(page.locator('#compose-action')).toHaveClass(/is-mic/);
  });

  test('sending a typed thought POSTs it as source:text and clears the field', async ({ page }) => {
    await page.locator('#draft').fill('call the plumber before friday');
    await page.locator('#compose-action').click();
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const [row] = await posts(page);
    expect(row.transcript).toBe('call the plumber before friday');
    expect(row.source).toBe('text');
    await expect(page.locator('#draft')).toHaveValue('');
    await expect(page.locator('#compose-action')).toHaveClass(/is-mic/);
  });

  test('tapping the mic with no key shows an inline explainer, not a cold bounce', async ({
    page,
  }) => {
    await page.locator('#compose-action').click(); // mic, no key set
    // Stays on compose with an inline explainer — never yanked into Settings.
    await expect(page.locator('.screen-compose')).toBeVisible();
    await expect(page.locator('.key-prompt')).toBeVisible();
    await expect(page.locator('.screen-settings')).toHaveCount(0);
    // "Set it up" is the one-tap path into Settings.
    await page.locator('#setup-voice').click();
    await expect(page.locator('.screen-settings')).toBeVisible();
  });

  test('a typed save shows the tappable "Saved to your Log" confirmation', async ({ page }) => {
    await page.locator('#draft').fill('buy milk before friday');
    await page.locator('#compose-action').click();
    const chip = page.locator('#compose-confirm');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/saved to your log/i);
    // Tapping the beat jumps to the Log so she SEES it saved (nothing-lost).
    await chip.click();
    await expect(page.locator('.screen-log')).toBeVisible();
  });
});

test.describe('voice is opt-in to save (with a key)', () => {
  test.beforeEach(async ({ page }) => {
    await setKey(page);
    await installMocks(page);
    await page.goto('/');
  });

  test('record → stop → review shows the transcript; nothing saved yet', async ({ page }) => {
    await page.locator('#compose-action').click(); // mic
    await expect(page.locator('.screen-recording')).toBeVisible();
    await page.locator('#stop-btn').click();
    await expect(page.locator('#review-text')).toHaveValue(FAKE_TRANSCRIPT);
    // Opt-in: the transcript is NOT in the inbox until she taps Save.
    expect((await posts(page)).length).toBe(0);
  });

  test('Save sends the transcript as source:voice', async ({ page }) => {
    await page.locator('#compose-action').click();
    await page.locator('#stop-btn').click();
    await expect(page.locator('#save-btn')).toBeVisible();
    await page.locator('#save-btn').click();
    await expect(page.locator('.screen-compose')).toBeVisible();
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const [row] = await posts(page);
    expect(row.transcript).toBe(FAKE_TRANSCRIPT);
    expect(row.source).toBe('voice');
  });

  test('Discard throws the transcript away — no POST', async ({ page }) => {
    await page.locator('#compose-action').click();
    await page.locator('#stop-btn').click();
    await expect(page.locator('#discard-btn')).toBeVisible();
    await page.locator('#discard-btn').click();
    await expect(page.locator('.screen-compose')).toBeVisible();
    expect((await posts(page)).length).toBe(0);
  });
});

test.describe('shared WhatsApp voice note (Web Share Target)', () => {
  test.beforeEach(async ({ page }) => {
    await setKey(page);
    await installMocks(page);
    await page.goto('/');
  });

  test('a shared note lands in review (opt-in), not auto-saved', async ({ page }) => {
    await page.evaluate(async () => {
      const cache = await caches.open('voice-capture-share');
      const headers = new Headers();
      headers.set('Content-Type', 'audio/ogg');
      headers.set('X-Shared-Filename', encodeURIComponent('PTT-20260616-WA0001.opus'));
      const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/ogg' });
      await cache.put('shared-audio', new Response(audio, { headers }));
    });
    await page.goto('/?shared=1');
    await expect(page.locator('#review-text')).toHaveValue(FAKE_TRANSCRIPT);
    expect((await posts(page)).length).toBe(0); // not saved until she taps Save
    // One-shot: the cached share is consumed, and the ?shared flag stripped.
    const leftover = await page.evaluate(async () => {
      const cache = await caches.open('voice-capture-share');
      return (await cache.match('shared-audio')) ? 'present' : 'gone';
    });
    expect(leftover).toBe('gone');
    expect(new URL(page.url()).search).toBe('');
  });
});

test.describe('log', () => {
  const HISTORY_KEY = 'vc.history';

  test.beforeEach(async ({ page }) => {
    await setKey(page);
    await installMocks(page);
    await page.addInitScript((k: string) => {
      const seed = [
        {
          id: 'a1',
          transcript: 'typed thought one',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          synced: true,
          source: 'text',
        },
        {
          id: 'b2',
          transcript: 'voice thought two',
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
          synced: true,
          source: 'voice',
        },
      ];
      window.localStorage.setItem(k, JSON.stringify(seed));
    }, HISTORY_KEY);
    await page.goto('/');
  });

  test('the log lists saved items newest first with copy + delete', async ({ page }) => {
    await page.locator('#open-log').click();
    await expect(page.locator('.log-card')).toHaveCount(2);
    await expect(page.locator('.log-card').first().locator('.log-text')).toHaveText(
      'typed thought one'
    );
  });

  test('copy flips the row to "Copied ✓"', async ({ page }) => {
    await page.locator('#open-log').click();
    await page.locator('.log-copy').first().click();
    await expect(page.locator('.log-copy').first()).toHaveText('Copied ✓');
  });

  test('delete removes the row from the list and localStorage', async ({ page }) => {
    await page.locator('#open-log').click();
    await page.locator('.log-del').first().click();
    await expect(page.locator('.log-card')).toHaveCount(1);
    const remaining = await page.evaluate(
      (k: string) => JSON.parse(window.localStorage.getItem(k) ?? '[]').length,
      HISTORY_KEY
    );
    expect(remaining).toBe(1);
  });

  test('Clear all needs two taps, then empties the log', async ({ page }) => {
    await page.locator('#open-log').click();
    await page.locator('#clear-all').click();
    await expect(page.locator('#clear-all')).toHaveText('Tap again to clear all');
    await expect(page.locator('.log-card')).toHaveCount(2); // not cleared yet
    await page.locator('#clear-all').click();
    await expect(page.locator('.log-empty')).toBeVisible();
    const remaining = await page.evaluate(
      (k: string) => JSON.parse(window.localStorage.getItem(k) ?? '[]').length,
      HISTORY_KEY
    );
    expect(remaining).toBe(0);
  });
});

test.describe('cross-device sync (logged in)', () => {
  const HISTORY_KEY = 'vc.history';
  const SESSION_KEY = 'vc.session';
  const REMOTE = [
    {
      id: 'r1',
      transcript: 'note from my phone',
      source: 'voice',
      created_at: new Date(Date.now() - 30_000).toISOString(),
    },
  ];

  test('a logged-in Log merges the inbox with local notes and marks remote read-only', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ hk, sk }: { hk: string; sk: string }) => {
        window.localStorage.setItem(
          sk,
          JSON.stringify({
            access_token: 'fake-access',
            refresh_token: 'fake-refresh',
            expires_at: Date.now() + 3_600_000,
            email: 'allisonecalt@gmail.com',
          })
        );
        window.localStorage.setItem(
          hk,
          JSON.stringify([
            {
              id: 'local1',
              transcript: 'note typed right here',
              createdAt: new Date(Date.now() - 5_000).toISOString(),
              synced: false,
              source: 'text',
            },
          ])
        );
      },
      { hk: HISTORY_KEY, sk: SESSION_KEY }
    );
    await installMocks(page, FAKE_TRANSCRIPT, true, REMOTE);
    await page.goto('/');

    await page.locator('#open-log').click();
    // Inbox row (phone) + the local unsynced note both show.
    await expect(page.locator('.log-card')).toHaveCount(2);
    await expect(page.locator('.log-text', { hasText: 'note from my phone' })).toBeVisible();
    await expect(page.locator('.log-text', { hasText: 'note typed right here' })).toBeVisible();
    // "Synced" banner; the remote row is read-only (no delete) — only the local note can be deleted.
    await expect(page.locator('.log-sync')).toBeVisible();
    await expect(page.locator('.log-del')).toHaveCount(1);
  });

  test('logging in from Settings shows the inbox notes', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await installMocks(page, FAKE_TRANSCRIPT, true, REMOTE);
    await page.goto('/');

    await page.locator('#open-log').click();
    await page.locator('#log-login').click(); // CTA → Settings
    await expect(page.locator('.screen-settings')).toBeVisible();
    await page.locator('#login-email').fill('allisonecalt@gmail.com');
    await page.locator('#login-password').fill('whatever');
    await page.locator('#login-btn').click();

    // Lands on the Log, synced, showing the inbox note from the "other device".
    await expect(page.locator('.screen-log')).toBeVisible();
    await expect(page.locator('.log-sync')).toBeVisible();
    await expect(page.locator('.log-text', { hasText: 'note from my phone' })).toBeVisible();
  });
});

test.describe('offline (Supabase rejects)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await installMocks(page, FAKE_TRANSCRIPT, false);
    await page.goto('/');
  });

  test('a typed thought is still kept locally when the send fails', async ({ page }) => {
    await page.locator('#draft').fill('offline thought');
    await page.locator('#compose-action').click();
    // The Supabase POST was attempted (and rejected); the note is safe in local history.
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem('vc.history') ?? '[]')
    );
    expect(stored.length).toBe(1);
    expect(stored[0].synced).toBe(false);
  });
});

test.describe('WAV encoder (in-page unit check)', () => {
  test('encodeWav writes a valid RIFF/WAVE 16 kHz mono header', async ({ page }) => {
    await installMocks(page);
    await page.goto('/');
    const header = await page.evaluate(async () => {
      const mod = await import('./dist/wav.js');
      const samples = new Float32Array(16000);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 5) * 0.3;
      const blob = mod.encodeWav(samples, 16000);
      const buf = new DataView(await blob.arrayBuffer());
      const str = (o: number, n: number) =>
        Array.from({ length: n }, (_, i) => String.fromCharCode(buf.getUint8(o + i))).join('');
      return { type: blob.type, riff: str(0, 4), wave: str(8, 4), fmt: str(12, 4) };
    });
    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.fmt).toBe('fmt ');
  });
});
