// app.spec.ts — Voice Capture end-to-end (mocked) tests
// WHAT: loads the page and exercises the state machine WITHOUT a real mic or real Gemini
//       key. getUserMedia + AudioContext + the Gemini fetch are all stubbed via an init
//       script so tests are hermetic and never hit a live API or write any prod resource.
// WHY:  the live transcription can't be CI-tested (no key, no mic), so we verify the
//       STRUCTURE: no-key prompt, record button, recording indicator (timer + pulse +
//       waveform), spinner, transcript + copy. The WAV encoder is unit-checked in-page.
// DECIDED: mock at the browser-API boundary (navigator.mediaDevices, AudioContext,
//          window.fetch) — the app code under test stays untouched. The Supabase save POST is
//          ALSO intercepted here (canned 201, EMPTY body — anon is insert-only, Prefer:
//          return=minimal, no id read-back) so save/history tests never hit prod; an offline
//          variant makes the POST reject to exercise the "will sync" path. There is NO PATCH
//          path anymore (anon can't update) — the To-Do/Thought tag is local until it rides
//          along in the note's INSERT, which fires when she LEAVES the result screen.
// BUILT:  fixtures + the tests below (incl. transcription saves locally but doesn't POST yet,
//          POST fires on leave with the tag in the body, offline-local-save, history view,
//          To-Do/Thought tagging is local, history filter, history sort).
// NEXT:   none for v0.

import { test, expect } from '@playwright/test';

const FAKE_KEY = 'AIzaTEST-fake-key-1234';
const FAKE_TRANSCRIPT = 'שלום this is a mixed עברית and English transcript.';
const SUPABASE_HOST = 'hpiyvnfhoqnnnotrmwaz.supabase.co';

/**
 * Install browser-API mocks BEFORE any app code runs:
 *  - navigator.mediaDevices.getUserMedia → a dummy MediaStream with a stoppable track
 *  - AudioContext → a fake that emits one audio frame so the waveform/levels move
 *  - window.fetch → intercept the Gemini endpoint (canned transcript) AND the Supabase
 *    voice_captures POST (canned 201 with an EMPTY body — Prefer: return=minimal, anon is
 *    insert-only, no id read-back; each POST body recorded on window.__supabasePosts); when
 *    `supabaseOnline` is false the Supabase POST REJECTS to exercise the offline path. There is
 *    no PATCH path (anon can't update) — any non-POST voice_captures call is unexpected.
 *  Real Supabase/Gemini are never hit.
 */
async function installMocks(
  page: import('@playwright/test').Page,
  transcript = FAKE_TRANSCRIPT,
  supabaseOnline = true
) {
  await page.addInitScript(
    ({ t, online, host }: { t: string; online: boolean; host: string }) => {
      // ── Fake mic stream ──
      const fakeTrack = { stop() {} } as unknown as MediaStreamTrack;
      const fakeStream = {
        getTracks: () => [fakeTrack],
      } as unknown as MediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => fakeStream,
        },
      });

      // ── Fake Web Audio ──
      class FakeProcessor {
        onaudioprocess: ((e: unknown) => void) | null = null;
        private timer: number | null = null;
        connect() {
          // Emit frames so the level meter / levels array updates.
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

      // Records every Supabase save POST body so tests can assert the endpoint was called.
      (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts = [];

      // ── Fake Gemini + Supabase fetch ──
      const realFetch = window.fetch.bind(window);
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: t }] } }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes(host) && url.includes('voice_captures')) {
          const bodyText = typeof init?.body === 'string' ? init.body : '';
          // Insert POST (the only voice_captures call — anon is insert-only). Record the body,
          // then succeed (or reject if offline).
          const posts = (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts;
          posts.push(bodyText ? JSON.parse(bodyText) : null);
          if (!online) {
            // Simulate offline: reject so the app falls back to "saved — will sync".
            return Promise.reject(new TypeError('Failed to fetch'));
          }
          // Successful insert: with Prefer: return=minimal, anon RLS returns 201 + an empty body
          // (no id read-back — anon has no SELECT).
          return new Response(null, { status: 201 });
        }
        return realFetch(input as RequestInfo, init);
      }) as typeof window.fetch;

      // Stub clipboard so the copy path resolves in headless Chromium.
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => {} },
      });
    },
    { t: transcript, online: supabaseOnline, host: SUPABASE_HOST }
  );
}

test.describe('first load (no key saved)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await installMocks(page);
    await page.goto('/');
  });

  test('renders the title, record button, and settings gear', async ({ page }) => {
    await expect(page.locator('h1')).toHaveText('Voice Capture');
    await expect(page.locator('#record-btn')).toBeVisible();
    await expect(page.locator('#open-settings')).toBeVisible();
  });

  test('shows the no-key Settings prompt and points to aistudio', async ({ page }) => {
    await expect(page.locator('#key-prompt')).toBeVisible();
    await expect(page.locator('#record-btn')).toBeDisabled();
    // The prompt routes into Settings, where the aistudio link lives.
    await page.locator('#goto-settings-from-prompt').click();
    await expect(page.locator('.screen-settings')).toBeVisible();
    await expect(page.locator('a[href*="aistudio.google.com"]')).toBeVisible();
  });

  test('tapping the disabled record area does not start recording', async ({ page }) => {
    // Button is disabled with no key; recording indicator must not appear.
    await expect(page.locator('.recording-indicator')).toHaveCount(0);
  });
});

test.describe('with a saved key', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      (key: string) => window.localStorage.setItem('voice-capture.gemini-key', key),
      FAKE_KEY
    );
    await installMocks(page);
    await page.goto('/');
  });

  test('no key prompt; record button is enabled', async ({ page }) => {
    await expect(page.locator('#key-prompt')).toHaveCount(0);
    await expect(page.locator('#record-btn')).toBeEnabled();
  });

  test('record → recording shows REC pill, timer, pulse, and waveform', async ({ page }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('.rec-pill')).toBeVisible();
    await expect(page.locator('#timer')).toBeVisible();
    await expect(page.locator('.record-btn.is-recording')).toBeVisible();
    await expect(page.locator('.waveform .wave-bar')).toHaveCount(32);
  });

  test('full mocked flow: record → stop → transcript → copy confirmation', async ({ page }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();
    // Lands on the result screen with the canned transcript.
    const ta = page.locator('#transcript');
    await expect(ta).toBeVisible();
    await expect(ta).toHaveValue(FAKE_TRANSCRIPT);
    // Copy → confirmation flips to "Copied ✓".
    await page.locator('#copy-btn').click();
    await expect(page.locator('#copy-btn')).toHaveText('Copied ✓');
  });

  test('settings saves a pasted key and returns to idle without the prompt', async ({ page }) => {
    await page.locator('#open-settings').click();
    await page.locator('#api-key').fill('AIzaANOTHER-key-9999');
    await page.locator('#save-key').click();
    await expect(page.locator('.screen-idle')).toBeVisible();
    await expect(page.locator('#key-prompt')).toHaveCount(0);
  });
});

test.describe('WAV encoder (in-page unit check)', () => {
  test('encodeWav writes a valid RIFF/WAVE 16 kHz mono header', async ({ page }) => {
    await installMocks(page);
    await page.goto('/');
    const header = await page.evaluate(async () => {
      const mod = await import('./dist/wav.js');
      const samples = new Float32Array(16000); // 1 second
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 5) * 0.3;
      const blob = mod.encodeWav(samples, 16000);
      const buf = new DataView(await blob.arrayBuffer());
      const str = (o: number, n: number) =>
        Array.from({ length: n }, (_, i) => String.fromCharCode(buf.getUint8(o + i))).join('');
      return {
        type: blob.type,
        riff: str(0, 4),
        wave: str(8, 4),
        fmt: str(12, 4),
        data: str(36, 4),
        audioFormat: buf.getUint16(20, true),
        channels: buf.getUint16(22, true),
        sampleRate: buf.getUint32(24, true),
        bitsPerSample: buf.getUint16(34, true),
        byteLength: blob.size,
      };
    });
    expect(header.type).toBe('audio/wav');
    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.fmt).toBe('fmt ');
    expect(header.data).toBe('data');
    expect(header.audioFormat).toBe(1); // PCM
    expect(header.channels).toBe(1); // mono
    expect(header.sampleRate).toBe(16000);
    expect(header.bitsPerSample).toBe(16);
    // 44-byte header + 1s * 16000 samples * 2 bytes.
    expect(header.byteLength).toBe(44 + 16000 * 2);
  });
});

const HISTORY_KEY = 'vc.history';

/** Read the localStorage history list the app maintains. */
async function readHistory(page: import('@playwright/test').Page) {
  return page.evaluate((k: string) => {
    const raw = window.localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
  }, HISTORY_KEY);
}

test.describe('auto-save on transcription (Supabase online)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      (key: string) => window.localStorage.setItem('voice-capture.gemini-key', key),
      FAKE_KEY
    );
    await installMocks(page); // supabaseOnline = true
    await page.goto('/');
  });

  test('record → stop saves LOCALLY and shows "Saved ✓" but does NOT POST yet', async ({
    page,
  }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();

    // Result screen with the canned transcript.
    await expect(page.locator('#transcript')).toHaveValue(FAKE_TRANSCRIPT);

    // Local save is the guarantee → status is "Saved ✓" immediately (no network involved yet).
    await expect(page.locator('#save-status')).toHaveText('Saved ✓');

    // localStorage history has exactly one item — saved locally, NOT yet synced (the send is
    // deferred until she leaves the result screen, so the final tag can ride along in the insert).
    const items = await readHistory(page);
    expect(items).toHaveLength(1);
    expect(items[0].transcript).toBe(FAKE_TRANSCRIPT);
    expect(items[0].synced).toBe(false);
    expect(typeof items[0].id).toBe('string');
    expect(typeof items[0].createdAt).toBe('string');
    // No supabaseId field exists anymore (anon is insert-only — nothing to address later).
    expect(items[0].supabaseId).toBeUndefined();

    // Crucially: NO Supabase POST has happened while she's still on the result screen.
    const posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    expect(posts).toHaveLength(0);
  });

  test('leaving the result screen (Record again) NOW fires the POST with source:voice', async ({
    page,
  }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();
    await expect(page.locator('#save-status')).toHaveText('Saved ✓');

    // Still no POST while on the result screen.
    let posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    expect(posts).toHaveLength(0);

    // Leave the result screen → the deferred send fires now.
    await page.locator('#again-btn').click();

    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts.length
        )
      )
      .toBeGreaterThanOrEqual(1);

    posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    const first = posts[0] as Record<string, unknown>;
    expect(first.transcript).toBe(FAKE_TRANSCRIPT);
    expect(first.source).toBe('voice');

    // The local item is now marked synced.
    const items = await readHistory(page);
    expect(items[0].synced).toBe(true);
  });

  test('opening History from the result screen also flushes the deferred send', async ({
    page,
  }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();
    await expect(page.locator('#save-status')).toHaveText('Saved ✓');

    await page.locator('#open-history').click();

    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts.length
        )
      )
      .toBeGreaterThanOrEqual(1);
  });
});

test.describe('auto-save when offline (Supabase rejects)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      (key: string) => window.localStorage.setItem('voice-capture.gemini-key', key),
      FAKE_KEY
    );
    await installMocks(page, FAKE_TRANSCRIPT, false); // supabaseOnline = false
    await page.goto('/');
  });

  test('saves locally; a failed send on leave just leaves it unsynced (retries later)', async ({
    page,
  }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();

    await expect(page.locator('#transcript')).toHaveValue(FAKE_TRANSCRIPT);

    // Local save is the guarantee regardless of network → "Saved ✓" on the result screen.
    await expect(page.locator('#save-status')).toHaveText('Saved ✓');
    let items = await readHistory(page);
    expect(items).toHaveLength(1);
    expect(items[0].transcript).toBe(FAKE_TRANSCRIPT);
    expect(items[0].synced).toBe(false);

    // Leave the result screen → the send is attempted but the (offline) POST rejects, so the
    // item is never lost — it stays in localStorage, unsynced, to retry next load / next leave.
    await page.locator('#again-btn').click();
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts.length
        )
      )
      .toBeGreaterThanOrEqual(1);
    items = await readHistory(page);
    expect(items).toHaveLength(1);
    expect(items[0].synced).toBe(false);
  });
});

test.describe('to-do / thought tagging (result screen)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      (key: string) => window.localStorage.setItem('voice-capture.gemini-key', key),
      FAKE_KEY
    );
    await installMocks(page); // supabaseOnline = true
    await page.goto('/');
  });

  test('tapping To-Do tags the note LOCALLY (no POST yet); leaving sends it with category:todo', async ({
    page,
  }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();

    // Result screen, saved locally, tag chips present.
    await expect(page.locator('#transcript')).toHaveValue(FAKE_TRANSCRIPT);
    await expect(page.locator('#save-status')).toHaveText('Saved ✓');

    const todoChip = page.locator('.tag-chip[data-tag="todo"]');
    await expect(todoChip).toBeVisible();
    await todoChip.click();

    // The chip paints active and the local item now carries category 'todo' — all LOCAL.
    await expect(page.locator('.tag-chip[data-tag="todo"]')).toHaveClass(/is-active/);
    const items = await readHistory(page);
    expect(items[0].category).toBe('todo');

    // No network call has happened yet — the tag is local until the note is sent.
    let posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    expect(posts).toHaveLength(0);

    // Leave the result screen → the deferred send fires, and the chosen tag rides along in the
    // single INSERT body (category:'todo'). There is no PATCH path.
    await page.locator('#again-btn').click();
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts.length
        )
      )
      .toBeGreaterThanOrEqual(1);
    posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    const first = posts[0] as Record<string, unknown>;
    expect(first.transcript).toBe(FAKE_TRANSCRIPT);
    expect(first.source).toBe('voice');
    expect(first.category).toBe('todo');
  });

  test('tapping the active To-Do chip again clears the tag locally (insert carries no category)', async ({
    page,
  }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();
    await expect(page.locator('#save-status')).toHaveText('Saved ✓');

    await page.locator('.tag-chip[data-tag="todo"]').click();
    await expect(page.locator('.tag-chip[data-tag="todo"]')).toHaveClass(/is-active/);
    // Tap again → unsorted (local).
    await page.locator('.tag-chip[data-tag="todo"]').click();
    await expect(page.locator('.tag-chip[data-tag="todo"]')).not.toHaveClass(/is-active/);

    const items = await readHistory(page);
    expect(items[0].category).toBeUndefined();

    // Leave → the note is sent untagged: the insert body has no `category` key.
    await page.locator('#again-btn').click();
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts.length
        )
      )
      .toBeGreaterThanOrEqual(1);
    const posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    const first = posts[0] as Record<string, unknown>;
    expect('category' in first).toBe(false);
  });
});

test.describe('history view', () => {
  const SEED = [
    {
      id: 'h-newest',
      transcript: 'Newest note — שלום',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      durationSeconds: 12,
      synced: true,
      category: 'todo',
    },
    {
      id: 'h-middle',
      transcript: 'Middle thought note',
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      durationSeconds: 8,
      synced: true,
      category: 'thought',
    },
    {
      id: 'h-oldest',
      transcript: 'Older note pending sync',
      createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      durationSeconds: 5,
      synced: false,
    },
  ];

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, seed, histKey }: { key: string; seed: unknown; histKey: string }) => {
        window.localStorage.setItem('voice-capture.gemini-key', key);
        window.localStorage.setItem(histKey, JSON.stringify(seed));
      },
      { key: FAKE_KEY, seed: SEED, histKey: HISTORY_KEY }
    );
    // Online so the seeded unsynced item may flip during the on-load sync; the list still
    // renders all rows. We assert on counts/text/copy/delete, not on the live dot race.
    await installMocks(page);
    await page.goto('/');
  });

  test('opening History lists saved items newest first, with an empty-state guard', async ({
    page,
  }) => {
    await page.locator('#open-history').click();
    await expect(page.locator('.screen-history')).toBeVisible();
    await expect(page.locator('.history-item')).toHaveCount(3);
    // Newest first: the first row carries the newest item's text.
    await expect(page.locator('.history-item').first().locator('.history-text')).toContainText(
      'Newest note'
    );
    await expect(page.locator('.history-empty')).toHaveCount(0);
  });

  test('copy on a history row flips to "Copied ✓"', async ({ page }) => {
    await page.locator('#open-history').click();
    const firstCopy = page.locator('.history-item').first().locator('.history-copy');
    await firstCopy.click();
    await expect(firstCopy).toHaveText('Copied ✓');
  });

  test('delete removes the row from the list and from localStorage', async ({ page }) => {
    await page.locator('#open-history').click();
    await expect(page.locator('.history-item')).toHaveCount(3);
    // Delete the first (newest) row.
    await page.locator('.history-item').first().locator('.history-delete').click();
    await expect(page.locator('.history-item')).toHaveCount(2);
    const items = await readHistory(page);
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.id === 'h-newest')).toBe(false);
  });

  test('empty history shows the calm empty state', async ({ page }) => {
    await page.evaluate((k: string) => window.localStorage.removeItem(k), HISTORY_KEY);
    await page.locator('#open-history').click();
    await expect(page.locator('.history-empty')).toHaveText('No saved notes yet.');
    await expect(page.locator('.history-item')).toHaveCount(0);
  });

  test('filter chips show only matching items (To-Do, then Thoughts, then All)', async ({
    page,
  }) => {
    await page.locator('#open-history').click();
    await expect(page.locator('.history-item')).toHaveCount(3);

    // To-Do filter → only the one 'todo' row.
    await page.locator('.filter-chip[data-filter="todo"]').click();
    await expect(page.locator('.history-item')).toHaveCount(1);
    await expect(page.locator('.history-item').first().locator('.history-text')).toContainText(
      'Newest note'
    );

    // Thoughts filter → only the one 'thought' row.
    await page.locator('.filter-chip[data-filter="thought"]').click();
    await expect(page.locator('.history-item')).toHaveCount(1);
    await expect(page.locator('.history-item').first().locator('.history-text')).toContainText(
      'Middle thought note'
    );

    // Back to All → all three.
    await page.locator('.filter-chip[data-filter="all"]').click();
    await expect(page.locator('.history-item')).toHaveCount(3);
  });

  test('sort toggle reorders newest ↔ oldest', async ({ page }) => {
    await page.locator('#open-history').click();
    // Default newest-first: first row = newest.
    await expect(page.locator('.history-item').first().locator('.history-text')).toContainText(
      'Newest note'
    );

    // Flip to Oldest: first row becomes the oldest.
    await page.locator('#sort-toggle').click();
    await expect(page.locator('#sort-toggle')).toContainText('Oldest');
    await expect(page.locator('.history-item').first().locator('.history-text')).toContainText(
      'Older note'
    );

    // Flip back to Newest.
    await page.locator('#sort-toggle').click();
    await expect(page.locator('#sort-toggle')).toContainText('Newest');
    await expect(page.locator('.history-item').first().locator('.history-text')).toContainText(
      'Newest note'
    );
  });
});

// These two cases need a single, controlled, already-synced item — seeded via addInitScript
// (so a page reload re-seeds the SAME state, not the multi-item SEED above) and synced=true
// so the on-load syncPending() never rewrites the store out from under the test.
test.describe('history tagging + filter empty-state (single seeded item)', () => {
  const ONE = [
    {
      id: 'only',
      transcript: 'untagged only note',
      createdAt: new Date().toISOString(),
      durationSeconds: 4,
      synced: true,
    },
  ];

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, seed, histKey }: { key: string; seed: unknown; histKey: string }) => {
        window.localStorage.setItem('voice-capture.gemini-key', key);
        window.localStorage.setItem(histKey, JSON.stringify(seed));
      },
      { key: FAKE_KEY, seed: ONE, histKey: HISTORY_KEY }
    );
    await installMocks(page);
    await page.goto('/');
  });

  test('a filter with no matches shows its own empty state, not "no saved notes"', async ({
    page,
  }) => {
    await page.locator('#open-history').click();
    await expect(page.locator('.history-item')).toHaveCount(1);
    // The one note is untagged → the To-Do filter matches nothing.
    await page.locator('.filter-chip[data-filter="todo"]').click();
    await expect(page.locator('.history-item')).toHaveCount(0);
    await expect(page.locator('.history-empty')).toHaveText('No to-dos yet.');
  });

  test('tapping a history row tag chip cycles unsorted → To-Do LOCALLY (no network call)', async ({
    page,
  }) => {
    await page.locator('#open-history').click();
    const chip = page.locator('.history-item').first().locator('.history-tag-chip');
    await expect(chip).toContainText('Tag');
    await chip.click();
    // Cycled to To-Do.
    await expect(page.locator('.history-item').first().locator('.history-tag-chip')).toContainText(
      'To-Do'
    );
    const items = await readHistory(page);
    expect(items[0].category).toBe('todo');

    // The seeded note is already synced, and anon can't update — so re-tagging in History is a
    // LOCAL-only change. No POST fires (it was already sent on a prior pass; this seed starts
    // synced). Known, accepted v0 limitation: the server row keeps its original tag.
    const posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    expect(posts).toHaveLength(0);
  });
});
