// test/userSettings.test.js — verifies the shape of REST calls
// /core/sync/userSettings.js sends to Supabase, using a mocked
// global.fetch (no network, no live project needed). Same technique as
// sync.test.js. This module backs the pause-blocking feature, which had
// zero test coverage despite going through several real bugs during
// development (see isIndefinitePause's tests below for the concrete one) —
// this file exists to close that gap, not because anything here is
// currently broken.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchIsPremium,
  fetchSettingsSnapshot,
  fetchBlockingMode,
  setBlockingMode,
  fetchPauseUntil,
  setPauseUntil,
  isIndefinitePause,
  INDEFINITE_PAUSE_ISO,
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

test('setBlockingMode', async (t) => {
  await t.test('PATCHes the right row with the requested mode', async () => {
    const calls = mockFetch([{ blocking_mode: 'strict' }]);
    const ok = await setBlockingMode('token', 'user-123', 'strict');

    assert.equal(ok, true);
    assert.equal(calls[0].options.method, 'PATCH');
    assert.match(calls[0].url, /user_settings\?id=eq\.user-123/);
    assert.deepEqual(JSON.parse(calls[0].options.body), { blocking_mode: 'strict' });
  });

  await t.test('normalizes anything other than "strict" to "friction"', async () => {
    // Guards against a typo'd/garbage mode value ever getting written
    // verbatim instead of falling back to the safe default.
    const calls = mockFetch([{ blocking_mode: 'friction' }]);
    await setBlockingMode('token', 'user-123', 'not-a-real-mode');
    assert.deepEqual(JSON.parse(calls[0].options.body), { blocking_mode: 'friction' });
  });
});

test('fetchPauseUntil', async (t) => {
  await t.test('requests the right column', async () => {
    const calls = mockFetch([{ paused_until: '2026-08-01T00:00:00.000Z' }]);
    await fetchPauseUntil('token', 'user-123');
    assert.match(calls[0].url, /\/rest\/v1\/user_settings\?id=eq\.user-123&select=paused_until/);
  });

  await t.test('returns the raw value, expired or not — callers check freshness themselves', async () => {
    mockFetch([{ paused_until: '2020-01-01T00:00:00.000Z' }]);
    assert.equal(await fetchPauseUntil('token', 'user-123'), '2020-01-01T00:00:00.000Z');
  });

  await t.test('returns null when there is no pause set', async () => {
    mockFetch([{ paused_until: null }]);
    assert.equal(await fetchPauseUntil('token', 'user-123'), null);
  });
});

test('setPauseUntil', async (t) => {
  await t.test('PATCHes the right row with the given timestamp', async () => {
    const calls = mockFetch([{ paused_until: '2026-08-01T00:00:00.000Z' }]);
    const ok = await setPauseUntil('token', 'user-123', '2026-08-01T00:00:00.000Z');

    assert.equal(ok, true);
    assert.equal(calls[0].options.method, 'PATCH');
    assert.match(calls[0].url, /user_settings\?id=eq\.user-123/);
    assert.deepEqual(JSON.parse(calls[0].options.body), { paused_until: '2026-08-01T00:00:00.000Z' });
  });

  await t.test('passing null clears the pause — the key must survive JSON.stringify, not be dropped', async () => {
    const calls = mockFetch([{ paused_until: null }]);
    await setPauseUntil('token', 'user-123', null);
    assert.deepEqual(JSON.parse(calls[0].options.body), { paused_until: null });
  });
});

test('INDEFINITE_PAUSE_ISO', () => {
  assert.equal(INDEFINITE_PAUSE_ISO, '9999-12-31T23:59:59.000Z');
});

test('isIndefinitePause', async (t) => {
  await t.test('true for the exact sentinel', () => {
    assert.equal(isIndefinitePause(INDEFINITE_PAUSE_ISO), true);
  });

  await t.test('true for a Postgres-reformatted round-trip of the same instant', () => {
    // This is the actual bug that shipped once: Postgres/PostgREST doesn't
    // guarantee returning the exact string that was written (+00:00 vs Z,
    // different sub-second precision). A strict === INDEFINITE_PAUSE_ISO
    // check silently failed on exactly this input and rendered a real
    // (if absurd) year-9999 clock time instead of "Paused indefinitely."
    assert.equal(isIndefinitePause('9999-12-31T23:59:59+00:00'), true);
  });

  await t.test('true for an epoch-ms number, not just an ISO string', () => {
    // background.js's GET_STATE hands back epoch ms, not an ISO string —
    // isIndefinitePause() has to work with both.
    const farFutureMs = new Date('9999-06-15T00:00:00.000Z').getTime();
    assert.equal(isIndefinitePause(farFutureMs), true);
  });

  await t.test('false for a real, near-future pause', () => {
    assert.equal(isIndefinitePause('2026-08-01T00:00:00.000Z'), false);
  });

  await t.test('false for null/undefined/empty', () => {
    assert.equal(isIndefinitePause(null), false);
    assert.equal(isIndefinitePause(undefined), false);
    assert.equal(isIndefinitePause(''), false);
  });
});

test('fetchSettingsSnapshot', async (t) => {
  await t.test('reads the three columns in one request', async () => {
    const calls = mockFetch([{ is_premium: true, blocking_mode: 'strict', paused_until: null }]);
    assert.deepEqual(await fetchSettingsSnapshot('token', 'user-123'), {
      isPremium: true, blockingMode: 'strict', pausedUntil: null,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /user_settings\?id=eq\.user-123&select=is_premium,blocking_mode,paused_until/);
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
