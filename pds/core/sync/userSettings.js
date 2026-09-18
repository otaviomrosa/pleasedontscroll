// Queries against the `user_settings` table.

import { supabaseFetch, supabaseFetchDetailed } from './restClient.js';

/** Whether the given user currently has an active premium subscription. */
export async function fetchIsPremium(accessToken, userId) {
  const rows = await supabaseFetch(
    `/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}&select=is_premium`,
    accessToken,
  );
  return rows?.[0]?.is_premium === true;
}

/**
 * The user's current blocking mode — 'friction' (30s breathing bypass) or
 * 'strict' (no bypass). This is a single per-user setting, not a property
 * of a profile: any profile can be run in either mode. Defaults to
 * 'friction' if the row can't be read.
 */
export async function fetchBlockingMode(accessToken, userId) {
  const rows = await supabaseFetch(
    `/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}&select=blocking_mode`,
    accessToken,
  );
  return rows?.[0]?.blocking_mode === 'strict' ? 'strict' : 'friction';
}

/** Sets the user's blocking mode. Returns true on success. */
export async function setBlockingMode(accessToken, userId, mode) {
  return (await setBlockingModeDetailed(accessToken, userId, mode)).ok;
}

/**
 * Same write as setBlockingMode(), resolving to { ok, error }. `error` is
 * the server's rejection text when a trigger refused the change — leaving
 * Strict during a scheduled Strict block raises "Strict Mode is scheduled
 * until 11:00 PM." (016_schedules.sql) and the popup shows that verbatim.
 */
export async function setBlockingModeDetailed(accessToken, userId, mode) {
  const { error } = await supabaseFetchDetailed(`/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ blocking_mode: mode === 'strict' ? 'strict' : 'friction' }),
  });
  return { ok: error === null, error };
}

// Sentinel for "paused indefinitely, until manually resumed" — no schema
// change needed for this: paused_until stays a plain TIMESTAMPTZ, and a
// far-future value satisfies every existing `Date.now() < pausedUntil`
// check (background/index.js's checkAndBlockTab, refreshPauseUI's isActive)
// without any special-casing there. Only the *display* layer (dashboard,
// popup) needs to recognize this value to show "indefinitely" instead of a
// real (meaningless, year-9999) clock time.
export const INDEFINITE_PAUSE_ISO = '9999-12-31T23:59:59.000Z';

/**
 * Whether a paused_until value (ISO string OR epoch ms — background.js's
 * GET_STATE hands back the latter) represents the indefinite sentinel.
 * Compares the parsed year, not the raw string: Postgres/PostgREST don't
 * necessarily round-trip the exact string that was written (e.g.
 * `+00:00` vs `Z`, different sub-second precision), so a strict
 * `=== INDEFINITE_PAUSE_ISO` check silently failed here — the value came
 * back reformatted, fell through to the "real timestamp" display branch,
 * and rendered as if it were a normal (if absurd, year-9999) time.
 */
export function isIndefinitePause(pausedUntil) {
  if (!pausedUntil) return false;
  return new Date(pausedUntil).getFullYear() >= 9000;
}

/**
 * The user's current pause-until timestamp (ISO string), or null if not
 * currently paused. Callers must still check it's in the future — this
 * returns whatever's in the column, including an expired one.
 */
export async function fetchPauseUntil(accessToken, userId) {
  const rows = await supabaseFetch(
    `/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}&select=paused_until`,
    accessToken,
  );
  return rows?.[0]?.paused_until ?? null;
}

/**
 * Sets (or clears, passing null) the user's pause-until timestamp. Returns
 * true on success. Friction Mode only by convention — the caller (dashboard)
 * is responsible for checking blocking_mode before calling this; the
 * extension's own enforcement also re-checks mode independently (see
 * background/index.js's checkAndBlockTab), so this alone is never the only
 * thing standing between Strict Mode and a bypass.
 */
export async function setPauseUntil(accessToken, userId, pausedUntilIso) {
  const result = await supabaseFetch(`/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ paused_until: pausedUntilIso }),
  });
  return result !== null;
}

/**
 * Records the user's IANA timezone (e.g. 'America/Sao_Paulo') — but only
 * if none is stored yet. The schedule (016_schedules.sql) evaluates "now"
 * in this zone, and a scheduled Strict block is only as strong as the
 * clock it's measured against: if every client could overwrite the zone,
 * a second device set to another timezone would unlock the block by moving
 * "now" outside it. So the first client to see the account wins, and a
 * change later is deliberately a manual, server-guarded act (the trigger
 * also refuses a change during an active Strict block). Idempotent; the
 * `timezone=is.null` filter makes the no-op case a 200 with an empty
 * array, so this returns true either way and false only on failure.
 */
export async function setTimezoneIfUnset(accessToken, userId, timezone) {
  if (!timezone) return false;
  const result = await supabaseFetch(
    `/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}&timezone=is.null`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify({ timezone }) },
  );
  return result !== null;
}

/**
 * The user's stored timezone (IANA name) or null if never set.
 */
export async function fetchTimezone(accessToken, userId) {
  const rows = await supabaseFetch(
    `/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}&select=timezone`,
    accessToken,
  );
  return rows?.[0]?.timezone ?? null;
}
