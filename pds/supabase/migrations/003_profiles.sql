-- ============================================================
-- PDS Migration 003 — Profiles & Contexts
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- ─── 1. Create the profiles table ─────────────────────────────────────────────
CREATE TABLE profiles (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  is_active  BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Enable RLS ────────────────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own profiles"
  ON profiles
  FOR ALL
  USING (auth.uid() = user_id);

-- ─── 3. Scope blocked_urls to a profile ──────────────────────────────────────
-- Adds a nullable profile_id so existing rows are not broken.
-- After back-filling, you can add NOT NULL if desired.
ALTER TABLE blocked_urls
  ADD COLUMN profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE;

-- ─── 4. Default-profile trigger ──────────────────────────────────────────────
-- Creates one "Default" profile (active = true) whenever a new auth user signs up.
-- Runs alongside the existing user_settings trigger.
CREATE OR REPLACE FUNCTION create_default_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (user_id, name, is_active)
  VALUES (NEW.id, 'Default', true);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_default_profile();

-- ─── 5. Back-fill existing users ─────────────────────────────────────────────
-- Gives every existing auth user a "Default" profile and links their
-- orphaned blocked_urls rows to it.
DO $$
DECLARE
  u RECORD;
  new_profile_id UUID;
BEGIN
  FOR u IN
    SELECT id FROM auth.users
    WHERE id NOT IN (SELECT user_id FROM profiles)
  LOOP
    INSERT INTO profiles (user_id, name, is_active)
    VALUES (u.id, 'Default', true)
    RETURNING id INTO new_profile_id;

    UPDATE blocked_urls
    SET profile_id = new_profile_id
    WHERE user_id = u.id AND profile_id IS NULL;
  END LOOP;
END;
$$;
