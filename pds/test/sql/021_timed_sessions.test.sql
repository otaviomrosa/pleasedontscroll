-- 021_timed_sessions.sql: sessions, the Strict lock tied to them, and the schedule as automatic sessions.

BEGIN;
SELECT test.signup(1);
INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com' FROM profiles WHERE user_id = test.uid(1);
UPDATE user_settings SET paused_until = now() + interval '1 hour' WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles WHERE user_id = test.uid(1)), 'friction', 30) $$);
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) = now() + interval '30 minutes', 'session ends in 30 minutes');
SELECT test.check((SELECT blocking_mode FROM user_settings WHERE id = test.uid(1)) = 'friction', 'friction mode');
SELECT test.check((SELECT paused_until FROM user_settings WHERE id = test.uid(1)) IS NULL, 'old pause cleared');
SELECT test.check(test.expect_ok($$ DELETE FROM blocked_urls WHERE url = 'reddit.com' $$) = 1, 'friction session allows edits');
SELECT test.expect_ok($$ SELECT end_session(test.uid(1)) $$);
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) IS NULL, 'friction session ended early');
ROLLBACK;
\echo ok - a Friction session starts, allows edits and ends early

BEGIN;
SELECT test.signup(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_error($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles WHERE user_id = test.uid(1)), 'strict', 30) $$, 'requires Focus Pro');
SELECT test.expect_error($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles WHERE user_id = test.uid(1)), 'friction', 0) $$, '1 minute to 12 hours');
SELECT test.expect_error($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles WHERE user_id = test.uid(1)), 'friction', 721) $$, '1 minute to 12 hours');
SELECT test.expect_error($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles WHERE user_id = test.uid(1)), 'calm', 30) $$, 'Unknown mode');
ROLLBACK;
\echo ok - Strict needs Focus Pro, and length and mode are validated

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true, timezone = 'UTC' WHERE id = test.uid(1);
INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Empty', false);
INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com' FROM profiles WHERE name = 'Default';
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles WHERE name = 'Default'), 'strict', 60) $$);
SELECT test.expect_error($$ SELECT end_session(test.uid(1)) $$, 'Strict Mode is on until');
SELECT test.expect_error($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles WHERE name = 'Empty'), 'friction', 15) $$, 'Strict Mode is on until');
SELECT test.expect_error($$ SELECT switch_active_profile(test.uid(1), (SELECT id FROM profiles WHERE name = 'Empty')) $$, 'Strict Mode is on until');
SELECT test.expect_error($$ DELETE FROM blocked_urls WHERE url = 'reddit.com' $$, 'Strict session');
SELECT test.check(test.expect_ok($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'x.com' FROM profiles WHERE name = 'Default' $$) = 1, 'adding is still allowed');
ROLLBACK;
\echo ok - a Strict session cannot be ended, replaced, switched or edited around

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true, blocking_mode = 'strict', session_until = now() - interval '1 minute' WHERE id = test.uid(1);
INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Other', false);
INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com' FROM profiles WHERE name = 'Default';
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.check(test.expect_ok($$ DELETE FROM blocked_urls WHERE url = 'reddit.com' $$) = 1, 'expired Strict session no longer locks edits');
SELECT test.expect_ok($$ SELECT switch_active_profile(test.uid(1), (SELECT id FROM profiles WHERE name = 'Other')) $$);
ROLLBACK;
\echo ok - Strict with no running session locks nothing

BEGIN;
SELECT test.signup(1);
SELECT test.signup(2);
SELECT test.act_as('anon');
SELECT test.expect_error($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles LIMIT 1), 'friction', 30) $$, 'permission denied');
SELECT test.expect_error($$ SELECT end_session(test.uid(1)) $$, 'permission denied');
SELECT test.act_as('authenticated', test.uid(2));
SELECT test.expect_error($$ SELECT start_session(test.uid(1), (SELECT id FROM profiles LIMIT 1), 'friction', 30) $$, 'Not authorized');
SELECT test.expect_error($$ SELECT end_session(test.uid(1)) $$, 'Not authorized');
SELECT test.expect_error($$ SELECT pds_strict_lock_message(test.uid(2)) $$, 'permission denied');
SELECT test.expect_error($$ UPDATE user_settings SET session_until = now() + interval '1 hour' WHERE id = test.uid(2) $$, 'permission denied');
ROLLBACK;
\echo ok - only the owner starts or ends a session, and session_until is server-owned

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true, timezone = 'UTC' WHERE id = test.uid(1);
INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Evening', false);
INSERT INTO schedules (user_id, profile_id, day_of_week, start_min, end_min, mode)
  SELECT test.uid(1), id, EXTRACT(ISODOW FROM now() AT TIME ZONE 'UTC')::INT - 1, 0, 1440, 'strict' FROM profiles WHERE name = 'Evening';
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ SELECT apply_schedule(test.uid(1)) $$);
SELECT test.check((SELECT name FROM profiles WHERE is_active AND user_id = test.uid(1)) = 'Evening', 'block switched the profile');
SELECT test.check((SELECT blocking_mode FROM user_settings WHERE id = test.uid(1)) = 'strict', 'block set Strict');
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day', 'session ends with the block');
SELECT test.expect_error($$ SELECT end_session(test.uid(1)) $$, 'Strict Mode is on until 12:00 AM');
SELECT test.expect_ok($$ SELECT apply_schedule(test.uid(1)) $$);
SELECT test.check((SELECT name FROM profiles WHERE is_active AND user_id = test.uid(1)) = 'Evening', 'second tick is a no-op');
SELECT test.act_as('postgres');
UPDATE schedules SET day_of_week = (day_of_week + 1) % 7 WHERE user_id = test.uid(1);
UPDATE user_settings SET session_until = (schedule_state -> 'applied' ->> 'until')::timestamptz WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ SELECT apply_schedule(test.uid(1)) $$);
SELECT test.check((SELECT name FROM profiles WHERE is_active AND user_id = test.uid(1)) = 'Default', 'profile restored after the block');
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) IS NULL, 'no session after the block');
SELECT test.check((SELECT blocking_mode FROM user_settings WHERE id = test.uid(1)) = 'friction', 'mode restored after the block');
SELECT test.check((SELECT schedule_state FROM user_settings WHERE id = test.uid(1)) IS NULL, 'state cleared');
ROLLBACK;
\echo ok - a Strict block runs as a session that cannot be ended, then restores

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true, timezone = 'UTC' WHERE id = test.uid(1);
INSERT INTO schedules (user_id, profile_id, day_of_week, start_min, end_min, mode)
  SELECT test.uid(1), id, EXTRACT(ISODOW FROM now() AT TIME ZONE 'UTC')::INT - 1, 0, 1440, 'friction' FROM profiles WHERE user_id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ SELECT apply_schedule(test.uid(1)) $$);
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) IS NOT NULL, 'friction block started a session');
SELECT test.expect_ok($$ SELECT end_session(test.uid(1)) $$);
SELECT test.check((apply_schedule(test.uid(1)) ->> 'skipped')::boolean, 'ended block is skipped for today');
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) IS NULL, 'skipped block does not restart');
ROLLBACK;
\echo ok - ending a Friction block skips it for the rest of today

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true, timezone = 'UTC' WHERE id = test.uid(1);
INSERT INTO schedules (user_id, profile_id, day_of_week, start_min, end_min, mode)
  SELECT test.uid(1), id, EXTRACT(ISODOW FROM now() AT TIME ZONE 'UTC')::INT - 1, 0, 1440, 'friction' FROM profiles WHERE user_id = test.uid(1);
UPDATE user_settings SET blocking_mode = 'strict', session_until = now() + interval '2 hours' WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.check(apply_schedule(test.uid(1)) ->> 'reason' = 'strict_session', 'friction block leaves a running Strict session alone');
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) = now() + interval '2 hours', 'strict session untouched');
ROLLBACK;
\echo ok - a Friction block never lowers a running Strict session

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true, timezone = 'UTC' WHERE id = test.uid(1);
INSERT INTO schedules (user_id, profile_id, day_of_week, start_min, end_min, mode)
  SELECT test.uid(1), id, EXTRACT(ISODOW FROM now() AT TIME ZONE 'UTC')::INT - 1, 0, 1440, 'strict' FROM profiles WHERE user_id = test.uid(1);
UPDATE user_settings SET blocking_mode = 'strict', session_until = now() + interval '30 hours' WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ SELECT apply_schedule(test.uid(1)) $$);
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) = now() + interval '30 hours', 'a Strict block never shortens a longer Strict session');
ROLLBACK;
\echo ok - a Strict block keeps a longer Strict session

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET timezone = 'UTC' WHERE id = test.uid(1);
INSERT INTO schedules (user_id, profile_id, day_of_week, start_min, end_min, mode)
  SELECT test.uid(1), id, EXTRACT(ISODOW FROM now() AT TIME ZONE 'UTC')::INT - 1, 0, 1440, 'strict' FROM profiles WHERE user_id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.check(apply_schedule(test.uid(1)) ->> 'reason' = 'free', 'free accounts ignore the schedule');
SELECT test.check((SELECT session_until FROM user_settings WHERE id = test.uid(1)) IS NULL, 'no session for a free account');
ROLLBACK;
\echo ok - the schedule stays dormant on a free account
