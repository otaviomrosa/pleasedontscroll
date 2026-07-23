// Pure URL/hostname matching logic — the rules that decide whether a given
// tab URL counts as "blocked." Written once, imported by background/index.js
// (and anywhere else that ever needs the same matching behavior).

const IGNORED_URL_SCHEMES = ['chrome-extension://', 'about:', 'file:', 'chrome:'];

/**
 * Normalizes a user-entered blocklist value ("instagram.com", "www.x.com",
 * "https://reddit.com/r/...") down to a bare, comparable hostname.
 */
export function normalizeToHostname(rawUrl) {
  try {
    const withProtocol = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`;
    return new URL(withProtocol).hostname.replace(/^www\./, '');
  } catch {
    return rawUrl.trim().toLowerCase().replace(/^www\./, '');
  }
}

/** False for internal browser/extension URLs that should never be intercepted. */
export function isNavigableUrl(url) {
  if (!url) return false;
  return !IGNORED_URL_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/** Hostname of a full tab URL, or null if it isn't a parseable URL. */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Whether a user-entered blocklist value looks like a real, addable
 * hostname (has a dot-separated domain shape once normalized). Distinct
 * from normalizeToHostname() above, which is deliberately lenient — never
 * throws, always returns *something* — because it's used for tab-URL
 * matching where a non-match is harmless. This one runs at input time,
 * where "hello world" silently being saved as a "blocked site" that can
 * never match anything is a real (if minor) bug worth catching.
 */
export function isValidBlocklistUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  return HOSTNAME_RE.test(normalizeToHostname(rawUrl));
}
