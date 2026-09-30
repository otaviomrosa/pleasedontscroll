# Architecture

How Please Don't Scroll is put together: the pieces, why they sit where they
do, and the decisions that are easy to undo by accident. Companion docs:
[DESIGN.md](DESIGN.md) for the visual system, [DECISIONS.md](DECISIONS.md)
for approaches that were tried and dropped.

**Project root is `pds/`, not the git repo root.** Every path below is
relative to `pds/`, and commands run from there.

---

## Overview

**Name:** Please Don't Scroll (PDS)
**Type:** Chrome Extension & Web Platform (SaaS), with a future phone app planned
**Core Mission:** A digital mindfulness coach that stops mindless habit loops and
compulsive usage by introducing "Friction" and "Strict Lockout" modes, helping users
reclaim time from infinite-scroll algorithms.

## Commands

Run from `pds/` (not the git repo root):

- `npm test` — runs `node --test` (zero dependencies, Node's built-in
  runner) over `/test`. To run a single file: `node --test test/hostname.test.js`.
- `./scripts/test-sql.sh` — applies every migration to a throwaway local
  Postgres (with `test/sql/supabase-stub.sql` standing in for Supabase's
  roles, `auth` schema and default grants) and runs `test/sql/*.test.sql`.
  Needs Postgres binaries; set `PDS_TEST_PG` to an existing server when
  running as root. This is the only automated check on the SQL guards.
- No build/lint step exists — this project is deliberately build-free (§8).
  There's nothing to compile; editing a file is the deploy for `/web` and
  `/extension`, modulo actually reloading the unpacked extension / pushing to
  Vercel.
- Local web dev: `python3 -m http.server 8000` from `pds/`, then point
  `core/config.js`'s `DASHBOARD_URL` at `http://localhost:8000/web/dashboard.html`
  (comment already in that file shows the swap — revert before committing).
- Loading the extension locally: Chrome → `chrome://extensions` → Developer
  mode → "Load unpacked" → select `pds/` (not the git repo root, not
  `pds/extension` — see §6 on why).
- Packaging for the Web Store: `./scripts/package-extension.sh` (zips
  `manifest.json` + `/extension` + `/core` into `dist/`).

## Tech stack

- **Extension:** Vanilla HTML, CSS, JavaScript (Chrome Extension Manifest V3)
- **Web Dashboard:** Vanilla JS, connecting to Supabase via `/core` (REST, no SDK/CDN)
- **Backend:** Supabase (PostgreSQL, Authentication, Row Level Security)
- **Future:** Phone app (platform TBD — likely React Native, to maximize reuse of
  the `/core` package described below)

Neither platform depends on the `supabase-js` SDK — all auth/session/query
logic is hand-rolled REST built once in `/core` (see §6, §8). This was a
deliberate choice made after checking whether the SDK could work in the
extension's MV3 background service worker; see the note at the top of
`/core/auth/session.js` for the reasoning and don't reintroduce it there.

## How it works today

- **Deployment:** Live on Vercel at https://pleasedontscroll.com.
  **Vercel Root Directory must be `pds`, NOT `pds/web`.** This tripped up
  the launch: `/core` is a sibling of `/web` (deliberately — the extension
  needs the same constraint, see the `manifest.json` note below), so if
  Root Directory is `pds/web`, `/core` never gets deployed at all and every
  page that imports from it (`dashboard.html`, `pricing.html`) silently
  breaks — the HTML loads, the `<script type="module">` import 404s, the
  whole module fails to execute, and every button wired up in it just does
  nothing. `pds/vercel.json` rewrites the clean public URLs (`/`,
  `/dashboard`, etc. — see the "Clean URLs" entry right below) to their real
  location under `/web`; `/core/*` needs no rewrite since Root
  Directory=`pds` serves it at its real path directly. With Root Directory=`pds`,
  everything else under `pds/` (migrations, edge function source, `/test`,
  `/extension`) is also publicly fetchable by path (found in a security
  review,
  confirmed live). **Don't fix this with a `.vercelignore` allowlist.** One
  was tried (`/*` then `!/web`, `!/core`, `!/vercel.json`) and it shipped
  an EMPTY deployment: every URL, including `/web/index.html`, returned
  404 on 2026-09-24 until it was deleted. The likely cause is that with
  Root Directory=`pds` the patterns are matched from the repo root, so
  `/*` hid `pds/` itself; unconfirmed. Whatever replaces it goes to a
  preview deployment first, and gets checked there by URL.
  `supabase/.temp` (CLI link metadata, including the pooler host) is also
  out of git now.
  `vercel.json` also sets **security headers on every path**: a CSP
  (`'self'` plus Google Fonts, DuckDuckGo icons and the Supabase project;
  `'unsafe-inline'` scripts and styles because every page carries inline
  module scripts and `<style>` blocks), `frame-ancestors 'none'` /
  `X-Frame-Options: DENY`, `nosniff`, a referrer policy, and a one-day
  cache on `/assets/*`. **Loading anything from a new origin (an analytics
  host, a CDN, Stripe.js) means adding it to that CSP**, or the browser
  refuses it silently; redirects to Stripe Checkout are navigations and
  aren't affected. Verified by loading every page, and the signed-in
  dashboard against faked Supabase responses, with zero violations. `core/config.js`'s `DASHBOARD_URL`/`PRICING_URL` point at the
  production domain. The extension itself is not yet published to the
  Chrome Web Store yet.
- **Clean URLs (no `.html`) are the public convention — extensionless is
  correct, don't add it back.** Canonical public paths are `/`, `/dashboard`,
  `/pricing`, `/privacy`. `vercel.json` does two things: **redirects**
  (`permanent: true`, 301) the old `.html` paths to their clean equivalents
  first, then **rewrites** the clean paths to the real files under `/web`.
  Redirects run before rewrites in Vercel's routing order, so a request for
  `/dashboard.html` 301s to `/dashboard` *before* anything tries to rewrite
  it — old bookmarks/shared links still resolve, just via one extra hop.
  `core/config.js`'s production `DASHBOARD_URL`/`PRICING_URL` and the
  redirect URLs built in `create-checkout-session`/`create-portal-session`
  (`${origin}/dashboard`, `${origin}/pricing`) all use the clean form
  directly — no reason to pay the extra redirect hop where we control the
  URL ourselves.
  - **Internal `href`s inside the HTML pages (nav, footer) deliberately
    still say `dashboard.html`, `pricing.html`, etc. — don't "clean" them
    up.** They're relative links, which is what makes them resolve
    correctly in *both* environments: in production they hit the `.html`
    path and silently 301 to the clean one (invisible to the user, address
    bar still ends up clean); in local dev (`python3 -m http.server`, which
    has no rewrite/redirect layer at all) they resolve directly to the real
    file. Changing them to extensionless or root-absolute (`/dashboard`)
    would break local dev the same way the Stripe redirect URLs broke
    locally earlier (see `create-checkout-session`'s local-testing note) —
    python's server would look for a literal file/directory named
    `dashboard` that doesn't exist.
  - Any new absolute production URL (Supabase Redirect URL allowlist
    entries, a future email template, anything hardcoded outside `/core`)
    should use the extensionless form too.
  - **A relative `href`/`src` to a real FILE in `/web` breaks in
    production, unlike a relative link to another page.** This shipped
    once and made the whole marketing site render unstyled. The rewrite
    serves `/web/index.html` at `/`, but the address bar stays `/`, so the
    browser resolves `href="site.css"` to `/site.css` — which has no
    rewrite and 404s. Page links survive the same treatment only because
    `dashboard.html` resolves to `/dashboard.html`, which the redirects
    above catch and send to `/dashboard`. There is no such safety net for
    an asset. `vercel.json` therefore rewrites `/site.css` and `/site.js`
    explicitly, the same way `/assets/:path*` already was (and
    `/robots.txt`, `/sitemap.xml`, `/favicon.ico` since the fix sprint).
    **Adding any
    new file to `/web` that a page references means adding a rewrite for
    it**, or the page will look fine locally (where `/web/index.html` is
    the real URL and relative paths resolve) and break once deployed.
    Local dev cannot catch this class of bug at all, since python's server
    has no rewrite layer — check the live URL after deploying.
  - Relative module imports are safe by accident, and worth not
    "tidying": `../core/x.js` from `/` or `/pricing` normalizes to
    `/core/x.js`, which Root Directory=`pds` serves directly. Verified
    live.
- **The display name briefly changed twice — "Lock Mode," then "Lockdown
  Mode" — before settling back on the original "Strict Mode," the
  founder's final call.** Worth knowing this was explored and reverted,
  so it doesn't get suggested again: "Lock" read as too mild once the
  mode started also guarding profile switches and blocklist edits (see
  the next bullet), "Lockdown" was a closer match for the actual behavior
  but ultimately didn't stick either. Both interim renames were kept
  strictly display-only — internal identifiers (`blocking_mode` values,
  `SET_BLOCKING_MODE`, `blockingMode` variables, `mode-strict-btn`/
  `strict-lock-icon` DOM ids, `data-mode="strict"`,
  `011_lock_mode_guards.sql`'s filename) were never touched through any of
  this, which is exactly what made reverting back to "Strict Mode" a
  clean, low-risk copy-only change rather than an undo of real
  architecture. If the display name changes again in the future, keep
  following that same pattern — internals stay put, only user-facing
  strings move.
- **Strict Mode is Focus Pro-gated**, both visually and server-side.
  `GET_STATE` and `SET_BLOCKING_MODE` in `background/index.js` both check
  `is_premium` (via `/core/sync/userSettings.js`'s `fetchIsPremium`) —
  `SET_BLOCKING_MODE` re-fetches it fresh rather than trusting the
  in-memory flag, specifically so a stale client can't switch to Strict
  right after a webhook downgrade. The popup shows a lock icon on the
  Strict pill when `!isPremium`; clicking it opens `PRICING_URL`
  (`core/config.js`) instead of switching. Don't gate this in the popup
  alone — the server-side check is the one that actually matters.
  **On downgrade, `stripe-webhook` also force-switches a Strict user back
  to Friction Mode** — `resetToFrictionModeIfNeeded()`, called alongside
  `reactivateDefaultProfileIfNeeded()` in both the `customer.subscription.
  updated` (on transition to non-premium) and `customer.subscription.
  deleted` handlers. Found by actually testing a cancellation: a user who
  was in Strict Mode when their subscription lapsed stayed in Strict
  afterward, with no obvious way back beyond knowing to find the toggle
  and sit through the 30s leave-Strict hold themselves. Enforcement was
  never actually unsafe either way — `checkAndBlockTab()` doesn't gate
  Strict on `is_premium`, it enforces "no bypass" regardless of who's
  paying — this fixes a bad post-downgrade experience, not a security
  hole. Implemented as a single conditional `UPDATE ... WHERE blocking_mode
  = 'strict'` rather than a SELECT-then-UPDATE, so it's a no-op for a user
  who was already in Friction Mode.
- **Profile limit is Focus Pro-gated, also both visually and server-side.**
  A user's oldest profile (by `created_at` — there's no `is_default`
  column; `fetchProfiles()` already orders `created_at.asc`, so `profiles[0]`
  is always "the free one") is always allowed; anything beyond it requires
  `is_premium`. Real enforcement is `007_profile_limit.sql`'s
  `enforce_profile_limit()` trigger (`BEFORE INSERT ON profiles`) — a free
  user's direct REST insert attempt gets rejected at the database, not just
  hidden in the UI. `019_profile_cap.sql` redefines the same function with
  a hard cap of **100 profiles** for every account and caller (the site
  still says "Unlimited profiles"; changing that copy is the founder's
  call, pending) and a per-user advisory lock so concurrent inserts can't
  both pass the count. `dashboard.html` hides/disables "+ New profile" for
  free users (the only surface with this button at all now — see the
  popup note in §4's Extension popup entry, profile creation is
  dashboard-only). Both `dashboard.html` and `popup.js` render any extra
  existing profiles (e.g. from a lapsed subscription) as locked —
  clickable only to route to `pricing.html`/`PRICING_URL`, never to
  switch or delete. On downgrade,
  `stripe-webhook`'s `reactivateDefaultProfileIfNeeded()` also force-switches
  `is_active` back to the oldest profile if a non-default one was active,
  so blocking behavior doesn't keep enforcing a now-locked profile's list
  until the client happens to notice. No profile is ever deleted by any of
  this — downgrading just locks access, exactly like the founder asked for.
- **Profile deletion is guarded server-side too, not just in the dashboard
  UI.** `handleDeleteProfile()` in `dashboard.html` already checked "not
  your last profile" / "not the active profile" client-side, but that's a
  courtesy, not a constraint — a direct REST call bypassing the dashboard
  could still delete either one, landing a user with zero profiles or zero
  active profiles. `background/index.js`'s `refreshBlocklist()` has no good
  recovery from that (`fetchActiveProfile()` returning null clears
  `blockedEntries` and disables blocking entirely — fails open, not closed).
  `009_profile_deletion_guard.sql` adds a `BEFORE DELETE` trigger enforcing
  both conditions at the database, mirroring `007_profile_limit.sql`'s
  style exactly. No RLS policy change needed, same reasoning as `007` — a
  business-rule trigger on top of the existing "Users manage own profiles"
  policy, not a new table or policy.
- **Profile activation (`switchProfile()`) is one atomic transaction, not
  two separate PATCH requests.** It used to deactivate-all then
  activate-one as two round trips from the client; an interruption between
  them (closed tab, dropped connection, function timeout) could leave a
  user with zero active profiles — the same fail-open state as the
  deletion gap above. `010_atomic_profile_switch.sql`'s
  `switch_active_profile(p_user_id, p_profile_id)` wraps both `UPDATE`s in
  one `plpgsql` function body, so a client-side interruption either never
  reaches the database (prior active profile untouched) or both updates
  land together — there's no window with only one done. It also validates
  `p_profile_id` actually belongs to `p_user_id` (via `GET DIAGNOSTICS
  ROW_COUNT`) before committing, so a bad/stale ID can't silently
  deactivate everything and activate nothing.
  **This function is `SECURITY DEFINER` and therefore bypasses RLS
  entirely** — unlike every other `/core/sync` call, which stays
  RLS-scoped by going through plain per-row REST requests. Without an
  explicit check, any authenticated caller could pass someone else's
  `p_user_id` and hijack their active profile. The function checks
  `auth.uid() = p_user_id` itself, skipped only for a trusted caller:
  `pds_is_trusted_caller()` (017), true for `stripe-webhook`'s service-role
  JWT (`reactivateDefaultProfileIfNeeded`) and for a session with no JWT
  claims at all (the SQL editor, a future pg_cron job). **Until 017 this
  was keyed on `auth.uid() IS NULL`, which the anon key also satisfies**,
  so anyone holding the public key skipped both the ownership and the
  Strict check. Don't reintroduce that inference in an RPC; in a table
  trigger it is fine, because RLS already keeps anon away from the rows.
  If you ever add another `SECURITY DEFINER` function touching user data,
  it needs this same self-check (RLS will not do it for you), and a
  `REVOKE EXECUTE … FROM PUBLIC, anon` in the same migration: Supabase
  grants every new public function to anon and PostgREST publishes it.
  `core/sync/restClient.js`'s `supabaseFetch()` returns `null` both on a
  failed request and on a successful-but-empty body (e.g. a `VOID`
  function's 204), with no way to tell them apart — every `/core/sync`
  caller's success check is `result !== null`. A `VOID`-returning version
  of this function would have made `switchProfile()` report every
  successful call as a failure. `switch_active_profile()` returns a real
  `BOOLEAN` (`true`) specifically so there's an actual body to parse,
  rather than changing `supabaseFetch()`'s shared contract for every other
  caller just to accommodate this one function.
- **Strict Mode's "no bypass" promise now also covers editing your way out
  of it, not just the block-screen countdown.** Found by an actual
  code-review pass: a user in Strict Mode could always just remove the site
  from their blocklist directly, or switch to a different (weaker or
  empty) profile — neither was gated by mode at all. `011_lock_mode_guards.sql`
  closes both, server-side:
  - `blocked_urls` gets a `BEFORE DELETE` trigger rejecting removal
    while `blocking_mode = 'strict'`. Adding a site stays allowed in
    either mode — it only ever increases restriction, nothing to guard.
    **One exception, added later (`014_lock_mode_redundant_cleanup_
    exception.sql`)**: removing a row is still allowed in Strict Mode if
    another row on the same profile already blocks the *entire* domain
    that row was scoped to — e.g. `facebook.com/marketplace` becomes
    removable the moment `facebook.com` (whole-domain) exists alongside
    it. Found by the founder actually using the path-scoped quick-add
    feature: block `facebook.com/marketplace`, switch to Strict, then use
    "Block Facebook" (whole domain) from the quick-add menu —
    `handleBlockWholeSite()` in `dashboard.html` already tries to clean up
    the now-redundant Marketplace row right after adding the whole-domain
    one, but the blanket rule above rejected it just like any other
    removal attempt. That's correct for the general case (Strict Mode's
    entire point is you can't edit your way out of it) but wrong here
    specifically: a row fully covered by another whole-domain row can
    never carry any enforcement on its own — the whole-domain entry
    already matches every URL the redundant one did — so removing it
    doesn't reduce protection at all, meaning it isn't a bypass the "no
    removal" rule needs to guard against. The new migration adds two
    reusable SQL helpers (`blocklist_url_hostname()`, `blocklist_url_
    is_whole_domain()`, mirroring `core/blocklist/hostname.js`'s
    `normalizeToHostname()`/`parseBlocklistEntry()` closely enough for
    this purpose) and redefines `enforce_lock_mode_blocklist_guard()`
    (same function name — the existing trigger already references it, no
    `CREATE TRIGGER` change needed, same technique used for `010`/`011`'s
    own updates) to check for a covering whole-domain row before
    rejecting. The asymmetric case still correctly rejects, deliberately:
    deleting a *whole-domain* row while a narrower path-scoped row for the
    same host remains is **not** allowed, since the narrower row alone
    doesn't cover everything the whole-domain row did — that would be a
    real reduction in enforcement, not cleanup, and the covering-row check
    only matches when the *remaining* row is itself whole-domain.
    **Further generalized in `015_blocklist_redundancy_guard.sql`** — see
    the no-redundant-entries bullet under Path-scoped blocking below —
    from "same-hostname whole-domain covers path-scoped" to the full
    `entryCovers()`/`blocklist_entry_covers()` rule (subdomains too), so
    e.g. removing `live.instagram.com` after `instagram.com` gets added is
    also allowed in Strict Mode. Same function name again, same
    no-`CREATE TRIGGER`-change technique.
  - `switch_active_profile()` (from `010_atomic_profile_switch.sql`)
    rejects switching while `blocking_mode = 'strict'`, same function, no
    call-site changes needed.
  Deliberately **not** a client-side hold like leaving Strict Mode has — the
  founder's call: switching profiles and editing the blocklist are simply
  unavailable in Strict Mode, full stop. To make either change, leave
  Strict Mode first (paying the existing exit hold), do the change in
  Friction Mode, then re-enter Strict Mode if wanted — instant, since
  Friction→Strict already was. This also resolves a subtler honesty
  problem a hold-based design would have had: the mode toggle would keep
  reading "Locked" even after switching to a profile with nothing
  blocked, giving a false sense of continued protection. Requiring a real
  exit first means the toggle always reads "Friction" *before* either
  change becomes possible — no window where the display and the actual
  protection level disagree.
  `dashboard.html` mirrors both rules client-side for UX, not security:
  non-active profile tabs render with the exact same locked look as a
  Focus-Pro-gated profile (same CSS class, same lock icon) while in
  Strict Mode — deliberate, so "everything is locked" reads as visually
  true — but clicking one shakes (generic `.shake`, not scoped to
  `.pause-toggle` anymore — reused via `shakeElement()`) and shows a
  rejection toast instead of routing to `pricing.html` — see
  `showToast()`'s `isError` variant below, not an inline `error-msg`
  element. `proLocked` (Pro-gated) takes priority over `modeLocked`
  (Strict-Mode-gated) when a tab is both,
  since pricing is still the more useful click target for a profile that's
  permanently unavailable regardless of mode. Blocklist rows get the same
  treatment — the remove button becomes the lock icon (not just
  disabled/hidden) with a matching shake + rejection toast, and a
  `.btn-delete-url.locked:hover` override so the destructive red hover
  doesn't fire for a button that can't actually delete anything right now.
  **Signing out of the extension is refused in Strict too (fix sprint,
  audit R1).** It emptied the blocklist in one click. The popup sends
  `SIGN_OUT`; the background re-checks the mode live (cached when the server
  can't be asked) and answers "Switch to Friction Mode to sign out." or,
  during a scheduled block, the scheduled-until line, shown in the popup's
  `#mode-status`. Client-side only by nature (nothing server-side can refuse
  clearing `chrome.storage`), and deliberately not applied to the
  dashboard's sign-out, which clears the web session and never stops
  blocking.
  **All three of this section's "you can't do that in Strict Mode" messages
  (profile switch, blocklist removal, pausing) route through the same
  `showToast(msg, true)` now, not three separate inline elements.** The
  pause one used to be `#pause-strict-msg`, a bespoke absolutely-positioned
  `<p>` built earlier specifically to avoid the layout shift a plain
  block-level error message caused — removed in favor of the toast, which
  gets the same "never shifts anything" property for free (fixed-position,
  outside document flow entirely) without needing its own positioning
  hack. The row wrapper whose `position: relative` anchored that element
  went with it (and the wrapper itself no longer exists). Form-validation errors
  (login, signup, password fields, etc.) deliberately still use the plain
  inline `error-msg`/`showError()` pattern — founder's call: those benefit
  from staying anchored to the specific field they're about, which a
  floating toast would lose, and the layout shift there was accepted as
  fine. Don't consolidate those into toasts too without asking first.
  **A gotcha worth remembering for any future trigger on a table that's
  ever reached via `ON DELETE CASCADE`**: `delete-account` cascade-deletes
  `blocked_urls` and `profiles` when an account is removed, and cascade
  deletes still fire `BEFORE DELETE` triggers on the child table, same as
  a direct `DELETE` would. A blanket mode/ownership check in either new
  trigger — or in `009_profile_deletion_guard.sql`'s existing one, which
  had this exact latent bug until this same pass fixed it too — would
  make account deletion fail outright the moment the cascade hits a row
  that fails the check (which, for the profile-deletion guard, is *most*
  accounts, since deleting your last/active profile is exactly what a
  cascade does). The fix everywhere: scope the check to `auth.uid() IS
  NOT NULL`. `auth.uid()` is `NULL` under `delete-account`'s service-role
  execution (no request-scoped end-user JWT), so the check naturally
  no-ops for that path while still applying to any real end-user request.
  Same reasoning already protects `switch_active_profile()`'s
  authorization check from blocking `stripe-webhook`'s
  `reactivateDefaultProfileIfNeeded()` — worth noting that call site
  specifically runs *before* `resetToFrictionModeIfNeeded()` in both
  webhook handlers, so a blanket (not `auth.uid()`-scoped) Strict Mode check
  on `switch_active_profile()` would have rejected the webhook's own
  downgrade-correction call for a user still technically in Strict Mode at
  that moment — a self-inflicted version of the exact bug this migration
  exists to fix. Both gotchas were caught before either shipped, not
  found after.
- **Superseded in part by the fix sprint: the breath no longer pauses
  anything account-wide.** Finishing the 30s breath now grants a local,
  10-minute pass for the one site the block screen was served for
  (`GRANT_SITE_PASS` → `sitePasses` in `background/index.js`, saved with
  the cached state). The pass covers the broadest matching entry's
  hostname and its subdomains, so a site redirecting between subdomains
  doesn't bounce the user back to the block screen. It is honored on the
  cached mode too (earned here, seconds ago), never in Strict, and entering
  Strict forfeits every pass. `paused_until` now has one writer, the
  dashboard's pause switch. Read writer 2 below as history.
- **Pause blocking has two triggers writing to the same source of truth,
  by design — not dashboard-only after all.** `user_settings.paused_until`
  (`008_pause.sql`, TIMESTAMPTZ) is the single source of truth, read by the
  extension's normal 60s poll (`refreshBlocklist()` in `background/index.js`).
  It's global/per-user, not per-profile. The two writers:
  1. The dashboard's pause control (right-aligned on the profile tabs
     row, see §4) via
     `core/sync/userSettings.js`'s `setPauseUntil()` — a deliberate,
     arbitrary-duration pause requiring a real trip to the dashboard.
  2. `blocked.js`'s Friction Mode breathing countdown, on completion —
     an automatic 10-minute grant for having sat through the 30s friction,
     via a `PAUSE_BLOCKING` message → a handler in `background/index.js`
     that also calls `setPauseUntil()` with `Date.now() + 10min`, then
     updates the in-memory `pausedUntil` immediately (doesn't wait for the
     next poll) so the redirect back to the original site 1.8s later
     doesn't immediately re-block.
  Both writers hit the exact same column with a plain overwrite (no merge
  logic anywhere), which is what makes "a dashboard pause always overrides
  the breathing grant, and vice versa" true for free — whichever happens
  later in real time simply wins. In practice these two rarely race: the
  breathing flow can only ever fire when `checkAndBlockTab()` currently
  decides to block, which means there was no active pause to begin with
  (an active dashboard pause already makes the site not-blocked, so
  `blocked.html` never loads and the countdown never runs). The real
  interaction is the other direction — a user starts the dashboard pause
  (or resumes/clears
  one) while a still-counting-down 10-minute breathing grant is active —
  and that's exactly the case the shared-column design handles with zero
  extra code.
  This replaced an older per-profile in-memory `PAUSE_BLOCKING` handler +
  `profilePauses` Map. That removal briefly (and wrongly) left
  `PAUSE_BLOCKING` a dead message — `blocked.js` was still sending it after
  every completed countdown, but `background/index.js`'s listener no
  longer had any case for it, so the message silently went nowhere: the
  completion screen said "Blocking paused for 10 minutes" and the user was
  immediately re-blocked the moment they landed back on the site. Re-wiring
  `PAUSE_BLOCKING` through `setPauseUntil()` (rather than reintroducing a
  local-only Map) both fixes that regression and avoids resurrecting the
  original problem with the in-memory version — a purely local grant is
  silently wiped on every MV3 service-worker idle-teardown, same as
  `profilePauses` was; writing through to Supabase means this grant
  survives that the same way the dashboard's pause always has.
  The handler re-checks `blockingMode` fresh (not the mode `blocked.html`
  opened with 30s earlier) before writing — same "never trust a value that
  might be stale by the time it matters" pattern as `SET_BLOCKING_MODE`'s
  `is_premium` re-check — though `checkAndBlockTab()` would ignore a
  stale-mode grant regardless, since it re-checks `blockingMode` itself
  before ever honoring `pausedUntil`.
  - **`GET_STATE` answers instantly from the in-memory cache, then
    revalidates in the background and pushes a correction if anything
    changed — it does not block the popup open on a live Supabase check.**
    This went through two iterations. First: serving the cache as-is,
    which had a real bug — trigger the 10-minute breathing grant, then
    immediately override it with an indefinite pause from the dashboard,
    then open the popup — it kept showing the stale 10-minute expiry
    instead of "Paused indefinitely," because nothing had refreshed the
    cache since the override. Second: made `GET_STATE` `await
    refreshBlocklist()` before ever responding, fixing that, but making
    every single popup open pay for a full live re-sync — several
    sequential Supabase round trips — which made the popup visibly slow to
    open. Current design keeps the fix without the cost: `sendResponse()`
    fires immediately with `buildStatePayload()` (a snapshot of whatever's
    currently cached), and only *after* that does the handler call
    `refreshBlocklist()` and push a `STATE_REFRESHED` message with the
    fresh snapshot. `popup.js` renders the instant reply right away via
    `applyState()`, then listens for `STATE_REFRESHED` and calls
    `applyState()` again if it arrives — usually a no-op re-render since
    the cache is normally already close to fresh (the 60s alarm, plus
    whatever the previous popup open's own background refresh left
    behind), but self-correcting within one round trip on the rare
    occasions it wasn't. If the popup's already closed by the time the
    push fires, `chrome.runtime.sendMessage` just fails silently (same
    `chrome.runtime.lastError`-swallowing pattern as the dashboard's
    `BLOCKLIST_CHANGED` poke) — this was always framed as an optimization,
    never something the push is allowed to be load-bearing for.
    `refreshBlocklist()` itself also got faster independent of this:
    `fetchBlockingMode`/`fetchIsPremium`/`fetchPauseUntil`/
    `fetchActiveProfile` don't depend on each other, so they now run via
    `Promise.all()` instead of four sequential `await`s — only
    `fetchBlockedUrls` still has to wait, since it needs `profile.id` from
    that batch first. `popup.js`'s `renderAppView()` similarly runs
    `refreshStatRow()` (backed by `GET_STATE`) and `fetchProfiles()`
    concurrently rather than sequentially, since the stat row and the
    profile pill list don't depend on each other either.
  - **The actual enforcement path — `checkAndBlockTab()`, run on every
    `chrome.tabs.onUpdated`/`onActivated` — also re-checks `blocking_mode`
    and `paused_until` live, not from the cache, once a hostname is even a
    blocklist candidate.** The `GET_STATE` fix above only made the *popup's
    display* honest; it did nothing for whether a site actually gets
    blocked, because tab navigation never goes through `GET_STATE` at all —
    it only reads the same cached `blockingMode`/`pausedUntil` that
    `refreshBlocklist()` last set, on whatever cadence that happened to run
    (startup / 60s alarm / poke, a no-op pre-launch / a popup open). Found
    by actually using the feature: pausing from the dashboard, then
    immediately trying a blocked site in another tab (without opening the
    popup, without waiting out the minute) still got blocked. The old
    `isUrlBlocked()` was a pure synchronous cache read; it's now
    `isCandidateForBlocking()` (still sync, still a cheap local check against
    the in-memory `blockedEntries` array, still cheap on every navigation)
    feeding an async
    `checkAndBlockTab()` that only does the live Supabase re-check once a
    hostname is actually a candidate — not on every navigation, since most
    aren't to blocklisted hosts at all. The staleness this closes runs both
    directions, and both are real bugs a user would notice immediately: a
    pause set moments ago might not be in the cache yet (blocks when it
    shouldn't), or a pause that already expired/was resumed might still
    look active in the cache (lets through when it shouldn't) — so the
    live check always re-verifies `blocking_mode` too, not just
    `paused_until`, and explicitly clears the cached `pausedUntil` when the
    fresh mode comes back `'strict'`, rather than only checking pause when
    the *stale* mode said `'friction'`. Without that, this recheck could
    become the one path that hands Strict Mode a bypass it was never
    supposed to have. If there's no valid access token when this runs, it
    falls through and blocks using whatever's cached — staying cautious is
    the safe default when a live check isn't possible, not silently
    granting an unverifiable exemption.
  There's a sixth duration option beyond
  30m/1h/2h/6h/12h — `INDEFINITE_PAUSE_ISO`
  (`core/sync/userSettings.js`, `'9999-12-31T23:59:59.000Z'`) — for "pause
  until I manually resume it." No schema change or special-casing needed
  in the actual enforcement logic for this: it's a plain far-future
  timestamp, so every existing `Date.now() < pausedUntil` check (in
  `checkAndBlockTab()`, `refreshPauseUI()`'s `isActive`) already treats it
  as "still paused" with no extra code. Only the *display* layer needs to
  recognize this value, to show "Paused indefinitely" / "until you resume
  it" instead of a real (meaningless, year-9999) clock time — done in both
  `dashboard.html` and `popup.js`'s pause-bar via
  `isIndefinitePause(pausedUntil)` (also in `core/sync/userSettings.js`).
  That helper compares the *parsed year*, not the raw string against
  `INDEFINITE_PAUSE_ISO` — an early version did a strict `===` string
  comparison and it silently never matched, because Postgres/PostgREST
  don't necessarily round-trip the exact string that was written (`+00:00`
  vs `Z`, different sub-second precision) — the value came back reformatted
  and fell through to the "real timestamp" branch every time, rendering as
  if it were a normal (if absurd, year-9999) time. Comparing by year is
  robust to any of that. `isIndefinitePause()` also accepts either an ISO
  string or epoch ms (`new Date()` parses both), since `dashboard.html`
  works with the former and `popup.js` gets the latter from
  `background/index.js`'s `GET_STATE`.
  - **No extra time-hold on pausing itself** — picking a duration
    (30m/1h/2h/6h/12h) commits immediately. The 30s hold already exists for
    leaving Strict Mode (the popup's Strict→Friction confirm screen); this
    doesn't duplicate it. A Friction-mode user is, by definition, not
    currently under that hold's protection, so pausing doesn't need a
    second one stacked on top.
  - **The control is a bare pause/play glyph, and one pill states the
    status.** They are two separate elements, right-aligned on the profile
    tabs row: `#mode-status` (the pill) and `#pause-toggle` (a 36px button
    with no background, holding a 25px glyph in `--ink`).
    - **The glyph shows the ACTION, media-player style**: blocking running
      shows pause, paused shows play. The two SVGs share one grid cell and
      cross-fade with a scale and counter-rotation rather than morphing the
      path, because animating `d` is unsupported in Firefox and this page
      is a website as well as an extension surface. Honors
      `prefers-reduced-motion`.
    - **`applyModeIndicator()` is the only thing that writes the pill**, and
      it has three states: "Friction Mode active" on `--friction`, "Strict
      Mode active" on `--strict`, and "Paused until 3:45 PM" (or "Paused
      indefinitely") on a neutral `--surface-deep`. **Paused wins**, because
      a blue "Friction Mode active" beside a paused button would be untrue.
      A scheduled Strict block composes as "Strict Mode active until
      11:00 PM". Separate "Blocking on" / "Paused until" labels used to sit
      beside the switch; they were redundant once the pill said both, and
      `refreshPauseUI()` no longer touches any label.
    - **`.paused` is still the exception class** on the button: no modifier
      means blocking is on. Don't rename it to something like `.active`,
      which would invert how it reads.
    - **Durations are a dropdown, not a pill that grows sideways.**
      `#pause-menu` reuses `.site-options-menu`, the one dropdown pattern
      in these notes, centred on the button and opening downward. Growing
      horizontally only worked when there was empty space in one specific
      direction, and needing that space is what drove several failed
      layouts. As rows they can also read properly: "Until I turn it back
      on" replaced an ∞ glyph that needed a tooltip.
      `.site-options-menu--tight` trims the base 14px offset to 8px, since
      this menu has no chevron to clear. **That modifier must stay after
      the base rule** — same specificity, so source order decides, and
      placed before it the base silently won.
    - The iOS-style track-and-knob switch this replaced is gone, along with
      `.pause-toggle-knob`, `.pause-options-pill`, `.pause-durations` and
      `.pause-duration-btn`. Its geometry was heavily documented here
      (42x24 track, 2px inset, knob travel, a tuck margin matched to the
      knob's `translateX`, sizing tied to `.nav-logo`); none of that
      applies any more and it is not worth restoring from history.
  - **Location and mode are the two friction layers that remain**:
    dashboard-only (not the extension popup — the popup already has the
    fast path to every other control, so putting this one behind "open a
    browser tab, sign in if needed" is the point, not an oversight), and
    Strict Mode can't be paused at all — clicking the pause button while
    in Strict shakes it and shows an error toast instead of opening the
    duration menu. Checked fresh via `fetchBlockingMode()` at three points
    in the dashboard (opening the menu, right before committing when a
    duration is clicked, and on `visibilitychange`), and independently
    again in `background/index.js`'s `checkAndBlockTab()`, which now also
    calls `fetchBlockingMode()` live (not the cache) before ever honoring
    `pausedUntil`, and ignores it entirely whenever the fresh mode comes
    back `'strict'` — never trusts a value that might be stale by the time
    it matters, same pattern as `SET_BLOCKING_MODE`'s `is_premium` re-check.
    Resuming early
    (canceling an active pause) is instant too — neither direction needs a
    wait; the friction here is entirely about *reach* (the dashboard trip),
    not time.
  - **Switching Friction→Strict while a pause is active clears the pause
    outright, not just ignores it.** `checkAndBlockTab()` already ignored
    `pausedUntil` whenever the fresh mode came back `'strict'`, so
    enforcement was always correct — but the stale `paused_until` value
    was left sitting in Supabase, which meant every *display* of pause
    state (the dashboard's toggle, the popup's pause bar) kept showing
    "Paused" even though nothing could actually bypass Strict Mode
    anymore. Found by testing the exact sequence: pause from the
    dashboard, confirm it works, switch to Strict Mode from the popup —
    the dashboard toggle stayed in its paused/gray state. Fixed in
    `background/index.js`'s `SET_BLOCKING_MODE` handler: right after a
    successful switch to `'strict'`, if `pausedUntil` was non-null it also
    calls `setPauseUntil(..., null)` and resets the local cache — so the
    dashboard toggle reads as "on" again the next time it re-syncs
    (`visibilitychange`, same as any other cross-surface mode change), and
    `popup.js`'s `handleSetMode()` now also calls `refreshStatRow()` right
    after switching, so the popup's own pause bar/status dot updates
    immediately in the same session instead of only on next open.
    Strict→Friction needs no equivalent handling — Strict never lets a
    pause exist in the first place, so there's nothing to clear going the
    other way.
  - Dashboard also pokes the extension after setting/clearing a pause
    (reuses the existing `BLOCKLIST_CHANGED` poke, which already triggers a
    full `refreshBlocklist()` — no new message type needed) and re-fetches
    `blocking_mode`/`paused_until`/`is_premium` on `visibilitychange` so a
    long-open dashboard tab doesn't show stale state after a mode switch or
    upgrade happens elsewhere. Popup's existing pause-bar UI (`isPaused`/
    `pauseUntil` in `GET_STATE`) displays this global pause unchanged — same
    field names as the old mechanism, no popup-side code changed.
  - **Overlapping clicks are handled with a "latest click wins" token, not a
    lock.** A `disabled`-attribute lock (block the switch/duration buttons
    while a click's `await` chain is in flight) was tried first and
    explicitly rejected — a user must always be able to press/unpress these
    buttons on demand, and a lock is also fragile: `fetch()` has no
    built-in timeout, so a single hung request (a slow moment on the live
    server did this in practice) left the control disabled indefinitely
    with no way to recover short of a reload. The fix is a single shared
    monotonic counter, `pauseActionToken`, incremented at the start of
    every pause-related handler (`refreshPauseUI()`, the switch's click
    handler, each duration button's click handler). Each handler captures
    its own value (`const myToken = ++pauseActionToken`) and, after every
    `await`, checks `if (myToken !== pauseActionToken) return` before
    touching shared state (`currentBlockingMode`, `currentPausedUntil`) or
    the DOM. Nothing ever blocks a click from firing — a second click just
    bumps the counter, and the first click's handler keeps running to
    completion but discards its result once it notices it's stale. A hung
    request becomes irrelevant the moment it's superseded instead of
    freezing the UI. The `visibilitychange` listener shares the same
    counter/pattern (via `refreshPauseUI()`) rather than skipping outright.
    If you add another pause-related control later, mint its token from
    the same `pauseActionToken` counter — don't give it a separate one, or
    two genuinely concurrent flows could each think they're the latest.
- **Quick-add chips for common distracting sites**, above the manual
  url-input row on `dashboard.html`'s Blocklist card (`#quick-add-row`).
  `QUICK_ADD_SITES` is a plain const array (Instagram, TikTok, YouTube,
  X, Facebook) — not exhaustive by design, the founder explicitly signed
  off on tuning this list later; Snapchat was in the original 8 and was
  dropped per the founder's request, then Reddit and Twitch.
  **The chips now live INSIDE the url input, right-justified, and the
  "Quick add" label is gone.** `.url-input-wrap` is the visible input box:
  it carries the ground, the radius and (via `:focus-within`) the focus
  ring, while the `<input>` inside it is transparent and the chip row is a
  flex sibling pinned right. Built that way rather than absolutely
  positioning the chips over a padded input, so typed text can never run
  under them however long the list gets. Two things to keep:
  **the chips are bare glyphs again, `background: none`**, so hover is a
  `scale(1.1)` plus the muted-to-ink glyph color rather than a fill (a
  `--card-ground` circle was tried first; note `--surface` would have been
  invisible there, since it is white inside `.app-card` and the input box
  is white too); and below 560px the chips drop to their own line inside the same box
  (`flex-wrap`, the field at `flex: 1 0 100%`, the row at `width: 100%`),
  since five chips leave under 170px to type in. **That media query has to
  sit after the `.url-input-row .field` rule it overrides** — same
  specificity, so source order decides, and while it sat before that rule
  the padding applied but the flex-basis was silently ignored. Each chip is a
  button that went through several rounds of visual iteration this
  session, each swapped per the founder's direct feedback — both the icon
  drawn inside it and, eventually, whether there was an outer chip shape
  at all:
  1. That site's DuckDuckGo favicon (same service/pattern as the blocklist
     row favicons below).
  2. Each platform's real brand mark from Simple Icons (simpleicons.org,
     MIT licensed) — first as a white glyph on a filled circle in that
     platform's own brand color (plus a `rgba(0,0,0,0.14)` 1px outline,
     added after the founder found the colors alone read as too flat
     against the white chip), briefly also tried as the *outer* chip's own
     background before reverting to the white outer circle. Dropped
     entirely — the founder felt the page had "too much color" with 7
     different brand colors on screen at once, and separately found even
     the recolored (gray, no fill) version of these same detailed
     Simple Icons paths still looked visually "bad"/too busy — these are
     exact, intricate corporate logo reproductions, not simple icons
     despite the library's name.
  3. A plain stroke-only glyph — `fill="none"`, `stroke="currentColor"`
     (color driven by the `.quick-add-chip svg` CSS rule, `var(--text-muted)`
     at rest / `var(--text)` on hover, same currentColor pattern the lock
     icon elsewhere in these notes already uses), from Tabler Icons'
     "brand-*" outline set (tabler.io/icons, MIT licensed) instead of
     Simple Icons. This is deliberately a simplified, generic-shape
     representation of each brand (e.g. Instagram is a rounded square + a
     circle + a dot, not the real logo's precise curves) rather than an
     exact logo reproduction — matching the same minimal
     geometric-shapes-not-detail style as this codebase's own lock icon,
     which is what the founder asked for by name. `icon` on each
     `QUICK_ADD_SITES` entry is raw inner `<path>` markup (some icons need
     more than one path, e.g. Reddit's two solid eye dots use their own
     `fill="currentColor"` override against the parent's `fill="none"`)
     rather than a single `d` string, injected directly into the wrapping
     `<svg>` in `renderQuickAddChips()`. `stroke-width="2"` matches
     Tabler's own authored value (their curves are tuned for that
     thickness).
  4. **Current**: the outer white circle/shadow chip shape (steps 1-3 all
     kept it, matching `.account-avatar`'s circle-icon precedent) is gone
     entirely — the founder asked to drop the card/circle container and
     let the bare glyph sit directly in the row, rather than an icon
     inside a button shape. `.quick-add-chip` is still a real `<button>`
     element at a fixed 28px size (so there's still a consistent
     click/tap target, and a stable anchor point for the options-menu
     positioning and the sectioned-chip chevron), but with no visible
     fill, border, or shadow — `background: none`, no `box-shadow`. Hover
     feedback changed to match: no more shadow-lift/translateY (nothing to
     lift), just a small `transform: scale(1.1)` plus the existing
     icon-darkens-on-hover color change. The icon itself renders at
     22x22px, same size as before the chip disappeared around it.
  5. **Current**: back to a filled glyph, not stroked — Remix Icon's
     "-fill" set (remixicon.com, Apache 2.0) instead of Tabler. Before
     committing to this, the founder was shown a side-by-side comparison
     (Tabler stroke vs. Phosphor stroke vs. two Remix Icon variants,
     rendered at actual chip size) and picked Remix's filled glyphs over
     all three stroke-based options, including the one already live.
     Unlike Simple Icons' exact logo traces (step 2, dropped for looking
     "bad"/too busy), Remix's fill icons are simplified interpretations —
     similar simplification level to Tabler's, just solid instead of
     stroked — which is what keeps them from reading as busy the same
     way. `icon` on each `QUICK_ADD_SITES` entry changed from Tabler's
     multi-`<path>` stroke markup to a single filled `<path>` per site;
     the wrapping `<svg>` in `renderQuickAddChips()` changed from
     `fill="none" stroke="currentColor" stroke-width="1.7" ...` to plain
     `fill="currentColor"` (no stroke attributes needed for a filled
     glyph) — `color` on `.quick-add-chip svg` still drives it via
     `currentColor` either way, so no CSS changes were needed, only the
     SVG markup itself.
  All versions of the icon itself were fetched/pasted in verbatim rather
  than loaded from a CDN at runtime, so this stays self-contained with no
  new runtime dependency and no failure mode if either icon service is
  ever unreachable or ad-blocked — consistent with every other build-free
  choice in this codebase. Only the main blocklist row list below still
  uses live DuckDuckGo favicons — those cover arbitrary user-typed sites,
  where a pre-baked icon set obviously isn't possible.
  One click adds that hostname via the same `addBlockedUrl()` used by the
  manual input — no separate code path. A site already on the current
  profile's blocklist renders as a non-interactive "added" state (grayed,
  shadow dropped back to a flat border) instead of disappearing,
  specifically to avoid reflowing every chip after it on every add —
  deliberately consistent with the toast-vs-inline-error layout-shift
  reasoning below. An earlier pass also added a small checkmark badge to
  the added state; removed per the founder's request ("just the greying is
  fine") — greying + losing the shadow's lifted depth is enough on its own.
  `currentBlocklistEntries` (an array of `{ hostname, pathPrefix }`,
  rebuilt via `parseBlocklistEntry()` at the top of every `renderUrlList()`
  call — see the path-scoped entry below for why this isn't a flat
  hostname `Set`) is what `renderQuickAddChips()` reads to decide "added"
  vs actionable, so chip state can never drift from the actual list — it's
  derived, not tracked separately.
  Duplicate-prevention is two-layered, same reasoning as every other guard
  in these notes: `handleQuickAdd()` disables its own chip for the duration
  of its request (the established one-shot-button pattern already used by
  `handleAddUrl()`'s "Block site" button — distinct from the pause toggle's
  deliberate never-disable rule, which only applies to persistent state
  toggles, not one-shot submits), and `012_blocked_urls_unique.sql` adds a
  `UNIQUE (profile_id, url)` constraint at the database so even a request
  that somehow got through twice (network retry, multiple tabs) can't
  create a duplicate row. That constraint is scoped to the exact string in
  `url`, not a normalized hostname — this table has always stored
  whatever was typed/sent verbatim; normalization only happens at
  match-time in the extension. So `instagram.com` and `www.instagram.com`
  could still coexist as separate rows; the constraint only prevents the
  exact same string being inserted twice, which is what a double-click or
  retry actually produces.
  **Known migration risk, not yet hit but worth knowing:** since no such
  constraint existed before, running `012_blocked_urls_unique.sql` against
  a database that already has duplicate `(profile_id, url)` rows from
  earlier testing will fail with a constraint-violation error. If that
  happens, de-duplicate first (keep one row per `(profile_id, url)`, delete
  the rest) before re-running the `ALTER TABLE`.
- **Path-scoped blocking: a site can be blocked in full, or just one
  section of it** (YouTube Shorts, Facebook Marketplace, Facebook Reels,
  Instagram Reels), via the quick-add chips above. Section labels use each
  platform's real feature name, not a generic "Shorts" everywhere —
  Facebook and Instagram's short-form video feed is actually branded
  Reels, confirmed with the founder before implementing (an earlier guess
  would have mislabeled it). Facebook's Marketplace and Reels are fully
  independent options, not a bundled "block both" action — each is its own
  row, its own `blocked_urls` entry, addable on its own.
  **No schema change was needed for this** — `blocked_urls.url` was
  already a free-text `TEXT` column, so a path-scoped entry is just stored
  as `youtube.com/shorts` (the literal string), same as a bare hostname
  is stored as `youtube.com`. `012_blocked_urls_unique.sql`'s
  `UNIQUE(profile_id, url)` and `013_block_own_domain_guard.sql`'s
  own-domain trigger both already worked correctly with a path-bearing
  string (the own-domain trigger already discards everything after the
  first `/` before comparing) — this was a matching-logic and UI change
  only.
  **The matching engine (`core/blocklist/hostname.js`, `background/
  index.js`) is path-aware end to end now, not hostname-only.** Three new
  exports alongside the existing five: `pathnameOf(url)` (mirrors
  `hostnameOf()` for the pathname), `parseBlocklistEntry(rawUrl)` (turns a
  stored `blocked_urls.url` string into `{ hostname, pathPrefix }` —
  `pathPrefix` is `null` for a bare-domain entry, a normalized path like
  `/shorts` otherwise), and `matchesBlockedEntry(url, entry)` (the actual
  comparison: hostname must match, and if the entry is path-scoped the
  tab's pathname must equal that prefix or sit under it, by whole
  segment: `/shorts` covers `/shorts/abc` but not `/shortsxyz` (018; a
  plain `startsWith` before that) — kept in `/core`, not
  inlined in `background/index.js`, per these notes's existing rule that no
  blocklist-matching logic lives outside `/core`). `background/index.js`'s
  in-memory cache is now `blockedEntries` (an array of parsed entries),
  replacing the old `blockedHosts` `Set` of bare hostnames;
  `isCandidateForBlocking()` is now `blockedEntries.some(entry =>
  matchesBlockedEntry(url, entry))` instead of a Set membership check — a
  handful of entries per user makes this trivially cheap on every
  navigation, no hostname-keyed Map needed for a fast-path reject.
  **This fixed a real, previously-live bug as a side effect, not a
  regression**: before this change, if a user manually typed
  `youtube.com/shorts` into the free-text "Block site" input, it already
  passed `isValidBlocklistUrl()` (which only ever validated the hostname
  portion via `normalizeToHostname()`) and got stored verbatim — but
  `background/index.js` then collapsed it back down to bare `youtube.com`
  when building the old `blockedHosts` Set, silently blocking the *entire*
  domain instead of just the path the user typed. Path-aware matching
  makes that manual-entry case actually respect the path now, same as the
  new quick-add sections do.
  `dashboard.html`'s `QUICK_ADD_SITES` entries optionally carry a
  `sections` array (`{ label, path }` pairs). A chip with `sections`
  (YouTube, Facebook, Instagram) opens a small options menu on click
  instead of adding immediately — first row "Block {name}" (e.g. "Block
  Instagram"; today's plain-chip behavior — see `handleBlockWholeSite()`
  below), then one row per section ("Block {label}", e.g. "Block
  Shorts"). Wording went through several rounds per the founder's
  feedback: "Block all of {name}" → "Block the whole site" → "Block
  everything" → back to "Block {name}" (the founder decided naming the
  platform explicitly read better than a generic phrase, since the
  section rows below it already name their own target — "Block
  Instagram" next to "Block Reels" reads as a consistent, parallel pair
  rather than a generic option followed by specific ones). Section rows
  dropped their "only" suffix ("Block {label} only" → "Block {label}") in
  an earlier pass — that part stuck. The "— already blocked" suffix on an
  already-added row (both the collapsed whole-chip title and each menu
  row) was also shortened to just "— blocked" per the founder's request.
  This was chosen over a second, cramped *clickable* hit-target (a
  chevron functioning as its own button) on a 28px circle — the whole
  chip stays the only click target either way. The purely decorative
  "more options here" hint next to a sectioned chip went through two
  versions: first a small corner dot (`.quick-add-chip.has-sections::after`,
  a pseudo-element on the chip itself), then — after the outer
  circle/shadow chip shape was dropped entirely (see the icon-treatment
  history above) and the founder asked for something more distinct — a
  small non-interactive v-shaped chevron (`.quick-add-chip-arrow`, a real
  `<span>` sibling of `.quick-add-chip` inside `.quick-add-item`, not a
  pseudo-element, since it needs to sit *below* the chip rather than in
  its corner) sitting centered underneath the chip. `pointer-events: none`
  keeps it purely visual — the chip itself is still the only click target,
  same reasoning as the corner-dot version it replaced. `.quick-add-chip:
  not(.added):hover ~ .quick-add-chip-arrow` darkens it in step with the
  icon on hover, via a plain CSS sibling selector (the arrow has to come
  after the chip in the DOM for this to work, which `renderQuickAddChips()`
  already does naturally). `.site-options-menu`'s `top` offset was bumped
  from `calc(100% + 8px)` to `+ 16px` to clear the chevron's own space
  below the chip without overlapping it when the menu opens. The chevron
  itself went through one more visibility round: first shrunk to
  6x4px/`stroke-width:1.25` with `opacity: 0.5` at rest (still "too
  visible" per the founder), then settled on **hidden entirely at rest**
  (`opacity: 0`, back to its original 8x5px/`stroke-width:1.5` size since
  legibility while hidden doesn't matter) and only faded in to `opacity: 1`
  (alongside the existing color darken) on `:hover`. The row now looks
  completely clean by default — the affordance only reveals itself once
  someone's actually hovering that specific chip, a deliberate discovery-
  vs-minimalism tradeoff the founder chose after weighing both directly
  against each other. Once the
  whole domain is already blocked, though, the chip collapses to the
  exact same greyed-out, non-interactive `.added` state a plain chip
  gets — no menu, no chevron, no click handler — rather than presenting a
  menu that looks available but has nothing left to offer (every row in
  it would show as covered). This was a deliberate revision after the
  founder tried the first version and asked for it: fully-blocked sites
  should read as done, not as "still has options." Only a section row
  (not the whole chip) shows the added/muted `.site-options-menu-item.added` treatment —
  that only ever happens while the chip is still in its menu-offering
  state, i.e. the whole domain isn't blocked yet, so at least one section
  is uncovered. A section row shows as added if its exact path entry
  exists. The menu itself (`.site-options-menu`) is modeled
  directly on the existing `.account-dropdown` pattern (nav avatar
  dropdown) — same absolute-positioning/white/border/shadow-card shape,
  same toggle-open + close-on-outside-click JS shape (`e.stopPropagation()`
  on the trigger, a `document.addEventListener('click', ...)` that closes
  every open `.site-options-menu`) — reusing the only dropdown pattern
  already in these notes rather than inventing a new popover mechanism.
  `handleQuickAdd()` was generalized to take an explicit URL string and
  label (rather than always a `site`'s bare hostname), so both an
  unsectioned chip's click and every menu row share the same one-shot
  disable-during-request → `addBlockedUrl()` → `loadBlocklist()` +
  `pokeExtension()` path.
  **While a chip's options menu is open, that chip keeps its hover look**
  (`transform: scale(1.1)`, darkened icon, chevron faded in) rather than
  reverting the instant the cursor leaves it to move down into the menu
  itself — found by the founder as a real inconsistency (the trigger would
  visually "let go" mid-interaction while its own menu was still visibly
  open right below it). Implemented as a `.menu-open` class the chip
  click handler adds alongside `.open` on the menu (and a shared
  `closeAllSiteMenus()` helper clears both together — the outside-click
  listener and every "close others before opening this one" call now go
  through this one function, so the menu-open and chip-look states can
  never drift out of sync). CSS-wise, every rule that previously read
  `.quick-add-chip:not(.added):hover` also matches plain
  `.quick-add-chip.menu-open` now, via a comma-separated selector — same
  visual outcome, two different triggers.
- **pleasedontscroll.com itself can never be added to a blocklist.** The
  dashboard, pricing page, and account settings all live there — if a user
  got it onto their own blocklist, the extension's tab intercept would
  redirect the dashboard to `blocked.html` too, and under Strict Mode
  specifically that combines with `011_lock_mode_guards.sql`'s "no bypass"
  + "can't remove a blocked site while in Strict Mode" guards into a real
  dead end: no way to reach the one page that could undo it, and no way to
  undo it even if they somehow did. Guarded two-layer, same pattern as
  every other rule in these notes: `core/blocklist/hostname.js`'s
  `isOwnDomain()` (matches the bare domain or any subdomain) is checked in
  `dashboard.html`'s manual add form for a fast, specific error message;
  `013_block_own_domain_guard.sql` adds a `BEFORE INSERT` trigger on
  `blocked_urls` doing the same check in SQL, since that table is reachable
  by direct REST, not just the form. The quick-add chips above don't need
  their own runtime check — `QUICK_ADD_SITES` is a fixed array that never
  contains this domain, so the trigger is the only backstop that actually
  matters there, same as it is for a direct REST call.
  **Third layer, and the only one that can't be skipped:**
  `matchesBlockedEntry()` never matches a tab on this domain, whatever is
  stored. The SQL normalizer is a regex, not a URL parser, so a string it
  doesn't recognize (a percent-encoded dot, sent straight to the REST API)
  used to get past 013 and then decode to this domain in the extension.
  018 moved 013's check onto `blocklist_url_hostname()`, which now also
  drops the DNS root dot like the JS does (`instagram.com.` is the same
  site as `instagram.com`; audit R4). Keep the two normalizers changing
  together: `test/sql/018_*.test.sql` pins the SQL side to the JS rules.
- **No redundant blocklist entries — a subdomain already covered by a
  broader entry can't be added, and adding a broader entry retires any
  existing narrower ones.** Found by the founder: `matchesBlockedEntry()`'s
  subdomain-inclusive matching (see the Pinterest bypass fix above) means
  blocking `instagram.com` already blocks `live.instagram.com`, so letting
  a user separately add `live.instagram.com` as its own row is pure
  redundant data, not extra protection. `core/blocklist/hostname.js` gained
  `entryCovers(covering, candidate)` for this — given two *parsed* entries
  (not a live tab URL and an entry, which is what `matchesBlockedEntry()`
  itself compares), it's true when `covering` already makes `candidate`
  fully redundant. Implemented by feeding a synthetic "broadest URL
  candidate itself matches" (`candidate.hostname + candidate.pathPrefix`,
  or `/` for a bare domain) through the existing `matchesBlockedEntry()`
  rather than reimplementing the same hostname/path comparison a second
  time — one comparison function underpins both "does this tab URL match
  this stored entry" and "does this stored entry make that other stored
  entry redundant."
  `dashboard.html`'s `handleAddUrl()` (the manual "Block site" input) now
  rejects a redundant add with its own message ("That site is already
  covered by an existing entry in your blocklist.", shaking the covering
  row) — checked after, not instead of, the pre-existing exact-duplicate
  check above it, so an exact re-add still gets its own more specific "already
  in your blocklist" message. The quick-add chips don't get this same
  reject check — they only ever add from the fixed, unrelated-domain
  `QUICK_ADD_SITES` list, so there's no realistic path to a chip click
  being redundant against an existing entry the way a manually-typed
  subdomain can be.
  The reverse direction — an existing narrower entry becoming redundant
  once a broader one is added — was already partly handled
  (`removeRedundantPathScopedEntries()`, added alongside the path-scoped
  quick-add feature, but scoped only to a path-scoped row sharing the
  *exact same hostname* as a newly-added whole-domain row). Generalized
  into `removeEntriesCoveredBy(accessToken, coveringEntry)`, using
  `entryCovers()` against every loaded `currentBlocklistEntries` row
  instead of a same-hostname filter — now also retires e.g. an existing
  `live.instagram.com` row when `instagram.com` gets added. Called from
  all three add paths that can introduce a broader entry:
  `handleAddUrl()` (unconditionally now, not gated on
  `pathPrefix === null` like the old function was, since a path-scoped add
  can still cover a narrower subdomain+path combination), `handleQuickAdd()`
  (newly added — a plain chip click didn't do any cleanup before this),
  and `handleBlockWholeSite()`. Same "best-effort, doesn't undo the add
  that already succeeded" reasoning as before.
  **Both directions are backstopped server-side too, same reasoning as
  every other blocklist rule in these notes** (`blocked_urls` is reachable
  by direct REST, not just these forms) — `015_blocklist_redundancy_guard.sql`:
  - Adds `blocklist_url_path_prefix()` (SQL mirror of `parseBlocklistEntry()`'s
    path-parsing, built on top of `014`'s `blocklist_url_hostname()`) and
    `blocklist_entry_covers(covering_url, candidate_url)` (SQL mirror of
    `entryCovers()` — same subdomain-suffix technique
    `013_block_own_domain_guard.sql`'s own-domain check already uses,
    avoiding `LIKE` wildcard ambiguity on a hostname).
  - A new `BEFORE INSERT` trigger, `reject_redundant_blocklist_insert()`,
    rejects an insert already covered by an existing row on the same
    profile — mirrors `013`'s own-domain guard shape exactly. Deliberately
    does **not** also auto-remove now-redundant existing rows the other
    direction (that stays `removeEntriesCoveredBy()`'s job, a
    client-orchestrated best-effort action, not a trigger-driven cascade
    delete within `BEFORE INSERT` — keeping automatic cross-row deletion
    out of an insert trigger avoids the same class of cascade-ordering
    gotcha documented on the Strict Mode guard below).
  - `enforce_lock_mode_blocklist_guard()` (from `011`, narrowed by `014`)
    is redefined again: `014` only let a removal through in Strict Mode
    when a *same-hostname* whole-domain row covered it; `015` widens that
    to `blocklist_entry_covers()`'s full rule, so `removeEntriesCoveredBy()`'s
    cleanup succeeds in Strict Mode for the subdomain case too (e.g. adding
    `instagram.com` while `live.instagram.com` already exists and the
    profile is in Strict Mode) — same "removing a row that never carried
    any enforcement of its own isn't a bypass" reasoning `014` already
    established, just no longer limited to the whole-domain/path-scoped
    shape of that one case.
- **Scheduled blocking (Focus Pro): a weekly grid of painted blocks, each
  saying "on this weekday, between these times, this profile in this
  mode."** Built as the Schedule tab in `dashboard.html` (a hand-rolled
  paint/drag/resize grid — see that file's own comments for the UI
  decisions) on top of `016_schedules.sql`. The founder's reasoning: Strict
  Mode's 30s exit hold stops an impulsive exit but not a planned one, so
  let the user commit in a calm moment, in advance, to what should be
  active later — the app's whole philosophy is fighting the in-the-moment
  urge, not premeditation, which is also why only the *currently active*
  Strict block is protected and tomorrow's can be edited today (a user
  calmly planning a day ahead could just as easily uninstall; locking the
  whole schedule was explicitly rejected as heavier than anything else
  this app does).
  - **Data**: `schedules` rows `{user_id, profile_id (FK, ON DELETE
    CASCADE), day_of_week 0=Monday..6, start_min, end_min, mode, version}`.
    Times are integer **minutes from local midnight** (`end_min` may be
    1440 — midnight as an *end*, which a `time` column can't express, and
    for a late-night-scrolling app the 22:00–00:00 block is the one that
    matters most); `day_of_week` is the grid column index, deliberately
    NOT JS `getDay()`/Postgres `DOW` (both 0 = Sunday) — every conversion
    is `(getDay()+6)%7` / `EXTRACT(ISODOW)-1`. Matching is half-open
    (`start <= now < end`) so abutting blocks never both match. Overlaps
    are prevented at paint time in the UI *and* by a `BEFORE INSERT OR
    UPDATE` trigger (`'That time overlaps another block.'`), which also
    checks the profile belongs to the same user and bumps `version` on
    every UPDATE. `user_settings` gained `timezone` (IANA name) and
    `schedule_state` (JSONB, server-owned — clients may read it, a
    trigger refuses any client write).
  - **"Now" is the user's own wall clock**: `now() AT TIME ZONE
    user_settings.timezone`. The zone is written **once**, by whichever
    client first sees the account (`setTimezoneIfUnset()` — a PATCH
    filtered on `timezone=is.null`, from both the extension's
    `refreshBlocklist()` and the dashboard's `showApp()`), and never
    overwritten by a client: if any client could, a second device set to
    another zone would end a scheduled Strict block early by moving "now"
    outside it. A change is also refused server-side during an active
    Strict block, and any new value is validated (`now() AT TIME ZONE x`
    inside an EXCEPTION block) so a bad zone can never make every tick
    raise. **No timezone, or no Focus Pro, means no active block, ever** —
    `schedule_active_block()` returns NULL in both cases, and that single
    condition is what keeps every guard below off a free/downgraded
    account: the rows stay dormant, nothing is deleted, re-subscribing
    brings them back (`apply_schedule()` also clears any leftover
    `schedule_state` for a free account so a stale snapshot can't be
    restored months later).
  - **Enforcement is `apply_schedule(p_user_id)`, one `SECURITY DEFINER`
    RPC, and nothing else.** Postgres has no timer here (no pg_cron), so
    it's client-driven and **idempotent**: the extension calls it at the
    top of every `refreshBlocklist()` (60s alarm, plus a one-shot
    `pds-schedule-boundary` alarm re-armed at the next block start/end
    via `core/schedule/active.js`'s `nextBoundaryAt()`, plus 3s of slack
    so the server's clock is surely past the boundary) *and* inside
    `checkAndBlockTab()`'s live re-check (`fetchLiveState()` — replaces
    the old separate `fetchBlockingMode` + `fetchPauseUntil` reads with
    this one RPC, which returns `mode`/`paused_until`/`profile_id` for
    every account; if the RPC fails it falls back to one plain settings
    read, and if that fails too the cached mode stands).
    That live re-check only runs for a URL already on the *cached* list,
    so a block that switches to a profile with a different list was
    invisible to browsing (the schedule-start bug hit on 2026-09-24). Fixed
    extension-side: a navigation that isn't a candidate refreshes first
    whenever the cache is over 2 minutes old or a block boundary has passed
    since it was filled (`cacheIsStale()`), and the worker also refreshes
    on wake (`chrome.idle` → `active`) and browser start. Nothing
    server-side runs `apply_schedule()` on a timer yet; a pg_cron job for
    Focus Pro users is the open server-side half.
    The dashboard calls it on load and on `visibilitychange`
    (`syncScheduleState()`), so the mode line and profile tabs are honest
    with no extension installed. It never `RETURNS VOID` (same
    `supabaseFetch()` reason as `switch_active_profile()`) — the JSONB
    always carries the resulting `profile_id`, `mode`, `paused_until`.
    What it does, in order: when a block covers now and hasn't been
    applied today → **snapshot** the user's current `{profile_id, mode}`
    into `schedule_state.snapshot` (only if none exists — a chain of
    abutting blocks keeps the first snapshot), switch profile, set mode
    (Strict block → strict; Friction block → whatever the snapshot/current
    mode was, a Friction block never *raises* to Strict), clear
    `paused_until` if the result is Strict (same rule as
    `SET_BLOCKING_MODE`), record `applied = {block_id, version, date,
    profile_id, mode}`. When no block covers now and a snapshot exists →
    **restore** it (a deleted snapshot profile falls back to the oldest
    one) and clear the state. The same block+version+date already applied
    but the current profile/mode differ from what it set → the user
    **overrode** a Friction block: record `skipped = {block_id, date}`
    (that occurrence only — next week's is unaffected), drop the snapshot
    (their manual choice is the new baseline, so nothing is "restored"
    over it when the block ends — also checked at the end-of-block
    restore itself, for an override made within the last poll interval).
    A block edited while active (`version` bumped) is re-applied, not
    mistaken for an override.
  - **A Friction block never lowers a Strict the user chose manually.**
    Manual Strict = `blocking_mode='strict'` with no snapshot. Without
    this, "paint a Friction block covering now" would be a hold-free
    Strict exit. Nothing is recorded in that case, so the block is
    re-evaluated every tick and takes effect for whatever is left of it
    the moment the user leaves Strict on their own through the popup's
    hold. (A *Strict* block during manual Strict does apply — it may move
    the profile — and restores the manual Strict afterward.)
  - **A scheduled Strict block cannot be left, edited, or deleted until it
    ends — server-side, founder's call** ("impossible until the block
    ends"; a stronger general Strict exit than the 30s hold is a separate,
    still-open decision — implement it there when it lands, not here).
    Three `BEFORE` triggers, all scoped to `auth.uid() IS NOT NULL` so the
    service-role webhook/delete-account paths are untouched (same cascade
    gotcha as 011 — `ON DELETE CASCADE` from `profiles` fires the
    `schedules` guard, and account deletion runs as service role):
    `schedules` UPDATE/DELETE of the active Strict block → `'This block is
    active right now and cannot be changed.'`; `user_settings` UPDATE with
    exactly `strict → friction` while the active block is Strict →
    `'Strict Mode is scheduled until 11:00 PM.'` (written on that exact
    transition so `paused_until` writes — breathing grant, dashboard
    resume, apply's own clear — never trip it); `switch_active_profile()`
    (redefined again, 010 → 011 → 016) raises the same "scheduled until"
    text in that state instead of the generic Strict message. The popup's
    30s hold would otherwise have been a bypass: `background/index.js`
    pre-checks the cached active block in `SET_BLOCKING_MODE` /
    `SWITCH_PROFILE` and answers instantly with that message, and the
    popup shows it in a new `#mode-status` line under the toggle (a
    standing "Scheduled Strict until 11:00 PM" from `GET_STATE`'s
    `scheduledStrictUntil`, the Friction option `.locked` with a lock
    icon; the same line shows any server refusal for a few seconds —
    those used to fail silently). The dashboard mirrors it with
    `isScheduleBlockLocked(block)` (shake + toast naming the end time),
    the pause toast, and "Mode active: Strict until 11:00 PM".
  - **The RPC has to be allowed to do what a human may not** (Strict →
    Strict on another profile, restoring Friction after a Strict block),
    so it sets a transaction-local GUC, `set_config('pds.applying_schedule',
    '1', true)`, and every guard above — including the Strict check inside
    `switch_active_profile()` — short-circuits on `current_setting(
    'pds.applying_schedule', true) = '1'`. It also takes
    `pg_advisory_xact_lock(hashtext(p_user_id))` (as does
    `switch_active_profile()`), so a popup switch can never interleave
    with a tick and be misread as an override.
  - **Errors reach the UI as text now.** `supabaseFetch()` returns null
    for both a failure and an empty success, which was fine while every
    write failed for one obvious reason; schedule writes can be refused
    for several user-actionable reasons, so `restClient.js` gained
    `supabaseFetchDetailed()` → `{ data, error }` (`error` = the PostgREST
    body's `message`, i.e. the trigger's `RAISE` text verbatim).
    `schedules.js`'s three mutators, `switchProfileDetailed()` and
    `setBlockingModeDetailed()` use it; the boolean `switchProfile()` /
    `setBlockingMode()` are now thin wrappers, contract unchanged. The
    dashboard's schedule mutators are pessimistic (write, mirror the
    returned row, render, poke the extension, then `syncScheduleState()`
    so a block covering now takes effect immediately); on a refusal they
    toast the server's message and re-fetch the grid, since a refusal
    usually means this tab was stale (a block painted on another device,
    or one that has since become active). `activateProfile()`'s failure
    was `console.error` only — it toasts the server's reason now.
  - **Interactions worth knowing**: pausing during a Friction block is
    fine (no profile/mode change, so not an override); a Strict block
    starting clears the pause; manually switching to Strict during a
    Friction block counts as an override (you stay Strict, nothing is
    restored at the block's end); deleting a profile cascades to its
    blocks (a Strict block in force can't be reached — its profile is the
    active one, which 009 already refuses); the Stripe downgrade path
    needs no change (service role → guards skip; next tick clears state).
- **Backend:** Supabase project active.
  - Tables: `blocked_urls`, `user_settings`, `profiles`, `schedules`.
    `blocked_urls.profile_id` and `schedules.profile_id`
    scope each row to a profile (relational join, not a JSON blob —
    matches the modeling rule in §8).
  - `user_settings.blocking_mode` (added in `005_blocking_mode.sql`) is
    `'friction' | 'strict'`, default `'friction'`. This is a **per-user**
    setting, not per-profile — any profile can run in either mode. Don't move
    it onto `profiles` "for consistency"; that was a deliberate call, not an
    oversight.
  - RLS fully active (`auth.uid() = id/user_id`), policies mirrored per-table
    in `/supabase/policies` (migrations remain the source of truth for what
    actually ran).
  - **Grants narrow what RLS allows (017).** The policies are all `FOR ALL`,
    so they pick rows, never columns or operations. `authenticated` may
    UPDATE only `user_settings.blocking_mode`, `paused_until` and
    `timezone` (billing, `schedule_state` and INSERT/DELETE of the row are
    server-owned), may not UPDATE `profiles` or `blocked_urls` at all
    (activation is the RPC; entries are added or removed, never edited),
    and may not INSERT a profile that is already active. `anon` holds no
    table privileges and may execute no function. A client write that
    needs a new column needs a matching `GRANT UPDATE (col)` migration.
  - SQL triggers create a `user_settings` row and a default `profiles` row on
    signup.
- **`/core`:** Built out. Owns all auth/session (REST, pluggable storage
  adapter), Supabase queries (profiles, blocked_urls, user_settings, billing),
  and blocklist hostname-matching logic. See §6/§8.
- **Web (`/web`):** Flat — `index.html`, `dashboard.html`, `pricing.html`,
  `privacy.html`, `site.css`, `site.js`, `assets/` are siblings (not nested
  under a `/web/dashboard` subfolder — there's no router, so nesting was
  deferred until something actually needs it). Every page except
  `privacy.html` imports from `/core` for anything touching auth or
  Supabase; no page talks to Supabase directly.
- **Extension (`/extension`):** Fully connected to Supabase via `/core` —
  auth, profile switching, and blocklist sync are live, not hardcoded.
  Blocklist sync is two-layer: `background/index.js` polls every 60s
  (`chrome.alarms`, alarm name `pds-refresh`, `REFRESH_PERIOD_MINUTES`) as
  the fallback (catches a second signed-in device, or a Stripe webhook
  flipping `is_premium`), and `web/dashboard.html` additionally "pokes" the
  extension for an immediate refresh right after an edit via
  `chrome.runtime.sendMessage(EXTENSION_ID, {type: 'BLOCKLIST_CHANGED'})` —
  allowed through by `externally_connectable` in `manifest.json`, received
  by `onMessageExternal` in `background/index.js`. The poke is pure
  optimization, never load-bearing — `EXTENSION_ID` in `core/config.js` is a
  placeholder until published, so right now every dashboard
  edit silently falls back to the 60s poll. Don't market this as "instant"
  anywhere until that ID is real and confirmed working.
  The fallback poll deliberately uses `chrome.alarms`, not `setInterval` —
  MV3 tears the service worker down after ~30s idle and a `setInterval`
  timer does not survive that teardown, so it would silently stop firing
  after the first idle period (this was a real bug: `is_premium` flipping
  true server-side after a Stripe checkout wasn't reflected in the
  extension until an explicit sign-out/sign-in forced a fresh
  `SESSION_UPDATED` refresh). `chrome.alarms` is built to wake a terminated
  service worker reliably. Chrome also clamps `periodInMinutes` to a
  1-minute floor for installed (non-unpacked) extensions, which is why this
  is 60s and not something shorter — don't lower `REFRESH_PERIOD_MINUTES`
  expecting a faster poll, it'll just get clamped back to 60s in production
  anyway.
  **The worker fails closed (audit R2/R3).** Its enforcement state
  (parsed blocklist, active profile, mode, pause, premium flag, schedule,
  `lastRefreshAt`) is saved to `chrome.storage.local` under `pds_state`
  after every complete refresh, and every listener awaits `ready` (the
  load of that state) before judging anything. Before this, each worker
  restart (about once a minute) began with an empty list, and if Supabase
  couldn't be reached, whether from an outage, a captive portal or the user
  blocking its host in an ad blocker, nothing was blocked at all. A failed
  refresh now keeps the cache and retries via a one-shot `pds-retry`
  alarm (30s, Chrome's floor). Reads that must not turn a network blip
  into "unblocked" are failure-aware: `fetchSettingsSnapshot()` returns
  null instead of free/Friction, `fetchActiveProfile()` throws instead of
  answering "no active profile". `getValidAccessToken()` clears the
  session only when the auth server rejects the refresh token (400/401);
  offline, 429, 5xx or a captive portal keep it. Refreshes are
  single-flight (`refreshBlocklist()` shares one in-flight run;
  `refreshAfterChange()` queues a new one behind it for sign-in, a poke or
  a switch), so a wake no longer spends two refreshes. Only a genuinely
  invalid session (a rejected refresh token, or a real sign-out) clears
  the cache; whether an expired session should keep enforcing is an open
  decision, still open.
  Dual-Mode is built: the popup has a Friction/Strict toggle
  (`SET_BLOCKING_MODE` message → background → `/core/sync/userSettings.js`),
  and `background/index.js` appends `&mode=friction|strict` to the
  `blocked.html` redirect URL at block-time. `blocked.js` reads that param
  and either runs the normal 30s breathing flow or renders a no-bypass
  message — Strict Mode never starts the countdown/breath-cue timers at all.
  **The 30s countdown pauses whenever its tab isn't the visible one, via
  the Page Visibility API (`document.visibilitychange`) — it does not run
  on a plain unconditional `setInterval`.** Found by actually hitting
  this: a user added a site to their blocklist while it was already open
  in a background tab; nothing here proactively re-checks already-open
  tabs on a blocklist change, but the site's own background activity
  (YouTube's client-side navigation triggers `chrome.tabs.onUpdated` with
  `status: 'complete'` on its own, without any user action) was enough to
  get that tab redirected to `blocked.html` — and once redirected,
  `chrome.tabs.update()` doesn't focus the tab it changes, so the
  countdown started and ran to completion entirely unwatched, granting the
  10-minute pause for free. `setInterval` keeps firing in a background tab
  regardless of focus — Friction Mode's whole premise is that the user is
  actually present for the 30s, so a countdown that can complete itself
  unwatched is a bypass, not friction, no matter how the tab got there in
  the first place. Fixed two ways, both in `blocked.js`: the
  `visibilitychange` listener clears the interval (never resets
  `secondsLeft`, just stops it exactly where it was) whenever the tab goes
  non-visible and restarts it when it returns; and `startCountdown()`
  itself checks `document.visibilityState` before ever starting the
  interval, in case the page loads directly into a background tab and is
  never visible even once at the start.
  **`blocked.html`'s leave button offers a real "Go back," not just
  "Close tab," when possible.** `background/index.js` keeps `lastSafeUrl`
  (`Map<tabId, url>`) — every time `checkAndBlockTab()` sees a navigation
  it does *not* end up blocking (not on the list, or let through by an
  active pause), it records that URL as the tab's last known safe page,
  skipping `chrome-extension://` URLs specifically so redirecting *to*
  `blocked.html` never overwrites the safe URL that led there. When a
  block does happen, that stored URL rides along as `&back=` on the
  redirect; `blocked.js` reads it and, if present, changes the leave
  button's label to "Go back" (and the Strict-mode copy to match) and
  navigates there directly via `window.location.href` on click, instead
  of the plain `chrome.tabs.remove()` close it falls back to when there's
  no stored URL (e.g. a tab that loaded straight into a blocked URL with
  no prior page that session — right after browser startup, say).
  **This deliberately does not fix the browser's own native back
  button**, and was scoped this way on purpose after weighing the
  alternative: `chrome.tabs.update()` (what actually redirects the tab to
  `blocked.html`) is a normal navigation, so the blocked site's URL still
  gets its own entry in real tab history, ahead of `blocked.html`'s.
  Clicking the *browser's* back button still lands back on that blocked
  URL and gets re-intercepted immediately. Truly fixing that would mean
  injecting `location.replace()` into the page at interception time
  (replacing that history entry instead of adding past it), which needs
  the `scripting` permission plus a broad host permission — effectively
  `<all_urls>`, since blocklisted sites are arbitrary user-added domains,
  not a fixed list. That's a real jump from this extension's current,
  narrowly-scoped permissions (`storage`/`tabs`/`alarms` plus host access
  to just the Supabase API) — a much scarier install-time permission
  prompt, and the kind of change that draws extra Chrome Web Store review
  scrutiny, right as this extension is preparing its first submission.
  The founder chose the `lastSafeUrl` approach specifically to get the
  same practical outcome (a working way back to where you were) without
  that trade-off. If a genuine fix for the native back button is ever
  wanted later, revisit the permissions trade-off explicitly — don't add
  `scripting`/`<all_urls>` quietly as a side effect of an unrelated change.
  `manifest.json` lives at the project root (`pds/manifest.json`, not
  inside `/extension`) because MV3's "Load unpacked" root has to contain
  both `/extension` and `/core` for the background service worker's
  relative imports to resolve — see §6.

## Repo structure

```
(all paths below are relative to pds/ — the project root, see the note
at the top of these notes)

manifest.json          ← Lives at the project root (pds/manifest.json), not
                          inside /extension. MV3's "Load unpacked" target has
                          to contain both /extension and /core so
                          background/index.js's relative imports
                          (../../core/...) can resolve — a Chrome extension
                          can't reach outside the folder you point "Load
                          unpacked" at. Paths inside manifest.json are
                          written relative to pds/ accordingly (e.g.
                          "extension/background/index.js"), so "Load
                          unpacked" must point at pds/, not the git repo root.

/supabase
  /migrations          ← schema as versioned SQL files, in numeric order.
                         Never hand-edit in the Supabase dashboard UI, and
                         never edit an already-applied migration after the
                         fact. Every migration that adds or alters a table
                         MUST ship with its RLS policy in the same commit.
  /policies            ← one file per table (blocked_urls.sql, user_settings.sql,
                         profiles.sql), mirroring each table's CURRENT policy.
                         This is a derived, current-state reference for
                         quickly seeing a table's full policy set — the
                         migrations remain the actual source of truth for
                         what ran. Update the matching policy file whenever a
                         migration changes a policy; don't let them drift.
  /functions           ← Edge Functions only (create-checkout-session,
                         create-portal-session, delete-account,
                         stripe-webhook). This is the ONLY place a
                         service_role key may ever be referenced, and only
                         via Supabase's own secrets manager — never in a
                         committed file. Verified compliant. delete-account
                         cancels any active Stripe subscription, then
                         deletes the auth.users row via the Auth Admin API —
                         profiles/blocked_urls/user_settings all cascade via
                         their existing ON DELETE CASCADE foreign keys (see
                         001_initial_schema.sql, 003_profiles.sql), so
                         nothing else needs deleting manually.
  config.toml          ← Per-function platform settings. All four functions
                         above have verify_jwt = false — each does its own
                         auth check inside the code (service-role
                         auth.getUser() on the incoming JWT for the
                         session-creating/account-deleting functions;
                         Stripe-Signature verification for the webhook),
                         and the gateway's own verify_jwt was found to
                         reject this project's asymmetric (ES256) JWTs
                         outright — see the comment in these notes for the
                         full reasoning. Don't remove these entries "to
                         restore default security" — the real auth check is
                         the one inside each function.

/core                  ← Platform-agnostic logic. No DOM, no chrome.*, no
                         React Native imports, no supabase-js SDK — plain
                         fetch() against the Supabase REST API (see the note
                         in /core/auth/session.js for why). This is what's
                         reused across extension, web, and the future phone app.
  config.js            ← SUPABASE_URL / SUPABASE_ANON_KEY / DASHBOARD_URL /
                         PRICING_URL / EXTENSION_ID — the single source both
                         platforms import. EXTENSION_ID is a placeholder
                         until the extension is published —
                         don't fill it with a personal local dev ID.
  /auth
    storage.js          ← storage-adapter interface + chromeStorageAdapter
                          (chrome.storage.local) + webStorageAdapter (localStorage)
    session.js           ← signIn / signUp / signOut / getValidAccessToken /
                          persistSession / getStoredSession / clearSession /
                          updatePassword / requestPasswordReset / getUser —
                          all parameterized by a storage adapter (except
                          updatePassword, requestPasswordReset, and getUser,
                          which just take an access token / email — direct
                          Supabase Auth calls, no stored-session mutation
                          involved). Password recovery is web-only —
                          dashboard.html's completeRecoveryFlow() handles
                          the emailed link's tokens (Supabase appends them
                          to the URL hash, not a query string); nothing in
                          the extension calls requestPasswordReset, same
                          reasoning "Change password" is dashboard-only —
                          an email link can't reasonably target an
                          unpublished extension popup. signUp() takes an
                          optional redirectTo (same `?redirect_to=` pattern
                          as requestPasswordReset) — without it, Supabase
                          falls back to its Site URL dashboard default,
                          which is how confirmation links were briefly
                          sending users to localhost; dashboard.html passes
                          its own origin+path, the popup passes
                          DASHBOARD_URL (same "email link can't target the
                          extension" reasoning as password reset).
                          **Signup confirmation logs the user straight
                          in.** Supabase's confirmation link redirects back
                          with a real session in the URL hash
                          (#access_token=...&refresh_token=...&type=signup),
                          not just a "you're verified" notice — same
                          mechanism as the recovery flow above. This hash
                          was previously never read for type=signup (only
                          completeRecoveryFlow() checked the hash, and only
                          for type=recovery), so confirming silently
                          dropped a perfectly good session and forced a
                          manual sign-in right after the user had just
                          proven their email. `completeSignupConfirmation()`
                          in dashboard.html now catches this: unlike the
                          recovery hash, Supabase's implicit-flow fragment
                          never includes the user object, so it calls the
                          new `getUser(accessToken)` to fill that in before
                          persisting a full session and calling the same
                          `showApp()` a normal login does — no divergent
                          code path. Web-only, same reasoning as recovery —
                          the extension's own signup still requires signing
                          in separately afterward, since session storage
                          isn't shared between the web dashboard and the
                          extension.
  /sync
    restClient.js         ← shared low-level supabaseFetch() wrapper, plus
                             supabaseFetchDetailed() → { data, error } for
                             writes whose server-side rejection text the
                             UI needs to show (see §5's "Scheduled
                             blocking" entry)
    profiles.js             ← fetchProfiles, fetchActiveProfile, createProfile,
                             switchProfile (+ switchProfileDetailed), deleteProfile
    blockedUrls.js           ← fetchBlockedUrls, addBlockedUrl, removeBlockedUrl
    userSettings.js           ← fetchIsPremium, fetchBlockingMode, setBlockingMode
                               (+ setBlockingModeDetailed), fetchPauseUntil,
                               setPauseUntil (see §5's "Pause blocking" entry),
                               setTimezoneIfUnset, fetchTimezone
    schedules.js               ← fetchSchedules, createScheduleBlock,
                                 updateScheduleBlock, deleteScheduleBlock,
                                 applySchedule (the apply_schedule() RPC —
                                 see §5's "Scheduled blocking" entry)
    billing.js                 ← createCheckoutSession, createPortalSession
                                 (both call their respective edge function;
                                 the portal one powers "Cancel subscription"
                                 via Stripe's hosted Billing Portal — no
                                 custom cancellation UI in this repo)
    account.js                  ← deleteAccount (calls the delete-account
                                 edge function). Dashboard-only — see the
                                 "Danger zone" section in its Settings card;
                                 the confirm-before-deleting UI lives there,
                                 these notes is just the network call.
  /schedule
    active.js                  ← pure clock helpers for the weekly schedule:
                                 localDayAndMinute, activeBlockAt,
                                 nextBoundaryAt. Used by the extension (next
                                 boundary alarm, popup status) and the
                                 dashboard (locked-block mirror). Predicts
                                 what the server's apply_schedule() will say;
                                 never the source of truth.
  /blocklist
    hostname.js                ← normalizeToHostname, isNavigableUrl, hostnameOf,
                                 isValidBlocklistUrl — the rules that decide if a
                                 tab URL is "blocked", plus the input-time check
                                 (distinct from normalizeToHostname, which is
                                 deliberately lenient for matching purposes)
  validation.js          ← isValidEmail, isValidPassword (+ MIN_PASSWORD_LENGTH),
                         isValidProfileName (+ MAX_PROFILE_NAME_LENGTH). Shared
                         input-hygiene checks for every form across extension
                         and web (login, signup, change password, new profile)
                         — not a security boundary, RLS/Supabase Auth still do
                         that; this just catches obvious mistakes before a
                         round trip to the server. Hand-rolled, no validation
                         library — see the build-free note in §8.
  /types
    index.js                    ← JSDoc typedefs (Profile, BlockedUrl,
                                 UserSettings) matching the schema exactly.
                                 If a migration changes a table, these notes
                                 changes in the same commit.

/extension
  /background/index.js  ← imports from /core, adapts core calls to chrome.tabs /
                         chrome.storage. Holds only runtime state that's
                         genuinely specific to this context (live
                         blockedEntries array, per-profile pause timers). No
                         auth logic, no Supabase query logic of its own.
  /popup                ← popup.html/js/css — auth + profile-switcher UI,
                         imports /core, messages background.js on session change
  /blocked              ← blocked.html/js/css — renders Friction (30s
                         breathing unlock) or Strict (no-bypass message)
                         based on the `?mode=` URL param background.js sets
                         at redirect time. Doesn't talk to Supabase directly;
                         only messages background.js.
  /assets

/web                   ← Flat: no /dashboard subfolder yet. index.html,
                         dashboard.html, pricing.html, privacy.html,
                         site.css, site.js and assets/ are siblings.
                         Revisit nesting only when there's an actual reason
                         to (a router, more pages under one section, etc.).
                         This is what's deployed on Vercel — see
                         Architecture Status above. These pages were rebuilt
                         from scratch in a `web-v2/` trial folder and
                         promoted over the old ones, which is why the git
                         history shows the whole directory replaced in one
                         go. `assets/images/` holds three files:
                         `logo-no-bg.png` (every page, popup and blocked
                         page), `testthis.webp` (both of index.html's photo
                         bands, see §4) and `share.png` (the 1200x630 link
                         preview, a render of the hero; og:/twitter: tags on
                         index, pricing and privacy). The unreferenced
                         `hero-top.webp`, `hero-painting.jpg` and
                         `chrome-logo.png` were removed. Adding a file here means adding
                         nothing to vercel.json — `/assets/:path*` already
                         rewrites the whole tree — but adding a file
                         anywhere ELSE in /web does (see §5's Clean URLs).
                         The old `tokens.css`, `style.css` and
                         `js/script.js` are gone with the rebuild, along with the
                         painting assets.
  site.css               ← The whole marketing design system: tokens at the
                         top, then nav, hero, mode bands, tiles, plans, FAQ,
                         footer. Shared by index.html, pricing.html and
                         privacy.html. dashboard.html does NOT use it — it
                         carries its own `<style>` block, because it's a
                         denser app UI with a different component set and
                         its own duplicated `:root` (see §4's "Where it
                         lives"). A shared `tokens.css` was tried once in
                         the old system and reverted after it broke the
                         pages, so don't reintroduce one without asking.
  site.js                ← initAccountMenu (the nav avatar dropdown),
                         scroll reveal gated behind prefers-reduced-motion,
                         and showToast. Imported by the three marketing
                         pages; dashboard.html has its own equivalents.
  index.html, pricing.html, dashboard.html   ← import from /core for all
                         auth/sync/blocklist/billing logic. Contain only DOM
                         rendering and event wiring.
                         All three duplicate the same account-menu markup in
                         their nav (avatar-in-a-circle + dropdown once
                         logged in: Dashboard, Settings, Sign out — replaces
                         the Sign in/Get started pill; no shared component
                         system in this build-free codebase for markup, so
                         it's the same markup copied three times, with the
                         behavior shared via site.js). "Settings"
                         on all three links to `dashboard.html#settings-card`
                         — account settings (email, change password, cancel
                         subscription) intentionally live as a section
                         inside dashboard.html, not a separate page; this
                         was a deliberate choice over a new settings.html.
                         index.html's and pricing.html's "Get Focus Pro"
                         CTAs go straight to Stripe Checkout (and to the
                         billing portal for someone already subscribed)
                         rather than routing through the pricing page; both
                         keep an href as the no-JS fallback, so their
                         handlers call preventDefault().
  privacy.html           ← static content, no /core import needed. Written
                         to describe actual data practices — keep it that
                         way if data handling ever changes (new analytics,
                         a new third party, etc.), don't let it go stale.

/phone (future)
  ← whatever framework is chosen, imports from /core the same way
    extension and web do. This is the entire point of /core existing.

/test                  ← node:test unit tests. hostname.test.js (pure
                         blocklist logic), validation.test.js (pure form
                         validation), schedule-active.test.js (pure schedule
                         clock helpers: half-open matching, Monday=0, midnight
                         ends, next-boundary rollover), and sync.test.js +
                         userSettings.test.js + schedules.test.js
                         (verify the shape of /core/sync's REST calls via a
                         mocked fetch — no live Supabase project needed;
                         userSettings.test.js also covers isIndefinitePause()'s
                         year-comparison logic as a regression test for a real
                         bug it already had — see that function's own comment
                         in core/sync/userSettings.js; schedules.test.js also
                         covers supabaseFetchDetailed() surfacing a trigger's
                         RAISE message). Run with `npm test`.
                         Zero test dependencies — see the build-free note in
                         §8 before reaching for a framework here.
  /sql                  ← SQL tests, one psql script per migration worth
                         testing (017_*.test.sql …), plus supabase-stub.sql.
                         Run with scripts/test-sql.sh, not npm test.

/scripts
  test-sql.sh           ← runs test/sql against a local Postgres (see §2).
  package-extension.sh  ← zips manifest.json + /extension + /core into
                         dist/ for Chrome Web Store upload. Needed because
                         pds/ (where manifest.json lives) also contains /web
                         and /supabase, which shouldn't ship in the
                         extension package. It also (1) drops files nothing
                         in the extension loads, from the package only, never
                         the repo: a 2.3MB `popup-painting.png` that was ~89%
                         of the upload, the PWA icons and webmanifest, and
                         the dashboard-only `core/sync/account.js` and
                         `billing.js`; (2) strips the `localhost:8000` origin
                         from the STAGED manifest's `externally_connectable`
                         (the repo manifest keeps it for "Load unpacked"
                         dev); and (3) fails the build if any relative
                         import, src/href or url() in the package points at a
                         file that isn't in it, or if it finds a localhost
                         origin or `service_role`. That third check is what
                         makes the exclusion list safe: the moment the
                         extension starts importing one of those files, the
                         build breaks instead of shipping a broken upload.
                         Result: 2.45MB -> 83KB. Verified by loading the
                         built zip into Chromium as a real extension.

package.json            ← NOT a build step. Declares zero dependencies —
                         exists only for `"type": "module"` (silences a
                         Node warning when running tests) and the `test`
                         script. Don't let this become a dependency
                         manifest; see §8.


vercel.json              ← Redirects + rewrites only (no build config — this
                         is a static site). Redirects old `.html` paths to
                         their extensionless equivalents (see "Clean URLs"
                         in §5), then rewrites those clean paths to the real
                         files under /web. Depends on Vercel's Root
                         Directory being set to `pds` in the dashboard — see
                         the Deployment note in §5. If pages 404 or
                         half-load in production, check that setting before
                         touching these notes.
```

**Rule of thumb:** if you're about to write auth code,
a Supabase query, or blocklist-matching logic inside `/extension` or `/web`
directly, stop — it belongs in `/core`, imported from there instead.

## Roadmap

1. ~~**Extension-Supabase Handshake**~~ — done. Extension authenticates via
   `/core/auth` and syncs `blocked_urls` via `/core/sync`, no hardcoded toggles.
2. ~~**Context Profiles**~~ — mostly done. `profiles` table +
   `blocked_urls.profile_id` relational join (not a JSON blob), extension
   profile-switcher, dashboard profile tabs. Not yet built: an actual
   "Deep Work" / "Evening Unwind" onboarding flow — right now a profile is
   just a name, no template/preset behavior.
   - Additional profiles are a Focus Pro feature — free accounts keep
     exactly one (see §5's "Profile limit" entry for the full mechanism).
     This landed after the base feature, once Strict Mode's earlier
     UI-only-then-hardened path made clear that gating needs a real
     server-side check, not just a hidden button.
3. ~~**Dual-Mode UI**~~ — done. `user_settings.blocking_mode` (per-user, see
   §5), popup toggle (`--friction` = friction, `--strict` = strict — each
   its own dedicated token, see §4's Colors entry for the current values
   and the naturalistic-palette detour they went through before settling).
   Friction's active pill was originally plain black, deliberately
   unflashy so Strict's own color stood out purely by contrast against a
   neutral non-color; moved to its current dedicated-token pair once both
   modes got their own identity color — Strict still reads as "the
   alarming one" since its color is more saturated/warmer than Friction's,
   so the same contrast holds via color temperature and saturation instead
   of color-vs-no-color. `blocked.js` branches on the redirect URL's
   `mode` param.
   - Leaving Strict Mode isn't a free action: the popup's Strict→Friction
     switch routes through a 30s breathing-hold confirm screen
     (`view-confirm` in popup.html, reuses the same ring-countdown pattern
     as `/extension/blocked`) before it actually calls `SET_BLOCKING_MODE`.
     Friction→Strict stays instant. This exists because a same-popup
     one-click toggle made Strict Mode pointless — closing the popup
     mid-countdown silently cancels it (no state persisted), which is
     intentional, not a bug to fix.
   - ~~The dashboard-side "temporarily disable for N hours" escape hatch~~ —
     done, see §5's "Pause blocking" entry for the full mechanism.
4. **Phone App** — once `/core` is proven stable across extension + web,
   evaluate framework and reuse `/core` directly.

## Conventions

### Security (structural, not just a reminder)
- Never write, read, or reference a `service_role` key outside
  `/supabase/functions` + Supabase's secrets manager. If a task seems to need
  service_role anywhere else, stop and flag it — the task is probably
  mis-scoped, not the rule wrong.
- Only `anon`/`publishable` keys in `/core`, `/extension`, `/web`.
- Every new or altered table's migration must include its RLS policy in the
  same commit. A migration without a policy file is incomplete, not "policy
  later."
- This project is deliberately build-free (no bundler, no transpilation) —
  there is no `.env` and nothing is injected at build time. `SUPABASE_URL`
  and `SUPABASE_ANON_KEY` are committed as plain constants in
  `/core/config.js`. This is intentional, not a gap: it's the
  anon/publishable key, safe to ship client-side by design, and RLS is what
  actually protects data. Don't add build tooling to "fix" this — you'd be
  solving a problem that doesn't exist. The rule that still matters:
  `service_role` never appears here, ever.
  - There IS a `package.json` now, added only for `npm test` (Node's
    built-in test runner, zero dependencies). Don't read its existence as
    permission to start adding npm packages — if a task seems to need a
    dependency, that's a signal to stop and ask, not to `npm install`.
- **Don't split sign-in errors into "no such email" vs "wrong password."**
  `core/auth/session.js`'s `friendlyAuthError()` deliberately maps both to
  one message ("Incorrect email or password.") because Supabase Auth itself
  returns the same generic "Invalid login credentials" for both cases —
  intentional, industry-standard behavior that prevents account enumeration
  (an attacker probing which emails have accounts by reading which error
  comes back). This was explicitly asked for once and declined for this
  reason — don't "fix" it later without re-deciding that tradeoff first.

### Architecture
- Shared logic (auth, sync, blocklist matching, type definitions) lives in
  `/core` and is imported, never duplicated, by extension/web/phone. `/core`
  does not depend on the `supabase-js` SDK — see the note in
  `/core/auth/session.js` and don't reintroduce it into the background
  service worker (that's the part that doesn't work reliably; a normal
  browser tab is fine, but nothing here uses the SDK at all right now, for
  consistency).
- `manifest.json` lives at the project root (`pds/`), not inside `/extension`,
  and not at the git repo root either (`pds/` is a directory inside it). If you
  ever move it back, you also have to either duplicate `/core` into
  `/extension` or find another way for `background/index.js`'s relative
  imports to resolve — MV3 can't load a file from outside the "Load unpacked"
  root.
- Favor relational structures over JSON blobs for anything that will be
  queried, filtered, or protected by RLS.
- Before adding a new table or column, check `/core/types` first — if a type
  already models this shape, extend it; don't create a parallel one.

### Working on this

- One roadmap item at a time. Bundling "handshake + dual-mode UI + context
  profiles" into one pass produces duplicate helpers and half-finished
  seams.
- Anything touching the schema or the extension-Supabase handshake gets a
  written plan and a review before it is built.
- After a refactor, update the Repo structure and How it works today
  sections above so they still describe what is on disk.

### User-facing copy
- No em dashes in anything a real user reads: UI strings, marketing copy
  (site, Chrome Web Store listing), email templates, Stripe product/checkout
  text. They read as an AI-written tell to a lot of people now, and this
  product's whole pitch is deliberate, human-considered friction — copy that
  reads as auto-generated undercuts that. Use a period, comma, or just a new
  sentence instead.
  Scoped to user-facing text only — this rule does NOT apply to code
  comments, commit messages, or these notes's own documentation, which lean on
  em dashes constantly and aren't being rewritten to avoid them.

## What "done" means for a refactor

A refactor task on this codebase is not complete until:
- No blocklist-matching, auth, or Supabase-query logic exists outside `/core`.
- Every table in `/supabase/migrations` has a matching policy file in
  `/supabase/policies`.
- No two files implement the same logic differently (e.g., extension and web
  each parsing URLs their own way).
- `/core/types` typedefs match the actual current schema exactly.
- This file (`the architecture notes`) has been updated to reflect what changed.
