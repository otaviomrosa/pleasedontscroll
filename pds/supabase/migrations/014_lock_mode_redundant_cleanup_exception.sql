-- ============================================================
-- PDS Migration 014 — Allow removing a redundant path-scoped entry in
-- Strict Mode when a whole-domain entry already covers it
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- No RLS policy change accompanies this migration, same reasoning as
-- 007/009/011 — this redefines an existing trigger function on top of
-- the existing "Users manage own blocked_urls" policy, not a new table
-- or policy.
-- ============================================================

-- Found by the founder actually using the feature: block
-- facebook.com/marketplace, switch to Strict Mode, then use the quick-add
-- menu's "Block Facebook" (whole domain) — the now-redundant Marketplace
-- row should disappear (dashboard.html's handleBlockWholeSite() already
-- tries to remove it right after adding the whole-domain row), but
-- 011_lock_mode_guards.sql's blanket "no removal in Strict Mode" trigger
-- rejected it, same as it would any other removal attempt. That's correct
-- for the general case (Strict Mode's whole point is you can't edit your
-- way out of it), but wrong here specifically: removing a row that's
-- already fully covered by another row blocking the entire domain doesn't
-- reduce enforcement at all — the whole-domain entry already matches
-- every URL the redundant row did — so it's pure data cleanup, not a
-- bypass, and shouldn't be blocked by a rule whose purpose is preventing
-- bypasses.
--
-- ─── Shared hostname-parsing helpers ──────────────────────────────────────────
-- Mirrors core/blocklist/hostname.js's normalizeToHostname()/
-- parseBlocklistEntry() closely enough for this purpose — extracted as
-- reusable SQL functions rather than inlined, since this same
-- scheme/www-stripping logic is about to be needed in two different
-- checks below. (013_block_own_domain_guard.sql has its own inline copy
-- of similar normalization — not touched here, since migrations are
-- never edited after the fact; only new logic uses these going forward.)
CREATE OR REPLACE FUNCTION blocklist_url_hostname(raw_url TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT split_part(
    split_part(
      split_part(
        regexp_replace(regexp_replace(lower(trim(raw_url)), '^[a-z][a-z0-9+.-]*://', ''), '^www\.', ''),
        '/', 1
      ),
      '?', 1
    ),
    ':', 1
  );
$$;

-- True if raw_url has no path/query/port beyond the bare hostname — i.e.
-- a "block the whole site" entry, not a path-scoped one like
-- "facebook.com/marketplace". Compares the scheme/www-stripped string
-- (path/query/port left intact) against the fully-stripped hostname —
-- they're equal only when there was nothing left to strip.
CREATE OR REPLACE FUNCTION blocklist_url_is_whole_domain(raw_url TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(regexp_replace(lower(trim(raw_url)), '^[a-z][a-z0-9+.-]*://', ''), '^www\.', '')
       = blocklist_url_hostname(raw_url);
$$;

-- ─── Redefine the Strict Mode blocklist-removal guard ────────────────────────
-- Same function name as 011_lock_mode_guards.sql — the existing trigger
-- already references it, so redefining the body is enough, no need to
-- touch the CREATE TRIGGER statement.
CREATE OR REPLACE FUNCTION enforce_lock_mode_blocklist_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  mode TEXT;
  covered_by_whole_domain BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT blocking_mode INTO mode FROM user_settings WHERE id = OLD.user_id;
    IF mode = 'strict' THEN
      SELECT EXISTS (
        SELECT 1 FROM blocked_urls b
        WHERE b.profile_id = OLD.profile_id
          AND b.id != OLD.id
          AND blocklist_url_is_whole_domain(b.url)
          AND blocklist_url_hostname(b.url) = blocklist_url_hostname(OLD.url)
      ) INTO covered_by_whole_domain;

      IF NOT covered_by_whole_domain THEN
        RAISE EXCEPTION 'Cannot remove a blocked site while in Strict Mode.';
      END IF;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;
