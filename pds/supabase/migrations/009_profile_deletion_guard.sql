-- ============================================================
-- PDS Migration 009 — Profile deletion guards (server-side)
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- No RLS policy change accompanies this migration, same reasoning as
-- 007_profile_limit.sql: this doesn't add or alter a table or its RLS —
-- it's a BEFORE DELETE trigger enforcing a business rule on top of the
-- existing "Users manage own profiles" policy from 003_profiles.sql,
-- which is unchanged.
-- ============================================================

-- ─── Enforce: can't delete your only profile, or the active one ─────────────
-- dashboard.html's handleDeleteProfile() already checks both of these
-- client-side ("You need at least one profile." / "Switch to a different
-- profile before deleting this one."), but that's UI convenience only — a
-- direct REST call bypassing the dashboard could still delete the last or
-- active profile, leaving the user with zero profiles or zero active ones.
-- background/index.js's refreshBlocklist() has no good recovery from that
-- (fetchActiveProfile() returning null clears blockedHosts and disables
-- blocking entirely — a fail-open state), so this needs to be a real
-- constraint, not just a client-side courtesy.
--
-- Scoped to auth.uid() IS NOT NULL: profiles.user_id references
-- auth.users(id) ON DELETE CASCADE (003_profiles.sql), so delete-account
-- cascade-deletes every profile when an account is removed — and cascade
-- deletes still fire BEFORE DELETE triggers on the child table. A blanket
-- check here would make account deletion fail outright the moment the
-- cascade tries to delete either the user's last remaining profile or
-- whichever one was active, which for most accounts is every account.
-- auth.uid() is NULL for that service-role-driven cascade (delete-account
-- runs via the Auth Admin API, not a request-scoped end-user JWT), so this
-- only ever blocks a real end-user's own direct delete request against
-- this table — never the account-deletion path.
CREATE OR REPLACE FUNCTION enforce_profile_deletion_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_count INT;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT COUNT(*) INTO existing_count FROM profiles WHERE user_id = OLD.user_id;

    IF existing_count <= 1 THEN
      RAISE EXCEPTION 'Cannot delete your only profile.';
    END IF;

    IF OLD.is_active THEN
      RAISE EXCEPTION 'Cannot delete the active profile — switch to a different profile first.';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER before_profile_delete_enforce_guard
  BEFORE DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION enforce_profile_deletion_guard();
