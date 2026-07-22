// test/sync.test.js — verifies the shape of REST calls /core/sync sends to
// Supabase, using a mocked global.fetch (no network, no live project needed).
// This is the class of bug worth catching automatically: a request silently
// missing a required field (e.g. user_id) that only fails once it hits a
// real NOT NULL constraint — see createProfile's history for a real example.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseFetch } from '../core/sync/restClient.js';
import { fetchProfiles, createProfile, switchProfile, deleteProfile } from '../core/sync/profiles.js';
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

test('switchProfile makes two PATCH calls: deactivate all, then activate one', async () => {
  // Supabase always sends back the affected rows here (supabaseFetch sets
  // `Prefer: return=representation` on every request), so a real successful
  // PATCH/DELETE body is "[]" or "[{...}]" — never truly empty. Mocking an
  // empty body (simulating a genuine 204) makes this fail, which is a real
  // finding, not a test bug: see the note on supabaseFetch's null-on-failure
  // contract below.
  const calls = mockFetch([]);
  const ok = await switchProfile('token', 'user-123', 'profile-456');

  assert.equal(ok, true);
  assert.equal(calls.length, 2);

  assert.equal(calls[0].options.method, 'PATCH');
  assert.match(calls[0].url, /user_id=eq\.user-123/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { is_active: false });

  assert.equal(calls[1].options.method, 'PATCH');
  assert.match(calls[1].url, /id=eq\.profile-456/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { is_active: true });
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
