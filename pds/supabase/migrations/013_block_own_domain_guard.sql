-- ============================================================
-- PDS Migration 013 — Prevent blocking pleasedontscroll.com itself
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- No RLS policy change accompanies this migration, same reasoning as
-- 007/009/011 — this is a BEFORE INSERT trigger enforcing a business rule
-- on top of the existing "Users manage own blocked_urls" policy from
-- 001_initial_schema.sql, not a new table or policy.
-- ============================================================

-- ─── Enforce: pleasedontscroll.com (or any subdomain) can never be blocked ───
-- The dashboard, pricing page, and account settings all live at
-- pleasedontscroll.com (see docs/ARCHITECTURE.md's Clean URLs note). If a user ever
-- got this onto their own blocklist, the extension's tab intercept would
-- redirect the dashboard itself to blocked.html — and in Strict Mode
-- specifically, 011_lock_mode_guards.sql's "no bypass" + "can't remove a
-- blocked site while in Strict Mode" guards would combine into a genuine
-- dead end: no way to reach the one page that could undo it, and no way to
-- undo it even if they somehow did. This is caught client-side in
-- dashboard.html (core/blocklist/hostname.js's isOwnDomain(), checked in
-- both the manual add form and the quick-add chips) for a fast, specific
-- error message, but enforced here too since blocked_urls is reachable by
-- direct REST, not just that form — same "client-side is UX, server-side is
-- the one that actually matters" pattern as every other guard in this file's
-- siblings.
--
-- Mirrors core/blocklist/hostname.js's normalizeToHostname() closely enough
-- to catch every way a user would actually type this (with/without
-- scheme, with/without www, with a trailing path) — it doesn't need to be a
-- general-purpose URL parser, just enough to strip what that function
-- strips.
CREATE OR REPLACE FUNCTION reject_own_domain_blocklist_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized TEXT;
BEGIN
  normalized := lower(trim(NEW.url));
  normalized := regexp_replace(normalized, '^[a-z][a-z0-9+.-]*://', '');
  normalized := regexp_replace(normalized, '^www\.', '');
  normalized := split_part(normalized, '/', 1);
  normalized := split_part(normalized, '?', 1);
  normalized := split_part(normalized, ':', 1);

  IF normalized = 'pleasedontscroll.com' OR normalized LIKE '%.pleasedontscroll.com' THEN
    RAISE EXCEPTION 'Cannot block pleasedontscroll.com — this would lock you out of the dashboard.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER before_blocked_url_insert_reject_own_domain
  BEFORE INSERT ON blocked_urls
  FOR EACH ROW EXECUTE FUNCTION reject_own_domain_blocklist_entry();
