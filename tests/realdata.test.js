// Tests for tests/realdata/lib.mjs (scoring FSRS models on real review logs). Tiny made-up users only: the dataset is never needed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHistories, truncate, eval6, eval7, auc, Metrics, headRates, evalConst, insideRepo } from './realdata/lib.mjs';
import { buildHistories } from '../js/fsrs-data.js';
import { evaluate, splitHistories } from '../js/fsrs-fit.js';
import { W7_DEFAULT, nextState7, forgettingCurve7, initState7 } from '../js/fsrs7-model.js';

const W6 = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];

// rows: [card, day, rating, state, elapsedSeconds]
function user(rows) {
  return { user: 1, card_id: rows.map(r => r[0]), day_offset: rows.map(r => r[1]), rating: rows.map(r => r[2]), state: rows.map(r => r[3]), elapsed_days: rows.map(() => -1), elapsed_seconds: rows.map(r => r[4]) };
}
// A few cards with same-day repeats, a reset, a lapse and an unrated (0) row.
const ROWS = [
  ['a', 0, 3, 0, -1], ['b', 0, 1, 0, -1], ['a', 0, 3, 1, 600], ['b', 0, 3, 1, 300], ['a', 3, 3, 2, 3 * 86400 - 600], ['b', 2, 1, 2, 2 * 86400 - 300],
  ['b', 2, 3, 3, 600], ['a', 9, 4, 2, 6 * 86400], ['b', 5, 3, 2, 3 * 86400], ['c', 1, 0, 0, -1], ['c', 4, 3, 1, 3 * 86400], ['d', 2, 2, 2, 5000],
  ['a', 12, 1, 2, 3 * 86400], ['a', 12, 2, 3, 400], ['e', 3, 3, 0, -1], ['e', 6, 3, 2, 3 * 86400], ['e', 7, 3, 0, -1], ['e', 9, 2, 1, 2 * 86400]
];

test('toHistories gives the same histories as buildHistories on the same rows', () => {
  const u = user(ROWS);
  const mine = toHistories(u);
  const rows = ROWS.map((r, k) => ({ cardId: r[0], timestamp: r[1] * 86400000 + 43200000 + k, rating: r[2], state: r[3], source: 'anki' }));
  const ref = buildHistories(rows);
  assert.equal(mine.skipped, ref.skipped);
  assert.equal(mine.cards.length, ref.cards.length);
  for (const c of ref.cards) {
    const m = mine.cards.find(x => x.cardId === c.cardId);
    assert.equal(m.day0, c.day0, c.cardId);
    assert.deepEqual(Array.from(m.deltas), Array.from(c.deltas), c.cardId);
    assert.deepEqual(Array.from(m.ratings), Array.from(c.ratings), c.cardId);
    assert.deepEqual(Array.from(m.scored), Array.from(c.scored), c.cardId);
  }
  assert.deepEqual(mine.cards.map(c => c.cardId), ref.cards.map(c => c.cardId));      // same card order
});

test('tFrac: elapsed_seconds in days; dropped rows still count; missing falls back to the whole-day gap', () => {
  const { cards } = toHistories(user([
    ['a', 0, 3, 0, -1], ['a', 0, 3, 1, 43200], ['a', 5, 0, 2, 86400], ['a', 6, 3, 2, 86400], ['a', 9, 3, 2, -1]
  ]));
  const [c] = cards;
  assert.equal(c.ratings.length, 4);                       // the rating 0 row is dropped
  assert.equal(c.tFrac[0], 0);
  assert.equal(c.tFrac[1], 0.5);
  assert.equal(c.tFrac[2], 2);                             // 1 day (dropped row) + 1 day
  assert.equal(c.tFrac[3], c.deltas[3]);                   // elapsed_seconds = -1: use the day gap (3)
  assert.equal(c.deltas[3], 3);
});

test('a card that does not start at new is skipped; a reset keeps only the part from the last one', () => {
  const r = toHistories(user([
    ['x', 0, 3, 2, -1], ['x', 2, 3, 2, 172800],                                 // starts in review state: skipped
    ['y', 0, 3, 0, -1], ['y', 1, 3, 2, 86400], ['y', 4, 2, 0, -1], ['y', 5, 3, 1, 86400]    // reset at the third row
  ]));
  assert.equal(r.skipped, 1);
  assert.equal(r.cards.length, 1);
  const y = r.cards[0];
  assert.equal(y.day0, 4);
  assert.deepEqual(Array.from(y.ratings), [2, 3]);
  assert.deepEqual(Array.from(y.deltas), [0, 1]);
});

test('eval6 long set equals fsrs-fit evaluate; same-day rows go to the other set', () => {
  const { cards } = toHistories(user(ROWS));
  const a = eval6(cards, W6).long, b = evaluate(cards, W6);
  assert.equal(a.n, b.n);
  assert.ok(a.n > 3);
  assert.ok(Math.abs(a.logLoss - b.logLoss) < 1e-12);
  assert.ok(Math.abs(a.rmse - b.rmse) < 1e-12);
  assert.equal(a.recalled, b.recalled);
  assert.ok(eval6(cards, W6).same.n > 0);
});

test('eval7 on one card equals a hand replay with nextState7 and forgettingCurve7', () => {
  const { cards } = toHistories(user([['a', 0, 3, 0, -1], ['a', 0, 1, 1, 7200], ['a', 1, 3, 1, 90000], ['a', 6, 4, 2, 5 * 86400 + 100], ['a', 6, 3, 2, 3600]]));
  const c = cards[0];
  const m = new Metrics(), s = new Metrics();
  let st = initState7(W7_DEFAULT, 3);
  for (const [t, g, same] of [[7200 / 86400, 1, true], [90000 / 86400, 3, false], [(5 * 86400 + 100) / 86400, 4, false], [3600 / 86400, 3, true]]) {
    (same ? s : m).add(forgettingCurve7(W7_DEFAULT, st, t), g > 1 ? 1 : 0);
    st = nextState7(W7_DEFAULT, st, t, g);
  }
  const r = eval7(cards, W7_DEFAULT);
  assert.deepEqual(r.long, m.result());
  assert.deepEqual(r.same, s.result());
  assert.equal(r.long.n, 2);
  assert.equal(r.same.n, 2);
});

test('unscored rows only move the state (the test half of a split)', () => {
  const { cards } = toHistories(user(ROWS));
  const none = cards.map(c => ({ ...c, scored: c.scored.map(() => 0) }));
  assert.equal(eval6(none, W6).long.n, 0);
  assert.equal(eval7(none, W7_DEFAULT).same.n, 0);
});

test('truncate keeps whole days up to the n-th review and drops empty cards', () => {
  const { cards } = toHistories(user([
    ['a', 0, 3, 0, -1], ['a', 2, 3, 2, 172800], ['a', 9, 3, 2, 7 * 86400],
    ['b', 1, 3, 0, -1], ['b', 2, 3, 1, 86400],
    ['c', 5, 3, 0, -1]
  ]));
  // days of all rows: 0, 1, 2, 2, 5, 9 -> the 4th review is on day 2: everything up to day 2 stays
  const t = truncate(cards, 4);
  assert.deepEqual(t.map(c => c.cardId), ['a', 'b']);
  assert.equal(t[0].ratings.length, 2);
  assert.equal(t[0].tFrac.length, 2);
  assert.equal(t[1].ratings.length, 2);
  assert.equal(truncate(cards, 100), cards);               // fewer rows than asked: unchanged
  assert.deepEqual(truncate(cards, 1).map(c => c.cardId), ['a']);
});

test('AUC: perfect, reversed, ties and one-sided', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  // pairs (pos, neg): 0.7>0.4 win, 0.7>0.7 tie (half), 0.4<0.7? the second positive 0.4 vs negatives 0.4 (tie) and 0.7 (loss)
  assert.equal(auc([0.4, 0.7, 0.4, 0.7], [0, 1, 1, 0]), (1 + 0.5 + 0.5 + 0) / 4);
  assert.equal(auc([0.3, 0.6], [1, 1]), null);
});

test('after splitHistories eval6 and eval7 score the same reviews, and head cards keep day0', () => {
  const { cards } = toHistories(user(ROWS));
  const { head, test: testSet, cutoff } = splitHistories(cards, 0.8);
  assert.ok(head.length > 0);
  for (const h of head) {
    const orig = cards.find(c => c.cardId === h.cardId);
    assert.equal(h.day0, orig.day0);                     // fit's recency weighting needs day0
    assert.ok(Number.isFinite(h.day0));
  }
  const a = eval6(testSet, W6), b = eval7(testSet, W7_DEFAULT);
  assert.ok(a.long.n + a.same.n > 0, `cutoff ${cutoff}`);
  assert.equal(a.long.n, b.long.n);
  assert.equal(a.same.n, b.same.n);
  const k = evalConst(testSet, headRates(head));
  assert.equal(k.long.n, a.long.n);
  assert.equal(k.same.n, a.same.n);
});

test('base rate: constant per set, clamped, AUC 0.5; paths inside the repo are recognised', () => {
  const mk = (ratings, deltas) => ({ day0: 0, ratings: Uint8Array.from(ratings), deltas: Int32Array.from(deltas), scored: new Uint8Array(ratings.length).fill(1), tFrac: new Float64Array(ratings.length) });
  const head = [mk([3, 3, 1, 3, 3], [0, 2, 0, 0, 1])];       // long: reviews 1 (y=1), 4 (y=1); same: reviews 2 (y=0), 3 (y=1)
  assert.deepEqual(headRates(head), { long: 0.99, same: 0.5 });
  const k = evalConst([mk([3, 3, 2], [0, 1, 0])], { long: 0.8, same: 0.4 });
  assert.equal(k.long.n, 1);
  assert.equal(k.same.n, 1);
  assert.equal(auc([0.8, 0.8, 0.8], [1, 0, 1]), 0.5);
  assert.ok(insideRepo(new URL('../results/x.jsonl', import.meta.url).pathname));
  assert.ok(!insideRepo('/tmp/some/other/place'));
});
