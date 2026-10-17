// Tests for js/fsrs-data.js (which review-log rows the FSRS optimizer learns from). Run with: node tests/fsrs-data.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rowKind, buildHistories, countEligible, deltaDays, MIN_REVIEWS, PLAY_POLICY } from '../js/fsrs-data.js';

// A row at day D of October 2026 and hour H (local time), a day in the month being the study day when H >= 4.
const at = (day, hour = 12) => new Date(2026, 9, day, hour).getTime();
let id = 0;
const row = (cardId, day, extra = {}) => ({ id: ++id, cardId, timestamp: at(day), source: 'review', rating: 3, ...extra });

// A hand-built log of 28 rows.
function log() {
  id = 0;
  return [
    // A: three real reviews and a same-day relearn. Starts at "new".
    row('A', 1, { state: 0 }), row('A', 3, { state: 2 }), row('A', 3, { state: 2, rating: 1 }), row('A', 10, { state: 3 }),
    // B: imported from Anki (no state on the first row, and nothing before it)
    row('B', 1, { source: 'anki' }), row('B', 5, { source: 'anki', rating: 4 }), row('B', 9, { source: 'anki', rating: 2 }),
    // C: history starts mid-way (state 2 on the first row): skipped
    row('C', 2, { state: 2 }), row('C', 6, { state: 2 }),
    // D: no state, but a Play row (not applied) came first: the start is unknown, so skipped
    row('D', 1, { source: 'play', applied: false, state: 0 }), row('D', 2), row('D', 8),
    // E: Play answers that did not change the schedule are ignored; the rest is a normal history
    row('E', 1, { state: 0 }), row('E', 2, { source: 'play', applied: false, state: 2 }), row('E', 4, { source: 'play' }), row('E', 6, { state: 2 }),
    // P: a Play answer that changed the schedule sits between two real reviews
    row('P', 1, { state: 0 }), row('P', 2, { source: 'play', applied: true, state: 2 }), row('P', 6, { state: 2, rating: 1 }),
    // Q: unknown source, bad ratings, a bad time and no card are all ignored
    row('Q', 1, { state: 0 }), row('Q', 2, { source: 'test' }), row('Q', 3, { rating: 0 }), row('Q', 3, { rating: 5 }), row('Q', 4, { timestamp: NaN }), row(undefined, 4),
    row('Q', 5, { state: 2 })
  ];
}

test('which rows count: review and anki are scored, applied Play is replayed, everything else is ignored', () => {
  const r = extra => ({ cardId: 'c', timestamp: 1, rating: 3, ...extra });
  assert.equal(rowKind(r({ source: 'review' })), 'train');
  assert.equal(rowKind(r({ source: 'anki' })), 'train');
  assert.equal(rowKind(r({ source: 'play', applied: true })), 'replay');
  assert.equal(rowKind(r({ source: 'play', applied: false })), null);
  assert.equal(rowKind(r({ source: 'play' })), null);
  assert.equal(rowKind(r({ source: 'test' })), null);              // an unknown source is ignored until it is added on purpose
  assert.equal(rowKind(r({ source: undefined })), null);
  for (const rating of [0, 5, 2.5, '3', null, undefined]) assert.equal(rowKind(r({ source: 'review', rating })), null);
  for (const timestamp of [NaN, undefined, Infinity]) assert.equal(rowKind(r({ source: 'review', timestamp })), null);
  for (const cardId of [undefined, null, '', NaN, {}]) assert.equal(rowKind(r({ source: 'review', cardId })), null);
  assert.equal(rowKind(null), null);
  assert.equal(rowKind('x'), null);
});

test('histories from a fixed log: deltas, ratings, scored flags, and the cards that are left out', () => {
  const h = buildHistories(log());
  const by = Object.fromEntries(h.cards.map(c => [c.cardId, c]));
  assert.deepEqual(Object.keys(by).sort(), ['A', 'B', 'E', 'P', 'Q']);
  assert.deepEqual([...by.A.deltas], [0, 2, 0, 7]);
  assert.deepEqual([...by.A.ratings], [3, 3, 1, 3]);
  assert.deepEqual([...by.A.scored], [1, 1, 1, 1]);
  assert.deepEqual([...by.B.deltas], [0, 4, 4]);
  assert.deepEqual([...by.B.ratings], [3, 4, 2]);
  assert.deepEqual([...by.E.deltas], [0, 5]);                       // the two ignored Play rows are not there, but the gap spans them
  assert.deepEqual([...by.P.deltas], [0, 1, 4]);                   // the gap to the next real review is measured from the Play answer
  assert.deepEqual([...by.P.scored], [1, 0, 1]);                   // replayed, never scored
  assert.deepEqual([...by.P.ratings], [3, 3, 1]);
  assert.deepEqual([...by.Q.deltas], [0, 4]);
  assert.equal(by.A.deltas.constructor, Int32Array);
  assert.equal(by.A.ratings.constructor, Uint8Array);
  assert.equal(by.A.scored.constructor, Uint8Array);
  assert.equal(h.skipped, 2);                                       // C and D
  assert.equal(h.cardsUsed, 5);
  // real reviews: A 4 + B 3 + E 2 + P 2 + Q 2 = 13; the ones with a prediction (a later day than the row before): A 2 + B 2 + E 1 + P 1 + Q 1 = 7
  assert.equal(h.reviews, 13);
  assert.equal(h.longTerm, 7);
});

test('the unlock count is the number of real reviews on cards with a known start', () => {
  assert.equal(MIN_REVIEWS, 400);
  assert.equal(countEligible(log()), 13);
  assert.equal(countEligible([]), 0);
  assert.equal(countEligible(null), 0);
  // 399 → 400: one more review unlocks it
  const many = n => Array.from({ length: n }, (_, i) => ({ cardId: 'k' + i, timestamp: at(1), source: 'review', rating: 3, state: 0 }));
  assert.equal(countEligible(many(399)), 399);
  assert.equal(countEligible(many(400)), 400);
  // Play answers never count towards it, whatever their policy
  const play = Array.from({ length: 50 }, (_, i) => ({ cardId: 'k0', timestamp: at(2 + (i % 20)), source: 'play', applied: true, rating: 3 }));
  assert.equal(countEligible([...many(10), ...play]), 10);
});

test('Play policy: replay (default) keeps the card going; truncate cuts the history at the first applied Play answer', () => {
  assert.equal(PLAY_POLICY, 'replay');
  const replay = buildHistories(log(), { playPolicy: 'replay' });
  const cut = buildHistories(log(), { playPolicy: 'truncate' });
  const p = h => h.cards.find(c => c.cardId === 'P');
  assert.deepEqual([...p(replay).ratings], [3, 3, 1]);
  assert.deepEqual([...p(cut).ratings], [3]);                         // only the review before the Play answer
  assert.deepEqual([...p(cut).scored], [1]);
  assert.equal(cut.reviews, replay.reviews - 1);                    // P's last real review is gone
  assert.equal(cut.longTerm, replay.longTerm - 1);
  // A card whose very first row is an applied Play answer has no real history left
  id = 0;
  const first = [row('X', 1, { source: 'play', applied: true, state: 0 }), row('X', 3, { state: 2 })];
  assert.equal(buildHistories(first, { playPolicy: 'truncate' }).cards.length, 0);
  const kept = buildHistories(first).cards[0];                       // replayed, then one real review
  assert.deepEqual([...kept.scored], [0, 1]);
});

test('rows can come in any order; an older row with the same time keeps log order', () => {
  const rows = log();
  const shuffled = [...rows].sort((a, b) => ((a.id * 7919) % 31) - ((b.id * 7919) % 31));
  const a = buildHistories(rows), b = buildHistories(shuffled);
  assert.deepEqual(b.cards.map(c => [c.cardId, [...c.deltas], [...c.ratings]]).sort(), a.cards.map(c => [c.cardId, [...c.deltas], [...c.ratings]]).sort());
});

test('a history that starts with an unknown state is skipped, and so is one with no state after other rows', () => {
  id = 0;
  const h = buildHistories([row('S', 1, { state: 1 }), row('S', 2), row('T', 1), row('T', 2)]);
  assert.deepEqual(h.cards.map(c => c.cardId), ['T']);              // T: no state at all, but nothing came first
  assert.equal(h.skipped, 1);
});

test('days are study days: the new day starts at 4am', () => {
  const t = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();
  assert.equal(deltaDays(t(5, 23, 30), t(6, 3, 59)), 0);          // 3:59 the next morning still belongs to the day before
  assert.equal(deltaDays(t(5, 23, 30), t(6, 4, 0)), 1);
  assert.equal(deltaDays(t(5, 3, 0), t(5, 5, 0)), 1);               // before and after 4am on the same calendar day
  assert.equal(deltaDays(t(5, 12), t(5, 12)), 0);
  assert.equal(deltaDays(t(5, 12), t(15, 12)), 10);
  id = 0;
  const rows = [
    { id: 1, cardId: 'N', timestamp: t(5, 22), source: 'review', rating: 3, state: 0 },
    { id: 2, cardId: 'N', timestamp: t(6, 2), source: 'review', rating: 1, state: 2 },
    { id: 3, cardId: 'N', timestamp: t(6, 9), source: 'review', rating: 3, state: 3 }
  ];
  assert.deepEqual([...buildHistories(rows).cards[0].deltas], [0, 0, 1]);   // late-night answer counts as the same day as the evening one
});

test('daylight saving: a 23 or 25 hour night is still one day (run in Europe/London)', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./fsrs-data.dst.child.mjs', import.meta.url))], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok tz=Europe\/London/);
});
