// Invokes the delete-account Edge Function — permanently deletes the
// signed-in user's account. Cancels any active Stripe subscription first,
// then deletes the auth user; profiles/blocked_urls/user_settings all
// cascade-delete via their FK constraints, so there's nothing else to clean
// up client-side.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

/**
 * @param {string} accessToken
 * @returns {Promise<{ ok: boolean, error: string | null }>}
 */
export async function deleteAccount(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Could not delete account.' };
  return { ok: true, error: null };
}
