// version-sync.spec.ts — the guard for the app's hand-synced version constants
// WHAT: asserts that sw.js's cache VERSION and app.ts's APP_VERSION agree, and that both build
//       stamps carry a TIME, not just a date.
// WHY:  parked on the BACKLOG since the 2026-07-17 sweep as "Version-tag CI check — one assert so
//       APP_VERSION / BUILD_DATE / sw VERSION can't drift (three hand-synced constants across 34+
//       deploys)". They drift silently and the cost lands on HER: the service worker keys its
//       shell cache off VERSION, so a bump she can see in the topbar while sw.js still says the
//       old number means the old shell keeps serving — she reads "v35" and uses v34.
// DECIDED: sw.js may carry a PATCH suffix the app does not (v34.3 shipped against app v34 — a
//       worker-only fix with no user-visible app change). So the rule is prefix-with-optional-
//       patch, not strict equality. Anything looser would not have caught the drift; anything
//       stricter would ban a legitimate worker-only ship.
// DECIDED: the time-in-the-stamp assert is her explicit rule (date AND time in a version tag), so
//       "did the new build actually load?" is answerable when two builds ship the same day.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (file: string): string => readFileSync(join(process.cwd(), file), 'utf-8');

function pick(source: string, pattern: RegExp, what: string): string {
  const m = source.match(pattern);
  expect(m, `${what} not found — was the constant renamed?`).not.toBeNull();
  return m![1];
}

test.describe('version constants stay in sync', () => {
  test("sw.js's cache VERSION matches app.ts's APP_VERSION", () => {
    const appVersion = pick(read('app.ts'), /const APP_VERSION = '([^']+)'/, 'APP_VERSION');
    const swVersion = pick(read('sw.js'), /const VERSION = '([^']+)'/, 'sw.js VERSION');

    // 'v35' → sw must be 'voice-capture-v35' or a patch of it ('voice-capture-v35.2').
    expect(
      swVersion,
      `sw.js says "${swVersion}" but app.ts says "${appVersion}". The service worker keys its ` +
        `shell cache off VERSION — leaving it behind means the OLD shell keeps serving while the ` +
        `topbar advertises the new one.`
    ).toMatch(new RegExp(`^voice-capture-${appVersion.replace('.', '\\.')}(\\.\\d+)?$`));
  });

  test('both build stamps carry a time, not just a date', () => {
    const appBuild = pick(read('app.ts'), /const BUILD_DATE = '([^']+)'/, 'BUILD_DATE');
    const memosBuild = pick(read('memos.ts'), /const MEMOS_BUILD = '([^']+)'/, 'MEMOS_BUILD');

    // Her rule: a version tag carries date AND time, so two builds on the same day are tellable
    // apart — "which one is actually loaded on my phone?" has to have an answer.
    for (const [name, stamp] of [
      ['BUILD_DATE', appBuild],
      ['MEMOS_BUILD', memosBuild],
    ] as const) {
      expect(stamp, `${name} ("${stamp}") must include a time like "2:05pm"`).toMatch(
        /\d{1,2}:\d{2}\s*(am|pm)/i
      );
    }
  });

  test('every precached module in sw.js actually exists in dist/', () => {
    const sw = read('sw.js');
    const block = sw.slice(sw.indexOf('const CRITICAL_ASSETS'), sw.indexOf('const NICE_ASSETS'));
    const modules = [...block.matchAll(/'\.\/(dist\/[a-z-]+\.js)'/g)].map((m) => m[1]);
    expect(
      modules.length,
      'no dist modules found in CRITICAL_ASSETS — did the list move?'
    ).toBeGreaterThan(0);
    for (const file of modules) {
      // A precache entry pointing at a missing file fails the SW install outright, and install
      // is all-or-nothing — she would be left on the previous build with no visible reason.
      expect(() => read(file), `${file} is precached by sw.js but does not exist`).not.toThrow();
    }
  });

  test('every compiled module is precached — a missing one boots the app blank offline', () => {
    const sw = read('sw.js');
    const tsconfig = JSON.parse(read('tsconfig.json')) as { include: string[] };
    // Every source file tsc compiles becomes a dist module the ES module graph may pull in. If one
    // is absent from the shell cache, an offline first-open fails the WHOLE graph and she gets a
    // blank screen — exactly the v34 bug (auth.js was missing), and the reason todos.js was added
    // to the list the moment it was created.
    const expected = tsconfig.include
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `./dist/${f.replace(/\.ts$/, '.js')}`);
    for (const asset of expected) {
      expect(sw, `${asset} is compiled but NOT precached by sw.js`).toContain(`'${asset}'`);
    }
  });
});
