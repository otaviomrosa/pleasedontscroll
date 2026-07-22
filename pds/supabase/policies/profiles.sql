-- ============================================================
-- Current-state RLS policy for `profiles`.
--
-- This is a DERIVED reference, not the source of truth — see
-- blocked_urls.sql in this directory for the full explanation.
--
-- Defined in: 003_profiles.sql
-- ============================================================

CREATE POLICY "Users manage own profiles"
  ON profiles
  FOR ALL
  USING (auth.uid() = user_id);
