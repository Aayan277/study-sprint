// The answer-button labels are the gap rate() really gives (QA v4.14, major 1). Run with: node --test tests/preview-labels.test.js
// Needs ts-fsrs locally (`npm install`: it is a devDependency), like tests/exam-rate.test.js; skipped, with a loud warning, without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';

const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
if (skip) console.warn('\n*** ts-fsrs not installed: the scheduler tests in preview-labels.test.js are SKIPPED. Run `npm install` (ts-fsrs 5.4.2 is a devDependency). ***\n');
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

test('FSRS-7: the labels are the gap rate() gives (its fuzz is deterministic, so it stays on), with and without balancing', { skip }, async () => {
  const { rate, previewIntervals, prepare7, schedulerOptions, dayKey } = await load();
  let seed = 777;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 40; i++) {
    const stability = 1 + rnd() * 120;
    const state = { cardId: `s${i}`, state: 2, stability, difficulty: 1 + rnd() * 9, reps: 3 + i, lapses: 0, lastReview: NOW - Math.round(stability) * DAY, due: NOW, scheduledDays: Math.round(stability), elapsedDays: Math.round(stability), learningSteps: 0 };
    await prepare7([state], async () => []);
    const plain = { ...schedulerOptions({}), fsrsVersion: 7 };
    const load = new Map();
    for (let d = 1; d < 60; d++) if (rnd() < 0.5) load.set(dayKey(NOW + d * DAY), Math.floor(rnd() * 10));
    for (const opts of [plain, { ...plain, balance: { load, easyDays: undefined } }]) {
      const shown = previewIntervals(state, opts, NOW, state.cardId);
      assert.deepEqual(previewIntervals(state, opts, NOW, state.cardId), shown);
      for (const rating of [1, 2, 3, 4]) {
        const o = opts.balance ? { ...opts, balance: { load: new Map(load), easyDays: undefined } } : opts;
        assert.equal(shown[rating], rate(state.cardId, state, rating, o, NOW).due - NOW, `card ${i} rating ${rating}`);
      }
    }
  }
});

test('a deck with an exam: the labels show the day the exam puts the card on, for FSRS-6 and FSRS-7', { skip }, async () => {
  const { rate, previewIntervals, prepare7, schedulerOptions, dayKey } = await load();
  const { examOptions: exam } = await import('../js/exam.js');
  const deck = { id: 'd', examDate: '2026-10-15' };
  const state = { cardId: 'e', state: 2, stability: 4, difficulty: 5, reps: 3, lapses: 0, lastReview: NOW - 2 * DAY, due: NOW, scheduledDays: 2, elapsedDays: 2, learningSteps: 0 };
  await prepare7([state], async () => []);
  for (const v of [6, 7]) {
    const load = new Map([[dayKey(NOW + 3 * DAY), 9]]);
    const base = { ...exam(schedulerOptions({}), deck, NOW), ...(v === 7 ? { fsrsVersion: 7 } : {}), balance: { load } };
    const shown = previewIntervals(state, base, NOW);
    assert.deepEqual([...load], [[dayKey(NOW + 3 * DAY), 9]]);          // a preview counts nothing
    for (const rating of [3, 4]) {
      const real = rate('e', state, rating, { ...base, balance: { load: new Map(load) } }, NOW).due - NOW;
      assert.equal(shown[rating], real, `FSRS-${v} rating ${rating}`);
      assert.ok(real < 3 * DAY, 'the exam rule keeps the card before exam day: ' + real / DAY);
    }
  }
});
