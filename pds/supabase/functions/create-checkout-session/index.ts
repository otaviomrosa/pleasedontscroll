/**
 * PDS Edge Function: create-checkout-session
 * ============================================================
 * Creates a Stripe Checkout Session for the Focus Pro subscription.
 *
 * Required environment variables (set via `supabase secrets set`):
 *   STRIPE_SECRET_KEY          — Stripe secret key (sk_live_... or sk_test_...)
 *   SUPABASE_URL               — Your project URL (auto-injected by Supabase)
 *   SUPABASE_ANON_KEY          — Anon key (auto-injected by Supabase)
 *   SUPABASE_SERVICE_ROLE_KEY  — Service role key for admin auth verification
 *   SITE_URL                   — Production origin (https://pleasedontscroll.com).
 *                                 Used both as the trusted redirect origin and
 *                                 as an entry in the Origin allowlist below —
 *                                 required, not optional, for prod correctness.
 *
 * Invocation (from frontend):
 *   supabase.functions.invoke('create-checkout-session', {
 *     body: { priceId: 'price_...' }
 *   })
 *
 * Returns:
 *   { url: string } — Stripe-hosted checkout URL to redirect the user to
 * ============================================================
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13.11.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ─── 1. Authenticate the user via the JWT in the Authorization header ───────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Use the service role client to verify and fetch the user from the JWT.
    // The anon client is not used here — we need admin-level user lookup.
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    )

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ─── 2. Parse the request body ───────────────────────────────────────────────
    const { priceId } = await req.json()

    if (!priceId) {
      return new Response(JSON.stringify({ error: 'priceId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ─── 3. Determine the origin for redirect URLs ───────────────────────────────
    // Do NOT trust the incoming Origin header blindly — it's attacker-settable
    // for anyone calling this function directly (curl/Postman), and an
    // unvalidated origin here becomes an open redirect after checkout
    // completes. Only allow known origins; otherwise fall back to SITE_URL.
    const ALLOWED_ORIGINS = [
      Deno.env.get('SITE_URL'),
      'http://localhost:8000',
      'http://localhost:3000',
    ].filter(Boolean)

    const requestOrigin = req.headers.get('Origin')
    const origin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : (Deno.env.get('SITE_URL') ?? 'http://localhost:8000')

    // ─── 4. Create the Stripe Checkout Session ───────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // metadata.user_id is critical — the stripe-webhook function reads this
      // to identify which Supabase user to upgrade after payment completes.
      metadata: {
        user_id: user.id,
      },
      success_url: `${origin}/dashboard.html?upgrade=success`,
      cancel_url: `${origin}/pricing.html`,
      // Allow promotion codes for future marketing flexibility
      allow_promotion_codes: true,
    })

    // ─── 5. Return the checkout URL ──────────────────────────────────────────────
    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('[PDS] create-checkout-session error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
