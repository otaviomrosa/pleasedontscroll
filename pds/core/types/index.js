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
 * @property {string} created_at
 */

export {};
