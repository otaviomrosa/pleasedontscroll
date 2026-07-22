-- ============================================================
-- PDS Migration 002 — user_settings auto-creation trigger
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- Automatically creates a user_settings row whenever a new auth user signs up.
CREATE OR REPLACE FUNCTION create_user_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_settings (id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_settings
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_user_settings();
