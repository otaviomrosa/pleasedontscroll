// Queries against the `schedules` table (weekly scheduled blocking) and the
// apply_schedule() RPC that enforces it. See 016_schedules.sql for the
// server-side rules; this module is just the network calls.

import { supabaseFetch, supabaseFetchDetailed } from './restClient.js';

/**
 * Every schedule block for the signed-in user, ordered by day then start.
 * Returns null (not []) on a failed fetch, distinct from a genuinely empty
 * schedule, so the background worker can keep its cached copy instead of
 * treating a network blip as "no schedule" — which would silently drop a
 * boundary alarm, or worse, let a Strict block lapse.
 */
export async function fetchSchedules(accessToken) {
  return await supabaseFetch(
    '/rest/v1/schedules?select=id,profile_id,day_of_week,start_min,end_min,mode,version&order=day_of_week.asc,start_min.asc',
    accessToken,
  );
}

/**
 * Creates one block. Resolves to { row, error }: `row` is the inserted
 * schedule (with its server id and version) or null, `error` is the
 * server's message when a trigger rejected it ("That time overlaps another
 * block.") or null. Callers show `error` verbatim.
 * @param {{ userId: string, profileId: string, dayOfWeek: number, startMin: number, endMin: number, mode: 'friction'|'strict' }} params
 */
export async function createScheduleBlock(accessToken, { userId, profileId, dayOfWeek, startMin, endMin, mode }) {
  const { data, error } = await supabaseFetchDetailed('/rest/v1/schedules', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      profile_id: profileId,
      day_of_week: dayOfWeek,
      start_min: startMin,
      end_min: endMin,
      mode,
    }),
  });
  return { row: data?.[0] ?? null, error };
}

/**
 * Partially updates one block (any of profile_id, start_min, end_min,
 * mode). Resolves to { row, error } like createScheduleBlock; an active
 * Strict block is rejected server-side with its own message.
 */
export async function updateScheduleBlock(accessToken, id, patch) {
  const { data, error } = await supabaseFetchDetailed(
    `/rest/v1/schedules?id=eq.${encodeURIComponent(id)}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return { row: data?.[0] ?? null, error };
}

/** Resolves to { ok, error }; same active-Strict rejection as update. */
export async function deleteScheduleBlock(accessToken, id) {
  const { error } = await supabaseFetchDetailed(
    `/rest/v1/schedules?id=eq.${encodeURIComponent(id)}`,
    accessToken,
    { method: 'DELETE' },
  );
  return { ok: error === null, error };
}

/**
 * Runs the server-side schedule transition for this user (see
 * apply_schedule() in 016_schedules.sql): switches profile/mode into the
 * block that covers "now", or restores the pre-block state when one just
 * ended. Idempotent, so it's safe to call every minute. Resolves to the
 * RPC's JSON — which always includes the resulting profile_id, mode and
 * paused_until — or null on failure.
 */
export async function applySchedule(accessToken, userId) {
  return await supabaseFetch('/rest/v1/rpc/apply_schedule', accessToken, {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId }),
  });
}
