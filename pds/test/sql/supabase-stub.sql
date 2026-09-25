-- The slice of a Supabase project that the migrations depend on, so they can
-- run against a plain local Postgres (see scripts/test-sql.sh). Not a
-- migration and never run against the real project.
--
-- What matters for the tests is that grants and JWT claims behave the way
-- they do behind PostgREST:
--   * anon, authenticated and service_role exist; service_role bypasses RLS.
--   * Everything created in `public` by postgres is granted to all three
--     roles by default, tables and functions alike. That default is exactly
--     what 017 has to undo, so the stub must reproduce it.
--   * auth.uid() and auth.jwt() read the per-request claims PostgREST sets
--     with set_config('request.jwt.claims', …, true). test.act_as() below
--     sets the same claims and the same role.

-- Roles are cluster-wide, so they may already exist from an earlier run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id    UUID PRIMARY KEY,
  email TEXT
);

CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb;
$$;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      auth.jwt() ->> 'sub'
    ),
    ''
  )::uuid;
$$;

CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('request.jwt.claim.role', true), auth.jwt() ->> 'role');
$$;

GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role() TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- ─── Test helpers ────────────────────────────────────────────────────────────

CREATE SCHEMA test;
GRANT USAGE ON SCHEMA test TO anon, authenticated, service_role;

-- Deterministic user ids: test.uid(1) = 00000000-0000-0000-0000-000000000001.
CREATE FUNCTION test.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid;
$$;

-- Signs up a user the way GoTrue does: a row in auth.users, which fires the
-- signup triggers (user_settings + default profile). Run as postgres.
CREATE FUNCTION test.signup(n int) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO auth.users (id, email) VALUES (test.uid(n), 'user' || n || '@example.com') RETURNING id;
$$;

-- Makes the rest of the transaction look like a PostgREST request from
-- `p_role` (anon | authenticated | service_role), optionally as user `p_sub`.
-- test.act_as('postgres') drops the claims and returns to the superuser,
-- which is what the SQL editor and pg_cron look like.
CREATE FUNCTION test.act_as(p_role text, p_sub uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_role = 'postgres' THEN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('role', 'postgres', true);
  ELSE
    PERFORM set_config('request.jwt.claims',
      jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_sub))::text, true);
    PERFORM set_config('role', p_role, true);
  END IF;
END;
$$;

-- Runs p_sql and fails the test unless it raises an error matching p_pattern
-- (case-insensitive regex). The statement's effects roll back either way.
CREATE FUNCTION test.expect_error(p_sql text, p_pattern text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~* p_pattern THEN
      RAISE EXCEPTION 'expected an error matching "%", got "%" from: %', p_pattern, SQLERRM, p_sql;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected an error matching "%", but it succeeded: %', p_pattern, p_sql;
END;
$$;

-- Runs p_sql and fails the test if it raises. Returns the affected row count.
CREATE FUNCTION test.expect_ok(p_sql text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'unexpected error "%" from: %', SQLERRM, p_sql;
END;
$$;

CREATE FUNCTION test.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'check failed: %', p_label;
  END IF;
END;
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO anon, authenticated, service_role;
