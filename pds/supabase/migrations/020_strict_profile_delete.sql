-- PDS Migration 020 — Deleting a non-active profile is allowed in Strict Mode
--
-- In Strict Mode the dashboard now lets you delete (not switch to) a
-- profile that isn't the active one. Deleting a profile cascades to its
-- blocked_urls rows (ON DELETE CASCADE, 003), cascade deletes still fire
-- BEFORE DELETE triggers on the child table, and
-- enforce_lock_mode_blocklist_guard() (011, last redefined in 015) refuses
-- every blocked_urls removal while blocking_mode = 'strict'. So any
-- profile with at least one site on it could not be deleted in Strict:
-- the cascade hit the guard and the whole statement rolled back with
-- "Cannot remove a blocked site while in Strict Mode."
--
-- That refusal protects nothing here. The guard exists so you can't edit
-- your way out of Strict by removing a site that is being enforced. A
-- non-active profile's list isn't being enforced, and it can't become
-- enforced without a profile switch, which Strict refuses
-- (switch_active_profile(), 011/016). The profile being deleted is
-- already known not to be the active one and not the last one:
-- enforce_profile_deletion_guard() (009) runs first, on the parent row,
-- and refuses both.
--
-- The exception is deliberately narrow: it applies only when the row's
-- profile no longer exists, which is true only during the cascade from a
-- profile delete (the parent row is removed before its children). A
-- direct DELETE of a blocked_urls row still finds its profile and is
-- still refused in Strict, on the active profile and on any other.
--
-- Same function name, so the existing trigger keeps pointing at it and no
-- CREATE TRIGGER is needed (same technique as 014 and 015). No RLS policy
-- change: this is a business-rule trigger on top of the existing
-- "Users manage own blocked urls" policy, not a new table or policy.

CREATE OR REPLACE FUNCTION enforce_lock_mode_blocklist_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  mode TEXT;
  is_covered BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT blocking_mode INTO mode FROM user_settings WHERE id = OLD.user_id;
    IF mode = 'strict' THEN
      -- The row's profile is gone: this is the cascade from deleting that
      -- profile, which 009 has already vetted. Nothing enforced is lost.
      IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = OLD.profile_id) THEN
        RETURN OLD;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM blocked_urls b
        WHERE b.profile_id = OLD.profile_id
          AND b.id != OLD.id
          AND blocklist_entry_covers(b.url, OLD.url)
      ) INTO is_covered;

      IF NOT is_covered THEN
        RAISE EXCEPTION 'Cannot remove a blocked site while in Strict Mode.';
      END IF;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;
