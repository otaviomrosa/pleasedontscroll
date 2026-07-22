-- ============================================================
-- Current-state RLS policy for `user_settings`.
--
-- This is a DERIVED reference, not the source of truth — see
-- blocked_urls.sql in this directory for the full explanation.
--
-- Defined in: 001_initial_schema.sql
-- Touched by: 004_stripe.sql (added stripe_customer_id column; policy unchanged)
-- Touched by: 005_blocking_mode.sql (added blocking_mode column; policy unchanged)
-- Touched by: 006_stripe_subscription_id.sql (added stripe_subscription_id column; policy unchanged)
-- ============================================================

CREATE POLICY "Users manage own settings"
  ON user_settings
  FOR ALL
  USING (auth.uid() = id);
