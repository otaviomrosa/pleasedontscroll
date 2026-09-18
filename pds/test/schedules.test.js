// test/schedules.test.js — verifies the shape of REST calls /core/sync/schedules
// sends to Supabase, plus supabaseFetchDetailed's error surfacing, using a
// mocked global.fetch (same technique as sync.test.js). The class of bug
// worth catching here: an insert silently missing user_id/profile_id that
// only fails against the real NOT NULL constraint, and a trigger's RAISE
// message getting lost on the way to the UI.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseFetchDetailed } from '../core/sync/restClient.js';
import {
  fetchSchedules, createScheduleBlock, updateScheduleBlock, deleteScheduleBlock, applySchedule,
} from '../core/sync/schedules.js';
import { setTimezoneIfUnset } from '../core/sync/userSettings.js';

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

test('fetchSchedules reads every column the grid and the worker need, ordered by day then start', async () => {
  const calls = mockFetch([{ id: 's1' }]);
  const rows = await fetchSchedules('token-abc');
  assert.equal(rows.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/schedules\?select=id,profile_id,day_of_week,start_min,end_min,mode,version&order=day_of_week\.asc,start_min\.asc$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-abc');
});

test('fetchSchedules returns null, not [], on a failed request', async () => {
  mockFetch(undefined, { ok: false, status: 500 });
  assert.equal(await fetchSchedules('t'), null);
});

test('createScheduleBlock sends every NOT NULL column with the server-side names', async () => {
  const calls = mockFetch([{ id: 's1', version: 1 }]);
  const { row, error } = await createScheduleBlock('t', {
    userId: 'u1', profileId: 'p1', dayOfWeek: 2, startMin: 540, endMin: 660, mode: 'strict',
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /\/rest\/v1\/schedules$/);
  assert.deepEqual(body, { user_id: 'u1', profile_id: 'p1', day_of_week: 2, start_min: 540, end_min: 660, mode: 'strict' });
  assert.equal(row.id, 's1');
  assert.equal(error, null);
});

test('a trigger rejection reaches the caller as the server message, with no row', async () => {
  mockFetch({ message: 'That time overlaps another block.' }, { ok: false, status: 400 });
  const { row, error } = await createScheduleBlock('t', {
    userId: 'u1', profileId: 'p1', dayOfWeek: 2, startMin: 540, endMin: 660, mode: 'friction',
  });
  assert.equal(row, null);
  assert.equal(error, 'That time overlaps another block.');
});

test('updateScheduleBlock PATCHes only the given fields to the one row', async () => {
  const calls = mockFetch([{ id: 's1', start_min: 600, version: 2 }]);
  const { row } = await updateScheduleBlock('t', 's1', { start_min: 600 });
  assert.equal(calls[0].options.method, 'PATCH');
  assert.match(calls[0].url, /\/rest\/v1\/schedules\?id=eq\.s1$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { start_min: 600 });
  assert.equal(row.version, 2);
});

test('deleteScheduleBlock resolves ok on 2xx and surfaces the guard message otherwise', async () => {
  const calls = mockFetch([]);
  assert.deepEqual(await deleteScheduleBlock('t', 's1'), { ok: true, error: null });
  assert.equal(calls[0].options.method, 'DELETE');
  assert.match(calls[0].url, /\/rest\/v1\/schedules\?id=eq\.s1$/);

  mockFetch({ message: 'This block is active right now and cannot be changed.' }, { ok: false, status: 400 });
  const res = await deleteScheduleBlock('t', 's1');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'This block is active right now and cannot be changed.');
});

test('applySchedule calls the RPC with the user id and returns its JSON', async () => {
  const calls = mockFetch({ applied: true, mode: 'strict' });
  const res = await applySchedule('t', 'u1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/apply_schedule$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_user_id: 'u1' });
  assert.equal(res.mode, 'strict');
});

test('setTimezoneIfUnset only writes rows whose timezone is still null', async () => {
  const calls = mockFetch([]);
  assert.equal(await setTimezoneIfUnset('t', 'u1', 'America/Sao_Paulo'), true);
  assert.equal(calls[0].options.method, 'PATCH');
  assert.match(calls[0].url, /\/rest\/v1\/user_settings\?id=eq\.u1&timezone=is\.null$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { timezone: 'America/Sao_Paulo' });
});

test('supabaseFetchDetailed: message on error, data on success, empty body is null data', async () => {
  mockFetch({ message: 'nope' }, { ok: false, status: 400 });
  assert.deepEqual(await supabaseFetchDetailed('/x', 't'), { data: null, error: 'nope' });

  mockFetch(undefined, { ok: false, status: 502 });
  const r = await supabaseFetchDetailed('/x', 't');
  assert.equal(r.data, null);
  assert.match(r.error, /502/);

  mockFetch(undefined);
  assert.deepEqual(await supabaseFetchDetailed('/x', 't', { method: 'DELETE' }), { data: null, error: null });
});
