// Tests for js/stats-calc.js (numbers on the Stats tab). Run with: node tests/stats.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, daysAgoStart, dayStreak, retention, isDueReview, reviewsPerDay, dueForecast, hardestCards, niceMax } from '../js/stats-calc.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();   // 7 Oct 2026, 3pm
const HOUR = 3600000, DAY = 24 * HOUR;
const at = (daysAgo, hour = 12) => { const d = new Date(daysAgoStart(daysAgo, NOW)); d.setHours(hour); return d.getTime(); };
const log = (daysAgo, extra = {}) => ({ cardId: 'a', timestamp: at(daysAgo), source: 'review', correct: true, state: 2, ...extra });

test('day keys follow the 4am study day', () => {
  assert.equal(dayKey(NOW), '2026-10-07');
  assert.equal(dayKey(new Date(2026, 9, 8, 2).getTime()), '2026-10-07');   // 2am counts as the day before
  assert.equal(dayKey(new Date(2026, 9, 8, 5).getTime()), '2026-10-08');
  assert.equal(dayKey(daysAgoStart(1, NOW)), '2026-10-06');
  assert.equal(dayKey(daysAgoStart(-2, NOW)), '2026-10-09');
});

test('streak counts back from today', () => {
  const s = dayStreak([log(0), log(1), log(2), log(4)], NOW);
  assert.equal(s.days, 3);
  assert.equal(s.studiedToday, true);
  assert.deepEqual(s.week.map(d => d.on), [false, false, true, false, true, true, true]);
  assert.equal(s.week[6].today, true);
});

test('streak still counts if you have not studied yet today', () => {
  assert.equal(dayStreak([log(1), log(2)], NOW).days, 2);
  assert.equal(dayStreak([log(1), log(2)], NOW).studiedToday, false);
  assert.equal(dayStreak([log(2)], NOW).days, 0);
  assert.equal(dayStreak([], NOW).days, 0);
});

test('Play answers count toward the streak', () => {
  assert.equal(dayStreak([log(0, { source: 'play' })], NOW).days, 1);
});

test('retention: due reviews in the last 30 days', () => {
  const logs = [
    log(1), log(2), log(3, { correct: false }),                          // 2 of 3 remembered
    log(1, { state: 0, correct: false }),                                // new card: not a due review
    log(1, { state: 1, correct: false }),                                // learning step: not counted
    log(40, { correct: false }),                                         // too old
    log(0, { source: 'play', reason: 'due', correct: true }),            // Play answer that was the card's review
    log(0, { source: 'play', reason: 'not-due', correct: true }),        // Play on a card not due: not counted
    log(0, { source: 'play', reason: 'again', correct: false })          // not due, missed: not a due review
  ];
  const r = retention(logs, NOW);
  assert.deepEqual([r.remembered, r.total], [3, 4]);
  assert.equal(r.rate, 0.75);
  assert.equal(retention([], NOW).rate, null);
});

test('older Play logs without a reason count when they changed the schedule', () => {
  assert.equal(isDueReview({ source: 'play', state: 2, applied: true }), true);
  assert.equal(isDueReview({ source: 'play', state: 2, applied: false }), false);
});

test('reviews per day, split by source', () => {
  const rows = reviewsPerDay([log(0), log(0, { source: 'play' }), log(2), log(31), log(0, { source: 'test' })], NOW);
  assert.equal(rows.length, 30);
  assert.deepEqual(rows[29], { time: daysAgoStart(0, NOW), review: 1, play: 1, total: 2 });
  assert.equal(rows[27].total, 1);
  assert.equal(rows.reduce((n, r) => n + r.total, 0), 3);
});

test('due forecast for the next 7 days', () => {
  const states = [
    { state: 2, due: NOW - 3 * DAY },     // overdue: today
    { state: 2, due: NOW + 2 * HOUR },    // later today
    { state: 1, due: NOW + 10 * 60000 },  // learning card: today
    { state: 2, due: NOW + 1 * DAY },     // tomorrow
    { state: 2, due: NOW + 6 * DAY },     // day 6
    { state: 2, due: NOW + 20 * DAY },    // beyond the week
    { state: 0, due: NOW }                // new: not counted
  ];
  assert.deepEqual(dueForecast(states, NOW).map(d => d.count), [3, 1, 0, 0, 0, 0, 1]);
  assert.equal(dayKey(dueForecast(states, NOW)[1].time), '2026-10-08');
});

test('hardest cards: most lapses, then most misses', () => {
  const cards = ['a', 'b', 'c', 'd'].map(id => ({ id, front: id }));
  const states = new Map([['a', { lapses: 1 }], ['b', { lapses: 4 }], ['c', { lapses: 0 }]]);
  const logs = [{ cardId: 'c', timestamp: at(1), source: 'play', correct: false }, { cardId: 'a', timestamp: at(1), source: 'review', correct: false }, { cardId: 'a', timestamp: at(2), source: 'review', correct: false }];
  const h = hardestCards(cards, states, logs, NOW);
  assert.deepEqual(h.map(x => x.card.id), ['b', 'a', 'c']);     // d has never been missed
  assert.deepEqual([h[1].lapses, h[1].misses], [1, 2]);
});

test('clean axis tops', () => {
  assert.deepEqual([0, 3, 7, 12, 48, 51, 180, 1000].map(niceMax), [5, 5, 10, 20, 50, 100, 200, 1000]);
});
