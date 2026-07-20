// memos.spec.ts — Memos widget smoke test (memos.html)
// WHAT: drives the real page against the LIVE `memos_test` twin table (?db=test) — add a typed
//       memo, see it render in its tag group, check it off, see it land in the Done fold.
// WHY:  unlike app.spec.ts (which mocks every fetch), the memos widget's whole point is the
//       Supabase round-trip Claude also reads — so the smoke test exercises the real REST path,
//       but ONLY ever against memos_test (anon-open, synthetic rows). Prod `memos` is never
//       touched: the page targets it only when ?db=test is absent.
// DECIDED: every test row carries a unique e2e marker in its content; the test deletes exactly
//       those rows afterwards (hard delete is fine on the TEST table only — the app itself has
//       no delete path anywhere, per her never-hard-delete rule). Tests goto the CLEAN url
//       /memos?db=test: `serve` (local + CI webServer) 301s /memos.html to /memos and DROPS the
//       query string on the way, which would silently retarget the test at prod. Verified
//       2026-07-20 with curl; GitHub Pages serves memos.html directly, so prod is unaffected.

import { test, expect } from '@playwright/test';

// Public client key — same constant the app ships in supabase.ts (safe to commit).
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';
const TEST_TABLE_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/memos_test';

const HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

/** Delete this test's own rows from memos_test (exact-content match, test table only). */
async function cleanupRows(
  request: import('@playwright/test').APIRequestContext,
  contents: string[]
): Promise<void> {
  for (const content of contents) {
    const res = await request.delete(
      `${TEST_TABLE_URL}?content=eq.${encodeURIComponent(content)}`,
      { headers: HEADERS }
    );
    expect(res.status(), `cleanup of "${content}"`).toBe(204);
  }
}

test.describe('memos widget (live memos_test via ?db=test)', () => {
  test('add a memo → it renders → check it off → it lands in Done', async ({ page, request }) => {
    const marker = `e2e-memo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const memoText = `${marker} ask about the gastro referral`;
    const tag = `${marker}-tag`;

    try {
      await page.goto('/memos?db=test');

      // The page banner marks the test DB loudly — proves we are NOT on prod memos.
      await expect(page.locator('.app-version')).toContainText('TEST DB');

      // Add a typed memo with a tag (input + Enter submits).
      await page.locator('#tag-input').fill(tag);
      await page.locator('#memo-input').fill(memoText);
      await page.locator('#memo-input').press('Enter');

      // It renders inside its tag group after the live round-trip.
      const card = page.locator('.memo-card', { hasText: memoText });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.memo-group-title', { hasText: tag })).toBeVisible();
      // The tag also becomes a filter chip.
      await expect(page.locator('.chip', { hasText: tag })).toBeVisible();

      // Check it off → leaves the active list, lands in the collapsible Done fold.
      await card.locator('.memo-check').click();
      await expect(page.locator('.memo-card', { hasText: memoText })).toHaveCount(0, {
        timeout: 15_000,
      });
      const fold = page.locator('.done-fold');
      await expect(fold.locator('.done-summary')).toContainText('Done');
      await fold.locator('.done-summary').click();
      const doneRow = page.locator('.done-row', { hasText: memoText });
      await expect(doneRow).toBeVisible();
      // done_at is shown ("done Jul 20, 3:45 PM") and undo is offered.
      await expect(doneRow.locator('.done-meta')).toContainText('done ');
      await expect(doneRow.locator('.undo-btn')).toBeVisible();

      // The row was archived (status=done), never deleted — verify against the table itself.
      const check = await request.get(
        `${TEST_TABLE_URL}?content=eq.${encodeURIComponent(memoText)}&select=status,done_at`,
        { headers: HEADERS }
      );
      expect(check.status()).toBe(200);
      const rows = (await check.json()) as Array<{ status: string; done_at: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('done');
      expect(rows[0].done_at).not.toBeNull();
    } finally {
      await cleanupRows(request, [memoText]);
    }
  });

  test('undo pulls a done memo back onto the active list', async ({ page, request }) => {
    const marker = `e2e-memo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const memoText = `${marker} bring the kupah card`;

    try {
      // Seed one already-done row directly (faster + independent of the first test).
      const seeded = await request.post(TEST_TABLE_URL, {
        headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        data: {
          content: memoText,
          status: 'done',
          done_at: new Date().toISOString(),
          source: 'typed',
        },
      });
      expect(seeded.status()).toBe(201);

      await page.goto('/memos?db=test');
      const fold = page.locator('.done-fold');
      await expect(fold).toBeVisible({ timeout: 15_000 });
      await fold.locator('.done-summary').click();
      await page.locator('.done-row', { hasText: memoText }).locator('.undo-btn').click();

      // Back on the active list (untagged → General group).
      await expect(page.locator('.memo-card', { hasText: memoText })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await cleanupRows(request, [memoText]);
    }
  });

  test('a failed load says so plainly — never a silent blank', async ({ page }) => {
    // Point every memos_test call at a black hole before the app boots.
    await page.route('**/rest/v1/memos_test**', (route) => route.abort());
    await page.goto('/memos?db=test');
    await expect(page.locator('.error-banner')).toContainText('Couldn’t load memos');
    await expect(page.locator('#retry-load')).toBeVisible();
  });
});
