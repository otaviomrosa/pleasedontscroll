// background/index.js — PDS Service Worker (Manifest V3, ES module)
// Owns tab interception and the in-memory blocklist. All auth/session and
// Supabase query logic lives in /core — this file only adapts core calls to
// chrome.tabs / chrome.storage and holds runtime state that's legitimately
// specific to this context (the live blockedHosts set, pause timers).

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import { getValidAccessToken, getStoredSession } from '../../core/auth/session.js';
import { fetchActiveProfile, switchProfile } from '../../core/sync/profiles.js';
import { fetchBlockedUrls } from '../../core/sync/blockedUrls.js';
import { fetchBlockingMode, setBlockingMode, fetchIsPremium, fetchPauseUntil, setPauseUntil } from '../../core/sync/userSettings.js';
import { normalizeToHostname, isNavigableUrl, hostnameOf } from '../../core/blocklist/hostname.js';

// ─── In-memory state ─────────────────────────────────────────────────────────
// Blocked hostnames derived from the user's active profile's blocked_urls rows.
let blockedHosts = new Set();

// User-level pause (not per-profile) — epoch ms when the pause expires, or
// null. Set from the dashboard (Supabase-backed, see core/sync/userSettings.js's
// fetchPauseUntil/setPauseUntil), read here on every refreshBlocklist().
// Deliberately global rather than per-profile: the dashboard's pause toggle
// is meant to disable blocking outright for a while, not scope it to
// whichever profile happens to be active. Friction Mode only — isUrlBlocked()
// below ignores this entirely when blockingMode is 'strict', so a pause can
// never bypass Strict Mode even if one was already running when the user
// switched into it.
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

// ─── Blocklist management ─────────────────────────────────────────────────────

/**
 * Resolves a valid access token, resolves the active profile, fetches its
 * blocklist, and rebuilds the in-memory blockedHosts Set.
 * Called on startup and on a timed interval. Refreshes the token itself if
 * it's expired — unlike the old REST calls, this doesn't depend on the popup
 * having been opened recently to stay fresh.
 */
async function refreshBlocklist() {
  const accessToken = await getValidAccessToken(chromeStorageAdapter);

  if (!accessToken) {
    blockedHosts.clear();
    activeProfile = null;
    isPremium = false;
    console.log('[PDS] No active session. Blocking disabled.');
    return;
  }

  const session = await getStoredSession(chromeStorageAdapter);
  blockingMode = await fetchBlockingMode(accessToken, session.user.id);
  isPremium = await fetchIsPremium(accessToken, session.user.id);

  const pauseIso = await fetchPauseUntil(accessToken, session.user.id);
  pausedUntil = pauseIso ? new Date(pauseIso).getTime() : null;

  const profile = await fetchActiveProfile(accessToken);
  if (!profile) {
    blockedHosts.clear();
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

  blockedHosts = new Set(rows.map((row) => normalizeToHostname(row.url)));

  console.log(
    `[PDS] Blocklist refreshed (profile: "${profile.name}"): ${blockedHosts.size} site(s).`,
    [...blockedHosts],
  );
}

/**
 * Starts (or restarts) the periodic blocklist refresh alarm.
 */
function startRefreshCycle() {
  chrome.alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM_NAME) refreshBlocklist();
});

// ─── Tab interception logic ───────────────────────────────────────────────────

/**
 * Returns true if the given full URL matches any blocked hostname.
 *
 * @param {string} url - Full URL of the tab being navigated.
 * @returns {boolean}
 */
function isUrlBlocked(url) {
  if (!isNavigableUrl(url)) return false;
  if (blockedHosts.size === 0) return false;

  // Dashboard-triggered pause — Friction Mode only, deliberately. Strict
  // Mode's entire promise is "no bypass"; a pause left running (or set)
  // from another tab must never be able to override that, so this is
  // checked only when blockingMode isn't 'strict', not just gated at the
  // point the pause was created.
  if (blockingMode === 'friction' && pausedUntil && Date.now() < pausedUntil) return false;

  const hostname = hostnameOf(url);
  return hostname !== null && blockedHosts.has(hostname);
}

/**
 * Redirects a tab to the blocked.html intercept page if its URL is blocked.
 *
 * @param {number} tabId
 * @param {string} url
 */
async function checkAndBlockTab(tabId, url) {
  if (!isUrlBlocked(url)) return;

  const blockedPageUrl =
    chrome.runtime.getURL('extension/blocked/blocked.html') +
    `?from=${encodeURIComponent(url)}&mode=${encodeURIComponent(blockingMode)}`;

  try {
    await chrome.tabs.update(tabId, { url: blockedPageUrl });
    console.log(`[PDS] Blocked tab ${tabId}: ${url}`);
  } catch (err) {
    console.warn(`[PDS] Could not redirect tab ${tabId}:`, err);
  }
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

// ─── Message protocol ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === 'SESSION_UPDATED') {
    refreshBlocklist().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'LOGOUT') {
    blockedHosts.clear();
    activeProfile = null;
    pausedUntil = null;
    blockingMode = 'friction';
    isPremium = false;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'GET_STATE') {
    // Re-sync before answering rather than serving whatever's cached in
    // memory: that cache is only as fresh as the last chrome.alarms tick
    // (up to 60s stale) or the dashboard's poke (a no-op until EXTENSION_ID
    // is a real published ID — see core/config.js). Popup open is exactly
    // the moment a user is looking for accurate status, so it shouldn't be
    // at the mercy of the poll cadence — this was caught by pausing 10
    // minutes via the Friction breathing flow, then immediately overriding
    // with an indefinite pause from the dashboard: the popup kept showing
    // the stale 10-minute expiry until the next alarm happened to fire.
    (async () => {
      await refreshBlocklist();
      sendResponse({
        blockedCount:  blockedHosts.size,
        blockedHosts:  [...blockedHosts],
        isPaused:      pausedUntil !== null && Date.now() < pausedUntil,
        pauseUntil:    pausedUntil,
        activeProfile,
        blockingMode,
        isPremium,
      });
    })();
    return true; // async
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

      const ok = await setBlockingMode(accessToken, session.user.id, mode);
      if (ok) blockingMode = mode;
      sendResponse({ ok, blockingMode, isPremium });
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
      // isUrlBlocked() would ignore a stale-mode grant regardless (it
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
      const ok = await switchProfile(accessToken, session.user.id, message.profileId);
      if (ok) await refreshBlocklist();
      sendResponse({ ok, activeProfile });
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
