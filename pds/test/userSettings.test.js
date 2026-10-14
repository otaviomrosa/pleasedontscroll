// test/userSettings.test.js — verifies the shape of REST calls
// /core/sync/userSettings.js sends to Supabase, using a mocked
// global.fetch (no network, no live project needed). Same technique as
// sync.test.js.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchIsPremium,
  fetchSettingsSnapshot,
  fetchBlockingMode,
} from '../core/sync/userSettings.js';

/**
 * Replaces globalThis.fetch with a stub that records every call and returns
 * a canned response. Pass `undefined` as the body to simulate a 204 empty
 * response (what Supabase actually returns for PATCH/DELETE).
 */
function mockFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
  };
  return calls;
}

test('fetchIsPremium', async (t) => {
  await t.test('requests the right column', async () => {
    const calls = mockFetch([{ is_premium: true }]);
    await fetchIsPremium('token', 'user-123');
    assert.match(calls[0].url, /\/rest\/v1\/user_settings\?id=eq\.user-123&select=is_premium/);
  });

  await t.test('returns true only for an explicit true, not any truthy value', async () => {
    mockFetch([{ is_premium: true }]);
    assert.equal(await fetchIsPremium('token', 'user-123'), true);
  });

  await t.test('returns false when the row is missing or is_premium is false', async () => {
    mockFetch([]);
    assert.equal(await fetchIsPremium('token', 'user-123'), false);
  });
});

test('fetchBlockingMode', async (t) => {
  await t.test('requests the right column', async () => {
    const calls = mockFetch([{ blocking_mode: 'strict' }]);
    await fetchBlockingMode('token', 'user-123');
    assert.match(calls[0].url, /\/rest\/v1\/user_settings\?id=eq\.user-123&select=blocking_mode/);
  });

  await t.test('returns strict only for an exact match', async () => {
    mockFetch([{ blocking_mode: 'strict' }]);
    assert.equal(await fetchBlockingMode('token', 'user-123'), 'strict');
  });

  await t.test('defaults to friction for anything else, including a missing row', async () => {
    mockFetch([]);
    assert.equal(await fetchBlockingMode('token', 'user-123'), 'friction');
  });
});

test('fetchSettingsSnapshot', async (t) => {
  await t.test('reads the three columns in one request', async () => {
    const calls = mockFetch([{ is_premium: true, blocking_mode: 'strict', session_until: '2026-10-14T12:00:00+00:00' }]);
    assert.deepEqual(await fetchSettingsSnapshot('token', 'user-123'), {
      isPremium: true, blockingMode: 'strict', sessionUntil: '2026-10-14T12:00:00+00:00',
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /user_settings\?id=eq\.user-123&select=is_premium,blocking_mode,session_until/);
  });

  await t.test('returns null on a failed request instead of defaulting to free/Friction', async () => {
    mockFetch({ message: 'boom' }, { ok: false, status: 503 });
    assert.equal(await fetchSettingsSnapshot('token', 'user-123'), null);
  });

  await t.test('returns null when the row is missing', async () => {
    mockFetch([]);
    assert.equal(await fetchSettingsSnapshot('token', 'user-123'), null);
  });
});
