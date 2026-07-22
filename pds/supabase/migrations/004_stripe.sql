-- ============================================================
-- PDS Migration 004 — Stripe Monetization
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- ─── 1. Add stripe_customer_id to user_settings ───────────────────────────────
-- Nullable — populated when a user completes their first Stripe checkout.
-- Used for future billing portal, subscription management, and idempotency.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- ─── 2. Index for webhook lookups (stripe_customer_id → user row) ─────────────
-- The webhook resolves via metadata.user_id so this is supplementary,
-- but useful when building a billing portal or customer lookup.
CREATE INDEX IF NOT EXISTS user_settings_stripe_customer_id_idx
  ON user_settings (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
