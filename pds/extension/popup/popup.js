// popup/popup.js — PDS Extension Popup (ES module)
// Handles authentication + profile management UI, imports session/query
// logic from /core, and tells background.js when the session changes.

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import * as Auth from '../../core/auth/session.js';
import { fetchProfiles } from '../../core/sync/profiles.js';
import { isIndefinitePause } from '../../core/sync/userSettings.js';
import { DASHBOARD_URL, PRICING_URL } from '../../core/config.js';
import { isValidEmail, isValidPassword, MIN_PASSWORD_LENGTH } from '../../core/validation.js';

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
    empty.textContent = 'No profiles found.';
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
}

/**
 * Sends SWITCH_PROFILE to the background service worker, then re-renders the
 * pill list and refreshes the stat line to reflect the new profile.
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
// Persistent descriptive text under the toggle (what each mode does, why
// Strict is locked) was removed per the founder's request — too much
// standing text in a popup opened many times a day, and the mechanic is
// self-explanatory once actually experienced (the breathing screen, the
// no-bypass screen). The one piece kept: why Strict is locked for a free
// account, since that's not obvious just from the lock icon — moved to a
// hover title on the button itself (zero visual weight at rest) instead
// of a persistent line of text.
const MODE_HINT_LOCKED = 'Strict Mode is a Focus Pro feature.';

// Set from GET_STATE — see refreshStatRow(). Strict Mode is gated
// server-side too (background.js re-checks before honoring the switch);
// this only controls what the popup shows/allows, not the source of truth.
let isPremium = false;

/**
 * Reflects the given mode in the toggle buttons, plus the Strict Mode
 * lock icon/tooltip based on the last-known isPremium value.
 * @param {'friction' | 'strict'} mode
 */
function renderModeToggle(mode) {
  document.querySelectorAll('.mode-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const strictBtn = document.getElementById('mode-strict-btn');
  strictBtn.classList.toggle('locked', !isPremium);
  strictBtn.title = isPremium ? '' : MODE_HINT_LOCKED;
  document.getElementById('strict-lock-icon').classList.toggle('hidden', isPremium);
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

  // Switching into Strict Mode also clears any active pause server-side
  // (see background/index.js's SET_BLOCKING_MODE handler) — refresh the
  // status dot/pause bar so that shows up immediately in this same popup
  // session, instead of only on the next time the popup happens to be
  // reopened.
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
 * Renders the stat line (blocked count / paused-until, plus the mode
 * toggle) from a state object — shared by refreshStatRow()'s own
 * GET_STATE reply and the STATE_REFRESHED push background.js sends once
 * its live re-check completes (see the onMessage listener below).
 */
function applyState(state) {
  isPremium = state.isPremium === true;
  document.getElementById('pro-tag').classList.toggle('hidden', !isPremium);
  renderModeToggle(state.blockingMode ?? 'friction');

  const statLine = document.getElementById('stat-line');

  if (state.isPaused && state.pauseUntil) {
    // "Paused indefinitely" / "Paused until X" — was "Unblocked until X"
    // (and "Unblocked until you resume it" for the indefinite case), but
    // that indefinite phrasing was the single longest string .stat-line
    // could ever show (30 chars) and was dictating the popup's minimum
    // width on its own. This tops out at 22 chars ("Paused until 11:45
    // PM") instead.
    statLine.textContent = isIndefinitePause(state.pauseUntil)
      ? 'Paused indefinitely'
      : `Paused until ${new Date(state.pauseUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    statLine.classList.add('paused');
  } else if (state.blockedCount > 0) {
    statLine.textContent = `${state.blockedCount} sites blocked`;
    statLine.classList.remove('paused');
  } else {
    statLine.textContent = 'No sites blocked yet';
    statLine.classList.remove('paused');
  }
}

/**
 * Refreshes the stat line from the background state. background.js
 * answers GET_STATE instantly from its own cache (see its comment in the
 * message listener) rather than waiting on a live Supabase re-check —
 * that re-check happens after, in the background, and arrives here as a
 * STATE_REFRESHED push if anything actually changed.
 */
async function refreshStatRow() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    applyState(state);
  } catch {
    document.getElementById('stat-line').textContent = 'Syncing…';
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

    // DASHBOARD_URL, not the extension's own chrome-extension:// origin —
    // an email link can't reasonably target an unpublished extension popup,
    // same reasoning "Change password"/password-reset are dashboard-only
    // (see core/auth/session.js). Without this, the confirmation link falls
    // back to Supabase's Site URL default instead.
    const { session, error } = await Auth.signUp(email, password, DASHBOARD_URL);

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
});
