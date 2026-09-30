-- ============================================================
-- PDS Migration 007 — Free-tier profile limit
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- No RLS policy change accompanies this migration (see docs/ARCHITECTURE.md's rule
-- on migrations shipping with policies) because this doesn't add or alter a
-- table or its RLS — it's a BEFORE INSERT trigger enforcing a business rule
-- on top of the existing "Users manage own profiles" policy from
-- 003_profiles.sql, which is unchanged.
-- ============================================================

-- ─── Enforce: free (non-premium) users may have at most one profile ─────────
-- A user's very first profile (created by 003_profiles.sql's
-- create_default_profile trigger, or manually) is always allowed regardless
-- of premium status — the check only blocks a 2nd+ INSERT. There's no
-- explicit "is this the default profile" flag; "the free profile" is simply
-- whichever one was created first (profiles.js's fetchProfiles already
-- orders by created_at ascending, so the client treats row 0 as it).
CREATE OR REPLACE FUNCTION enforce_profile_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_count INT;
  premium BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO existing_count FROM profiles WHERE user_id = NEW.user_id;

  IF existing_count >= 1 THEN
    SELECT is_premium INTO premium FROM user_settings WHERE id = NEW.user_id;

    IF NOT COALESCE(premium, false) THEN
      RAISE EXCEPTION 'Additional profiles require Focus Pro.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER before_profile_insert_enforce_limit
  BEFORE INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION enforce_profile_limit();
