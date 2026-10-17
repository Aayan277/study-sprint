// Tests for the retention helper's simulation (js/retention-sim.js) and the young/mature retention split (stats-calc.js retentionByAge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateOne, simulateAll, planSample, intervalFor, ratingProbs, RETENTIONS, HORIZONS, SIM_CAP,
  DEFAULT_REVIEW_PROBS, DEFAULT_FIRST_PROBS, priorityOrder, pickSelected, smoothWorkload, kneeOf, marginalCost, highestWithin, suggestion, examTarget, KNEE_MIN, KNEE_MAX, EXAM_TOLERANCE, EXAM_LOAD_TOLERANCE
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

// Exam decks: cards in group 1, an exam `exam` days away.
function examInput(extra = {}, exam = 40) {
  const input = makeInput({ groups: [{ exam: null }, { exam }] });
  input.existing = input.existing.map(c => ({ ...c, grp: 1 }));
  input.unseen = new Int16Array(150).fill(1);
  return Object.assign(input, extra);
}

test('an exam is modelled as examClamp/planFinalPass do: the last pass is the weak cards only, over the last 3 days', () => {
  const input = examInput();
  const lo = simulateOne(input, 0.75), hi = simulateOne(input, 0.97);
  for (const r of [lo, hi]) {
    assert.equal(r.exams.length, 1);
    const e = r.exams[0];
    assert.equal(e.day, 40);
    assert.equal(e.total, 200 + 150);
    assert.ok(e.share > 0.85 && e.share <= 1, String(e.share));            // after the final pass most cards are ready
    assert.ok(e.preShare <= e.share + 1e-9);
    assert.ok(e.preRecall > 0.5 && e.preRecall <= 1);
    assert.ok(e.passLoad > 0 && Number.isFinite(e.passLoad));
  }
  // what differs between targets is how much of the work the final pass has to do: a higher target is better prepared before it
  assert.ok(hi.exams[0].preShare > lo.exams[0].preShare + 0.1, `${lo.exams[0].preShare} vs ${hi.exams[0].preShare}`);
  assert.ok(hi.exams[0].preRecall > lo.exams[0].preRecall);
  assert.ok(lo.exams[0].passLoad > hi.exams[0].passLoad, `${lo.exams[0].passLoad} vs ${hi.exams[0].passLoad}`);
  // ...while exam-day readiness after it is high for both, so it is not the number that separates the targets
  assert.ok(lo.exams[0].share > 0.9 && hi.exams[0].share > 0.9);
  // a different exam day moves the record
  assert.equal(simulateOne(examInput({}, 60), 0.9).exams[0].day, 60);
  // an exam in 2 days: the last pass already started today
  const soon = simulateOne(examInput({}, 2), 0.9).exams[0];
  assert.equal(soon.day, 2);
  assert.ok(soon.passLoad > 0);
  // cards in no-exam groups are not touched: their numbers are the same with or without another group having an exam
  const plain = makeInput();
  const mixed = makeInput({ groups: [{ exam: null }, { exam: 40 }] });
  const a = simulateOne(plain, 0.9), b = simulateOne(mixed, 0.9);
  assert.deepEqual(a.horizons, b.horizons);
});

test('cards you will surely remember on exam day (99% or better) get no final-pass review', () => {
  // very stable cards, due long after the exam: nothing is brought forward, so the last 3 days hold no reviews at all
  const input = examInput({ newPerDay: 0, unseen: new Int16Array(0) });
  input.existing = Array.from({ length: 100 }, (_, i) => ({ s: 4000 + i, d: 3, last: -5, due: 800, grp: 1 }));
  const e = simulateOne(input, 0.9).exams[0];
  assert.equal(e.passLoad, 0);
  assert.equal(e.share, 1);
  assert.equal(e.preShare, 1);
  // weaker cards due after the exam are put on the last 3 days (and only there): load is spread, not all on one day
  const weak = examInput({ newPerDay: 0, unseen: new Int16Array(0) });
  weak.existing = Array.from({ length: 90 }, (_, i) => ({ s: 30 + (i % 10), d: 5, last: -5, due: 100, grp: 1 }));
  const w = simulateOne(weak, 0.9).exams[0];
  assert.ok(w.passLoad > 20 && w.passLoad <= 60, String(w.passLoad));      // about 90 cards over 3 days
  assert.ok(w.share > 0.8);
  // a card due BEFORE the exam is left alone until it is due (the exam does not pull it earlier)
  const early = examInput({ newPerDay: 0, unseen: new Int16Array(0) });
  early.existing = Array.from({ length: 50 }, () => ({ s: 6, d: 5, last: -2, due: 3, grp: 1 }));
  const noExam = { ...early, groups: [{ exam: null }, { exam: null }] };
  assert.equal(simulateOne(early, 0.9).horizons[30].reviews > 0, true);
  assert.ok(Math.abs(simulateOne(early, 0.9).horizons[30].reviewsPerDay - simulateOne(noExam, 0.9).horizons[30].reviewsPerDay) < 0.6 * simulateOne(noExam, 0.9).horizons[30].reviewsPerDay);
});

test('the order of work: your target first, then every 5%, then the gaps; only the gaps are cut by the time budget', () => {
  const { order, core } = priorityOrder(RETENTIONS, 0.88);
  assert.equal(order[0], 0.88);
  assert.deepEqual(order.slice(1, core), [0.75, 0.8, 0.85, 0.9, 0.95, 0.97]);
  assert.equal(order.length, RETENTIONS.length);
  assert.equal(new Set(order).size, RETENTIONS.length);
  assert.equal(priorityOrder(RETENTIONS, 0.9).core, 6);                    // 90 is one of the 5% steps already
  assert.equal(priorityOrder(RETENTIONS, undefined).order[0], 0.75);
  let t = 0;
  const r = run(simulateAll(makeInput(), { current: 0.88, now: () => (t += 1000), budgetMs: 500 }));
  assert.equal(r.complete, false);
  assert.equal(r.points.length, core);
  assert.equal(r.missing, RETENTIONS.length - core);
  assert.deepEqual(r.points.map(p => Math.round(p.retention * 100)), [75, 80, 85, 88, 90, 95, 97]);
  // "selected" is always one that was worked out: your target when it is there, else the nearest
  assert.equal(pickSelected(r.points, 0.88), 0.88);
  assert.equal(pickSelected(r.points, 0.86), 0.85);
  assert.equal(pickSelected(r.points, 0.96), 0.95);
  assert.equal(pickSelected(r.points, 0.7), 0.75);
  assert.equal(pickSelected([], 0.9), null);
  // the whole run (no cut) with a target outside the range: still every target
  const full = run(simulateAll(makeInput(), { current: 0.99 }));
  assert.equal(full.complete, true);
  assert.equal(full.points.length, RETENTIONS.length);
});

// Workload curves made by hand: reviews a day against the target at the 90-day horizon.
const curvePoints = (f, noise = () => 0) => RETENTIONS.map((r, i) => ({ retention: r, horizons: { 90: { reviewsPerDay: f(r) + noise(i), reviews: 90 * f(r) } }, exams: [] }));

test('smoothed workload: non-decreasing, convex, over the fixed 80 to 97 range, whatever else was simulated', () => {
  const rng = mulberry32Test(4);
  const noisy = curvePoints(r => 20 + 600 * (r - 0.75) ** 3, () => (rng() - 0.5) * 6);
  const c = smoothWorkload(noisy, 90);
  assert.equal(c.retentions[0], KNEE_MIN);
  assert.equal(c.retentions[c.retentions.length - 1], KNEE_MAX);
  assert.equal(c.values.length, 18);
  for (let i = 1; i < c.values.length; i++) assert.ok(c.values[i] >= c.values[i - 1] - 1e-9, 'non-decreasing');
  for (let i = 1; i < c.values.length - 1; i++) assert.ok(c.values[i + 1] - 2 * c.values[i] + c.values[i - 1] >= -1e-6, 'convex');
  // points outside 80 to 97 change nothing
  const tweaked = noisy.map(p => (p.retention < 0.8 ? { ...p, horizons: { 90: { reviewsPerDay: 999, reviews: 999 } } } : p));
  assert.deepEqual(smoothWorkload(tweaked, 90), c);
  // too few targets in range: no curve
  assert.equal(smoothWorkload(noisy.filter(p => p.retention < 0.81 || p.retention > 0.96), 90), null);
  assert.equal(suggestion(noisy.filter(p => p.retention < 0.81 || p.retention > 0.96), 90).kind, 'none');
});

function mulberry32Test(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('the knee: where a convex workload curve is farthest below its chord; a straight one has none', () => {
  // flat until 90 then steeply up: the knee is at the bend
  const bend = curvePoints(r => 20 + (r > 0.9 ? 400 * (r - 0.9) : 0));
  const c = smoothWorkload(bend, 90);
  assert.ok(Math.abs(kneeOf(c) - 0.9) <= 0.02, String(kneeOf(c)));
  const s = suggestion(bend, 90);
  assert.equal(s.kind, 'knee');
  assert.equal(s.target, s.knee);
  // a straight line has no knee: the first target
  assert.equal(kneeOf(smoothWorkload(curvePoints(r => 30 + 100 * (r - 0.8)), 90)), 0.8);
  assert.equal(kneeOf(smoothWorkload(curvePoints(() => 30), 90)), 0.8);
  // noise does not move it much
  const rng = mulberry32Test(9);
  const noisy = smoothWorkload(curvePoints(r => 20 + (r > 0.9 ? 400 * (r - 0.9) : 0), () => (rng() - 0.5) * 4), 90);
  assert.ok(Math.abs(kneeOf(noisy) - 0.9) <= 0.03, String(kneeOf(noisy)));
});

test('marginal cost of one more point', () => {
  const pts = curvePoints(r => 20 + (r > 0.9 ? 400 * (r - 0.9) : 0));
  const c = smoothWorkload(pts, 90);
  const m = marginalCost(c, 0.95);                                          // about 4 more a day per point there, on about 40 a day
  assert.ok(Math.abs(m.perDay - 4) < 0.5, JSON.stringify(m));
  assert.ok(Math.abs(m.pct - 4 / 40) < 0.03);
  assert.ok(marginalCost(c, 0.85).perDay < 0.5);
  assert.equal(marginalCost(c, 0.97), null);                                // nothing above the range
  assert.equal(marginalCost(c, 0.78), null);                                // nothing below it
  assert.equal(highestWithin(c, 100), 0.97);
  assert.ok(Math.abs(highestWithin(c, 40) - 0.95) <= 0.011);
  assert.equal(highestWithin(c, 10), null);
});

test('a review limit: the suggestion is the highest target whose reviews a day fit, and it says so', () => {
  const bowl = curvePoints(r => 20 + 800 * (r - 0.8) ** 2);                // reviews a day rise faster and faster all the way
  const free = suggestion(bowl, 90);
  assert.equal(free.kind, 'knee');
  const limit = Math.round((20 + 800 * (free.target - 0.04 - 0.8) ** 2) * 10) / 10 + 0.05;
  const lim = suggestion(bowl, 90, { reviewLimit: limit });
  assert.equal(lim.kind, 'limit');
  assert.equal(lim.limit, limit);
  assert.ok(lim.target < free.target);
  assert.ok(lim.curve.values[Math.round((lim.target - 0.8) * 100)] <= limit + 1e-9);
  assert.ok(lim.curve.values[Math.round((lim.target - 0.8) * 100) + 1] > limit);       // ...and one point higher does not fit
  // a roomy limit is not a reason to stop at the knee: the highest target that fits is the top of the range
  const roomy = suggestion(bowl, 90, { reviewLimit: 500 });
  assert.equal(roomy.kind, 'limit');
  assert.equal(roomy.target, KNEE_MAX);
  assert.equal(roomy.knee, free.knee);                                           // (the knee is still there to be shown)
  // no room even at the bottom of the range: no suggestion, and the sheet says why
  const none = suggestion(bowl, 90, { reviewLimit: 5 });
  assert.equal(none.kind, 'none');
  assert.equal(none.target, null);
  assert.equal(none.limitFits, false);
  // no limit set (null, 0, junk): the knee
  for (const l of [null, 0, undefined, NaN, -3]) assert.equal(suggestion(bowl, 90, { reviewLimit: l }).kind, 'knee');
});

// An exam record by hand: recall before the final pass rises with the target, the last days get lighter as it rises
const examPoints = (pre, load) => RETENTIONS.map(r => ({
  retention: r, horizons: { 90: { reviewsPerDay: 20 + 300 * (r - 0.75) ** 2, reviews: 100 } },
  exams: [{ grp: 1, day: 40, total: 100, ready: 0, share: 0.99, preShare: 0.5, preRecall: pre(r), passLoad: load(r) }]
}));

test('an exam deck: the suggestion comes from recall before the final pass and the load of the last days, not from the saturated end result', () => {
  const pts = examPoints(r => Math.min(0.97, 0.8 + (r - 0.75) * 0.8), r => 400 - (r - 0.75) * 300);
  const s = suggestion(pts, 90, { examGroup: 1 });
  assert.equal(s.kind, 'exam');
  const rows = pts.filter(p => p.retention >= KNEE_MIN);
  const recall = p => p.exams[0].preRecall, load = p => p.exams[0].passLoad;
  const best = Math.max(...rows.map(recall)), lightest = Math.min(...rows.map(load));
  const at = pts.find(p => Math.abs(p.retention - s.target) < 1e-9);
  assert.ok(recall(at) >= best - EXAM_TOLERANCE - 1e-9);
  assert.ok(load(at) <= lightest * (1 + EXAM_LOAD_TOLERANCE) + 0.5);
  assert.deepEqual(s.exam, { preRecall: recall(at), passLoad: load(at) });
  // one point lower misses one of the two
  const lower = pts.find(p => Math.abs(p.retention - (s.target - 0.01)) < 1e-9);
  if (lower && lower.retention >= KNEE_MIN) assert.ok(recall(lower) < best - EXAM_TOLERANCE || load(lower) > lightest * (1 + EXAM_LOAD_TOLERANCE) + 0.5);
  // either criterion alone can be the one that decides
  const flatRecall = suggestion(examPoints(() => 0.93, r => 400 - (r - 0.75) * 600), 90, { examGroup: 1 }).target;       // recall never matters: the load decides
  const flatLoad = suggestion(examPoints(r => 0.8 + (r - 0.75) * 0.8, () => 300), 90, { examGroup: 1 }).target;           // load never matters: recall decides
  assert.ok(flatRecall > KNEE_MIN && flatLoad > KNEE_MIN);
  assert.ok(flatRecall <= KNEE_MAX && flatLoad <= KNEE_MAX);
  // the result after the pass is not looked at: changing it changes nothing
  const saturated = pts.map(p => ({ ...p, exams: [{ ...p.exams[0], share: 0.5 + p.retention / 3 }] }));
  assert.equal(suggestion(saturated, 90, { examGroup: 1 }).target, s.target);
  // one lucky target does not pull the suggestion down: the criteria have to hold from there all the way up
  const dip = examPoints(r => (Math.abs(r - 0.83) < 1e-9 ? 0.97 : Math.min(0.97, 0.8 + (r - 0.75) * 0.8)), r => 400 - (r - 0.75) * 300);
  assert.equal(suggestion(dip, 90, { examGroup: 1 }).target, s.target);
  // a limit lower than the exam's own suggestion wins (and the sheet can say what the exam alone wanted); a roomy one changes nothing
  const roomy = suggestion(pts, 90, { examGroup: 1, reviewLimit: 500 });
  assert.equal(roomy.kind, 'exam');
  assert.equal(roomy.target, s.target);
  const tight = suggestion(pts, 90, { examGroup: 1, reviewLimit: 22 });
  assert.equal(tight.kind, 'limit');
  assert.ok(tight.target < s.target);
  assert.equal(tight.examTarget, s.target);
  // no exam numbers for that group: the knee
  assert.equal(suggestion(pts, 90, { examGroup: 7 }).kind, 'knee');
  assert.equal(examTarget(pts, 7), null);
});

test('a suggestion is always a target that was simulated, even when the time budget cut the gaps', () => {
  const cut = curvePoints(r => 20 + (r > 0.9 ? 400 * (r - 0.9) : 0)).filter(p => Math.round(p.retention * 100) % 5 === 0 || p.retention === 0.97);
  const simulated = new Set(cut.map(p => p.retention));
  for (const limit of [null, 23, 45]) {
    const s = suggestion(cut, 90, { reviewLimit: limit });
    assert.ok(simulated.has(s.target), `${limit}: ${s.target}`);
    if (limit) assert.ok(s.curve.values[Math.round((s.target - 0.8) * 100)] <= limit + 1e-9);        // rounding down keeps it within the limit
  }
  const exam = examPoints(r => Math.min(0.97, 0.8 + (r - 0.75) * 0.8), r => 400 - (r - 0.75) * 300).filter(p => Math.round(p.retention * 100) % 5 === 0);
  assert.ok(new Set(exam.map(p => p.retention)).has(suggestion(exam, 90, { examGroup: 1 }).target));
});

test('real simulation: a suggestion in range, and the smoothed curve is convex', () => {
  const r = run(simulateAll(makeInput(), { current: 0.9 }));
  for (const h of HORIZONS) {
    const s = suggestion(r.points, h);
    assert.ok(s.target >= KNEE_MIN && s.target <= KNEE_MAX);
    const v = s.curve.values;
    for (let i = 1; i < v.length - 1; i++) assert.ok(v[i + 1] - 2 * v[i] + v[i - 1] >= -1e-6);
    assert.ok(marginalCost(s.curve, 0.9).perDay > 0);
  }
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
