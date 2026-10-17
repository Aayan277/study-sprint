// Checks that the forward model in js/fsrs-fit.js gives the same memory state as the real scheduler (ts-fsrs 5.4.2).
// Run with: node tests/fsrs-parity.test.js
// If ts-fsrs drifts (a new FSRS version), this is the test that fails. It needs a local copy, like tests/exam-rate.test.js:
//   npm install --no-save ts-fsrs@5.4.2      (or set TS_FSRS_PATH to its dist/index.mjs)
// Without that copy these tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { forgettingCurve, initState, nextState, evaluate, mulberry32 } from '../js/fsrs-fit.js';

const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
const load = () => import(pathToFileURL(local).href);

// Random weights inside ts-fsrs's own bounds (so they are valid), or the defaults.
function randomWeights(lib, rng) {
  const clip = lib.CLAMP_PARAMETERS(lib.W17_W18_Ceiling, true);
  return clip.map(([lo, hi]) => lo + (hi - lo) * rng());
}

// A random history: first rating, then (days since the last answer, rating) pairs, with plenty of same-day answers.
function randomHistory(rng) {
  const n = 2 + Math.floor(rng() * 14);
  const steps = [{ t: 0, g: 1 + Math.floor(rng() * 4) }];
  for (let i = 1; i < n; i++) {
    const u = rng();
    const t = u < 0.3 ? 0 : u < 0.8 ? 1 + Math.floor(rng() * 30) : 1 + Math.floor(rng() * 400);
    steps.push({ t, g: 1 + Math.floor(rng() * 4) });
  }
  return steps;
}

test('the model matches ts-fsrs step by step: 200 random histories, default and random weights', { skip }, async () => {
  const lib = await load();
  const rng = mulberry32(2026);
  let compared = 0;
  for (let h = 0; h < 200; h++) {
    const w0 = h % 4 === 0 ? [...lib.default_w] : randomWeights(lib, rng);
    const algo = new lib.FSRSAlgorithm(lib.generatorParameters({ w: w0, enable_fuzz: false }));
    const w = [...algo.param.w];                                   // the weights as ts-fsrs holds them (after its own clipping)
    assert.equal(w.length, 21);
    let mem = null, s, d;
    for (const [i, { t, g }] of randomHistory(rng).entries()) {
      if (i === 0) {
        mem = algo.next_state(null, 0, g);
        ({ s, d } = initState(w, g));
      } else {
        // the predicted chance of remembering, from both
        const theirs = algo.forgetting_curve(t, mem.stability), ours = forgettingCurve(w, t, s);
        assert.ok(Math.abs(theirs - ours) < 1e-12, `curve h${h} step ${i}: ${theirs} vs ${ours}`);
        mem = algo.next_state(mem, t, g);
        ({ s, d } = nextState(w, s, d, t, g));
      }
      assert.ok(Math.abs(mem.stability - s) < 1e-9 * Math.max(1, s), `stability h${h} step ${i}: ${mem.stability} vs ${s}`);
      assert.ok(Math.abs(mem.difficulty - d) < 1e-9, `difficulty h${h} step ${i}: ${mem.difficulty} vs ${d}`);
      compared++;
    }
  }
  assert.ok(compared > 1000);
});

test('the metrics match a log loss worked out from ts-fsrs predictions', { skip }, async () => {
  const lib = await load();
  const rng = mulberry32(5);
  const w = [...lib.default_w];
  const algo = new lib.FSRSAlgorithm(lib.generatorParameters({ w, enable_fuzz: false }));
  const cards = [];
  let loss = 0, n = 0;
  for (let c = 0; c < 60; c++) {
    const steps = randomHistory(rng);
    cards.push({ deltas: Int32Array.from(steps.map(x => x.t)), ratings: Uint8Array.from(steps.map(x => x.g)), scored: Uint8Array.from(steps.map(() => 1)) });
    let mem = null;
    for (const [i, { t, g }] of steps.entries()) {
      if (i > 0) {
        const r = algo.forgetting_curve(t, mem.stability);
        if (t > 0) { const p = Math.min(Math.max(r, 1e-6), 1 - 1e-6); loss -= Math.log(g > 1 ? p : 1 - p); n++; }
      }
      mem = algo.next_state(mem, i ? t : 0, g);
    }
  }
  const ours = evaluate(cards, w);
  assert.equal(ours.n, n);
  assert.ok(Math.abs(ours.logLoss - loss / n) < 1e-9, `${ours.logLoss} vs ${loss / n}`);
});

test('the bounds and defaults used by the fit tests are ts-fsrs\'s own', { skip }, async () => {
  const lib = await load();
  assert.equal(lib.default_w.length, 21);
  const clip = lib.CLAMP_PARAMETERS(lib.W17_W18_Ceiling, true);
  assert.equal(clip.length, 21);
  // the fit tests copy these two lists; if ts-fsrs changes them, this shows it
  const BOUNDS = [[0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2], [0.01, 0.8], [0.1, 0.8]];
  assert.deepEqual(clip, BOUNDS);
  assert.deepEqual([...lib.default_w], [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]);
});
