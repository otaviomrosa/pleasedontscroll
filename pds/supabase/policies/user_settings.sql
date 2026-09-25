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
-- Touched by: 008_pause.sql (added paused_until column; policy unchanged)
-- Touched by: 016_schedules.sql (added timezone + schedule_state columns and a
--   BEFORE UPDATE trigger guarding Strict->Friction / timezone changes during a
--   scheduled Strict block, and schedule_state writes by clients; policy unchanged)
-- Touched by: 017_lock_down_client_writes.sql (grants, not policy: authenticated
--   may UPDATE only blocking_mode, paused_until, timezone, and may not INSERT or
--   DELETE the row; anon holds nothing)
-- ============================================================

CREATE POLICY "Users manage own settings"
  ON user_settings
  FOR ALL
  USING (auth.uid() = id);
