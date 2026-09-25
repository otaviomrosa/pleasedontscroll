-- ============================================================
-- PDS Migration 018 — Keep the SQL blocklist rules in step with
-- core/blocklist/hostname.js: trailing-dot hostnames and whole-segment
-- path matching
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- Mirrors two changes to core/blocklist/hostname.js (audit R4, R5):
--   * A hostname's DNS root dot is dropped: "instagram.com." is the same
--     site as "instagram.com". The extension now matches it; without this
--     the SQL side would treat "instagram.com." as a different, uncovered
--     entry (a duplicate the redundancy guard misses).
--   * A path entry covers its own segment and everything under it:
--     "youtube.com/shorts" covers ".../shorts/abc" but no longer
--     ".../shortsxyz".
--
-- And one consequence that has to ship with them: 013's own-domain guard
-- normalizes the URL inline and never dropped the root dot. Before this
-- change "pleasedontscroll.com." was harmless, because the extension didn't
-- recognize it either; now the extension would read it as the dashboard's
-- domain. The guard is redefined on top of blocklist_url_hostname() so both
-- sides agree. (The extension also refuses to match its own domain at all
-- now, so a stored string this regex still misses, such as a
-- percent-encoded dot, is inert rather than a lockout.)
--
-- Same function names as 013/014/015, so every trigger that uses them
-- picks up the new bodies with no CREATE TRIGGER change.
-- blocklist_url_path_prefix() needs no change: it already worked on the
-- scheme/www-stripped string and returns NULL for "instagram.com.".
-- No RLS policy change.
-- ============================================================

-- ─── Hostname: now also drops trailing dots ────────────────────────────────
CREATE OR REPLACE FUNCTION blocklist_url_hostname(raw_url TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
    split_part(
      split_part(
        split_part(
          regexp_replace(regexp_replace(lower(trim(raw_url)), '^[a-z][a-z0-9+.-]*://', ''), '^www\.', ''),
          '/', 1
        ),
        '?', 1
      ),
      ':', 1
    ),
    '\.+$', ''
  );
$$;

-- ─── Coverage: path prefixes compare whole segments ────────────────────────
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
        AND (
          blocklist_url_path_prefix(candidate_url) = blocklist_url_path_prefix(covering_url)
          OR left(
               blocklist_url_path_prefix(candidate_url),
               length(blocklist_url_path_prefix(covering_url)) + 1
             ) = blocklist_url_path_prefix(covering_url) || '/'
        )
      )
    );
$$;

-- ─── Own-domain guard, on the shared hostname helper ───────────────────────
CREATE OR REPLACE FUNCTION reject_own_domain_blocklist_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized TEXT := blocklist_url_hostname(NEW.url);
BEGIN
  IF normalized = 'pleasedontscroll.com' OR right(normalized, 21) = '.pleasedontscroll.com' THEN
    RAISE EXCEPTION 'Cannot block pleasedontscroll.com. That would lock you out of the dashboard.';
  END IF;

  RETURN NEW;
END;
$$;

-- 017 revoked EXECUTE on the helpers from the API roles. CREATE OR REPLACE
-- keeps a function's existing grants, so this only matters when 018 is
-- applied before 017; repeating the revoke keeps the order irrelevant.
REVOKE EXECUTE ON FUNCTION
  public.blocklist_url_hostname(text),
  public.blocklist_entry_covers(text, text)
FROM PUBLIC, anon, authenticated;
