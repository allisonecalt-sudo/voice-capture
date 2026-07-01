// app.spec.ts — Brain Dump (voice-capture) end-to-end (mocked) tests
// WHAT: drives the compose-first state machine WITHOUT a real mic or Gemini key. getUserMedia +
//       AudioContext + the Gemini/Supabase fetches are stubbed via an init script so tests are
//       hermetic and never hit a live API or write the prod inbox.
// WHY:  the live transcription can't be CI-tested (no key, no mic), so we verify the STRUCTURE:
//       typed capture sends straight to the inbox (source:text); voice AUTO-SAVES on transcription
//       (record → stop → POST source:voice, no review gate — her 2026-06-23 call); the log
//       lists/copies/deletes/clears; a shared WhatsApp note also auto-saves. WAV encoder unit-checked.
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
  remoteRows: unknown[] = [],
  geminiFailFirst = 0
): Promise<void> {
  await page.addInitScript(
    ({
      t,
      online,
      host,
      remote,
      failFirst,
    }: {
      t: string;
      online: boolean;
      host: string;
      remote: unknown[];
      failFirst: number;
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
      (window as unknown as { __supabasePatches: unknown[] }).__supabasePatches = [];
      // Mutable inbox: the GET handler reads from this so a test can change what the inbox returns
      // between two Log opens (proves the fresh read re-homes the default segment — v15 re-home fix).
      (window as unknown as { __remoteRows: unknown[] }).__remoteRows = remote;

      const realFetch = window.fetch.bind(window);
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('generativelanguage.googleapis.com')) {
          const w = window as unknown as { __geminiCalls: number };
          w.__geminiCalls = (w.__geminiCalls ?? 0) + 1;
          // Simulate Google's transient "model overloaded" 503 for the first N calls so the
          // retry+fallback path is exercised; later calls succeed.
          if (w.__geminiCalls <= failFirst) {
            return new Response(
              JSON.stringify({
                error: { message: 'The model is overloaded. Please try again later.' },
              }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          }
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
            // Authenticated inbox read-back (cross-device history). The app appends
            // `archived=eq.false`; the canned rows already exclude archived ones. Reads from the
            // mutable __remoteRows so a test can simulate a newly-arrived note between opens.
            const rows = (window as unknown as { __remoteRows: unknown[] }).__remoteRows ?? remote;
            return new Response(JSON.stringify(rows), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (method === 'PATCH') {
            // Authenticated UPDATE (markListened / archive / unarchive). Record on a separate
            // channel so tests can assert what was patched without polluting the insert log.
            const bodyText = typeof init?.body === 'string' ? init.body : '';
            const patches = (window as unknown as { __supabasePatches: unknown[] })
              .__supabasePatches;
            patches.push({ url, body: bodyText ? JSON.parse(bodyText) : null });
            if (!online) return Promise.reject(new TypeError('Failed to fetch'));
            return new Response(null, { status: 204 });
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
    {
      t: transcript,
      online: supabaseOnline,
      host: SUPABASE_HOST,
      remote: remoteRows,
      failFirst: geminiFailFirst,
    }
  );
}

function posts(page: import('@playwright/test').Page): Promise<SupabasePost[]> {
  return page.evaluate(
    () => (window as unknown as { __supabasePosts: SupabasePost[] }).__supabasePosts
  );
}

interface SupabasePatch {
  url: string;
  body: Record<string, unknown> | null;
}

function patches(page: import('@playwright/test').Page): Promise<SupabasePatch[]> {
  return page.evaluate(
    () => (window as unknown as { __supabasePatches: SupabasePatch[] }).__supabasePatches
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
    await expect(page.locator('.topbar-title')).toContainText('Brain dump');
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

  test('on a phone viewport the mic/send action sits in view without scrolling', async ({
    page,
  }) => {
    // Regression guard for the Jun 18 bug: the composer action was below the fold on
    // phone. The sticky bottom composer + 100dvh keep it reachable without scrolling.
    await page.setViewportSize({ width: 412, height: 600 });
    await expect(page.locator('#compose-action')).toBeInViewport();
    await expect(page.locator('#draft')).toBeInViewport();
  });
});

test.describe('voice auto-saves (with a key)', () => {
  test.beforeEach(async ({ page }) => {
    await setKey(page);
    await installMocks(page);
    await page.goto('/');
  });

  test('record → stop auto-saves the transcript as source:voice (no review gate)', async ({
    page,
  }) => {
    await page.locator('#compose-action').click(); // mic
    await expect(page.locator('.screen-recording')).toBeVisible();
    await page.locator('#stop-btn').click();
    // No opt-in: it lands back on compose and the transcript is already in the inbox.
    await expect(page.locator('.screen-compose')).toBeVisible();
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const [row] = await posts(page);
    expect(row.transcript).toBe(FAKE_TRANSCRIPT);
    expect(row.source).toBe('voice');
  });

  test('Pause flips to Resume + a Paused state, and stop still auto-saves after', async ({
    page,
  }) => {
    await page.locator('#compose-action').click(); // mic → recording
    await expect(page.locator('.screen-recording')).toBeVisible();
    const pause = page.locator('#pause-btn');
    await expect(pause).toContainText('Pause');
    await pause.click();
    await expect(pause).toContainText('Resume');
    await expect(page.locator('.rec-label')).toHaveText('Paused');
    await expect(page.locator('.rec-dot.paused')).toBeVisible();
    // Resume → back to listening, and the recording still completes and auto-saves.
    await pause.click();
    await expect(page.locator('#pause-btn')).toContainText('Pause');
    await expect(page.locator('.rec-label')).toHaveText('Listening…');
    await page.locator('#stop-btn').click();
    await expect(page.locator('.screen-compose')).toBeVisible();
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const [row] = await posts(page);
    expect(row.source).toBe('voice');
  });
});

test.describe('Gemini "busy" (503) resilience', () => {
  test('a transient overload self-heals: retry+fallback still auto-saves', async ({ page }) => {
    await setKey(page);
    // First two calls 503 ("model overloaded"); the retry loop's 3rd call succeeds.
    await installMocks(page, FAKE_TRANSCRIPT, true, [], 2);
    await page.goto('/');
    await page.locator('#compose-action').click(); // mic
    await page.locator('#stop-btn').click();
    // No error surfaced to her; the note lands in the inbox on its own.
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const [row] = await posts(page);
    expect(row.source).toBe('voice');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  });

  test('a persistent overload shows a plain message + a Retry that recovers', async ({ page }) => {
    await setKey(page);
    // Fail every attempt this build makes (MAX_ATTEMPTS=4) → she sees the message + Retry.
    await installMocks(page, FAKE_TRANSCRIPT, true, [], 4);
    await page.goto('/');
    await page.locator('#compose-action').click(); // mic
    await page.locator('#stop-btn').click();
    // Honest, non-scary message + the held recording offered back as a one-tap Retry.
    await expect(page.locator('.error-banner')).toContainText('busy');
    await expect(page.locator('#retry-voice')).toBeVisible();
    expect(await posts(page)).toHaveLength(0); // nothing saved yet
    // The overload has since cleared (calls 5+ succeed) → Retry transcribes + saves.
    await page.locator('#retry-voice').click();
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    expect((await posts(page))[0].source).toBe('voice');
    await expect(page.locator('#retry-voice')).toHaveCount(0); // cleared after success
  });

  test('a held recording can be discarded — never saves, no nag', async ({ page }) => {
    await setKey(page);
    await installMocks(page, FAKE_TRANSCRIPT, true, [], 4); // all attempts fail → held + offered
    await page.goto('/');
    await page.locator('#compose-action').click(); // mic
    await page.locator('#stop-btn').click();
    await expect(page.locator('#discard-voice')).toBeVisible();
    await page.locator('#discard-voice').click();
    // Gone: prompt cleared, nothing saved, error banner gone.
    await expect(page.locator('#retry-voice')).toHaveCount(0);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(await posts(page)).toHaveLength(0);
  });
});

test.describe('shared WhatsApp voice note (Web Share Target)', () => {
  test.beforeEach(async ({ page }) => {
    await setKey(page);
    await installMocks(page);
    await page.goto('/');
  });

  test('a shared note auto-saves as source:voice', async ({ page }) => {
    await page.evaluate(async () => {
      const cache = await caches.open('voice-capture-share');
      const headers = new Headers();
      headers.set('Content-Type', 'audio/ogg');
      headers.set('X-Shared-Filename', encodeURIComponent('PTT-20260616-WA0001.opus'));
      const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/ogg' });
      await cache.put('shared-audio', new Response(audio, { headers }));
    });
    await page.goto('/?shared=1');
    // No review gate: the shared note transcribes and lands in the inbox on its own.
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const [row] = await posts(page);
    expect(row.transcript).toBe(FAKE_TRANSCRIPT);
    expect(row.source).toBe('voice');
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

  test('archive removes a local note from the list and localStorage', async ({ page }) => {
    // Logged-out, local-only notes archive by dropping from the device buffer (nothing reached the
    // inbox yet) — the visible 🗑 is data-local-del. Both seed rows live in the "My Notes" segment.
    await page.locator('#open-log').click();
    await expect(page.locator('.log-card')).toHaveCount(2);
    await page.locator('.log-archive[data-local-del]').first().click();
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

  test('a logged-in Log merges the inbox with local notes; remote archives, local drops', async ({
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
    // Offline POST so the typed note STAYS unsynced — a synced local copy would now sync and be
    // pruned (it lives in the shared inbox instead). The local buffer is only un-delivered notes.
    await installMocks(page, FAKE_TRANSCRIPT, false, REMOTE);
    await page.goto('/');

    await page.locator('#open-log').click();
    // Both are her own notes → the "My Notes" segment. Inbox row (phone) + local UNSYNCED buffer.
    await expect(page.locator('.log-card')).toHaveCount(2);
    await expect(page.locator('.log-text', { hasText: 'note from my phone' })).toBeVisible();
    await expect(page.locator('.log-text', { hasText: 'note typed right here' })).toBeVisible();
    // "Synced" banner. v15: every card has a 🗑 — the remote/synced one soft-archives
    // (data-archive), the local-only one drops from the device buffer (data-local-del).
    await expect(page.locator('.log-sync')).toBeVisible();
    await expect(page.locator('.log-archive[data-archive]')).toHaveCount(1);
    await expect(page.locator('.log-archive[data-local-del]')).toHaveCount(1);
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

  test('a synced local note gone from the inbox (Claude filed it) is pruned from the phone', async ({
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
        // One SYNCED local note that is NOT in the inbox (REMOTE) below = Claude already filed it.
        window.localStorage.setItem(
          hk,
          JSON.stringify([
            {
              id: 'filed1',
              transcript: 'already filed note',
              createdAt: new Date(Date.now() - 9_000).toISOString(),
              synced: true,
              source: 'voice',
            },
          ])
        );
      },
      { hk: HISTORY_KEY, sk: SESSION_KEY }
    );
    await installMocks(page, FAKE_TRANSCRIPT, true, REMOTE); // REMOTE holds only 'note from my phone'
    await page.goto('/');

    await page.locator('#open-log').click();
    // The filed local copy is pruned — only the shared inbox note remains (same on every device).
    await expect(page.locator('.log-text', { hasText: 'note from my phone' })).toBeVisible();
    await expect(page.locator('.log-text', { hasText: 'already filed note' })).toHaveCount(0);
    // Pruned from localStorage, not just hidden.
    await expect
      .poll(async () =>
        page.evaluate(
          (k: string) => JSON.parse(window.localStorage.getItem(k) ?? '[]').length,
          HISTORY_KEY
        )
      )
      .toBe(0);
  });

  test('a Claude voice note default-lands on the Voice segment with a player + listened toggle', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ sk }: { sk: string }) => {
        window.localStorage.setItem(
          sk,
          JSON.stringify({
            access_token: 'fake-access',
            refresh_token: 'fake-refresh',
            expires_at: Date.now() + 3_600_000,
            email: 'allisonecalt@gmail.com',
          })
        );
      },
      { sk: SESSION_KEY }
    );
    const claudeRemote = [
      {
        id: 'claude1',
        transcript: 'מכונים list — your eval-day options',
        source: 'text',
        created_at: new Date(Date.now() - 10_000).toISOString(),
        from_claude: true,
        audio_url:
          'https://hpiyvnfhoqnnnotrmwaz.supabase.co/storage/v1/object/public/voice-notes/claude1.mp3',
        listened: false,
      },
    ];
    await installMocks(page, FAKE_TRANSCRIPT, true, claudeRemote);
    await page.goto('/');

    await page.locator('#open-log').click();
    // Default-lands on the Voice segment (it has the unheard note); the Voice tab is active.
    await expect(page.locator('.seg[data-seg="voice"]')).toHaveClass(/is-active/);
    const card = page.locator('.claude-card');
    await expect(card).toHaveCount(1);
    // A voice note shows a ▶ Play button (it plays in the persistent bar, not an inline <audio>).
    await expect(card.locator('.card-play')).toHaveCount(1);
    await expect(card).toHaveClass(/is-unlistened/);
    // Marking listened swaps the button for the badge and dims the card (sunk + checked off).
    await card.locator('.mark-listened').click();
    await expect(card.locator('.listened-badge')).toBeVisible();
    await expect(page.locator('.claude-card.is-unlistened')).toHaveCount(0);
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

test.describe('v15 — 3-segment Log (Mine / Voice / Info)', () => {
  const SESSION_KEY = 'vc.session';

  // One row per segment + her own note. The voice note is unheard → default-lands on Voice.
  const SEGMENTED_REMOTE = [
    {
      id: 'mine1',
      transcript: 'my own captured thought',
      source: 'text',
      created_at: new Date(Date.now() - 5_000).toISOString(),
      from_claude: false,
    },
    {
      id: 'voice1',
      transcript: 'Voice note: your eval-day plan',
      source: 'text',
      created_at: new Date(Date.now() - 10_000).toISOString(),
      from_claude: true,
      audio_url:
        'https://hpiyvnfhoqnnnotrmwaz.supabase.co/storage/v1/object/public/voice-notes/voice1.mp3',
      listened: false,
    },
    {
      id: 'info1',
      transcript: 'מכונים list — Jerusalem eval options',
      source: 'text',
      created_at: new Date(Date.now() - 20_000).toISOString(),
      from_claude: true,
      audio_url: null,
      listened: false,
    },
  ];

  async function seedLoggedIn(
    page: import('@playwright/test').Page,
    remote: unknown[] = SEGMENTED_REMOTE
  ): Promise<void> {
    await page.addInitScript((sk: string) => {
      window.localStorage.setItem(
        sk,
        JSON.stringify({
          access_token: 'fake-access',
          refresh_token: 'fake-refresh',
          expires_at: Date.now() + 3_600_000,
          email: 'allisonecalt@gmail.com',
        })
      );
    }, SESSION_KEY);
    await installMocks(page, FAKE_TRANSCRIPT, true, remote);
    await page.goto('/');
    await page.locator('#open-log').click();
  }

  test('the segmented control filters one inbox into Mine / Voice / Info', async ({ page }) => {
    await seedLoggedIn(page);
    // Three segments rendered.
    await expect(page.locator('.seg')).toHaveCount(3);
    // Default-lands on Voice (it has the unheard voice note); only voice1 shows.
    await expect(page.locator('.seg[data-seg="voice"]')).toHaveClass(/is-active/);
    // Claude note content shows on the card (the subject header derives from the first line when
    // there's no explicit title), so assert against .claude-card, not the .log-text body.
    await expect(page.locator('.claude-card', { hasText: 'your eval-day plan' })).toBeVisible();
    await expect(page.locator('.claude-card', { hasText: 'מכונים list' })).toHaveCount(0);
    await expect(page.locator('.log-text', { hasText: 'my own captured thought' })).toHaveCount(0);

    // Switch to Info → only the written memo (no audio player).
    await page.locator('.seg[data-seg="info"]').click();
    await expect(page.locator('.claude-card', { hasText: 'מכונים list' })).toBeVisible();
    await expect(page.locator('audio.claude-audio')).toHaveCount(0);
    await expect(page.locator('.log-text', { hasText: 'your eval-day plan' })).toHaveCount(0);

    // Switch to My Notes → only her own capture.
    await page.locator('.seg[data-seg="mine"]').click();
    await expect(page.locator('.log-text', { hasText: 'my own captured thought' })).toBeVisible();
    await expect(page.locator('.claude-card')).toHaveCount(0);
  });

  test('the Claude tabs show an unheard count + header; Mine shows a plain count', async ({
    page,
  }) => {
    await seedLoggedIn(page);
    // Voice + Info each carry a "1" unheard badge; Mine has none.
    await expect(page.locator('.seg[data-seg="voice"] .seg-badge')).toHaveText('1');
    await expect(page.locator('.seg[data-seg="info"] .seg-badge')).toHaveText('1');
    await expect(page.locator('.seg[data-seg="mine"] .seg-badge')).toHaveCount(0);
    // Voice (active) header states the unheard count, never scolds.
    await expect(page.locator('.segment-header')).toHaveText('1 unheard');
    // After marking it listened, the header flips to the calm "All caught up ✓".
    await page.locator('.claude-card .mark-listened').click();
    await expect(page.locator('.segment-header.is-clear')).toHaveText('All caught up ✓');
  });

  test('a newly-arrived unheard Claude note re-homes the default segment on the next open', async ({
    page,
  }) => {
    // First open with ONLY her own note in the inbox → default-lands on Mine (no unheard Claude tab).
    await seedLoggedIn(page, [
      {
        id: 'mine1',
        transcript: 'my own captured thought',
        source: 'text',
        created_at: new Date(Date.now() - 5_000).toISOString(),
        from_claude: false,
      },
    ]);
    await expect(page.locator('.seg[data-seg="mine"]')).toHaveClass(/is-active/);

    // A new unheard VOICE note from Claude lands in the inbox after the first open.
    await page.evaluate(() => {
      (window as unknown as { __remoteRows: unknown[] }).__remoteRows = [
        {
          id: 'mine1',
          transcript: 'my own captured thought',
          source: 'text',
          created_at: new Date(Date.now() - 5_000).toISOString(),
          from_claude: false,
        },
        {
          id: 'voiceNew',
          transcript: 'Voice note: just arrived',
          source: 'text',
          created_at: new Date().toISOString(),
          from_claude: true,
          audio_url:
            'https://hpiyvnfhoqnnnotrmwaz.supabase.co/storage/v1/object/public/voice-notes/voiceNew.mp3',
          listened: false,
        },
      ];
    });

    // Go back to compose, then open the Log again. The fresh inbox read must re-home onto Voice —
    // it must NOT latch off the stale cache and stay on Mine (the v15 re-home regression).
    await page.locator('#log-back').click();
    await page.locator('#open-log').click();
    await expect(page.locator('.seg[data-seg="voice"]')).toHaveClass(/is-active/);
    await expect(page.locator('.claude-card', { hasText: 'just arrived' })).toBeVisible();
  });

  test('playing a Claude note in the persistent bar marks it listened', async ({ page }) => {
    await seedLoggedIn(page);
    const card = page.locator('.claude-card');
    await expect(card).toHaveClass(/is-unlistened/);
    // Tap ▶ Play → the note loads in the persistent bar; playing counts as heard (auto-marks).
    await card.locator('.card-play').click();
    await expect(card.locator('.listened-badge')).toBeVisible();
    await expect(card).toHaveClass(/is-listened/);
    // It persisted via an authenticated PATCH carrying listened=true.
    await expect
      .poll(async () => (await patches(page)).some((p) => p.body?.listened === true))
      .toBe(true);
  });

  test('a playing voice note survives navigation (persistent bar, outside #app)', async ({
    page,
  }) => {
    await seedLoggedIn(page);
    // Play a note → it loads in the persistent bar.
    await page.locator('.claude-card .card-play').first().click();
    await expect(page.locator('#player-bar')).toBeVisible();
    const srcBefore = await page.locator('#player-audio').getAttribute('src');
    expect(srcBefore).toBeTruthy();
    // Leave the Log to write a reply — this rebuilds #app entirely (the old inline <audio> would die).
    await page.locator('.claude-card .reply-btn').first().click();
    await expect(page.locator('.screen-compose')).toBeVisible();
    // The bar lives OUTSIDE #app, so it's untouched: same <audio> element, same src — still playing.
    await expect(page.locator('#player-bar')).toBeVisible();
    expect(await page.locator('#player-audio').getAttribute('src')).toBe(srcBefore);
  });

  test('archive soft-deletes with an Undo snackbar (no confirm dialog)', async ({ page }) => {
    await seedLoggedIn(page);
    const card = page.locator('.claude-card');
    await card.locator('.log-archive[data-archive]').click();
    // The card drops from view immediately; the Undo snackbar appears (no dialog).
    await expect(page.locator('.claude-card')).toHaveCount(0);
    await expect(page.locator('#undo-snackbar')).toBeVisible();
    // It archived server-side via PATCH archived=true.
    await expect
      .poll(async () => (await patches(page)).some((p) => p.body?.archived === true))
      .toBe(true);
    // Undo restores it (PATCH archived=false) and the card comes back.
    await page.locator('#undo-archive').click();
    await expect
      .poll(async () => (await patches(page)).some((p) => p.body?.archived === false))
      .toBe(true);
    await expect(page.locator('.claude-card')).toHaveCount(1);
  });

  test('Reply on a Claude note carries reply_to + reply_snippet into the capture', async ({
    page,
  }) => {
    await seedLoggedIn(page);
    // Tap Reply on the voice note → drops into compose with a "replying to" banner.
    await page.locator('.claude-card .reply-btn').click();
    await expect(page.locator('.screen-compose')).toBeVisible();
    await expect(page.locator('.reply-banner')).toBeVisible();
    // Type + send → the saved capture carries the parent id + snippet.
    await page.locator('#draft').fill('yes, the second clinic works for me');
    await page.locator('#compose-action').click();
    await expect.poll(async () => (await posts(page)).length).toBe(1);
    const [row] = await posts(page);
    expect(row.transcript).toBe('yes, the second clinic works for me');
    expect((row as { reply_to?: string }).reply_to).toBe('voice1');
    expect((row as { reply_snippet?: string }).reply_snippet).toContain('your eval-day plan');
    // The banner clears after sending.
    await expect(page.locator('.reply-banner')).toHaveCount(0);
  });

  test('the bar speed button cycles 1× → 1.25× → 1.5× → 2× → 0.75× and remembers it', async ({
    page,
  }) => {
    await seedLoggedIn(page);
    // Speed is ONE control on the persistent bar now (not a per-card chip) — open the bar first.
    await page.locator('.claude-card .card-play').first().click();
    const speed = page.locator('#player-speed');
    await expect(speed).toHaveText('1×');
    await speed.click();
    await expect(speed).toHaveText('1.25×');
    await speed.click();
    await expect(speed).toHaveText('1.5×');
    await speed.click();
    await expect(speed).toHaveText('2×');
    await speed.click();
    await expect(speed).toHaveText('0.75×');
    await speed.click();
    await expect(speed).toHaveText('1×');
    // The bar audio's playbackRate tracks the button.
    await speed.click(); // → 1.25×
    const rate = await page
      .locator('#player-audio')
      .evaluate((a: HTMLAudioElement) => a.playbackRate);
    expect(rate).toBeCloseTo(1.25, 2);
    // Persisted to localStorage.
    const stored = await page.evaluate(() => window.localStorage.getItem('vc.playbackRate'));
    expect(stored).toBe('1.25');
  });

  test('her reply renders with a "↩ re: …" tag in My Notes', async ({ page }) => {
    // A remote row that IS her reply (carries reply_snippet) shows the thread tag.
    const withReply = [
      {
        id: 'myreply1',
        transcript: 'sounds good, booking it',
        source: 'voice',
        created_at: new Date(Date.now() - 2_000).toISOString(),
        from_claude: false,
        reply_to: 'voice1',
        reply_snippet: 'Voice note: your eval-day plan',
      },
    ];
    await seedLoggedIn(page, withReply);
    // Lands on Mine (no unheard Claude items). The reply tag is visible.
    await expect(page.locator('.seg[data-seg="mine"]')).toHaveClass(/is-active/);
    await expect(page.locator('.reply-tag')).toContainText('re: Voice note: your eval-day plan');
  });

  test('listened Claude notes dim in place — they keep chronological order, never sink', async ({
    page,
  }) => {
    // A NEWER note she already heard + an OLDER note she hasn't. Under the old "sink listened to the
    // bottom" rule the newer-heard note would drop below the older-unheard one. Her feedback killed
    // that (a note must not move when she plays/marks it): order is stable newest-first, and listened
    // just dims where it sits. So the newer-heard note stays ON TOP, dimmed.
    const twoVoice = [
      {
        id: 'heardNewer',
        transcript: 'newer already-heard voice note',
        source: 'text',
        created_at: new Date(Date.now() - 5_000).toISOString(),
        from_claude: true,
        audio_url: 'https://x/storage/v1/object/public/voice-notes/heardNewer.mp3',
        listened: true,
      },
      {
        id: 'unheardOlder',
        transcript: 'older unheard voice note',
        source: 'text',
        created_at: new Date(Date.now() - 50_000).toISOString(),
        from_claude: true,
        audio_url: 'https://x/storage/v1/object/public/voice-notes/unheardOlder.mp3',
        listened: false,
      },
    ];
    await seedLoggedIn(page, twoVoice);
    await expect(page.locator('.seg[data-seg="voice"]')).toHaveClass(/is-active/);
    const cards = page.locator('.claude-card');
    await expect(cards).toHaveCount(2);
    // Newest-first is preserved: the newer (heard) note stays first and dims; it does NOT sink.
    await expect(cards.nth(0)).toHaveClass(/is-listened/);
    await expect(cards.nth(1)).toHaveClass(/is-unlistened/);
  });

  test('every Claude note shows its subject as a header (explicit title, else the first line)', async ({
    page,
  }) => {
    const notes = [
      {
        id: 'withTitle',
        title: 'Push notifications',
        transcript: 'They are live now.',
        source: 'text',
        created_at: new Date(Date.now() - 5_000).toISOString(),
        from_claude: true,
        audio_url: 'https://x/storage/v1/object/public/voice-notes/withTitle.mp3',
        listened: false,
      },
      {
        id: 'noTitle',
        transcript: 'Subject from first line\nand the body below',
        source: 'text',
        created_at: new Date(Date.now() - 50_000).toISOString(),
        from_claude: true,
        audio_url: 'https://x/storage/v1/object/public/voice-notes/noTitle.mp3',
        listened: false,
      },
    ];
    await seedLoggedIn(page, notes);
    await expect(page.locator('.seg[data-seg="voice"]')).toHaveClass(/is-active/);
    // Explicit title → subject = title, body = the transcript.
    const c1 = page.locator('.claude-card', { hasText: 'Push notifications' });
    await expect(c1.locator('.claude-subject')).toHaveText('Push notifications');
    await expect(c1.locator('.log-text')).toHaveText('They are live now.');
    // No title → subject derives from the first line, body is the remainder (no duplication).
    const c2 = page.locator('.claude-card', { hasText: 'Subject from first line' });
    await expect(c2.locator('.claude-subject')).toHaveText('Subject from first line');
    await expect(c2.locator('.log-text')).toHaveText('and the body below');
  });

  test('Voice tab groups by session + a dropdown filters to one session', async ({ page }) => {
    await seedLoggedIn(page, [
      {
        id: 's1a',
        title: 'Build note',
        transcript: 'about the build',
        source: 'text',
        created_at: new Date(Date.now() - 5_000).toISOString(),
        from_claude: true,
        audio_url: 'https://x/storage/v1/object/public/voice-notes/s1a.mp3',
        listened: false,
        session_label: 'Voice-capture build',
      },
      {
        id: 's2a',
        title: 'Masters note',
        transcript: 'about masters',
        source: 'text',
        created_at: new Date(Date.now() - 9_000).toISOString(),
        from_claude: true,
        audio_url: 'https://x/storage/v1/object/public/voice-notes/s2a.mp3',
        listened: false,
        session_label: 'Masters decision',
      },
    ]);
    await expect(page.locator('.seg[data-seg="voice"]')).toHaveClass(/is-active/);
    // With 2 sessions the dropdown appears and the list groups under one divider per session.
    const dd = page.locator('#session-filter');
    await expect(dd).toBeVisible();
    await expect(page.locator('.session-divider')).toHaveCount(2);
    // Filter to one session → only its note shows, no dividers.
    await dd.selectOption('Voice-capture build');
    await expect(page.locator('.claude-card')).toHaveCount(1);
    await expect(page.locator('.claude-card', { hasText: 'Build note' })).toBeVisible();
    await expect(page.locator('.session-divider')).toHaveCount(0);
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
