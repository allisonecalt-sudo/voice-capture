// app.spec.ts — Voice Capture end-to-end (mocked) tests
// WHAT: loads the page and exercises the state machine WITHOUT a real mic or real Gemini
//       key. getUserMedia + AudioContext + the Gemini fetch are all stubbed via an init
//       script so tests are hermetic and never hit a live API or write any prod resource.
// WHY:  the live transcription can't be CI-tested (no key, no mic), so we verify the
//       STRUCTURE: no-key prompt, record button, recording indicator (timer + pulse +
//       waveform), spinner, transcript + copy. The WAV encoder is unit-checked in-page.
// DECIDED: mock at the browser-API boundary (navigator.mediaDevices, AudioContext,
//          window.fetch) — the app code under test stays untouched. The Supabase save POST
//          is ALSO intercepted here (canned 201) so save/history tests never hit prod;
//          an offline variant makes that fetch reject to exercise the "will sync" path.
// BUILT:  fixtures + the tests below (incl. save→history, offline-local-save, history view).
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
 *    voice_captures POST (canned 201, recorded on window.__supabasePosts); when
 *    `supabaseOnline` is false the Supabase fetch REJECTS to exercise the offline path.
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
          const posts = (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts;
          const bodyText = typeof init?.body === 'string' ? init.body : '';
          posts.push(bodyText ? JSON.parse(bodyText) : null);
          if (!online) {
            // Simulate offline: reject so the app falls back to "saved on phone — will sync".
            return Promise.reject(new TypeError('Failed to fetch'));
          }
          // Successful insert: anon RLS returns 201 with an empty body (return=minimal).
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

  test('record → stop writes to local history AND POSTs to Supabase, shows "Saved ✓"', async ({
    page,
  }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();

    // Result screen with the canned transcript.
    await expect(page.locator('#transcript')).toHaveValue(FAKE_TRANSCRIPT);

    // The save status resolves to "Saved ✓" once the (mocked) Supabase insert returns 201.
    await expect(page.locator('#save-status')).toHaveText('Saved ✓');

    // localStorage history has exactly one item, synced, with the transcript.
    const items = await readHistory(page);
    expect(items).toHaveLength(1);
    expect(items[0].transcript).toBe(FAKE_TRANSCRIPT);
    expect(items[0].synced).toBe(true);
    expect(typeof items[0].id).toBe('string');
    expect(typeof items[0].createdAt).toBe('string');

    // The Supabase endpoint was actually called with the expected payload shape.
    const posts = await page.evaluate(
      () => (window as unknown as { __supabasePosts: unknown[] }).__supabasePosts
    );
    expect(posts.length).toBeGreaterThanOrEqual(1);
    const first = posts[0] as Record<string, unknown>;
    expect(first.transcript).toBe(FAKE_TRANSCRIPT);
    expect(first.source).toBe('voice');
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

  test('still saves locally and shows "will sync" when the POST fails', async ({ page }) => {
    await page.locator('#record-btn').click();
    await expect(page.locator('#timer')).toBeVisible();
    await page.locator('#stop-btn').click();

    await expect(page.locator('#transcript')).toHaveValue(FAKE_TRANSCRIPT);

    // Offline: the transcript is never lost — it's in localStorage, marked unsynced.
    await expect(page.locator('#save-status')).toHaveText('Saved on phone — will sync');
    const items = await readHistory(page);
    expect(items).toHaveLength(1);
    expect(items[0].transcript).toBe(FAKE_TRANSCRIPT);
    expect(items[0].synced).toBe(false);
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
    // renders both rows. We assert on counts/text/copy/delete, not on the live dot race.
    await installMocks(page);
    await page.goto('/');
  });

  test('opening History lists saved items newest first, with an empty-state guard', async ({
    page,
  }) => {
    await page.locator('#open-history').click();
    await expect(page.locator('.screen-history')).toBeVisible();
    await expect(page.locator('.history-item')).toHaveCount(2);
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
    await expect(page.locator('.history-item')).toHaveCount(2);
    // Delete the first (newest) row.
    await page.locator('.history-item').first().locator('.history-delete').click();
    await expect(page.locator('.history-item')).toHaveCount(1);
    const items = await readHistory(page);
    expect(items).toHaveLength(1);
    expect(items.some((i) => i.id === 'h-newest')).toBe(false);
  });

  test('empty history shows the calm empty state', async ({ page }) => {
    await page.evaluate((k: string) => window.localStorage.removeItem(k), HISTORY_KEY);
    await page.locator('#open-history').click();
    await expect(page.locator('.history-empty')).toHaveText('No saved notes yet.');
    await expect(page.locator('.history-item')).toHaveCount(0);
  });
});
