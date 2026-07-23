// test/hostname.test.js — pure logic, no mocking needed.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToHostname, isNavigableUrl, hostnameOf, isValidBlocklistUrl } from '../core/blocklist/hostname.js';

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
