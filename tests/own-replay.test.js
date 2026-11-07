import './rwkv-utc.mjs';
// Tests for the replay test (tools/own-model/replay-core.mjs) on made-up learners from the sim source and the shipped js/own-params.js model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLearner } from '../tools/own-model/common.mjs';
import { loadShippedParams } from '../tools/own-model/eval-core.mjs';
import { warmUp, simulate, replayUser, crnU, cutoffOf, interpAt, matchedPct, summarizeReplay, runKey, TARGETS, TRUTHS, SCHEDS } from '../tools/own-model/replay-core.mjs';
import { createOwnModel } from '../js/own-model.js';

const shipped = await loadShippedParams();
assert.ok(shipped, 'js/own-params.js is needed');
const model = createOwnModel(shipped.params, shipped.size);
const learner = k => loadLearner({ kind: 'sim', split: 'test', k, config: { days: [60, 80] } });
const O = { model, fitFsrs: false, days: 40, maxCards: 60, seed: 3 };
const strip = r => JSON.parse(JSON.stringify(r, (k, v) => (k === 'seconds' || k === 'fitSeconds' ? undefined : v)));

test('a run is deterministic: the same user and settings give the same numbers', () => {
  const a = replayUser(learner(0), { ...O, targets: [0.9] }), b = replayUser(learner(0), { ...O, targets: [0.9] });
  assert.equal(a.ok, true);
  assert.deepEqual(strip(a), strip(b));
  assert.equal(Object.keys(a.runs).length, 4, 'truth x scheduler for one target');
  assert.ok(a.runs[runKey('own', 'own', 0.9)].reviews > 0);
  const c = replayUser(learner(0), { ...O, targets: [0.9], seed: 4 });
  assert.notDeepEqual(strip(a.runs), strip(c.runs), 'another seed gives other luck');
});

test('truth Own, scheduler Own: the mean chance of passing at review time is close to the target', () => {
  for (const R of [0.8, 0.9]) {
    let sum = 0, n = 0;
    for (const k of [0, 1, 2]) {
      const warm = warmUp(learner(k), O), r = simulate(warm, { truth: 'own', sched: 'own', R }, O);
      sum += r.meanP * r.reviews; n += r.reviews;
    }
    assert.ok(Math.abs(sum / n - R) < 0.06, `R ${R}: mean p ${(sum / n).toFixed(3)}`);
  }
});

test('common random numbers: the same card and review number get the same u under every scheduler', () => {
  const warm = warmUp(learner(1), O), seen = {};
  for (const sched of SCHEDS) {
    seen[sched] = new Map();
    simulate(warm, { truth: 'fsrs', sched, R: 0.9 }, { ...O, onReview: i => seen[sched].set(`${i.card}|${i.n}`, i) });
  }
  let shared = 0, differentP = false;
  for (const [key, a] of seen.fsrs) {
    const b = seen.own.get(key);
    if (!b) continue;
    shared++;
    assert.equal(a.u, b.u);
    assert.equal(a.u, crnU(O.seed, warm.user, a.card, a.n));
    if (a.p !== b.p) differentP = true;
  }
  assert.ok(shared > 20, `only ${shared} shared reviews`);
  assert.ok(differentP, 'the schedulers must differ (otherwise this checks nothing)');
  assert.notEqual(crnU(1, 'u', 'c', 0), crnU(1, 'u', 'c', 1));
  assert.notEqual(crnU(1, 'u', 'c', 0), crnU(2, 'u', 'c', 0));
  assert.equal(crnU(1, 'u', 'c', 0), crnU(1, 'u', 'c', 0));
  for (let n = 0; n < 50; n++) { const u = crnU(0, 'u', 'c', n); assert.ok(u >= 0 && u < 1); }
});

test('a higher target gives more reviews and more knowledge', () => {
  const warm = warmUp(learner(2), { ...O, days: 60 });
  for (const [truth, sched] of [['fsrs', 'fsrs'], ['own', 'own'], ['own', 'fsrs']]) {
    const lo = simulate(warm, { truth, sched, R: 0.8 }, { ...O, days: 60 }), hi = simulate(warm, { truth, sched, R: 0.95 }, { ...O, days: 60 });
    assert.ok(hi.reviews > lo.reviews, `${truth}/${sched}: reviews ${lo.reviews} -> ${hi.reviews}`);
    assert.ok(hi.kAvg > lo.kAvg, `${truth}/${sched}: knowledge ${lo.kAvg} -> ${hi.kAvg}`);
  }
});

test('nothing after the cutoff is read: poisoned later rows change nothing; an earlier row does', () => {
  const clean = learner(0), cutoff = cutoffOf(clean.rows);
  const later = clean.rows.filter(r => r.day > cutoff).length;
  assert.ok(later > 10, 'the learner must have reviews after the cutoff');
  let at = 0;
  const poisoned = { ...clean, rows: clean.rows.map(r => (r.day > cutoff
    ? { ...r, rating: (at++ % 2) ? 1 : 4, ms: 123456, gapSec: 1, noteKey: 'poison', deckKey: 'poison', t: r.t + 7777, kind: 'replay' } : r)) };
  assert.equal(cutoffOf(poisoned.rows), cutoff);
  const a = replayUser(clean, { ...O, targets: [0.9] }), b = replayUser(poisoned, { ...O, targets: [0.9] });
  assert.deepEqual(strip(a), strip(b));
  let flipped = false;
  const early = { ...clean, rows: clean.rows.map((r, i) => (!flipped && r.day <= cutoff && i > 30 ? (flipped = true, { ...r, rating: r.rating === 1 ? 4 : 1 }) : r)) };
  assert.notDeepEqual(strip(replayUser(early, { ...O, targets: [0.9] }).runs), strip(a.runs), 'an earlier row is read');
});

test('the warm-up leaves its state alone and the simulation keeps to its rules', () => {
  const warm = warmUp(learner(0), O), before = JSON.stringify(warm.own.feats.toJSON()), seen = [];
  const r = simulate(warm, { truth: 'own', sched: 'fsrs', R: 0.9 }, { ...O, onReview: i => seen.push(i) });
  assert.equal(JSON.stringify(warm.own.feats.toJSON()), before, 'runs work on a clone');
  assert.equal(r.reviews, seen.length);
  assert.ok(seen.every(i => i.day > warm.cutoff && i.day <= warm.cutoff + O.days));
  assert.ok(warm.cards.length <= O.maxCards);
  const perDay = new Map();
  for (const i of seen) { const k = `${i.card}|${i.day}`; perDay.set(k, (perDay.get(k) || 0) + 1); }
  assert.ok(Math.max(...perDay.values()) <= 4, 'a card is reviewed at most once and then 3 repeats a day');
  assert.ok(r.lapses <= r.reviews && r.kAvg > 0 && r.kAvg <= 1);
});

test('interpolation and the matched-knowledge headline on hand-made numbers; the report has no per-user lines', () => {
  assert.ok(Math.abs(interpAt([{ x: 0.8, y: 100 }, { x: 0.9, y: 200 }], 0.85) - 150) < 1e-9);
  assert.equal(interpAt([{ x: 0.9, y: 200 }, { x: 0.8, y: 100 }], 0.9), 200);
  assert.equal(interpAt([{ x: 0.8, y: 100 }, { x: 0.9, y: 200 }], 0.95), null);
  const mk = (id, own) => {
    const runs = {};
    for (const truth of TRUTHS) TARGETS.forEach((R, i) => {
      runs[runKey(truth, 'fsrs', R)] = { reviews: 100 + 100 * i, lapses: 5, meanP: R, kEnd: 0.8 + 0.05 * i, kAvg: 0.8 + 0.05 * i, perCard: 1, cards: 10 };
      runs[runKey(truth, 'own', R)] = { reviews: own * (100 + 100 * i), lapses: 5, meanP: R, kEnd: 0.8 + 0.05 * i, kAvg: 0.8 + 0.05 * i, perCard: 1, cards: 10 };
    });
    return { user: id, ok: true, runs };
  };
  assert.ok(Math.abs(matchedPct(mk('a', 0.7), 'own', 0.9) + 30) < 1e-9);
  const { markdown, data } = summarizeReplay([mk('secret1', 0.7), mk('secret2', 0.8), mk('secret3', 0.9), { user: 'bad', ok: false, runs: {} }], { tag: 't' });
  assert.ok(Math.abs(data.truths.own.headline['0.90'].mean + 20) < 1e-9);
  assert.equal(data.truths.own.headline['0.90'].users, 3);
  assert.match(markdown, /Truth: Own model/); assert.match(markdown, /Truth: FSRS-6/); assert.match(markdown, /1 failed/);
  assert.ok(!/secret/.test(markdown));
});
