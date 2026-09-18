// Pure helpers for reading a weekly schedule against a local clock. No
// network, no DOM — shared by the extension's background worker (to pick
// the next boundary alarm and label the popup) and the dashboard (to mirror
// the server's "this block is active now" guard). The server's
// apply_schedule() is authoritative; this only predicts what it will say.

/**
 * A block's own coordinates: day_of_week is 0 = Monday .. 6 = Sunday
 * (JS getDay() is 0 = Sunday, hence the shift), minute is minutes since
 * local midnight.
 * @param {Date} [date]
 * @returns {{ day: number, minute: number }}
 */
export function localDayAndMinute(date = new Date()) {
  return {
    day: (date.getDay() + 6) % 7,
    minute: date.getHours() * 60 + date.getMinutes(),
  };
}

/**
 * The block covering `date`, or null. Half-open: a block that ends at
 * 11:00 is not active at 11:00, so abutting blocks never both match.
 * @param {Array<{ day_of_week: number, start_min: number, end_min: number }>} blocks
 * @param {Date} [date]
 */
export function activeBlockAt(blocks, date = new Date()) {
  const { day, minute } = localDayAndMinute(date);
  return blocks.find((b) => b.day_of_week === day && b.start_min <= minute && minute < b.end_min) ?? null;
}

/**
 * The next instant (strictly after `date`) at which any block starts or
 * ends, searching up to a week ahead; null when there are no blocks. Used
 * to set a one-shot alarm so a boundary lands on the minute instead of up
 * to a poll interval late. Built with the local Date setters, so it stays
 * correct across a DST change.
 * @param {Array<{ day_of_week: number, start_min: number, end_min: number }>} blocks
 * @param {Date} [date]
 * @returns {Date | null}
 */
export function nextBoundaryAt(blocks, date = new Date()) {
  if (!blocks.length) return null;
  const { day, minute } = localDayAndMinute(date);
  let best = null;

  for (const b of blocks) {
    for (const m of [b.start_min, b.end_min]) {
      let dayDelta = (b.day_of_week - day + 7) % 7;
      if (dayDelta === 0 && m <= minute) dayDelta = 7;
      const t = new Date(date);
      t.setHours(0, 0, 0, 0);
      t.setDate(t.getDate() + dayDelta);
      t.setMinutes(m); // 1440 rolls over to the next midnight
      if (!best || t < best) best = t;
    }
  }
  return best;
}
