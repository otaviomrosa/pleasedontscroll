// background/index.js — PDS Service Worker (Manifest V3, ES module)
// Owns tab interception and the in-memory blocklist. All auth/session and
// Supabase query logic lives in /core — this file only adapts core calls to
// chrome.tabs / chrome.storage and holds runtime state that's legitimately
// specific to this context (the live blockedEntries array, pause timers).

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import { getValidAccessToken, getStoredSession } from '../../core/auth/session.js';
import { fetchActiveProfile, switchProfile } from '../../core/sync/profiles.js';
import { fetchBlockedUrls } from '../../core/sync/blockedUrls.js';
import { fetchBlockingMode, setBlockingMode, fetchIsPremium, fetchPauseUntil, setPauseUntil } from '../../core/sync/userSettings.js';
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
    console.log('[PDS] No active session. Blocking disabled.');
    return;
  }

  const session = await getStoredSession(chromeStorageAdapter);

  // None of these four depend on each other's result, so run them
  // concurrently instead of one after another — this was the main cost
  // behind GET_STATE's forced refresh feeling slow (see the message
  // listener below): four sequential round trips collapse to the time of
  // the single slowest one. Only fetchBlockedUrls (below) genuinely has to
  // wait, since it needs profile.id from this batch first.
  const [mode, premium, pauseIso, profile] = await Promise.all([
    fetchBlockingMode(accessToken, session.user.id),
    fetchIsPremium(accessToken, session.user.id),
    fetchPauseUntil(accessToken, session.user.id),
    fetchActiveProfile(accessToken),
  ]);

  blockingMode = mode;
  isPremium = premium;
  pausedUntil = pauseIso ? new Date(pauseIso).getTime() : null;

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
  if (alarm.name === REFRESH_ALARM_NAME) refreshBlocklist();
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
  if (!isCandidateForBlocking(url)) return;

  const accessToken = await getValidAccessToken(chromeStorageAdapter);
  if (accessToken) {
    const session = await getStoredSession(chromeStorageAdapter);
    blockingMode = await fetchBlockingMode(accessToken, session.user.id);

    if (blockingMode === 'friction') {
      const freshPauseIso = await fetchPauseUntil(accessToken, session.user.id);
      pausedUntil = freshPauseIso ? new Date(freshPauseIso).getTime() : null;
      if (pausedUntil && Date.now() < pausedUntil) return; // currently paused — let it through
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
  return {
    blockedCount:  uniqueHosts.size,
    blockedHosts:  [...uniqueHosts],
    isPaused:      pausedUntil !== null && Date.now() < pausedUntil,
    pauseUntil:    pausedUntil,
    activeProfile,
    blockingMode,
    isPremium,
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

      const ok = await setBlockingMode(accessToken, session.user.id, mode);
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
      }
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
