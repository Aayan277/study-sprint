import './own-utc.mjs';
// Tests for the "v2" planning read used by the trust rule: fadedP / fadedDays with `fresh` features (js/own-model.js), the engine's sched
// option (js/own-engine.js) and afterCounters (js/own-features.js). The default read ('fade') must stay exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/own-engine.js';
import { initParams, createOwnModel } from '../js/own-model.js';
import { pAt, largestDayAtLeast } from '../js/own-curve.js';
import { mulberry32 } from '../js/fsrs-fit.js';
import { OwnFeatures } from '../js/own-features.js';
import { miniRows } from './own-mini.mjs';

const noisy = (seed, scale = 0.5) => { const p = initParams('s', seed), r = mulberry32(seed * 7 + 1); for (let i = 0; i < p.length; i++) p[i] += (r() - 0.5) * scale; return p; };
const f32 = rng => new Float32Array(18).map(() => rng());
const statesOf = (m, rng) => {
  let st = m.advance(f32(rng), m.decayAll({}, null));
  st = m.advance(f32(rng), m.decayAll(st, { note: 0.5, deck: 1, user: 2 }));
  return st;
};
const L = x => Math.log1p(x > 0 ? x : 0);

test('non-fresh fadedP / fadedDays equal a plain recomputation (decayAll + headOf + pAt) on random parameters and states', () => {
  const rng = mulberry32(11);
  for (let trial = 0; trial < 12; trial++) {
    const m = createOwnModel(noisy(trial + 1)), st = statesOf(m, rng), fq = f32(rng), pOf = m.fadedP(st, fq);
    const ref = t => pAt(m.headOf(m.decayAll(st, { note: t, deck: 0, user: 0 }), fq), t);
    for (const t of [0.01, 0.4, 1, 3.7, 20, 400, 9000]) assert.ok(Math.abs(pOf(t) - ref(t)) < 1e-12, `trial ${trial} t ${t}`);
    for (const R of [0.5, 0.8, 0.9]) {
      const want = Number.isFinite(ref(1)) ? largestDayAtLeast(ref, R, 3650) : null;
      assert.equal(m.fadedDays(st, fq, R, 3650), want);
      assert.equal(m.fadedDays(st, fq, R, 3650, null), want, 'fresh = null is the default');
    }
  }
});

test('v2 (fresh with decayAll): p at each gap equals the head read on hand-built features, all memories faded by t, to 1e-12', () => {
  const rng = mulberry32(5);
  for (let trial = 0; trial < 10; trial++) {
    const m = createOwnModel(noisy(trial + 20)), st = statesOf(m, rng);
    const fresh = { noteGap0: 0, age0: 4 + trial, answers: 3 + trial, lapses: trial % 4, neutral: [0, 0, 0, 0, 0], decayAll: true };
    const pOf = m.fadedP(st, f32(rng), fresh);
    for (const t of [0.05, 0.9, 1, 2.5, 11, 80, 700]) {
      const f = new Float64Array(18);
      f[3] = L(t) / 5; f[6] = L(fresh.answers) / 3; f[7] = L(fresh.lapses) / 2; f[8] = L(fresh.age0 + t) / 6;
      const want = pAt(m.headOf(m.decayAll(st, { note: t, deck: t, user: t }), f), t);
      assert.ok(Math.abs(pOf(t) - want) < 1e-12, `trial ${trial} t ${t}: ${pOf(t)} vs ${want}`);
    }
    assert.equal(m.fadedP(st, null, fresh)(3), pOf(3), 'the query features do not matter');
    const d = m.fadedDays(st, null, 0.85, 3650, fresh);
    assert.ok(Number.isInteger(d) && d >= 1 && d <= 3650);
  }
});

test('the engine: sched v2 gives whole days >= 1, ordered, changes nothing; fade stays the default', () => {
  const rows = miniRows(), P = Float32Array.from(noisy(3, 0.3)), e = new Engine(P);
  for (const _ of e.replay(rows.slice(0, 10))) { /* drive */ }
  e.snapshotDirty();
  const before = JSON.stringify(e.toJSON()), row = rows[10];
  for (const R of [0.6, 0.8, 0.9]) {
    const fade = e.daysForButtons(row, 8000, R, 365), v2 = e.daysForButtons(row, 8000, R, 365, { sched: 'v2' });
    assert.deepEqual(e.daysForButtons(row, 8000, R, 365, { sched: 'fade' }), fade);
    assert.deepEqual(Object.keys(v2), ['2', '3', '4']);
    for (const r of [2, 3, 4]) assert.ok(Number.isInteger(v2[r]) && v2[r] >= 1 && v2[r] <= 365);
    assert.ok(v2[2] <= v2[3] && v2[3] <= v2[4]);
    // Good, by hand: the planned answer's counters and the candidate gap, every memory faded by the gap
    const b = e.builder, m = e.model, c = b.cards.get(row.cardKey);
    const dec = m.decayAll(e._states(row), b.gaps(row)), next = m.advance(b.features({ ...row, rating: 3, ms: 8000 }, false), dec);
    const pOf = t => { const f = new Float64Array(18); f[3] = L(t) / 5; f[6] = L(c.answers + 1) / 3; f[7] = L(c.lapses) / 2; f[8] = L(row.day - c.firstDay + t) / 6; return pAt(m.headOf(m.decayAll(next, { note: t, deck: t, user: t }), f), t); };
    const hand = largestDayAtLeast(pOf, R, 365), want = Math.max(1, Math.min(365, hand));
    assert.equal(v2[3], Math.max(want, v2[2]), `Good at R ${R}`);
  }
  assert.equal(JSON.stringify(e.toJSON()), before);
  assert.equal(e.snapshotDirty().cards.length, 0);
  assert.throws(() => e.daysForButtons(row, 8000, 0.9, 365, { sched: 'nope' }), /sched/);
  assert.equal(e.daysForButtons(row, 8000, 0.9, 0, { sched: 'v2' }), null);
});

test('afterCounters: answers, lapses and card age after a planned answer, changing nothing', () => {
  const b = new OwnFeatures(), rows = miniRows();
  for (const r of rows.slice(0, 10)) b.commit(r);
  const before = JSON.stringify(b.toJSON()), row = rows[10], c = b.cards.get(row.cardKey);
  assert.deepEqual(b.afterCounters(row, 3), { age0: row.day - c.firstDay, answers: c.answers + 1, lapses: c.lapses });
  assert.deepEqual(b.afterCounters(row, 1), { age0: row.day - c.firstDay, answers: c.answers + 1, lapses: c.lapses + 1 });
  assert.deepEqual(new OwnFeatures().afterCounters(row, 1), { age0: 0, answers: 1, lapses: 1 });
  assert.equal(JSON.stringify(b.toJSON()), before);
});
