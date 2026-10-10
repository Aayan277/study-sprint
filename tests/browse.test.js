// Tests for js/browse-logic.js (the card list). Run with: node tests/browse.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardStatus, browseCards, isHidden, isBuried, buryUntil, parseTags, FILTERS, SORTS, replaceInCards, tagCounts, renameTag } from '../js/browse-logic.js';
import * as leechFns from '../js/browse-logic.js';
import { dayEnd } from '../js/days.js';

const NOW = new Date(2026, 9, 9, 15, 0).getTime();
const DAY = 86400000;
const card = (id, extra = {}) => ({ id, deckId: 'd', front: id, back: `${id} back`, tags: [], created: 0, ...extra });

test('status: suspended and buried win over the schedule', () => {
  assert.equal(cardStatus(card('a', { suspended: true }), { state: 2, due: NOW - DAY }, NOW).key, 'suspended');
  assert.equal(cardStatus(card('a', { buriedUntil: NOW + 1000 }), undefined, NOW).key, 'buried');
  assert.equal(cardStatus(card('a', { buriedUntil: NOW - 1000 }), undefined, NOW).key, 'new');      // bury has worn off
});

test('status from the schedule', () => {
  assert.equal(cardStatus(card('a'), undefined, NOW).label, 'New');
  assert.equal(cardStatus(card('a'), { state: 1, due: NOW + 60000 }, NOW).label, 'Learning');
  assert.equal(cardStatus(card('a'), { state: 3, due: NOW - 1 }, NOW).label, 'Learning · due');
  assert.equal(cardStatus(card('a'), { state: 2, due: NOW - 3 * DAY }, NOW).key, 'due');
  assert.equal(cardStatus(card('a'), { state: 2, due: NOW + 2 * 3600000 }, NOW).key, 'due');        // later today
  assert.deepEqual(cardStatus(card('a'), { state: 2, due: NOW + 3 * DAY }, NOW), { key: 'review', label: 'Due in 3d' });
});

test('hidden from Review and Play: suspended, or buried until tomorrow', () => {
  assert.equal(isHidden(card('a', { suspended: true }), NOW), true);
  assert.equal(isHidden(card('a', { buriedUntil: buryUntil(NOW) }), NOW), true);
  assert.equal(isHidden(card('a', { buriedUntil: buryUntil(NOW) }), dayEnd(NOW) + 1), false);       // tomorrow it's back
  assert.equal(isBuried(card('a'), NOW), false);
  assert.equal(isHidden(card('a', { flag: 1 }), NOW), false);
});

const deck = [
  card('Mitosis', { created: 1, tags: ['cells'] }),
  card('Meiosis', { created: 2, flag: 1 }),
  card('Café', { created: 3, suspended: true }),
  card('Osmosis', { created: 4, flag: 4, tags: ['leech'] }),
  card('apple', { created: 5 })
];
const states = new Map([
  ['Mitosis', { state: 2, due: NOW + 5 * DAY, lapses: 1, difficulty: 4 }],
  ['Meiosis', { state: 2, due: NOW - DAY, lapses: 3, difficulty: 8 }],
  ['Osmosis', { state: 1, due: NOW + 60000, lapses: 0, difficulty: 6 }]
]);
const ids = list => list.map(x => x.card.id);

test('search front, back and tags, ignoring capitals and accents', () => {
  assert.deepEqual(ids(browseCards(deck, states, { query: 'MITO', now: NOW })), ['Mitosis']);
  assert.deepEqual(ids(browseCards(deck, states, { query: 'cafe', now: NOW })), ['Café']);
  assert.deepEqual(ids(browseCards(deck, states, { query: 'cells', now: NOW })), ['Mitosis']);
  assert.deepEqual(ids(browseCards(deck, states, { query: 'osis back', now: NOW, sort: 'added-old' })), ['Mitosis', 'Meiosis', 'Osmosis']);
});

test('filters', () => {
  const f = filter => ids(browseCards(deck, states, { filter, sort: 'added-old', now: NOW }));
  assert.deepEqual(f('new'), ['apple']);                  // Café is suspended, so not "new"
  assert.deepEqual(f('due'), ['Meiosis']);
  assert.deepEqual(f('review'), ['Mitosis']);
  assert.deepEqual(f('learning'), ['Osmosis']);
  assert.deepEqual(f('suspended'), ['Café']);
  assert.deepEqual(f('flagged'), ['Meiosis', 'Osmosis']);
  assert.deepEqual(f('flag4'), ['Osmosis']);
  assert.deepEqual(f('leech'), ['Osmosis']);
  assert.equal(f('all').length, 5);
});

test('sorting', () => {
  const s = sort => ids(browseCards(deck, states, { sort, now: NOW }));
  assert.deepEqual(s('added-new'), ['apple', 'Osmosis', 'Café', 'Meiosis', 'Mitosis']);
  assert.deepEqual(s('due').slice(0, 3), ['Meiosis', 'Osmosis', 'Mitosis']);          // new cards last
  assert.deepEqual(s('lapses').slice(0, 2), ['Meiosis', 'Mitosis']);
  assert.deepEqual(s('difficulty')[0], 'Meiosis');
  assert.deepEqual(s('az'), ['apple', 'Café', 'Meiosis', 'Mitosis', 'Osmosis']);
});

test('tags', () => {
  assert.deepEqual(parseTags(' Biology, cells,,biology , Exam 1 '), ['biology', 'cells', 'exam 1']);
  assert.deepEqual(parseTags(''), []);
});

test('every filter and sort has a label', () => {
  assert.ok(FILTERS.every(([k, l]) => k && l) && SORTS.every(([k, l]) => k && l));
});

test('leeches: caught at the threshold, then every half-threshold', () => {
  const { isNewLeech, markLeech } = leechFns;
  assert.equal(isNewLeech(6, 7, 8), false);
  assert.equal(isNewLeech(7, 8, 8), true);
  assert.equal(isNewLeech(8, 8, 8), false);     // no new lapse
  assert.equal(isNewLeech(8, 9, 8), false);
  assert.equal(isNewLeech(11, 12, 8), true);    // 8 + 4
  assert.equal(isNewLeech(15, 16, 8), true);    // 8 + 8
  assert.equal(isNewLeech(2, 3, 3), true);
  assert.equal(isNewLeech(3, 4, 3), false);
  assert.equal(isNewLeech(4, 5, 3), true);      // 3 + 2
  assert.equal(isNewLeech(0, 1, 0), false);     // 0 = leeches turned off
});

test('leeches: tagged, and suspended unless tag-only', () => {
  const { markLeech } = leechFns;
  const c = { id: 'a', tags: ['exam'] };
  assert.deepEqual(markLeech(c, 'suspend'), { id: 'a', tags: ['exam', 'leech'], suspended: true });
  assert.deepEqual(markLeech(c, 'tag'), { id: 'a', tags: ['exam', 'leech'] });
  assert.deepEqual(markLeech({ id: 'b', tags: ['leech'] }, 'tag').tags, ['leech']);
});


test('duplicates filter: same front, listed together', () => {
  const cs = [card('Mitosis', { created: 1 }), card('Meiosis', { created: 2 }), card('**mitosis**', { created: 3 }), card('Mitosis!', { created: 4 }), card('Osmosis', { created: 5 })];
  assert.deepEqual(browseCards(cs, new Map(), { filter: 'dupes', now: NOW }).map(x => x.card.id), ['Mitosis', '**mitosis**', 'Mitosis!']);
});

test('find and replace', () => {
  const cs = [{ id: 'a', front: 'Pavlov dog', back: 'pavlov ran tests' }, { id: 'b', front: 'Skinner', back: 'box (1.5)' }];
  assert.deepEqual(replaceInCards(cs, { find: 'pavlov', replace: 'Pavlov’s' }).map(c => [c.front, c.back]), [['Pavlov’s dog', 'Pavlov’s ran tests']]);
  assert.deepEqual(replaceInCards(cs, { find: 'pavlov', replace: 'X', matchCase: true }).map(c => [c.front, c.back]), [['Pavlov dog', 'X ran tests']]);
  assert.deepEqual(replaceInCards(cs, { find: 'Pavlov', replace: 'X', field: 'back' }).map(c => c.back), ['X ran tests']);
  assert.deepEqual(replaceInCards(cs, { find: '(1.5)', replace: '$&' }).map(c => c.back), ['box $&']);      // literal, not a pattern
  assert.deepEqual(replaceInCards(cs, { find: '' }), []);
});

test('tags: counts, rename and remove everywhere', () => {
  const cs = [{ id: 'a', tags: ['exam1', 'cells'] }, { id: 'b', tags: ['exam1'] }, { id: 'c', tags: ['cells', 'exam 1'] }, { id: 'd', tags: [] }];
  assert.deepEqual(tagCounts(cs), [{ tag: 'cells', count: 2 }, { tag: 'exam1', count: 2 }, { tag: 'exam 1', count: 1 }]);
  assert.deepEqual(renameTag(cs, 'exam1', 'Exam 1').map(c => [c.id, c.tags]), [['a', ['exam 1', 'cells']], ['b', ['exam 1']]]);
  assert.deepEqual(renameTag(cs, 'cells', 'exam 1').map(c => [c.id, c.tags]), [['a', ['exam1', 'exam 1']], ['c', ['exam 1']]]);   // merging doesn't double up
  assert.deepEqual(renameTag(cs, 'cells', '').map(c => c.tags), [['exam1'], ['exam 1']]);                                       // removing
});
