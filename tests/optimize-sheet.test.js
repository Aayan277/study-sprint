// Tests for js/optimize-sheet.js: judging weights per deck (the relearning-step clip) and running a fit with a time limit,
// Cancel and the main-thread fallback. The sheet itself is covered by tests/browser/e2e-optimize.mjs.
// Run with: node tests/optimize-sheet.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ui.js (which the sheet imports) looks at the page when it loads; give it just enough to do so in Node.
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.document ??= { getElementById: () => null, addEventListener() {}, querySelector: () => null };
const { runFit, TIME_LIMIT_MS } = await import('../js/optimize-sheet.js');
const { judge, initState, nextState, forgettingCurve, mulberry32, evaluate } = await import('../js/fsrs-fit.js');

const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const BOUNDS = [[0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2], [0.01, 0.8], [0.1, 0.8]];

function cards(w, n, seed) {
  const rng = mulberry32(seed), out = [];
  for (let c = 0; c < n; c++) {
    const deltas = [0], ratings = [3], scored = [1];
    let { s, d } = initState(w, 3);
    for (let i = 1; i < 8; i++) {
      const t = Math.max(1, Math.round(s * (0.6 + rng())));
      const r = forgettingCurve(w, t, s);
      const g = rng() < r ? 3 : 1;
      deltas.push(t); ratings.push(g); scored.push(1);
      ({ s, d } = nextState(w, s, d, t, g, true, r));
    }
    out.push({ deltas: Int32Array.from(deltas), ratings: Uint8Array.from(ratings), scored: Uint8Array.from(scored) });
  }
  return out;
}

test('judge: scores each deck with the weights clipped for its own relearning steps', () => {
  const cs = cards(W, 60, 3);
  const seen = [];
  // A clip that records the step count and pins w17 and w18 to a tiny value for decks with more than one step.
  const clip = (w, n) => { seen.push(n); const o = w.slice(); if (n > 1) { o[17] = 0.01; o[18] = 0.01; } return o; };
  const steps = cs.map((_, i) => (i % 2 ? 2 : 1));
  const v = judge(cs, steps, W, W, clip);
  assert.deepEqual([...new Set(seen)].sort(), [1, 2]);
  assert.equal(v.better, false);                                   // the same weights are not "better"
  assert.equal(v.before.n, v.after.n);
  assert.ok(v.before.n > 0);
  // With every deck on one step it is the plain evaluation.
  const plain = judge(cs, cs.map(() => 1), W, W, (w) => w);
  assert.equal(plain.before.logLoss, evaluate(cs, W).logLoss);
});

test('judge: better weights win, worse ones lose', () => {
  const truth = [0.12, 0.7, 1.4, 5.5, 6.8, 0.9, 3.0, 0.002, 1.35, 0.35, 0.7, 1.9, 0.07, 0.3, 1.3, 0.55, 1.9, 0.6, 0.12, 0.08, 0.3];   // someone who forgets faster
  const cs = cards(truth, 200, 5);
  const id = w => w;
  const v = judge(cs, cs.map(() => 1), W, truth, id);
  assert.equal(v.better, true);
  assert.equal(judge(cs, cs.map(() => 1), truth, W, id).better, false);
});

const slow = () => ({ cards: cards(W, 150, 9), current: W, defaults: W, bounds: BOUNDS });

test('runFit on the page (no worker): runs to the end, with progress that never goes back', async () => {
  const seen = [];
  let fell = 0;
  const { promise } = runFit(slow(), { useWorker: false, onProgress: p => seen.push(p.progress), onFallback: () => fell++ });
  const out = await promise;
  assert.equal(out.status, 'done');
  assert.equal(out.inWorker, false);
  assert.equal(fell, 1);
  assert.ok(['better', 'same'].includes(out.result.status));
  assert.ok(seen.length > 3 && seen.every((p, i) => i === 0 || p >= seen[i - 1]));
});

test('runFit: Cancel stops it and nothing is returned', async () => {
  let handle;
  handle = runFit(slow(), { useWorker: false, onProgress: () => handle?.cancel() });
  const out = await handle.promise;
  assert.equal(out.status, 'cancelled');
});

test('runFit: the time limit ends it', async () => {
  const { promise } = runFit(slow(), { useWorker: false, timeoutMs: 0 });
  const out = await promise;
  assert.equal(out.status, 'timeout');
});

test('runFit: a failing fit is reported, not thrown', async () => {
  const { promise } = runFit({ cards: null, current: W, defaults: W, bounds: BOUNDS }, { useWorker: false });
  const out = await promise;
  assert.equal(out.status, 'error');
});

test('the limit is two minutes', () => assert.equal(TIME_LIMIT_MS, 120000));
