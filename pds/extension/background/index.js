// background/index.js — PDS Service Worker (Manifest V3, ES module)
// Owns tab interception and the in-memory blocklist. All auth/session and
// Supabase query logic lives in /core — this file only adapts core calls to
// chrome.tabs / chrome.storage and holds runtime state that's legitimately
// specific to this context (the live blockedEntries array, pause timers).

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import { getValidAccessToken, getStoredSession } from '../../core/auth/session.js';
import { fetchActiveProfile, switchProfileDetailed } from '../../core/sync/profiles.js';
import { fetchBlockedUrls } from '../../core/sync/blockedUrls.js';
import {
  fetchBlockingMode, setBlockingModeDetailed, fetchIsPremium, fetchPauseUntil, setPauseUntil, setTimezoneIfUnset,
} from '../../core/sync/userSettings.js';
import { fetchSchedules, applySchedule } from '../../core/sync/schedules.js';
import { activeBlockAt, nextBoundaryAt } from '../../core/schedule/active.js';
import { isNavigableUrl, parseBlocklistEntry, matchesBlockedEntry } from '../../core/blocklist/hostname.js';

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
// null. Set from the dashboard or the Friction Mode breathing flow
// (Supabase-backed, see core/sync/userSettings.js's fetchPauseUntil/
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
 * Live { mode, pausedUntil, profileId } from the server in one round trip.
 * Calls apply_schedule() — which both runs any due schedule transition
 * (so "live" here includes a block that started seconds ago, even if no
 * alarm has fired yet) and returns the resulting mode/paused_until/profile
 * for every account, Focus Pro or not. Falls back to the plain
 * blocking_mode + paused_until reads if the RPC is unavailable, so the
 * extension keeps enforcing normally even before 016 is applied or during
 * a partial outage.
 */
async function fetchLiveState(accessToken, userId) {
  const result = await applySchedule(accessToken, userId);
  if (result && (result.mode === 'friction' || result.mode === 'strict')) {
    return {
      mode: result.mode,
      pausedUntil: result.paused_until ? new Date(result.paused_until).getTime() : null,
      profileId: result.profile_id ?? null,
    };
  }
  const [mode, pauseIso] = await Promise.all([
    fetchBlockingMode(accessToken, userId),
    fetchPauseUntil(accessToken, userId),
  ]);
  return { mode, pausedUntil: pauseIso ? new Date(pauseIso).getTime() : null, profileId: null };
}

// ─── Blocklist management ─────────────────────────────────────────────────────

/**
 * Resolves a valid access token, resolves the active profile, fetches its
 * blocklist, and rebuilds the in-memory blockedEntries array.
 * Called on startup and on a timed interval. Refreshes the token itself if
 * it's expired — unlike the old REST calls, this doesn't depend on the popup
 * having been opened recently to stay fresh.
 */
async function refreshBlocklist() {
  const accessToken = await getValidAccessToken(chromeStorageAdapter);

  if (!accessToken) {
    blockedEntries = [];
    activeProfile = null;
    isPremium = false;
    schedules = [];
    armBoundaryAlarm();
    console.log('[PDS] No active session. Blocking disabled.');
    return;
  }

  const session = await getStoredSession(chromeStorageAdapter);
  const userId = session.user.id;

  // The schedule is evaluated in the user's own wall clock, which the
  // server only knows once some client tells it. First writer wins and
  // later changes are guarded server-side — see setTimezoneIfUnset().
  if (timezoneOfferedFor !== userId) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (await setTimezoneIfUnset(accessToken, userId, zone)) timezoneOfferedFor = userId;
  }

  // Order matters here: fetchLiveState() runs apply_schedule(), which may
  // switch the active profile, so the profile read has to come after it —
  // otherwise a block's profile switch would only show up one poll late.
  // is_premium doesn't depend on it, so that one still runs concurrently.
  const [live, premium] = await Promise.all([
    fetchLiveState(accessToken, userId),
    fetchIsPremium(accessToken, userId),
  ]);

  blockingMode = live.mode;
  isPremium = premium;
  pausedUntil = live.pausedUntil;

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

  const profile = await fetchActiveProfile(accessToken);

  if (!profile) {
    blockedEntries = [];
    activeProfile = null;
    console.warn('[PDS] No active profile found. Blocking disabled.');
    return;
  }

  activeProfile = profile;

  const rows = await fetchBlockedUrls(accessToken, profile.id);
  if (rows === null) {
    // Network blip — keep the stale blocklist rather than opening everything.
    console.warn('[PDS] Blocklist refresh failed. Keeping stale list.');
    return;
  }

  blockedEntries = rows.map((row) => parseBlocklistEntry(row.url));

  console.log(
    `[PDS] Blocklist refreshed (profile: "${profile.name}"): ${blockedEntries.length} entr${blockedEntries.length === 1 ? 'y' : 'ies'}.`,
    blockedEntries,
  );
}

/**
 * Starts (or restarts) the periodic blocklist refresh alarm.
 */
function startRefreshCycle() {
  chrome.alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM_NAME || alarm.name === BOUNDARY_ALARM_NAME) refreshBlocklist();
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
  if (!isCandidateForBlocking(url)) {
    // Not on the blocklist (or not a real navigable page — isNavigableUrl
    // inside isCandidateForBlocking already filters out blocked.html's own
    // chrome-extension:// URL, so redirecting TO the block page never
    // overwrites the safe URL that got us there).
    if (isNavigableUrl(url)) lastSafeUrl.set(tabId, url);
    return;
  }

  const accessToken = await getValidAccessToken(chromeStorageAdapter);
  if (accessToken) {
    const session = await getStoredSession(chromeStorageAdapter);
    // One RPC that also applies any schedule transition that's due — so a
    // Strict block that began moments ago is enforced on this very
    // navigation, not after the boundary alarm or the next poll.
    const live = await fetchLiveState(accessToken, session.user.id);
    blockingMode = live.mode;

    // If that transition just moved the user to another profile, this
    // navigation must be judged against that profile's list, not the
    // cached one — refresh, then re-ask whether the URL is even a candidate.
    if (live.profileId && activeProfile && live.profileId !== activeProfile.id) {
      await refreshBlocklist();
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
  // No valid access token: fall through and block using whatever mode is
  // already cached. Staying cautious (still enforcing) is the safer
  // default when a live check isn't possible — never silently grant an
  // exemption that couldn't actually be verified.

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === 'SESSION_UPDATED') {
    refreshBlocklist().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'LOGOUT') {
    blockedEntries = [];
    activeProfile = null;
    pausedUntil = null;
    blockingMode = 'friction';
    isPremium = false;
    schedules = [];
    timezoneOfferedFor = null;
    armBoundaryAlarm();
    sendResponse({ ok: true });
    return true;
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
    sendResponse(buildStatePayload());

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
      const accessToken = await getValidAccessToken(chromeStorageAdapter);
      if (!accessToken) {
        sendResponse({ ok: false, error: 'Not authenticated.' });
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
      } else if (mode === 'friction') {
        // The server said no — most likely the scheduled-Strict guard, in
        // which case our cached mode was stale (a block started since the
        // last poll). Resync so the popup's next STATE_REFRESHED shows the
        // lock and the real reason, not a toggle that silently snaps back.
        await refreshBlocklist();
      }
      sendResponse({ ok, error: ok ? null : (error || 'Could not change mode.'), blockingMode, isPremium });
    })();
    return true; // async
  }

  if (message.type === 'PAUSE_BLOCKING') {
    // Sent by blocked.js's onComplete() once the 30s Friction Mode
    // breathing countdown finishes — the automatic "you sat through the
    // friction, here's a grace window" grant, distinct from the
    // dashboard's deliberate pause. message.durationMinutes — currently
    // always 10 (blocked.js), defaulted here too in case that ever
    // changes without this file being touched.
    //
    // Written through to the same Supabase paused_until column the
    // dashboard's setPauseUntil() writes (not a separate local-only
    // variable) — this is what makes "a dashboard pause always overrides
    // this" true for free: both are just the last write to one column, no
    // merge logic needed either direction. It's also why this can't
    // regress the way the old per-profile in-memory PAUSE_BLOCKING +
    // profilePauses Map did (see docs/ARCHITECTURE.md §5) — that state lived only in
    // the service worker and was silently wiped on every MV3 idle
    // teardown; this survives it the same way the dashboard's pause
    // already does, because it's the same durable column.
    (async () => {
      const accessToken = await getValidAccessToken(chromeStorageAdapter);
      if (!accessToken) {
        sendResponse({ ok: false, error: 'Not authenticated.' });
        return;
      }

      const session = await getStoredSession(chromeStorageAdapter);

      // Re-check fresh, not the mode blocked.html opened with 30s ago —
      // checkAndBlockTab() would ignore a stale-mode grant regardless (it
      // re-checks blockingMode itself before honoring pausedUntil), but no
      // reason to write a pause to Supabase at all if the user has since
      // switched to Strict from another tab.
      blockingMode = await fetchBlockingMode(accessToken, session.user.id);
      if (blockingMode !== 'friction') {
        sendResponse({ ok: false, error: 'Not in Friction Mode.' });
        return;
      }

      const minutes = Number(message.durationMinutes) || 10;
      const untilIso = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      const ok = await setPauseUntil(accessToken, session.user.id, untilIso);
      if (ok) pausedUntil = new Date(untilIso).getTime();
      sendResponse({ ok });
    })();
    return true; // async
  }

  if (message.type === 'SWITCH_PROFILE') {
    // message.profileId — UUID of the profile to activate
    (async () => {
      const accessToken = await getValidAccessToken(chromeStorageAdapter);
      if (!accessToken) {
        sendResponse({ ok: false, error: 'Not authenticated.' });
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
      await refreshBlocklist();
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
    refreshBlocklist().then(() => sendResponse({ ok: true }));
    return true; // async
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function initialize() {
  await refreshBlocklist();
  startRefreshCycle();

  // Check any tabs already open before the extension loaded.
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    checkAndBlockTab(tab.id, tab.url);
  }
}

initialize();
