import { chromeStorageAdapter } from '../../core/auth/storage.js';
import * as Auth from '../../core/auth/session.js';
import { fetchProfiles } from '../../core/sync/profiles.js';
import { SESSION_MINUTES } from '../../core/sync/sessions.js';
import { sessionRemainingMs, formatCountdown, formatMinutesLabel, formatClockTime } from '../../core/session/time.js';
import { DASHBOARD_URL, PRICING_URL } from '../../core/config.js';
import { isValidEmail } from '../../core/validation.js';

const PREFS_KEY = 'pds_popup_prefs';
const ARM_MS = 3000;
const LOCK_ICON = '<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const $ = (id) => document.getElementById(id);

const views = { loading: $('view-loading'), auth: $('view-auth'), app: $('view-app') };

let state = { isPremium: false, blockingMode: 'friction', sessionUntil: null, scheduled: false, activeProfile: null, blockedCount: 0 };
let prefs = { mode: 'friction', profileId: null, minutes: 30, startedAt: null, startedUntil: null };
let profiles = [];
let ticker = null;
let armedUntil = 0;
let armTimer = null;
let noteTimer = null;
let busy = false;

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  $('menu-wrap').hidden = name !== 'app';
}

async function loadPrefs() {
  const saved = await chromeStorageAdapter.get(PREFS_KEY);
  if (saved && typeof saved === 'object') prefs = { ...prefs, ...saved };
  if (!SESSION_MINUTES.includes(prefs.minutes)) prefs.minutes = 30;
  if (prefs.mode !== 'strict') prefs.mode = 'friction';
}

function savePrefs() {
  chromeStorageAdapter.set(PREFS_KEY, prefs);
}

function isRunning() {
  return sessionRemainingMs(state.sessionUntil) > 0;
}

function selectableProfiles() {
  return profiles.filter((_, index) => state.isPremium || index === 0);
}

function selectedProfile() {
  if (isRunning() && state.activeProfile) {
    return profiles.find((p) => p.id === state.activeProfile.id) ?? state.activeProfile;
  }
  const allowed = selectableProfiles();
  return allowed.find((p) => p.id === prefs.profileId)
    ?? allowed.find((p) => p.is_active)
    ?? allowed[0]
    ?? state.activeProfile;
}

function selectedMode() {
  if (isRunning()) return state.blockingMode;
  return prefs.mode === 'strict' && state.isPremium ? 'strict' : 'friction';
}

function sessionTotalMs() {
  const remaining = sessionRemainingMs(state.sessionUntil);
  if (prefs.startedUntil && prefs.startedAt && prefs.startedUntil === state.sessionUntil) {
    return Math.max(remaining, prefs.startedUntil - prefs.startedAt);
  }
  const preset = SESSION_MINUTES.map((m) => m * 60000).find((ms) => ms >= remaining);
  return preset ?? remaining;
}

function setNote(message, isError = false) {
  clearTimeout(noteTimer);
  const note = $('note');
  note.textContent = message;
  note.classList.toggle('is-error', isError);
  if (isError) noteTimer = setTimeout(() => renderNote(), 4500);
}

function renderNote() {
  if (isRunning()) {
    const count = state.blockedCount;
    setNote(count === 1 ? '1 site blocked' : `${count} sites blocked`);
  } else {
    setNote('Sites stay blocked until the timer ends.');
  }
}

function syncSegmented(el) {
  const buttons = [...el.querySelectorAll(':scope > button')];
  const index = buttons.findIndex((b) => b.classList.contains('is-on'));
  el.style.setProperty('--segments', String(buttons.length));
  el.style.setProperty('--active', String(Math.max(index, 0)));
  el.toggleAttribute('data-none', index < 0);
}

function renderMode() {
  const running = isRunning();
  const mode = selectedMode();
  const control = $('mode-control');
  control.classList.toggle('is-frozen', running);
  for (const btn of control.querySelectorAll('button')) {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
  }
  $('strict-pro').hidden = state.isPremium;
  syncSegmented(control);
}

function renderLength() {
  const running = isRunning();
  const control = $('length-control');
  control.classList.toggle('is-frozen', running);
  if (!control.childElementCount) {
    for (const minutes of SESSION_MINUTES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.minutes = String(minutes);
      btn.setAttribute('role', 'radio');
      btn.textContent = formatMinutesLabel(minutes);
      btn.addEventListener('click', () => {
        if (isRunning()) return;
        prefs.minutes = minutes;
        savePrefs();
        render();
      });
      control.appendChild(btn);
    }
  }
  const startedMinutes = running && prefs.startedUntil === state.sessionUntil && prefs.startedAt
    ? Math.round((prefs.startedUntil - prefs.startedAt) / 60000)
    : null;
  for (const btn of control.querySelectorAll('button')) {
    const minutes = Number(btn.dataset.minutes);
    const on = running ? minutes === startedMinutes : minutes === prefs.minutes;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
  }
  syncSegmented(control);
}

function renderProfile() {
  const running = isRunning();
  const profile = selectedProfile();
  $('profile-value').textContent = profile?.name ?? 'Default';
  $('profile-btn').disabled = running || profiles.length < 2;
  if (running || profiles.length < 2) closeProfileMenu();
}

function renderProfileMenu() {
  const menu = $('profile-menu');
  menu.replaceChildren();
  const current = selectedProfile();
  profiles.forEach((profile, index) => {
    const locked = !state.isPremium && index > 0;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `menu-item${profile.id === current?.id ? ' is-on' : ''}${locked ? ' is-locked' : ''}`;
    item.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = profile.name;
    item.appendChild(name);
    if (locked) item.insertAdjacentHTML('beforeend', LOCK_ICON);
    else if (profile.id === current?.id) item.insertAdjacentHTML('beforeend', CHECK_ICON);
    item.title = locked ? 'More profiles come with Focus Pro' : profile.name;
    item.addEventListener('click', () => {
      if (locked) {
        chrome.tabs.create({ url: PRICING_URL });
        return;
      }
      prefs.profileId = profile.id;
      savePrefs();
      closeProfileMenu();
      render();
    });
    menu.appendChild(item);
  });
}

function openProfileMenu() {
  renderProfileMenu();
  $('profile-menu').hidden = false;
  $('profile-btn').setAttribute('aria-expanded', 'true');
}

function closeProfileMenu() {
  $('profile-menu').hidden = true;
  $('profile-btn').setAttribute('aria-expanded', 'false');
}

function renderDial() {
  const running = isRunning();
  const dial = $('dial');
  const mode = selectedMode();
  dial.classList.toggle('is-running', running);
  dial.classList.toggle('is-strict', mode === 'strict');
  const time = $('dial-time');
  const fill = $('dial-fill');

  if (running) {
    const remaining = sessionRemainingMs(state.sessionUntil);
    const fraction = Math.min(1, remaining / Math.max(1, sessionTotalMs()));
    $('dial-label').textContent = state.scheduled ? 'Scheduled session' : mode === 'strict' ? 'Strict session' : 'Keep going!';
    time.textContent = formatCountdown(remaining);
    $('dial-sub').textContent = `until ${formatClockTime(state.sessionUntil)}`;
    fill.style.strokeDashoffset = String(1000 * (1 - fraction));
  } else {
    $('dial-label').textContent = '';
    time.textContent = formatCountdown(prefs.minutes * 60000);
    $('dial-sub').textContent = '';
    fill.style.strokeDashoffset = '1000';
  }
  time.classList.toggle('is-long', time.textContent.length > 5);
}

function renderAction() {
  const btn = $('primary-btn');
  const running = isRunning();
  btn.className = 'btn btn-lg btn-block';
  btn.disabled = busy;
  if (!running) {
    btn.classList.add('btn-primary');
    btn.textContent = busy ? 'Starting…' : 'Start focusing';
    return;
  }
  if (state.blockingMode === 'strict') {
    btn.classList.add('btn-locked');
    btn.disabled = true;
    btn.innerHTML = `${LOCK_ICON}<span></span>`;
    btn.querySelector('span').textContent = `Locked until ${formatClockTime(state.sessionUntil)}`;
    return;
  }
  btn.classList.add('btn-danger');
  const armed = Date.now() < armedUntil;
  btn.classList.toggle('is-armed', armed);
  btn.textContent = busy ? 'Ending…' : armed ? 'Click again to end' : 'End session';
}

function render() {
  renderMode();
  renderProfile();
  renderLength();
  renderDial();
  renderAction();
  if (!$('note').classList.contains('is-error')) renderNote();
  syncTicker();
}

function syncTicker() {
  if (isRunning() && !ticker) {
    ticker = setInterval(() => {
      if (!isRunning()) {
        clearInterval(ticker);
        ticker = null;
        state.sessionUntil = null;
        render();
        refreshState();
        return;
      }
      renderDial();
    }, 1000);
  } else if (!isRunning() && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function applyState(next) {
  if (!next || typeof next !== 'object') return;
  state = {
    isPremium: next.isPremium === true,
    blockingMode: next.blockingMode === 'strict' ? 'strict' : 'friction',
    sessionUntil: typeof next.sessionUntil === 'number' ? next.sessionUntil : null,
    scheduled: next.scheduled === true,
    activeProfile: next.activeProfile ?? null,
    blockedCount: next.blockedCount ?? 0,
  };
  render();
}

async function refreshState() {
  try {
    applyState(await chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  } catch {
    setNote('Syncing…');
  }
}

async function loadProfiles(accessToken) {
  const rows = await fetchProfiles(accessToken).catch(() => null);
  if (Array.isArray(rows)) profiles = rows;
  render();
}

async function renderApp(accessToken) {
  showView('app');
  render();
  await Promise.all([refreshState(), loadProfiles(accessToken)]);
}

async function startSession() {
  const profile = selectedProfile();
  if (!profile) {
    setNote('Add a profile on the dashboard first.', true);
    return;
  }
  busy = true;
  render();
  const minutes = prefs.minutes;
  const response = await chrome.runtime.sendMessage({
    type: 'START_SESSION',
    profileId: profile.id,
    mode: selectedMode(),
    minutes,
  }).catch(() => null);
  busy = false;
  if (!response?.ok) {
    render();
    setNote(response?.error || 'Could not start. Try again.', true);
    shake($('primary-btn'));
    return;
  }
  prefs.startedAt = Date.now();
  prefs.startedUntil = response.sessionUntil;
  prefs.profileId = profile.id;
  savePrefs();
  applyState(response);
}

async function endSession() {
  if (Date.now() >= armedUntil) {
    armedUntil = Date.now() + ARM_MS;
    clearTimeout(armTimer);
    armTimer = setTimeout(renderAction, ARM_MS);
    renderAction();
    return;
  }
  armedUntil = 0;
  busy = true;
  renderAction();
  const response = await chrome.runtime.sendMessage({ type: 'END_SESSION' }).catch(() => null);
  busy = false;
  if (!response?.ok) {
    applyState(response);
    setNote(response?.error || 'Could not end the session.', true);
    return;
  }
  applyState(response);
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function setFormMsg(message, neutral = false) {
  const el = $('auth-error');
  el.textContent = message;
  el.classList.toggle('is-neutral', neutral);
  el.hidden = !message;
}

async function boot() {
  $('menu-dashboard').href = DASHBOARD_URL;
  await loadPrefs();
  const accessToken = await Auth.getValidAccessToken(chromeStorageAdapter);
  if (accessToken) await renderApp(accessToken);
  else showView('auth');
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_REFRESHED') applyState(message);
});

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormMsg('');
  $('login-resend-link').hidden = true;
  const email = $('email-input').value.trim();
  const password = $('password-input').value;
  if (!isValidEmail(email) || !password) {
    setFormMsg('Enter your email and password.');
    return;
  }
  const btn = $('login-btn');
  btn.textContent = 'Signing in…';
  btn.disabled = true;
  const { session, error } = await Auth.signIn(email, password);
  btn.textContent = 'Sign in';
  btn.disabled = false;
  if (error) {
    setFormMsg(error);
    if (error.toLowerCase().includes('confirm your email')) $('login-resend-link').hidden = false;
    return;
  }
  await Auth.persistSession(chromeStorageAdapter, session);
  await chrome.runtime.sendMessage({ type: 'SESSION_UPDATED' }).catch(() => null);
  await renderApp(session.access_token);
});

$('login-resend-link').addEventListener('click', async () => {
  const email = $('email-input').value.trim();
  if (!isValidEmail(email)) return;
  const { ok, error } = await Auth.resendConfirmationEmail(email, DASHBOARD_URL);
  setFormMsg(ok ? 'Confirmation email sent.' : (error || 'Could not resend. Try again.'), ok);
});

$('signup-link').addEventListener('click', () => chrome.tabs.create({ url: `${DASHBOARD_URL}?view=signup` }));
$('forgot-password-link').addEventListener('click', () => chrome.tabs.create({ url: `${DASHBOARD_URL}?view=forgot` }));

$('mode-control').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-mode]');
  if (!btn || isRunning()) return;
  if (btn.dataset.mode === 'strict' && !state.isPremium) {
    chrome.tabs.create({ url: PRICING_URL });
    return;
  }
  prefs.mode = btn.dataset.mode;
  savePrefs();
  render();
});

$('profile-btn').addEventListener('click', (event) => {
  event.stopPropagation();
  if ($('profile-menu').hidden) openProfileMenu();
  else closeProfileMenu();
});

$('primary-btn').addEventListener('click', () => {
  if (busy) return;
  if (isRunning()) endSession();
  else startSession();
});

$('menu-btn').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = $('menu');
  menu.hidden = !menu.hidden;
  $('menu-btn').setAttribute('aria-expanded', String(!menu.hidden));
});

$('menu-signout').addEventListener('click', async () => {
  $('menu').hidden = true;
  const response = await chrome.runtime.sendMessage({ type: 'SIGN_OUT' }).catch(() => null);
  if (response?.ok) {
    profiles = [];
    showView('auth');
    return;
  }
  setNote(response?.error || 'Could not sign out. Try again.', true);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#menu-wrap')) $('menu').hidden = true;
  if (!event.target.closest('#profile-picker')) closeProfileMenu();
});

boot();
