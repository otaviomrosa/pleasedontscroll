// test/schedule-active.test.js — pure schedule/clock helpers used by the
// extension's boundary alarm and the dashboard's "active now" mirror.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayAndMinute, activeBlockAt, nextBoundaryAt } from '../core/schedule/active.js';

// 2026-09-14 is a Monday. Local-time constructor, so these are wall-clock values.
const mon = (h, m = 0) => new Date(2026, 8, 14, h, m);
const sun = (h, m = 0) => new Date(2026, 8, 20, h, m);

const blocks = [
  { id: 'a', day_of_week: 0, start_min: 540, end_min: 660, mode: 'friction' }, // Mon 9-11
  { id: 'b', day_of_week: 0, start_min: 660, end_min: 720, mode: 'strict' },   // Mon 11-12, abuts a
  { id: 'c', day_of_week: 6, start_min: 1320, end_min: 1440, mode: 'strict' }, // Sun 22-24
];

test('localDayAndMinute: Monday is 0, Sunday is 6, minutes from local midnight', () => {
  assert.deepEqual(localDayAndMinute(mon(9, 15)), { day: 0, minute: 555 });
  assert.deepEqual(localDayAndMinute(sun(23, 59)), { day: 6, minute: 1439 });
});

test('activeBlockAt: inside, at start, and half-open at the end', () => {
  assert.equal(activeBlockAt(blocks, mon(10)).id, 'a');
  assert.equal(activeBlockAt(blocks, mon(9)).id, 'a');       // start is inclusive
  assert.equal(activeBlockAt(blocks, mon(11)).id, 'b');      // a ended, b started: exactly one match
  assert.equal(activeBlockAt(blocks, mon(12)), null);        // end is exclusive
  assert.equal(activeBlockAt(blocks, mon(8, 59)), null);
});

test('activeBlockAt: wrong day is not active; a block ending at midnight covers 23:59', () => {
  assert.equal(activeBlockAt(blocks, new Date(2026, 8, 15, 10)), null); // Tuesday
  assert.equal(activeBlockAt(blocks, sun(23, 59)).id, 'c');
});

test('nextBoundaryAt: next edge later the same day', () => {
  assert.deepEqual(nextBoundaryAt(blocks, mon(8)), mon(9));
  assert.deepEqual(nextBoundaryAt(blocks, mon(9, 30)), mon(11));
  assert.deepEqual(nextBoundaryAt(blocks, mon(11)), mon(12)); // a boundary at "now" is not "next"
});

test('nextBoundaryAt: rolls forward across days, and a midnight end lands on the next day', () => {
  assert.deepEqual(nextBoundaryAt(blocks, mon(13)), sun(22));
  assert.deepEqual(nextBoundaryAt(blocks, sun(23)), new Date(2026, 8, 21, 0, 0)); // Sun 24:00 == Mon 00:00
  assert.deepEqual(nextBoundaryAt(blocks, new Date(2026, 8, 21, 0, 0)), new Date(2026, 8, 21, 9, 0));
});

test('nextBoundaryAt: no blocks means no alarm', () => {
  assert.equal(nextBoundaryAt([], mon(8)), null);
});
