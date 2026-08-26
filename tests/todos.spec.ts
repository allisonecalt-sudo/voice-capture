// todos.spec.ts — the To-Do destination on the compose screen (v35)
// WHAT: drives the real app against the LIVE `memos_test` twin (?db=test) — pick "To-Do list",
//       type the way she types, watch it land on the list, check it off, and confirm the choice
//       is still there after a reload.
// WHY:  her ask was about the FEEL — "super easy, select To Do List and then do like my usual
//       talking or writing and then just is there." That is a round-trip claim (it really is on
//       the list), so it is tested against the real REST path, like memos.spec.ts, not a mock.
// DECIDED: prod `memos` is NEVER touched — todos.ts only targets it when ?db=test is absent, and
//       every row here carries a unique marker that the test deletes afterwards. Navigate to the
//       CLEAN url `/?db=test`: `serve` 301s /index.html to / and DROPS the query string, which
//       would silently retarget the test at her live list.

import { test, expect } from '@playwright/test';

const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';
const TEST_TABLE_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/memos_test';
const HEADERS = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

async function cleanupRows(
  request: import('@playwright/test').APIRequestContext,
  contents: string[]
): Promise<void> {
  for (const content of contents) {
    await request.delete(`${TEST_TABLE_URL}?content=eq.${encodeURIComponent(content)}`, {
      headers: HEADERS,
    });
  }
}

test.describe('To-Do destination (live memos_test via ?db=test)', () => {
  test('pick To-Do → type → it is on the list → check it off', async ({ page, request }) => {
    const marker = `e2e-todo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const todoText = `${marker} book the orthopedist`;

    await page.goto('/?db=test');

    // The switch is the whole feature: one tap, before she says anything.
    const todoChip = page.locator('.dest-chip[data-dest="todo"]');
    await expect(todoChip).toBeVisible();
    await todoChip.click();
    await expect(todoChip).toHaveAttribute('aria-pressed', 'true');

    // The screen now says what it is — placeholder and list panel, not the brain-dump canvas.
    await expect(page.locator('#draft')).toHaveAttribute('placeholder', 'Add a to-do…');
    await expect(page.locator('.todo-panel')).toBeVisible();

    // "my usual talking or writing" — the typed half.
    await page.locator('#draft').fill(todoText);
    await page.locator('#compose-action').click();

    // "and then just is there".
    await expect(page.locator('.todo-row', { hasText: todoText })).toBeVisible({ timeout: 15000 });
    // The composer clears so the next one can go straight in.
    await expect(page.locator('#draft')).toHaveValue('');

    // Check it off — it leaves the active list and lands in the Done fold, never deleted.
    const row = page.locator('.todo-row', { hasText: todoText });
    await row.locator('.todo-check').click();
    await expect(page.locator('.todo-done-fold')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.todo-done-fold .todo-row', { hasText: todoText })).toHaveCount(1);

    await cleanupRows(request, [todoText]);
  });

  test('the choice is sticky — a reload comes back on To-Do', async ({ page }) => {
    await page.goto('/?db=test');
    await page.locator('.dest-chip[data-dest="todo"]').click();
    await expect(page.locator('.dest-chip[data-dest="todo"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await page.reload();

    await expect(page.locator('.dest-chip[data-dest="todo"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.locator('#draft')).toHaveAttribute('placeholder', 'Add a to-do…');
  });

  test('switching back to Brain dump restores the normal capture screen', async ({ page }) => {
    await page.goto('/?db=test');
    await page.locator('.dest-chip[data-dest="todo"]').click();
    await expect(page.locator('.todo-panel')).toBeVisible();

    await page.locator('.dest-chip[data-dest="inbox"]').click();

    await expect(page.locator('.todo-panel')).toHaveCount(0);
    await expect(page.locator('.canvas-hint')).toBeVisible();
    await expect(page.locator('#draft')).toHaveAttribute('placeholder', "What's on your mind?");
  });

  test('the voice half: record → transcribe → it lands on the list, not the inbox', async ({
    page,
    request,
  }) => {
    const marker = `e2e-todo-voice-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const spoken = `${marker} refill the magnesium`;

    // Mic + audio graph faked in-page; Gemini intercepted at the NETWORK layer (page.route) rather
    // than by replacing window.fetch, so the Supabase round trip to memos_test stays real.
    await page.addInitScript((key: string) => {
      window.localStorage.setItem('voice-capture.gemini-key', key);
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
    }, 'AIzaTEST-fake-key-1234');

    await page.route('**generativelanguage.googleapis.com**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text: spoken }] } }] }),
      })
    );

    await page.goto('/?db=test');
    await page.locator('.dest-chip[data-dest="todo"]').click();

    // Empty composer → the action button is the mic. Record a beat, then stop & transcribe
    // (the recording screen swaps in its own Stop button; #compose-action is gone by then).
    await page.locator('#compose-action').click();
    await expect(page.locator('#stop-btn')).toBeVisible();
    await page.waitForTimeout(600);
    await page.locator('#stop-btn').click();

    // The transcript is on the LIST.
    await expect(page.locator('.todo-row', { hasText: spoken })).toBeVisible({ timeout: 20000 });

    await cleanupRows(request, [spoken]);
  });
});
