import { supabaseFetchDetailed } from './restClient.js';

export const SESSION_MINUTES = [15, 30, 60, 120, 360];

export async function startSession(accessToken, userId, { profileId, mode, minutes }) {
  const { data, error } = await supabaseFetchDetailed('/rest/v1/rpc/start_session', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: userId,
      p_profile_id: profileId,
      p_mode: mode === 'strict' ? 'strict' : 'friction',
      p_minutes: minutes,
    }),
  });
  return { state: data, error };
}

export async function endSession(accessToken, userId) {
  const { data, error } = await supabaseFetchDetailed('/rest/v1/rpc/end_session', accessToken, {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId }),
  });
  return { state: data, error };
}
