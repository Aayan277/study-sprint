// Tests for js/confusion.js (cards the person mixes up). Run with: node tests/confusion.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixPairs, pairsFor, partnerOf, pairKey, dismissPair, loadDismissed, saveDismissed, DISMISS_KEY, cardLabel, neighbours, comparisonText } from '../js/confusion.js';

const MIN = 60000, DAY = 86400000;
const T = new Date(2026, 9, 14, 12).getTime();
const cardsById = new Map(['a', 'b', 'c', 'd'].map(id => [id, { id }]));
const log = (cardId, mixedWith, t) => ({ cardId, mixedWith, timestamp: t });

test('a pair needs two mix-ups, and A→B and B→A are the same pair', () => {
  assert.deepEqual(mixPairs([log('a', 'b', T)], { cardsById }), []);
  const pairs = mixPairs([log('a', 'b', T), log('b', 'a', T + 10 * MIN)], { cardsById });
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { key: 'a|b', a: 'a', b: 'b', count: 2, last: T + 10 * MIN });
  assert.equal(pairKey('b', 'a'), 'a|b');
});

test('the same direction within 2 minutes counts once', () => {
  const rows = [log('a', 'b', T), log('a', 'b', T + MIN), log('a', 'b', T + 119 * 1000)];
  assert.deepEqual(mixPairs(rows, { cardsById }), []);                               // all three are one
  assert.equal(mixPairs([...rows, log('a', 'b', T + 5 * MIN)], { cardsById })[0].count, 2);
  // the other direction straight away is a different mix-up
  assert.equal(mixPairs([log('a', 'b', T), log('b', 'a', T + 1000)], { cardsById })[0].count, 2);
});

test('rows without mixedWith, self-pairs and rows outside the window are ignored', () => {
  const rows = [{ cardId: 'a', timestamp: T }, log('a', 'a', T), log('a', 'b', T - 100 * DAY), log('a', 'b', T - 99 * DAY), log('a', 'b', T)];
  assert.deepEqual(mixPairs(rows, { cardsById, since: T - 90 * DAY }), []);          // only one row is inside
  assert.equal(mixPairs(rows, { cardsById, since: T - 120 * DAY })[0].count, 3);
});

test('a pair with a deleted card is left out', () => {
  const rows = [log('a', 'x', T), log('a', 'x', T + 10 * MIN)];
  assert.deepEqual(mixPairs(rows, { cardsById }), []);
  assert.equal(mixPairs(rows, { cardsById: { a: 1, x: 1 } }).length, 1);              // a plain object works too
});

test('"Not confused" hides a pair until two more mix-ups', () => {
  const rows = n => Array.from({ length: n }, (_, i) => log('a', 'b', T + i * 10 * MIN));
  const [pair] = mixPairs(rows(3), { cardsById });
  assert.equal(pair.count, 3);
  const dismissed = dismissPair({}, pair);
  assert.deepEqual(dismissed, { 'a|b': 3 });
  assert.equal(mixPairs(rows(3), { cardsById, dismissed }).length, 0);
  assert.equal(mixPairs(rows(4), { cardsById, dismissed }).length, 0);                // one more is not enough
  assert.equal(mixPairs(rows(5), { cardsById, dismissed })[0].count, 5);               // two more: it returns
});

test('pairs are sorted by count, then by the latest mix-up; pairsFor and partnerOf', () => {
  const rows = [log('a', 'b', T), log('a', 'b', T + 5 * MIN), log('c', 'd', T + 20 * MIN), log('c', 'd', T + 30 * MIN),
    log('a', 'c', T + 40 * MIN), log('a', 'c', T + 50 * MIN), log('c', 'a', T + 60 * MIN)];
  const pairs = mixPairs(rows, { cardsById });
  assert.deepEqual(pairs.map(p => p.key), ['a|c', 'c|d', 'a|b']);
  assert.deepEqual(pairsFor(['d'], pairs).map(p => p.key), ['c|d']);
  assert.deepEqual(pairsFor(new Set(['b', 'd']), pairs).map(p => p.key), ['c|d', 'a|b']);
  assert.equal(partnerOf(pairs[1], 'c'), 'd');
  assert.equal(partnerOf(pairs[1], 'd'), 'c');
});

test('dismissals are kept in storage, and bad or missing storage gives {}', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(loadDismissed(storage), {});
  saveDismissed({ 'a|b': 3 }, storage);
  assert.deepEqual(loadDismissed(storage), { 'a|b': 3 });
  store.set(DISMISS_KEY, '[1,2]');
  assert.deepEqual(loadDismissed(storage), {});
  store.set(DISMISS_KEY, 'not json');
  assert.deepEqual(loadDismissed(storage), {});
  assert.deepEqual(loadDismissed(undefined), {});
  saveDismissed({}, { setItem() { throw new Error('blocked'); } });                    // must not throw
});

test('cardLabel: plain text, one line, shortened; a picture card uses its hidden part', () => {
  assert.equal(cardLabel({ front: '**Mitosis**\nphase' }), 'Mitosis phase');
  assert.equal(cardLabel({ front: 'x'.repeat(80) }, 10), 'xxxxxxxxx…');
  assert.equal(cardLabel({ front: '' }), 'Picture');
  assert.equal(cardLabel(undefined), '');
});

test('neighbours: same decks, nearest wording first, no siblings, no repeated answers, at most 4', () => {
  const c = (id, front, back, extra = {}) => ({ id, deckId: 'd', front, back, ...extra });
  const a = c('a', 'Mitosis', 'Cell division', { noteId: 'N1' }), b = c('b', 'Meiosis', 'Sex cell division');
  const cards = [a, b, c('s', 'Sib', 'Sibling answer', { noteId: 'N1' }), c('x1', 'Cytokinesis', 'Cell division, split'), c('x2', 'Osmosis', 'Water moving'),
    c('x3', 'Diffusion', 'Spreading out'), c('x4', 'Glycolysis', 'Sugar breakdown'), c('x5', 'Other', 'Cell division'),
    c('far', 'Elsewhere', 'Cell division, split again', { deckId: 'other' }), c('sus', 'Sus', 'Cell wall', { suspended: true })];
  const n = neighbours(a, b, cards);
  assert.equal(n.length, 4);
  const ids = n.map(x => x.id);
  assert.equal(ids[0], 'x1');                                   // the closest wording comes first
  for (const bad of ['a', 'b', 's', 'x5', 'far', 'sus']) assert.ok(!ids.includes(bad), bad);   // itself, sibling, same answer as the pair, other deck, suspended
  assert.equal(neighbours(a, b, [a, b]).length, 0);
});

test('comparisonText asks for the difference and lists both cards', () => {
  const t = comparisonText({ front: 'Mitosis' }, { front: 'Meiosis' });
  assert.equal(t.front, "Mitosis vs Meiosis: what's the difference?");
  assert.equal(t.back, '- Mitosis: …\n- Meiosis: …');
});

test('a pair that comes back after "Not confused" shows the mix-ups since', () => {
  const rows = [0, 10, 20, 30].map(i => log('a', 'b', T + i * MIN * 3));
  const first = mixPairs(rows.slice(0, 2), { cardsById });
  const dismissed = dismissPair({}, first[0]);
  assert.deepEqual(mixPairs(rows.slice(0, 3), { cardsById, dismissed }), []);
  assert.equal(mixPairs(rows, { cardsById, dismissed })[0].count, 4);
});
