# Decisions, and what was tried

Things that were built and then removed, with the reason. Kept because
without it the same ideas get proposed again, and several of them look like
obvious improvements until you know why they failed here.

---

## Design: tried and dropped


- Gouache-painting backgrounds (made pages inconsistent; see the
  photographic bands in DESIGN.md for the one sanctioned use that survived); a single
  indigo accent (`#6366f1`); a "naturalistic" earth-tone palette (sage /
  terracotta / gold); burgundy `#b0203f` + teal `#4a90a4` as the mode
  pair; **Apple system blue `#0071e3` for Friction against a red for
  Strict** — two fully saturated near-opposite primaries, which read
  as signage (police, toy) rather than software wherever both appear at
  once, the schedule grid worst of all. **Note the resolution here: what
  got dropped was the blue/red pairing, not the blue.** Friction is that
  exact `#0071e3` again today everywhere except `dashboard.html`, whose
  `:root` currently says `#388ce0` (an unreconciled drift, see DESIGN.md's
  token note); it stopped reading as signage the moment
  Strict became a navy rather than a red, since the clash was always
  between the two hues and never in either one alone. The intermediate
  step was deep teal `#00857a` + scarlet `#dc2626`, picked from six pairs
  rendered on the real surfaces (iris, teal, amber, vermilion/oxblood,
  iris/oxblood, graphite) and a matrix of six reds, both now superseded.
  That red search is still worth knowing for any future warm accent:
  brightening a red raises its luminance faster than its saturation, so
  every step lighter costs white-text contrast, and scarlet was the
  brightest that still cleared 4.5:1 for the 12-13px mode labels.
  `--error` deliberately
  kept the old `#d70015`: separate semantic token, and a form error never
  sits beside a mode pill; a violet `#7741c8` `--accent-pro` / `--accent-brand` pair in
  `/web`; orange for Focus Pro (rejected — black + orange reads as an
  adult-site logo); a colored glow around the blocklist to show the
  active mode (added, strengthened, then reverted); glow shadows under
  the active mode option. All replaced by the two-blues + no-Pro-color
  rule in DESIGN.md.
- `Lora` (and `Fraunces` before it) as the serif headline face —
  replaced by Plus Jakarta Sans. Lora's lightest weight was 400, which
  is why old rules never request 300.
- Hairline borders (`rgba(0,0,0,0.09–0.14)`) as the primary grouping
  device, card `box-shadow`s at rest, a 3D-looking pause toggle (border
  + knob shadow) — all flattened. One resting shadow came back by the
  founder's call: the dashboard's `.app-card`, a soft two-layer shadow
  that lifts the one gray card off the page (see DESIGN.md).
- In the popup specifically: a pulsing accent Pro badge (too loud for a
  permanent header tag → flat gray box); a status color dot; standing
  hint text under the mode toggle and a "syncs every minute" footer
  (removed — a popup opened many times a day doesn't need captions; the
  "Strict is Focus Pro" reason survives as a hover `title`); the brand
  name next to the logo (logo only now); profile *creation* (dashboard-
  only, since blocklist editing is too); "Manage blocklist" as a
  full-width button, then a text link, then finally the small ink pill
  "Blocklist →" sharing a row with the status line; the status line's
  gray box and amber paused variant (paused is plain ink text now); the
  five `.divider` hairlines (sections are spaced by a `.container > * + *`
  sibling margin — not a flex `gap`, because `showView()` sets
  `display: block` inline on the active view and a gap would silently do
  nothing). The `mini-logo` PNG is white-on-transparent, so it renders
  with `filter: invert(1)`, not `brightness(0)`.
- In the dashboard: the upgrade banner moved from first-thing-on-page to
  last (a bold upsell as the first thing on open sat oddly next to "we
  don't track you"); the mode indicator went from a glow, to a toggle
  idea, to an uppercase "Mode active: …" line with a colored dot, to a
  pill with the pause button inside it, to the current solid mode pill
  with a separate round pause bubble beside it; the iOS-style pause
  switch with a sideways-growing duration pill (now a dropdown); a bottom
  bar holding pause + mode (72% empty at 690px); per-site white cards
  inside the blocklist (rows sit directly on the list surface now); seven
  separate day boxes in the schedule (one white box now, with hour lines
  that never touch the top or bottom edge); a persistent hover highlight
  on an opened Settings disclosure row.
- Quick-add chip icons went DuckDuckGo favicons → Simple Icons brand
  marks (too much color, then too busy even in gray) → Remix Icon
  "-fill" glyphs → **Tabler stroke glyphs (current)**, pasted inline,
  never CDN-loaded — stroke-based so line weight stays a tunable value
  instead of being baked into solid path geometry. The "more options"
  chevron under a sectioned chip went from visible, to hover-only, to
  removed. `QUICK_ADD_SITES` shrank from eight sites to three (Instagram,
  YouTube, Facebook): Snapchat, then Reddit and Twitch, then TikTok and X.
- **The quick-add chips' circle came back for a while, then left again
  when the chips moved into the input.** The old circle was white with a shadow sitting on a white
  card, and the founder dropped it so the glyph sat bare in the row. They
  are now 36px circles in plain `--surface` gray with a
  `--surface-deep` hover, which is the same resting treatment every other
  control in the system has; a bare glyph had no affordance at all (no
  label, no container, no hover visible at rest) and read as a status
  icon. The enabling change was location: the row used to sit *inside*
  `.blocklist-surface`, so it looked like part of the list of things
  already blocked, and a gray circle would have been invisible on gray.
  It now sits above that surface on white, next to a small "Quick add"
  label, so everything above the gray surface means "add something" and
  the surface itself means only "what is blocked." That reasoning held,
  and is why the chips now live *inside* the url input, right-aligned:
  still above the list, still "add something", and the input box is the
  container the bare glyph was missing, so the circle went again and the
  label with it.
- Blocklist rows gained a hover fill (`--card-ground`, filling the
  `border-radius` `.url-item` already declared but never painted). It is
  wrapped in `@media (hover: hover)` on purpose: on touch, `:hover` sticks
  after a tap and the row would stay filled until you tapped elsewhere.
  This is how a long list gets per-row separation without the dividers
  this system rules out, so don't "improve" it by adding lines.
- Blocklist rows were sized up in the same pass (15px text, 18px
  favicons, ~40px rows; favicons have since come back down to 14px at
  `opacity: 0.9`). At 14px/14px, with the per-site white cards
  gone, five sites read as a dense settings list lost inside a surface
  built for something more substantial.
- **Inline red form errors.** Every dashboard form used to show its error
  as a red `.error-msg` line under the field, on the theory that an error
  should stay next to the thing it is about. Replaced by the same error
  toast the Strict-mode refusals already used, so every error reads the
  same and nothing shifts the form.
- **The landscape band behind the dashboard.** The landing page's closing
  artwork was reproduced behind the signed-in page (image plus a
  multi-stop white fade). Removed: the dashboard is plain white again,
  and the footer's frosted pills are now invisible there.
- **A scrolling dashboard with the full landing-page footer.** Briefly
  the dashboard became a scrolling page so the 716px art footer could sit
  under it. Reverted within the session: the dashboard stays one fixed
  100vh box, with the site nav on top and only the footer's link row at
  the bottom.
- **The avatar and "Sign out" in the sidebar footer.** Moved to the nav's
  account menu when the dashboard gained the site nav; the sidebar
  footer now holds only the Pro tag.
- **Landing-page feature tiles as working controls.** The "Block any site"
  tile once had live quick-add glyphs with hover menus, and the "Pause
  when you need to" tile a working switch with six duration bubbles.
  Replaced by static brand-colored app icons and a one-click toy (pill +
  bubble, "Blocking paused", no durations); the interactive blocklist
  demo lives only in the "Built around your day" preview now.
