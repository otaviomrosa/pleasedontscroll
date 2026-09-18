// popup/popup.js — PDS Extension Popup (ES module)
// Handles authentication + profile management UI, imports session/query
// logic from /core, and tells background.js when the session changes.

import { chromeStorageAdapter } from '../../core/auth/storage.js';
import * as Auth from '../../core/auth/session.js';
import { fetchProfiles } from '../../core/sync/profiles.js';
import { isIndefinitePause } from '../../core/sync/userSettings.js';
import { DASHBOARD_URL, PRICING_URL } from '../../core/config.js';
import { isValidEmail } from '../../core/validation.js';

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
const viewConfirm = document.getElementById('view-confirm');

function showView(view) {
  [viewApp, viewAuth, viewConfirm].forEach(v => {
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

/** Same as setError, but for the resend-email result specifically —
 * neutral-colored on success rather than alarm-red (see .auth-error.neutral
 * in popup.css), still red on failure. */
function setResendResult(el, msg, isError) {
  el.textContent = msg;
  el.classList.toggle('neutral', !isError);
  el.classList.remove('hidden');
}

// ─── Profile pill rendering ───────────────────────────────────────────────────

// The last profile list rendered, so applyState() can re-render the pills
// when the mode or premium flag changes after they were first drawn
// (renderAppView() fetches profiles and state concurrently, so the first
// render can't know either yet).
let lastProfiles = null;

// Same lock glyph the mode toggle uses (popup.html) — currentColor.
const LOCK_SVG = `<svg class="lock-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2.5"/>
  <path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" stroke-width="2.5"/>
</svg>`;

/**
 * Renders profile pills into #profile-pills.
 * Clicking an inactive pill sends SWITCH_PROFILE to the service worker.
 *
 * @param {Array<{id: string, name: string, is_active: boolean}>} profiles
 */
function renderProfilePills(profiles) {
  lastProfiles = profiles;
  const container = document.getElementById('profile-pills');
  container.innerHTML = '';

  if (profiles.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'profiles-empty';
    empty.textContent = 'No profiles found.';
    container.appendChild(empty);
    return;
  }

  // Two unrelated reasons a pill can be locked, same as the dashboard's
  // tabs: profiles[0] is the oldest (fetchProfiles orders by
  // created_at.asc) — the one a free account keeps; anything after it is
  // Focus-Pro-only (enforced by 007_profile_limit.sql, not here). And in
  // Strict Mode switching is simply unavailable (switch_active_profile()
  // refuses it, 011/016), so a non-active pill isn't clickable at all —
  // it used to send the request and show the refusal afterwards. Pro
  // takes priority when both apply, since pricing is the useful click.
  profiles.forEach((profile, index) => {
    const proLocked  = !isPremium && index > 0;
    const modeLocked = !proLocked && currentBlockingMode === 'strict' && !profile.is_active;

    const pill = document.createElement('button');
    pill.className = `profile-pill${profile.is_active ? ' active' : ''}${(proLocked || modeLocked) ? ' locked' : ''}${modeLocked ? ' mode-locked' : ''}`;
    pill.dataset.profileId = profile.id;

    // .profile-pill-name truncates with an ellipsis (see popup.css), so
    // the full name is still reachable via the native tooltip.
    const name = document.createElement('span');
    name.className = 'profile-pill-name';
    name.textContent = profile.name;
    pill.appendChild(name);
    pill.title = profile.name;

    if (proLocked || modeLocked) pill.insertAdjacentHTML('beforeend', LOCK_SVG);

    if (proLocked) {
      pill.title = 'Unlock more profiles with Focus Pro';
      pill.addEventListener('click', () => chrome.tabs.create({ url: PRICING_URL }));
    } else if (modeLocked) {
      pill.title = scheduledStrictUntil !== null
        ? scheduledStrictMessage()
        : 'Leave Strict Mode to switch profiles';
      pill.setAttribute('aria-disabled', 'true');
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

  const response = await chrome.runtime.sendMessage({ type: 'SWITCH_PROFILE', profileId });
  // A refusal (Strict Mode, or a scheduled Strict block until X) used to
  // just snap the pills back with no explanation.
  if (response && !response.ok) showModeNotice(response.error || 'Could not switch profile.');

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

// Also from GET_STATE. Read by renderProfilePills(): in Strict Mode the
// other profiles render locked instead of clickable.
let currentBlockingMode = 'friction';

// Epoch ms when the scheduled Strict block currently in force ends, or
// null when none is (from GET_STATE's scheduledStrictUntil). While set,
// the Friction option is locked: the server refuses to leave Strict until
// the block ends, so offering the 30s hold would be a lie.
let scheduledStrictUntil = null;

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function scheduledStrictMessage() {
  return `Scheduled Strict until ${formatClock(scheduledStrictUntil)}`;
}

let modeNoticeTimer = null;

/**
 * Renders #mode-status: the standing schedule line when a block is in
 * force, otherwise hidden — unless a transient notice is showing.
 */
function renderModeStatus() {
  if (modeNoticeTimer) return; // a notice is on screen; it restores this when it clears
  const el = document.getElementById('mode-status');
  el.classList.remove('notice');
  if (scheduledStrictUntil) {
    el.textContent = scheduledStrictMessage();
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/**
 * Shows a short-lived message in the same line (a refused mode or profile
 * change, with the server's own reason), then hands the line back to
 * renderModeStatus().
 */
function showModeNotice(message) {
  const el = document.getElementById('mode-status');
  clearTimeout(modeNoticeTimer);
  el.textContent = message;
  el.classList.add('notice');
  el.classList.remove('hidden');
  modeNoticeTimer = setTimeout(() => {
    modeNoticeTimer = null;
    renderModeStatus();
  }, 4000);
}

/**
 * Reflects the given mode in the toggle buttons, plus the Strict Mode
 * lock icon/tooltip based on the last-known isPremium value, and the
 * Friction lock while a scheduled Strict block is in force.
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

  const frictionLocked = scheduledStrictUntil !== null && mode === 'strict';
  const frictionBtn = document.getElementById('mode-friction-btn');
  frictionBtn.classList.toggle('locked', frictionLocked);
  frictionBtn.title = frictionLocked ? scheduledStrictMessage() : '';
  document.getElementById('friction-lock-icon').classList.toggle('hidden', !frictionLocked);

  renderModeStatus();
}

/**
 * Sends SET_BLOCKING_MODE to the background service worker and reflects
 * the result (or reverts the UI and explains why if the write failed).
 * @param {'friction' | 'strict'} mode
 */
async function handleSetMode(mode) {
  renderModeToggle(mode); // optimistic
  const response = await chrome.runtime.sendMessage({ type: 'SET_BLOCKING_MODE', mode });
  renderModeToggle(response?.ok ? response.blockingMode : (response?.blockingMode ?? mode));
  if (response && !response.ok && response.error) showModeNotice(response.error);

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
  const wasPremium = isPremium;
  const prevMode   = currentBlockingMode;
  isPremium = state.isPremium === true;
  currentBlockingMode = state.blockingMode === 'strict' ? 'strict' : 'friction';
  scheduledStrictUntil = typeof state.scheduledStrictUntil === 'number' ? state.scheduledStrictUntil : null;
  document.getElementById('pro-tag').classList.toggle('hidden', !isPremium);
  renderModeToggle(currentBlockingMode);

  // The pills depend on both flags; redraw them if either just changed.
  if (lastProfiles && (wasPremium !== isPremium || prevMode !== currentBlockingMode)) {
    renderProfilePills(lastProfiles);
  }

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
  const loginBtn    = document.getElementById('login-btn');
  const authError   = document.getElementById('auth-error');
  const authResend  = document.getElementById('auth-resend');

  loginBtn.addEventListener('click', async () => {
    clearError(authError);
    authResend.classList.add('hidden');
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

    if (error) {
      setError(authError, error);
      // Only "email not confirmed" gets a resend offer — the one sign-in
      // failure where we reliably know (from Supabase's own distinct
      // error) that resending is the right next step, unlike a repeat
      // signup attempt, which is deliberately ambiguous about whether the
      // account already existed (see resendConfirmationEmail's own
      // comment in core/auth/session.js).
      if (error.toLowerCase().includes('confirm your email')) {
        authResend.classList.remove('hidden');
      }
      return;
    }

    await persistSession(session);
    await renderAppView(session.access_token);
  });

  document.getElementById('login-resend-link').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email-input').value.trim();
    if (!isValidEmail(email)) return;

    // DASHBOARD_URL — same reasoning as signup below, an email link can't
    // reasonably target an unpublished extension popup.
    const { ok, error } = await Auth.resendConfirmationEmail(email, DASHBOARD_URL);
    setResendResult(authError, ok ? 'Confirmation email sent.' : (error || 'Could not resend. Please try again.'), !ok);
  });

  // ── Enter key on login fields ───────────────────────────────────────────────
  ['email-input', 'password-input'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loginBtn.click();
    });
  });

  // ── Signup / forgot password — both open the dashboard rather than an
  // in-popup form. Account creation used to be a full second form here,
  // duplicating the dashboard's own signup with no real benefit — one
  // account-creation surface is enough, and it kept this file in sync with
  // a second, independent auth flow that's since caused real bugs of its
  // own (see the resend-confirmation and expired-link work above/in
  // dashboard.html). Password reset was already dashboard-only for the
  // same "an email link can't target an unpublished extension popup"
  // reason signUp()'s redirectTo argument uses — this just makes the
  // popup's own UI honest about that instead of having no forgot-password
  // affordance at all. ──────────────────────────────────────────────────
  // ?view=signup / ?view=forgot — tells dashboard.html's checkForViewParam()
  // to land directly on that specific card instead of the default sign-in
  // screen. Without this, both links opened the dashboard but always to
  // plain sign-in, since boot() had no way to know the click meant
  // "specifically show signup/forgot," not just "open the dashboard."
  document.getElementById('signup-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `${DASHBOARD_URL}?view=signup` });
  });

  document.getElementById('forgot-password-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `${DASHBOARD_URL}?view=forgot` });
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
        // A scheduled Strict block can't be left until it ends — the
        // server would refuse after the 30s hold anyway, so say so now
        // instead of making the user sit through a hold that can't succeed.
        if (scheduledStrictUntil !== null) {
          showModeNotice(`Strict Mode is scheduled until ${formatClock(scheduledStrictUntil)}.`);
          return;
        }
        startFrictionConfirm();
      } else {
        handleSetMode(btn.dataset.mode);
      }
    });
  });

  document.getElementById('confirm-cancel-btn').addEventListener('click', cancelFrictionConfirm);
});
