# Weekly Schedule Feature — Design & Implementation Tracker

**Status: brainstorming / design phase. Nothing has been built yet.**

This is a working doc for a single big feature, not architecture reference
(that's docs/ARCHITECTURE.md) and not the launch checklist (that's TODO.md). Once this
feature ships, fold the settled parts of this into docs/ARCHITECTURE.md's §5 and delete
this file — don't let it become a second, competing source of truth.

## The problem this is trying to solve

Strict Mode's 30-second exit hold is the weak link — it stops an impulsive
exit but not really a planned one. The idea: let a user pre-schedule which
profile + mode should be active for repeating blocks of the week, so the
commitment is made in a calm moment, in advance, the same way Strict Mode
itself already works, just extended across a whole week instead of "right
now."

## Core mechanics (decided)

- **New tab in the dashboard**, separate from Blocklist/Settings. One box:
  title row + a 7-day-wide calendar grid.
- **Paint interaction, not a form.** User picks a profile + mode, then
  drags across the grid to "paint" a block of time on a given day. This is
  a from-scratch custom UI component (drag/paint, not a list of start/end
  time inputs).
- **Collision handling is a paint-time constraint, not a validation error.**
  The user simply cannot paint or drag over a cell that's already covered
  by an existing block — no overlapping blocks are ever produced in the
  first place, so there's no "reject on save" step to design.
- **Resizing**: hovering a block reveals a small handle (a ball) at its
  top-right and bottom-left corners; dragging one resizes that edge.
- **Block appearance**: each painted block shows the profile's name, is
  colored by its mode (reusing the existing Friction teal / Strict
  burgundy — see docs/ARCHITECTURE.md §4's Colors entry, `--friction`/`--strict` in
  the extension, this dashboard's own `--friction-teal`/`--strict-burgundy`
  mode-pill tokens), and displays the time range it covers, computed
  automatically from its position/size, never typed in by hand.
- **While a Strict block is currently active**: that block cannot be
  edited or deleted. This is a deliberate, final decision, not an open
  question — see "Resolved: no whole-schedule lock" below for why the
  founder rejected extending this to future/non-active Strict blocks too.
- **While a Friction block is currently active**: the user is free to
  switch profiles or edit the blocklist as normal, same as Friction Mode
  already behaves everywhere else in this app.
- **Overriding a Friction block deactivates it for that occurrence only.**
  If the user switches profiles away from what a Friction block says
  should be active, that specific occurrence (today's instance of that
  recurring weekly slot) is treated as overridden/skipped — next week's
  occurrence of the same slot is unaffected. Same scope as editing a single
  instance of a recurring calendar event, not the whole series.

## Resolved: no whole-schedule lock on Strict blocks

Earlier concern raised: if only the *currently active* Strict block is
protected, a user could defeat the whole feature by editing tomorrow's
Strict block today, one step ahead of ever being inside it.

**Founder's call: this is fine as-is, don't guard against it.** Reasoning:
this app's entire mechanism is about fighting a temporary, in-the-moment
urge, not a calculated, planned decision made a day in advance. A user
who is deliberately, calmly planning ahead to defeat tomorrow's block could
just as easily uninstall the extension entirely — there's no version of
this feature that stops someone that determined, and trying to build one
would mean locking the entire schedule against all edits indefinitely once
a single Strict block exists, which is a much heavier, more punishing
mechanism than what this app has ever done elsewhere (Strict Mode itself
only ever guards the *current* moment, never future hypothetical ones).
Consistent with the existing philosophy already documented in docs/ARCHITECTURE.md
§5 — enforcement targets impulse, not premeditation.

## Still open / not yet decided

- **How to make the 30-second exit hold itself more strict.** Founder is
  still brainstorming this independently of the scheduling feature. Ideas
  raised so far in conversation (not committed to anything): a longer
  hold, an accountability-partner approval gate (see below), possibly
  something else entirely. Revisit once scheduling's shape is locked in.
- **Forced transitions at a block's start time.** When a scheduled block
  begins, does the extension force-switch the active profile/mode
  immediately (interrupting whatever the user is doing), or does it just
  refuse to let them leave once they're there? Leaning toward the latter
  (matches how Freedom/Opal behave — block enforcement kicks in without a
  forced context switch) but not decided.
- **Timezone / DST.** A weekly recurring schedule needs to mean the same
  wall-clock time every week regardless of DST — likely needs a timezone
  field somewhere (per-user setting or per-schedule-row), not just a raw
  UTC timestamp per block.
- **Library/build question.** Recommendation on the table: no bundler, no
  new runtime dependency — hand-roll the paint/drag/resize grid in vanilla
  JS + CSS grid, consistent with every other build-free precedent in this
  codebase (hand-rolled REST instead of the Supabase SDK, pasted-in SVGs
  instead of CDN-loaded icons). If a library ever turns out to be worth it,
  the fallback is a plain `<script src="cdn...">` tag (same pattern as
  Google Fonts) — never an actual bundler/build step. Not yet finalized.

## Rough implementation shape (sketch, not a real plan yet)

- **Schema**: new `schedules` table — one row per painted block:
  `user_id`, `profile_id` (FK), `day_of_week`, `start_time`, `end_time`,
  `mode` (`friction | strict`). Needs its own RLS policy file in the same
  commit as the migration, per docs/ARCHITECTURE.md's rule.
- **`/core/sync/schedules.js`**: `fetchSchedules`, `createScheduleBlock`,
  `updateScheduleBlock`, `deleteScheduleBlock` — same shape as
  `profiles.js`/`blockedUrls.js`. A DB trigger rejects editing/deleting a
  row that is both currently active and `mode = 'strict'` (mirrors
  `011_lock_mode_guards.sql`'s pattern; deliberately row-scoped only, see
  "Resolved" above, not a whole-schedule check).
- **`background/index.js`**: needs a new time-driven check — "what does
  the schedule say should be active right now" — that doesn't exist
  anywhere in this codebase yet (everything today is reactive to tab
  navigation, not to a clock). Likely piggybacks on the existing 60s
  `chrome.alarms` poll rather than adding a second alarm.
- **`dashboard.html`**: new sidebar nav item + content section, the
  paint/drag/resize weekly grid component itself (the single biggest
  chunk of net-new code in this feature), rendering blocks from
  `fetchSchedules()` and writing back through the `/core/sync/schedules.js`
  functions above.

## Sizing

Medium-to-large. Backend/enforcement reuses a lot of what already exists
(profiles, `blocking_mode`, Strict Mode's existing guards) — the genuinely
novel pieces are the time-driven background check (a new category of logic
for this codebase) and the calendar UI itself (the biggest single piece of
new code either way, library or not).
