// Tests for js/queue.js and js/days.js (which cards are due). Run with: node tests/queue.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, interleave, takeNext, addWaiting, newStudiedToday, formatInterval, NEW, LEARNING, REVIEW } from '../js/queue.js';
import { dayStart, dayEnd } from '../js/days.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();      // 7 Oct 2026, 3pm local time
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const card = id => ({ id, deckId: 'd', front: id, back: id });

test('the study day starts at 4am', () => {
  assert.equal(new Date(dayStart(NOW)).getHours(), 4);
  assert.equal(new Date(dayStart(NOW)).getDate(), 7);
  const lateNight = new Date(2026, 9, 8, 2, 0).getTime();       // 2am on the 8th still counts as the 7th
  assert.equal(new Date(dayStart(lateNight)).getDate(), 7);
  assert.equal(dayEnd(NOW) - dayStart(NOW), DAY);
});

test('due reviews, learning cards and new cards', () => {
  const cards = ['overdue', 'today', 'tomorrow', 'learnNow', 'learnLater', 'new1', 'new2', 'new3'].map(card);
  const states = new Map([
    ['overdue', { state: REVIEW, due: NOW - 2 * DAY }],
    ['today', { state: REVIEW, due: NOW + 3 * HOUR }],         // later today still counts as due today
    ['tomorrow', { state: REVIEW, due: NOW + 2 * DAY }],
    ['learnNow', { state: LEARNING, due: NOW + 5 * MIN }],     // within 20 minutes: show now
    ['learnLater', { state: LEARNING, due: NOW + 2 * HOUR }],  // waits until it's due
    ['new3', { state: NEW, due: NOW }]
  ]);
  const { queue, waiting, newAvailable } = buildQueue(cards, states, 2, NOW);
  const ids = queue.map(q => q.card.id);
  assert.equal(newAvailable, 3);
  assert.deepEqual(ids.filter(id => !id.startsWith('new')), ['overdue', 'learnNow', 'today']);
  assert.deepEqual(ids.filter(id => id.startsWith('new')), ['new1', 'new2']);   // limited to 2, in order
  assert.deepEqual(waiting.map(w => w.card.id), ['learnLater']);
  assert.ok(!ids.includes('tomorrow'));
});

test('new card limit of 0 means reviews only', () => {
  const { queue } = buildQueue([card('a')], new Map(), 0, NOW);
  assert.equal(queue.length, 0);
});

test('new cards are spread evenly between reviews', () => {
  const r = [1, 2, 3, 4].map(i => ({ kind: 'review', i }));
  const n = [1, 2].map(i => ({ kind: 'new', i }));
  assert.deepEqual(interleave(r, n).map(x => x.kind[0]).join(''), 'rrnrrn');
  assert.equal(interleave([], n).length, 2);
});

test('waiting learning cards come back when due, or early if nothing else is left', () => {
  const queue = [{ card: card('q') }];
  const waiting = [];
  addWaiting(waiting, { card: card('late'), due: NOW + 10 * MIN });
  addWaiting(waiting, { card: card('soon'), due: NOW - MIN });
  assert.deepEqual(waiting.map(w => w.card.id), ['soon', 'late']);
  assert.equal(takeNext(queue, waiting, NOW).card.id, 'soon');
  assert.equal(takeNext(queue, waiting, NOW).card.id, 'q');
  assert.equal(takeNext(queue, waiting, NOW).card.id, 'late');
  assert.equal(takeNext(queue, waiting, NOW), null);
});

test('new cards studied today count toward the daily limit', () => {
  const logs = [
    { cardId: 'a', state: NEW, timestamp: NOW - HOUR },
    { cardId: 'a', state: LEARNING, timestamp: NOW - 50 * MIN },
    { cardId: 'b', state: NEW, timestamp: NOW - 2 * HOUR },
    { cardId: 'c', state: NEW, timestamp: NOW - DAY }          // yesterday: doesn't count
  ];
  assert.equal(newStudiedToday(logs, NOW), 2);
});

test('interval labels', () => {
  assert.deepEqual([30e3, MIN, 10 * MIN, 5 * HOUR, 4 * DAY, 45 * DAY, 400 * DAY].map(formatInterval),
    ['<1m', '1m', '10m', '5h', '4d', '1.5mo', '1.1y']);
});

import { pickNew, newLimits, extraNewToday, aheadQueue, forgottenQueue } from '../js/queue.js';
const inDeck = (id, deckId) => ({ id, deckId, front: id, back: id });

test('each deck can have its own new card limit, inside the overall one', () => {
  const fresh = [inDeck('a1', 'A'), inDeck('a2', 'A'), inDeck('a3', 'A'), inDeck('b1', 'B'), inDeck('b2', 'B')];
  const ids = l => pickNew(fresh, l).map(c => c.id);
  assert.deepEqual(ids(3), ['a1', 'a2', 'a3']);
  assert.deepEqual(ids({ total: 10, byDeck: new Map([['A', 1]]) }), ['a1', 'b1', 'b2']);
  assert.deepEqual(ids({ total: 2, byDeck: new Map([['A', 1]]) }), ['a1', 'b1']);
  assert.deepEqual(ids({ total: 10, byDeck: new Map([['A', 0], ['B', 0]]) }), []);
});

test('new limits count what was already studied today, plus extras', () => {
  const decks = [{ id: 'A', newPerDay: 3 }, { id: 'B' }];
  const deckOf = new Map([['a1', 'A'], ['a2', 'A'], ['b1', 'B']]);
  const logs = [
    { cardId: 'a1', timestamp: NOW - HOUR, state: NEW }, { cardId: 'a1', timestamp: NOW - 30 * MIN, state: LEARNING },
    { cardId: 'a2', timestamp: NOW - DAY, state: NEW },        // yesterday: doesn't count
    { cardId: 'b1', timestamp: NOW - HOUR, state: NEW }
  ];
  const l = newLimits({ perDay: 20, decks, logs, deckOf, now: NOW });
  assert.equal(l.total, 18);
  assert.deepEqual([...l.byDeck], [['A', 2]]);
  const more = newLimits({ perDay: 20, decks, logs, deckOf, extra: 5, now: NOW });
  assert.equal(more.total, 23);
  assert.equal(more.byDeck.get('A'), 7);
  // buildQueue takes the same limits
  const { queue } = buildQueue([inDeck('x', 'A'), inDeck('y', 'A'), inDeck('z', 'A'), inDeck('w', 'B')], new Map(), l, NOW);
  assert.deepEqual(queue.map(q => q.card.id), ['x', 'y', 'w']);
});

test('extra new cards only count on the day they were added', () => {
  assert.equal(extraNewToday({ day: dayStart(NOW), n: 10 }, NOW), 10);
  assert.equal(extraNewToday({ day: dayStart(NOW - DAY), n: 10 }, NOW), 0);
  assert.equal(extraNewToday(undefined, NOW), 0);
});

test('review ahead: review cards due in the next few days, soonest first', () => {
  const cards = ['today', 'in1', 'in3', 'in9', 'learn', 'new'].map(card);
  const states = new Map([
    ['today', { state: REVIEW, due: NOW + HOUR }],
    ['in1', { state: REVIEW, due: NOW + DAY }],
    ['in3', { state: REVIEW, due: NOW + 3 * DAY }],
    ['in9', { state: REVIEW, due: NOW + 9 * DAY }],
    ['learn', { state: LEARNING, due: NOW + DAY }]
  ]);
  assert.deepEqual(aheadQueue(cards, states, 3, NOW).queue.map(q => q.card.id), ['in1', 'in3']);
  assert.deepEqual(aheadQueue(cards, states, 1, NOW).queue.map(q => q.card.id), ['in1']);
});

test('forgotten today: cards rated Again today, once each', () => {
  const cards = ['a', 'b', 'c', 'gone'].map(card);
  const states = new Map([['a', { state: 3, due: NOW }], ['b', { state: REVIEW, due: NOW + DAY }]]);
  const logs = [
    { cardId: 'b', timestamp: NOW - 2 * HOUR, rating: 1 },
    { cardId: 'a', timestamp: NOW - HOUR, rating: 1 },
    { cardId: 'b', timestamp: NOW - 30 * MIN, rating: 1 },
    { cardId: 'c', timestamp: NOW - HOUR, rating: 3 },
    { cardId: 'a', timestamp: NOW - DAY, rating: 1 },
    { cardId: 'deleted', timestamp: NOW - HOUR, rating: 1 }
  ];
  assert.deepEqual(forgottenQueue(cards, states, logs, NOW).queue.map(q => [q.card.id, q.kind]), [['b', 'review'], ['a', 'learn']]);
});
