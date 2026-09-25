// test/session.test.js — getValidAccessToken()'s refresh rules, with a
// mocked fetch and an in-memory storage adapter. The case that matters: a
// refresh that fails for a reason unrelated to the refresh token (offline,
// 429, 5xx) must keep the session, because clearing it stops all blocking
// in the extension (audit R3).
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getValidAccessToken, getStoredSession, persistSession } from '../core/auth/session.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) { return data[key] ?? null; },
    async set(key, value) { data[key] = value; },
    async remove(key) { delete data[key]; },
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

function expiredSession(refreshToken = 'refresh-1') {
  return { access_token: 'old-access', refresh_token: refreshToken, expires_at: nowSec() - 10, user: { id: 'u1' } };
}

/** Replaces fetch with a stub answering every call with `respond()`. */
function mockFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return respond();
  };
  return calls;
}

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('getValidAccessToken', async (t) => {
  await t.test('returns the stored token while it is fresh, without a request', async () => {
    const storage = memoryStorage();
    await persistSession(storage, { access_token: 'fresh', refresh_token: 'r', expires_at: nowSec() + 3600 });
    const calls = mockFetch(() => { throw new Error('should not fetch'); });
    assert.equal(await getValidAccessToken(storage), 'fresh');
    assert.equal(calls.length, 0);
  });

  await t.test('refreshes an expired token and persists the new session', async () => {
    const storage = memoryStorage();
    await persistSession(storage, expiredSession());
    mockFetch(() => jsonResponse(200, { access_token: 'new-access', refresh_token: 'refresh-2', expires_at: nowSec() + 3600 }));
    assert.equal(await getValidAccessToken(storage), 'new-access');
    assert.equal((await getStoredSession(storage)).refresh_token, 'refresh-2');
  });

  await t.test('keeps the session when offline', async () => {
    const storage = memoryStorage();
    await persistSession(storage, expiredSession());
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    assert.equal(await getValidAccessToken(storage), null);
    assert.ok(await getStoredSession(storage), 'session must survive a network error');
  });

  for (const status of [429, 500, 502, 503]) {
    await t.test(`keeps the session on a ${status}`, async () => {
      const storage = memoryStorage();
      await persistSession(storage, expiredSession());
      mockFetch(() => jsonResponse(status, { msg: 'try later' }));
      assert.equal(await getValidAccessToken(storage), null);
      assert.ok(await getStoredSession(storage));
    });
  }

  await t.test('keeps the session when a captive portal answers 200 with a web page', async () => {
    const storage = memoryStorage();
    await persistSession(storage, expiredSession());
    mockFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    assert.equal(await getValidAccessToken(storage), null);
    assert.ok(await getStoredSession(storage));
  });

  for (const status of [400, 401]) {
    await t.test(`clears the session when the refresh token is rejected (${status})`, async () => {
      const storage = memoryStorage();
      await persistSession(storage, expiredSession());
      mockFetch(() => jsonResponse(status, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }));
      assert.equal(await getValidAccessToken(storage), null);
      assert.equal(await getStoredSession(storage), null);
    });
  }

  await t.test('does not sign out when another context already spent the refresh token', async () => {
    const storage = memoryStorage();
    await persistSession(storage, expiredSession('refresh-1'));
    // The popup refreshed first and stored refresh-2; our request with
    // refresh-1 comes back "already used".
    mockFetch(() => {
      storage.data.pds_session = { access_token: 'popup-access', refresh_token: 'refresh-2', expires_at: nowSec() + 3600 };
      return jsonResponse(400, { error_code: 'refresh_token_already_used' });
    });
    assert.equal(await getValidAccessToken(storage), 'popup-access');
    assert.equal((await getStoredSession(storage)).refresh_token, 'refresh-2');
  });

  await t.test('parallel callers share one refresh request', async () => {
    const storage = memoryStorage();
    await persistSession(storage, expiredSession('refresh-shared'));
    const calls = mockFetch(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return jsonResponse(200, { access_token: 'shared-access', refresh_token: 'refresh-next', expires_at: nowSec() + 3600 });
    });
    const tokens = await Promise.all([getValidAccessToken(storage), getValidAccessToken(storage), getValidAccessToken(storage)]);
    assert.deepEqual(tokens, ['shared-access', 'shared-access', 'shared-access']);
    assert.equal(calls.length, 1);
  });
});
