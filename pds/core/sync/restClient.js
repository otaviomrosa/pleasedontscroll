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

/**
 * Same request as supabaseFetch(), but keeps the failure reason. Resolves
 * to { data, error }: `data` is the parsed body (null when empty), `error`
 * is null on success, or the PostgREST error body's `message` — which for
 * a trigger's RAISE EXCEPTION is exactly the text the trigger raised, so a
 * UI can show it verbatim ("That time overlaps another block."). Falls back
 * to "Request failed (status)" when the body has no message.
 *
 * Exists because supabaseFetch() returns null for both a failed request and
 * an empty success body, which was fine while every write either succeeded
 * or failed for one obvious reason. Schedule writes can be rejected for
 * several distinct, user-actionable reasons, so the caller needs the text.
 * supabaseFetch()'s contract stays untouched for every existing caller.
 * @param {string} path
 * @param {string} accessToken
 * @param {RequestInit} [options]
 * @returns {Promise<{ data: any | null, error: string | null }>}
 */
export async function supabaseFetchDetailed(path, accessToken, options = {}) {
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

  const text = await res.text();

  if (!res.ok) {
    console.warn('[PDS] Supabase error:', res.status, text);
    let message = null;
    try {
      message = text ? JSON.parse(text)?.message ?? null : null;
    } catch {
      message = null;
    }
    return { data: null, error: message || `Request failed (${res.status})` };
  }

  return { data: text ? JSON.parse(text) : null, error: null };
}
