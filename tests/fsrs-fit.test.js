// Tests for js/fsrs-fit.js (fitting FSRS-6 weights to a review history). Run with: node tests/fsrs-fit.test.js
// No network and no ts-fsrs needed: the default weights and bounds are copied here (ts-fsrs 5.4.2), and
// tests/fsrs-parity.test.js checks the forward model against the real library when it is installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fit, runFit, evaluate, evaluateSplit, lossAndGrad, isBetter, pretrainStarts, mulberry32,
  forgettingCurve, initState, nextState, FIT_DEFAULTS
} from '../js/fsrs-fit.js';

// ts-fsrs 5.4.2: default_w and CLAMP_PARAMETERS(W17_W18_Ceiling = 2, enable_short_term = true)
const DEFAULT_W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const BOUNDS = [[0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2], [0.01, 0.8], [0.1, 0.8]];
// Someone who forgets faster than the defaults say: smaller start stabilities, slower growth, a steeper curve.
const FORGETFUL = [0.12, 0.7, 1.4, 5.5, 6.8, 0.9, 3.0, 0.002, 1.35, 0.35, 0.7, 1.9, 0.07, 0.3, 1.3, 0.55, 1.9, 0.6, 0.12, 0.08, 0.3];

// Make histories the way a person would produce them, using the model itself: new cards get a first rating, then come
// back around the time they are due (some early, some late), are remembered with the model's probability, and a miss is
// often followed by a same-day relearn. start = the study day of the first answer (spread out, for the split test).
function synth(w, nCards, seed, perCard = 10) {
  const rng = mulberry32(seed);
  const cards = [];
  for (let c = 0; c < nCards; c++) {
    const deltas = [0], ratings = [], scored = [1];
    const u = rng();
    ratings.push(u < 0.25 ? 1 : u < 0.4 ? 2 : u < 0.9 ? 3 : 4);
    let { s, d } = initState(w, ratings[0]);
    const n = 3 + Math.floor(rng() * (2 * perCard - 5));
    for (let i = 1; i < n; i++) {
      const t = ratings[i - 1] === 1 && rng() < 0.6 ? 0 : Math.max(1, Math.round(s * Math.exp((rng() - 0.5) * 1.6)));
      const r = forgettingCurve(w, t, s);
      let g;
      if (t === 0) g = rng() < 0.8 ? 3 : 1;
      else if (rng() < r) { const v = rng(); g = v < 0.1 ? 2 : v < 0.9 ? 3 : 4; } else g = 1;
      deltas.push(t); ratings.push(g); scored.push(1);
      ({ s, d } = nextState(w, s, d, t, g, true, r));
    }
    cards.push({ day0: Math.floor(rng() * 300), deltas: Int32Array.from(deltas), ratings: Uint8Array.from(ratings), scored: Uint8Array.from(scored) });
  }
  return cards;
}
const count = cards => cards.reduce((a, c) => a + c.ratings.length, 0);
const input = (cards, extra = {}) => ({ cards, current: DEFAULT_W, defaults: DEFAULT_W, bounds: BOUNDS, ...extra });

test('forward model: a hand-worked card', () => {
  // First answer Good: S = w2, D = w4 − e^(2·w5) + 1.
  const w = DEFAULT_W;
  const a = initState(w, 3);
  assert.equal(a.s, 2.3065);
  assert.ok(Math.abs(a.d - (6.4133 - Math.exp(2 * 0.8334) + 1)) < 1e-7);
  // 90% at t = S, because that is what stability means
  assert.ok(Math.abs(forgettingCurve(w, 2.3065, 2.3065) - 0.9) < 1e-6);
  assert.equal(forgettingCurve(w, 0, 5), 1);
  // metrics for one card, answered Good then Good one day later: one prediction, remembered
  const card = { deltas: Int32Array.of(0, 1), ratings: Uint8Array.of(3, 3), scored: Uint8Array.of(1, 1) };
  const r = forgettingCurve(w, 1, 2.3065);
  const m = evaluate([card], w);
  assert.equal(m.n, 1);
  assert.ok(Math.abs(m.logLoss + Math.log(r)) < 1e-12);
  assert.ok(Math.abs(m.rmse - (1 - r)) < 1e-12);                 // one bin: predicted r, observed 1
  // the same card with the second answer replayed (not scored) has nothing to check
  assert.equal(evaluate([{ ...card, scored: Uint8Array.of(1, 0) }], w).n, 0);
  // a same-day answer is not a prediction either
  assert.equal(evaluate([{ ...card, deltas: Int32Array.of(0, 0) }], w).n, 0);
});

test('gradients (dual numbers) match central finite differences, and the values match the plain model', () => {
  const cards = synth(FORGETFUL, 60, 11);
  const checks = [DEFAULT_W, FORGETFUL, DEFAULT_W.map((x, i) => Math.min(BOUNDS[i][1], Math.max(BOUNDS[i][0], x * (0.8 + 0.4 * ((i * 7) % 5) / 4))))];
  for (const w of checks) {
    const { loss, count: n, grad } = lossAndGrad(cards, w);
    const plain = evaluate(cards, w, { round: false });
    assert.equal(n, plain.n);
    assert.ok(Math.abs(loss - plain.logLoss * plain.n) < 1e-7 * Math.abs(loss), 'the dual forward pass is the same model');
    const total = x => { const e = evaluate(cards, x, { round: false }); return e.logLoss * e.n; };
    for (let k = 0; k < 17; k++) {
      const i = k + 4, h = 1e-6 * Math.max(1, Math.abs(w[i]));
      const up = w.slice(), down = w.slice();
      up[i] += h; down[i] -= h;
      const numeric = (total(up) - total(down)) / (2 * h);
      const err = Math.abs(grad[k] - numeric) / Math.max(1, Math.abs(numeric));
      assert.ok(err < 1e-5, `w${i}: analytic ${grad[k]} vs numeric ${numeric}`);
    }
  }
});

test('the generated history really comes from the weights it was made with', () => {
  const cards = synth(FORGETFUL, 400, 7);
  assert.ok(count(cards) > 3500 && count(cards) < 4600, String(count(cards)));
  assert.ok(evaluate(cards, FORGETFUL).logLoss < evaluate(cards, DEFAULT_W).logLoss - 0.01);
});

test('fit: a forgetful learner. Lower log loss than the defaults, and the weights move towards the truth', () => {
  const cards = synth(FORGETFUL, 400, 7);                     // about 4,000 answers
  const result = runFit(input(cards));
  assert.equal(result.status, 'better');
  assert.equal(result.w, result.fitted);
  assert.equal(result.w.length, 21);
  const { before, after } = result;
  const truth = evaluate(cards, FORGETFUL);
  assert.ok(after.logLoss < before.logLoss - 0.01, `log loss ${before.logLoss} → ${after.logLoss}`);
  assert.ok(after.rmse < before.rmse, `rmse ${before.rmse} → ${after.rmse}`);
  assert.ok(after.logLoss < truth.logLoss + 0.003, 'as good as the true weights on the data it was fitted to');
  // the steepness of the curve (w20) and the start stabilities of Again, Hard and Good move towards the truth
  const err = (w, i) => Math.abs(Math.log(w[i]) - Math.log(FORGETFUL[i]));
  assert.ok(err(result.w, 20) < err(DEFAULT_W, 20) * 0.6, `w20 ${result.w[20]} (truth 0.3, default 0.1542)`);
  for (const i of [0, 1, 2]) assert.ok(err(result.w, i) < err(DEFAULT_W, i) * 0.6, `w${i} ${result.w[i]} (truth ${FORGETFUL[i]}, default ${DEFAULT_W[i]})`);
  // overall, the 21 weights are closer to the truth than the defaults are (on a log scale)
  const dist = w => w.reduce((a, x, i) => a + (Math.log(x) - Math.log(FORGETFUL[i])) ** 2, 0);
  assert.ok(dist(result.w) < dist(DEFAULT_W) * 0.5, `${dist(result.w)} vs ${dist(DEFAULT_W)}`);
  // and the counts
  assert.equal(result.reviews, count(cards));
  assert.equal(result.cards, 400);
});

test('fit: every weight stays inside its bounds, also with extreme data', () => {
  const normal = runFit(input(synth(FORGETFUL, 300, 3)));
  for (const r of [normal]) r.fitted.forEach((x, i) => assert.ok(x >= BOUNDS[i][0] && x <= BOUNDS[i][1], `w${i} = ${x}`));
  // never forgets, ever: the fit wants huge stabilities; the weights must still be in range
  const easy = Array.from({ length: 200 }, () => ({ day0: 0, deltas: Int32Array.of(0, 30, 60, 120, 200), ratings: Uint8Array.of(4, 4, 4, 4, 4), scored: Uint8Array.of(1, 1, 1, 1, 1) }));
  const r = runFit(input(easy));
  assert.notEqual(r.status, 'not-enough');
  r.fitted.forEach((x, i) => assert.ok(Number.isFinite(x) && x >= BOUNDS[i][0] && x <= BOUNDS[i][1], `w${i} = ${x}`));
  // and a tighter bound is respected too
  const tight = BOUNDS.map(([lo, hi], i) => (i === 20 ? [0.2, 0.25] : [lo, hi]));
  const t = runFit(input(synth(FORGETFUL, 300, 3), { bounds: tight }));
  assert.ok(t.fitted[20] >= 0.2 && t.fitted[20] <= 0.25);
});

test('fit: the same data and seed give exactly the same weights; another seed gives (slightly) different ones', () => {
  const cards = synth(FORGETFUL, 200, 5);
  const a = runFit(input(cards, { config: { seed: 42 } })), b = runFit(input(cards, { config: { seed: 42 } }));
  assert.deepEqual(a.fitted, b.fitted);
  assert.deepEqual(a.after, b.after);
  const c = runFit(input(cards, { config: { seed: 43 } }));
  assert.notDeepEqual(a.fitted, c.fitted);
  assert.ok(Math.abs(a.after.logLoss - c.after.logLoss) < 0.01);
});

test('fit: progress only goes forwards and ends at 1; stopping early gives nothing', () => {
  const cards = synth(FORGETFUL, 120, 9);
  const seen = [];
  const result = runFit(input(cards), p => seen.push(p));
  assert.ok(seen.length > 5);
  assert.deepEqual([...new Set(seen.map(p => p.phase))], ['pretrain', 'train', 'check']);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].progress >= seen[i - 1].progress, `step ${i}`);
  assert.equal(seen[0].progress, 0);
  assert.equal(seen.at(-1).progress, 1);
  for (const p of seen) assert.ok(p.done <= p.total && p.progress >= 0 && p.progress <= 1);
  const train = seen.filter(p => p.phase === 'train');
  assert.equal(train.at(-1).done, train.at(-1).total);
  assert.equal(result.status, 'better');
  // a generator you stop early returns nothing, and does not carry on
  const it = fit(input(cards));
  assert.equal(it.next().done, false);
  assert.equal(it.next().done, false);
  assert.deepEqual(it.return(), { value: undefined, done: true });
  assert.deepEqual(it.next(), { value: undefined, done: true });
});

test('decision: keep the new weights only if log loss is lower AND rmse is no higher', () => {
  const m = (logLoss, rmse) => ({ logLoss, rmse });
  assert.equal(isBetter(m(0.4, 0.05), m(0.39, 0.04)), true);
  assert.equal(isBetter(m(0.4, 0.05), m(0.39, 0.05)), true);       // rmse equal is fine
  assert.equal(isBetter(m(0.4, 0.05), m(0.39, 0.051)), false);     // lower log loss but a higher rmse: keep the current ones
  assert.equal(isBetter(m(0.4, 0.05), m(0.4, 0.04)), false);       // equal log loss is not better
  assert.equal(isBetter(m(0.4, 0.05), m(0.41, 0.03)), false);
  assert.equal(isBetter(m(0.4, 0.05), m(0.41, 0.06)), false);
});

test('decision: when the current weights are already the true ones, the fit keeps them', () => {
  // A history made from the default weights, judged against those same weights.
  const cards = synth(DEFAULT_W, 400, 21);
  const r = runFit(input(cards));
  assert.equal(r.status, 'same');
  assert.deepEqual(r.w, DEFAULT_W);                              // the weights in use are returned unchanged
  assert.ok(!isBetter(r.before, r.after));
  assert.notDeepEqual(r.fitted, DEFAULT_W);                      // a fit was made, and was not kept
  // The same history, judged against weights that are clearly wrong: now the fit is kept.
  const wrong = runFit(input(cards, { current: FORGETFUL }));
  assert.equal(wrong.status, 'better');
  assert.deepEqual(wrong.current, FORGETFUL);
  assert.ok(wrong.after.logLoss < wrong.before.logLoss);
});

test('too few reviews: no fit', () => {
  const few = synth(FORGETFUL, 30, 1);
  assert.ok(count(few) < 400);
  const r = runFit(input(few));
  assert.deepEqual(r, { status: 'not-enough', reviews: count(few), needed: 400 });
  // right at the limit: 400 real reviews fit, 399 do not
  const make = n => { const c = synth(FORGETFUL, 100, 2); let left = n; return c.filter(x => { if (left <= 0) return false; left -= x.ratings.length; return true; }).map((x, i, all) => (i === all.length - 1 && left < 0 ? { ...x, ratings: x.ratings.slice(0, x.ratings.length + left), deltas: x.deltas.slice(0, x.ratings.length + left), scored: x.scored.slice(0, x.ratings.length + left) } : x)); };
  assert.equal(count(make(400)), 400);
  assert.equal(runFit(input(make(399))).status, 'not-enough');
  assert.notEqual(runFit(input(make(400))).status, 'not-enough');
  assert.equal(runFit(input(make(399), { config: { minReviews: 300 } })).status === 'not-enough', false);
  // replayed answers (scored 0) do not count
  const replayed = synth(FORGETFUL, 100, 2).map(c => ({ ...c, scored: new Uint8Array(c.scored.length) }));
  assert.equal(runFit(input(replayed)).status, 'not-enough');
  assert.equal(runFit(input([])).status, 'not-enough');
});

test('replayed answers move the memory state but are never predicted', () => {
  const cards = synth(FORGETFUL, 200, 4);
  const masked = cards.map(c => ({ ...c, scored: c.scored.map((x, i) => (i % 3 === 1 ? 0 : x)) }));
  const a = evaluate(cards, DEFAULT_W), b = evaluate(masked, DEFAULT_W);
  assert.ok(b.n < a.n);
  // the fit never trains on them: a history where every second answer is replayed still fits, with fewer reviews counted
  const r = runFit(input(masked));
  assert.ok(r.reviews < count(cards));
  assert.equal(r.before.n, b.n);
});

test('pretraining: start stabilities are in order, in range, and near the truth with plenty of data', () => {
  const big = synth(FORGETFUL, 4000, 1);
  const p = pretrainStarts(big, DEFAULT_W, BOUNDS, FORGETFUL[20]);
  assert.equal(p.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(p[i] >= BOUNDS[i][0] && p[i] <= BOUNDS[i][1]);
    if (i) assert.ok(p[i] >= p[i - 1]);
    assert.ok(Math.abs(Math.log(p[i] / FORGETFUL[i])) < 0.35, `w${i} ${p[i]} vs ${FORGETFUL[i]}`);
  }
  // no data at all: the defaults
  assert.deepEqual(pretrainStarts([], DEFAULT_W, BOUNDS, 0.1542), DEFAULT_W.slice(0, 4));
  // out of order data (Good cards forgotten faster than Hard ones) is put in order
  const mk = (g, t, ok, n) => Array.from({ length: n }, () => ({ deltas: Int32Array.of(0, t), ratings: Uint8Array.of(g, ok ? 3 : 1), scored: Uint8Array.of(1, 1) }));
  const odd = [...mk(2, 2, true, 40), ...mk(3, 2, false, 40)];
  const q = pretrainStarts(odd, DEFAULT_W, BOUNDS, 0.1542);
  for (let i = 1; i < 4; i++) assert.ok(q[i] >= q[i - 1]);
});

test('out-of-sample split: fitted weights predict the later answers better too', () => {
  const cards = synth(FORGETFUL, 500, 13);
  const it = evaluateSplit(input(cards), 0.8);
  let r;
  for (;;) { const x = it.next(); if (x.done) { r = x.value; break; } }
  assert.equal(r.status, 'split');
  assert.ok(r.before.n > 100);
  assert.ok(r.after.logLoss < r.before.logLoss, `${r.before.logLoss} → ${r.after.logLoss}`);
  assert.equal(r.trainResult.status, 'better');
  assert.ok(r.trainResult.reviews < count(cards));
});

test('defaults of the config are the ones in the plan', () => {
  assert.deepEqual({ epochs: FIT_DEFAULTS.epochs, batchSize: FIT_DEFAULTS.batchSize, lr: FIT_DEFAULTS.lr, minReviews: FIT_DEFAULTS.minReviews }, { epochs: 5, batchSize: 512, lr: 0.04, minReviews: 400 });
});
