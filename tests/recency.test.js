// Tests for the recency weighting in the optimizer's loss (js/fsrs-fit.js: recencyWeight, withRecency, the `recency` setting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyWeight, withRecency, RECENCY_FLOOR, lossAndGrad, evaluate, evaluateMany, fit, FIT_DEFAULTS, mulberry32, forgettingCurve, initState, nextState } from '../js/fsrs-fit.js';

const DEFAULT_W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const BOUNDS = [[0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2], [0.01, 0.8], [0.1, 0.8]];

function synth(w, nCards, seed) {
  const rng = mulberry32(seed);
  const cards = [];
  for (let c = 0; c < nCards; c++) {
    const deltas = [0], ratings = [], scored = [1];
    ratings.push(rng() < 0.2 ? 1 : 3);
    let { s, d } = initState(w, ratings[0]);
    const n = 4 + Math.floor(rng() * 8);
    for (let i = 1; i < n; i++) {
      const t = Math.max(1, Math.round(s * Math.exp((rng() - 0.5) * 1.6)));
      const r = forgettingCurve(w, t, s);
      const g = rng() < r ? 3 : 1;
      deltas.push(t); ratings.push(g); scored.push(1);
      ({ s, d } = nextState(w, s, d, t, g, true, r));
    }
    cards.push({ day0: Math.floor(rng() * 300), deltas: Int32Array.from(deltas), ratings: Uint8Array.from(ratings), scored: Uint8Array.from(scored) });
  }
  return cards;
}

test('the weighting curve: floor + (1 - floor) * x^3, from the oldest to the newest review', () => {
  assert.equal(RECENCY_FLOOR, 0.5);
  assert.equal(recencyWeight(0), 0.5);
  assert.equal(recencyWeight(1), 1);
  assert.ok(Math.abs(recencyWeight(0.5) - 0.5625) < 1e-12);
  assert.ok(Math.abs(recencyWeight(0.75) - (0.5 + 0.5 * 0.421875)) < 1e-12);
  assert.equal(recencyWeight(0, 0.25), 0.25);          // fsrs-rs's floor
  let prev = 0;
  for (let i = 0; i <= 20; i++) { const v = recencyWeight(i / 20); assert.ok(v >= prev); prev = v; }
});

test('withRecency: newer predictions weigh more, same-day ones share a weight, unpredicted answers stay 1', () => {
  const cards = synth(DEFAULT_W, 40, 3);
  const weighted = withRecency(cards);
  assert.equal(weighted.length, cards.length);
  const seen = [];            // [absolute day, weight] of every prediction
  weighted.forEach(c => {
    assert.equal(c.wt[0], 1);                       // a card's first answer gets no prediction
    let day = c.day0;
    for (let i = 0; i < c.ratings.length; i++) { day += c.deltas[i]; if (i > 0 && c.deltas[i] > 0) seen.push([day, c.wt[i]]); }
  });
  seen.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i][1] >= seen[i - 1][1] - 1e-12, 'weights never fall with time');
    if (seen[i][0] === seen[i - 1][0]) assert.equal(seen[i][1], seen[i - 1][1]);
  }
  assert.equal(seen[0][1], 0.5);
  assert.ok(seen[seen.length - 1][1] > 0.97);
  // the original histories are not touched
  assert.equal(cards[0].wt, undefined);
});

test('withRecency leaves histories without day0 alone (every review counts 1)', () => {
  const cards = synth(DEFAULT_W, 5, 4).map(c => ({ ...c, day0: undefined }));
  assert.equal(withRecency(cards), cards);
});

test('lossAndGrad with all weights 1 equals no weights; with weights it is a weighted sum', () => {
  const cards = synth(DEFAULT_W, 30, 5);
  const ones = cards.map(c => ({ ...c, wt: new Float64Array(c.ratings.length).fill(1) }));
  const a = lossAndGrad(cards, DEFAULT_W), b = lossAndGrad(ones, DEFAULT_W);
  assert.ok(Math.abs(a.loss - b.loss) < 1e-9);
  assert.equal(a.count, b.count);
  assert.ok(Math.abs(b.wsum - b.count) < 1e-9);
  const twos = cards.map(c => ({ ...c, wt: new Float64Array(c.ratings.length).fill(2) }));
  const c2 = lossAndGrad(twos, DEFAULT_W);
  assert.ok(Math.abs(c2.loss - 2 * a.loss) < 1e-9);
  assert.ok(Math.abs(c2.wsum - 2 * a.count) < 1e-9);
  for (let k = 0; k < a.grad.length; k++) assert.ok(Math.abs(c2.grad[k] - 2 * a.grad[k]) < 1e-8);
  // the weighted gradient matches a finite difference of the weighted loss
  const rec = withRecency(cards);
  const g = lossAndGrad(rec, DEFAULT_W);
  const k = 8, i = k + 4, h = 1e-5;
  const up = DEFAULT_W.slice(), dn = DEFAULT_W.slice();
  up[i] += h; dn[i] -= h;
  const fd = (lossAndGrad(rec, up).loss - lossAndGrad(rec, dn).loss) / (2 * h);
  assert.ok(Math.abs(fd - g.grad[k]) < 1e-4 * Math.max(1, Math.abs(fd)), `${fd} vs ${g.grad[k]}`);
});

test('evaluate: the plain numbers do not change with recency; weighted: true is the weighted mean', () => {
  const rec = withRecency(synth(DEFAULT_W, 30, 6));
  const plain = evaluate(rec, DEFAULT_W);
  const plain2 = evaluate(rec.map(c => ({ ...c, wt: undefined })), DEFAULT_W);
  assert.deepEqual(plain, plain2);
  const wtd = evaluateMany([{ cards: rec, w: DEFAULT_W }], { weighted: true });
  assert.equal(wtd.n, plain.n);
  assert.ok(wtd.wn < plain.n && wtd.wn > 0.5 * plain.n);
  assert.ok(wtd.rmse === plain.rmse);
});

test('fit: recency is on by default, repeatable, and changes the weights it finds', () => {
  assert.equal(FIT_DEFAULTS.recency, true);
  const cards = synth(DEFAULT_W, 150, 7);
  const run = config => { const it = fit({ cards, current: DEFAULT_W, defaults: DEFAULT_W, bounds: BOUNDS, config }); for (;;) { const r = it.next(); if (r.done) return r.value; } };
  const a = run({ epochs: 2 }), b = run({ epochs: 2 });
  assert.deepEqual(a.fitted, b.fitted);
  const off = run({ epochs: 2, recency: false });
  assert.notDeepEqual(a.fitted, off.fitted);
  // the check numbers a fit reports use every review equally, either way
  assert.equal(a.before.n, off.before.n);
});
