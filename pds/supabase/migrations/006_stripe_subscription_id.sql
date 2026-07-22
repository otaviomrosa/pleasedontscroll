-- ============================================================
-- PDS Migration 006 — Stripe Subscription ID
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- ─── Add stripe_subscription_id to user_settings ───────────────────────────────
-- Nullable — populated in the checkout.session.completed webhook handler
-- alongside stripe_customer_id (see 004_stripe.sql). Lets the
-- customer.subscription.updated/deleted handlers and any future billing
-- portal work address a specific subscription without re-fetching it from
-- Stripe by customer ID first.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- ─── Index for webhook lookups (stripe_subscription_id → user row) ────────────
CREATE INDEX IF NOT EXISTS user_settings_stripe_subscription_id_idx
  ON user_settings (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- No new RLS policy needed: user_settings already has a full-row policy
-- ("Users manage own settings", USING (auth.uid() = id)) from
-- 001_initial_schema.sql that covers this column too.
