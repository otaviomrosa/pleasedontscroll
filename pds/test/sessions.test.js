import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSession, endSession, SESSION_MINUTES } from '../core/sync/sessions.js';
import { sessionRemainingMs, isSessionLive, formatCountdown, formatMinutesLabel } from '../core/session/time.js';

function mockFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  return calls;
}

test('startSession', async (t) => {
  await t.test('calls the start_session RPC with every argument', async () => {
    const calls = mockFetch({ profile_id: 'p1', mode: 'strict', session_until: '2026-10-14T12:00:00+00:00' });
    const { state, error } = await startSession('token', 'u1', { profileId: 'p1', mode: 'strict', minutes: 60 });
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/start_session$/);
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_user_id: 'u1', p_profile_id: 'p1', p_mode: 'strict', p_minutes: 60 });
    assert.equal(state.mode, 'strict');
    assert.equal(error, null);
  });

  await t.test('normalizes any other mode to friction', async () => {
    const calls = mockFetch({});
    await startSession('token', 'u1', { profileId: 'p1', mode: 'calm', minutes: 15 });
    assert.equal(JSON.parse(calls[0].options.body).p_mode, 'friction');
  });

  await t.test('surfaces the server refusal text', async () => {
    mockFetch({ message: 'Strict Mode requires Focus Pro.' }, { ok: false, status: 400 });
    const { state, error } = await startSession('token', 'u1', { profileId: 'p1', mode: 'strict', minutes: 15 });
    assert.equal(state, null);
    assert.equal(error, 'Strict Mode requires Focus Pro.');
  });
});

test('endSession', async (t) => {
  await t.test('calls the end_session RPC', async () => {
    const calls = mockFetch({ session_until: null });
    const { error } = await endSession('token', 'u1');
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/end_session$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_user_id: 'u1' });
    assert.equal(error, null);
  });

  await t.test('returns the Strict refusal verbatim', async () => {
    mockFetch({ message: 'Strict Mode is on until 4:30 PM.' }, { ok: false, status: 400 });
    assert.equal((await endSession('token', 'u1')).error, 'Strict Mode is on until 4:30 PM.');
  });
});

test('SESSION_MINUTES are the five presets', () => {
  assert.deepEqual(SESSION_MINUTES, [15, 30, 60, 120, 360]);
});

test('session time helpers', async (t) => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);

  await t.test('remaining time from an ISO string, epoch ms, or nothing', () => {
    assert.equal(sessionRemainingMs('2026-10-14T12:30:00Z', now), 30 * 60 * 1000);
    assert.equal(sessionRemainingMs(now + 5000, now), 5000);
    assert.equal(sessionRemainingMs(null, now), 0);
    assert.equal(sessionRemainingMs('not a date', now), 0);
  });

  await t.test('an ended session is not live', () => {
    assert.equal(isSessionLive(now - 1, now), false);
    assert.equal(isSessionLive(now + 1, now), true);
  });

  await t.test('countdown formats minutes and hours', () => {
    assert.equal(formatCountdown(25 * 60 * 1000), '25:00');
    assert.equal(formatCountdown(61 * 1000), '01:01');
    assert.equal(formatCountdown((2 * 3600 + 5) * 1000), '2:00:05');
    assert.equal(formatCountdown(400), '00:01');
    assert.equal(formatCountdown(-5), '00:00');
  });

  await t.test('preset labels', () => {
    assert.deepEqual([15, 30, 60, 120, 360].map(formatMinutesLabel), ['15m', '30m', '1h', '2h', '6h']);
  });
});
