// Thin wrapper around the Supabase PostgREST API. All /core/sync modules
// build on this instead of the supabase-js query builder — see the note in
// /core/auth/session.js for why this codebase doesn't depend on the SDK.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

/**
 * @param {string} path - Path + query string, e.g. "/rest/v1/profiles?select=id".
 * @param {string} accessToken
 * @param {RequestInit} [options]
 * @returns {Promise<any | null>} Parsed JSON body, or null on a non-2xx response.
 */
export async function supabaseFetch(path, accessToken, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    console.warn('[PDS] Supabase error:', res.status, await res.text());
    return null;
  }

  // DELETE/PATCH can return an empty 204 body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
