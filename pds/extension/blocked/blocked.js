// blocked.js — Friction/Lock intercept screen controller
// Friction Mode: drives the 30-second countdown ring and hands off to
// background.js via chrome.runtime.sendMessage when it completes.
// Lock Mode: no countdown at all — just a message and a close button.

// ─── Constants ────────────────────────────────────────────────────────────────

const COUNTDOWN_SECONDS = 30;

// SVG ring circumference (matches CSS --ring-circum: 2π × r=100 ≈ 628.318).
const RING_CIRCUMFERENCE = 628.318;

// How long the completion overlay is shown before redirecting (ms).
const REDIRECT_DELAY_MS = 1800;

// ─── DOM references ───────────────────────────────────────────────────────────

const countdownEl  = document.getElementById('countdown');
const progressRing = document.getElementById('progressRing');
const siteNameEl   = document.getElementById('siteName');
const modePillEl    = document.getElementById('modePill');

// ─── Extract URL metadata from query params ───────────────────────────────────
// `mode` is set by background.js at redirect time from the user's current
// blocking_mode (a per-user setting, not per-profile — see
// /core/sync/userSettings.js). Defaults to friction if missing/unrecognized.

const params  = new URLSearchParams(window.location.search);
const fromUrl = params.get('from') || '';
const mode    = params.get('mode') === 'strict' ? 'strict' : 'friction';

// Display just the hostname so the user knows where they were headed.
let displayHost = fromUrl;
try {
  displayHost = new URL(fromUrl).hostname.replace(/^www\./, '');
} catch {
  displayHost = fromUrl;
}

if (siteNameEl && displayHost) {
  siteNameEl.textContent = displayHost;
}

if (modePillEl) {
  modePillEl.textContent = mode === 'strict' ? 'Lock Mode' : 'Friction Mode';
  modePillEl.classList.toggle('strict', mode === 'strict');
}

// ─── Progress ring helper ─────────────────────────────────────────────────────

/**
 * Sets the ring fill to represent `fraction` (0 = empty, 1 = full).
 * The ring drains as time passes, so fraction decreases from 1 to 0.
 *
 * @param {number} fraction - A value between 0 and 1.
 */
function setRingProgress(fraction) {
  if (!progressRing) return;
  // stroke-dashoffset of RING_CIRCUMFERENCE = ring invisible (empty).
  // stroke-dashoffset of 0                 = ring fully drawn.
  const offset = RING_CIRCUMFERENCE * (1 - fraction);
  progressRing.style.strokeDashoffset = offset;
}

// ─── Completion ───────────────────────────────────────────────────────────────

/**
 * Called when the countdown reaches zero.
 * 1. Injects and shows the completion overlay.
 * 2. Sends PAUSE_BLOCKING to the service worker.
 * 3. Redirects to the originally requested URL.
 */
function onComplete() {
  // Inject completion overlay DOM (keeps HTML clean).
  const overlay = document.createElement('div');
  overlay.className = 'completion-overlay';
  overlay.innerHTML = `
    <p class="completion-message">Well done.<br>Proceed mindfully.</p>
    <p class="completion-sub">Blocking paused for 10 minutes.</p>
  `;
  document.body.appendChild(overlay);

  // Trigger fade-in on next paint.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add('visible'));
  });

  // Tell the service worker to pause blocking.
  chrome.runtime.sendMessage(
    { type: 'PAUSE_BLOCKING', durationMinutes: 10 },
    () => {
      // After a brief beat, navigate to the original destination.
      setTimeout(() => {
        if (fromUrl) {
          window.location.href = fromUrl;
        }
      }, REDIRECT_DELAY_MS);
    }
  );
}

// ─── Countdown timer ──────────────────────────────────────────────────────────

let secondsLeft = COUNTDOWN_SECONDS;
let countdownInterval = null;

function startCountdown() {
  // Prime the ring to full before the interval fires.
  setRingProgress(1);

  countdownInterval = setInterval(() => {
    secondsLeft -= 1;

    // Update the visible number.
    if (countdownEl) {
      countdownEl.textContent = secondsLeft;
    }

    // Drain the ring proportionally.
    setRingProgress(secondsLeft / COUNTDOWN_SECONDS);

    if (secondsLeft <= 0) {
      clearInterval(countdownInterval);
      onComplete();
    }
  }, 1000);
}

// ─── Leave button ─────────────────────────────────────────────────────────────

document.getElementById('leaveBtn').addEventListener('click', () => {
  clearInterval(countdownInterval);
  chrome.tabs.getCurrent(tab => chrome.tabs.remove(tab.id));
});

// ─── Start everything ─────────────────────────────────────────────────────────
// Lock Mode never runs the countdown flow at all — there is no bypass.
// Only Friction Mode gets the timer.

if (mode === 'strict') {
  document.getElementById('frictionUi').hidden = true;
  document.getElementById('strictUi').hidden = false;
} else {
  startCountdown();
}
