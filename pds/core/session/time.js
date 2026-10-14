export function sessionRemainingMs(sessionUntil, now = Date.now()) {
  if (sessionUntil === null || sessionUntil === undefined || sessionUntil === '') return 0;
  const until = typeof sessionUntil === 'number' ? sessionUntil : new Date(sessionUntil).getTime();
  if (Number.isNaN(until)) return 0;
  return Math.max(0, until - now);
}

export function isSessionLive(sessionUntil, now = Date.now()) {
  return sessionRemainingMs(sessionUntil, now) > 0;
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatMinutesLabel(minutes) {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

export function formatClockTime(when) {
  const date = typeof when === 'number' ? new Date(when) : new Date(when);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
