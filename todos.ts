// todos.ts — the To-Do list behind the compose screen's destination switch
// WHAT: read/add/check-off for Allison's to-do list. A thin REST library (no UI, no state
//       machine) that app.ts calls, so picking "To-Do" on the main screen and then talking or
//       typing lands the note straight on the list.
// WHY:  her ask, 2026-08-26: "I want it super easy — select To Do List and then do like my usual
//       talking or writing and then just is there." The app already had a to-do TAG chosen AFTER
//       transcription, which is a step she has to remember, on a screen she reaches after the
//       thought is already out. Choosing the destination FIRST removes the step entirely.
// DECIDED: stores in the EXISTING `memos` table under tag 'todo' — no new table, no schema
//       change. memos already has exactly the right shape (content / tag / status / source /
//       done_at) and had zero rows, so a second parallel list would have been pure duplication.
//       The Memos page keeps working untouched; a to-do is simply a memo with a reserved tag.
// DECIDED: this is a LIBRARY, not a copy of memos.ts. memos.ts is a page controller (its own
//       render loop, its own recorder) and cannot be imported piecemeal, so the four REST calls
//       are re-expressed here against the same table with the same auth posture — anon INSERT
//       (capture is never blocked by login), authenticated SELECT + UPDATE (RLS gives anon no
//       read), and check-off is status='done' + done_at, NEVER a hard delete (her archive rule).
// BUILT: TODO_TAG, Todo, loadTodos(), addTodo(), setTodoDone().
// NEXT:  none. Promotion of a to-do into the canonical todo_tasks DB stays deliberately manual —
//        that table's PRE-INSERT discipline (next_step, energy, calendar pairing) is more than a
//        5-second voice note can honestly fill, so Claude promotes them, the app never does.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
import { getToken } from './auth.js';

// The reserved tag that makes a memo a to-do. Anything else in `memos` is a normal memo and
// never shows up here.
export const TODO_TAG = 'todo';

const REST_BASE = SUPABASE_URL.replace('/voice_captures', '');

// `?db=test` → the memos_test twin, exactly as memos.ts does it, so Playwright can drive the
// real code path without ever touching her live list.
const IS_TEST_DB = new URLSearchParams(window.location.search).get('db') === 'test';
const TABLE_URL = `${REST_BASE}/${IS_TEST_DB ? 'memos_test' : 'memos'}`;

export type TodoSource = 'typed' | 'voice';

export interface Todo {
  id: string;
  content: string;
  status: 'active' | 'done';
  source: TodoSource;
  created_at: string;
  done_at: string | null;
}

/** Reading needs her login (anon has no SELECT under RLS); null means logged out. */
async function readBearer(): Promise<string | null> {
  if (IS_TEST_DB) return SUPABASE_ANON_KEY; // the test twin is anon-open
  try {
    return await getToken();
  } catch {
    return null;
  }
}

/**
 * Every to-do, newest last, done ones included — the caller splits active from done so the
 * check-off animation has both halves without a second round trip.
 *
 * Throws 'logged-out' when there is no session. That is deliberate: RLS answers an anon SELECT
 * with an empty 200, which would render as "no to-dos yet" — a silent lie about her own list.
 * The caller shows a real logged-out state instead (fail-loud rule).
 */
export async function loadTodos(): Promise<Todo[]> {
  const bearer = await readBearer();
  if (!bearer) throw new Error('logged-out');
  const res = await fetch(
    `${TABLE_URL}?select=*&tag=eq.${encodeURIComponent(TODO_TAG)}&order=created_at.asc`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer}` } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()) as Todo[];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Add one to-do. Rides the ANON key on purpose — mirrors voice_captures: getting a thought out
 * of her head is never gated on being logged in. `return=minimal` because anon has no SELECT to
 * read the row back with.
 */
export async function addTodo(content: string, source: TodoSource): Promise<void> {
  const text = content.trim();
  if (!text) return;
  const res = await fetch(TABLE_URL, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ content: text, tag: TODO_TAG, source }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Check off (or un-check) one to-do. Never a hard delete — done is status='done' + a done_at
 * stamp, so the item is archived and pullable, and undo is just the flip back.
 */
export async function setTodoDone(id: string, done: boolean): Promise<void> {
  const bearer = await readBearer();
  if (!bearer) throw new Error('logged-out');
  const res = await fetch(`${TABLE_URL}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(
      done
        ? { status: 'done', done_at: new Date().toISOString() }
        : { status: 'active', done_at: null }
    ),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
