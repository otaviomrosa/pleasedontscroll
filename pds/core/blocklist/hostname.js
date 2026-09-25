// Pure URL/hostname matching logic — the rules that decide whether a given
// tab URL counts as "blocked." Written once, imported by background/index.js
// (and anywhere else that ever needs the same matching behavior).

const IGNORED_URL_SCHEMES = ['chrome-extension://', 'about:', 'file:', 'chrome:'];

// The comparable form of a hostname: no DNS root dot, no leading "www.".
// The root dot matters because Chrome loads "instagram.com." as the same
// site as "instagram.com", which made it a one-character way past every
// entry (audit R4). Stripped before "www." so "www.x.com." becomes "x.com".
function comparableHostname(hostname) {
  return hostname.replace(/\.+$/, '').replace(/^www\./, '');
}

/**
 * Normalizes a user-entered blocklist value ("instagram.com", "www.x.com",
 * "https://reddit.com/r/...") down to a bare, comparable hostname.
 */
export function normalizeToHostname(rawUrl) {
  try {
    const withProtocol = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`;
    return comparableHostname(new URL(withProtocol).hostname);
  } catch {
    return comparableHostname(rawUrl.trim().toLowerCase());
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
    return comparableHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Pathname of a full tab URL (e.g. "/shorts"), or null if unparseable. */
export function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// Each label capped at 30 chars (down from RFC 1035's actual 63-char
// max) — this field is for a human to type a site like "instagram.com" by
// hand, not to accept arbitrary auto-generated infrastructure hostnames,
// and 63-char labels let obvious gibberish through: pasting the same
// random string twice back to back (e.g. "aeiouaeiouaeiouaeiouaeiouaeiou.
// comaeiouaeiouaeiouaeiouaeiouaeiou.com") parses as three RFC-legal labels
// and passed this check before, even though nothing about it resembles a
// real site. 30 chars is still generous for anything a person would
// actually type.
const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?\.)+[a-z]{2,}$/i;

// Matches the maxlength set on dashboard.html's #url-input — keep these in
// sync if either changes. Covers a hostname plus a path-scoped suffix
// (e.g. "facebook.com/marketplace") with room to spare; also the mirrored
// cap that keeps the blocklist row's ellipsis-truncation (.url-text) from
// ever needing to handle something wildly longer than this.
export const MAX_BLOCKLIST_URL_LENGTH = 100;

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
  if (rawUrl.trim().length > MAX_BLOCKLIST_URL_LENGTH) return false;
  return HOSTNAME_RE.test(normalizeToHostname(rawUrl));
}

const OWN_DOMAIN = 'pleasedontscroll.com';

/**
 * True if rawUrl is pleasedontscroll.com or a subdomain of it. The
 * dashboard itself lives there — letting a user block it would risk
 * locking them out of the one page that could undo it, especially under
 * Strict Mode's "no bypass, can't remove a blocked site" guarantees.
 * Mirrored server-side in 013_block_own_domain_guard.sql, since
 * blocked_urls is reachable by direct REST, not just this check.
 */
export function isOwnDomain(rawUrl) {
  const hostname = normalizeToHostname(rawUrl);
  return hostname === OWN_DOMAIN || hostname.endsWith(`.${OWN_DOMAIN}`);
}

/**
 * Turns a stored blocked_urls.url string ("youtube.com", "youtube.com/shorts")
 * into a structured entry for matching. pathPrefix is null for a bare-domain
 * entry (blocks the whole site) or a normalized path ("/shorts") for a
 * path-scoped one — trailing slashes stripped, lowercased. A bare "/" is
 * treated the same as no path at all.
 */
export function parseBlocklistEntry(rawUrl) {
  const hostname = normalizeToHostname(rawUrl);

  let pathPrefix = null;
  try {
    const withProtocol = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`;
    const path = new URL(withProtocol).pathname.toLowerCase().replace(/\/+$/, '');
    pathPrefix = path === '' ? null : path;
  } catch {
    pathPrefix = null;
  }

  return { hostname, pathPrefix };
}

/**
 * Whether a live tab URL falls under a parsed blocklist entry — same
 * hostname (or a subdomain of it — see below), and (if the entry is
 * path-scoped) the tab's path is that path or sits under it. A null
 * pathPrefix matches any path under the hostname, which is what makes a
 * bare-domain entry block the whole site.
 *
 * Path matching is by whole segment: "/shorts" covers "/shorts" and
 * "/shorts/abc", not "/shortsxyz" (audit R5). Mirrored in SQL by
 * blocklist_entry_covers() (018).
 *
 * Never true for pleasedontscroll.com itself. The dashboard is the only
 * way to undo a block, so this is the one check that must not be skippable:
 * the dashboard form and 013's trigger both refuse to store the own
 * domain, but a stored string the SQL guard doesn't recognize (a
 * percent-encoded dot sent straight to the REST API) still normalizes to
 * it here.
 *
 * Subdomain-inclusive: blocking "pinterest.com" also blocks
 * "br.pinterest.com", "m.pinterest.com", etc. — found as a real bypass:
 * Pinterest (and plenty of other sites) redirect to a country-specific
 * subdomain, which isn't the exact hostname a bare-domain entry stored, so
 * the site quietly stopped being blocked after the redirect. Same
 * endsWith('.' + hostname) pattern isOwnDomain() already uses to protect
 * pleasedontscroll.com from being blocked — the leading dot is what keeps
 * "notpinterest.com" from falsely matching "pinterest.com".
 */
export function matchesBlockedEntry(url, entry) {
  const hostname = hostnameOf(url);
  if (hostname === null) return false;
  if (hostname === OWN_DOMAIN || hostname.endsWith(`.${OWN_DOMAIN}`)) return false;
  if (hostname !== entry.hostname && !hostname.endsWith(`.${entry.hostname}`)) return false;
  if (entry.pathPrefix === null) return true;

  const pathname = pathnameOf(url);
  if (pathname === null) return false;
  const path = pathname.toLowerCase();
  return path === entry.pathPrefix || path.startsWith(`${entry.pathPrefix}/`);
}

/**
 * True if `covering` (a parsed blocklist entry) already makes `candidate`
 * (another parsed blocklist entry) fully redundant — e.g. covering
 * "instagram.com" makes candidate "live.instagram.com" redundant, same as
 * it would make the live tab URL "https://live.instagram.com/" redundant.
 * Reuses matchesBlockedEntry() rather than reimplementing the same
 * hostname/path comparison a second time, by feeding it a synthetic URL
 * representing the broadest thing candidate itself matches (its own
 * hostname + its own path, or "/" for a bare-domain candidate).
 *
 * Used both directions in dashboard.html: reject adding a new entry
 * that's already covered by an existing one, and clean up existing
 * entries a newly-added, broader entry now makes redundant.
 */
export function entryCovers(covering, candidate) {
  const candidateUrl = `https://${candidate.hostname}${candidate.pathPrefix ?? '/'}`;
  return matchesBlockedEntry(candidateUrl, covering);
}
