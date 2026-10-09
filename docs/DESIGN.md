# Design system

The live visual system across `/web` (marketing pages and the dashboard) and
the extension (`popup.css`, `blocked.css`). It replaced an earlier
flat-black/hairline system wholesale, so anything describing hairlines,
`tokens.css`, `style.css` or Lora is history rather than current.

Approaches that were tried and dropped live in [DECISIONS.md](DECISIONS.md).

`/web` was rebuilt from scratch in a `web-v2/` trial folder and promoted
over the old pages, so nothing in the repo carries the old look any more.

---

## Principles

- **Flat, monochrome, no lines.** Black ink (`#000000`) on white paper
  (`#ffffff`), with two gray surfaces doing all the grouping work:
  `--surface: #f5f5f7` (every control's resting ground: inputs, pills,
  cards, the sidebar, the blocklist box) and `--surface-deep: #e8e8ed`
  (hover / "off" state of a surface). Muted text is `#6e6e73`.
  **No hairline borders, no dividers, no outlined chips, no box-shadows
  on resting elements** — a gray surface on white *is* the boundary. The
  only exceptions are informational lines (the schedule grid's hour lines
  and day separators, drawn as faint gradients/inset shadows because they
  carry real information) and the one floating shadow
  (`--shadow-float: 0 12px 40px rgba(0,0,0,0.12)`) reserved for things
  that genuinely float over the page: menus, popovers, toasts.
- **Color is for the two modes, nothing else.** Both are blue, the
  founder's own hand-picked pair: `#2081e3` for Friction, deep navy
  `#2250a6` for Strict — `--friction` / `--strict` in every stylesheet
  (dashboard also keeps the legacy aliases `--friction-teal` /
  `--strict-burgundy`, now written as `var(--friction)` / `var(--strict)`
  rather than duplicated hexes, so they can never drift again). Used as
  solid fills with white text (an active mode option, a schedule block,
  the blocked page's mode pill) or as a small dot — never as glows,
  tints, or borders. `--error` stays its own separate red `#d70015`, and
  is now the only red in the system. **Focus Pro has no
  color**: there is no Pro tag any more, and the upgrade CTA is white on an ink
  banner. Don't add a third color.
  Two things worth knowing about this pair specifically. First, it reads
  as one hue at two depths rather than two opposed signals, so Strict is
  "more of the same" instead of "the alarming one" — a deliberate move
  away from the signage look that killed the earlier blue/red pair, and
  the reason the old "Friction is calm, Strict is alarm" framing no
  longer describes what the colors do. Second, both clear 4.5:1 against
  white text for Strict (7.6:1) but not for Friction: `#2081e3` is 3.95:1,
  under the 4.5:1 that the 12-13px mode labels on a solid fill call for
  (the earlier `#0071e3` was 4.7:1). That is the cost of the lighter
  blue; darken it a step if the labels ever need to pass.
  The pair is identical in all four stylesheets as of this writing
  (`site.css`, `dashboard.html`, `popup.css`, `blocked.css`), plus
  `site.css`'s two `-dim` tints, which are the same colours at 10% and 9%.
  Smaller drifts remain and are harmless: `dashboard.html`'s `--paper` is
  `#fefeff` and `site.css`'s `--surface` is `#f5f5f9`.
  **The dashboard's own mode pill is the exception: it carries no
  colour.** "Friction Mode active" / "Strict Mode active" are a white
  pill with ink text, identical to the "Paused until" state. In the
  dashboard the mode colours now appear only on the schedule's blocks.
  (The landing page's copies of that pill, in the preview and the pause
  tile, are still blue.)
- **Shapes.** Surfaces are 24px radius (`--radius-surface`), inner
  items 14–16px (`--radius-inner`), fields 12px, and every button, tab,
  chip and toggle is a full pill (`--radius-pill: 999px`). Active state
  is "solid ink, white text" in the popup (the "Dashboard" link) and on
  the marketing pages, not an outline, not a color. The dashboard has two
  deliberate exceptions, both by the founder's call: the active sidebar
  item is ink text only (it briefly carried a 3px ink bar at its left
  edge, since removed), and the active
  profile tab is a white pill with ink text at weight 500, while every
  inactive tab is the same white pill at `opacity: 0.6` (0.85 on hover),
  the look a locked tab used to have on its own. A locked tab still adds
  its lock icon. The extension popup's profile pills follow the same
  rule (active ink at 500, the rest at 0.6), but keep the gray
  `--surface` ground, since the popup sits on white rather than on a gray
  card. The "+ profile" button is a 34px circle drawn with a
  dashed SVG ring (16 dashes, `stroke-dasharray: 3.75 2.73`, `--faint`),
  the one outlined control in the system: a dashed edge is the usual
  "this makes a new thing" cue. An SVG, because a CSS dashed border at
  1px renders ~50 specks on a 34px circle.
- **Type.** `DM Sans` (400/500/600) for all UI at 14–15px, and
  `Plus Jakarta Sans` **700** with `letter-spacing: -0.03em` for display
  moments only: page/section headlines, the sign-in title, the blocked
  page's title, the countdown numerals. Section labels are 0.7rem
  uppercase muted with 0.06–0.07em tracking. Both faces load from Google
  Fonts via `--font-ui` / `--font-display` (`--font-serif` is aliased to
  the display face where old rules still reference it). No serif.
- **Motion.** Small and physical: `translateY(-1px)` + `opacity: 0.86`
  on hover for ink buttons, `scale(0.98)` on press, 0.15–0.25s eases,
  `cubic-bezier(0.16, 1, 0.3, 1)` for anything that moves. Honor
  `prefers-reduced-motion`.
- **Sizing.** 44–48px primary buttons and fields, 34px tabs/pills
  (30px in the popup, whose card is 276px wide), 16px side gutters at phone width.
- **The signed-in dashboard is one gray card holding white surfaces, which
  inverts this document's usual "gray surface on white" rule.** It is the same
  two-surface relationship the hero's browser mock uses (gray frame, white
  screen), and it exists because a white shell on a white page had no
  visible edge, so the margin read as unfinished rather than as framing.
  The card carries the system's one resting shadow (founder's call): a
  tight contact shadow plus a wide ambient one,
  `0 1px 2px rgba(0,0,0,0.04), 0 8px 28px rgba(0,0,0,0.07)`, soft enough
  to read as depth rather than as a floating menu. The page behind it is
  a full-bleed artwork, `assets/images/dashback3.webp` (2560px wide,
  ~22KB, a soft peach-to-periwinkle glow fading to white at the bottom;
  two earlier candidates, `dashback.webp` and `dashback2.webp`, are still
  beside it), set as `#app-screen`'s background at
  `center / cover` with no fade or overlay, by the founder's call. The nav
  is transparent over it, and its link uses `#57575c` because `--muted`
  measured too low over the first artwork. Both source files had a dark
  1px edge (bottom and right); the WebPs are cropped in to drop it, so
  re-crop
  if it is ever re-exported. On phones `#app-screen` keeps
  `min-height: 100vh` so the image still covers a short page. A
  `--page-ground` token is still defined in `:root` but nothing uses it.
  **The status row described next is currently switched off.** One
  marked block in `dashboard.html` ("STATUS BAR SWITCHED OFF") hides it,
  gives the shell its 44px back, restores the 40px top margin and
  cancels the lift; deleting that block brings everything below back
  exactly as described. The markup, styles and JS are all intact. While
  it is off the dashboard has no mode readout and **no pause control**,
  and the popup cannot start or end a pause either.
  **The card holds the shell; the status sits above the card.** The mode
  pill and the pause bubble are in `.status-bar`, a row over the card,
  their right edge on the card's own right edge, on the page's artwork.
  They are account-wide state, so they show on every tab. Both wear the
  frosted glass of the landing page's footer pills (`--glass-bg`,
  `--glass-blur`) rather than a solid fill, with the label at weight 400 like the footer links and, to its left, a
  still 7px dot in the running mode's colour (`--friction`, `--strict`, or
  `--faint` gray while paused), the one place this pill shows the mode
  colours. While a mode runs, a halo of the same colour breathes behind
  it (to twice its size and back over 5s); paused, the dot is gray and
  still. A ring pinging outward every 2s was tried first and read as a
  radar; the rule targets
  `#mode-status` by id because the pill's state rules come later at the
  same class specificity. `--shell-pad-top` is 0, and on desktop the
  status row, the card and the note are additionally lifted 14px with a
  relative offset into the empty strip at the foot of the nav, so the
  card starts 31px under the nav's bottom edge. A negative margin does
  not work for that lift: the grid's top spacer row absorbs it. The
  status row takes `z-index: 41` so the transparent nav (40) does not
  swallow clicks where the two overlap. The "Blocklist syncs every minute" note sits
  below the card, so `.page-wrap` is five rows (spacer / status / card /
  note / spacer) with the three content rows carrying explicit
  `grid-row`s, since auto-placement would drop them into the spacers.
  `--status-bar-h` (44px: the 34px row and its 10px margin) is subtracted
  in the shell's height calc, and the shell's `min-height` floor dropped
  from 480 to 436 by the same amount, so on a short window the note does
  not run into the footer. The pair used to sit at the right end of the
  profile tabs row, inside the card. Keeping the note out of the card is
  what lets `.blocklist-surface` run to the card's bottom edge: it is
  `flex: 1`, so it takes whatever is left. The note is hidden with
  `visibility` (`.sync-hint.is-off`), never `display`, so its row stays
  reserved and the card does not jump between tabs; the nav handler
  toggles it in step with `.content-section`.
  A bottom bar holding pause + mode was tried and removed: at 690px wide
  with 190px of content it was 72% empty, and the two controls read as
  unrelated shapes rather than a designed row.
  - **One line does the flip: `.app-card { --surface: var(--paper); }`.**
    Redefining that token on the card, and nowhere else, turns every gray
    surface inside it white at once (sidebar, blocklist, fields, profile
    tabs, quick-add chips, settings rows). The card's own ground uses a
    separate `--card-ground` token, so it is not caught by its own
    override. To revert, delete `.app-card`'s rule and its wrapper div,
    restore the four rows, and drop the three `/* card flip */` overrides.
  - **`--surface-deep` is deliberately NOT redefined.** Hovers therefore
    darken from white to `#e8e8ed` instead of resolving to the card's own
    gray, which would make a hovered control vanish into the card.
  - **Three rules needed a `/* card flip */` override**, all the same
    failure: a white element inside a parent that just became white.
    `.pro-tag` in the sidebar (since removed with the tag), `.settings-item .field`, and
    `.btn-sm.light`. That last one was *already* invisible before the flip
    (`--surface` on an `--surface` parent), so it is a fix, not a
    regression.
  - **The schedule's day headings are part of the white grid, not the
    card.** `.sched-head-cell` is `--paper`, so the header and the day
    columns read as one white panel: the header carries the panel's top
    corner radius and the columns only round at the foot. It stays opaque,
    which is all its `position: sticky` needs. The one exception is the
    empty corner above the hour gutter, `.sched-head-cell--corner`, which
    is transparent: there is no white column beneath it, so white there
    would float as a lone square on the card. The hour labels in
    `.sched-gutter` sit on the card's gray for the same reason.
  - **`--card-pad` and `--note-block-h` are subtracted inside the shell's
    height calc.** Without that the card's extra chrome came out of the
    bottom margin; with it, the 72px `--shell-pad-bottom` floor is finally
    honest, and 1366x768 now measures 40 above / 72 below where the old
    layout gave 40/62.
  - **The signed-out screens keep their own card**, because `.auth-card`
    sits outside `.app-card` and so never sees the override: a gray card
    with white fields. They share the signed-in page's artwork, though:
    `#auth-screen` carries the same `dashback3.webp` background, so
    signing in doesn't change the page behind the card. Change both
    together if the background changes.
  **Check this class of change by measuring, not by looking**: walk every
  element under `#app-screen`, compare its background to the nearest
  ancestor that paints one, and flag any pair that matches with no border
  or shadow. That is what caught all three invisible elements above, and
  the same sweep caught seven vanished auth fields in an earlier attempt
  at this.
- **Nothing in the dashboard may grow without a ceiling.** The shell is a
  fixed-height box with `overflow: hidden`, and `.blocklist-surface` is
  `flex: 1` inside it, so anything above the list that grows takes its
  height straight out of the list. The profile tabs proved this: wrapping
  freely, they left 506px of list at 2 profiles, 296px at 12, and 24px
  with overflow at 25, degrading long before it looked wrong.
  `.profile-tabs` and the Schedule tab's `.sched-profiles` are therefore
  both capped at `calc(2 * 34px + 8px)` (two rows plus the gap) with
  `overflow-y: auto`, tabs cap at `max-width: 180px` with an ellipsis, and
  the active tab calls `scrollIntoView({ block: 'nearest' })` after render
  so it is never the one hidden below the fold. Two details that look
  optional and are not: **`min-width: 0` on the tab's inner span** is what
  actually lets a long name shrink, without it the `max-width` is ignored
  and the pill just grows; and the scroll-into-view runs **after** the
  loop, because tabs are appended from two places (the locked branch
  returns early).
  **The cut edge fades, so a capped row doesn't read as the full list.**
  When profiles are hidden below, the row's bottom 26px fades down to 8%
  (`.more-below`); once scrolled, the top does the same (`.more-above`).
  It is a mask, set by `updateScrollHints()` after each render, on scroll,
  on resize and when a section is shown (a hidden section's row measures
  0). Applies to `.profile-tabs` and `.sched-profiles`. A thin scroll
  indicator to the left of the row was tried in between and dropped.
  A tab's delete x is an 11px SVG on the lock's own box and stroke weight,
  not a typed "×", so the two are the same size on the same centre and
  swap without a jump in Strict Mode.
  The lock and the x are both `flex-shrink: 0`: the tab is a flex row
  capped at 180px, and a long name used to squeeze the icon rather than
  ellipsing itself.
  On the Schedule tab the same row also holds the Friction/Strict pair,
  pinned top-right with `align-items: flex-start` and `flex-wrap: nowrap`,
  separated from the profiles by a **32px minimum gap**. That gap is
  structural, not decorative: both groups use the identical `.sched-pill`
  shape, so at the old 8px the mode pair read as two more profiles.
- **Scrollbars are thumb-only and appear on hover.**
  `scrollbar-color: transparent transparent` at rest, going to
  `rgba(0,0,0,0.2)` on the thumb while the area is hovered, with
  `::-webkit-scrollbar` rules as the fallback where scrollbars still take
  layout space. Applied to `.profile-tabs`, `.url-list`, `.sched-profiles`,
  `#schedule-scroll` and `#section-settings`. Two things worth knowing:
  the hover target is not always the scroller (`.url-list` is inset inside
  `.blocklist-surface`'s padding, so the surface is the target), and on
  overlay-scrollbar systems the `::-webkit-scrollbar` width is ignored
  entirely, so verify with `scrollbar-color` rather than by screenshot.
- **Blocklist rows: `.url-item` fills on hover** (`--card-ground`, gated
  behind `@media (hover: hover)` so a tap does not leave it stuck on).
  That fills the `border-radius` the rule already declared but never
  painted, and gives a long list per-row separation without the dividers
  this system rules out. The favicon lifts from `opacity: 0.90` to full in
  the same hover.
- **The dashboard app shell is one fixed box pinned to the viewport**,
  not a scrolling page: `#app-screen` is a flex column,
  `height: 100vh; overflow: hidden`, holding the site nav, `.page-wrap`
  (a four-row grid, `flex: 1; min-height: 0`) and the footer's link row.
  `min-height: 0` matters: a flex item's default minimum is its content,
  which let the grid's spacer floors push the footer below the viewport.
  Size tokens in `dashboard.html`'s `:root`: `--container` (1020px, the
  shell), `--site-container` (1120px, the nav and footer, matching
  site.css so they line up with the marketing pages), `--shell-max-h`
  (620px), `--shell-pad-top` (40px), `--shell-pad-bottom` (72px),
  `--sidebar-w` (182px), `--nav-h` (68px) and `--footer-h` (38px of
  footer pills plus the footer's own bottom padding). The shell's height
  calc subtracts the nav, the footer, both pads, the card padding and the
  note row. `--shell-max-h` replaced an earlier
  `calc((100vh - …) * 0.88)`, which grew the shell on every tall monitor.
  The sidebar has no footer any more (the avatar and "Sign out" moved to
  the nav's account menu and the Pro tag was removed), so only the nav
  labels constrain `--sidebar-w`.
- **The dashboard wears the site's nav and the footer's link row, copied
  verbatim from site.css** (17px/1.55 type, the curly apostrophe in
  "Please Don’t Scroll", 1120px container), because the dashboard does not
  import site.css. If the nav or footer changes there, change it here too,
  and check the two pixel-for-pixel against a signed-in index.html. The
  dashboard's account menu is Settings (opens the section in place) and
  Sign out. The footer keeps `.footer--art`'s frosted pills, which now
  sit over the dashboard's artwork.
  **The shell sits high on the page, and how it gets there took three
  tries — don't "simplify" it back.** The founder wants a small margin
  above and a large one below. Top-aligning (`align-content: start`)
  dumps 100% of the slack below the shell, which on a tall monitor is a
  runaway bottom gap; centering it (`align-content: center`, even with
  uneven padding) pulls it back toward the middle as the viewport grows,
  which the founder rejected as not high enough. Current mechanism:
  `.page-wrap` has spacer rows above and below the content, weighted
  `minmax(var(--shell-pad-top), 1fr)` and
  `minmax(var(--shell-pad-bottom), 3fr)`, so free space splits a
  quarter above / three-quarters below and the two tokens act as
  *floors* rather than fixed margins. `.app-card` and `.sync-hint` need
  explicit `grid-row: 2` / `grid-row: 3`, since auto-placement would
  otherwise drop them into the spacers. **Retune by changing the 1fr:3fr
  ratio**, not the floors and not the alignment. Measured from the nav's
  bottom to the card, and from the card to the footer row (which includes
  the 30px note row): 40/102 at 1280x800 and 1440x900, 99/325 at
  1440x1200.
  **The mobile block must release the clamp** (`#app-screen { height:
  auto; overflow: visible }`, `.page-wrap { height: auto; display:
  block }`) since the shell is auto-height and scrolls there; without
  that the page is cut off at 100vh.
- **Copy.** Sentence case, direct, feature-led ("Stop scrolling for
  good."), no em dashes in anything a user reads (see ARCHITECTURE.md's
  user-facing copy rule).
- **Every dashboard error is a toast.** Form validation included: no
  inline red lines under fields, no layout shift. `showError(msg)` wraps
  `showToast(msg, true)`; the toast is `role="status"`.
- **The schedule marks "now".** Today's day name goes from muted to ink,
  and a plain stick crosses today's column at the current time, white
  with a 2px ink outline (it briefly had a round head), inset 2px so the
  outline ends on the column's edges, the same
  treatment as the resize handles (`placeScheduleNowLine()`, re-run every
  minute and on returning to the tab, separately from the grid render so
  it never rebuilds the grid mid-drag). It draws over the blocks
  (`z-index: 1`) and under the resize handles (3) and the sticky header
  (2). A plain ink line behind the blocks, white inside a running block,
  was the first version. It reads the device's clock, the same as the
  active-block mirror.
- **A block's three corner controls.** On hover or selection: the two
  resize handles (top right, bottom left) and a delete disc at the top
  left, built exactly like a handle (a 10px white disc with a 2px ink
  ring) and holding an ink x. Delete used to be a row in the popover; it is
  also Delete/Backspace on a focused block. A locked block (the scheduled
  Strict block in force) shows none of the three.
- **The block popover is as wide as its Friction/Strict pair and no
  wider.** The caption and every row are `width: 0; min-width: 100%`, so
  they add nothing to the popover's width and then fill it; a long
  profile name ends in an ellipsis inside the same 12px margins.
- **Schedule resize handles always paint on top.** `.sched-block-handle`
  carries `z-index: 3` permanently, above the sticky day header (2), and
  neither `.sched-col` nor `.sched-block` sets a z-index, so neither is a
  stacking context that could trap it. The old fix lifted the hovered
  block's column with a `:has(:hover)` rule instead; that z-index dropped
  the instant hover ended, so the handles got clipped by the next column
  during their 0.15s fade-out, and it never cleared the header at all.
  The handles are `pointer-events: none` until their block is hovered or
  selected. Invisible handles used to stay hit-testable, and their 22px
  hit areas overhang the neighbouring day and the slots around the block,
  so roughly one paint drag in three near an existing block silently
  became a resize of a block the user couldn't see.
- **Illustrations** are hand-drawn artwork pasted in as inline SVG, one
  filled path per drawing with `fill="currentColor"` so a CSS color drives
  it. Each exported file ships two paths, a background shape and the ink;
  **keep only the ink**, since the background shape would paint a visible
  rectangle wherever the ground is not that exact color. Where a drawing
  needs an opaque body (the hero monitor sitting on colored grounds), the
  background path is reused as a white fill clipped to the union of the
  artwork's own regions, which follows the hand-drawn edge exactly instead
  of approximating it with a rectangle. Earlier drawings were clean vector
  geometry run through an SVG displacement filter to fake a hand-drawn
  wobble; that filter is gone now that the wobble is real.
  **Sizing note, kept because the principle outlives the section:** size
  two drawings by their ink, never by their box. Exports leave differing
  margins inside their own viewBox, so equal CSS widths render unequal
  ink; measure `getBBox()` against the rendered box. The mode band this
  applied to (`.ink--drawn` / `.ink--breath` / `.band__copy`) was deleted
  with the "Pick your boundary" section and none of those classes exist.
- **The hero's blocked-page mock (`.browser` in `index.html`) is shaped by
  `aspect-ratio`, not by its contents.** It is markup rather than a
  drawing, so the text inside stays real text and tracks the mode tokens.
  Two things hold the shape: `aspect-ratio: 4 / 3` on the frame, and
  `grid-template-rows: auto 1fr` so the page row absorbs whatever the
  chrome bar leaves. **`.browser__page` then needs
  `grid-template-rows: minmax(0, 1fr)`** — the default `auto` row grows to
  its content and spills straight out of the height the ratio handed down,
  which is easy to miss because the frame still *looks* right. The
  contents (ring, type scale, padding, gaps) are tuned to fit that box, so
  changing the ratio means re-tuning them; measure each `.bp__view`'s
  `scrollHeight` against the page's inner height at several widths rather
  than eyeballing one. 16:10 was tried first and read as a letterbox next
  to this much centered text; 4:3 is the founder's middle ground between
  that and the original content-driven shape, which was slightly taller
  than wide.
  **Its three window dots are macOS traffic lights in real color**
  (`#ff5f57` / `#febc2e` / `#28c840`, close / minimize / zoom, hardcoded
  because they are Apple's colors and must not follow a token). This is
  not a breach of "color is for the two modes, nothing else" — it is a
  literal depiction of something real, not the brand speaking. Note the
  blocklist's favicons used to be cited here as the same kind of
  exception, and they still are: grayscale was tried on them and the
  founder kept the colour, so both survive on that reasoning. What the
  blocklist rows do carry is `opacity: 0.90` at rest going to full on row
  hover, which quiets them without draining them. Don't gray them out to enforce that rule.

**Where it lives.** Each document keeps its own `:root` (this is a
build-free repo with no shared stylesheet across the extension and the
site — a shared `tokens.css` was tried once for `/web` and reverted after
it broke the pages), but the values are copied verbatim from
`web/dashboard.html`'s `:root`. If a token changes, change it in all
of: `web/site.css`, `web/dashboard.html`, `extension/popup/popup.css`,
`extension/blocked/blocked.css`.

**Verified by screenshot, not by eye.** These surfaces are checked with
throwaway Playwright harnesses that stub `chrome.*` for the popup and
blocked page and inject fake state into the dashboard. They live outside
the repo, so rebuild one when changing any of this rather than trusting a
CSS diff. Contrast and spacing are worth measuring rather than eyeballing:
several bugs here were invisible until measured (white-on-white controls,
a note that failed AA over the background image).

**`index.html`'s demos.** Two are working controls holding state in
plain module-scope memory in the page's own inline `<script type="module">`
(no Supabase, no `localStorage`, gone on reload), and two tiles are toys:
- **The hero's blocked-page mock** loops the real Friction flow in real
  time: 30s countdown, the completion screen, then back. The reset to 30
  happens while the countdown is still faded out under the completion
  screen, so it fades back in already full; resetting after it had
  reappeared showed a 0 and an empty ring that then snapped to 30.
- **The "Built around your day" preview is the dashboard's Blocklist
  pane, rebuilt at the dashboard's sizes**: one gray card with the same
  resting shadow, white tabs (active ink, inactive at 0.6), the dashed
  "+" ring, the Friction pill and pause bubble, the input with the three
  quick-add glyphs inside it and an "Add" button, then the white list
  surface with hover-only remove buttons. Profiles, quick add (including
  the section menus) and removal work; the pill, the bubble, the ring and
  the input are pictures. When the dashboard's pane changes, change this
  to match. Three rules:
  - **Its add rules come from `/core`** (`parseBlocklistEntry`,
    `entryCovers` from `blocklist/hostname.js`), so quick-adding
    `youtube.com` retires an existing `youtube.com/shorts` row and a
    redundant add is refused, exactly as `handleAddUrl()` does. Don't
    reimplement the comparison here.
  - **`.preview__sites` has a fixed `height`, not `min-height`.** Adds can
    push it past seven rows, and a minimum let that stretch the whole
    `#profiles` grid; overflow scrolls inside the surface instead.
  - **Chip state is derived from the list on every render**, never
    tracked, same as `currentBlocklistEntries` in the dashboard.
  Below 560px the pill and bubble move above the tabs, right-aligned.
- **Each feature is a small card holding only its picture, with the
  heading and copy on the page below it.** `.tile__card` is the same thin
  gray frame (8px of `--surface`) around a white body (`.tile__stage`) as
  the hero's browser and the preview, spanning its whole column (the same
  width as the text below it, identical for all four) at one fixed 124px
  height, so the headings line up across each row. Each picture is
  centred and sized for that box: 40px app icons, a Monday-first week of 62px-tall
  day cells, up to 380px wide, under the dashboard's 3-letter
  uppercase day names, the lock and link at their normal size. Inside the white body the controls that
  sit white on gray elsewhere (the pause bubble, the paused pill, the
  week's day cells) take `--surface` instead, or they would vanish. The
  privacy card holds the hand-drawn lock and the "Read the privacy
  policy" link side by side, the one card whose contents are a real link.
- **One resting shadow, `--shadow-card`**
  (`0 1px 2px rgba(0,0,0,0.04), 0 8px 28px rgba(0,0,0,0.07)`), on every
  card of the landing page (the hero's browser, the preview, the feature
  tiles, both plans) and on the dashboard's `.app-card`.
- **"Block any site" shows the brands as app icons in their own colours**
  (`.app-icon--*`: Instagram's gradient, TikTok and X black, YouTube red,
  Facebook blue, Reddit orange, Twitch purple), white Tabler glyphs on
  rounded squares, no interaction. Brand colour is allowed here for the
  same reason the favicons and the traffic lights are: it depicts
  something real. 40px icons, 10px apart, shrinking with the viewport
  (`clamp(26px, 7.4vw, 40px)`) so all seven fit one line inside
  the tile on a 360px phone.
- **"Pause when you need to" is a toy, drawn as a zoomed-in crop of the
  dashboard's tabs row** (the same pane "Built around your day" shows
  whole): two tabs and the + ring dimmed and fading out under a white
  gradient on the card's left edge, then the "Friction Mode active" pill
  and the pause bubble, scaled up 1.18x from the row's right end so the
  bubble is the focus (unscaled below 560px). The bubble toggles the pill
  to "Blocking paused" and back, with no durations. It must stay on
  Friction: Strict can't be paused, and the dashboard hides the bubble
  in Strict.

**The extension popup is one white card on a white ground.** `body` is
white with 3px of padding and `.container` is the white card (18px
radius, no shadow, 17px of padding) holding everything, header included,
so the popup reads as plain white with 20px to every edge and 20px
between every group. The status line and the "Dashboard" button share a
row when they fit; a longer status ("Paused until 8:46 PM", "No sites
blocked yet") keeps its full text and the button wraps to its own line,
right-aligned. Controls inside it
take the gray `--surface`. Profile pills cap at
`max-width: 100%` of the card's content area, not a pixel value, so a
very long name ends in an ellipsis inside the card at any card width. `.panel` only wraps what sits under the header
and paints nothing. The popup is 250px wide.

**Two deliberate exceptions to "no imagery": `index.html`'s photographic
bands.** The landing page opens with `.prelude` and closes with `.footer--art`,
both full bleed, both fading into the page rather than ending on an edge.
They are one page's bookends, not a return to imagery as a background
treatment — don't put pictures behind sections, and don't add them to
`pricing.html` or `privacy.html` without the founder asking.

`.prelude` is a painted sky running **behind** the top of the document,
`position: absolute; z-index: -1`, taking no space in flow. The fade is
deliberately aggressive, fully opaque white by 55% of its height, and the
band's own `opacity` sits on top of that (currently `1`; it was 0.55
behind an earlier, louder image). Lighten or strengthen
it with that one number rather than by softening the gradient: the page
behind is white, so element opacity washes the sky toward that white
evenly and leaves the already-white tail of the fade untouched. Three
things had to change together to make a true backdrop work, and each is
easy to undo by accident:
- **The page ground moved from `body` to `html`.** In CSS paint order a
  non-positioned block's background (body's) covers negative-z-index
  children, while the root element's propagated canvas background does
  not. Put `background` back on `body` and the backdrop vanishes
  completely, with no other symptom.
- **`.nav` goes transparent at rest.** It is `position: sticky` with an
  opaque `--paper` background, so it would punch a white strip through
  the most visible part of the sky. `site.js` toggles `.nav--over` while
  `scrollY < 8`; opaque is the CSS default, so a JS failure leaves the
  nav readable rather than see-through. Don't invert that default.
- **Once scrolled, the nav is frosted rather than a flat white bar**:
  `rgba(255,255,255,0.55)` with `backdrop-filter: blur(16px)
  saturate(1.4)`, so the sky behind shows through as a soft blur.
  It sits inside `@supports`, and opaque `--paper` stays the fallback, so
  a browser without backdrop-filter never gets text over text. Shared by
  pricing and privacy, where on plain white it just reads as white.
- **`.nav__link` goes to full ink under `.nav--over`.** `--muted` is a
  light gray tuned for white and is illegible on the blue.
It ships as **WebP** (`web/assets/images/landscape.webp`, 2560x1440,
~177KB, the same file the footer band uses). Keep the format: the band is full
bleed, so it needs roughly 2x the viewport width to stay sharp, and JPEG
at that size cost 457KB for the same picture. An earlier halftone
version was the extreme case, 900KB as JPEG against 360KB as WebP, and
downscaling to dodge that produced visible mush at retina density. When
re-exporting, encode WebP at q80-84 from the largest source available
rather than shrinking a JPEG.

The closing band is **`.footer--art`**, the footer itself carrying the
artwork as a background (`assets/images/landscape.webp`, the same file the
sky uses) with a white-to-transparent overlay fading its top into the
page. It is not the old gouache-background treatment returning: one image,
on one page, below all the content, where it cannot make any surface
inconsistent with another. Don't reintroduce paintings as page or section
backgrounds. The fade's far stop is written `rgba(255, 255, 255, 0)`
rather than `transparent` on purpose, so no engine interpolates it through
transparent black and leaves a gray haze mid-gradient.
**It also carries a `box-shadow` of its own colour, and that is a bug fix,
not decoration — don't delete it.** `scrollHeight` rounds UP to a whole
pixel while the page's real height is fractional, so at full scroll a
sub-pixel strip of the `<html>` ground showed beneath the band as a white
hairline. A taller band cannot fix it (the rounding gap reappears at the
new height) and nor can a negative margin (`scrollHeight` still follows
body's content box). A shadow works because it paints outside the border
box and the spec excludes it from scrollable overflow. Re-sample the
colour from the artwork's bottom edge if the image changes.
The footer's own links and copyright sit in two frosted pills, tuned via
`--glass-bg` / `--glass-blur`; the hero eyebrow has its own
`--eyebrow-bg` / `--eyebrow-blur` so the two can be set apart.
