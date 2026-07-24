// popup/popup.js — PDS Extension Popup (ES module)
// Handles authentication + profile management UI, imports session/query
// logic from /core, and tells background.js when the session changes.

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import * as Auth from '../../core/auth/session.js';
import { fetchProfiles, createProfile } from '../../core/sync/profiles.js';
import { isIndefinitePause } from '../../core/sync/userSettings.js';
import { DASHBOARD_URL, PRICING_URL } from '../../core/config.js';
import { isValidEmail, isValidPassword, isValidProfileName, MIN_PASSWORD_LENGTH } from '../../core/validation.js';

// ─── Session persistence (adds background notification on top of /core) ──────

async function persistSession(session) {
  await Auth.persistSession(chromeStorageAdapter, session);
  await chrome.runtime.sendMessage({ type: 'SESSION_UPDATED' });
}

async function clearSessionAndNotify() {
  await Auth.clearSession(chromeStorageAdapter);
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
}

async function getValidAccessToken() {
  return Auth.getValidAccessToken(chromeStorageAdapter);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

const viewApp     = document.getElementById('view-app');
const viewAuth    = document.getElementById('view-auth');
const viewSignup  = document.getElementById('view-signup');
const viewConfirm = document.getElementById('view-confirm');

function showView(view) {
  [viewApp, viewAuth, viewSignup, viewConfirm].forEach(v => {
    v.style.display = 'none';
    v.classList.add('hidden');
  });
  view.style.display = 'block';
  view.classList.remove('hidden');
}

function setError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError(el) {
  el.textContent = '';
  el.classList.add('hidden');
}

// ─── Profile pill rendering ───────────────────────────────────────────────────

/**
 * Renders profile pills into #profile-pills.
 * Clicking an inactive pill sends SWITCH_PROFILE to the service worker.
 *
 * @param {Array<{id: string, name: string, is_active: boolean}>} profiles
 */
function renderProfilePills(profiles) {
  const container = document.getElementById('profile-pills');
  container.innerHTML = '';

  if (profiles.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'profiles-empty';
    empty.textContent = 'No profiles yet — add one below.';
    container.appendChild(empty);
    return;
  }

  // profiles[0] is the oldest (fetchProfiles orders by created_at.asc) —
  // the one free-tier account keeps. Anything after it is Focus-Pro-only;
  // locked here for free users. Real enforcement is the trigger in
  // 007_profile_limit.sql, not this.
  profiles.forEach((profile, index) => {
    const locked = !isPremium && index > 0;

    const pill = document.createElement('button');
    pill.className = `profile-pill${profile.is_active ? ' active' : ''}${locked ? ' locked' : ''}`;
    pill.textContent = profile.name;
    pill.dataset.profileId = profile.id;

    if (locked) {
      pill.title = 'Unlock more profiles with Focus Pro';
      pill.addEventListener('click', () => chrome.tabs.create({ url: PRICING_URL }));
    } else if (!profile.is_active) {
      pill.addEventListener('click', () => handleSwitchProfile(profile.id));
    }

    container.appendChild(pill);
  });

  document.getElementById('add-profile-btn').classList.toggle('hidden', !isPremium);
}

/**
 * Sends SWITCH_PROFILE to the background service worker, then re-renders the
 * pill list and refreshes the blocked-count stat to reflect the new profile.
 *
 * @param {string} profileId
 */
async function handleSwitchProfile(profileId) {
  // Optimistic: mark all pills inactive, target pill active immediately.
  document.querySelectorAll('.profile-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.profileId === profileId);
    if (p.dataset.profileId === profileId) {
      // Remove click handler while switching is in progress.
      p.replaceWith(p.cloneNode(true));
    }
  });

  await chrome.runtime.sendMessage({ type: 'SWITCH_PROFILE', profileId });

  // Re-fetch profiles and re-render to pick up any server-side changes.
  const accessToken = await getValidAccessToken();
  if (accessToken) renderProfilePills(await fetchProfiles(accessToken));

  // Refresh blocked count from the new profile's state.
  refreshStatRow();
}

// ─── Mode toggle ────────────────────────────────────────────────────────────

const MODE_HINTS = {
  friction: 'Breathe for 30 seconds to unblock websites.',
  strict: 'No bypassing. Switch to Friction mode to unblock.',
};

const MODE_HINT_LOCKED = 'Strict Mode is a Focus Pro feature.';

// Set from GET_STATE — see refreshStatRow(). Strict Mode is gated
// server-side too (background.js re-checks before honoring the switch);
// this only controls what the popup shows/allows, not the source of truth.
let isPremium = false;

/**
 * Reflects the given mode in the toggle buttons and hint text, plus the
 * Strict Mode lock icon based on the last-known isPremium value.
 * @param {'friction' | 'strict'} mode
 */
function renderModeToggle(mode) {
  document.querySelectorAll('.mode-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  document.getElementById('mode-strict-btn').classList.toggle('locked', !isPremium);
  document.getElementById('strict-lock-icon').classList.toggle('hidden', isPremium);

  document.getElementById('mode-hint').textContent = MODE_HINTS[mode] ?? MODE_HINTS.friction;
}

/**
 * Sends SET_BLOCKING_MODE to the background service worker and reflects
 * the result (or reverts the UI if the write failed).
 * @param {'friction' | 'strict'} mode
 */
async function handleSetMode(mode) {
  renderModeToggle(mode); // optimistic
  const response = await chrome.runtime.sendMessage({ type: 'SET_BLOCKING_MODE', mode });
  renderModeToggle(response?.ok ? response.blockingMode : (response?.blockingMode ?? mode));

  // Switching into Strict also clears any active pause server-side (see
  // background/index.js's SET_BLOCKING_MODE handler) — refresh the status
  // dot/pause bar so that shows up immediately in this same popup session,
  // instead of only on the next time the popup happens to be reopened.
  await refreshStatRow();
}

// ─── Strict → Friction confirmation (breathing hold) ───────────────────────
// Leaving Strict Mode costs the same 30s hold as breathing through a
// blocked site — otherwise it's one click away from being pointless.
// Switching the other way (Friction → Strict) stays instant.

const CONFIRM_SECONDS = 30;
const CONFIRM_RING_CIRCUMFERENCE = 628.318; // 2π × r=100, matches the SVG

let confirmInterval = null;

function setConfirmRingProgress(fraction) {
  const ring = document.getElementById('confirm-ring-fill');
  if (ring) ring.style.strokeDashoffset = CONFIRM_RING_CIRCUMFERENCE * (1 - fraction);
}

function startFrictionConfirm() {
  showView(viewConfirm);

  let secondsLeft = CONFIRM_SECONDS;
  document.getElementById('confirm-countdown').textContent = secondsLeft;
  setConfirmRingProgress(1);

  confirmInterval = setInterval(() => {
    secondsLeft -= 1;
    document.getElementById('confirm-countdown').textContent = secondsLeft;
    setConfirmRingProgress(secondsLeft / CONFIRM_SECONDS);

    if (secondsLeft <= 0) {
      clearInterval(confirmInterval);
      confirmInterval = null;
      handleSetMode('friction').then(() => showView(viewApp));
    }
  }, 1000);
}

function cancelFrictionConfirm() {
  clearInterval(confirmInterval);
  confirmInterval = null;
  showView(viewApp);
}

/**
 * Renders the stat row (blocked count, status dot, pause bar, mode toggle)
 * from a state object — shared by refreshStatRow()'s own GET_STATE reply
 * and the STATE_REFRESHED push background.js sends once its live re-check
 * completes (see the onMessage listener below).
 */
function applyState(state) {
  document.getElementById('blocked-count').textContent = state.blockedCount ?? '—';
  isPremium = state.isPremium === true;
  renderModeToggle(state.blockingMode ?? 'friction');

  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');

  if (state.isPaused) {
    dot.className     = 'status-dot paused';
    label.textContent = 'Paused';
  } else if (state.blockedCount > 0) {
    dot.className     = 'status-dot active';
    label.textContent = 'Blocking active';
  } else {
    dot.className     = 'status-dot idle';
    label.textContent = 'No sites blocked yet';
  }

  const pauseBar = document.getElementById('pause-bar');
  if (state.isPaused && state.pauseUntil) {
    pauseBar.classList.remove('hidden');
    document.getElementById('pause-until-label').textContent =
      isIndefinitePause(state.pauseUntil)
        ? 'you resume it'
        : new Date(state.pauseUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    pauseBar.classList.add('hidden');
  }
}

/**
 * Refreshes the blocked-count and status pill from the background state.
 * background.js answers GET_STATE instantly from its own cache (see its
 * comment in the message listener) rather than waiting on a live Supabase
 * re-check — that re-check happens after, in the background, and arrives
 * here as a STATE_REFRESHED push if anything actually changed.
 */
async function refreshStatRow() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    applyState(state);
  } catch {
    document.getElementById('status-label').textContent = 'Syncing…';
    document.getElementById('blocked-count').textContent = '…';
  }
}

// Only matters while the popup is still open — if it's already closed by
// the time background.js's live re-check finishes, this message just goes
// nowhere, which is fine (same as the dashboard's BLOCKLIST_CHANGED poke).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_REFRESHED') applyState(message);
});

// ─── App view render ──────────────────────────────────────────────────────────

/**
 * Renders the full authenticated view — stats + profiles.
 * @param {string} accessToken
 */
async function renderAppView(accessToken) {
  showView(viewApp);
  // Independent of each other (stat row comes from background.js's cache,
  // profiles are a separate direct REST call) — no reason to wait for one
  // before starting the other.
  await Promise.all([
    refreshStatRow(),
    fetchProfiles(accessToken).then(renderProfilePills),
  ]);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  document.getElementById('manage-link').href = DASHBOARD_URL;
  const accessToken = await getValidAccessToken();

  if (accessToken) {
    await renderAppView(accessToken);
  } else {
    showView(viewAuth);
  }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  boot();

  // ── Login form ──────────────────────────────────────────────────────────────
  const loginBtn  = document.getElementById('login-btn');
  const authError = document.getElementById('auth-error');

  loginBtn.addEventListener('click', async () => {
    clearError(authError);
    const email    = document.getElementById('email-input').value.trim();
    const password = document.getElementById('password-input').value;

    if (!isValidEmail(email) || !password) {
      setError(authError, 'Enter a valid email and your password.');
      return;
    }

    loginBtn.textContent = 'Signing in…';
    loginBtn.disabled    = true;

    const { session, error } = await Auth.signIn(email, password);

    loginBtn.textContent = 'Sign in';
    loginBtn.disabled    = false;

    if (error) { setError(authError, error); return; }

    await persistSession(session);
    await renderAppView(session.access_token);
  });

  // ── Enter key on login fields ───────────────────────────────────────────────
  ['email-input', 'password-input'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loginBtn.click();
    });
  });

  // ── Signup navigation ───────────────────────────────────────────────────────
  document.getElementById('signup-link').addEventListener('click', (e) => {
    e.preventDefault();
    showView(viewSignup);
  });

  document.getElementById('back-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    showView(viewAuth);
  });

  // ── Sign-up form ────────────────────────────────────────────────────────────
  const signupBtn   = document.getElementById('signup-btn');
  const signupError = document.getElementById('signup-error');

  signupBtn.addEventListener('click', async () => {
    clearError(signupError);
    const email    = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;

    if (!isValidEmail(email)) {
      setError(signupError, 'Enter a valid email address.');
      return;
    }
    if (!isValidPassword(password)) {
      setError(signupError, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    signupBtn.textContent = 'Creating…';
    signupBtn.disabled    = true;

    const { session, error } = await Auth.signUp(email, password);

    signupBtn.textContent = 'Create account';
    signupBtn.disabled    = false;

    if (error) { setError(signupError, error); return; }

    await persistSession(session);
    await renderAppView(session.access_token);
  });

  // ── Enter key on signup fields ──────────────────────────────────────────────
  ['signup-email', 'signup-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') signupBtn.click();
    });
  });

  // ── Logout ──────────────────────────────────────────────────────────────────
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await clearSessionAndNotify();
    showView(viewAuth);
  });

  // ── Mode toggle ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.mode-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;

      if (btn.dataset.mode === 'strict' && !isPremium) {
        document.getElementById('mode-hint').textContent = MODE_HINT_LOCKED;
        chrome.tabs.create({ url: PRICING_URL });
        return;
      }

      const current = document.querySelector('.mode-option.active')?.dataset.mode;
      if (current === 'strict' && btn.dataset.mode === 'friction') {
        startFrictionConfirm();
      } else {
        handleSetMode(btn.dataset.mode);
      }
    });
  });

  document.getElementById('confirm-cancel-btn').addEventListener('click', cancelFrictionConfirm);

  // ── Add profile button ──────────────────────────────────────────────────────
  document.getElementById('add-profile-btn').addEventListener('click', () => {
    document.getElementById('new-profile-row').classList.remove('hidden');
    document.getElementById('new-profile-input').focus();
  });

  document.getElementById('new-profile-cancel').addEventListener('click', () => {
    document.getElementById('new-profile-row').classList.add('hidden');
    document.getElementById('new-profile-input').value = '';
  });

  document.getElementById('new-profile-confirm').addEventListener('click', async () => {
    const input      = document.getElementById('new-profile-input');
    const name       = input.value.trim();
    const confirmBtn = document.getElementById('new-profile-confirm');

    if (!isValidProfileName(name)) return;

    const accessToken = await getValidAccessToken();
    if (!accessToken) return;

    const session = await Auth.getStoredSession(chromeStorageAdapter);

    confirmBtn.textContent = '…';
    confirmBtn.disabled    = true;

    const newProfile = await createProfile(accessToken, session.user.id, name);

    confirmBtn.textContent = 'Add';
    confirmBtn.disabled    = false;

    if (!newProfile) {
      // Silently fail — profile creation error is uncommon and not worth a full error state.
      input.value = '';
      document.getElementById('new-profile-row').classList.add('hidden');
      return;
    }

    input.value = '';
    document.getElementById('new-profile-row').classList.add('hidden');

    // Re-render pill list to include the new profile.
    renderProfilePills(await fetchProfiles(accessToken));
  });

  // Allow pressing Enter in the new-profile input to confirm.
  document.getElementById('new-profile-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('new-profile-confirm').click();
    if (e.key === 'Escape') document.getElementById('new-profile-cancel').click();
  });
});
