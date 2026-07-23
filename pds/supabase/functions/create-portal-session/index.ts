/**
 * PDS Edge Function: create-portal-session
 * ============================================================
 * Creates a Stripe Billing Portal session so a user can cancel their
 * subscription or update their payment method through Stripe's own hosted
 * UI — no custom cancellation flow lives in this repo.
 *
 * Required environment variables (set via `supabase secrets set`):
 *   STRIPE_SECRET_KEY          — Stripe secret key (sk_live_... or sk_test_...)
 *   SUPABASE_URL               — Your project URL (auto-injected by Supabase)
 *   SUPABASE_ANON_KEY          — Anon key (auto-injected by Supabase)
 *   SUPABASE_SERVICE_ROLE_KEY  — Service role key for admin auth verification
 *                                 and looking up stripe_customer_id
 *   SITE_URL                   — Production origin (https://pleasedontscroll.com).
 *                                 Same allowlist/redirect pattern as
 *                                 create-checkout-session — see that file.
 *
 * Returns:
 *   { url: string } — Stripe-hosted Billing Portal URL to redirect the user to
 * ============================================================
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8'
import Stripe from 'https://esm.sh/stripe@13.11.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2026-06-24.dahlia',
  httpClient: Stripe.createFetchHttpClient(),
})

serve(async (req: Request) => {
  const ALLOWED_ORIGINS = [
    Deno.env.get('SITE_URL'),
    'http://localhost:8000',
    'http://localhost:3000',
  ].filter(Boolean)

  const requestOrigin = req.headers.get('Origin')
  const origin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : (Deno.env.get('SITE_URL') ?? 'http://localhost:8000')

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

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

    // ─── 2. Look up this user's Stripe customer ID ───────────────────────────────
    const { data: settings, error: settingsError } = await supabaseAdmin
      .from('user_settings')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single()

    if (settingsError || !settings?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'No billing account found for this user.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ─── 3. Create the Billing Portal session ────────────────────────────────────
    const session = await stripe.billingPortal.sessions.create({
      customer: settings.stripe_customer_id,
      return_url: `${origin}/dashboard`,
    })

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('[PDS] create-portal-session error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
