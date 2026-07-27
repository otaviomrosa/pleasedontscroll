/**
 * PDS Edge Function: delete-account
 * ============================================================
 * Permanently deletes the signed-in user's account. Cancels any active
 * Stripe subscription first (otherwise a now-nonexistent user would keep
 * getting billed), then deletes the auth.users row via the Auth Admin API.
 *
 * Nothing else needs deleting manually: blocked_urls.user_id,
 * profiles.user_id, and user_settings.id all reference auth.users(id) with
 * ON DELETE CASCADE (see 001_initial_schema.sql, 003_profiles.sql), and
 * blocked_urls.profile_id cascades from profiles.id in turn — deleting the
 * auth user cascades through all of it at the database level.
 *
 * Required environment variables (set via `supabase secrets set`):
 *   STRIPE_SECRET_KEY          — to cancel an active subscription, if any
 *   SUPABASE_URL               — Your project URL (auto-injected by Supabase)
 *   SUPABASE_SERVICE_ROLE_KEY  — needed for auth.getUser() and admin.deleteUser()
 *   SITE_URL                   — Same CORS allowlist pattern as the other functions
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

    // ─── 2. Cancel any active Stripe subscription first ──────────────────────────
    const { data: settings } = await supabaseAdmin
      .from('user_settings')
      .select('stripe_subscription_id')
      .eq('id', user.id)
      .single()

    if (settings?.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(settings.stripe_subscription_id)
      } catch (err) {
        // Already cancelled, already gone, etc. — don't let a Stripe hiccup
        // block account deletion itself; log it and proceed.
        console.warn('[PDS] Stripe subscription cancel during account deletion:', err)
      }
    }

    // ─── 3. Delete the auth user — cascades to profiles/blocked_urls/user_settings ─
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id)

    if (deleteError) {
      console.error('[PDS] Failed to delete user:', deleteError)
      return new Response(JSON.stringify({ error: 'Could not delete account. Please try again.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log(`[PDS] Account deleted: ${user.id}`)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('[PDS] delete-account error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
