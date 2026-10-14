import { sessionRemainingMs, formatCountdown, formatClockTime } from '../../core/session/time.js';

const BREATH_SECONDS = 30;
const PRESETS_MS = [15, 30, 60, 120, 360].map((m) => m * 60000);

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const fromUrl = params.get('from') || '';
const backUrl = params.get('back') || '';
let mode = params.get('mode') === 'strict' ? 'strict' : 'friction';

let host = '';
try {
  host = new URL(fromUrl).hostname.replace(/^www\./, '');
} catch {
  host = '';
}

let sessionUntil = null;
let totalMs = 0;
let ticker = null;
let breathLeft = BREATH_SECONDS;
let breathTimer = null;
let breathing = false;
let finished = false;

function setFill(fraction) {
  $('timer-fill').style.strokeDashoffset = String(1000 * (1 - Math.max(0, Math.min(1, fraction))));
}

function setTime(text) {
  const el = $('timer-time');
  el.textContent = text;
  el.classList.toggle('is-long', text.length > 5);
}

function renderMode() {
  const strict = mode === 'strict';
  $('mode-chip').classList.toggle('is-strict', strict);
  $('mode-label').textContent = strict ? 'Strict session' : 'Friction session';
  $('timer').classList.toggle('is-strict', strict);
  $('breathe-btn').hidden = strict || finished;
  $('fine').textContent = strict && sessionUntil ? `Strict Mode is on until ${formatClockTime(sessionUntil)}.` : '';
}

function renderSession() {
  if (breathing || finished) return;
  const remaining = sessionRemainingMs(sessionUntil);
  if (remaining <= 0) {
    finishSession();
    return;
  }
  setTime(formatCountdown(remaining));
  setFill(remaining / Math.max(1, totalMs));
}

function finishSession() {
  finished = true;
  clearInterval(ticker);
  setTime('00:00');
  setFill(0);
  $('title').textContent = 'Session over';
  $('lead').textContent = host ? `${host} is open again.` : 'This site is open again.';
  $('timer-label').textContent = 'well done';
  $('breathe-btn').hidden = true;
  $('fine').textContent = '';
  if (fromUrl) setTimeout(() => { window.location.href = fromUrl; }, 1500);
}

function startTicker() {
  clearInterval(ticker);
  renderSession();
  ticker = setInterval(renderSession, 1000);
}

function breathTick() {
  breathLeft -= 1;
  setTime(String(breathLeft));
  setFill(breathLeft / BREATH_SECONDS);
  $('timer-label').textContent = Math.floor((BREATH_SECONDS - breathLeft) / 4) % 2 === 0 ? 'breathe in' : 'breathe out';
  if (breathLeft <= 0) {
    clearInterval(breathTimer);
    breathTimer = null;
    completeBreath();
  }
}

function startBreathTimer() {
  if (breathTimer === null && breathLeft > 0 && document.visibilityState === 'visible') {
    breathTimer = setInterval(breathTick, 1000);
  }
}

function startBreath() {
  breathing = true;
  breathLeft = BREATH_SECONDS;
  $('timer').classList.add('is-breathing');
  $('breathe-btn').hidden = true;
  $('title').textContent = 'Take a breath';
  $('lead').textContent = 'Stay on this tab for 30 seconds. Then decide if you still want it.';
  $('timer-label').textContent = 'breathe in';
  setTime(String(BREATH_SECONDS));
  setFill(1);
  startBreathTimer();
}

function completeBreath() {
  $('title').textContent = 'Go ahead, mindfully';
  $('lead').textContent = host ? `${host} is open for 10 minutes.` : 'This site is open for 10 minutes.';
  $('timer-label').textContent = 'done';
  chrome.runtime.sendMessage({ type: 'GRANT_SITE_PASS', url: fromUrl }, (response) => {
    void chrome.runtime.lastError;
    if (!response?.ok) {
      $('fine').textContent = response?.error || 'Could not open the site.';
      return;
    }
    setTimeout(() => { if (fromUrl) window.location.href = fromUrl; }, 1200);
  });
}

document.addEventListener('visibilitychange', () => {
  if (!breathing) return;
  if (document.visibilityState === 'visible') startBreathTimer();
  else if (breathTimer !== null) {
    clearInterval(breathTimer);
    breathTimer = null;
  }
});

$('title').textContent = host ? `${host} is blocked` : 'This site is blocked';
$('leave-btn').textContent = backUrl ? 'Go back' : 'Close tab';
$('leave-btn').addEventListener('click', () => {
  clearInterval(breathTimer);
  if (backUrl) window.location.href = backUrl;
  else chrome.tabs.getCurrent((tab) => chrome.tabs.remove(tab.id));
});
$('breathe-btn').addEventListener('click', startBreath);
renderMode();

chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (response) => {
  void chrome.runtime.lastError;
  if (response?.blockingMode) mode = response.blockingMode;
  sessionUntil = typeof response?.sessionUntil === 'number' ? response.sessionUntil : null;
  if (!sessionUntil) {
    finishSession();
    return;
  }
  const remaining = sessionRemainingMs(sessionUntil);
  totalMs = PRESETS_MS.find((ms) => ms >= remaining) ?? remaining;
  renderMode();
  startTicker();
});
