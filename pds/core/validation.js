// Shared input-validation helpers, used wherever the extension or web app
// takes free-text input (email, password, profile name). Hand-rolled, not a
// library — this repo doesn't add dependencies without asking (see
// docs/ARCHITECTURE.md §8), and these checks are simple enough not to need one.
//
// These are UX/data-hygiene checks, not a security boundary — RLS and
// Supabase Auth's own server-side rules are what actually enforce
// correctness. The goal here is catching obvious mistakes (typo'd email,
// empty profile name, "hello world" typed into the blocklist box) before a
// round trip to the server, not defending against a malicious client.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Loose but real email shape check — not RFC 5322-complete, just enough to
 * catch "forgot the @" / "forgot the domain" typos before hitting Supabase. */
export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// Matches Supabase Auth's own default minimum, so client-side and
// server-side rejection agree — don't lower this without also checking the
// project's Auth settings (Authentication → Policies → Password).
export const MIN_PASSWORD_LENGTH = 6;

export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

// Matches the maxlength="28" set on dashboard.html's profile-name input
// (the only one — popup.html has no profile-creation UI of its own, see
// docs/ARCHITECTURE.md) — keep these in sync if either changes. Lowered from 40:
// the extension popup renders active/locked profiles as pills too
// (.profile-pill), and a name near 40 characters could overflow the
// popup's own width (290px, minus padding) — 28 is short enough to fit
// comfortably as a single pill even at the popup's narrower width.
export const MAX_PROFILE_NAME_LENGTH = 28;

/** Non-empty (after trim) and within the length both inputs already cap at.
 * Rendered via textContent everywhere it's displayed, so this isn't an XSS
 * defense — just a "don't save garbage" check. */
export function isValidProfileName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed.length > 0 && trimmed.length <= MAX_PROFILE_NAME_LENGTH;
}
