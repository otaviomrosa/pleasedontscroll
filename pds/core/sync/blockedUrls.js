// Queries against the `blocked_urls` table, scoped to a profile.

import { supabaseFetch } from './restClient.js';

/**
 * Blocked URLs for a profile, newest first.
 * Returns null (not []) on a failed fetch, distinct from a genuinely empty
 * list, so callers that cache the result (the background worker) can choose
 * to keep a stale list instead of treating a network blip as "unblock everything."
 */
export async function fetchBlockedUrls(accessToken, profileId) {
  return await supabaseFetch(
    `/rest/v1/blocked_urls?profile_id=eq.${encodeURIComponent(profileId)}&select=id,url&order=created_at.desc`,
    accessToken,
  );
}

/**
 * Adds a URL to a profile's blocklist. Returns the created row or null on failure.
 * @param {{ profileId: string, userId: string, url: string }} params
 */
export async function addBlockedUrl(accessToken, { profileId, userId, url }) {
  const rows = await supabaseFetch('/rest/v1/blocked_urls', accessToken, {
    method: 'POST',
    body: JSON.stringify({ url, profile_id: profileId, user_id: userId }),
  });
  return rows?.[0] ?? null;
}

export async function removeBlockedUrl(accessToken, urlId) {
  const result = await supabaseFetch(`/rest/v1/blocked_urls?id=eq.${encodeURIComponent(urlId)}`, accessToken, {
    method: 'DELETE',
  });
  return result !== null;
}
