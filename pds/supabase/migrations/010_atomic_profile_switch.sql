-- ============================================================
-- PDS Migration 010 — Atomic profile activation
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- No RLS policy change accompanies this migration, but read the
-- authorization note inside the function below before assuming that means
-- RLS still applies here the way it does elsewhere — it explicitly does
-- NOT, and the function compensates for that itself.
-- ============================================================

-- ─── switch_active_profile: one transaction instead of two round trips ──────
-- core/sync/profiles.js's switchProfile() previously did this as two
-- separate PATCH requests from the client (deactivate all, then activate
-- one) — not atomic. If anything interrupted execution between them
-- (closed tab, network drop, function timeout), a user could end up with
-- zero active profiles, which background/index.js's refreshBlocklist()
-- has no good recovery from (fetchActiveProfile() returning null disables
-- blocking entirely — fails open, not closed).
--
-- Wrapping both UPDATEs in a single plpgsql function makes them atomic:
-- the whole call is one transaction from Postgres's perspective, so a
-- client-side interruption either never reaches the database at all (the
-- prior active profile stays untouched) or the database completes both
-- updates together — there's no window where only the first has happened.
--
-- The row-count check on the second UPDATE closes a second gap: without
-- it, a bad/stale p_profile_id (already deleted, belongs to another user)
-- would silently deactivate every profile and then activate nothing,
-- landing on zero active profiles anyway. Raising instead rolls back the
-- whole transaction, including the first UPDATE, leaving the original
-- active profile exactly as it was.
--
-- SECURITY DEFINER is required for this to run as a single transaction at
-- all, but it has a real consequence worth being deliberate about: it
-- bypasses RLS entirely, so the "Users manage own profiles" policy that
-- protects every direct table UPDATE elsewhere in this codebase does NOT
-- automatically apply inside this function body. Without the auth.uid()
-- check below, any authenticated caller could pass an arbitrary p_user_id
-- and hijack a different user's active profile — a real privilege
-- escalation, not a hypothetical one. The check only fires when there IS
-- an end-user JWT that doesn't match p_user_id; it's a no-op when
-- auth.uid() is NULL, which is the case for stripe-webhook's service-role
-- caller (reactivateDefaultProfileIfNeeded, called with a Stripe-verified
-- user_id it already resolved server-side, not a request-scoped JWT) —
-- consistent with the trust model that call site already operates under.
--
-- RETURNS BOOLEAN, not VOID: core/sync/restClient.js's supabaseFetch()
-- returns null both on a failed request AND on a successful-but-empty
-- response body (e.g. a VOID function's 204 No Content) — it has no way
-- to tell those apart. Every /core/sync caller's success check is
-- `result !== null`, so a VOID-returning function here would make
-- switchProfile() report every successful call as a failure. Returning a
-- real `true` gives supabaseFetch() an actual body to parse, so success
-- is genuinely distinguishable from failure without needing to touch
-- restClient.js's shared contract (used by every other /core/sync call)
-- just for this one function.
CREATE OR REPLACE FUNCTION switch_active_profile(p_user_id UUID, p_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Not authorized to modify profiles for this user.';
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
