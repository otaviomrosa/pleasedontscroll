// test/sync.test.js — verifies the shape of REST calls /core/sync sends to
// Supabase, using a mocked global.fetch (no network, no live project needed).
// This is the class of bug worth catching automatically: a request silently
// missing a required field (e.g. user_id) that only fails once it hits a
// real NOT NULL constraint — see createProfile's history for a real example.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseFetch } from '../core/sync/restClient.js';
import { fetchProfiles, fetchActiveProfile, createProfile, switchProfile, deleteProfile } from '../core/sync/profiles.js';
import { addBlockedUrl, removeBlockedUrl, fetchBlockedUrls } from '../core/sync/blockedUrls.js';

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

test('supabaseFetch', async (t) => {
  await t.test('sends apikey + Authorization headers and parses JSON', async () => {
    const calls = mockFetch([{ id: '1' }]);
    const result = await supabaseFetch('/rest/v1/profiles', 'token-abc');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer token-abc');
    assert.ok(calls[0].options.headers.apikey);
    assert.deepEqual(result, [{ id: '1' }]);
  });

  await t.test('returns null on a non-ok response instead of throwing', async () => {
    mockFetch({ error: 'nope' }, { ok: false, status: 400 });
    const result = await supabaseFetch('/rest/v1/profiles', 'token-abc');
    assert.equal(result, null);
  });
});

test('fetchProfiles requests the right columns and order', async () => {
  const calls = mockFetch([]);
  await fetchProfiles('token');
  assert.match(calls[0].url, /\/rest\/v1\/profiles\?select=id,name,is_active&order=created_at\.asc/);
});

test('createProfile includes user_id in the insert body', async () => {
  // Regression check: an earlier version of this logic (the extension popup's
  // hand-rolled version, before it was consolidated into /core) omitted
  // user_id on insert, which silently failed against the NOT NULL constraint.
  const calls = mockFetch([{ id: 'p1', name: 'Deep Work', is_active: false }]);
  await createProfile('token', 'user-123', 'Deep Work');

  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.user_id, 'user-123');
  assert.equal(body.name, 'Deep Work');
  assert.equal(body.is_active, false);
});

test('switchProfile calls the switch_active_profile RPC once, not two PATCHes', async () => {
  // As of 010_atomic_profile_switch.sql, this is a single RPC call instead
  // of two separate PATCHes — see that migration and switchProfile()'s own
  // comment for why (a client interruption between two PATCHes could leave
  // a user with zero active profiles). The RPC returns a real `true`, not
  // an empty body — mocking an empty/false body here would make this fail,
  // which is the correct behavior, not a test bug: supabaseFetch() can't
  // tell "succeeded with an empty body" apart from "failed", so the SQL
  // function deliberately returns a real boolean instead of VOID.
  const calls = mockFetch(true);
  const ok = await switchProfile('token', 'user-123', 'profile-456');

  assert.equal(ok, true);
  assert.equal(calls.length, 1);

  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/switch_active_profile$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_user_id: 'user-123',
    p_profile_id: 'profile-456',
  });
});

test('deleteProfile sends a DELETE to the right row', async () => {
  const calls = mockFetch([]);
  const ok = await deleteProfile('token', 'profile-456');

  assert.equal(ok, true);
  assert.equal(calls[0].options.method, 'DELETE');
  assert.match(calls[0].url, /profiles\?id=eq\.profile-456/);
});

test('addBlockedUrl includes both profile_id and user_id', async () => {
  const calls = mockFetch([{ id: 'b1', url: 'instagram.com' }]);
  await addBlockedUrl('token', { profileId: 'p1', userId: 'u1', url: 'instagram.com' });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.profile_id, 'p1');
  assert.equal(body.user_id, 'u1');
  assert.equal(body.url, 'instagram.com');
});

test('removeBlockedUrl targets blocked_urls by id', async () => {
  const calls = mockFetch([]);
  await removeBlockedUrl('token', 'url-1');
  assert.match(calls[0].url, /blocked_urls\?id=eq\.url-1/);
  assert.equal(calls[0].options.method, 'DELETE');
});

test('fetchBlockedUrls returns null (not []) on a failed fetch', async () => {
  // Distinguishing null from [] matters: background.js uses this to keep a
  // stale blocklist on a network blip instead of unblocking everything.
  mockFetch(undefined, { ok: false, status: 500 });
  const result = await fetchBlockedUrls('token', 'profile-1');
  assert.equal(result, null);
});

test('fetchActiveProfile', async (t) => {
  await t.test('returns the active profile', async () => {
    mockFetch([{ id: 'p1', name: 'Deep Work' }]);
    assert.deepEqual(await fetchActiveProfile('token'), { id: 'p1', name: 'Deep Work' });
  });

  await t.test('returns null when no profile is active', async () => {
    mockFetch([]);
    assert.equal(await fetchActiveProfile('token'), null);
  });

  await t.test('throws on a failed request, so it is never read as "no active profile"', async () => {
    mockFetch({ message: 'upstream timeout' }, { ok: false, status: 504 });
    await assert.rejects(fetchActiveProfile('token'), /Could not load the active profile/);
  });
});
