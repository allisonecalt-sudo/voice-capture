// auth.ts — minimal Supabase email/password auth (gotrue REST, no supabase-js)
// WHAT: signs Allison in against this project's Supabase Auth and keeps the session token in
//       localStorage so the Log screen can READ her inbox back (cross-device). Login is the price
//       of reading: the public anon key is INSERT-only by design, so seeing notes from another
//       device requires proving it's her — exactly the login her budget app already uses.
// WHY:  no-deps to match the rest of the app (single static bundle, raw fetch). gotrue's
//       password + refresh_token grants are simple REST calls; we store {access, refresh, expiry}
//       and silently refresh a near-expired token before a read.
// DECIDED: SESSION_KEY = 'vc.session'; refresh 60s before expiry; ANY refresh/login failure clears
//          the session and falls back to logged-out (local-only history) — never a hard error or a
//          dead end. Tokens live only in localStorage on this device, same posture as the Gemini key.
// BUILT:  login(), logout(), isLoggedIn(), currentEmail(), getToken() (auto-refresh).
// NEXT:   none — if multi-user ever happens, scope inbox reads by user_id (today she's the sole user).

import { SUPABASE_ANON_KEY } from './supabase.js';

const AUTH_BASE = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co/auth/v1';
const SESSION_KEY = 'vc.session';

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms when access_token expires
  email: string;
}

// Minimal shape of a gotrue /token response (success fields + the error fields we surface).
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { email?: string };
  error_description?: string;
  msg?: string;
  error?: string;
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (
      typeof s.access_token === 'string' &&
      typeof s.refresh_token === 'string' &&
      typeof s.expires_at === 'number'
    ) {
      return {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at,
        email: typeof s.email === 'string' ? s.email : '',
      };
    }
  } catch {
    // corrupt/disabled storage — treat as logged-out
  }
  return null;
}

function saveSession(s: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // storage disabled — the session simply won't persist; reads fall back to local-only.
  }
}

/** Forget the current session (logged-out → local-only history). */
export function logout(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing more to do
  }
}

export function isLoggedIn(): boolean {
  return loadSession() !== null;
}

export function currentEmail(): string {
  return loadSession()?.email ?? '';
}

function sessionFromResponse(data: TokenResponse, fallbackEmail: string): Session {
  return {
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    email: data.user?.email ?? fallbackEmail,
  };
}

/** Sign in with email + password. Throws an Error with a human-readable message on failure. */
export async function login(email: string, password: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token) {
    throw new Error(
      data.error_description ||
        data.msg ||
        data.error ||
        'Login failed. Check your email and password.'
    );
  }
  saveSession(sessionFromResponse(data, email));
}

async function refresh(s: Session): Promise<Session> {
  const res = await fetch(`${AUTH_BASE}/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token) {
    throw new Error('refresh failed');
  }
  return sessionFromResponse(data, s.email);
}

/**
 * Return a valid access token, refreshing if it's within 60s of expiry. Returns null when there's
 * no session or the refresh failed (caller then shows local-only history). A failed refresh clears
 * the stored session so the UI reflects logged-out.
 */
export async function getToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;
  if (Date.now() < s.expires_at - 60_000) return s.access_token;
  try {
    const ns = await refresh(s);
    saveSession(ns);
    return ns.access_token;
  } catch {
    logout();
    return null;
  }
}
