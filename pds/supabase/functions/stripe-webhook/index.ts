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
 *     - customer.subscription.deleted  (for future cancellation handling)
 *
 * Security: The raw request body MUST be used for signature verification.
 * Do NOT parse the body before verifying — Stripe's constructEventAsync
 * requires the exact bytes Stripe sent.
 * ============================================================
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13.11.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

// Service role client — bypasses RLS intentionally.
// This function runs server-side only, triggered by verified Stripe events.
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
)

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

        if (!userId) {
          console.error('[PDS] checkout.session.completed: missing metadata.user_id')
          break
        }

        // Upgrade the user — set is_premium = true and store the Stripe customer ID.
        // Uses service role to bypass RLS (this is intentional: webhooks are server-side).
        const { error } = await supabaseAdmin
          .from('user_settings')
          .update({
            is_premium: true,
            stripe_customer_id: stripeCustomerId,
          })
          .eq('id', userId)

        if (error) {
          console.error('[PDS] Failed to upgrade user:', error)
          // Return 500 so Stripe retries the webhook
          return new Response('Database update failed', { status: 500 })
        }

        console.log(`[PDS] User ${userId} upgraded to premium. Stripe customer: ${stripeCustomerId}`)
        break
      }

      case 'customer.subscription.deleted': {
        // Future: downgrade user when they cancel.
        // The subscription object has customer ID; resolve to user_id via stripe_customer_id column.
        const subscription = event.data.object as Stripe.Subscription
        const stripeCustomerId = subscription.customer as string

        const { error } = await supabaseAdmin
          .from('user_settings')
          .update({ is_premium: false })
          .eq('stripe_customer_id', stripeCustomerId)

        if (error) {
          console.error('[PDS] Failed to downgrade user on cancellation:', error)
          return new Response('Database update failed', { status: 500 })
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
