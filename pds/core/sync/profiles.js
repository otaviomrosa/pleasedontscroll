// Queries against the `profiles` table. Used by the extension (background +
// popup) and the web dashboard identically — see /core/types for the row shape.

import { supabaseFetch } from './restClient.js';

/** All profiles owned by the current user, oldest first. */
export async function fetchProfiles(accessToken) {
  const rows = await supabaseFetch(
    '/rest/v1/profiles?select=id,name,is_active&order=created_at.asc',
    accessToken,
  );
  return rows ?? [];
}

/** The user's single active profile ({ id, name }), or null if none is active. */
export async function fetchActiveProfile(accessToken) {
  const rows = await supabaseFetch(
    '/rest/v1/profiles?is_active=eq.true&select=id,name&limit=1',
    accessToken,
  );
  if (!rows || rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name };
}

/** Creates a new, inactive profile. Returns the created row or null on failure. */
export async function createProfile(accessToken, userId, name) {
  const rows = await supabaseFetch('/rest/v1/profiles', accessToken, {
    method: 'POST',
    body: JSON.stringify({ name, is_active: false, user_id: userId }),
  });
  return rows?.[0] ?? null;
}

/**
 * Atomically makes `profileId` the only active profile for `userId`, via
 * the switch_active_profile() RPC (010_atomic_profile_switch.sql) — a
 * single transaction, not two separate PATCH requests. That used to be two
 * round trips (deactivate all, then activate one); an interruption between
 * them could leave a user with zero active profiles, which
 * background/index.js's refreshBlocklist() has no good recovery from
 * (disables blocking entirely). The RPC function enforces its own
 * authorization (auth.uid() = userId) internally, since it runs as
 * SECURITY DEFINER and bypasses RLS — see that migration's comments.
 */
export async function switchProfile(accessToken, userId, profileId) {
  const result = await supabaseFetch('/rest/v1/rpc/switch_active_profile', accessToken, {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId, p_profile_id: profileId }),
  });

  return result !== null;
}

/** Deletes a profile. Its blocked_urls rows cascade-delete via the FK. */
export async function deleteProfile(accessToken, profileId) {
  const result = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(profileId)}`, accessToken, {
    method: 'DELETE',
  });
  return result !== null;
}
