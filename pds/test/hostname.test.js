// test/hostname.test.js — pure logic, no mocking needed.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToHostname, isNavigableUrl, hostnameOf, pathnameOf, isValidBlocklistUrl, isOwnDomain, parseBlocklistEntry, matchesBlockedEntry } from '../core/blocklist/hostname.js';

test('normalizeToHostname', async (t) => {
  await t.test('bare domain', () => {
    assert.equal(normalizeToHostname('instagram.com'), 'instagram.com');
  });

  await t.test('strips www.', () => {
    assert.equal(normalizeToHostname('www.instagram.com'), 'instagram.com');
  });

  await t.test('full URL with path', () => {
    assert.equal(normalizeToHostname('https://reddit.com/r/all'), 'reddit.com');
  });

  await t.test('full URL with www and path', () => {
    assert.equal(normalizeToHostname('https://www.twitter.com/home'), 'twitter.com');
  });

  await t.test('http (not https)', () => {
    assert.equal(normalizeToHostname('http://example.com'), 'example.com');
  });

  await t.test('garbage input falls back to trimmed lowercase', () => {
    assert.equal(normalizeToHostname('  Not A URL  '), 'not a url');
  });

  await t.test('empty string does not throw', () => {
    assert.equal(normalizeToHostname(''), '');
  });
});

test('isNavigableUrl', async (t) => {
  await t.test('normal https URL is navigable', () => {
    assert.equal(isNavigableUrl('https://instagram.com'), true);
  });

  await t.test('empty/undefined is not navigable', () => {
    assert.equal(isNavigableUrl(''), false);
    assert.equal(isNavigableUrl(undefined), false);
  });

  await t.test('chrome-extension:// is not navigable', () => {
    assert.equal(isNavigableUrl('chrome-extension://abc123/blocked.html'), false);
  });

  await t.test('chrome:// is not navigable', () => {
    assert.equal(isNavigableUrl('chrome://extensions'), false);
  });

  await t.test('about: is not navigable', () => {
    assert.equal(isNavigableUrl('about:blank'), false);
  });

  await t.test('file: is not navigable', () => {
    assert.equal(isNavigableUrl('file:///Users/x/index.html'), false);
  });
});

test('hostnameOf', async (t) => {
  await t.test('extracts hostname from a full URL', () => {
    assert.equal(hostnameOf('https://instagram.com/p/123'), 'instagram.com');
  });

  await t.test('strips www.', () => {
    assert.equal(hostnameOf('https://www.instagram.com/p/123'), 'instagram.com');
  });

  await t.test('returns null for unparseable input', () => {
    assert.equal(hostnameOf('not a url'), null);
  });

  await t.test('returns null for empty string', () => {
    assert.equal(hostnameOf(''), null);
  });
});

test('pathnameOf', async (t) => {
  await t.test('bare domain returns /', () => {
    assert.equal(pathnameOf('https://youtube.com'), '/');
  });

  await t.test('domain with path returns the path', () => {
    assert.equal(pathnameOf('https://youtube.com/shorts/abc123'), '/shorts/abc123');
  });

  await t.test('returns null for unparseable input', () => {
    assert.equal(pathnameOf('not a url'), null);
  });
});

test('parseBlocklistEntry', async (t) => {
  await t.test('bare hostname has null pathPrefix', () => {
    assert.deepEqual(parseBlocklistEntry('youtube.com'), { hostname: 'youtube.com', pathPrefix: null });
  });

  await t.test('strips www. from hostname, same as normalizeToHostname', () => {
    assert.deepEqual(parseBlocklistEntry('www.youtube.com'), { hostname: 'youtube.com', pathPrefix: null });
  });

  await t.test('path is captured as pathPrefix', () => {
    assert.deepEqual(parseBlocklistEntry('youtube.com/shorts'), { hostname: 'youtube.com', pathPrefix: '/shorts' });
  });

  await t.test('trailing slash is stripped from pathPrefix', () => {
    assert.deepEqual(parseBlocklistEntry('facebook.com/marketplace/'), { hostname: 'facebook.com', pathPrefix: '/marketplace' });
  });

  await t.test('bare "/" is treated as no path', () => {
    assert.deepEqual(parseBlocklistEntry('youtube.com/'), { hostname: 'youtube.com', pathPrefix: null });
  });

  await t.test('pathPrefix is lowercased', () => {
    assert.deepEqual(parseBlocklistEntry('youtube.com/SHORTS'), { hostname: 'youtube.com', pathPrefix: '/shorts' });
  });
});

test('matchesBlockedEntry', async (t) => {
  await t.test('whole-domain entry matches any path under that hostname', () => {
    const entry = { hostname: 'youtube.com', pathPrefix: null };
    assert.equal(matchesBlockedEntry('https://youtube.com', entry), true);
    assert.equal(matchesBlockedEntry('https://youtube.com/shorts/abc', entry), true);
    assert.equal(matchesBlockedEntry('https://youtube.com/watch?v=1', entry), true);
  });

  await t.test('path-scoped entry matches only that prefix and deeper', () => {
    const entry = { hostname: 'youtube.com', pathPrefix: '/shorts' };
    assert.equal(matchesBlockedEntry('https://youtube.com/shorts', entry), true);
    assert.equal(matchesBlockedEntry('https://youtube.com/shorts/abc123', entry), true);
  });

  await t.test('path-scoped entry does not match the bare domain or a different path', () => {
    const entry = { hostname: 'youtube.com', pathPrefix: '/shorts' };
    assert.equal(matchesBlockedEntry('https://youtube.com', entry), false);
    assert.equal(matchesBlockedEntry('https://youtube.com/watch?v=1', entry), false);
  });

  await t.test('mismatched hostname never matches, regardless of path', () => {
    const entry = { hostname: 'youtube.com', pathPrefix: null };
    assert.equal(matchesBlockedEntry('https://vimeo.com/shorts', entry), false);
  });

  await t.test('case-insensitive on path', () => {
    const entry = { hostname: 'youtube.com', pathPrefix: '/shorts' };
    assert.equal(matchesBlockedEntry('https://youtube.com/SHORTS', entry), true);
  });

  await t.test('returns false for an unparseable url', () => {
    const entry = { hostname: 'youtube.com', pathPrefix: null };
    assert.equal(matchesBlockedEntry('not a url', entry), false);
  });
});

test('isValidBlocklistUrl', async (t) => {
  await t.test('bare domain is valid', () => {
    assert.equal(isValidBlocklistUrl('instagram.com'), true);
  });

  await t.test('full URL with path is valid', () => {
    assert.equal(isValidBlocklistUrl('https://www.reddit.com/r/all'), true);
  });

  await t.test('subdomain is valid', () => {
    assert.equal(isValidBlocklistUrl('mail.google.com'), true);
  });

  await t.test('garbage text is rejected', () => {
    assert.equal(isValidBlocklistUrl('hello world'), false);
  });

  await t.test('single word with no TLD is rejected', () => {
    assert.equal(isValidBlocklistUrl('localhost'), false);
  });

  await t.test('empty/whitespace-only is rejected', () => {
    assert.equal(isValidBlocklistUrl(''), false);
    assert.equal(isValidBlocklistUrl('   '), false);
  });

  await t.test('non-string input is rejected', () => {
    assert.equal(isValidBlocklistUrl(undefined), false);
    assert.equal(isValidBlocklistUrl(null), false);
  });
});

test('isOwnDomain', async (t) => {
  await t.test('bare domain matches', () => {
    assert.equal(isOwnDomain('pleasedontscroll.com'), true);
  });

  await t.test('www. matches', () => {
    assert.equal(isOwnDomain('www.pleasedontscroll.com'), true);
  });

  await t.test('full URL with path matches', () => {
    assert.equal(isOwnDomain('https://pleasedontscroll.com/dashboard'), true);
  });

  await t.test('other subdomain matches', () => {
    assert.equal(isOwnDomain('app.pleasedontscroll.com'), true);
  });

  await t.test('unrelated site does not match', () => {
    assert.equal(isOwnDomain('instagram.com'), false);
  });

  await t.test('lookalike domain does not match', () => {
    assert.equal(isOwnDomain('pleasedontscroll.com.evil.com'), false);
    assert.equal(isOwnDomain('notpleasedontscroll.com'), false);
  });
});
