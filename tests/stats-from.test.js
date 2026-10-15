// calendarFromDays' `from` option: the grid starts at the week holding the 1st of the first month with answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarFromDays, firstAnswerTime, dayKey, daysAgoStart } from '../js/stats-calc.js';

const NOW = new Date(2026, 9, 14, 12).getTime();      // Wed 14 Oct 2026

test('firstAnswerTime finds the earliest day with answers', () => {
  assert.equal(firstAnswerTime(new Map()), null);
  const m = new Map([[dayKey(new Date(2026, 7, 6, 12).getTime()), 2], ['2026-01-01', 0], [dayKey(new Date(2026, 8, 2, 12).getTime()), 1]]);
  const t = new Date(firstAnswerTime(m));
  assert.deepEqual([t.getFullYear(), t.getMonth(), t.getDate()], [2026, 7, 6]);
});

test('from starts the calendar at the week of the 1st of that month', () => {
  const from = new Date(2026, 7, 6, 12).getTime();
  const cal = calendarFromDays(new Map(), NOW, 53, { from });
  const first = new Date(cal.weeks[0][0].time);
  assert.equal(first.getDay(), 1);                                  // a Monday
  assert.ok(first <= new Date(2026, 7, 1, 12) && first > new Date(2026, 6, 24, 12), first.toDateString());
  assert.equal(cal.weeks.length, 12);                              // 27 Jul ... the week of 12 Oct
  assert.equal(cal.weeks.at(-1).some(d => dayKey(d.time) === dayKey(NOW)), true);
});

test('from never shows more than `weeks`, and no from keeps the full year', () => {
  assert.equal(calendarFromDays(new Map(), NOW, 53, { from: new Date(2020, 0, 5).getTime() }).weeks.length, 53);
  assert.equal(calendarFromDays(new Map(), NOW, 53).weeks.length, 53);
  assert.equal(calendarFromDays(new Map(), NOW, 53, { from: daysAgoStart(0, NOW) }).weeks.length, 3);   // this month: 28 Sep week to now
});
