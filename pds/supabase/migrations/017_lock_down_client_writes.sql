-- ============================================================
-- PDS Migration 017 — Lock down what clients can write, and who can call
-- the security-definer functions
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- Closes four findings from a security review of this schema. Every
-- policy in this schema is `FOR ALL USING (auth.uid() = …)`: it decides
-- which ROWS a user reaches, never which COLUMNS or operations. The
-- triggers (009/011/014/015/016) guard the paths the app itself uses, so a
-- user sending their own REST calls could take any path they don't cover:
--   S1  PATCH user_settings.is_premium = true — Focus Pro for free.
--   S2  PATCH their own stripe_customer_id / stripe_subscription_id to
--       someone else's — the portal and delete-account trust those columns.
--   S3  Call switch_active_profile() / apply_schedule() / the schedule
--       helpers with only the public anon key. Those functions read
--       "auth.uid() IS NULL" as "the service-role webhook", but anon has no
--       uid either, so anon skipped both the ownership and the Strict check
--       (and apply_schedule() handed back any user's profile, mode, pause).
--   S4  Step around Strict Mode through writes the triggers don't watch:
--       UPDATE profiles.is_active / blocked_urls.url, DELETE + re-INSERT
--       the settings row, INSERT a second active profile.
--
-- The fix is grants, not more triggers. Clients only ever write three
-- user_settings columns (blocking_mode, paused_until, timezone) and never
-- UPDATE profiles or blocked_urls (switching goes through the RPC), so
-- those are the only writes left granted. service_role and the owner-run
-- security-definer functions (apply_schedule, the signup triggers) are
-- unaffected: REVOKE here only touches anon and authenticated.
--
-- Decided and deliberately NOT done here (see the fix sprint brief):
-- leaving manual Strict for Friction stays a plain PATCH of blocking_mode.
-- The popup's 30s hold is a courtesy; a user at that point can disable the
-- extension anyway, so a server cooldown would buy nothing.
--
-- No RLS policy changes. supabase/policies/*.sql gain a note on the grants.
-- ============================================================

-- ─── 1. Who counts as a trusted caller ─────────────────────────────────────
-- Replaces the "auth.uid() IS NULL means trusted" inference inside the RPCs.
-- Every request through the Supabase API carries JWT claims with a role
-- (anon, authenticated or service_role), so:
--   * role = 'service_role'  → stripe-webhook (and any future edge function)
--   * no claims at all       → a direct database session: the SQL editor,
--                              pg_cron, GoTrue's own signup triggers
--   * anon / authenticated   → an end user; never trusted
-- Only callable from the security-definer functions below (EXECUTE is
-- revoked from the API roles at the end of this file).
--
-- The triggers keep their existing `auth.uid() IS NOT NULL` scoping on
-- purpose: RLS already keeps anon away from every row, so for a table
-- trigger "no uid" really does mean the service role or a cascade.
CREATE OR REPLACE FUNCTION pds_is_trusted_caller()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(auth.jwt() ->> 'role', 'service_role') = 'service_role';
$$;

-- ─── 2. Table grants ───────────────────────────────────────────────────────
-- anon never touches these tables (every client call carries the user's
-- access token), so it keeps nothing. RLS already returned it zero rows;
-- this makes that a permission error instead of an empty result.
REVOKE ALL ON public.user_settings, public.profiles, public.blocked_urls, public.schedules FROM anon;

-- user_settings: read the row, write the three preference columns. Billing
-- (is_premium, stripe_*), schedule_state and the row itself (INSERT/DELETE)
-- are server-owned: the webhook, apply_schedule() and the signup trigger.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_settings FROM authenticated;
GRANT UPDATE (blocking_mode, paused_until, timezone) ON public.user_settings TO authenticated;

-- profiles / blocked_urls: nothing in /core, /web or /extension UPDATEs
-- either table. Profile activation is switch_active_profile(); a blocklist
-- entry is added or removed, never edited. INSERT and DELETE stay, still
-- guarded by 007/009/011/013/014/015.
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.profiles, public.blocked_urls FROM authenticated;

-- schedules keeps full write access (the dashboard edits blocks in place);
-- 016's triggers already guard it.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.schedules FROM authenticated;

-- ─── 3. A new profile starts inactive ──────────────────────────────────────
-- With UPDATE gone, the one remaining way to make a profile active without
-- the RPC was to INSERT it already active: a Focus Pro user in Strict Mode
-- could add an empty profile with is_active = true, leaving two active
-- rows and letting fetchActiveProfile()'s `limit=1` pick the empty one.
-- core/sync/profiles.js's createProfile() always sends false, so this only
-- refuses what the app never does. The signup trigger (003) still creates
-- the first profile active: it runs with no request claims, so it is a
-- trusted caller.
CREATE OR REPLACE FUNCTION reject_active_profile_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active AND NOT pds_is_trusted_caller() THEN
    RAISE EXCEPTION 'A new profile starts inactive. Switch to it after creating it.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_profile_insert_reject_active ON profiles;
CREATE TRIGGER before_profile_insert_reject_active
  BEFORE INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION reject_active_profile_insert();

-- ─── 4. switch_active_profile() and apply_schedule() ───────────────────────
-- Bodies copied verbatim from 016_schedules.sql. The only change in each is
-- the caller check: `auth.uid() IS NOT NULL AND …` became
-- `NOT pds_is_trusted_caller() AND …`, so an anonymous caller is treated
-- like any other end user (and fails the ownership check) instead of like
-- the webhook. The EXECUTE revoke in section 5 already keeps anon out;
-- this is the second layer, and it keeps working if a grant is ever
-- restored by mistake.

CREATE OR REPLACE FUNCTION switch_active_profile(p_user_id UUID, p_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
  mode          TEXT;
  blk           schedules;
BEGIN
  IF NOT pds_is_trusted_caller() AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized to modify profiles for this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  IF NOT pds_is_trusted_caller()
     AND current_setting('pds.applying_schedule', true) IS DISTINCT FROM '1' THEN
    SELECT blocking_mode INTO mode FROM user_settings WHERE id = p_user_id;
    IF mode = 'strict' THEN
      blk := schedule_active_block(p_user_id);
      IF blk.id IS NOT NULL AND blk.mode = 'strict' THEN
        RAISE EXCEPTION 'Strict Mode is scheduled until %.', schedule_minute_label(blk.end_min);
      END IF;
      RAISE EXCEPTION 'Cannot switch profiles while in Strict Mode.';
    END IF;
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

CREATE OR REPLACE FUNCTION apply_schedule(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  settings        user_settings%ROWTYPE;
  blk             schedules;
  local_now       TIMESTAMP;
  today           TEXT;
  st              JSONB;
  snap            JSONB;
  applied         JSONB;
  skipped         JSONB;
  cur_profile     UUID;
  cur_mode        TEXT;
  target_profile  UUID;
  target_mode     TEXT;
  restore_profile UUID;
  block_json      JSONB;
BEGIN
  IF NOT pds_is_trusted_caller() AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized to apply the schedule for this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));
  PERFORM set_config('pds.applying_schedule', '1', true);

  SELECT * INTO settings FROM user_settings WHERE id = p_user_id;
  IF settings.id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_settings');
  END IF;

  SELECT id INTO cur_profile FROM profiles WHERE user_id = p_user_id AND is_active = true LIMIT 1;
  cur_mode := settings.blocking_mode;

  -- Free accounts: the schedule is dormant. Drop any leftover state so a
  -- later re-subscribe starts clean rather than restoring a stale snapshot.
  IF NOT COALESCE(settings.is_premium, false) THEN
    IF settings.schedule_state IS NOT NULL THEN
      UPDATE user_settings SET schedule_state = NULL WHERE id = p_user_id;
    END IF;
    RETURN jsonb_build_object('applied', false, 'reason', 'free',
      'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
  END IF;

  local_now := schedule_local_now(p_user_id);
  IF local_now IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_timezone',
      'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
  END IF;
  today := to_char(local_now, 'YYYY-MM-DD');

  st      := COALESCE(settings.schedule_state, '{}'::jsonb);
  snap    := st -> 'snapshot';
  applied := st -> 'applied';
  skipped := st -> 'skipped';
  IF skipped IS NOT NULL AND (skipped ->> 'date') IS DISTINCT FROM today THEN
    skipped := NULL;
  END IF;

  blk := schedule_active_block(p_user_id);

  -- ── No block right now ────────────────────────────────────────────────
  IF blk.id IS NULL THEN
    -- The last block ended after the user had already changed profile or
    -- mode inside it (a Friction block, within the last poll interval):
    -- that's an override we never got to see. Their choice stands; don't
    -- restore over it.
    IF snap IS NOT NULL AND applied IS NOT NULL
       AND (cur_profile IS DISTINCT FROM (applied ->> 'profile_id')::UUID
            OR cur_mode IS DISTINCT FROM (applied ->> 'mode')) THEN
      snap := NULL;
    END IF;

    IF snap IS NOT NULL THEN
      -- The last block ended: put the user back where they were. A deleted
      -- snapshot profile falls back to the oldest one rather than raising.
      restore_profile := (snap ->> 'profile_id')::UUID;
      IF restore_profile IS NULL
         OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = restore_profile AND user_id = p_user_id) THEN
        SELECT id INTO restore_profile FROM profiles WHERE user_id = p_user_id ORDER BY created_at ASC LIMIT 1;
      END IF;
      IF restore_profile IS NOT NULL AND restore_profile IS DISTINCT FROM cur_profile THEN
        PERFORM switch_active_profile(p_user_id, restore_profile);
        cur_profile := restore_profile;
      END IF;

      target_mode := CASE WHEN (snap ->> 'mode') = 'strict' THEN 'strict' ELSE 'friction' END;
      IF target_mode != cur_mode THEN
        UPDATE user_settings SET blocking_mode = target_mode WHERE id = p_user_id;
        cur_mode := target_mode;
      END IF;

      UPDATE user_settings
        SET schedule_state = NULLIF(jsonb_strip_nulls(jsonb_build_object('skipped', skipped)), '{}'::jsonb)
        WHERE id = p_user_id;

      SELECT paused_until INTO settings.paused_until FROM user_settings WHERE id = p_user_id;
      RETURN jsonb_build_object('restored', true,
        'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
    END IF;

    -- Nothing to restore; only persist the skipped-cleanup if it changed.
    IF settings.schedule_state IS DISTINCT FROM NULLIF(jsonb_strip_nulls(jsonb_build_object('skipped', skipped)), '{}'::jsonb) THEN
      UPDATE user_settings
        SET schedule_state = NULLIF(jsonb_strip_nulls(jsonb_build_object('skipped', skipped)), '{}'::jsonb)
        WHERE id = p_user_id;
    END IF;
    RETURN jsonb_build_object('applied', false, 'reason', 'none',
      'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
  END IF;

  block_json := jsonb_build_object('id', blk.id, 'profile_id', blk.profile_id, 'mode', blk.mode,
                                   'day_of_week', blk.day_of_week, 'start_min', blk.start_min, 'end_min', blk.end_min);

  -- ── This occurrence was overridden earlier today ──────────────────────
  IF skipped IS NOT NULL AND (skipped ->> 'block_id')::UUID = blk.id THEN
    RETURN jsonb_build_object('skipped', true, 'block', block_json,
      'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
  END IF;

  -- ── Already applied this exact block today ────────────────────────────
  IF applied IS NOT NULL
     AND (applied ->> 'block_id')::UUID = blk.id
     AND (applied ->> 'version')::INT = blk.version
     AND (applied ->> 'date') = today THEN
    IF cur_profile IS DISTINCT FROM (applied ->> 'profile_id')::UUID
       OR cur_mode IS DISTINCT FROM (applied ->> 'mode') THEN
      -- The user changed profile or mode during this block (only possible
      -- for a Friction block; Strict is guarded). Leave them alone for the
      -- rest of it, and forget the snapshot: their choice is the new baseline.
      skipped := jsonb_build_object('block_id', blk.id, 'date', today);
      UPDATE user_settings SET schedule_state = jsonb_build_object('skipped', skipped) WHERE id = p_user_id;
      RETURN jsonb_build_object('skipped', true, 'block', block_json,
        'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
    END IF;
    RETURN jsonb_build_object('applied', true, 'block', block_json,
      'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
  END IF;

  -- ── Apply (first time today, or the block was edited) ─────────────────
  target_profile := blk.profile_id;
  target_mode := CASE
    WHEN blk.mode = 'strict' THEN 'strict'
    ELSE COALESCE(snap ->> 'mode', cur_mode)
  END;

  -- A Friction block never lowers a Strict the user chose themselves (no
  -- snapshot means the schedule didn't put them there) — that would make
  -- "paint a block" a hold-free Strict exit. Nothing is recorded, so the
  -- block is re-evaluated every tick and takes effect the moment the user
  -- leaves Strict on their own (through the popup's hold), for whatever is
  -- left of it.
  IF cur_mode = 'strict' AND snap IS NULL AND blk.mode = 'friction' THEN
    IF settings.schedule_state IS DISTINCT FROM NULLIF(jsonb_strip_nulls(jsonb_build_object('skipped', skipped)), '{}'::jsonb) THEN
      UPDATE user_settings
        SET schedule_state = NULLIF(jsonb_strip_nulls(jsonb_build_object('skipped', skipped)), '{}'::jsonb)
        WHERE id = p_user_id;
    END IF;
    RETURN jsonb_build_object('applied', false, 'reason', 'manual_strict', 'block', block_json,
      'profile_id', cur_profile, 'mode', cur_mode, 'paused_until', settings.paused_until);
  END IF;

  IF cur_profile IS DISTINCT FROM target_profile OR cur_mode != target_mode THEN
    IF snap IS NULL THEN
      snap := jsonb_build_object('profile_id', cur_profile, 'mode', cur_mode);
    END IF;
    IF cur_profile IS DISTINCT FROM target_profile THEN
      PERFORM switch_active_profile(p_user_id, target_profile);
    END IF;
    IF cur_mode != target_mode THEN
      UPDATE user_settings SET blocking_mode = target_mode WHERE id = p_user_id;
    END IF;
    -- Same rule as SET_BLOCKING_MODE: Strict and a pause can't coexist.
    IF target_mode = 'strict' AND settings.paused_until IS NOT NULL THEN
      UPDATE user_settings SET paused_until = NULL WHERE id = p_user_id;
    END IF;
  END IF;

  applied := jsonb_build_object('block_id', blk.id, 'version', blk.version, 'date', today,
                                'profile_id', target_profile, 'mode', target_mode);
  UPDATE user_settings
    SET schedule_state = jsonb_strip_nulls(jsonb_build_object('snapshot', snap, 'applied', applied, 'skipped', skipped))
    WHERE id = p_user_id;

  SELECT paused_until INTO settings.paused_until FROM user_settings WHERE id = p_user_id;
  RETURN jsonb_build_object('applied', true, 'block', block_json,
    'profile_id', target_profile, 'mode', target_mode, 'paused_until', settings.paused_until);
END;
$$;

-- ─── 5. Function grants ────────────────────────────────────────────────────
-- Supabase grants EXECUTE on every new public function to PUBLIC, anon,
-- authenticated and service_role, and PostgREST publishes each one as
-- /rest/v1/rpc/<name>. Only two are meant to be called by a signed-in user.
REVOKE EXECUTE ON FUNCTION
  public.switch_active_profile(uuid, uuid),
  public.apply_schedule(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.switch_active_profile(uuid, uuid),
  public.apply_schedule(uuid)
TO authenticated, service_role;

-- Internal helpers, used only inside the security-definer functions and
-- triggers (which run as their owner, so they keep access).
-- schedule_active_block() and schedule_local_now() are the ones that
-- mattered: both are security definer and returned any user's current
-- block / local time by id, bypassing RLS. The rest are pure string and
-- clock helpers, revoked so the API surface is only what clients use.
REVOKE EXECUTE ON FUNCTION
  public.pds_is_trusted_caller(),
  public.schedule_active_block(uuid),
  public.schedule_local_now(uuid),
  public.schedule_minute_label(int),
  public.blocklist_url_hostname(text),
  public.blocklist_url_is_whole_domain(text),
  public.blocklist_url_path_prefix(text),
  public.blocklist_entry_covers(text, text)
FROM PUBLIC, anon, authenticated;
