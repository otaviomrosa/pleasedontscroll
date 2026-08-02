/**
 * PDS Edge Function: stripe-webhook
 * ============================================================
 * Handles Stripe webhook events. Verifies the signature and
 * updates the user's is_premium status upon successful payment.
 *
 * Required environment variables (set via `supabase secrets set`):
 *   STRIPE_WEBHOOK_SECRET      — From Stripe Dashboard → Webhooks → Signing secret
 *   SUPABASE_URL               — Your project URL (auto-injected by Supabase)
 *   SUPABASE_SERVICE_ROLE_KEY  — Service role key (needed to write user_settings)
 *
 * Register this webhook in the Stripe Dashboard:
 *   Endpoint URL: https://<project-ref>.supabase.co/functions/v1/stripe-webhook
 *   Events to listen for:
 *     - checkout.session.completed
 *     - customer.subscription.updated  (renewal failures downgrade immediately
 *       instead of waiting on Stripe's dunning retry schedule to exhaust)
 *     - customer.subscription.deleted
 *
 * Security: The raw request body MUST be used for signature verification.
 * Do NOT parse the body before verifying — Stripe's constructEventAsync
 * requires the exact bytes Stripe sent.
 * ============================================================
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8'
import Stripe from 'https://esm.sh/stripe@13.11.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  // Checked the fields this file reads (session.customer, session.subscription,
  // subscription.customer, subscription.status, metadata) against Stripe's
  // changelog between 2023-10-16 and 2026-06-24.dahlia — the only breaking
  // change in that range affecting objects used here removed Subscription's
  // top-level current_period_start/end (2025-03-31.basil), which this file
  // never reads. Safe to jump straight to current.
  apiVersion: '2026-06-24.dahlia',
  httpClient: Stripe.createFetchHttpClient(),
})

// Service role client — bypasses RLS intentionally.
// This function runs server-side only, triggered by verified Stripe events.
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
)

/**
 * On downgrade, if the user's currently-active profile isn't their oldest
 * ("free") one, switches activity back to the oldest — otherwise blocking
 * would keep enforcing a profile's list that the user, now on Free,
 * shouldn't have access to anymore (the profile itself isn't deleted, it's
 * just locked in the UI — see 007_profile_limit.sql and docs/ARCHITECTURE.md). A no-op
 * if the user has one profile or the active one is already the oldest.
 *
 * Uses the switch_active_profile() RPC (010_atomic_profile_switch.sql) —
 * one transaction instead of two separate .update() calls, same reasoning
 * as core/sync/profiles.js's switchProfile(). auth.uid() is NULL for this
 * service-role client, so the RPC's own authorization check is a no-op
 * here, consistent with supabaseAdmin's existing trust model elsewhere in
 * this file.
 */
async function reactivateDefaultProfileIfNeeded(userId: string) {
  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, is_active')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  if (error || !profiles || profiles.length <= 1) return

  const defaultProfile = profiles[0]
  const activeProfile = profiles.find((p) => p.is_active)

  if (activeProfile && activeProfile.id !== defaultProfile.id) {
    const { error: switchError } = await supabaseAdmin.rpc('switch_active_profile', {
      p_user_id: userId,
      p_profile_id: defaultProfile.id,
    })

    if (switchError) {
      console.error(`[PDS] Failed to reactivate default profile for user ${userId}:`, switchError)
      return
    }

    console.log(`[PDS] Downgrade: reactivated default profile ${defaultProfile.id} for user ${userId}`)
  }
}

/**
 * Strict Mode is a Focus Pro feature — on downgrade, force the user back to
 * Friction Mode if they're currently in Strict, mirroring
 * reactivateDefaultProfileIfNeeded() right above: a downgraded user
 * shouldn't be left stuck in a paid-only mode with no way out beyond
 * knowing to find the toggle themselves and sit through the 30s
 * leave-Strict hold. Enforcement itself was never actually unsafe either
 * way — checkAndBlockTab() doesn't gate Strict on is_premium, it just
 * keeps enforcing "no bypass" regardless of who's paying — this is about
 * not leaving a free user's account silently misconfigured after an
 * involuntary downgrade, not a security fix.
 * A single conditional UPDATE (WHERE blocking_mode = 'strict') rather than
 * a SELECT-then-UPDATE — a no-op if the user was already in Friction Mode.
 */
async function resetToFrictionModeIfNeeded(userId: string) {
  const { error } = await supabaseAdmin
    .from('user_settings')
    .update({ blocking_mode: 'friction' })
    .eq('id', userId)
    .eq('blocking_mode', 'strict')

  if (error) {
    console.error(`[PDS] Failed to reset blocking_mode to friction for user ${userId}:`, error)
  }
}

serve(async (req: Request) => {
  // ─── 1. Read the raw body bytes (required for signature verification) ─────────
  const body = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  // ─── 2. Verify the webhook signature ─────────────────────────────────────────
  let event: Stripe.Event

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
    )
  } catch (err) {
    console.error('[PDS] Webhook signature verification failed:', err)
    return new Response(`Webhook signature error: ${err}`, { status: 400 })
  }

  console.log(`[PDS] Stripe event received: ${event.type}`)

  // ─── 3. Handle relevant events ───────────────────────────────────────────────
  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        // Only process subscription checkouts
        if (session.mode !== 'subscription') break

        const userId = session.metadata?.user_id
        const stripeCustomerId = session.customer as string
        const stripeSubscriptionId = session.subscription as string

        if (!userId) {
          console.error('[PDS] checkout.session.completed: missing metadata.user_id')
          break
        }

        // Upgrade the user — set is_premium = true and store the Stripe customer
        // and subscription IDs. Uses service role to bypass RLS (this is
        // intentional: webhooks are server-side).
        const { error } = await supabaseAdmin
          .from('user_settings')
          .update({
            is_premium: true,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
          })
          .eq('id', userId)

        if (error) {
          console.error('[PDS] Failed to upgrade user:', error)
          // Return 500 so Stripe retries the webhook
          return new Response('Database update failed', { status: 500 })
        }

        console.log(`[PDS] User ${userId} upgraded to premium. Stripe customer: ${stripeCustomerId}, subscription: ${stripeSubscriptionId}`)
        break
      }

      case 'customer.subscription.updated': {
        // Keeps is_premium in sync with the subscription's actual status on
        // every change — most importantly a failed renewal. Without this,
        // a lapsed card only downgrades the user once Stripe's dunning
        // retry schedule fully exhausts and fires subscription.deleted,
        // which can be days to weeks later. Resolved via stripe_customer_id,
        // same lookup pattern as the deleted handler below.
        const subscription = event.data.object as Stripe.Subscription
        const stripeCustomerId = subscription.customer as string
        const PREMIUM_STATUSES: Stripe.Subscription.Status[] = ['active', 'trialing']
        const isPremium = PREMIUM_STATUSES.includes(subscription.status)

        const { data: updatedRows, error } = await supabaseAdmin
          .from('user_settings')
          .update({ is_premium: isPremium })
          .eq('stripe_customer_id', stripeCustomerId)
          .select('id')

        if (error) {
          console.error('[PDS] Failed to sync subscription status:', error)
          return new Response('Database update failed', { status: 500 })
        }

        if (!isPremium && updatedRows?.[0]?.id) {
          await reactivateDefaultProfileIfNeeded(updatedRows[0].id)
          await resetToFrictionModeIfNeeded(updatedRows[0].id)
        }

        console.log(`[PDS] Subscription status "${subscription.status}" for Stripe customer ${stripeCustomerId} — is_premium=${isPremium}`)
        break
      }

      case 'customer.subscription.deleted': {
        // The subscription object has customer ID; resolve to user_id via stripe_customer_id column.
        const subscription = event.data.object as Stripe.Subscription
        const stripeCustomerId = subscription.customer as string

        const { data: updatedRows, error } = await supabaseAdmin
          .from('user_settings')
          .update({ is_premium: false })
          .eq('stripe_customer_id', stripeCustomerId)
          .select('id')

        if (error) {
          console.error('[PDS] Failed to downgrade user on cancellation:', error)
          return new Response('Database update failed', { status: 500 })
        }

        if (updatedRows?.[0]?.id) {
          await reactivateDefaultProfileIfNeeded(updatedRows[0].id)
          await resetToFrictionModeIfNeeded(updatedRows[0].id)
        }

        console.log(`[PDS] Subscription cancelled for Stripe customer: ${stripeCustomerId}`)
        break
      }

      default:
        // Acknowledge all other events without processing
        console.log(`[PDS] Unhandled event type: ${event.type}`)
    }

  } catch (err) {
    console.error('[PDS] Event handler error:', err)
    return new Response('Internal server error', { status: 500 })
  }

  // Stripe expects a 200 to confirm receipt
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
