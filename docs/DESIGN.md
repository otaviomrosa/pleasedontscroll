# Design

The visual system for the website, the dashboard and the extension. It
replaced the earlier flat black-and-white system and its paintings in one
pass, modelled on [FocusPocus](https://github.com/gugeldev/focus-pocus)
(MIT, see [THIRD_PARTY_NOTICES.md](../pds/THIRD_PARTY_NOTICES.md)).

## Principles

- **One product, one look.** Every surface uses the same tokens, type,
  shapes and motion. The landing page's mocks are drawn with the same
  classes as the real popup, focus screen and dashboard.
- **Light, quiet, one accent.** White canvas, near-white surfaces, hairline
  borders, a single violet. Atmosphere (dots, glows, the spell, the silk)
  lives only on the website and the focus screen, never inside controls.
- **Show the product working.** The hero popup, dashboard and focus screen
  are interactive, and the blocklist mock uses the real matching rules
  from `/core`.
- **Short, practical copy.** Say what it does. No em dashes in anything a
  user reads.

## Tokens

Defined in `web/site.css` (website and dashboard) and `extension/ui.css`
(popup and focus screen). The two lists are copies; change both.

| Token | Value | Use |
| --- | --- | --- |
| `--canvas` | `#ffffff` | Page |
| `--surface` | `#fcfcfe` | Panels (dashboard pane) |
| `--raised` / `--raised-hover` | `#f6f6fa` / `#efeff5` | Fields, segmented controls, pills |
| `--border` | `#eeeef4` | Hairlines and list dividers |
| `--text` / `--text-muted` / `--text-faint` | `#12111c` / `#55536a` / `#8c8aa0` | Three text levels |
| `--accent` | `#7c3aed` | Primary buttons, live states, Friction |
| `--strict` | `#4c1d95` | Strict, the same hue one step deeper |
| `--brand` | `#5b21b6` | The logo tile |
| `--danger` / `--danger-soft` | `#e5374e` / `#d0354a` | End session, delete, the schedule's now line |

Friction and Strict are one hue at two depths, so Strict reads as "more of
the same", not as an alarm.

## Type

Plus Jakarta Sans, self-hosted from `assets/fonts` (one variable file, no
Google Fonts request). Display sizes use weight 500 with tight tracking
(`-0.045em` hero, `-0.035em` section titles); UI text is 13 to 15px.
Countdowns use tabular figures.

## Shapes and elevation

- Buttons and pills: full radius. Fields: 12px. Cards: 16 to 24px. The
  install panel: 32px.
- Resting elevation is a 1px hairline, not a shadow. `--shadow-float` is
  for things drawn floating over the page (mocks, plan cards, auth card),
  `--shadow-popover` for menus and toasts.

## Motion

- Entrances rise with a short blur (`rise`, 900ms) on load, and reveal on
  scroll via `data-reveal`.
- The spell turns once every four minutes, the silk drifts, the hero popup
  floats, the focus screen's aura drifts.
- `prefers-reduced-motion` finishes every animation at once.

## Logo

A violet tile with a white ring and a centre dot: the session timer,
reduced to a mark. Source in `extension/assets/icons/logo.svg`; the PNG
icons and favicons are renders of it.

## Surfaces

- **Website** (`index`, `pricing`, `privacy`): shared header that pulls in
  to a floating pill on scroll, dot grid and spell backdrop, column guide
  lines, shared footer. Header, footer and backdrop markup is identical on
  every page.
- **Dashboard**: an options-page layout. Sidebar with navigation, the live
  session card and the account row; a raised pane for Blocklist, Schedule
  and Settings. All blocklist, profile and schedule behaviour is unchanged.
- **Popup** (352px): dial, mode, profile, length, one primary action.
  Friction sessions end with two clicks; Strict shows when it unlocks.
- **Focus screen**: the time left in the session, a way back, and in
  Friction a 30-second breath that opens the site for 10 minutes.

## Product change that came with it

Blocking now runs only during a session (migration 021). The popup starts
one with a mode, a profile and a length (15m, 30m, 1h, 2h, 6h); scheduled
blocks start sessions on their own. Pause was removed, since nothing is
blocked outside a session.
