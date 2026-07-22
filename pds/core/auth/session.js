// Session management — plain Supabase Auth REST calls, deliberately not the
// supabase-js SDK.
//
// Why: this module has to run identically in the extension's background
// service worker, the extension popup, AND plain web pages. The background
// service worker is the constraint — MV3 tears it down when idle, and
// supabase-js's autoRefreshToken relies on an internal timer with no
// documented guarantee of surviving that suspension. The SDK also needs a
// `global: { fetch }` override to work at all in a service worker (no
// XMLHttpRequest there) and Supabase's own tracker has an open, unresolved
// thread on inconsistent auth behavior between tab/popup and service-worker
// contexts. Hand-rolled REST + refresh-on-demand (below) sidesteps all of
// that by never depending on a background timer — every call checks/refreshes
// the token right before it's used, everywhere, uniformly.
//
// If you're tempted to swap this back to supabase-js: that's what was tried
// first. It's not that it doesn't work in a normal browser tab (it does) —
// it's specifically the service worker that isn't safe. Don't reintroduce it
// there.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const SESSION_KEY = 'pds_session';

async function authFetch(path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * Signs in with email + password. Returns { session, error }.
 * `session` matches Supabase's token response shape: access_token,
 * refresh_token, expires_at (unix seconds), user: { id, email, ... }.
 */
export async function signIn(email, password) {
  const { res, data } = await authFetch('/auth/v1/token?grant_type=password', { email, password });
  if (!res.ok) return { session: null, error: data.error_description || data.message || 'Sign-in failed.' };
  return { session: data, error: null };
}

/** Signs up a new user. Returns { session, error }. */
export async function signUp(email, password) {
  const { res, data } = await authFetch('/auth/v1/signup', { email, password });
  if (!res.ok) return { session: null, error: data.error_description || data.message || 'Sign-up failed.' };
  if (data.access_token) return { session: data, error: null };
  return { session: null, error: 'Check your email to confirm your account.' };
}

/** Exchanges a refresh_token for a fresh session, or null if it's no longer valid. */
async function refreshSessionToken(refreshToken) {
  const { res, data } = await authFetch('/auth/v1/token?grant_type=refresh_token', {
    refresh_token: refreshToken,
  });
  if (!res.ok || !data.access_token) return null;
  return data;
}

export async function persistSession(storage, session) {
  await storage.set(SESSION_KEY, session);
}

export async function getStoredSession(storage) {
  return await storage.get(SESSION_KEY);
}

export async function clearSession(storage) {
  await storage.remove(SESSION_KEY);
}

export async function signOut(storage) {
  await clearSession(storage);
}

/**
 * Returns a valid access token, transparently refreshing (and persisting the
 * refreshed session) if the stored one is expired or about to be. Returns
 * null if there's no session, or the refresh token itself is no longer valid
 * (in which case the stale session is cleared).
 */
export async function getValidAccessToken(storage) {
  const session = await getStoredSession(storage);
  if (!session) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (session.expires_at && nowSec < session.expires_at - 60) {
    return session.access_token;
  }

  const fresh = await refreshSessionToken(session.refresh_token);
  if (!fresh) {
    await clearSession(storage);
    return null;
  }

  await persistSession(storage, fresh);
  return fresh.access_token;
}
