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
  const result = await supabaseFetch(`/rest/v1/user_settings?id=eq.${encodeURIComponent(userId)}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ blocking_mode: mode === 'strict' ? 'strict' : 'friction' }),
  });
  return result !== null;
}
