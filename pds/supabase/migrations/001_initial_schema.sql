-- ============================================================
-- PDS Migration 001 — Initial Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- ─── 1. blocked_urls ─────────────────────────────────────────────────────────
CREATE TABLE blocked_urls (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url        TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE blocked_urls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own blocked_urls"
  ON blocked_urls
  FOR ALL
  USING (auth.uid() = user_id);

-- ─── 2. user_settings ────────────────────────────────────────────────────────
CREATE TABLE user_settings (
  id         UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_premium BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own settings"
  ON user_settings
  FOR ALL
  USING (auth.uid() = id);
