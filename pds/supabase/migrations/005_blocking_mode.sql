-- ============================================================
-- PDS Migration 005 — Blocking Mode (Friction / Strict)
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- ─── Add blocking_mode to user_settings ────────────────────────────────────
-- User-level toggle between:
--   'friction' — 30-second breathing bypass (the current default behavior)
--   'strict'   — no bypass at all
--
-- This is deliberately on user_settings, NOT profiles. Friction/Strict is
-- not a property of a profile — any profile can be run in either mode. The
-- mode is a single setting per user, switched from the extension popup.
--
-- No new RLS policy needed: user_settings already has a full-row policy
-- ("Users manage own settings", USING (auth.uid() = id)) from
-- 001_initial_schema.sql that covers this column too.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS blocking_mode TEXT NOT NULL DEFAULT 'friction'
    CHECK (blocking_mode IN ('friction', 'strict'));
