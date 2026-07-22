// Invokes the create-checkout-session Edge Function. A plain fetch POST —
// equivalent to supabase.functions.invoke() without depending on the SDK.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

/**
 * @param {string} accessToken
 * @param {string} priceId - Stripe Price ID for the plan being purchased.
 * @returns {Promise<{ url: string | null, error: string | null }>}
 */
export async function createCheckoutSession(accessToken, priceId) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-checkout-session`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ priceId }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { url: null, error: data.error || 'Checkout failed.' };
  if (!data.url) return { url: null, error: 'No checkout URL returned.' };
  return { url: data.url, error: null };
}
