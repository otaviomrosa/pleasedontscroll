// JSDoc typedefs for every Supabase row shape. These are the contract: if a
// migration changes a table, this file changes in the same commit.
// Pure documentation — no runtime exports.

/**
 * @typedef {Object} Profile
 * @property {string} id
 * @property {string} user_id
 * @property {string} name
 * @property {boolean} is_active
 * @property {string} created_at
 */

/**
 * @typedef {Object} BlockedUrl
 * @property {string} id
 * @property {string} user_id
 * @property {string} profile_id
 * @property {string} url
 * @property {string} created_at
 */

/**
 * @typedef {Object} UserSettings
 * @property {string} id
 * @property {boolean} is_premium
 * @property {string | null} stripe_customer_id
 * @property {string | null} stripe_subscription_id
 * @property {'friction' | 'strict'} blocking_mode - User-level, not per-profile.
 * @property {string | null} paused_until - ISO timestamp; blocking is
 *   suspended until this time when set and in the future. Friction Mode
 *   only — ignored entirely while blocking_mode is 'strict'. Set from the
 *   dashboard (see docs/ARCHITECTURE.md), read by the extension's poll.
 * @property {string | null} timezone - IANA zone the schedule is evaluated
 *   in. Written once by the first client to see the account
 *   (setTimezoneIfUnset); null means the schedule is dormant.
 * @property {Object | null} schedule_state - Owned by apply_schedule()
 *   (016_schedules.sql); clients may read it but never write it. Shape:
 *   { snapshot?: { profile_id, mode }, applied?: { block_id, version,
 *   date, profile_id, mode }, skipped?: { block_id, date } }.
 * @property {string} created_at
 */

/**
 * One painted block on the weekly schedule grid. Times are minutes from
 * LOCAL midnight in `UserSettings.timezone`; day_of_week is 0 = Monday ..
 * 6 = Sunday (grid column order, NOT JS getDay()). end_min may be 1440
 * (midnight as an end). Matching is half-open: start_min <= now < end_min.
 * @typedef {Object} Schedule
 * @property {string} id
 * @property {string} user_id
 * @property {string} profile_id - Profile this block activates; deleting
 *   the profile cascades to its blocks.
 * @property {number} day_of_week
 * @property {number} start_min
 * @property {number} end_min
 * @property {'friction' | 'strict'} mode
 * @property {number} version - Bumped by a trigger on every UPDATE, so an
 *   edited block is re-applied rather than mistaken for a manual override.
 * @property {string} created_at
 */

export {};
