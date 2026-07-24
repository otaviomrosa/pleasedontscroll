-- ============================================================
-- PDS Migration 008 — Blocklist pause
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- Lets a user temporarily disable blocking for a fixed window (30m / 1h /
-- 2h / 6h / 12h, chosen in the dashboard — see docs/ARCHITECTURE.md §5 for the full
-- mechanism). Friction Mode only: the extension's isUrlBlocked() ignores
-- this column entirely whenever blocking_mode is 'strict', so a pause can
-- never bypass Strict Mode even if one happens to still be active when the
-- user switches into it.
--
-- No new RLS policy needed: user_settings already has a full-row policy
-- ("Users manage own settings", USING (auth.uid() = id)) from
-- 001_initial_schema.sql that covers this column too.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;
