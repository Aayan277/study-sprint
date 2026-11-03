import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logLoss, auc, rmseBins, compare } from '../js/rwkv-metrics.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('log loss: known values, and a certain wrong answer is clamped, not infinite', () => {
  near(logLoss([0.9, 0.2], [1, 0]), (-Math.log(0.9) - Math.log(0.8)) / 2);
  near(logLoss([0.5, 0.5], [1, 0]), Math.log(2));
  assert.ok(Number.isFinite(logLoss([0], [1])));
  near(logLoss([0], [1]), -Math.log(1e-6));
  assert.equal(logLoss([], []), null);
});

test('AUC: perfect, reversed, ties and a single class', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);
  near(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  near(auc([0.2, 0.6, 0.4, 0.8], [0, 1, 0, 1]), 1);
  near(auc([0.2, 0.7, 0.5, 0.4], [0, 1, 0, 1]), 0.75);        // 3 of the 4 pairs are in order
  assert.equal(auc([0.3, 0.4], [1, 1]), null);
  assert.equal(auc([0.3, 0.4], [0, 0]), null);
});

test('RMSE by bins: calibrated is 0, and a bin that is off counts by its size', () => {
  near(rmseBins([0.5, 0.5], [1, 0]), 0);
  near(rmseBins([0.9, 0.9, 0.9, 0.9], [1, 1, 1, 1]), 0.1);
  // two bins: 2 reviews at 0.1 (none remembered: off by 0.1), 2 at 0.9 (all remembered: off by 0.1)
  near(rmseBins([0.1, 0.1, 0.9, 0.9], [0, 0, 1, 1]), 0.1);
  near(rmseBins([1, 1], [1, 1]), 0);                              // 1.0 lands in the last bin
  assert.equal(rmseBins([], []), null);
});

const rec = (t, y, elapsedDays, p) => ({ t, y, elapsedDays, fsrsMine: p, fsrsDefault: p, rwkvCurve: p, rwkvImm: p });

test('compare: same reviews for every row; short gaps and missing predictions are left out; "since" filters by time', () => {
  const preds = [rec(1, 1, 3, 0.9), rec(2, 0, 5, 0.3), rec(3, 1, 0, 0.9), { ...rec(4, 1, 9, 0.8), fsrsMine: null }, rec(10, 1, 2, 0.8)];
  const all = compare(preds);
  assert.deepEqual(all.map(r => r.name), ['FSRS-6 (your settings)', 'FSRS-6 (default)', 'RWKV curve', 'RWKV instant']);
  assert.ok(all.every(r => r.n === 3));
  const since = compare(preds, { since: 5 });
  assert.ok(since.every(r => r.n === 1));
  assert.equal(since[0].auc, null);
  assert.equal(compare([]).every(r => r.n === 0 && r.logLoss === null), true);
});
