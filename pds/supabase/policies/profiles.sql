-- ============================================================
-- Current-state RLS policy for `profiles`.
--
-- This is a DERIVED reference, not the source of truth — see
-- blocked_urls.sql in this directory for the full explanation.
--
-- Defined in: 003_profiles.sql
-- Touched by: 017_lock_down_client_writes.sql (grants, not policy: no UPDATE for
--   authenticated, activation goes through switch_active_profile(); a new row
--   cannot be inserted already active; anon holds nothing)
-- ============================================================

CREATE POLICY "Users manage own profiles"
  ON profiles
  FOR ALL
  USING (auth.uid() = user_id);
