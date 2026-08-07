-- ============================================================
-- PDS Migration 015 — Reject redundant blocklist inserts (subdomain/path
-- coverage), and generalize the Strict Mode removal exception to match.
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- No RLS policy change accompanies this migration, same reasoning as
-- 007/009/011/014 — these redefine existing trigger functions (or add a
-- new one of the same shape) on top of the existing "Users manage own
-- blocked_urls" policy, not a new table or policy.
-- ============================================================

-- Found by the founder: a user could add "live.instagram.com" even though
-- "instagram.com" was already on their blocklist and already covers it
-- (matchesBlockedEntry()'s subdomain-inclusive matching means blocking
-- instagram.com already blocks live.instagram.com — see
-- core/blocklist/hostname.js). dashboard.html already rejects this
-- client-side (entryCovers(), same file) and cleans up the reverse case
-- (adding the broader entry retires the narrower one) — but blocked_urls
-- is reachable by direct REST, same as every other guard in this file, so
-- both directions need a server-side backstop too.
--
-- ─── Path-prefix extraction ────────────────────────────────────────────────
-- Mirrors core/blocklist/hostname.js's parseBlocklistEntry(): everything
-- from the first '/' onward (query string and trailing slashes stripped,
-- lowercased), or NULL for a bare-domain entry with no path at all. Built
-- on top of 014_lock_mode_redundant_cleanup_exception.sql's
-- blocklist_url_hostname(), which already isolates the scheme/www-stripped
-- string this operates on.
CREATE OR REPLACE FUNCTION blocklist_url_path_prefix(raw_url TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(
    regexp_replace(
      split_part(
        substring(
          regexp_replace(regexp_replace(lower(trim(raw_url)), '^[a-z][a-z0-9+.-]*://', ''), '^www\.', '')
          from '/.*'
        ),
        '?', 1
      ),
      '/+$', ''
    ),
    ''
  );
$$;

-- ─── Entry-covers-entry ─────────────────────────────────────────────────────
-- SQL equivalent of core/blocklist/hostname.js's entryCovers(): true if
-- covering_url already makes candidate_url fully redundant — same hostname
-- or a subdomain of it (mirrors matchesBlockedEntry()'s
-- right(...) = '.' || hostname pattern, same technique
-- 013_block_own_domain_guard.sql's own-domain check already uses to avoid
-- LIKE wildcard ambiguity on a hostname), and (if covering_url is
-- path-scoped) candidate_url's path starts with that prefix.
CREATE OR REPLACE FUNCTION blocklist_entry_covers(covering_url TEXT, candidate_url TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    (
      blocklist_url_hostname(candidate_url) = blocklist_url_hostname(covering_url)
      OR right(
           blocklist_url_hostname(candidate_url),
           length(blocklist_url_hostname(covering_url)) + 1
         ) = '.' || blocklist_url_hostname(covering_url)
    )
    AND (
      blocklist_url_path_prefix(covering_url) IS NULL
      OR (
        blocklist_url_path_prefix(candidate_url) IS NOT NULL
        AND left(
              blocklist_url_path_prefix(candidate_url),
              length(blocklist_url_path_prefix(covering_url))
            ) = blocklist_url_path_prefix(covering_url)
      )
    );
$$;

-- ─── Reject a redundant insert ──────────────────────────────────────────────
-- Mirrors 013_block_own_domain_guard.sql's shape exactly (BEFORE INSERT,
-- scoped to the same profile via NEW.profile_id). Deliberately does NOT
-- also auto-remove now-redundant existing rows the other direction (adding
-- "instagram.com" while "live.instagram.com" already exists) — that stays
-- a client-orchestrated, best-effort action
-- (dashboard.html's removeEntriesCoveredBy(), same as it already was
-- for the whole-domain/path-scoped case before this migration), not a
-- trigger-driven cascade delete. Keeping automatic cross-row deletion out
-- of a BEFORE INSERT trigger avoids the same class of cascade-ordering
-- gotcha documented on enforce_lock_mode_blocklist_guard() below.
CREATE OR REPLACE FUNCTION reject_redundant_blocklist_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM blocked_urls b
    WHERE b.profile_id = NEW.profile_id
      AND blocklist_entry_covers(b.url, NEW.url)
  ) THEN
    RAISE EXCEPTION 'That site is already covered by an existing entry in your blocklist.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER before_blocked_url_insert_reject_redundant
  BEFORE INSERT ON blocked_urls
  FOR EACH ROW EXECUTE FUNCTION reject_redundant_blocklist_insert();

-- ─── Generalize the Strict Mode removal exception ──────────────────────────
-- Same function name as 011/014 — the existing trigger already references
-- it, so redefining the body is enough. 014 only allowed removing a
-- path-scoped row when a *same-hostname* whole-domain row covered it; this
-- widens that to blocklist_entry_covers()'s full rule (subdomains, and any
-- path-prefix relationship, not just whole-domain-covers-path-scoped) so
-- dashboard.html's removeEntriesCoveredBy() cleanup succeeds in Strict
-- Mode for the subdomain case too (e.g. adding "instagram.com" while
-- "live.instagram.com" already exists and the profile is in Strict Mode).
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
