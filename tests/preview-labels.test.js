// The answer-button labels are the gap rate() really gives (QA v4.14, major 1). Run with: node --test tests/preview-labels.test.js
// Needs ts-fsrs locally (npm install), like tests/exam-rate.test.js; skipped without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';

const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
if (!skip) register('./sim/loader.mjs', import.meta.url);
const load = async () => ({ ...(await import('../js/srs.js')), ...(await import('../js/sched-settings.js')), ...(await import('../js/queue.js')), ...(await import('../js/stats-calc.js')) });

const DAY = 86400000;
const NOW = new Date(2026, 9, 12, 10).getTime();

test('preview labels equal the real scheduled gap for many random cards and ratings, with Spread out due dates on', { skip }, async () => {
  const { rate, previewIntervals, schedulerOptions, formatInterval, dayKey } = await load();
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let checked = 0;
  for (let i = 0; i < 150; i++) {
    const stability = 0.5 + rnd() * rnd() * 200;
    const state = rnd() < 0.15 ? null : { cardId: `c${i}`, state: rnd() < 0.85 ? 2 : 3, stability, difficulty: 1 + rnd() * 9, reps: 2 + Math.floor(rnd() * 20), lapses: 0,
      lastReview: NOW - Math.round(stability) * DAY, due: NOW, scheduledDays: Math.round(stability), elapsedDays: Math.round(stability), learningSteps: 0 };
    const load = new Map();
    for (let d = 1; d < 80; d++) if (rnd() < 0.6) load.set(dayKey(NOW + d * DAY), Math.floor(rnd() * 12));
    const easyDays = ['normal', 'reduced', 'normal', 'minimum', 'normal', 'normal', 'normal'];
    const opts = { ...schedulerOptions({}), balance: { load, easyDays } };
    const before = [...load];
    const shown = previewIntervals(state, opts, NOW, `c${i}`);
    assert.deepEqual([...load], before);                                       // a preview counts nothing
    assert.deepEqual(previewIntervals(state, opts, NOW, `c${i}`), shown);      // stable across redraws
    for (const rating of [1, 2, 3, 4]) {
      const real = rate(`c${i}`, state, rating, { ...opts, balance: { load: new Map(load), easyDays } }, NOW).due - NOW;
      assert.equal(shown[rating], real, `card ${i} rating ${rating}`);
      assert.equal(formatInterval(shown[rating]), formatInterval(real));
      checked++;
    }
  }
  assert.equal(checked, 600);
});

test('rate on the same card, state and button picks the same day every time (no random draw)', { skip }, async () => {
  const { rate, schedulerOptions } = await load();
  const state = { cardId: 'x', state: 2, stability: 30, difficulty: 5, reps: 5, lapses: 0, lastReview: NOW - 30 * DAY, due: NOW, scheduledDays: 30, elapsedDays: 30, learningSteps: 0 };
  const opts = { ...schedulerOptions({}), balance: { load: new Map(), easyDays: undefined } };
  const first = rate('x', state, 3, { ...opts, balance: { load: new Map() } }, NOW).due;
  for (let i = 0; i < 10; i++) assert.equal(rate('x', state, 3, { ...opts, balance: { load: new Map() } }, NOW).due, first);
});

test('preview without balancing is the exact gap and does not change from call to call', { skip }, async () => {
  const { previewIntervals, schedulerOptions } = await load();
  const state = { cardId: 'x', state: 2, stability: 30, difficulty: 5, reps: 5, lapses: 0, lastReview: NOW - 30 * DAY, due: NOW, scheduledDays: 30, elapsedDays: 30, learningSteps: 0 };
  const a = previewIntervals(state, schedulerOptions({}), NOW);
  for (let i = 0; i < 5; i++) assert.deepEqual(previewIntervals(state, schedulerOptions({}), NOW), a);
});
