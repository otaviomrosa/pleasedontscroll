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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8'
import Stripe from 'https://esm.sh/stripe@13.11.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  // Checked the fields this file reads (session.customer, metadata) against
  // Stripe's changelog between 2023-10-16 and 2026-06-24.dahlia — the only
  // breaking change in that range affecting objects used here removed
  // Subscription's top-level current_period_start/end (2025-03-31.basil),
  // which this file never reads. Safe to jump straight to current.
  apiVersion: '2026-06-24.dahlia',
  httpClient: Stripe.createFetchHttpClient(),
})

serve(async (req: Request) => {
  // Computed once per request and reused for both the CORS header below and
  // the checkout success/cancel redirect URLs (§3) — one allowlist, not two.
  const ALLOWED_ORIGINS = [
    Deno.env.get('SITE_URL'),
    // Both the apex and www domain serve the site (no canonical redirect
    // between them — see vercel.json), and manifest.json's
    // externally_connectable already treats both as valid. SITE_URL alone
    // only ever covers one of the two, so list both explicitly here too,
    // rather than depending on which form SITE_URL happens to be set to.
    'https://pleasedontscroll.com',
    'https://www.pleasedontscroll.com',
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

    // ─── 2b. Refuse to sell a second subscription to an already-Pro user ────────
    // The pricing page hides/relabels the Upgrade button client-side for
    // premium users, but that's UI only — checked again here so a stale tab
    // or a direct call to this function can't create a duplicate Checkout
    // Session (and, since Stripe would just create a second subscription
    // rather than reject it outright, a duplicate charge).
    const { data: existingSettings } = await supabaseAdmin
      .from('user_settings')
      .select('is_premium')
      .eq('id', user.id)
      .single()

    if (existingSettings?.is_premium) {
      return new Response(JSON.stringify({ error: 'You already have an active Focus Pro subscription.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ─── 3. Redirect URLs use the request-scoped `origin` validated above ───────
    // (Do NOT trust the incoming Origin header blindly for this — it's
    // attacker-settable for anyone calling this function directly, and an
    // unvalidated origin here becomes an open redirect after checkout
    // completes. `origin` was already resolved against the allowlist.)

    // ─── 4. Create the Stripe Checkout Session ───────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      // Managed Payments left on the account default (not explicitly
      // disabled) as of this change — being re-tested against the new live
      // Brazilian account/product, since the previous failure (Managed
      // Payments gating checkout on the product's Stripe tax code being in
      // its eligible set) was tied to the old account's product setup and
      // may not recur here. payment_method_types is also omitted now,
      // matching Stripe's current guidance to let it pick eligible methods
      // dynamically instead of hardcoding card-only — that's the actual
      // point of turning this back on, not just a side effect.
      //
      // If this breaks again the same way, revert to the known-working
      // state: add back `payment_method_types: ['card']` and
      // `managed_payments: { enabled: false }` here.
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
      success_url: `${origin}/dashboard?upgrade=success`,
      cancel_url: `${origin}/pricing`,
      // Allow promotion codes for future marketing flexibility
      allow_promotion_codes: true,
    }, {
      // Deterministic per (user, price, 5-minute window) key so a client
      // retry shortly after a timeout reuses the in-flight/completed
      // session instead of creating a duplicate one — that's the actual
      // scenario this protects against (a double-click, or the client
      // auto-retrying a fetch that timed out but actually succeeded
      // server-side), which resolves within seconds, not hours.
      //
      // A previous version keyed only on (user, price) with no time
      // component. Stripe idempotency keys are valid for 24h, so that
      // wasn't "only same-day retries collapse" as the old comment here
      // claimed — it meant ANY two checkout attempts by the same user for
      // the same price within a day collided, including a genuine
      // resubscribe after a real cancellation: Stripe just handed back the
      // original, already-completed Checkout Session, which is exactly why
      // a user who'd cancelled and tried to resubscribe saw Stripe's "You're
      // all done here... this checkout session has timed out" message
      // instead of a fresh checkout. Bucketing to 5 minutes keeps the
      // intended double-submit protection while making any attempt more
      // than 5 minutes after the last one get a genuinely fresh session.
      idempotencyKey: `checkout_${user.id}_${priceId}_${Math.floor(Date.now() / (5 * 60 * 1000))}`,
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
