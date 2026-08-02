-- ============================================================
-- PDS Migration 011 — Lock Mode guards (server-side)
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- "Lock Mode" is the user-facing rename of what's internally still
-- blocking_mode = 'strict' throughout the schema/functions — display-only,
-- see docs/ARCHITECTURE.md. This migration is the server-side half of closing a real
-- gap: Lock Mode's "no bypass" promise only ever guarded the block-screen
-- countdown. A user could just as easily remove the site from their
-- blocklist directly, or switch to a different (weaker or empty) profile —
-- both fully available regardless of mode, no hold, no confirmation.
--
-- Adding a site stays allowed in either mode — it only ever increases
-- restriction, so there's nothing to guard there.
--
-- No RLS policy change accompanies this migration, same reasoning as
-- 007/009: these are triggers/function changes on top of existing "Users
-- manage own X" policies, not new tables or policies.
-- ============================================================

-- ─── 1. Removing a blocked site requires Friction Mode ───────────────────────
-- Scoped to auth.uid() IS NOT NULL — same reasoning as the profile-switch
-- guard below. delete-account cascade-deletes blocked_urls via
-- ON DELETE CASCADE when an account is removed (see 001_initial_schema.sql),
-- and cascade deletes still fire BEFORE DELETE triggers on the child table.
-- A blanket check here would block account deletion outright for any user
-- who happened to be in Lock Mode at the time — auth.uid() is NULL for
-- that service-role-driven cascade, so this only ever applies to a real
-- end-user's own direct delete request against this table.
CREATE OR REPLACE FUNCTION enforce_lock_mode_blocklist_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  mode TEXT;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT blocking_mode INTO mode FROM user_settings WHERE id = OLD.user_id;
    IF mode = 'strict' THEN
      RAISE EXCEPTION 'Cannot remove a blocked site while in Lock Mode.';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER before_blocked_url_delete_enforce_lock_mode
  BEFORE DELETE ON blocked_urls
  FOR EACH ROW EXECUTE FUNCTION enforce_lock_mode_blocklist_guard();

-- ─── 2. Switching profiles requires Friction Mode ────────────────────────────
-- Redefines switch_active_profile() from 010_atomic_profile_switch.sql,
-- adding the mode check as the first thing it does (alongside the
-- existing auth.uid() authorization check that migration already added) —
-- same function, same callers (core/sync/profiles.js's switchProfile(),
-- used by both the dashboard and the extension popup; stripe-webhook's
-- reactivateDefaultProfileIfNeeded()). No changes needed at any call site.
--
-- The mode check is scoped to auth.uid() IS NOT NULL, same as the
-- authorization check right above it — NOT a blanket check. This matters:
-- stripe-webhook's reactivateDefaultProfileIfNeeded() runs BEFORE
-- resetToFrictionModeIfNeeded() in both its callers (see
-- stripe-webhook/index.ts), so at the moment this function runs for that
-- caller, the user can still genuinely be in Lock Mode. A blanket check
-- would reject the webhook's own downgrade-correction call, leaving the
-- user stuck on a now-locked secondary profile with Lock Mode still on —
-- exactly the bug this migration exists to close, self-inflicted. Scoping
-- to auth.uid() IS NOT NULL means this only ever blocks a real end-user
-- request (dashboard, popup), never the trusted service-role caller —
-- consistent with the authorization check's own reasoning, and correct
-- regardless of the two webhook calls' order (not something that quietly
-- breaks again if that order is ever changed).
CREATE OR REPLACE FUNCTION switch_active_profile(p_user_id UUID, p_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
  mode TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Not authorized to modify profiles for this user.';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT blocking_mode INTO mode FROM user_settings WHERE id = p_user_id;
    IF mode = 'strict' THEN
      RAISE EXCEPTION 'Cannot switch profiles while in Lock Mode.';
    END IF;
  END IF;

  UPDATE profiles SET is_active = false WHERE user_id = p_user_id;

  UPDATE profiles SET is_active = true WHERE id = p_profile_id AND user_id = p_user_id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count = 0 THEN
    RAISE EXCEPTION 'Profile % does not belong to user %', p_profile_id, p_user_id;
  END IF;

  RETURN true;
END;
$$;
