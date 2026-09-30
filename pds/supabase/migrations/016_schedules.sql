-- ============================================================
-- 016_schedules.sql
--
-- Scheduled blocking. A `schedules` row is one painted block on the
-- dashboard's weekly grid: "on this weekday, between these minutes, this
-- profile should be active in this mode." Nothing in Postgres runs on a
-- timer (no pg_cron here), so enforcement is client-driven: the extension
-- calls apply_schedule() every minute (plus a one-shot alarm on the next
-- block boundary), and the dashboard calls it on load. apply_schedule() is
-- the ONLY place a schedule ever changes profile/mode, and it is idempotent.
--
-- Design decisions (see docs/ARCHITECTURE.md "Scheduled blocking"):
--   * Times are integer minutes from LOCAL midnight (0..1440), day_of_week
--     is 0 = Monday .. 6 = Sunday (matches the grid's column index; note
--     EXTRACT(ISODOW) is 1..7, hence the "- 1" below, and JS getDay() is
--     0 = Sunday). end_min = 1440 means midnight as an END, which a `time`
--     column cannot express. Matching is half-open: start <= m < end.
--   * "Now" is evaluated in the user's own timezone (user_settings.timezone,
--     IANA name, written once by whichever client first sees the account).
--     No timezone, or no Focus Pro, means no active block, ever — which is
--     the single condition that keeps every guard below off a downgraded or
--     un-timezoned account.
--   * A scheduled Strict block cannot be left, edited or deleted while it
--     is active: two BEFORE triggers below enforce that server-side. The
--     popup's 30s hold is client-only and would otherwise be a bypass.
--   * apply_schedule() itself must be allowed to make transitions a human
--     may not (Strict -> Strict on another profile, restoring the previous
--     state after a Strict block ends). It sets a transaction-local GUC,
--     pds.applying_schedule, and every guard — including the Strict check
--     inside switch_active_profile() from 011 — short-circuits on it.
--   * Every guard is also scoped to auth.uid() IS NOT NULL, so the
--     service-role stripe-webhook (which downgrades users by switching
--     profile and resetting mode) is never affected — same lesson as 011.
--   * When a block first takes over, apply_schedule() snapshots the
--     user's profile + mode into user_settings.schedule_state and restores
--     them when the block ends. If the user manually changes profile or
--     mode during a FRICTION block, that occurrence is skipped for the rest
--     of the day and their manual state becomes the new baseline. A
--     Friction block never lowers a Strict the user chose manually (that
--     would turn "paint a block" into a hold-free Strict exit).
--
-- Run this in the Supabase SQL Editor. Ships with
-- supabase/policies/schedules.sql and the new Schedule typedef in
-- core/types/index.js, per docs/ARCHITECTURE.md.
-- ============================================================

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schedules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_id  UUID        NOT NULL REFERENCES profiles(id)   ON DELETE CASCADE,
  day_of_week SMALLINT    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_min   SMALLINT    NOT NULL,
  end_min     SMALLINT    NOT NULL,
  mode        TEXT        NOT NULL CHECK (mode IN ('friction', 'strict')),
  -- Bumped on every UPDATE (trigger below). apply_schedule() records the
  -- version it applied so an edited block is re-applied instead of being
  -- mistaken for a manual override.
  version     INT         NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min)
);

CREATE INDEX IF NOT EXISTS schedules_user_day_idx ON schedules (user_id, day_of_week);

ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own schedules"
  ON schedules
  FOR ALL
  USING (auth.uid() = user_id);

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS timezone       TEXT,
  ADD COLUMN IF NOT EXISTS schedule_state JSONB;

-- ─── Helpers ────────────────────────────────────────────────────────────────

-- Wall-clock "now" for the user, or NULL when no timezone is stored.
CREATE OR REPLACE FUNCTION schedule_local_now(p_user_id UUID)
RETURNS TIMESTAMP
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz TEXT;
BEGIN
  SELECT timezone INTO tz FROM user_settings WHERE id = p_user_id;
  IF tz IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN now() AT TIME ZONE tz;
END;
$$;

-- The block covering "now" for this user, or a NULL row (id IS NULL) when
-- there is none — including whenever the account is not Focus Pro or has
-- no timezone. Every guard in this file keys off this one function.
CREATE OR REPLACE FUNCTION schedule_active_block(p_user_id UUID)
RETURNS schedules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  premium   BOOLEAN;
  local_now TIMESTAMP;
  d         INT;
  m         INT;
  blk       schedules;
BEGIN
  SELECT is_premium INTO premium FROM user_settings WHERE id = p_user_id;
  IF NOT COALESCE(premium, false) THEN
    RETURN blk;
  END IF;

  local_now := schedule_local_now(p_user_id);
  IF local_now IS NULL THEN
    RETURN blk;
  END IF;

  d := EXTRACT(ISODOW FROM local_now)::INT - 1;
  m := EXTRACT(HOUR FROM local_now)::INT * 60 + EXTRACT(MINUTE FROM local_now)::INT;

  SELECT * INTO blk
  FROM schedules
  WHERE user_id = p_user_id
    AND day_of_week = d
    AND start_min <= m
    AND m < end_min
  LIMIT 1;

  RETURN blk;
END;
$$;

-- "11:00 PM" for 1380, "12:00 AM" for 1440 (midnight as an end).
CREATE OR REPLACE FUNCTION schedule_minute_label(p_min INT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_min >= 1440 THEN
    RETURN '12:00 AM';
  END IF;
  RETURN trim(to_char(make_time(p_min / 60, p_min % 60, 0), 'HH12:MI AM'));
END;
$$;

-- ─── Guards on `schedules` ──────────────────────────────────────────────────

-- (1) No overlapping blocks for the same user on the same day (half-open,
--     so abutting blocks are fine), (2) the profile must belong to the
--     same user, (3) version bumps on every UPDATE.
CREATE OR REPLACE FUNCTION reject_overlapping_schedule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.profile_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'That profile does not belong to this account.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM schedules s
    WHERE s.user_id = NEW.user_id
      AND s.day_of_week = NEW.day_of_week
      AND s.id != NEW.id
      AND s.start_min < NEW.end_min
      AND NEW.start_min < s.end_min
  ) THEN
    RAISE EXCEPTION 'That time overlaps another block.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_schedule_write_reject_overlap ON schedules;
CREATE TRIGGER before_schedule_write_reject_overlap
  BEFORE INSERT OR UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION reject_overlapping_schedule();

-- An active Strict block is frozen: no edits, no deletion, until it ends.
CREATE OR REPLACE FUNCTION enforce_active_strict_block_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  blk schedules;
BEGIN
  IF auth.uid() IS NOT NULL
     AND current_setting('pds.applying_schedule', true) IS DISTINCT FROM '1' THEN
    blk := schedule_active_block(OLD.user_id);
    IF blk.id = OLD.id AND OLD.mode = 'strict' THEN
      RAISE EXCEPTION 'This block is active right now and cannot be changed.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_schedule_change_enforce_active_strict ON schedules;
CREATE TRIGGER before_schedule_change_enforce_active_strict
  BEFORE UPDATE OR DELETE ON schedules
  FOR EACH ROW EXECUTE FUNCTION enforce_active_strict_block_guard();

-- ─── Guard on `user_settings` ───────────────────────────────────────────────

-- Three things, all scoped to a real end-user JWT and to writes that are
-- not apply_schedule()'s own:
--   * Strict -> Friction is rejected while a Strict block is active. Written
--     on exactly that transition, so paused_until writes (the breathing
--     grant, dashboard pause/resume, apply's own pause clear) never trip it.
--   * timezone must be a real zone, and cannot change during an active
--     Strict block (a second device in another zone would otherwise unlock
--     it by making "now" fall outside the block).
--   * schedule_state is owned by apply_schedule(); clients may not write it.
CREATE OR REPLACE FUNCTION enforce_scheduled_strict_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  blk         schedules;
  leaving     BOOLEAN;
  tz_changing BOOLEAN;
BEGIN
  IF auth.uid() IS NULL
     OR current_setting('pds.applying_schedule', true) = '1' THEN
    RETURN NEW;
  END IF;

  IF NEW.schedule_state IS DISTINCT FROM OLD.schedule_state THEN
    RAISE EXCEPTION 'schedule_state is managed by the schedule and cannot be edited.';
  END IF;

  tz_changing := NEW.timezone IS DISTINCT FROM OLD.timezone;
  IF tz_changing AND NEW.timezone IS NOT NULL THEN
    BEGIN
      PERFORM now() AT TIME ZONE NEW.timezone;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Unknown timezone: %', NEW.timezone;
    END;
  END IF;

  leaving := OLD.blocking_mode = 'strict' AND NEW.blocking_mode = 'friction';

  IF leaving OR tz_changing THEN
    -- Reads the stored (OLD) timezone/premium, since the row isn't updated yet.
    blk := schedule_active_block(OLD.id);
    IF blk.id IS NOT NULL AND blk.mode = 'strict' THEN
      IF leaving THEN
        RAISE EXCEPTION 'Strict Mode is scheduled until %.', schedule_minute_label(blk.end_min);
      END IF;
      RAISE EXCEPTION 'Timezone cannot change during a scheduled Strict block.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_user_settings_update_enforce_schedule ON user_settings;
CREATE TRIGGER before_user_settings_update_enforce_schedule
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION enforce_scheduled_strict_guard();

-- ─── switch_active_profile(): bypass flag + per-user serialization ──────────
-- Same body as 011_lock_mode_guards.sql's revision, plus: (a) the Strict
-- check is skipped while apply_schedule() is running (the schedule may move
-- between profiles in Strict; a human may not), (b) a transaction-scoped
-- advisory lock per user, so a popup switch can never interleave with a
-- schedule tick (which would otherwise be misread as a manual override).
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
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Not authorized to modify profiles for this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  IF auth.uid() IS NOT NULL
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

-- ─── apply_schedule(): the one place a schedule changes anything ────────────
-- Idempotent. Returns JSONB (never VOID — supabaseFetch() can't tell an
-- empty body from an error), always carrying the resulting profile_id, mode
-- and paused_until so callers need no follow-up reads:
--   { applied: true,  block: {...}, profile_id, mode, paused_until }
--   { restored: true, profile_id, mode, paused_until }
--   { skipped: true,  block: {...}, ... }     user overrode a Friction block today
--   { applied: false, reason: 'free' | 'no_timezone' | 'none', ... }
-- schedule_state shape: { snapshot: {profile_id, mode} | absent,
--                         applied:  {block_id, version, date, profile_id, mode} | absent,
--                         skipped:  {block_id, date} | absent }
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
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
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
