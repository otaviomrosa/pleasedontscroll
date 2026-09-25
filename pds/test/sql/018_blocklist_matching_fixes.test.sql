-- 018_blocklist_matching_fixes.sql: the SQL rules agree with
-- core/blocklist/hostname.js on trailing dots and path segments, and the
-- triggers built on them behave accordingly.

BEGIN;
SELECT test.check(blocklist_url_hostname('instagram.com.') = 'instagram.com', 'root dot dropped');
SELECT test.check(blocklist_url_hostname('https://www.instagram.com./reels') = 'instagram.com', 'root dot with www and path');
SELECT test.check(blocklist_url_hostname('youtube.com/shorts') = 'youtube.com', 'plain entry unchanged');
SELECT test.check(blocklist_entry_covers('instagram.com', 'instagram.com.'), 'dotted duplicate is covered');
SELECT test.check(blocklist_entry_covers('youtube.com/shorts', 'youtube.com/shorts'), 'same path covers');
SELECT test.check(blocklist_entry_covers('youtube.com/shorts', 'm.youtube.com/shorts/abc'), 'deeper path covers');
SELECT test.check(NOT blocklist_entry_covers('youtube.com/shorts', 'youtube.com/shortsxyz'), 'longer segment is not covered');
SELECT test.check(NOT blocklist_entry_covers('reddit.com/r/news', 'reddit.com/r/newsokur'), 'r/newsokur is not covered');
SELECT test.check(blocklist_entry_covers('reddit.com', 'reddit.com/r/news'), 'whole domain covers any path');
SELECT test.check(NOT blocklist_entry_covers('reddit.com/r/news', 'reddit.com'), 'path does not cover whole domain');
ROLLBACK;
\echo ok - hostname and coverage helpers match the JavaScript rules

BEGIN;
SELECT test.signup(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com/r/news' FROM profiles $$);
-- Not redundant any more: a different subreddit that shares the prefix.
SELECT test.check(test.expect_ok($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com/r/newsokur' FROM profiles $$) = 1, 'r/newsokur can be added');
-- Still redundant: under an existing entry.
SELECT test.expect_error($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com/r/news/top' FROM profiles $$, 'already covered');
SELECT test.expect_ok($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'instagram.com' FROM profiles $$);
SELECT test.expect_error($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'instagram.com.' FROM profiles $$, 'already covered');
ROLLBACK;
\echo ok - the redundancy guard follows the new rules

BEGIN;
SELECT test.signup(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_error($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'pleasedontscroll.com' FROM profiles $$, 'lock you out');
SELECT test.expect_error($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'pleasedontscroll.com.' FROM profiles $$, 'lock you out');
SELECT test.expect_error($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'https://WWW.PleaseDontScroll.com./dashboard' FROM profiles $$, 'lock you out');
SELECT test.expect_error($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'app.pleasedontscroll.com' FROM profiles $$, 'lock you out');
SELECT test.check(test.expect_ok($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'notpleasedontscroll.com' FROM profiles $$) = 1, 'lookalike domain allowed');
ROLLBACK;
\echo ok - the own-domain guard catches the trailing-dot form

BEGIN;
SELECT test.signup(1);
UPDATE user_settings SET is_premium = true WHERE id = test.uid(1);
INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com/r/newsokur' FROM profiles;
INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com/r/news/top' FROM profiles;
UPDATE user_settings SET blocking_mode = 'strict' WHERE id = test.uid(1);
SELECT test.act_as('authenticated', test.uid(1));
SELECT test.expect_ok($$ INSERT INTO blocked_urls (user_id, profile_id, url) SELECT test.uid(1), id, 'reddit.com/r/news' FROM profiles $$);
-- Strict: removing a row a broader one covers is cleanup, anything else is refused.
SELECT test.check(test.expect_ok($$ DELETE FROM blocked_urls WHERE url = 'reddit.com/r/news/top' $$) = 1, 'covered row removable in Strict');
SELECT test.expect_error($$ DELETE FROM blocked_urls WHERE url = 'reddit.com/r/newsokur' $$, 'Strict Mode');
ROLLBACK;
\echo ok - Strict removal exception uses whole-segment coverage
