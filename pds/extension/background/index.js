// background/index.js — PDS Service Worker (Manifest V3, ES module)
// Owns tab interception and the in-memory blocklist. All auth/session and
// Supabase query logic lives in /core — this file only adapts core calls to
// chrome.tabs / chrome.storage and holds runtime state that's legitimately
// specific to this context (the live blockedHosts set, pause timers).

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import { getValidAccessToken, getStoredSession } from '../../core/auth/session.js';
import { fetchActiveProfile, switchProfile } from '../../core/sync/profiles.js';
import { fetchBlockedUrls } from '../../core/sync/blockedUrls.js';
import { fetchBlockingMode, setBlockingMode, fetchIsPremium } from '../../core/sync/userSettings.js';
import { normalizeToHostname, isNavigableUrl, hostnameOf } from '../../core/blocklist/hostname.js';

// ─── In-memory state ─────────────────────────────────────────────────────────
// Blocked hostnames derived from the user's active profile's blocked_urls rows.
let blockedHosts = new Set();

// Per-profile pause timestamps. Key: profile UUID, value: epoch ms when pause expires.
// Each profile's pause is independent — switching profiles is unaffected.
const profilePauses = new Map();

// The currently active profile row: { id, name } or null.
let activeProfile = null;

// 'friction' (30s breathing bypass) or 'strict' (no bypass). A per-user
// setting, NOT per-profile — see /core/sync/userSettings.js.
let blockingMode = 'friction';

// Strict Mode is a Focus Pro feature. Gated here (not just hidden in the
// popup UI) so a stale/tampered client can't just send SET_BLOCKING_MODE
// directly and get it anyway.
let isPremium = false;

// Refresh interval ID so we can clear it if the user logs out.
let refreshIntervalId = null;

// How often to re-fetch the blocklist from Supabase (ms).
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
 * Starts (or restarts) the periodic blocklist refresh interval.
 */
function startRefreshCycle() {
  if (refreshIntervalId !== null) clearInterval(refreshIntervalId);
  refreshIntervalId = setInterval(refreshBlocklist, REFRESH_INTERVAL_MS);
}

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

  // Respect per-profile pause window set by the breathing UI.
  if (activeProfile) {
    const pauseUntil = profilePauses.get(activeProfile.id);
    if (pauseUntil && Date.now() < pauseUntil) return false;
  }

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
    profilePauses.clear();
    blockingMode = 'friction';
    isPremium = false;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'PAUSE_BLOCKING') {
    if (!activeProfile) { sendResponse({ ok: false }); return true; }
    const durationMs = (message.durationMinutes || 10) * 60 * 1000;
    const pauseUntil = Date.now() + durationMs;
    profilePauses.set(activeProfile.id, pauseUntil);
    console.log(`[PDS] Profile "${activeProfile.name}" paused for ${message.durationMinutes} minute(s).`);
    sendResponse({ ok: true, pauseUntil });
    return true;
  }

  if (message.type === 'GET_STATE') {
    const pauseUntil = activeProfile ? (profilePauses.get(activeProfile.id) ?? null) : null;
    sendResponse({
      blockedCount:  blockedHosts.size,
      blockedHosts:  [...blockedHosts],
      isPaused:      pauseUntil !== null && Date.now() < pauseUntil,
      pauseUntil,
      activeProfile,
      blockingMode,
      isPremium,
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

      const ok = await setBlockingMode(accessToken, session.user.id, mode);
      if (ok) blockingMode = mode;
      sendResponse({ ok, blockingMode, isPremium });
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
