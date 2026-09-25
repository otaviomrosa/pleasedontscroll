// background/index.js — PDS Service Worker (Manifest V3, ES module)
// Owns tab interception and the in-memory blocklist. All auth/session and
// Supabase query logic lives in /core — this file only adapts core calls to
// chrome.tabs / chrome.storage and holds runtime state that's legitimately
// specific to this context (the live blockedEntries array, pause timers).

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import { getValidAccessToken, getStoredSession, clearSession } from '../../core/auth/session.js';
import { fetchActiveProfile, switchProfileDetailed } from '../../core/sync/profiles.js';
import { fetchBlockedUrls } from '../../core/sync/blockedUrls.js';
import {
  setBlockingModeDetailed, fetchIsPremium, fetchSettingsSnapshot, setPauseUntil, setTimezoneIfUnset,
} from '../../core/sync/userSettings.js';
import { fetchSchedules, applySchedule } from '../../core/sync/schedules.js';
import { activeBlockAt, nextBoundaryAt } from '../../core/schedule/active.js';
import { isNavigableUrl, hostnameOf, parseBlocklistEntry, matchesBlockedEntry } from '../../core/blocklist/hostname.js';

// ─── In-memory state ─────────────────────────────────────────────────────────
// Parsed { hostname, pathPrefix } entries from the user's active profile's
// blocked_urls rows — pathPrefix is null for a whole-domain entry, or a
// normalized path ("/shorts") for a path-scoped one (see core/blocklist/
// hostname.js's parseBlocklistEntry). A handful of entries per user makes a
// plain array + matchesBlockedEntry()'s .some() check in
// isCandidateForBlocking() below trivially cheap — no need for a
// hostname-keyed Map just for a fast-path reject.
let blockedEntries = [];

// Per-tab "last known non-blocked URL" — Map<tabId, url>. Lets blocked.html
// offer a real "Go back" action instead of just closing the tab. Doesn't
// (and can't, without much broader host permissions — see docs/ARCHITECTURE.md) fix
// the browser's own back button: chrome.tabs.update() to blocked.html is a
// normal navigation, so it still adds its own history entry after the
// blocked site's, and clicking native back would just re-navigate to that
// blocked URL and get re-intercepted. This sidesteps that by tracking the
// page before the blocked attempt ourselves and giving blocked.html a
// direct link there, bypassing tab history entirely.
const lastSafeUrl = new Map();

// User-level pause (not per-profile) — epoch ms when the pause expires, or
// null. Set from the dashboard's pause switch (the breath grants a per-site
// pass instead, see sitePasses) — Supabase-backed, see core/sync/userSettings.js's fetchPauseUntil/
// setPauseUntil), refreshed on every refreshBlocklist() AND re-checked
// live in checkAndBlockTab() below right before a block would actually
// happen, since that's the one place staleness is immediately visible to
// the user. Deliberately global rather than per-profile: the dashboard's
// pause toggle is meant to disable blocking outright for a while, not
// scope it to whichever profile happens to be active. Friction Mode only —
// checkAndBlockTab() below ignores this entirely when blockingMode is
// 'strict', so a pause can never bypass Strict Mode even if one was
// already running when the user switched into it.
let pausedUntil = null;

// Per-site passes earned by finishing the 30s breath on blocked.html:
// { [hostname]: expiresAtMs }. One breath opens the site it was served for,
// not every blocked site (fix sprint decision; it used to write the
// account-wide paused_until above, which opened everything for 10 minutes).
// Local to this browser on purpose: a pass is earned here, by sitting
// through the countdown here. Friction Mode only, like the pause.
let sitePasses = {};
const SITE_PASS_MINUTES = 10;

// The currently active profile row: { id, name } or null.
let activeProfile = null;

// 'friction' (30s breathing bypass) or 'strict' (no bypass). A per-user
// setting, NOT per-profile — see /core/sync/userSettings.js.
let blockingMode = 'friction';

// Strict Mode is a Focus Pro feature. Gated here (not just hidden in the
// popup UI) so a stale/tampered client can't just send SET_BLOCKING_MODE
// directly and get it anyway.
let isPremium = false;

// How often to re-fetch the blocklist from Supabase. This is the fallback
// path — a second device/browser signed into the same account (or a Stripe
// webhook flipping is_premium) has no direct channel to this one, so it
// relies on this timer. Same-browser dashboard edits get an immediate
// refresh via the externally_connectable message below instead of waiting
// on this — see BLOCKLIST_CHANGED in the message listener.
//
// Uses chrome.alarms, not setInterval: MV3 tears the service worker down
// after ~30s idle, and a setInterval timer does NOT survive that teardown
// (this was a real bug — is_premium flipping true server-side after a
// Stripe checkout wasn't reflected in the extension until an explicit
// sign-out/sign-in, because the poll had silently stopped firing).
// chrome.alarms is designed specifically to wake a terminated service
// worker reliably. Chrome also clamps periodInMinutes to a 1-minute
// minimum for installed (non-unpacked) extensions, so this can't actually
// go below 60s in production regardless of the value below — keep this in
// sync with the "Blocklist syncs every ___" footer hint in popup.html.
const REFRESH_ALARM_NAME = 'pds-refresh';
const REFRESH_PERIOD_MINUTES = 1;

// ─── Scheduled blocking ──────────────────────────────────────────────────────
// The user's painted weekly blocks (core/types Schedule rows), cached for
// two local purposes only: computing the next block boundary for the
// one-shot alarm below, and telling the popup "Scheduled Strict until X"
// via buildStatePayload(). Enforcement is NOT done from this cache — the
// server's apply_schedule() RPC (016_schedules.sql) is the only thing that
// ever switches profile/mode for a block, and every refresh calls it
// before reading anything else, so the reads below already reflect it.
// Empty for free accounts (their rows stay dormant server-side too).
let schedules = [];

// One-shot alarm at the next block start/end so a boundary lands on the
// minute instead of up to a full poll period late. Re-armed on every
// refresh; chrome.alarms.create() with the same name replaces the old one.
const BOUNDARY_ALARM_NAME = 'pds-schedule-boundary';
// Fire a beat after the boundary, not exactly on it: apply_schedule()
// decides "now" on the server's clock, and if this machine runs a couple
// of seconds fast the RPC would still see the previous minute and do
// nothing until the next poll.
const BOUNDARY_ALARM_SLACK_MS = 3000;

// Which user we've already offered our timezone for this worker lifetime —
// setTimezoneIfUnset() is idempotent (writes only while the column is
// null), this just avoids a pointless PATCH every minute.
let timezoneOfferedFor = null;

// ─── Persisted cache ─────────────────────────────────────────────────────────
// Everything above is mirrored to chrome.storage.local after each refresh
// and loaded back before any event is handled. MV3 stops this worker after
// ~30s idle and it restarts roughly every minute, and every restart used to
// begin with an empty blocklist until several network calls finished. A
// navigation that woke the worker slipped through, and if Supabase was
// unreachable (an outage, a captive portal, or the user blocking its host
// in an ad blocker) nothing was blocked at all (audit R2). Now the last
// known state is enforced until a refresh replaces it: failing closed.
const STATE_KEY = 'pds_state';

// When the cache was last filled from the server (epoch ms), and for whom.
let lastRefreshAt = 0;
let cachedUserId = null;

async function saveState() {
  try {
    await chrome.storage.local.set({
      [STATE_KEY]: {
        userId: cachedUserId,
        blockedEntries,
        activeProfile,
        blockingMode,
        isPremium,
        pausedUntil,
        sitePasses: livePasses(),
        schedules,
        lastRefreshAt,
        timezoneOfferedFor,
      },
    });
  } catch (err) {
    console.warn('[PDS] Could not save state:', err);
  }
}

async function loadState() {
  const { [STATE_KEY]: saved } = await chrome.storage.local.get(STATE_KEY);
  if (!saved) return;
  cachedUserId = saved.userId ?? null;
  blockedEntries = Array.isArray(saved.blockedEntries) ? saved.blockedEntries : [];
  activeProfile = saved.activeProfile ?? null;
  blockingMode = saved.blockingMode === 'strict' ? 'strict' : 'friction';
  isPremium = saved.isPremium === true;
  pausedUntil = typeof saved.pausedUntil === 'number' ? saved.pausedUntil : null;
  sitePasses = saved.sitePasses && typeof saved.sitePasses === 'object' ? saved.sitePasses : {};
  schedules = Array.isArray(saved.schedules) ? saved.schedules : [];
  lastRefreshAt = saved.lastRefreshAt ?? 0;
  timezoneOfferedFor = saved.timezoneOfferedFor ?? null;
}

/** Forgets the cached state, in memory and in storage (a real sign-out). */
async function clearState() {
  blockedEntries = [];
  activeProfile = null;
  pausedUntil = null;
  sitePasses = {};
  blockingMode = 'friction';
  isPremium = false;
  schedules = [];
  timezoneOfferedFor = null;
  lastRefreshAt = 0;
  cachedUserId = null;
  armBoundaryAlarm();
  try {
    await chrome.storage.local.remove(STATE_KEY);
  } catch (err) {
    console.warn('[PDS] Could not clear state:', err);
  }
}

// Every listener awaits this before reading state, so an event that wakes
// the worker is judged against the saved blocklist, not an empty one.
const ready = loadState().catch((err) => console.warn('[PDS] Could not load state:', err));

// How old the cache may get before a navigation waits for a refresh. The
// 60s alarm usually keeps it younger; this covers the gaps where it
// doesn't (sleep, a missed alarm, a failed refresh).
const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * True when the cache may no longer describe what the server would say:
 * older than STALE_AFTER_MS, or a scheduled block has started or ended
 * since it was filled. The second case is the schedule-start bug in
 * TODO.md: a block that switches to a profile with a different list is
 * invisible to navigation, because only URLs on the cached list trigger a
 * live check.
 */
function cacheIsStale() {
  if (Date.now() - lastRefreshAt > STALE_AFTER_MS) return true;
  const boundary = nextBoundaryAt(schedules, new Date(lastRefreshAt));
  return boundary !== null && boundary.getTime() <= Date.now();
}

/** sitePasses without the expired ones. */
function livePasses() {
  const now = Date.now();
  return Object.fromEntries(Object.entries(sitePasses).filter(([, until]) => until > now));
}

/** True if a breath pass currently covers this URL (its host or a subdomain). */
function hasSitePass(url) {
  return Object.keys(livePasses()).some((hostname) => matchesBlockedEntry(url, { hostname, pathPrefix: null }));
}

/**
 * The hostname a pass for `url` should cover: that of the broadest cached
 * entry blocking it ("youtube.com" for m.youtube.com/shorts/x), so the
 * site's own redirects between subdomains (pinterest.com to
 * br.pinterest.com) don't land the user straight back on the block screen
 * they just breathed through. Falls back to the URL's own hostname.
 */
function passHostnameFor(url) {
  const matching = blockedEntries.filter((entry) => matchesBlockedEntry(url, entry));
  if (matching.length === 0) return hostnameOf(url);
  return matching.reduce((a, b) => (b.hostname.length < a.hostname.length ? b : a)).hostname;
}

/**
 * Re-arms the boundary alarm from the cached schedule (or clears it when
 * there's nothing scheduled).
 */
function armBoundaryAlarm() {
  const next = nextBoundaryAt(schedules);
  if (!next) {
    chrome.alarms.clear(BOUNDARY_ALARM_NAME);
    return;
  }
  chrome.alarms.create(BOUNDARY_ALARM_NAME, { when: next.getTime() + BOUNDARY_ALARM_SLACK_MS });
}

/**
 * The scheduled block covering right now (from the cache), or null. Only
 * meaningful for a Focus Pro account — the server ignores the schedule
 * for everyone else, so this must too, or the popup would show a lock
 * the server isn't enforcing.
 */
function currentScheduledBlock() {
  if (!isPremium || schedules.length === 0) return null;
  return activeBlockAt(schedules);
}

/** Epoch ms at which today's instance of `block` ends (end_min 1440 = next midnight). */
function blockEndMs(block) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setMinutes(block.end_min);
  return end.getTime();
}

/** "11:00 PM" — same shape the server's schedule_minute_label() produces. */
function formatBlockEnd(block) {
  return new Date(blockEndMs(block)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The message a user gets when a scheduled Strict block stops them from
 * leaving Strict or switching profiles — null when no such block is
 * active. Mirrors the server guard (016) for a fast local answer; the
 * server is still the one that actually refuses.
 */
function scheduledStrictRefusal() {
  const block = currentScheduledBlock();
  if (!block || block.mode !== 'strict' || blockingMode !== 'strict') return null;
  return `Strict Mode is scheduled until ${formatBlockEnd(block)}.`;
}

/**
 * Live { mode, pausedUntil, profileId } from the server in one round trip,
 * or null when the server couldn't be asked. Calls apply_schedule() — which
 * both runs any due schedule transition (so "live" here includes a block
 * that started seconds ago, even if no alarm has fired yet) and returns the
 * resulting mode/paused_until/profile for every account, Focus Pro or not.
 * Falls back to a plain settings read if the RPC fails. Null, never a
 * default: the old fallback answered 'friction' on a network error, which
 * let a Strict user through (audit R2).
 */
async function fetchLiveState(accessToken, userId) {
  const result = await applySchedule(accessToken, userId).catch(() => null);
  if (result && (result.mode === 'friction' || result.mode === 'strict')) {
    return {
      mode: result.mode,
      pausedUntil: result.paused_until ? new Date(result.paused_until).getTime() : null,
      profileId: result.profile_id ?? null,
    };
  }
  const settings = await fetchSettingsSnapshot(accessToken, userId).catch(() => null);
  if (!settings) return null;
  return {
    mode: settings.blockingMode,
    pausedUntil: settings.pausedUntil ? new Date(settings.pausedUntil).getTime() : null,
    profileId: null,
  };
}

// ─── Blocklist management ─────────────────────────────────────────────────────

// A one-shot alarm that retries a failed refresh instead of waiting for the
// next periodic tick. 30s is the shortest delay Chrome allows a packed
// extension's alarm.
const RETRY_ALARM_NAME = 'pds-retry';
const RETRY_DELAY_MINUTES = 0.5;

function scheduleRetry() {
  chrome.alarms.create(RETRY_ALARM_NAME, { delayInMinutes: RETRY_DELAY_MINUTES });
}

let refreshInFlight = null;
let refreshAfterChangePending = null;

// When the last refresh started, successful or not. A stale cache makes
// navigations refresh first (checkAndBlockTab()); while Supabase is
// unreachable that would be one failing attempt per page load, so a
// navigation starts a new attempt only this long after the previous one.
let lastRefreshAttemptAt = 0;
const NAVIGATION_REFRESH_BACKOFF_MS = 30 * 1000;

/**
 * Refills the cache from the server. Callers landing together (a wake fires
 * the alarm, initialize() and a tab event at once) share one refresh
 * instead of each spending four or five requests and racing the refresh
 * token (audit R6). Never rejects.
 */
function refreshBlocklist() {
  if (!refreshInFlight) {
    refreshInFlight = runRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/**
 * For callers that just changed something (sign-in, a dashboard edit, a
 * profile switch): a refresh already in flight may have read the state
 * before the change, so wait for it and start a new one.
 */
function refreshAfterChange() {
  if (!refreshAfterChangePending) {
    const previous = refreshInFlight ?? Promise.resolve();
    refreshAfterChangePending = previous.then(() => {
      refreshAfterChangePending = null;
      return refreshBlocklist();
    });
  }
  return refreshAfterChangePending;
}

async function runRefresh() {
  await ready;
  lastRefreshAttemptAt = Date.now();
  try {
    const accessToken = await getValidAccessToken(chromeStorageAdapter);
    if (!accessToken) {
      if (await getStoredSession(chromeStorageAdapter)) {
        // Signed in, but the token couldn't be refreshed right now (offline,
        // a 5xx, a captive portal). Keep enforcing what we have.
        console.warn('[PDS] Could not refresh the session. Keeping cached state.');
        scheduleRetry();
        return;
      }
      if (cachedUserId || blockedEntries.length) await clearState();
      console.log('[PDS] No active session. Blocking disabled.');
      return;
    }
    await pullState(accessToken);
  } catch (err) {
    console.warn('[PDS] Refresh failed. Keeping cached state.', err);
    scheduleRetry();
  }
}

/**
 * Reads the active profile, its blocklist, mode, pause, premium flag and
 * schedule, running any due schedule transition first. Throws when the
 * server can't answer; the caller keeps the cache and retries. Only a
 * complete refresh advances lastRefreshAt.
 */
async function pullState(accessToken) {
  const session = await getStoredSession(chromeStorageAdapter);
  const userId = session.user.id;

  // The schedule is evaluated in the user's own wall clock, which the
  // server only knows once some client tells it. First writer wins and
  // later changes are guarded server-side — see setTimezoneIfUnset().
  // timezoneOfferedFor is saved with the cache, so this is one PATCH per
  // account, not one per worker restart.
  if (timezoneOfferedFor !== userId) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (await setTimezoneIfUnset(accessToken, userId, zone).catch(() => false)) timezoneOfferedFor = userId;
  }

  // apply_schedule() may switch the active profile, so the profile read has
  // to come after it. The settings read doesn't depend on it and runs
  // alongside: it supplies is_premium, and mode/pause if the RPC fails.
  const [live, settings] = await Promise.all([
    applySchedule(accessToken, userId).catch(() => null),
    fetchSettingsSnapshot(accessToken, userId).catch(() => null),
  ]);
  const liveOk = live && (live.mode === 'friction' || live.mode === 'strict');
  if (!liveOk && !settings) throw new Error('Could not read blocking mode.');

  blockingMode = liveOk ? live.mode : settings.blockingMode;
  const pauseIso = liveOk ? live.paused_until : settings.pausedUntil;
  pausedUntil = pauseIso ? new Date(pauseIso).getTime() : null;
  if (settings) isPremium = settings.isPremium;

  // Cache the schedule (Focus Pro only — dormant otherwise, matching the
  // server) and re-arm the boundary alarm from it. A failed fetch keeps
  // the previous copy: dropping it would silently cancel the alarm for a
  // block that's still very much going to start.
  if (isPremium) {
    const rows = await fetchSchedules(accessToken);
    if (rows !== null) schedules = rows;
  } else {
    schedules = [];
  }
  armBoundaryAlarm();

  // Throws on a failed request; null only when no profile is active, which
  // 009/010 prevent, so the empty list below is a real state, not a blip.
  const profile = await fetchActiveProfile(accessToken);
  if (!profile) {
    blockedEntries = [];
    activeProfile = null;
    console.warn('[PDS] No active profile found. Blocking disabled.');
  } else {
    const rows = await fetchBlockedUrls(accessToken, profile.id);
    if (rows === null) throw new Error('Could not load the blocklist.');
    activeProfile = profile;
    blockedEntries = rows.map((row) => parseBlocklistEntry(row.url));
    console.log(
      `[PDS] Blocklist refreshed (profile: "${profile.name}"): ${blockedEntries.length} entr${blockedEntries.length === 1 ? 'y' : 'ies'}.`,
      blockedEntries,
    );
  }

  cachedUserId = userId;
  lastRefreshAt = Date.now();
  await saveState();
}

/**
 * Creates the periodic refresh alarm if it's missing. Chrome may drop alarms
 * on a browser restart, so this runs on every worker start; it no longer
 * re-creates an existing alarm, which reset its period each time.
 */
async function ensureRefreshAlarm() {
  const existing = await chrome.alarms.get(REFRESH_ALARM_NAME);
  if (!existing) chrome.alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM_NAME || alarm.name === BOUNDARY_ALARM_NAME || alarm.name === RETRY_ALARM_NAME) {
    refreshBlocklist();
  }
});

// Waking from sleep or unlocking is when a missed boundary alarm is most
// likely (TODO.md's schedule-start bug): refresh as soon as the user is
// back. The idle permission shows no install warning.
chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === 'active') refreshBlocklist();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBlocklist();
});

// ─── Tab interception logic ───────────────────────────────────────────────────

/**
 * Whether the given URL is on the current blocklist at all (hostname, and
 * if the matching entry is path-scoped, the path too) — a pure, fast,
 * local check independent of blocking_mode/pause. Used only to decide
 * whether a live mode/pause recheck (below) is worth doing; the actual
 * block/no-block decision is never made from this alone.
 *
 * @param {string} url - Full URL of the tab being navigated.
 * @returns {boolean}
 */
function isCandidateForBlocking(url) {
  if (!isNavigableUrl(url)) return false;
  if (blockedEntries.length === 0) return false;
  return blockedEntries.some((entry) => matchesBlockedEntry(url, entry));
}

/**
 * Redirects a tab to the blocked.html intercept page if it's currently
 * blocked. "Currently" is always decided live against Supabase once a
 * hostname is a blocklist candidate, never from the cached blockingMode/
 * pausedUntil alone — those are only as fresh as the last
 * refreshBlocklist() (startup, the 60s chrome.alarms tick, an external
 * poke — a no-op pre-launch since EXTENSION_ID in core/config.js is still
 * a placeholder — or a popup open), none of which are triggered by the
 * act of navigating. That staleness cuts both ways, and both directions
 * are real bugs a user would immediately notice: a pause set moments ago
 * on the dashboard might not be reflected in the cache yet (blocks a site
 * that should currently be let through), or a pause that already expired
 * or was resumed might still look active in the cache (lets a site
 * through that should currently be blocked). Re-checking live here — once
 * a hostname is even a blocklist candidate, not on every navigation —
 * closes both gaps with one round trip instead of only the first.
 *
 * @param {number} tabId
 * @param {string} url
 */
async function checkAndBlockTab(tabId, url) {
  // Judge against the saved state, never the empty one a restarted worker
  // starts with.
  await ready;

  // Not a real navigable page — this also filters out blocked.html's own
  // chrome-extension:// URL, so redirecting TO the block page never
  // overwrites the safe URL that got us there.
  if (!isNavigableUrl(url)) return;

  // A URL missing from an out-of-date list may still be blocked: most often
  // a scheduled block has started and moved the user to a profile whose
  // list the cache doesn't hold yet. Refresh before letting it through.
  if (!isCandidateForBlocking(url)) {
    if (refreshInFlight) {
      await refreshInFlight;
    } else if (cacheIsStale() && Date.now() - lastRefreshAttemptAt > NAVIGATION_REFRESH_BACKOFF_MS) {
      await refreshBlocklist();
    }
  }

  if (!isCandidateForBlocking(url)) {
    lastSafeUrl.set(tabId, url);
    return;
  }

  const accessToken = await getValidAccessToken(chromeStorageAdapter);
  const session = accessToken ? await getStoredSession(chromeStorageAdapter) : null;
  // One RPC that also applies any schedule transition that's due — so a
  // Strict block that began moments ago is enforced on this very
  // navigation, not after the boundary alarm or the next poll. Null when
  // the server can't be asked; then the cached mode decides, below.
  const live = session ? await fetchLiveState(accessToken, session.user.id) : null;
  if (live) {
    blockingMode = live.mode;

    // If that transition just moved the user to another profile, this
    // navigation must be judged against that profile's list, not the
    // cached one — refresh, then re-ask whether the URL is even a candidate.
    if (live.profileId && activeProfile && live.profileId !== activeProfile.id) {
      await refreshAfterChange();
      if (!isCandidateForBlocking(url)) {
        if (isNavigableUrl(url)) lastSafeUrl.set(tabId, url);
        return;
      }
    }

    if (blockingMode === 'friction') {
      pausedUntil = live.pausedUntil;
      if (pausedUntil && Date.now() < pausedUntil) {
        lastSafeUrl.set(tabId, url); // currently paused — let it through, still a safe page
        return;
      }
    } else {
      // Strict Mode never honors a pause regardless of what's stored —
      // keep the cache consistent with that so a later GET_STATE (e.g. the
      // popup) doesn't display a pause that can no longer do anything.
      pausedUntil = null;
    }
  }

  // A breath pass for this site. Unlike the server-side pause above, it is
  // honored on the cached mode too: it was earned here, seconds ago, by
  // sitting through the countdown, and refusing it whenever Supabase is
  // unreachable would strand a Friction user on the block screen. Strict
  // never honors one, and entering Strict forfeits them all.
  if (blockingMode === 'friction') {
    if (hasSitePass(url)) {
      lastSafeUrl.set(tabId, url);
      return;
    }
  } else if (Object.keys(sitePasses).length) {
    sitePasses = {};
    saveState();
  }
  // No token, or the server didn't answer: fall through and block using
  // whatever mode is already cached. Staying cautious (still enforcing) is
  // the safer default when a live check isn't possible — never silently
  // grant an exemption that couldn't actually be verified.

  // The page before this blocked attempt, if we ever saw one for this tab
  // (we won't for e.g. a tab that loaded straight into a blocked URL on
  // browser startup) — blocked.html falls back to a plain "Close tab" when
  // this is absent. See docs/ARCHITECTURE.md on why this is a same-permissions
  // workaround, not a fix for the browser's own back button.
  const backUrl = lastSafeUrl.get(tabId);

  const blockedPageUrl =
    chrome.runtime.getURL('extension/blocked/blocked.html') +
    `?from=${encodeURIComponent(url)}&mode=${encodeURIComponent(blockingMode)}` +
    (backUrl ? `&back=${encodeURIComponent(backUrl)}` : '');

  try {
    await chrome.tabs.update(tabId, { url: blockedPageUrl });
    console.log(`[PDS] Blocked tab ${tabId}: ${url}`);
  } catch (err) {
    console.warn(`[PDS] Could not redirect tab ${tabId}:`, err);
  }
}

/**
 * Snapshot of state the popup cares about, built from the current
 * in-memory cache. Shared by GET_STATE's immediate response and the
 * STATE_REFRESHED push that follows once a background refresh completes.
 */
function buildStatePayload() {
  // popup.html labels this "sites in this profile" — a whole-domain entry
  // and a path-scoped entry for the same site (e.g. youtube.com plus
  // youtube.com/shorts) should still read as one site, not two, so this
  // counts unique hostnames rather than raw blockedEntries.length.
  const uniqueHosts = new Set(blockedEntries.map((entry) => entry.hostname));
  // The scheduled Strict block in force right now, if any — the popup
  // uses it to lock the Friction option and say until when. Null unless
  // the server is actually enforcing it (Focus Pro, mode really is
  // Strict), so the popup never shows a lock the user couldn't rely on.
  const block = currentScheduledBlock();
  const scheduledStrictUntil = block && block.mode === 'strict' && blockingMode === 'strict' ? blockEndMs(block) : null;
  return {
    blockedCount:  uniqueHosts.size,
    blockedHosts:  [...uniqueHosts],
    isPaused:      pausedUntil !== null && Date.now() < pausedUntil,
    pauseUntil:    pausedUntil,
    activeProfile,
    blockingMode,
    isPremium,
    scheduledStrictUntil,
  };
}

// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    checkAndBlockTab(tabId, changeInfo.url);
  } else if (changeInfo.status === 'complete' && tab.url) {
    checkAndBlockTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    checkAndBlockTab(tabId, tab.url);
  } catch {
    // Tab may no longer exist — ignore.
  }
});

// Keeps lastSafeUrl from growing unbounded across a long browser session.
chrome.tabs.onRemoved.addListener((tabId) => {
  lastSafeUrl.delete(tabId);
});

// ─── Message protocol ─────────────────────────────────────────────────────────

/**
 * What to tell the popup when an action needs a token and there isn't one:
 * signed out, or signed in but the session couldn't be refreshed just now
 * (getValidAccessToken() keeps the session on a network error or a 5xx).
 */
async function noTokenError() {
  return (await getStoredSession(chromeStorageAdapter))
    ? "Can't reach Please Don't Scroll right now. Try again in a moment."
    : 'Not authenticated.';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === 'SESSION_UPDATED') {
    refreshAfterChange().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'SIGN_OUT') {
    // The popup's Sign out. Signing out empties the blocklist, which made it
    // a one-click way out of Strict Mode, easier than the exit hold it
    // skipped (audit R1). Refused in Strict, as profile switches and
    // blocklist edits already are: leave Strict first. The check happens
    // here, not in the popup, and asks the server first (a Strict block may
    // have started since the last refresh); if the server can't be asked,
    // the cached mode decides, so going offline isn't a way out either.
    // This is friction rather than a boundary: no server can refuse
    // clearing chrome.storage, and uninstalling is always possible.
    (async () => {
      await ready;
      const accessToken = await getValidAccessToken(chromeStorageAdapter);
      const session = accessToken ? await getStoredSession(chromeStorageAdapter) : null;
      const live = session ? await fetchLiveState(accessToken, session.user.id) : null;
      if (live) blockingMode = live.mode;

      if (blockingMode === 'strict') {
        const scheduled = scheduledStrictRefusal();
        sendResponse({
          ok: false,
          error: scheduled ? `${scheduled} You can sign out after it ends.` : 'Switch to Friction Mode to sign out.',
        });
        return;
      }

      await clearSession(chromeStorageAdapter);
      await clearState();
      sendResponse({ ok: true });
    })();
    return true; // async
  }

  if (message.type === 'GET_STATE') {
    // Answer immediately from whatever's cached — instant, no network
    // wait — then kick off a live refresh in the background and push a
    // follow-up STATE_REFRESHED if the popup is still open to receive it.
    //
    // This used to await refreshBlocklist() before responding at all,
    // which fixed a real bug (the popup showing a stale pause expiry that
    // wouldn't correct itself until the next chrome.alarms tick — see
    // docs/ARCHITECTURE.md §5) but made every popup open feel slow, since
    // refreshBlocklist() is several sequential Supabase round trips. The
    // cache is usually already close to fresh (the 60s alarm, plus
    // whatever the last GET_STATE's own background refresh left behind),
    // so serving it immediately and correcting moments later if it turns
    // out stale gets both: an instant-feeling open AND the same eventual
    // correctness, without paying for a full refresh on every single click
    // of the toolbar icon.
    ready.then(() => sendResponse(buildStatePayload()));

    refreshBlocklist().then(() => {
      chrome.runtime.sendMessage({ type: 'STATE_REFRESHED', ...buildStatePayload() }, () => {
        void chrome.runtime.lastError; // no popup listening anymore — fine, this is just an optimization
      });
    });
    return true;
  }

  if (message.type === 'SET_BLOCKING_MODE') {
    // message.mode — 'friction' or 'strict'
    (async () => {
      await ready;
      const accessToken = await getValidAccessToken(chromeStorageAdapter);
      if (!accessToken) {
        sendResponse({ ok: false, error: await noTokenError() });
        return;
      }

      const mode = message.mode === 'strict' ? 'strict' : 'friction';
      const session = await getStoredSession(chromeStorageAdapter);

      if (mode === 'strict' && !isPremium) {
        // Don't trust the in-memory flag alone for the thing that actually
        // gates a paid feature — re-check against Supabase right before
        // honoring the switch, in case a webhook downgrade landed after the
        // last refreshBlocklist() but before this click.
        isPremium = await fetchIsPremium(accessToken, session.user.id);
        if (!isPremium) {
          sendResponse({ ok: false, error: 'Focus Pro required.', blockingMode, isPremium });
          return;
        }
      }

      // A scheduled Strict block can't be left until it ends (founder's
      // call — the popup's 30s hold is a client-side courtesy the server
      // no longer honors during a block). The trigger in 016 refuses the
      // write regardless; this local check just answers instantly with
      // the same message and skips a round trip that would fail.
      if (mode === 'friction') {
        const refusal = scheduledStrictRefusal();
        if (refusal) {
          sendResponse({ ok: false, error: refusal, blockingMode, isPremium });
          return;
        }
      }

      const { ok, error } = await setBlockingModeDetailed(accessToken, session.user.id, mode);
      if (ok) {
        blockingMode = mode;

        // Strict Mode and an active pause can't coexist — a pause is
        // meaningless the instant Strict Mode is in effect (checkAndBlockTab
        // already ignores pausedUntil whenever the fresh mode is 'strict'),
        // but leaving the stale paused_until sitting in Supabase means every
        // *display* of pause state (the dashboard's toggle, the popup's
        // pause bar) keeps showing "Paused" even though nothing is actually
        // paused anymore — enforcement was already correct, only the UI
        // lagged. So switching into Strict also clears the pause outright,
        // not just ignores it: write paused_until back to null and reset
        // the local cache, so the dashboard toggle reads as "on" again the
        // next time it re-syncs, instead of showing a pause that can't do
        // anything. Friction→Strict only — going the other way has nothing
        // to clear (Strict never lets a pause exist in the first place).
        if (mode === 'strict' && pausedUntil !== null) {
          const cleared = await setPauseUntil(accessToken, session.user.id, null);
          if (cleared) pausedUntil = null;
        }
        if (mode === 'strict') sitePasses = {};
        await saveState();
      } else if (mode === 'friction') {
        // The server said no — most likely the scheduled-Strict guard, in
        // which case our cached mode was stale (a block started since the
        // last poll). Resync so the popup's next STATE_REFRESHED shows the
        // lock and the real reason, not a toggle that silently snaps back.
        await refreshAfterChange();
      }
      sendResponse({ ok, error: ok ? null : (error || 'Could not change mode.'), blockingMode, isPremium });
    })();
    return true; // async
  }

  if (message.type === 'GRANT_SITE_PASS') {
    // Sent by blocked.js once the 30s Friction Mode breath finishes, with
    // the URL the block screen was served for (message.url). Grants a
    // SITE_PASS_MINUTES pass for that site only. Local, no network: the
    // pass lives in this browser's cache, and checkAndBlockTab() re-checks
    // the mode before honoring it.
    (async () => {
      await ready;
      if (blockingMode !== 'friction') {
        sendResponse({ ok: false, error: 'Not in Friction Mode.' });
        return;
      }
      const hostname = passHostnameFor(message.url);
      if (!hostname) {
        sendResponse({ ok: false, error: 'Unknown site.' });
        return;
      }
      sitePasses = { ...livePasses(), [hostname]: Date.now() + SITE_PASS_MINUTES * 60 * 1000 };
      await saveState();
      sendResponse({ ok: true, hostname, minutes: SITE_PASS_MINUTES });
    })();
    return true; // async
  }

  if (message.type === 'SWITCH_PROFILE') {
    // message.profileId — UUID of the profile to activate
    (async () => {
      await ready;
      const accessToken = await getValidAccessToken(chromeStorageAdapter);
      if (!accessToken) {
        sendResponse({ ok: false, error: await noTokenError() });
        return;
      }

      const session = await getStoredSession(chromeStorageAdapter);

      // Same fast local answer as SET_BLOCKING_MODE: switch_active_profile()
      // already refuses any switch in Strict Mode (011), and during a
      // scheduled Strict block its message names the end time (016).
      const refusal = scheduledStrictRefusal();
      if (refusal) {
        sendResponse({ ok: false, error: refusal, activeProfile });
        return;
      }

      const { ok, error } = await switchProfileDetailed(accessToken, session.user.id, message.profileId);
      // Refresh either way — a refusal usually means the cache was stale
      // (a Strict block began since the last poll), and the popup needs
      // the corrected state to explain itself.
      await refreshAfterChange();
      sendResponse({ ok, error: ok ? null : (error || 'Could not switch profile.'), activeProfile });
    })();
    return true; // async
  }
});

// ─── External message protocol (from the web dashboard) ───────────────────────
// Only origins listed in manifest.json's externally_connectable.matches can
// reach this listener at all — Chrome enforces that before the message ever
// gets here, so no extra sender-origin check is needed for security. This is
// purely a "sync got faster" optimization, never a hard dependency: if the
// dashboard's EXTENSION_ID is stale/unset, or this message never arrives for
// any other reason, refreshBlocklist() still runs on its normal interval.

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'BLOCKLIST_CHANGED') {
    refreshAfterChange().then(() => sendResponse({ ok: true }));
    return true; // async
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function initialize() {
  await ready;
  await ensureRefreshAlarm();
  // The saved schedule may outlive a boundary alarm Chrome dropped on restart.
  armBoundaryAlarm();

  // Every worker start runs this, roughly once a minute. Only go to the
  // network when the saved state is actually old; a wake caused by the
  // refresh alarm refreshes through its own listener anyway.
  if (cacheIsStale()) await refreshBlocklist();

  // Check any tabs already open before the extension loaded.
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    checkAndBlockTab(tab.id, tab.url);
  }
}

initialize();
