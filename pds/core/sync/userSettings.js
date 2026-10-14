// Queries against the `user_settings` table.

import { supabaseFetch } from './restClient.js';

/** Whether the given user currently has an active premium subscription. */
export async function fetchIsPremium(accessToken, userId) {
  const rows = await supabaseFetch(
    `/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}&select=is_premium`,
    accessToken,
  );
  return rows?.[0]?.is_premium === true;
}

/**
 * is_premium, blocking_mode and session_until in one read, or null when the
 * request failed, so a network blip leaves the extension's cached state alone.
 * Throws if fetch itself throws (offline), same as supabaseFetch().
 * @returns {Promise<{ isPremium: boolean, blockingMode: 'friction'|'strict', sessionUntil: string|null } | null>}
 */
export async function fetchSettingsSnapshot(accessToken, userId) {
  const rows = await supabaseFetch(
    `/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}&select=is_premium,blocking_mode,session_until`,
    accessToken,
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    isPremium: row.is_premium === true,
    blockingMode: row.blocking_mode === 'strict' ? 'strict' : 'friction',
    sessionUntil: row.session_until ?? null,
  };
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
