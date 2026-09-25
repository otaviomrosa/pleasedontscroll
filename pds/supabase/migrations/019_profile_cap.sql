-- ============================================================
-- PDS Migration 019 — Maximum profile count
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- (018 is reserved for the blocklist matching fix in the same sprint; the
-- two are independent and can be applied in either order.)
--
-- Focus Pro advertises unlimited profiles, and nothing capped them: a
-- direct REST loop could create profiles until the table or the dashboard's
-- tab row fell over. The fix sprint brief settles on a server-side cap next
-- to 007's free-tier limit, at 100, a number no real user reaches. The
-- "Unlimited profiles" copy on the site is deliberately left alone for now
-- (the founder decides that separately).
--
-- Same function name as 007_profile_limit.sql, so the existing
-- before_profile_insert_enforce_limit trigger picks the new body up with no
-- CREATE TRIGGER change (the technique 010/011/014/015/016 already use).
-- Two additions:
--   * the cap, checked for every account, Focus Pro or not, and for every
--     caller including the service role: it is a data limit, not a
--     permission;
--   * a per-user advisory lock (the one switch_active_profile() and
--     apply_schedule() already take), so two concurrent inserts can't both
--     read the old count. That race also let a free account end up with two
--     profiles under 007.
--
-- No RLS policy change: a trigger on top of "Users manage own profiles".
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_profile_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_profiles CONSTANT INT := 100;
  existing_count INT;
  premium BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text));

  SELECT COUNT(*) INTO existing_count FROM profiles WHERE user_id = NEW.user_id;

  IF existing_count >= max_profiles THEN
    RAISE EXCEPTION 'You can have up to % profiles.', max_profiles;
  END IF;

  IF existing_count >= 1 THEN
    SELECT is_premium INTO premium FROM user_settings WHERE id = NEW.user_id;

    IF NOT COALESCE(premium, false) THEN
      RAISE EXCEPTION 'Additional profiles require Focus Pro.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
