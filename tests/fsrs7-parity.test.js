// Checks that js/fsrs7-model.js (the memory model) and js/fsrs7-sched.js (the scheduler) give exactly what ts-fsrs 6.0.0-beta.14 gives.
// Run with: node tests/fsrs7-parity.test.js
// The beta is a devDependency under the name ts-fsrs-beta (npm install), or set TS_FSRS_BETA_PATH to its dist/index.mjs. Without it
// every test here is SKIPPED, and says so loudly. If the beta changes the maths, this is the test that fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { W7_DEFAULT, W7_BOUNDS, clipWeights7, curve7, forgettingCurve7, nextInterval7, initState7, nextState7 } from '../js/fsrs7-model.js';
import { plan7 } from '../js/fsrs7-sched.js';
import { mulberry32 } from '../js/fsrs-fit.js';

const local = process.env.TS_FSRS_BETA_PATH || new URL('../node_modules/ts-fsrs-beta/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 6.0.0-beta.14 is not installed';
if (skip) console.warn('\n*** ts-fsrs-beta not installed: the FSRS-7 parity tests are SKIPPED. Run `npm install` (ts-fsrs-beta is a devDependency). ***\n');
const root = () => pathToFileURL(local).href;
const loadModel = () => import(root().replace(/index\.mjs$/, 'models/fsrs-7.mjs'));

function randomWeights(rng) {
  return clipWeights7(W7_BOUNDS.map(([lo, hi]) => lo + (hi - lo) * rng()));
}
// A random history: first rating, then (days since the last answer, rating), with fractions of a day and long gaps.
function history(rng) {
  const n = 2 + Math.floor(rng() * 12);
  const steps = [{ t: 0, g: 1 + Math.floor(rng() * 4) }];
  for (let i = 1; i < n; i++) {
    const u = rng();
    const t = u < 0.25 ? rng() * 0.05 : u < 0.5 ? rng() * 1.5 : u < 0.85 ? 1 + rng() * 40 : 1 + rng() * 600;
    steps.push({ t, g: 1 + Math.floor(rng() * 4) });
  }
  return steps;
}

test('the default weights and the weight bounds are the library\'s', { skip }, async () => {
  const lib = await loadModel();
  assert.deepEqual([...W7_DEFAULT], [...lib.FSRS7_DEFAULT_WEIGHTS]);
  assert.deepEqual(W7_BOUNDS.map(b => [...b]), lib.FSRS7ParameterBounds().map(b => [...b]));
  const rng = mulberry32(7);
  for (let i = 0; i < 50; i++) {                              // wild numbers (and junk) are clipped the same way
    const wild = Array.from({ length: 34 }, () => (rng() < 0.05 ? NaN : (rng() - 0.3) * 20));
    assert.deepEqual(clipWeights7(wild), lib.clipFSRS7Parameters(wild));
  }
});

test('memory, curve and interval match the library: 300 random histories, default and random weights', { skip }, async () => {
  const lib = await loadModel();
  const rng = mulberry32(2026);
  let steps = 0;
  for (let h = 0; h < 300; h++) {
    const w = h % 3 === 0 ? [...W7_DEFAULT] : randomWeights(rng);
    const algo = new lib.FSRS7Algorithm(w, lib.FSRS7_MODEL_BOUNDS);
    let theirs = null, ours = null;
    for (const [i, { t, g }] of history(rng).entries()) {
      if (i > 0) {
        const a = algo.curve(t, theirs), b = curve7(w, ours, t);
        assert.ok(Math.abs(a.retrievability - b.r) < 1e-12, `curve h${h} step ${i}: ${a.retrievability} vs ${b.r}`);
        assert.ok(Math.abs(a.derivative - b.dr) < 1e-12 * Math.max(1, Math.abs(a.derivative)), `slope h${h} step ${i}`);
        assert.equal(forgettingCurve7(w, ours, t), b.r);
      }
      theirs = algo.next_state(i === 0 ? null : theirs, t, g);
      ours = nextState7(w, i === 0 ? null : ours, t, g);
      for (const k of ['stability', 'stabilityFast', 'difficulty']) assert.ok(Math.abs(theirs[k] - ours[k]) < 1e-9 * Math.max(1, theirs[k]), `${k} h${h} step ${i}: ${theirs[k]} vs ${ours[k]}`);
      if (i === 0) assert.deepEqual(initState7(w, g), ours);
      for (const dr of [0.7, 0.9, 0.97]) {
        const x = algo.next_interval(theirs, dr), y = nextInterval7(w, ours, dr);
        assert.ok(Math.abs(x - y) < 1e-9 * Math.max(1, x), `interval h${h} step ${i} dr ${dr}: ${x} vs ${y}`);
      }
      steps++;
    }
  }
  assert.ok(steps > 1500);
});

test('a new card answered Good at the default weights is due in about 4.8 days (the number in the research note)', { skip }, () => {
  let m = nextState7(W7_DEFAULT, null, 0, 3);
  assert.ok(Math.abs(nextInterval7(W7_DEFAULT, m, 0.9) - 4.78) < 0.02);
});

// ---------- the scheduler, card by card ----------
// The library's own scheduler (DefaultScheduler, FSRS-7) against plan7. Each step: all four ratings from the same card, then one is applied.
test('scheduler: due date, state, step, stability and counters match the library for every rating: 150 random cards', { skip }, async () => {
  const lib = await import(root());
  const rng = mulberry32(99);
  const stepSets = [[['1m', '10m'], ['10m']], [['1m', '10m', '1h'], ['10m', '1h']], [['5m'], []], [[], ['10m']], [['2m', '30m'], ['30m']], [[], []]];
  const DAY = 86400000;
  let compared = 0;
  for (let c = 0; c < 150; c++) {
    const [learningSteps, relearningSteps] = stepSets[c % stepSets.length];
    const retention = [0.8, 0.9, 0.95, 0.97][Math.floor(rng() * 4)];
    const maxInterval = [36500, 365, 60, 30][Math.floor(rng() * 4)];
    const fuzz = c % 3 === 0;
    const w = c % 2 ? [...W7_DEFAULT] : randomWeights(rng);
    const cfg = { w, retention, learningSteps, relearningSteps, maxInterval, fuzz };
    const sched = await lib.DefaultScheduler({ version: 'FSRS-7', weights: w, desiredRetention: retention, learningSteps, relearningSteps, maximumInterval: maxInterval, enableFuzz: fuzz });
    let now = Date.UTC(2026, 9, 1, 8 + Math.floor(rng() * 12), Math.floor(rng() * 60), Math.floor(rng() * 60));
    let card = sched.newCard(new Date(now));
    let mine = { state: 0, learningStep: 0, reps: 0, lapses: 0, lastReview: null, cardId: card.cardId, memory: null };
    for (let i = 0; i < 14; i++) {
      const outcome = plan7(mine, cfg, now);
      const results = [1, 2, 3, 4].map(g => ({ g, theirs: sched.review({ card, grade: g, now: new Date(now) }).card, ours: outcome(g) }));
      for (const { g, theirs, ours } of results) {
        const tag = `card ${c} step ${i} grade ${g}`;
        assert.equal(ours.state, theirs.state, `state ${tag}`);
        assert.equal(ours.learningStep, theirs.learningStep, `learning step ${tag}`);
        assert.equal(ours.reps, theirs.reps, `reps ${tag}`);
        assert.equal(ours.lapses, theirs.lapses, `lapses ${tag}`);
        assert.ok(Math.abs(ours.scheduledDays - theirs.scheduledDays) < 1e-9 * Math.max(1, ours.scheduledDays), `scheduled days ${tag}: ${ours.scheduledDays} vs ${theirs.scheduledDays}`);
        assert.ok(Math.abs(ours.due - new Date(theirs.dueAt).getTime()) <= 2, `due ${tag}`);
        for (const k of ['stability', 'stabilityFast', 'difficulty']) assert.ok(Math.abs(ours.memory[k] - theirs[k]) < 1e-9 * Math.max(1, theirs[k]), `${k} ${tag}`);
        compared++;
      }
      const pick = results[Math.floor(rng() * 4)];
      mine = { state: pick.ours.state, learningStep: pick.ours.learningStep, reps: pick.ours.reps, lapses: pick.ours.lapses, lastReview: now, cardId: card.cardId, memory: pick.ours.memory };
      card = pick.theirs;
      // the next answer comes when due, early, or late (minutes to months)
      const u = rng();
      const due = new Date(card.dueAt).getTime();
      now = u < 0.4 ? Math.max(now + 1000, due) : u < 0.6 ? now + Math.floor(rng() * 3600000) + 1000 : u < 0.8 ? now + Math.floor(rng() * 5 * DAY) + 1000 : due + Math.floor(rng() * 90 * DAY);
    }
  }
  assert.ok(compared > 7000);
});
