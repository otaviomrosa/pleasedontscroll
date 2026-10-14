import { chromeStorageAdapter } from '../../core/auth/storage.js';
import { getValidAccessToken, getStoredSession, clearSession } from '../../core/auth/session.js';
import { fetchActiveProfile } from '../../core/sync/profiles.js';
import { fetchBlockedUrls } from '../../core/sync/blockedUrls.js';
import { fetchSettingsSnapshot, setTimezoneIfUnset } from '../../core/sync/userSettings.js';
import { startSession, endSession, SESSION_MINUTES } from '../../core/sync/sessions.js';
import { fetchSchedules, applySchedule } from '../../core/sync/schedules.js';
import { activeBlockAt, nextBoundaryAt } from '../../core/schedule/active.js';
import { isNavigableUrl, hostnameOf, parseBlocklistEntry, matchesBlockedEntry } from '../../core/blocklist/hostname.js';
import { formatClockTime } from '../../core/session/time.js';

const STATE_KEY = 'pds_state';
const SITE_PASS_MINUTES = 10;
const REFRESH_ALARM = 'pds-refresh';
const BOUNDARY_ALARM = 'pds-schedule-boundary';
const SESSION_END_ALARM = 'pds-session-end';
const RETRY_ALARM = 'pds-retry';
const BOUNDARY_SLACK_MS = 3000;
const STALE_AFTER_MS = 2 * 60 * 1000;
const NAVIGATION_REFRESH_BACKOFF_MS = 30 * 1000;
const BADGE_COLOR = '#7c3aed';

let blockedEntries = [];
let activeProfile = null;
let blockingMode = 'friction';
let isPremium = false;
let sessionUntil = null;
let sitePasses = {};
let schedules = [];
let lastRefreshAt = 0;
let cachedUserId = null;
let timezoneOfferedFor = null;

const lastSafeUrl = new Map();
let refreshInFlight = null;
let refreshAfterChangePending = null;
let lastRefreshAttemptAt = 0;

function toMs(value) {
  if (!value) return null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function sessionLive() {
  return sessionUntil !== null && Date.now() < sessionUntil;
}

function livePasses() {
  const now = Date.now();
  return Object.fromEntries(Object.entries(sitePasses).filter(([, until]) => until > now));
}

async function saveState() {
  try {
    await chrome.storage.local.set({
      [STATE_KEY]: {
        userId: cachedUserId,
        blockedEntries,
        activeProfile,
        blockingMode,
        isPremium,
        sessionUntil,
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
  sessionUntil = typeof saved.sessionUntil === 'number' ? saved.sessionUntil : null;
  sitePasses = saved.sitePasses && typeof saved.sitePasses === 'object' ? saved.sitePasses : {};
  schedules = Array.isArray(saved.schedules) ? saved.schedules : [];
  lastRefreshAt = saved.lastRefreshAt ?? 0;
  timezoneOfferedFor = saved.timezoneOfferedFor ?? null;
}

async function clearState() {
  blockedEntries = [];
  activeProfile = null;
  blockingMode = 'friction';
  isPremium = false;
  sessionUntil = null;
  sitePasses = {};
  schedules = [];
  lastRefreshAt = 0;
  cachedUserId = null;
  timezoneOfferedFor = null;
  armBoundaryAlarm();
  armSessionEndAlarm();
  updateBadge();
  try {
    await chrome.storage.local.remove(STATE_KEY);
  } catch (err) {
    console.warn('[PDS] Could not clear state:', err);
  }
}

const ready = loadState()
  .catch((err) => console.warn('[PDS] Could not load state:', err))
  .then(() => {
    armSessionEndAlarm();
    updateBadge();
  });

function cacheIsStale() {
  if (Date.now() - lastRefreshAt > STALE_AFTER_MS) return true;
  const boundary = nextBoundaryAt(schedules, new Date(lastRefreshAt));
  if (boundary !== null && boundary.getTime() <= Date.now()) return true;
  return sessionUntil !== null && sessionUntil <= Date.now() && sessionUntil > lastRefreshAt;
}

function hasSitePass(url) {
  return Object.keys(livePasses()).some((hostname) => matchesBlockedEntry(url, { hostname, pathPrefix: null }));
}

function passHostnameFor(url) {
  const matching = blockedEntries.filter((entry) => matchesBlockedEntry(url, entry));
  if (matching.length === 0) return hostnameOf(url);
  return matching.reduce((a, b) => (b.hostname.length < a.hostname.length ? b : a)).hostname;
}

function armBoundaryAlarm() {
  const next = isPremium ? nextBoundaryAt(schedules) : null;
  if (!next) {
    chrome.alarms.clear(BOUNDARY_ALARM);
    return;
  }
  chrome.alarms.create(BOUNDARY_ALARM, { when: next.getTime() + BOUNDARY_SLACK_MS });
}

function armSessionEndAlarm() {
  if (!sessionLive()) {
    chrome.alarms.clear(SESSION_END_ALARM);
    return;
  }
  chrome.alarms.create(SESSION_END_ALARM, { when: sessionUntil + 1000 });
}

function updateBadge() {
  try {
    if (!sessionLive()) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    const minutes = Math.ceil((sessionUntil - Date.now()) / 60000);
    const text = minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
    chrome.action.setBadgeText({ text });
  } catch (err) {
    console.warn('[PDS] Could not update badge:', err);
  }
}

function currentScheduledBlock() {
  if (!isPremium || schedules.length === 0) return null;
  return activeBlockAt(schedules);
}

function strictRefusal() {
  if (blockingMode === 'strict' && sessionLive()) {
    return `Strict Mode is on until ${formatClockTime(sessionUntil)}.`;
  }
  const block = currentScheduledBlock();
  if (block && block.mode === 'strict') return 'A scheduled Strict session is running.';
  return null;
}

function applyServerState(state) {
  if (state.mode === 'friction' || state.mode === 'strict') blockingMode = state.mode;
  const previous = sessionUntil;
  sessionUntil = toMs(state.session_until ?? state.sessionUntil ?? null);
  if (sessionUntil !== null && sessionUntil <= Date.now()) sessionUntil = null;
  if (previous !== sessionUntil) {
    if (!sessionLive() || blockingMode === 'strict') sitePasses = {};
    armSessionEndAlarm();
  }
  updateBadge();
}

async function fetchLiveState(accessToken, userId) {
  const result = await applySchedule(accessToken, userId).catch(() => null);
  if (result && (result.mode === 'friction' || result.mode === 'strict')) {
    return { mode: result.mode, session_until: result.session_until ?? null, profileId: result.profile_id ?? null };
  }
  const settings = await fetchSettingsSnapshot(accessToken, userId).catch(() => null);
  if (!settings) return null;
  return { mode: settings.blockingMode, session_until: settings.sessionUntil, profileId: null };
}

function scheduleRetry() {
  chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 0.5 });
}

function refreshBlocklist() {
  if (!refreshInFlight) {
    refreshInFlight = runRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

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
        console.warn('[PDS] Could not refresh the session. Keeping cached state.');
        scheduleRetry();
        return;
      }
      if (cachedUserId || blockedEntries.length) await clearState();
      return;
    }
    await pullState(accessToken);
  } catch (err) {
    console.warn('[PDS] Refresh failed. Keeping cached state.', err);
    scheduleRetry();
  }
}

async function pullState(accessToken) {
  const session = await getStoredSession(chromeStorageAdapter);
  const userId = session.user.id;

  if (timezoneOfferedFor !== userId) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (await setTimezoneIfUnset(accessToken, userId, zone).catch(() => false)) timezoneOfferedFor = userId;
  }

  const [live, settings] = await Promise.all([
    applySchedule(accessToken, userId).catch(() => null),
    fetchSettingsSnapshot(accessToken, userId).catch(() => null),
  ]);
  const liveOk = live && (live.mode === 'friction' || live.mode === 'strict');
  if (!liveOk && !settings) throw new Error('Could not read the session.');

  if (settings) isPremium = settings.isPremium;
  applyServerState(liveOk ? live : { mode: settings.blockingMode, session_until: settings.sessionUntil });

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
  } else {
    const rows = await fetchBlockedUrls(accessToken, profile.id);
    if (rows === null) throw new Error('Could not load the blocklist.');
    activeProfile = profile;
    blockedEntries = rows.map((row) => parseBlocklistEntry(row.url));
  }

  cachedUserId = userId;
  lastRefreshAt = Date.now();
  await saveState();
}

async function ensureRefreshAlarm() {
  const existing = await chrome.alarms.get(REFRESH_ALARM);
  if (!existing) chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (![REFRESH_ALARM, BOUNDARY_ALARM, RETRY_ALARM, SESSION_END_ALARM].includes(alarm.name)) return;
  await ready;
  updateBadge();
  await refreshBlocklist();
  if (alarm.name === SESSION_END_ALARM) notifyPopup();
});

chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === 'active') refreshBlocklist();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBlocklist();
});

function isCandidateForBlocking(url) {
  if (!isNavigableUrl(url) || blockedEntries.length === 0) return false;
  return blockedEntries.some((entry) => matchesBlockedEntry(url, entry));
}

async function checkAndBlockTab(tabId, url) {
  await ready;
  if (!isNavigableUrl(url)) return;

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
  const live = session ? await fetchLiveState(accessToken, session.user.id) : null;

  if (live) {
    applyServerState(live);
    if (live.profileId && activeProfile && live.profileId !== activeProfile.id) {
      await refreshAfterChange();
      if (!isCandidateForBlocking(url)) {
        lastSafeUrl.set(tabId, url);
        return;
      }
    }
  }

  if (!sessionLive()) {
    lastSafeUrl.set(tabId, url);
    return;
  }

  if (blockingMode === 'friction' && hasSitePass(url)) {
    lastSafeUrl.set(tabId, url);
    return;
  }

  const backUrl = lastSafeUrl.get(tabId);
  const blockedPageUrl =
    chrome.runtime.getURL('extension/blocked/blocked.html') +
    `?from=${encodeURIComponent(url)}&mode=${encodeURIComponent(blockingMode)}` +
    (backUrl ? `&back=${encodeURIComponent(backUrl)}` : '');

  try {
    await chrome.tabs.update(tabId, { url: blockedPageUrl });
  } catch (err) {
    console.warn(`[PDS] Could not redirect tab ${tabId}:`, err);
  }
}

function buildStatePayload() {
  const uniqueHosts = new Set(blockedEntries.map((entry) => entry.hostname));
  const block = currentScheduledBlock();
  return {
    blockedCount: uniqueHosts.size,
    activeProfile,
    blockingMode,
    isPremium,
    sessionUntil: sessionLive() ? sessionUntil : null,
    scheduled: Boolean(block && sessionLive() && block.mode === blockingMode),
    presets: SESSION_MINUTES,
  };
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'STATE_REFRESHED', ...buildStatePayload() }, () => {
    void chrome.runtime.lastError;
  });
}

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
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastSafeUrl.delete(tabId);
});

async function noTokenError() {
  return (await getStoredSession(chromeStorageAdapter))
    ? "Can't reach Please Don't Scroll right now. Try again in a moment."
    : 'Not signed in.';
}

async function sweepOpenTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) checkAndBlockTab(tab.id, tab.url);
}

const handlers = {
  async SESSION_UPDATED() {
    await refreshAfterChange();
    return { ok: true };
  },

  async GET_STATE() {
    refreshBlocklist().then(notifyPopup);
    return buildStatePayload();
  },

  async START_SESSION(message) {
    const accessToken = await getValidAccessToken(chromeStorageAdapter);
    if (!accessToken) return { ok: false, error: await noTokenError() };
    const minutes = Number(message.minutes);
    if (!SESSION_MINUTES.includes(minutes)) return { ok: false, error: 'Pick a length.' };
    const mode = message.mode === 'strict' ? 'strict' : 'friction';
    const session = await getStoredSession(chromeStorageAdapter);
    if (mode === 'strict' && !isPremium) {
      const settings = await fetchSettingsSnapshot(accessToken, session.user.id).catch(() => null);
      if (settings) isPremium = settings.isPremium;
      if (!isPremium) return { ok: false, error: 'Strict Mode is part of Focus Pro.' };
    }
    const { state, error } = await startSession(accessToken, session.user.id, {
      profileId: message.profileId,
      mode,
      minutes,
    });
    if (error) return { ok: false, error, ...buildStatePayload() };
    applyServerState(state);
    sitePasses = {};
    await refreshAfterChange();
    sweepOpenTabs();
    return { ok: true, ...buildStatePayload() };
  },

  async END_SESSION() {
    const refusal = strictRefusal();
    if (refusal) return { ok: false, error: refusal, ...buildStatePayload() };
    const accessToken = await getValidAccessToken(chromeStorageAdapter);
    if (!accessToken) return { ok: false, error: await noTokenError() };
    const session = await getStoredSession(chromeStorageAdapter);
    const { state, error } = await endSession(accessToken, session.user.id);
    if (error) {
      await refreshAfterChange();
      return { ok: false, error, ...buildStatePayload() };
    }
    applyServerState(state);
    await saveState();
    return { ok: true, ...buildStatePayload() };
  },

  async GRANT_SITE_PASS(message) {
    if (blockingMode !== 'friction' || !sessionLive()) return { ok: false, error: 'No Friction session running.' };
    const hostname = passHostnameFor(message.url);
    if (!hostname) return { ok: false, error: 'Unknown site.' };
    sitePasses = { ...livePasses(), [hostname]: Date.now() + SITE_PASS_MINUTES * 60 * 1000 };
    await saveState();
    return { ok: true, hostname, minutes: SITE_PASS_MINUTES };
  },

  async GET_SESSION() {
    return { sessionUntil: sessionLive() ? sessionUntil : null, blockingMode };
  },

  async SIGN_OUT() {
    const accessToken = await getValidAccessToken(chromeStorageAdapter);
    const session = accessToken ? await getStoredSession(chromeStorageAdapter) : null;
    const live = session ? await fetchLiveState(accessToken, session.user.id) : null;
    if (live) applyServerState(live);
    const refusal = strictRefusal();
    if (refusal) return { ok: false, error: `${refusal} You can sign out after it ends.` };
    await clearSession(chromeStorageAdapter);
    await clearState();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  ready
    .then(() => handler(message))
    .then(sendResponse, (err) => {
      console.warn(`[PDS] ${message.type} failed:`, err);
      sendResponse({ ok: false, error: 'Something went wrong. Try again.' });
    });
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'BLOCKLIST_CHANGED') return false;
  refreshAfterChange().then(() => {
    sweepOpenTabs();
    notifyPopup();
    sendResponse({ ok: true });
  });
  return true;
});

async function initialize() {
  await ready;
  await ensureRefreshAlarm();
  armBoundaryAlarm();
  if (cacheIsStale()) await refreshBlocklist();
  await sweepOpenTabs();
}

initialize();
