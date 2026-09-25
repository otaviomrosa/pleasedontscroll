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
 * Maps a failed Supabase Auth response to clearer, polished copy shown to
 * the user. Takes the whole parsed body, not a single field, because
 * different Auth endpoints (and different Supabase versions) put the error
 * text under different keys — error_description (OAuth-style, the token
 * endpoint), msg (most other Auth endpoints), message, or error. Checking
 * all of them here, once, means a call site can't silently regress to
 * showing the generic fallback just because it only checked one field (that
 * exact bug happened: signIn/signUp only checked error_description/message
 * and missed msg, which is what this endpoint actually returns).
 *
 * Supabase deliberately returns the SAME "Invalid login credentials"
 * message whether the email doesn't exist or the password is wrong —
 * intentional, industry-standard behavior to prevent account enumeration
 * (an attacker probing which emails have accounts by reading the error).
 * Don't try to split this into separate "no such email" / "wrong password"
 * messages — Supabase's API doesn't expose enough to do that safely, and
 * faking it would reintroduce the enumeration risk this protects against.
 */
function friendlyAuthError(data) {
  const raw = data?.error_description || data?.msg || data?.message || data?.error || '';
  const msg = raw.toLowerCase();

  if (msg.includes('invalid login credentials')) {
    return 'Incorrect email or password. Please try again.';
  }
  if (msg.includes('email not confirmed')) {
    return 'Please confirm your email before signing in — check your inbox.';
  }
  if (msg.includes('already registered') || msg.includes('already exists')) {
    return 'An account with this email already exists. Try signing in instead.';
  }

  return raw || 'Something went wrong. Please try again.';
}

/**
 * Signs in with email + password. Returns { session, error }.
 * `session` matches Supabase's token response shape: access_token,
 * refresh_token, expires_at (unix seconds), user: { id, email, ... }.
 */
export async function signIn(email, password) {
  const { res, data } = await authFetch('/auth/v1/token?grant_type=password', { email, password });
  if (!res.ok) return { session: null, error: friendlyAuthError(data) };
  return { session: data, error: null };
}

/**
 * Signs up a new user. Returns { session, error }.
 *
 * `redirectTo`, if given, is where the confirmation email's link lands the
 * user (same `?redirect_to=` query param requestPasswordReset() below uses
 * against Supabase Auth's REST API). Without it, Supabase falls back to the
 * project's Site URL (Authentication → URL Configuration in the Supabase
 * dashboard) — if that's ever left pointed at a local dev URL, every
 * confirmation link sends users to localhost regardless of what domain they
 * actually signed up from. Callers should always pass this explicitly
 * rather than relying on that dashboard default. As with
 * requestPasswordReset(), Supabase silently ignores redirectTo unless it's
 * also in that same dashboard's Redirect URLs allowlist — passing it here
 * doesn't skip needing that entry.
 */
export async function signUp(email, password, redirectTo) {
  const path = redirectTo
    ? `/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`
    : '/auth/v1/signup';
  const { res, data } = await authFetch(path, { email, password });
  if (!res.ok) return { session: null, error: friendlyAuthError(data) };
  if (data.access_token) return { session: data, error: null };
  return { session: null, error: 'Check your email to confirm your account.' };
}

/**
 * Resends a signup confirmation email. Returns { ok, error }.
 *
 * Exists because re-calling signUp() with an email that's already
 * registered but unconfirmed doesn't reliably send a new email — Supabase
 * deliberately returns an ambiguous, success-shaped response for that case
 * (same anti-enumeration reasoning as requestPasswordReset() not revealing
 * whether an account exists), so a repeat signup attempt can silently do
 * nothing. This calls Auth's dedicated /resend endpoint instead, which is
 * the actual supported way to get a fresh link — found after a real report:
 * signing up again with an old, never-confirmed email produced no new
 * email, and the original link had since expired with no way back in.
 *
 * `redirectTo` behaves the same as signUp()'s — must be in the Supabase
 * dashboard's Redirect URLs allowlist or it's silently ignored.
 */
export async function resendConfirmationEmail(email, redirectTo) {
  const path = redirectTo
    ? `/auth/v1/resend?redirect_to=${encodeURIComponent(redirectTo)}`
    : '/auth/v1/resend';
  const { res, data } = await authFetch(path, { email, type: 'signup' });
  if (!res.ok) return { ok: false, error: friendlyAuthError(data) };
  return { ok: true, error: null };
}

/**
 * Sends a password-recovery email. `redirectTo` must be an allowlisted
 * Redirect URL in Supabase Dashboard → Authentication → URL Configuration,
 * or Supabase silently ignores it. Clicking the emailed link lands the user
 * back on `redirectTo` with recovery tokens in the URL hash (not a query
 * string) — see dashboard.html's completeRecoveryFlow() for how those get
 * turned into an actual password change via updatePassword() above.
 *
 * Always resolves { ok: true } on a 2xx, regardless of whether the email
 * actually belongs to an account — Supabase itself doesn't reveal that (same
 * enumeration-prevention reasoning as friendlyAuthError's login mapping), so
 * there's nothing more specific to tell the caller.
 */
export async function requestPasswordReset(email, redirectTo) {
  const { res, data } = await authFetch(
    `/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
    { email },
  );
  if (!res.ok) return { ok: false, error: friendlyAuthError(data) };
  return { ok: true, error: null };
}

/**
 * Changes the signed-in user's password. Requires a valid access token
 * (not the pre-auth apikey-only flow signIn/signUp use) — this hits
 * Supabase Auth's "update current user" endpoint.
 * Returns { ok: true } or { ok: false, error }.
 */
export async function updatePassword(accessToken, newPassword) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: friendlyAuthError(data) };
  return { ok: true, error: null };
}

/**
 * Fetches the user object for a given access token. Used to complete a
 * session built from an implicit-flow redirect's URL hash (a signup
 * confirmation link, for instance) — those only carry access_token/
 * refresh_token/expires_in, not the user object itself, so this fills that
 * gap before the caller persists a full session. Returns null on failure.
 */
export async function getUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Exchanges a refresh_token for a fresh session. Resolves to one of:
 *   { session }       — success
 *   { invalid: true } — the auth server rejected the refresh token itself
 *                       (400/401: revoked, already used, not found)
 *   { transient: true } — anything that says nothing about the token: a
 *                       network error, a 429, a 5xx, a captive portal's page
 * Only the second may end a session. Treating the third the same way is what
 * used to sign the extension out (and stop all blocking) on a server hiccup
 * or a laptop waking before its Wi-Fi did (audit R3).
 */
async function refreshSessionToken(refreshToken) {
  let res;
  let data;
  try {
    ({ res, data } = await authFetch('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: refreshToken,
    }));
  } catch {
    return { transient: true };
  }
  if (res.ok && data.access_token) return { session: data };
  if (res.status === 400 || res.status === 401) return { invalid: true };
  return { transient: true };
}

// Refreshes in flight in this JS context, keyed by the refresh token being
// spent. On wake, the service worker's alarm, a tab event and a popup
// message can all ask for a token at once; they share one request instead
// of racing the same refresh token (Supabase rotates it on use).
const refreshesInFlight = new Map();

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
 * null when there's no session, when the refresh token was rejected (the
 * session is then cleared), and when the refresh couldn't happen right now
 * (the session is kept for the next attempt). Callers that must tell the
 * last two apart check getStoredSession() afterwards: still there means
 * "try again later", not "signed out".
 */
export async function getValidAccessToken(storage) {
  const session = await getStoredSession(storage);
  if (!session) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (session.expires_at && nowSec < session.expires_at - 60) {
    return session.access_token;
  }

  let pending = refreshesInFlight.get(session.refresh_token);
  if (!pending) {
    pending = refreshSessionToken(session.refresh_token)
      .finally(() => refreshesInFlight.delete(session.refresh_token));
    refreshesInFlight.set(session.refresh_token, pending);
  }
  const result = await pending;

  if (result.session) {
    await persistSession(storage, result.session);
    return result.session.access_token;
  }

  if (result.invalid) {
    // The popup and the service worker are separate contexts sharing one
    // storage. If the other one already refreshed, our token was rejected
    // only because it had just been spent: use theirs, don't sign out.
    const current = await getStoredSession(storage);
    if (current && current.refresh_token !== session.refresh_token) {
      return current.access_token;
    }
    await clearSession(storage);
  }

  return null;
}
