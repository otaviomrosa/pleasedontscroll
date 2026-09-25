-- 017_lock_down_client_writes.sql: what a signed-in user, the anon key, the
-- webhook (service_role) and the SQL editor (postgres) can each still do.
-- Every block rolls back, so they don't depend on each other.

-- ─── S1 / S2: billing columns are server-owned ─────────────────────────────
BEGIN;
SELECT test.signup(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_error($$ UPDATE user_settings SET is_premium = true WHERE id = test.uid(1) $$, 'permission denied');
SELECT test.expect_error($$ UPDATE user_settings SET stripe_customer_id = 'cus_x' WHERE id = test.uid(1) $$, 'permission denied');
SELECT test.expect_error($$ UPDATE user_settings SET stripe_subscription_id = 'sub_x' WHERE id = test.uid(1) $$, 'permission denied');
SELECT test.expect_error($$ UPDATE user_settings SET schedule_state = '{}' WHERE id = test.uid(1) $$, 'permission denied');
SELECT test.expect_error($$ DELETE FROM user_settings WHERE id = test.uid(1) $$, 'permission denied');
SELECT test.expect_error($$ INSERT INTO user_settings (id, is_premium) VALUES (test.uid(1), true) $$, 'permission denied');
ROLLBACK;
\echo ok - S1/S2 billing columns, schedule_state and the row itself are not client-writable

-- ─── The three columns clients do write still work ─────────────────────────
BEGIN;
SELECT test.signup(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.check(test.expect_ok($$ UPDATE user_settings SET blocking_mode = 'strict' WHERE id = test.uid(1) $$) = 1, 'set blocking_mode');
SELECT test.check(test.expect_ok($$ UPDATE user_settings SET blocking_mode = 'friction' WHERE id = test.uid(1) $$) = 1, 'leave strict (manual, no schedule)');
SELECT test.check(test.expect_ok($$ UPDATE user_settings SET paused_until = now() + interval '1 hour' WHERE id = test.uid(1) $$) = 1, 'set paused_until');
-- setTimezoneIfUnset(): PATCH filtered on timezone=is.null, returning the row.
SELECT test.check(test.expect_ok($$ UPDATE user_settings SET timezone = 'America/Sao_Paulo' WHERE id = test.uid(1) AND timezone IS NULL RETURNING * $$) = 1, 'set timezone once');
SELECT test.check(test.expect_ok($$ UPDATE user_settings SET timezone = 'Europe/Paris' WHERE id = test.uid(1) AND timezone IS NULL RETURNING * $$) = 0, 'second timezone write is a no-op');
SELECT test.check((SELECT is_premium FROM user_settings WHERE id = test.uid(1)) = false, 'can still read own row');
ROLLBACK;
\echo ok - blocking_mode, paused_until and timezone stay writable

-- ─── S4: no editing around Strict ──────────────────────────────────────────
BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true WHERE id = test.uid(1);
INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Empty', false);
INSERT INTO blocked_urls (user_id, profile_id, url)
  SELECT test.uid(1), id, 'instagram.com' FROM profiles WHERE user_id = test.uid(1) AND is_active;
UPDATE user_settings SET blocking_mode = 'strict' WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_error($$ UPDATE profiles SET is_active = (name = 'Empty') WHERE user_id = test.uid(1) $$, 'permission denied');
SELECT test.expect_error($$ UPDATE blocked_urls SET url = 'example.invalid' WHERE user_id = test.uid(1) $$, 'permission denied');
SELECT test.expect_error($$ DELETE FROM blocked_urls WHERE user_id = test.uid(1) $$, 'Strict Mode');
SELECT test.expect_error($$ INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Sneaky', true) $$, 'starts inactive');
SELECT test.expect_error($$ SELECT switch_active_profile(test.uid(1), (SELECT id FROM profiles WHERE name = 'Empty')) $$, 'Strict Mode');
ROLLBACK;
\echo ok - S4 profile/blocklist edits, a second active profile and the RPC are refused in Strict

-- ─── Normal Friction-mode use is unchanged ─────────────────────────────────
BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.check(test.expect_ok($$ INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Deep Work', false) $$) = 1, 'create profile');
SELECT test.check(test.expect_ok($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com' FROM profiles WHERE name = 'Deep Work' $$) = 1, 'add blocked url');
SELECT test.check(test.expect_ok($$ DELETE FROM blocked_urls WHERE url = 'reddit.com' $$) = 1, 'remove blocked url');
SELECT test.expect_ok($$ SELECT switch_active_profile(test.uid(1), (SELECT id FROM profiles WHERE name = 'Deep Work')) $$);
SELECT test.check((SELECT name FROM profiles WHERE is_active) = 'Deep Work', 'switched');
SELECT test.check(test.expect_ok($$ DELETE FROM profiles WHERE name = 'Default' $$) = 1, 'delete inactive profile');
SELECT test.expect_ok($$ SELECT apply_schedule(test.uid(1)) $$);
SELECT test.expect_ok($$ INSERT INTO schedules (user_id, profile_id, day_of_week, start_min, end_min, mode) SELECT test.uid(1), id, 0, 60, 120, 'friction' FROM profiles WHERE is_active $$);
SELECT test.check(test.expect_ok($$ UPDATE schedules SET end_min = 180 WHERE user_id = test.uid(1) $$) = 1, 'edit schedule block');
ROLLBACK;
\echo ok - profile, blocklist, switch, schedule and apply_schedule still work for the owner

-- ─── S3: the anon key reaches no function and no row ───────────────────────
BEGIN;
SELECT test.signup(1);
SELECT test.act_as('anon');
SELECT test.expect_error($$ SELECT switch_active_profile(test.uid(1), test.uid(1)) $$, 'permission denied');
SELECT test.expect_error($$ SELECT apply_schedule(test.uid(1)) $$, 'permission denied');
SELECT test.expect_error($$ SELECT schedule_active_block(test.uid(1)) $$, 'permission denied');
SELECT test.expect_error($$ SELECT schedule_local_now(test.uid(1)) $$, 'permission denied');
SELECT test.expect_error($$ SELECT pds_is_trusted_caller() $$, 'permission denied');
SELECT test.expect_error($$ SELECT * FROM user_settings $$, 'permission denied');
SELECT test.expect_error($$ SELECT * FROM profiles $$, 'permission denied');
ROLLBACK;
\echo ok - S3 anon cannot execute the RPCs or helpers, or read the tables

-- ─── S3: a signed-in user reaches only their own account ───────────────────
BEGIN;
SELECT test.signup(1);
SELECT test.signup(2);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_error($$ SELECT switch_active_profile(test.uid(2), (SELECT id FROM profiles LIMIT 1)) $$, 'Not authorized');
SELECT test.expect_error($$ SELECT apply_schedule(test.uid(2)) $$, 'Not authorized');
SELECT test.expect_error($$ SELECT schedule_active_block(test.uid(2)) $$, 'permission denied');
ROLLBACK;
\echo ok - S3 an authenticated user cannot act on another account

-- ─── The webhook and the SQL editor keep working ───────────────────────────
BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true, blocking_mode = 'strict' WHERE id = test.uid(1);
INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Second', false);
-- stripe-webhook: downgrade switches the profile even in Strict, then resets mode.
SELECT test.act_as('service_role');
SELECT test.check(test.expect_ok($$ UPDATE user_settings SET is_premium = false, stripe_customer_id = 'cus_1' WHERE id = test.uid(1) $$) = 1, 'webhook writes billing columns');
SELECT test.expect_ok($$ SELECT switch_active_profile(test.uid(1), (SELECT id FROM profiles WHERE name = 'Second')) $$);
SELECT test.check((SELECT name FROM profiles WHERE is_active) = 'Second', 'service role switched in Strict');
-- SQL editor / a future pg_cron job: no request claims at all.
SELECT test.act_as('postgres');
SELECT test.expect_ok($$ SELECT apply_schedule(test.uid(1)) $$);
SELECT test.expect_ok($$ SELECT switch_active_profile(test.uid(1), (SELECT id FROM profiles WHERE name = 'Default')) $$);
ROLLBACK;
\echo ok - service_role and direct database sessions are still trusted

-- ─── Signup still creates an active default profile ────────────────────────
BEGIN;
SELECT test.signup(1);
SELECT test.check((SELECT count(*) FROM profiles WHERE user_id = test.uid(1) AND is_active) = 1, 'default profile active');
SELECT test.check((SELECT count(*) FROM user_settings WHERE id = test.uid(1)) = 1, 'settings row created');
ROLLBACK;
\echo ok - signup triggers are unaffected
