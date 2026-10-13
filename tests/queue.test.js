// Tests for js/queue.js and js/days.js (which cards are due). Run with: node tests/queue.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, interleave, takeNext, addWaiting, newStudiedToday, formatInterval, limitSiblings, answeredNotes, NEW, LEARNING, RELEARNING, REVIEW } from '../js/queue.js';
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

import { pickNew, newLimits, extraNewToday, aheadQueue, forgottenQueue, reviewLimits } from '../js/queue.js';
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

test('Play answers that were only logged do not use up new cards, applied ones do', () => {
  const decks = [{ id: 'A' }], deckOf = new Map([['p1', 'A'], ['p2', 'A'], ['p3', 'A']]);
  const logs = [
    { cardId: 'p1', timestamp: NOW - HOUR, state: NEW, source: 'play', applied: false, reason: 'new' },
    { cardId: 'p2', timestamp: NOW - HOUR, state: NEW, source: 'play', applied: false, reason: 'new-limit' },
    { cardId: 'p3', timestamp: NOW - HOUR, state: NEW, source: 'play', applied: true, reason: 'first' }
  ];
  assert.equal(newLimits({ perDay: 20, decks, logs, deckOf, now: NOW }).total, 19);
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


test('daily review limit: overall and per deck, learning cards never held back', () => {
  const cs = [inDeck('r1', 'A'), inDeck('r2', 'A'), inDeck('r3', 'B'), inDeck('r4', 'B'), inDeck('l1', 'A')];
  const states = new Map([
    ['r1', { state: REVIEW, due: NOW - 4 * DAY }], ['r2', { state: REVIEW, due: NOW - 3 * DAY }],
    ['r3', { state: REVIEW, due: NOW - 2 * DAY }], ['r4', { state: REVIEW, due: NOW - DAY }],
    ['l1', { state: LEARNING, due: NOW - 60000 }]
  ]);
  const ids = lim => buildQueue(cs, states, 0, NOW, lim).queue.map(q => q.card.id);
  assert.deepEqual(ids(Infinity), ['r1', 'r2', 'r3', 'r4', 'l1']);
  assert.deepEqual(ids(2), ['r1', 'r2', 'l1']);                                         // most overdue first
  assert.deepEqual(ids({ total: 10, byDeck: new Map([['A', 1]]) }), ['r1', 'r3', 'r4', 'l1']);
  const decks = [{ id: 'A', reviewPerDay: 2 }, { id: 'B' }];
  const deckOf = new Map([['r1', 'A'], ['r3', 'B']]);
  const logs = [
    { cardId: 'r1', timestamp: NOW - HOUR, state: REVIEW, source: 'review' },
    { cardId: 'r3', timestamp: NOW - HOUR, state: REVIEW, source: 'play', applied: true },
    { cardId: 'r3', timestamp: NOW - HOUR, state: REVIEW, source: 'play', applied: false },     // didn't count
    { cardId: 'r1', timestamp: NOW - HOUR, state: LEARNING, source: 'review' },                // not a review
    { cardId: 'r1', timestamp: NOW - DAY, state: REVIEW, source: 'review' }                    // yesterday
  ];
  const l = reviewLimits({ perDay: 10, decks, logs, deckOf, now: NOW });
  assert.equal(l.total, 8);
  assert.deepEqual([...l.byDeck], [['A', 1]]);
  assert.equal(reviewLimits({ perDay: null, decks: [], logs, deckOf, now: NOW }).total, Infinity);
});

test('subdecks: a parent deck\'s limits cap everything inside it', () => {
  // Psych (limit 3 new) › Unit 1 (limit 2) and Unit 2 (no limit of its own); Bio has no limit.
  const decks = [{ id: 'P', newPerDay: 3 }, { id: 'U1', parentId: 'P', newPerDay: 2 }, { id: 'U2', parentId: 'P' }, { id: 'B' }];
  const chains = new Map([['P', ['P']], ['U1', ['U1', 'P']], ['U2', ['U2', 'P']], ['B', ['B']]]);
  const fresh = ['u1a', 'u1b', 'u1c', 'u2a', 'u2b', 'b1'].map(id => inDeck(id, id.startsWith('u1') ? 'U1' : id.startsWith('u2') ? 'U2' : 'B'));
  const studiedToday = [{ cardId: 'old', timestamp: NOW - HOUR, state: NEW }];          // one new card done in Unit 2
  const deckOf = new Map([['old', 'U2']]);
  const l = newLimits({ perDay: 20, decks, logs: studiedToday, deckOf, now: NOW, chains });
  assert.deepEqual([...l.byDeck], [['P', 2], ['U1', 2]]);                               // Psych has 2 left (3 − 1 in Unit 2)
  assert.deepEqual(pickNew(fresh, l).map(c => c.id), ['u1a', 'u1b', 'b1']);            // Psych's 2 used by Unit 1, so none from Unit 2
  // reviews done in a subdeck count toward the parent
  const r = reviewLimits({ perDay: null, decks: [{ id: 'P', reviewPerDay: 5 }], logs: [{ cardId: 'x', timestamp: NOW - HOUR, state: REVIEW, source: 'review' }], deckOf: new Map([['x', 'U1']]), now: NOW, chains });
  assert.equal(r.byDeck.get('P'), 4);
});

test('newRoomFor / takeNewFor: Play in an exam deck respects the new-card limits', async () => {
  const { newRoomFor, takeNewFor } = await import('../js/queue.js');
  const chains = new Map([['kid', ['kid', 'par']], ['par', ['par']], ['other', ['other']]]);
  const limit = { total: 3, byDeck: new Map([['par', 2]]), chains };
  assert.equal(newRoomFor(limit, 'kid'), true);
  assert.equal(takeNewFor(limit, 'kid'), true);
  assert.equal(takeNewFor(limit, 'kid'), true);
  assert.equal(limit.total, 1);
  assert.equal(newRoomFor(limit, 'kid'), false);          // the parent deck's own limit is used up
  assert.equal(takeNewFor(limit, 'kid'), false);
  assert.equal(takeNewFor(limit, 'other'), true);         // another deck still has the overall limit
  assert.equal(newRoomFor(limit, 'other'), false);        // overall limit now 0
});

test('exam final pass: a card planned for today is due today, and the biggest gains come first', () => {
  const cards = ['planned', 'later', 'big', 'small', 'learnNow'].map(card);
  const states = new Map([
    ['planned', { state: REVIEW, due: NOW + 40 * DAY }],       // saved far away, but the exam plan brings it to today
    ['later', { state: REVIEW, due: NOW + 40 * DAY }],         // not planned: stays where it is
    ['big', { state: REVIEW, due: NOW - DAY }],
    ['small', { state: REVIEW, due: NOW - 5 * DAY }],
    ['learnNow', { state: LEARNING, due: NOW }]
  ]);
  const exam = { caps: new Map([['planned', dayStart(NOW)]]), gain: new Map([['planned', 0.2], ['big', 0.3], ['small', 0.01]]) };
  const { queue } = buildQueue(cards, states, 0, NOW, Infinity, exam);
  assert.deepEqual(queue.map(q => q.card.id), ['learnNow', 'big', 'planned', 'small']);     // 'later' is not due
  // without the exam: the usual order, most overdue first, and the far-off card stays away
  assert.deepEqual(buildQueue(cards, states, 0, NOW).queue.map(q => q.card.id), ['small', 'big', 'learnNow']);
});

test('exam final pass: the review limit keeps the biggest gains', () => {
  const cards = ['a', 'b', 'c'].map(card);
  const states = new Map(cards.map((c, i) => [c.id, { state: REVIEW, due: NOW - (i + 1) * DAY }]));
  const exam = { caps: new Map(), gain: new Map([['a', 0.01], ['b', 0.05], ['c', 0.2]]) };
  assert.deepEqual(buildQueue(cards, states, 0, NOW, 2, exam).queue.map(q => q.card.id), ['c', 'b']);
});

test('review ahead leaves out cards the exam brought to today', () => {
  const states = new Map([['a', { state: REVIEW, due: NOW + 40 * DAY }], ['b', { state: REVIEW, due: NOW + 2 * DAY }]]);
  assert.deepEqual(aheadQueue(['a', 'b'].map(card), states, 3, NOW).queue.map(q => q.card.id), ['b']);
  assert.deepEqual(aheadQueue(['a', 'b'].map(card), states, 3, NOW, new Map([['a', dayEnd(NOW) + HOUR]])).queue.map(q => q.card.id), ['a', 'b']);
});

// ---------- cloze siblings ----------
const sibCard = (id, note) => ({ id, deckId: 'd', front: id, back: id, ...(note ? { noteId: note, cloze: 1 } : {}) });

test('siblings: two due cards of one note show only one, the most overdue', () => {
  const cards = [sibCard('a1', 'A'), sibCard('a2', 'A'), sibCard('plain')];
  const states = new Map([['a1', { state: REVIEW, due: NOW - DAY }], ['a2', { state: REVIEW, due: NOW - 3 * DAY }], ['plain', { state: REVIEW, due: NOW - DAY }]]);
  const { queue } = buildQueue(cards, states, 5, NOW);
  assert.deepEqual(queue.map(q => q.card.id).sort(), ['a2', 'plain']);
});

test('siblings: a learning card comes before a review, a review before a new card', () => {
  let cards = [sibCard('r', 'A'), sibCard('l', 'A'), sibCard('n', 'A')];
  let states = new Map([['r', { state: REVIEW, due: NOW - DAY }], ['l', { state: LEARNING, due: NOW + 5 * MIN }]]);
  assert.deepEqual(buildQueue(cards, states, 5, NOW).queue.map(q => q.card.id), ['l']);
  states = new Map([['r', { state: REVIEW, due: NOW - DAY }]]);
  assert.deepEqual(buildQueue(cards, states, 5, NOW).queue.map(q => q.card.id), ['r']);
  cards = [sibCard('n1', 'A'), sibCard('n2', 'A')];
  assert.deepEqual(buildQueue(cards, new Map(), 5, NOW).queue.map(q => q.card.id), ['n1']);         // new: the first one
  // a learning card due later today still holds its place
  states = new Map([['r', { state: REVIEW, due: NOW - DAY }], ['l', { state: LEARNING, due: NOW + 2 * HOUR }]]);
  const q = buildQueue([sibCard('r', 'A'), sibCard('l', 'A')], states, 5, NOW);
  assert.deepEqual([q.queue.length, q.waiting.map(w => w.card.id)], [0, ['l']]);
});

test('siblings: a card from the note answered today hides the others, but not itself coming back', () => {
  const cards = [sibCard('a1', 'A'), sibCard('a2', 'A'), sibCard('a3', 'A')];
  const logs = [{ cardId: 'a1', timestamp: NOW - HOUR, source: 'review' }, { cardId: 'a3', timestamp: NOW - DAY * 2, source: 'review' }, { cardId: 'a3', timestamp: NOW - HOUR, source: 'play', applied: false }];
  const answered = answeredNotes(logs, cards, NOW);
  assert.deepEqual([...answered.get('A')], ['a1']);
  const states = new Map([['a1', { state: LEARNING, due: NOW + 5 * MIN }], ['a2', { state: REVIEW, due: NOW - DAY }], ['a3', { state: REVIEW, due: NOW - DAY }]]);
  assert.deepEqual(buildQueue(cards, states, 5, NOW, Infinity, null, answered).queue.map(q => q.card.id), ['a1']);
  // the learning card has been done with: only a2 and a3 left, and the note was answered today, so nothing shows
  states.set('a1', { state: REVIEW, due: NOW + 5 * DAY });
  assert.deepEqual(buildQueue(cards, states, 5, NOW, Infinity, null, answered).queue.length, 0);
});

test('siblings: learning cards are never held back, even when the whole note was answered today', () => {
  const cards = [sibCard('a1', 'A'), sibCard('a2', 'A'), sibCard('a3', 'A')];
  const logs = [{ cardId: 'a1', timestamp: NOW - HOUR, source: 'review' }, { cardId: 'a2', timestamp: NOW - HOUR, source: 'review' }];
  const answered = answeredNotes(logs, cards, NOW);
  const states = new Map([['a1', { state: LEARNING, due: NOW + 5 * MIN }], ['a2', { state: RELEARNING, due: NOW + 6 * MIN }], ['a3', { state: REVIEW, due: NOW - DAY }]]);
  assert.deepEqual(buildQueue(cards, states, 5, NOW, Infinity, null, answered).queue.map(q => q.card.id).sort(), ['a1', 'a2']);   // a3 waits for tomorrow
});

test('siblings: a hidden sibling does not use up a new-card slot, and ordinary cards are untouched', () => {
  const cards = [sibCard('n1', 'A'), sibCard('n2', 'A'), sibCard('p1'), sibCard('p2')];
  const q = buildQueue(cards, new Map(), 2, NOW).queue.map(x => x.card.id);
  assert.deepEqual(q, ['n1', 'p1']);
  assert.deepEqual(limitSiblings([{ card: sibCard('x'), kind: 'review' }, { card: sibCard('y'), kind: 'review' }]).length, 2);
});
