// Tests for the retention helper's simulation (js/retention-sim.js) and the young/mature retention split (stats-calc.js retentionByAge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateOne, simulateAll, planSample, intervalFor, ratingProbs, efficiency, suggestRetention, RETENTIONS, HORIZONS, SIM_CAP,
  DEFAULT_REVIEW_PROBS, DEFAULT_FIRST_PROBS, SUGGEST_FLOOR, suggestFor
} from '../js/retention-sim.js';
import { retentionByAge, retention, YOUNG_DAYS } from '../js/stats-calc.js';


const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const run = g => { for (;;) { const r = g.next(); if (r.done) return r.value; } };

function makeInput(extra = {}) {
  const existing = [];
  for (let i = 0; i < 200; i++) existing.push({ s: 2 + (i % 30) * 3, d: 3 + (i % 7), last: -(i % 12), due: (i % 15) - 2, grp: 0 });
  return {
    w: W, existing, unseen: new Int16Array(150), groups: [{ exam: null }], newPerDay: 10, learnSteps: 2, relearnSteps: 1, maxInterval: 36500,
    reviewProbs: DEFAULT_REVIEW_PROBS, firstProbs: DEFAULT_FIRST_PROBS, seed: 5, ...extra
  };
}

test('intervalFor: the gap that targets a retention (R = 90% after exactly S days)', () => {
  assert.equal(intervalFor(W, 10, 0.9, 36500), 10);
  assert.ok(intervalFor(W, 10, 0.8, 36500) > intervalFor(W, 10, 0.9, 36500));
  assert.ok(intervalFor(W, 10, 0.97, 36500) < 10);
  assert.equal(intervalFor(W, 0.01, 0.9, 36500), 1);           // never under a day
  assert.equal(intervalFor(W, 1000, 0.8, 90), 90);             // never over the maximum
});

test('the same seed gives the same answer; another seed gives another one', () => {
  const a = simulateOne(makeInput(), 0.9), b = simulateOne(makeInput(), 0.9);
  assert.deepEqual(a, b);
  const c = simulateOne(makeInput({ seed: 6 }), 0.9);
  assert.notDeepEqual(a.horizons[365], c.horizons[365]);
  const x = run(simulateAll(makeInput())), y = run(simulateAll(makeInput()));
  assert.deepEqual(x, y);
  assert.equal(x.points.length, RETENTIONS.length);
  assert.equal(x.complete, true);
  assert.equal(RETENTIONS[0], 0.75);
  assert.equal(RETENTIONS[RETENTIONS.length - 1], 0.97);
});

test('a higher target means more reviews and more remembered; numbers are sane', () => {
  const r = run(simulateAll(makeInput()));
  const at = pct => r.points.find(p => Math.round(p.retention * 100) === pct);
  for (const h of HORIZONS) {
    assert.ok(at(97).horizons[h].reviewsPerDay > at(90).horizons[h].reviewsPerDay);
    assert.ok(at(90).horizons[h].reviewsPerDay > at(75).horizons[h].reviewsPerDay);
    assert.ok(at(97).horizons[h].recall > at(75).horizons[h].recall);
    const x = at(90).horizons[h];
    assert.ok(x.recall > 0.5 && x.recall <= 1);
    assert.ok(Math.abs(x.reviewsPerDay * h - x.reviews) < 1e-6);
    assert.ok(x.started >= 200 - 1e-6);
  }
  // new cards are introduced at the limit: 10 a day for 15 days uses the 150 unseen cards
  assert.ok(Math.abs(at(90).horizons[30].started - 350) < 1e-6);
  // the same cards meet the same dice under every target, so the difference is smooth, not noise
  let up = 0;
  for (let i = 1; i < r.points.length; i++) if (r.points[i].horizons[365].reviewsPerDay >= r.points[i - 1].horizons[365].reviewsPerDay - 0.5) up++;
  assert.ok(up >= RETENTIONS.length - 2);
});

test('no new cards and nothing started: nothing to review', () => {
  const r = simulateOne(makeInput({ existing: [], unseen: new Int16Array(0) }), 0.9);
  assert.equal(r.horizons[30].reviews, 0);
  assert.equal(r.horizons[30].recall, 0);
});

test('a big collection is sampled, seeded, and scaled back up', () => {
  const big = makeInput();
  big.existing = Array.from({ length: 6000 }, (_, i) => ({ s: 3 + (i % 60), d: 5, last: -(i % 20), due: i % 10, grp: 0 }));
  big.unseen = new Int16Array(4000);
  const plan = planSample(big);
  assert.ok(plan.f < 1);
  assert.ok(plan.existingIdx.length + plan.unseenIdx.length <= SIM_CAP * 1.1);      // (the sample of cards not started yet is a little bigger: only the first ones are introduced within the year)
  assert.deepEqual(plan, planSample(big));
  const a = simulateOne(big, 0.9), small = makeInput();
  small.existing = big.existing.filter((_, i) => i % 6 === 0);
  small.unseen = new Int16Array(10 * 365 > 4000 ? 4000 : 0);
  // scaled counts are on the scale of the whole collection
  assert.ok(a.horizons[30].started > 6000);
  assert.ok(Math.abs(a.horizons[30].started - 6300) < 100);
  assert.ok(Math.abs(a.horizons[365].started - 9650) < 100);
});

test('an exam: the last pass and the rising target make readiness high, and it is recorded on exam day', () => {
  const input = makeInput({ groups: [{ exam: null }, { exam: 40 }] });
  input.existing = input.existing.map((c, i) => ({ ...c, grp: i % 2 }));
  input.unseen = Int16Array.from({ length: 150 }, (_, i) => (i % 2 ? 1 : 0));
  const lo = simulateOne(input, 0.75), hi = simulateOne(input, 0.97);
  for (const r of [lo, hi]) {
    assert.equal(r.exams.length, 1);
    assert.equal(r.exams[0].day, 40);
    assert.ok(r.exams[0].share > 0.8 && r.exams[0].share <= 1, String(r.exams[0].share));
    assert.equal(r.exams[0].total, 100 + 75);
  }
  // a different exam day moves the record
  const later = simulateOne({ ...input, groups: [{ exam: null }, { exam: 60 }] }, 0.9);
  assert.equal(later.exams[0].day, 60);
  // suggestFor with an exam looks at readiness, not knowledge per review
  const all = run(simulateAll(input));
  const s = suggestFor(all.points, 90, 1);
  assert.ok(s >= SUGGEST_FLOOR && s <= 0.97);
});

test('the time budget stops early and says so', () => {
  let t = 0;
  const r = run(simulateAll(makeInput(), { now: () => (t += 1000), budgetMs: 2500 }));
  assert.equal(r.complete, false);
  assert.ok(r.points.length >= 2 && r.points.length < RETENTIONS.length);
  assert.equal(r.stoppedAt, r.points[r.points.length - 1].retention);
});

test('suggestRetention: the fewest reviews within 2% of the best knowledge per review, never below 80%', () => {
  const pt = (retention, reviews, known) => ({ retention, horizons: { 90: { reviews, known } }, exams: [] });
  // efficiency falls steadily with the target: the best is at the floor
  const falling = [0.75, 0.8, 0.85, 0.9, 0.95].map((r, i) => pt(r, 100 + i * 60, 90 + i));
  assert.equal(suggestRetention(falling, 90), 0.8);
  // an interior best (a lower target costs many lapses): 0.88 is best; 0.86 is within 2% and has fewer reviews
  const eff = { 0.8: 0.40, 0.84: 0.449, 0.86: 0.4515, 0.88: 0.46, 0.92: 0.40, 0.96: 0.30 };
  const interior = Object.entries(eff).map(([r, e]) => pt(+r, 100 * (1 + (+r - 0.8) * 5), e * 100 * (1 + (+r - 0.8) * 5)));
  assert.equal(efficiency(interior[3], 90).toFixed(2), '0.46');
  assert.equal(suggestRetention(interior, 90), 0.86);        // 0.4515 >= 0.46 * 0.98, and it has fewer reviews than 0.88; 0.84 (0.449) is not within 2%
  assert.equal(suggestRetention([], 90), null);
});

test('ratingProbs: your own Hard/Good/Easy shares once there are enough answers, else the usual ones', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ source: 'review', state: 2, rating: i < 30 ? 2 : i < 90 ? 3 : 4 });
  for (let i = 0; i < 40; i++) rows.push({ source: 'review', state: 0, rating: i < 10 ? 1 : 3 });
  rows.push({ source: 'play', state: 2, rating: 4 }, { source: 'review', state: 2, rating: 1 });
  const p = ratingProbs(rows);
  assert.deepEqual(p.review, [0.3, 0.6, 0.1]);
  assert.deepEqual(p.first, [0.25, 0, 0.75, 0]);
  assert.deepEqual(p.own, { review: true, first: true });
  const few = ratingProbs(rows.slice(0, 20));
  assert.deepEqual(few.review, DEFAULT_REVIEW_PROBS);
  assert.deepEqual(few.own, { review: false, first: false });
});

// ---------- the young/mature split ----------
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 17, 12);
let id = 0;
const log = (cardId, daysAgo, correct, extra = {}) => ({ id: ++id, cardId, timestamp: NOW - daysAgo * DAY, source: 'review', state: 2, rating: correct ? 3 : 1, correct, ...extra });

test('retentionByAge: young is a gap under 21 days, mature 21 or more; periods nest', () => {
  const logs = [
    log('a', 60, true),                                       // a's earlier answer, outside every period
    log('a', 50, true),                                       // 10 days after: young... (outside the 30-day window)
    log('a', 20, true),                                       // gap 30 days: mature
    log('a', 6, false),                                       // gap 14: young
    log('b', 70, true), log('b', 40, true),                   // b: gap 30 (mature, 90-day window only)
    log('b', 3, true),                                        // gap 37: mature
    log('c', 2, true),                                        // no earlier answer: mature
    log('d', 25, true, { rating: 3, state: 1 }),              // a learning answer: not a recall review, but it sets d's last answer
    log('d', 5, true),                                        // gap 20: young
    log('e', 5, true, { source: 'play', mode: 'front', applied: true, reason: 'due' }),   // multiple choice: not counted
  ];
  const r = retentionByAge(logs, NOW, [7, 30, 90]);
  assert.deepEqual(r[7].young, { n: 2, ok: 1 });           // a day 6 (wrong), d day 5
  assert.deepEqual(r[7].mature, { n: 2, ok: 2 });          // b day 3, c day 2
  assert.deepEqual(r[7].all, { n: 4, ok: 3 });
  assert.equal(r[30].all.n, 5);                              // + a day 20
  assert.deepEqual(r[30].mature, { n: 3, ok: 3 });
  assert.equal(r[90].all.n, 9);                              // + a day 60 and 50, b day 70 and 40
  assert.equal(r[90].all.n, r[90].young.n + r[90].mature.n);
  assert.equal(YOUNG_DAYS, 21);
  assert.equal(r[7].target, null);
});

test('retentionByAge agrees with the plain 30-day retention, and averages the targets of the reviews', () => {
  const logs = [];
  for (let i = 0; i < 40; i++) logs.push(log('c' + (i % 8), 1 + (i % 28), i % 5 !== 0));
  const split = retentionByAge(logs, NOW, [30], { targetOf: cid => (cid < 'c4' ? 0.9 : 0.8) })[30];
  const plain = retention(logs, NOW, 30);
  assert.equal(split.all.n, plain.total);
  assert.equal(split.all.ok, plain.remembered);
  assert.ok(split.target > 0.8 && split.target < 0.9);
  const expected = logs.filter(l => l.timestamp >= NOW - 29.5 * DAY).reduce((s, l) => s + (l.cardId < 'c4' ? 0.9 : 0.8), 0);
  assert.ok(expected > 0);
});

test('an Anki-imported review with no earlier answer counts as mature; Play answers that did not move the schedule do not set the gap', () => {
  const logs = [
    log('x', 40, true, { source: 'anki' }),
    log('x', 35, true, { source: 'play', mode: 'typing', applied: false, reason: 'not-due' }),    // did not change the schedule
    log('x', 3, true),                                        // gap from day 40, not 35: 37 days
  ];
  const r = retentionByAge(logs, NOW, [7])[7];
  assert.deepEqual(r.mature, { n: 1, ok: 1 });
  assert.equal(r.young.n, 0);
});
