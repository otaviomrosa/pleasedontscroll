-- 019_profile_cap.sql: at most 100 profiles for anyone, still one for free.

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true WHERE id = test.uid(1);
-- The default profile plus 98 more = 99 rows.
INSERT INTO profiles (user_id, name, is_active)
  SELECT test.uid(1), 'P' || g, false FROM generate_series(1, 98) g;
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.check(test.expect_ok($$ INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Hundredth', false) $$) = 1, '100th profile allowed');
SELECT test.expect_error($$ INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'One too many', false) $$, 'up to 100 profiles');
SELECT test.act_as('service_role');
SELECT test.expect_error($$ INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Service', false) $$, 'up to 100 profiles');
ROLLBACK;
\echo ok - Focus Pro accounts stop at 100 profiles, service role included

BEGIN;
SELECT test.signup(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_error($$ INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Second', false) $$, 'require Focus Pro');
ROLLBACK;
\echo ok - free accounts still keep exactly one profile

BEGIN;
SELECT test.signup(1);
SELECT test.signup(2);
SELECT test.check((SELECT count(*) FROM profiles) = 2, 'signup still creates the first profile');
ROLLBACK;
\echo ok - signup is unaffected
