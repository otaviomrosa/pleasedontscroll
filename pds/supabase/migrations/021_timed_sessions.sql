-- PDS Migration 021: timed sessions. Blocking runs only while user_settings.session_until is in the future.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS session_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION schedule_block_end_at(p_tz TEXT, p_end_min INT)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT (date_trunc('day', now() AT TIME ZONE p_tz) + make_interval(mins => p_end_min)) AT TIME ZONE p_tz;
$$;

CREATE OR REPLACE FUNCTION pds_strict_lock_message(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s        user_settings%ROWTYPE;
  blk      schedules;
  until_ts TIMESTAMPTZ;
BEGIN
  SELECT * INTO s FROM user_settings WHERE id = p_user_id;
  IF s.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF s.blocking_mode = 'strict' AND s.session_until > now() THEN
    until_ts := s.session_until;
  END IF;

  blk := schedule_active_block(p_user_id);
  IF blk.id IS NOT NULL AND blk.mode = 'strict' THEN
    until_ts := GREATEST(COALESCE(until_ts, '-infinity'::timestamptz), schedule_block_end_at(s.timezone, blk.end_min));
  END IF;

  IF until_ts IS NULL THEN
    RETURN NULL;
  END IF;

  IF s.timezone IS NULL THEN
    RETURN 'Strict Mode is on until the session ends.';
  END IF;

  RETURN 'Strict Mode is on until ' || trim(to_char(until_ts AT TIME ZONE s.timezone, 'FMHH12:MI AM')) || '.';
END;
$$;

CREATE OR REPLACE FUNCTION pds_session_state(p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'profile_id', (SELECT id FROM profiles WHERE user_id = p_user_id AND is_active LIMIT 1),
    'mode', s.blocking_mode,
    'session_until', CASE WHEN s.session_until > now() THEN s.session_until END
  )
  FROM user_settings s
  WHERE s.id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION switch_active_profile(p_user_id UUID, p_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
  msg           TEXT;
BEGIN
  IF NOT pds_is_trusted_caller() AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized to modify profiles for this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  IF NOT pds_is_trusted_caller()
     AND current_setting('pds.applying_schedule', true) IS DISTINCT FROM '1' THEN
    msg := pds_strict_lock_message(p_user_id);
    IF msg IS NOT NULL THEN
      RAISE EXCEPTION '%', msg;
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

CREATE OR REPLACE FUNCTION enforce_lock_mode_blocklist_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg        TEXT;
  is_covered BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    msg := pds_strict_lock_message(OLD.user_id);
    IF msg IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = OLD.profile_id) THEN
        RETURN OLD;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM blocked_urls b
        WHERE b.profile_id = OLD.profile_id
          AND b.id != OLD.id
          AND blocklist_entry_covers(b.url, OLD.url)
      ) INTO is_covered;

      IF NOT is_covered THEN
        RAISE EXCEPTION 'Cannot remove a blocked site during a Strict session. %', msg;
      END IF;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION start_session(p_user_id UUID, p_profile_id UUID, p_mode TEXT, p_minutes INT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s   user_settings%ROWTYPE;
  msg TEXT;
BEGIN
  IF NOT pds_is_trusted_caller() AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized to start a session for this user.';
  END IF;

  IF p_mode IS NULL OR p_mode NOT IN ('friction', 'strict') THEN
    RAISE EXCEPTION 'Unknown mode.';
  END IF;

  IF p_minutes IS NULL OR p_minutes < 1 OR p_minutes > 720 THEN
    RAISE EXCEPTION 'A session runs from 1 minute to 12 hours.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  SELECT * INTO s FROM user_settings WHERE id = p_user_id;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'No settings for this user.';
  END IF;

  IF p_mode = 'strict' AND NOT COALESCE(s.is_premium, false) THEN
    RAISE EXCEPTION 'Strict Mode requires Focus Pro.';
  END IF;

  msg := pds_strict_lock_message(p_user_id);
  IF msg IS NOT NULL THEN
    RAISE EXCEPTION '%', msg;
  END IF;

  PERFORM switch_active_profile(p_user_id, p_profile_id);

  UPDATE user_settings
    SET blocking_mode = p_mode,
        session_until = now() + make_interval(mins => p_minutes),
        paused_until  = NULL
    WHERE id = p_user_id;

  RETURN pds_session_state(p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION end_session(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg TEXT;
BEGIN
  IF NOT pds_is_trusted_caller() AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized to end a session for this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  IF NOT pds_is_trusted_caller() THEN
    msg := pds_strict_lock_message(p_user_id);
    IF msg IS NOT NULL THEN
      RAISE EXCEPTION '%', msg;
    END IF;
  END IF;

  UPDATE user_settings SET session_until = NULL WHERE id = p_user_id;

  RETURN pds_session_state(p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION apply_schedule(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s               user_settings%ROWTYPE;
  blk             schedules;
  local_now       TIMESTAMP;
  today           TEXT;
  st              JSONB;
  snap            JSONB;
  applied         JSONB;
  skipped         JSONB;
  cur_profile     UUID;
  cur_mode        TEXT;
  cur_until       TIMESTAMPTZ;
  live            BOOLEAN;
  block_end       TIMESTAMPTZ;
  target_until    TIMESTAMPTZ;
  restore_profile UUID;
  restore_mode    TEXT;
  restore_until   TIMESTAMPTZ;
  block_json      JSONB;
  rest            JSONB;
BEGIN
  IF NOT pds_is_trusted_caller() AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized to apply the schedule for this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));
  PERFORM set_config('pds.applying_schedule', '1', true);

  SELECT * INTO s FROM user_settings WHERE id = p_user_id;
  IF s.id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_settings');
  END IF;

  SELECT id INTO cur_profile FROM profiles WHERE user_id = p_user_id AND is_active LIMIT 1;
  cur_mode  := s.blocking_mode;
  cur_until := s.session_until;
  live      := cur_until IS NOT NULL AND cur_until > now();

  IF NOT COALESCE(s.is_premium, false) THEN
    IF s.schedule_state IS NOT NULL THEN
      UPDATE user_settings SET schedule_state = NULL WHERE id = p_user_id;
    END IF;
    RETURN pds_session_state(p_user_id) || jsonb_build_object('applied', false, 'reason', 'free');
  END IF;

  local_now := schedule_local_now(p_user_id);
  IF local_now IS NULL THEN
    RETURN pds_session_state(p_user_id) || jsonb_build_object('applied', false, 'reason', 'no_timezone');
  END IF;

  today   := to_char(local_now, 'YYYY-MM-DD');
  st      := COALESCE(s.schedule_state, '{}'::jsonb);
  snap    := st -> 'snapshot';
  applied := st -> 'applied';
  skipped := st -> 'skipped';

  IF skipped IS NOT NULL AND (skipped ->> 'date') IS DISTINCT FROM today THEN
    skipped := NULL;
  END IF;
  rest := NULLIF(jsonb_strip_nulls(jsonb_build_object('skipped', skipped)), '{}'::jsonb);

  blk := schedule_active_block(p_user_id);

  IF blk.id IS NULL THEN
    IF snap IS NOT NULL AND applied IS NOT NULL
       AND (cur_profile IS DISTINCT FROM (applied ->> 'profile_id')::UUID
            OR cur_mode IS DISTINCT FROM (applied ->> 'mode')
            OR cur_until IS DISTINCT FROM (applied ->> 'until')::TIMESTAMPTZ) THEN
      snap := NULL;
    END IF;

    IF snap IS NOT NULL THEN
      restore_profile := (snap ->> 'profile_id')::UUID;
      IF restore_profile IS NULL
         OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = restore_profile AND user_id = p_user_id) THEN
        SELECT id INTO restore_profile FROM profiles WHERE user_id = p_user_id ORDER BY created_at ASC LIMIT 1;
      END IF;
      IF restore_profile IS NOT NULL AND restore_profile IS DISTINCT FROM cur_profile THEN
        PERFORM switch_active_profile(p_user_id, restore_profile);
      END IF;

      restore_mode  := CASE WHEN (snap ->> 'mode') = 'strict' THEN 'strict' ELSE 'friction' END;
      restore_until := (snap ->> 'until')::TIMESTAMPTZ;
      IF restore_until IS NOT NULL AND restore_until <= now() THEN
        restore_until := NULL;
      END IF;

      UPDATE user_settings
        SET blocking_mode = restore_mode, session_until = restore_until, schedule_state = rest
        WHERE id = p_user_id;
      RETURN pds_session_state(p_user_id) || jsonb_build_object('restored', true);
    END IF;

    IF s.schedule_state IS DISTINCT FROM rest THEN
      UPDATE user_settings SET schedule_state = rest WHERE id = p_user_id;
    END IF;
    RETURN pds_session_state(p_user_id) || jsonb_build_object('applied', false, 'reason', 'none');
  END IF;

  block_end  := schedule_block_end_at(s.timezone, blk.end_min);
  block_json := jsonb_build_object('id', blk.id, 'profile_id', blk.profile_id, 'mode', blk.mode,
                                   'day_of_week', blk.day_of_week, 'start_min', blk.start_min,
                                   'end_min', blk.end_min, 'until', block_end);

  IF skipped IS NOT NULL AND (skipped ->> 'block_id')::UUID = blk.id THEN
    RETURN pds_session_state(p_user_id) || jsonb_build_object('skipped', true, 'block', block_json);
  END IF;

  IF applied IS NOT NULL
     AND (applied ->> 'block_id')::UUID = blk.id
     AND (applied ->> 'version')::INT = blk.version
     AND (applied ->> 'date') = today THEN
    IF cur_profile IS DISTINCT FROM (applied ->> 'profile_id')::UUID
       OR cur_mode IS DISTINCT FROM (applied ->> 'mode')
       OR cur_until IS DISTINCT FROM (applied ->> 'until')::TIMESTAMPTZ THEN
      skipped := jsonb_build_object('block_id', blk.id, 'date', today);
      UPDATE user_settings SET schedule_state = jsonb_build_object('skipped', skipped) WHERE id = p_user_id;
      RETURN pds_session_state(p_user_id) || jsonb_build_object('skipped', true, 'block', block_json);
    END IF;
    RETURN pds_session_state(p_user_id) || jsonb_build_object('applied', true, 'block', block_json);
  END IF;

  IF blk.mode = 'friction' AND live AND cur_mode = 'strict' THEN
    IF s.schedule_state IS DISTINCT FROM rest THEN
      UPDATE user_settings SET schedule_state = rest WHERE id = p_user_id;
    END IF;
    RETURN pds_session_state(p_user_id) || jsonb_build_object('applied', false, 'reason', 'strict_session', 'block', block_json);
  END IF;

  target_until := block_end;
  IF live AND cur_mode = 'strict' AND cur_until > block_end THEN
    target_until := cur_until;
  END IF;

  IF snap IS NULL THEN
    snap := jsonb_build_object('profile_id', cur_profile, 'mode', cur_mode,
                               'until', CASE WHEN live THEN cur_until END);
  END IF;

  IF cur_profile IS DISTINCT FROM blk.profile_id THEN
    PERFORM switch_active_profile(p_user_id, blk.profile_id);
  END IF;

  applied := jsonb_build_object('block_id', blk.id, 'version', blk.version, 'date', today,
                                'profile_id', blk.profile_id, 'mode', blk.mode, 'until', target_until);

  UPDATE user_settings
    SET blocking_mode  = blk.mode,
        session_until  = target_until,
        paused_until   = NULL,
        schedule_state = jsonb_strip_nulls(jsonb_build_object('snapshot', snap, 'applied', applied, 'skipped', skipped))
    WHERE id = p_user_id;

  RETURN pds_session_state(p_user_id) || jsonb_build_object('applied', true, 'block', block_json);
END;
$$;

REVOKE UPDATE (blocking_mode, paused_until) ON public.user_settings FROM authenticated;

REVOKE EXECUTE ON FUNCTION
  public.start_session(uuid, uuid, text, int),
  public.end_session(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.start_session(uuid, uuid, text, int),
  public.end_session(uuid)
TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION
  public.schedule_block_end_at(text, int),
  public.pds_strict_lock_message(uuid),
  public.pds_session_state(uuid)
FROM PUBLIC, anon, authenticated;
