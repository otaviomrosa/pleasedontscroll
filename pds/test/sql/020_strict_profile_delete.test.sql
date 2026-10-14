-- 020_strict_profile_delete.sql: in Strict Mode a non-active profile can
-- be deleted along with its sites, and nothing else got looser.

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true WHERE id = test.uid(1);
INSERT INTO profiles (user_id, name, is_active) VALUES (test.uid(1), 'Spare', false);
INSERT INTO blocked_urls (user_id, profile_id, url)
  SELECT test.uid(1), id, 'reddit.com' FROM profiles WHERE user_id = test.uid(1) AND name = 'Spare';
INSERT INTO blocked_urls (user_id, profile_id, url)
  SELECT test.uid(1), id, 'instagram.com' FROM profiles WHERE user_id = test.uid(1) AND is_active;
UPDATE user_settings SET blocking_mode = 'strict', session_until = now() + interval '1 hour' WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));

-- A direct removal is still refused, on the spare profile as on the active one.
SELECT test.expect_error($$ DELETE FROM blocked_urls WHERE url = 'reddit.com' $$, 'Strict Mode');
SELECT test.expect_error($$ DELETE FROM blocked_urls WHERE url = 'instagram.com' $$, 'Strict Mode');
-- The active profile still can't be deleted.
SELECT test.expect_error($$ DELETE FROM profiles WHERE is_active $$, 'active profile');
-- The spare one can, and its site goes with it.
SELECT test.check(test.expect_ok($$ DELETE FROM profiles WHERE name = 'Spare' $$) = 1, 'spare profile deleted in Strict');
SELECT test.act_as('postgres');
SELECT test.check((SELECT count(*) FROM blocked_urls WHERE url = 'reddit.com') = 0, 'its site cascaded away');
SELECT test.check((SELECT count(*) FROM blocked_urls WHERE url = 'instagram.com') = 1, 'the active profile kept its site');
ROLLBACK;
\echo ok - Strict Mode allows deleting a non-active profile, and only that
