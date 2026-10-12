// Tests for js/study-data.js (what Today counts). Run with: node tests/study-data.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countFor, answeredToday, typicalCardMs, DEFAULT_CARD_MS, scopeKey } from '../js/study-data.js';
import { buildQueue, splitCards, newLimits, reviewLimits } from '../js/queue.js';
import { chainMap } from '../js/deck-tree.js';

const DAY = 86400000;
const now = Date.now();
const decks = [{ id: 'a', name: 'A', created: 1 }, { id: 'a1', name: 'A1', parentId: 'a', created: 2 }, { id: 'b', name: 'B', created: 3 }];
const cards = [];
const statesById = new Map();
for (let i = 0; i < 60; i++) {
  const c = { id: 'c' + i, deckId: ['a', 'a1', 'b'][i % 3], front: 'f' + i, back: 'b' + i, created: i };
  cards.push(c);
  if (i % 2) statesById.set(c.id, { cardId: c.id, state: i % 7 === 0 ? 1 : 2, due: now + (i % 5 - 2) * DAY / 3 });
}
const chains = chainMap(decks);
const deckOf = new Map(cards.map(c => [c.id, c.deckId]));
const data = {
  decks, cards, statesById, deckOf, logs: [], chains,
  newLeft: newLimits({ perDay: 7, decks, logs: [], deckOf, chains }),
  reviewLeft: reviewLimits({ perDay: 9, decks, logs: [], deckOf, chains }),
};
data.split = splitCards(cards, statesById, now); data.splitAt = Date.now();

test('counting a deck from the pre-sorted lists gives the same numbers as building its queue', () => {
  for (const ids of [['a'], ['a1'], ['b'], ['a', 'b'], ['a', 'a1', 'b']]) {
    const inside = new Set(ids.flatMap(id => id === 'a' ? ['a', 'a1'] : [id]));
    const q = buildQueue(cards.filter(c => inside.has(c.deckId)), statesById, data.newLeft, Date.now(), data.reviewLeft);
    const got = countFor(data, ids);
    assert.equal(got.fresh, q.queue.filter(x => x.kind === 'new').length, ids.join());
    assert.equal(got.due, q.queue.filter(x => x.kind !== 'new').length + q.waiting.length, ids.join());
    assert.equal(got.cards.length, cards.filter(c => inside.has(c.deckId)).length);
  }
});

test('the daily goal counts answers in the same decks as the cards to go', () => {
  const logs = [['c0', 'review'], ['c1', 'review'], ['c2', 'play'], ['c1', 'anki']].map(([cardId, source]) => ({ cardId, source, timestamp: now }));
  const d = { ...data, logs };
  assert.equal(answeredToday(d, []), 3);          // all decks (anki imports aren't today's work)
  assert.equal(answeredToday(d, ['b']), 1);       // c2 is in b
  assert.equal(answeredToday(d, ['a']), 2);       // c0 in a, c1 in a1
});

test('time per card comes from the gaps between reviews in a session', () => {
  assert.equal(typicalCardMs([], now), DEFAULT_CARD_MS);
  const at = i => now - 1000000 + i;
  // ten reviews, 20 seconds apart, but only 3 seconds to turn each card over
  const logs = Array.from({ length: 10 }, (_, i) => ({ source: 'review', timestamp: at(i * 20000), ms: 3000 }));
  assert.equal(typicalCardMs(logs, now), 20000);
  // a long pause (a break) is not counted, and a slow card counts as at most a minute
  const withBreak = [...logs, { source: 'review', timestamp: at(10 * 20000 + 600000), ms: 1 }, { source: 'review', timestamp: at(10 * 20000 + 600000 + 100000), ms: 1 }];
  assert.equal(typicalCardMs(withBreak, now), 20000);
  const slow = Array.from({ length: 8 }, (_, i) => ({ source: 'review', timestamp: at(i * 100000), ms: 1 }));
  assert.equal(typicalCardMs(slow, now), 60000);                 // 100 seconds a card counts as a minute at most
  const breaks = Array.from({ length: 8 }, (_, i) => ({ source: 'review', timestamp: at(i * 300000), ms: 1 }));
  assert.equal(typicalCardMs(breaks, now), DEFAULT_CARD_MS);    // every gap is a break: nothing to go on
  assert.equal(typicalCardMs(logs.map(l => ({ ...l, source: 'play' })), now), DEFAULT_CARD_MS);
});

test('review ahead by 3 days and by 7 days are different sessions', () => {
  assert.notEqual(scopeKey(['a'], 'ahead', 3), scopeKey(['a'], 'ahead', 7));
  assert.equal(scopeKey(['b', 'a'], 'ahead', 7), scopeKey(['a', 'b'], 'ahead', 7));
  assert.equal(scopeKey(['a']), scopeKey(['a'], null, 3));      // days left out means the usual 3
});
