// Tests for js/stats-calc.js (numbers on the Stats tab). Run with: node tests/stats.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, daysAgoStart, dayStreak, retention, isDueReview, reviewsPerDay, dueForecast, hardestCards, niceMax, studyCalendar, buttonCounts, hourly, difficultyBands } from '../js/stats-calc.js';

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

test('study calendar: weeks start on Monday, newest on the right, darker on busier days', () => {
  // 7 Oct 2026 is a Wednesday. Answers: 2 today, 1 yesterday, 1 three days ago, and 3 days in a row a while back.
  const logs = [log(0), log(0), log(1), log(3), log(8), log(9), log(10)];
  const cal = studyCalendar(logs, NOW, 3);
  assert.equal(cal.weeks.length, 3);
  assert.ok(cal.weeks.every(w => w.length === 7));
  assert.equal(new Date(cal.weeks[0][0].time).getDay(), 1);                     // a Monday
  assert.equal(new Date(cal.weeks[0][0].time).getDate(), 21);                   // 21 Sep
  const today = cal.weeks[2][2];                                                 // this week's Wednesday
  assert.equal(dayKey(today.time), dayKey(NOW));
  assert.deepEqual([today.count, today.level], [2, 4]);
  assert.deepEqual([cal.weeks[2][1].count, cal.weeks[2][1].level], [1, 2]);     // yesterday
  assert.ok(cal.weeks[2].slice(3).every(d => d.future && d.count === 0));         // Thu–Sun haven't happened yet
  assert.equal(cal.daysStudied, 6);
  assert.equal(cal.answers, 7);
  assert.equal(cal.daysShown, 17);
  assert.equal(cal.longest, 3);
});

test('study calendar with no answers', () => {
  const cal = studyCalendar([], NOW);
  assert.equal(cal.weeks.length, 53);
  assert.deepEqual([cal.max, cal.daysStudied, cal.longest], [0, 0, 0]);
});


test('answer buttons: learning vs review, last 30 days', () => {
  const logs = [log(0, { rating: 3, state: 2 }), log(1, { rating: 1, state: 2, correct: false }), log(2, { rating: 4, state: 2 }), log(3, { rating: 2, state: 0 }),
    log(40, { rating: 1, state: 2 }), log(1, { source: 'play', rating: 3, state: 2 }), log(1, { source: 'review', rating: 3, state: 1 })];
  const b = buttonCounts(logs, NOW);
  assert.deepEqual(b.review, [1, 0, 2, 1]);
  assert.deepEqual(b.learning, [0, 1, 1, 0]);
  assert.equal(b.reviewRight, 75);
  assert.equal(buttonCounts([], NOW).reviewRight, null);
});

test('time of day', () => {
  const at9 = d => { const t = new Date(daysAgoStart(d, NOW)); t.setHours(9, 30); return t.getTime(); };
  const h = hourly([{ ...log(0), timestamp: at9(0) }, { ...log(1), timestamp: at9(1), correct: false }, log(0)], NOW);
  assert.equal(h.length, 24);
  assert.deepEqual([h[9].total, h[9].right], [2, 1]);
  assert.equal(h[12].total, 1);
});

test('difficulty bands', () => {
  const b = difficultyBands([{ state: 2, difficulty: 1 }, { state: 2, difficulty: 5.5 }, { state: 3, difficulty: 10 }, { state: 0, difficulty: 5 }, null]);
  assert.deepEqual(b.filter(x => x.count).map(x => [x.band, x.count]), [[1, 1], [6, 1], [10, 1]]);
});
