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
  // a long pause (a break) is not counted
  const withBreak = [...logs, { source: 'review', timestamp: at(10 * 20000 + 600000), ms: 1 }, { source: 'review', timestamp: at(10 * 20000 + 600000 + 100000), ms: 1 }];
  assert.equal(typicalCardMs(withBreak, now), 20000);
  // a minute or more between answers is not "a card": no gap counts, so the 8-second default stays
  const slow = Array.from({ length: 8 }, (_, i) => ({ source: 'review', timestamp: at(i * 100000), ms: 1 }));
  assert.equal(typicalCardMs(slow, now), DEFAULT_CARD_MS);
  const breaks = Array.from({ length: 8 }, (_, i) => ({ source: 'review', timestamp: at(i * 300000), ms: 1 }));
  assert.equal(typicalCardMs(breaks, now), DEFAULT_CARD_MS);
  assert.equal(typicalCardMs(logs.map(l => ({ ...l, source: 'play' })), now), DEFAULT_CARD_MS);
  assert.equal(typicalCardMs(logs.map(l => ({ ...l, source: 'anki' })), now), DEFAULT_CARD_MS);
});

// A deterministic wobble so the "real" logs below are not perfectly regular.
const wobble = i => ((i * 7919) % 11) / 10;          // 0 .. 1
const session = (start, n, base, spread) => Array.from({ length: n }, (_, i) => ({ source: 'review', timestamp: start += Math.round(base + wobble(i) * spread), ms: 4000 }));

test('time per card on realistic logs: 5 to 15 seconds a card, sessions hours apart', () => {
  const HOUR = 3600000;
  const logs = [];
  for (let d = 1; d <= 20; d++) {
    logs.push(...session(now - d * DAY, 25, 5000, 10000));            // a morning session
    logs.push(...session(now - d * DAY + 9 * HOUR, 25, 5000, 10000)); // an evening one, 9 hours later
  }
  const ms = typicalCardMs(logs, now);
  assert.ok(ms >= 7000 && ms <= 13000, `got ${ms}`);
  // 76 cards is then a quarter of an hour at most, not 76 minutes
  assert.ok(76 * ms / 60000 < 16);
});

test('time per card ignores Play rounds, imported Anki history and a few slow cards', () => {
  const HOUR = 3600000;
  const real = [];
  for (let d = 1; d <= 10; d++) real.push(...session(now - d * DAY, 30, 6000, 8000));
  const base = typicalCardMs(real, now);
  // imported Anki history with made-up times (70 seconds a card, thousands of rows) and a Play round, 2 seconds an answer
  const anki = Array.from({ length: 3000 }, (_, i) => ({ source: 'anki', timestamp: now - 30 * DAY + i * 70000, ms: 0 }));
  const play = Array.from({ length: 200 }, (_, i) => ({ source: 'play', timestamp: now - 3 * DAY + i * 2000, ms: 500 }));
  assert.equal(typicalCardMs([...real, ...anki, ...play], now), base);
  // a few cards that took a minute and a half (looked something up) are not counted
  const withLookups = [...real, ...Array.from({ length: 6 }, (_, i) => ({ source: 'review', timestamp: now - 12 * HOUR + i * 90000, ms: 1 }))];
  assert.equal(typicalCardMs(withLookups, now), base);
});

test('time per card follows recent habits when there are enough recent reviews', () => {
  const old = session(now - 50 * DAY, 100, 30000, 8000);             // 50 days ago: slow, 30 to 38 seconds a card
  const recent = session(now - 2 * DAY, 60, 6000, 4000);            // lately: 6 to 10 seconds
  const ms = typicalCardMs([...old, ...recent], now);
  assert.ok(ms >= 6000 && ms <= 10000, `got ${ms}`);
  // with only a few recent reviews, the older history is still used
  const fewRecent = typicalCardMs([...old, ...session(now - DAY, 4, 6000, 0)], now);
  assert.ok(fewRecent >= 30000, `got ${fewRecent}`);
});

test('review ahead by 3 days and by 7 days are different sessions', () => {
  assert.notEqual(scopeKey(['a'], 'ahead', 3), scopeKey(['a'], 'ahead', 7));
  assert.equal(scopeKey(['b', 'a'], 'ahead', 7), scopeKey(['a', 'b'], 'ahead', 7));
  assert.equal(scopeKey(['a']), scopeKey(['a'], null, 3));      // days left out means the usual 3
});

test('Today counts a cloze note once, the same as the Review queue, and exam prep keeps every sibling', async () => {
  const { customQueue } = await import('../js/study-data.js');
  const { answeredNotes } = await import('../js/queue.js');
  const cl = [1, 2, 3].map(n => ({ id: 'k' + n, deckId: 'b', front: 'f', back: 'b', noteId: 'N', cloze: n, created: 1000 + n }));
  const plain = { id: 'p', deckId: 'b', front: 'p', back: 'p', created: 1 };
  const all = [plain, ...cl];
  const st = new Map(all.map(c => [c.id, { cardId: c.id, state: 2, due: now - DAY, lastReview: now - 5 * DAY }]));
  const d = { ...data, cards: all, statesById: st, logs: [], answered: new Map(), deckOf: new Map(all.map(c => [c.id, 'b'])) };
  d.split = splitCards(all, st, now); d.splitAt = Date.now();
  d.exam = { caps: new Map(), gain: new Map() };
  const c = countFor(d, ['b']);
  const { queue } = buildQueue(all, st, d.newLeft, now, d.reviewLeft, null, d.answered);
  assert.equal(c.due, 2);                      // the plain card and one sibling
  assert.equal(queue.length, c.due);
  // one sibling answered today: the other two stay out, the answered one is not due any more
  st.set('k1', { cardId: 'k1', state: 2, due: now + 4 * DAY, lastReview: now - 1000 });
  d.answered = answeredNotes([{ cardId: 'k1', timestamp: now - 1000, source: 'review' }], all, now);
  d.split = splitCards(all, st, now); d.splitAt = Date.now();
  assert.equal(countFor(d, ['b']).due, 1);
  // exam prep: every sibling due for a look, whatever Review shows
  const ymd = new Date(now + 5 * DAY);
  const examDate = `${ymd.getFullYear()}-${String(ymd.getMonth() + 1).padStart(2, '0')}-${String(ymd.getDate()).padStart(2, '0')}`;
  const deckExam = { ...d, decks: d.decks.map(x => (x.id === 'b' ? { ...x, examDate } : x)) };
  const prep = customQueue('prep', deckExam, all, 3);
  assert.deepEqual(prep.queue.map(x => x.card.id).filter(id => id.startsWith('k')).sort(), ['k2', 'k3']);
});

test('review ahead leaves out siblings of a card that is still due today', async () => {
  const { customQueue } = await import('../js/study-data.js');
  const cl = [1, 2, 3].map(n => ({ id: 'k' + n, deckId: 'b', front: 'f', back: 'b', noteId: 'N', cloze: n, created: n }));
  const st = new Map(cl.map(c => [c.id, { cardId: c.id, state: 2, due: now + 2 * DAY, lastReview: now - DAY }]));
  const d = { ...data, cards: cl, statesById: st, logs: [], answered: new Map(), exam: { caps: new Map(), gain: new Map() } };
  d.split = splitCards(cl, st, now);
  assert.equal(customQueue('ahead', d, cl, 3).queue.length, 1);          // nothing due today: one of the three
  st.set('k1', { cardId: 'k1', state: 2, due: now - DAY, lastReview: now - 5 * DAY });
  d.split = splitCards(cl, st, now);                                      // k1 is due today and will be in Review
  assert.equal(customQueue('ahead', d, cl, 3).queue.length, 0);
});

test('countFor passes the catch-up plan on: the backlog is capped and new cards pause', () => {
  const cs = [], st = new Map();
  for (let i = 0; i < 50; i++) { cs.push({ id: 'o' + i, deckId: 'b', created: i }); st.set('o' + i, { cardId: 'o' + i, state: 2, due: now - 8 * DAY - i }); }
  cs.push({ id: 'n1', deckId: 'b', created: 99 });
  const base = { ...data, cards: cs, statesById: st, split: splitCards(cs, st, now), splitAt: Date.now(), rescue: null,
    newLeft: newLimits({ perDay: 5, decks, logs: [], deckOf: new Map(cs.map(c => [c.id, 'b'])), chains }), reviewLeft: { total: Infinity, byDeck: new Map(), chains } };
  assert.deepEqual([countFor(base, ['b']).due, countFor(base, ['b']).fresh], [50, 1]);
  const rescue = { cutoff: now - DAY, allow: 10, k: 1, days: 5, remaining: 50, pauseNew: true, exempt: new Set() };
  const got = countFor({ ...base, rescue }, ['b']);
  assert.deepEqual([got.due, got.fresh], [10, 0]);
});
