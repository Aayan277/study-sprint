import './rwkv-utc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnModel, initParams, StateStore, eventsFromRows } from '../js/own-model.js';
import { Tape } from '../js/own-grad.js';
import { OwnFeatures } from '../js/own-features.js';
import { paramCount, paramOffsets, paramLayout, sizesOf } from '../js/own-spec.js';
import { pAt } from '../js/own-curve.js';
import { mulberry32 } from '../js/fsrs-fit.js';
import { miniRows } from './own-mini.mjs';

// small random noise on top of the starting values, so no gradient is exactly zero for a lucky reason
const noisy = (seed = 3, size = 's') => { const p = initParams(size, seed), r = mulberry32(seed + 100); for (let i = 0; i < p.length; i++) p[i] += (r() - 0.5) * 0.3; return p; };

test('parameter count is exact, and the layout adds up', () => {
  assert.equal(paramCount('s'), 19178);
  assert.equal(paramCount('m'), 63306);
  assert.equal(initParams('s', 1).length, 19178);
  assert.equal(createOwnModel(initParams('s', 1), 's').paramCount, 19178);
  assert.throws(() => createOwnModel(new Float64Array(10), 's'), /Wrong number of parameters/);
  const off = paramOffsets('s');
  let sum = 0;
  for (const p of paramLayout('s')) { assert.equal(off[p.name].offset, sum); sum += off[p.name].length; }
  assert.equal(sum, 19178);
});

test('starting parameters: deterministic by seed, different across seeds, sensible', () => {
  const a = initParams('s', 7), b = initParams('s', 7), c = initParams('s', 8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every(Number.isFinite));
  const off = paramOffsets('s');
  const tau = Array.from(a.subarray(off['note.theta'].offset, off['note.theta'].offset + 16), Math.exp);
  assert.ok(Math.abs(tau[0] - 0.05) < 1e-9 && Math.abs(tau[15] - 100) < 1e-6);
  for (let i = 1; i < 16; i++) assert.ok(tau[i] > tau[i - 1]);
  // fresh head: ceiling about 0.9, stabilities 0.5 / 5 / 50 days
  const m = createOwnModel(a, 's');
  const head = m.headOf(m.decayAll({}, null), new Float32Array(18));
  assert.ok(head.a > 0.8 && head.a < 0.95);
  for (let k = 0; k < 3; k++) assert.ok(head.s[k] > [0.4, 4, 40][k] && head.s[k] < [0.6, 6, 60][k]);
});

test('determinism by seed: the same events give bit-identical predictions and states', () => {
  const run = seed => {
    const m = createOwnModel(initParams('s', seed), 's'), st = new StateStore();
    const ps = m.predictChunk(eventsFromRows(miniRows()), st);
    return { ps, user: Array.from(st.user) };
  };
  assert.deepEqual(run(5), run(5));
  assert.notDeepEqual(run(5).ps, run(6).ps);
});

test('inference path equals tape path to 1e-6 (whole history, and chunked with carried state)', () => {
  const params = noisy(4), m = createOwnModel(params, 's'), ev = eventsFromRows(miniRows());
  const fast = m.predictChunk(ev, new StateStore());
  // whole history on the tape: pull the predictions out by comparing BCE to the one computed from the fast path
  const scored = ev.filter(e => e.score);
  assert.equal(fast.length, scored.length);
  const bce = scored.reduce((s, e, i) => s - (e.y ? Math.log(fast[i]) : Math.log(1 - fast[i])), 0);
  const tape = new Tape(), grads = new Float64Array(params.length);
  const one = m.trainChunk(tape, grads, ev, new StateStore(), false);
  assert.equal(one.count, scored.length);
  assert.ok(Math.abs(one.loss - bce) < 1e-6, `${one.loss} vs ${bce}`);
  // per-event predictions: score one event at a time on the tape (history before it replayed in the same chunk, loss only on the last)
  for (let n = 1; n < ev.length; n++) {
    if (!ev[n].score) continue;
    const upTo = ev.slice(0, n + 1).map((e, i) => (i === n ? e : { ...e, score: false }));
    const { loss } = m.trainChunk(new Tape(), grads, upTo, new StateStore(), false);
    const p = fast[scored.indexOf(ev[n])];
    const expected = -(ev[n].y ? Math.log(p) : Math.log(1 - p));
    assert.ok(Math.abs(loss - expected) < 1e-6, `event ${n}: ${loss} vs ${expected}`);
  }
  // chunked: two chunks with state carried between them give the same loss as one
  const st = new StateStore(), t2 = new Tape();
  const a = m.trainChunk(t2, grads, ev.slice(0, 7), st, false), b = m.trainChunk(t2, grads, ev.slice(7), st, false);
  assert.ok(Math.abs(a.loss + b.loss - one.loss) < 1e-9);
  assert.equal(a.count + b.count, one.count);
  assert.equal(grads.every(g => g === 0), true);                              // backward=false adds no gradient
});

test('gradient check through a TBPTT chunk (3 cards, 2 decks) against finite differences', () => {
  const params = noisy(9), m = createOwnModel(params, 's'), ev = eventsFromRows(miniRows());
  const lossOf = (events, store) => m.trainChunk(new Tape(), new Float64Array(params.length), events, store.clone(), false).loss;
  const gradOf = (events, store) => { const g = new Float64Array(params.length); m.trainChunk(new Tape(), g, events, store.clone(), true); return g; };
  const first = new StateStore();
  m.trainChunk(new Tape(), new Float64Array(params.length), ev.slice(0, 6), first, false);   // states carried into chunk 2 (fixed: truncation)
  const cases = [['whole history', ev, new StateStore()], ['second chunk with carried state', ev.slice(6), first]];
  const rng = mulberry32(21), H = 1e-6;
  const off = paramOffsets('s');
  for (const [label, events, store] of cases) {
    const g = gradOf(events, store);
    assert.ok(g.some(x => x !== 0));
    // 4 random numbers from every block, plus every number of the small blocks
    const picks = [];
    for (const p of paramLayout('s')) {
      const { offset, length } = off[p.name];
      if (length <= 16) for (let i = 0; i < length; i++) picks.push(offset + i);
      else for (let r = 0; r < 4; r++) picks.push(offset + Math.floor(rng() * length));
    }
    let worst = 0;
    for (const i of picks) {
      const keep = params[i];
      params[i] = keep + H; const lp = lossOf(events, store);
      params[i] = keep - H; const lm = lossOf(events, store);
      params[i] = keep;
      const numeric = (lp - lm) / (2 * H), err = Math.abs(g[i] - numeric);
      worst = Math.max(worst, err);
      assert.ok(err < 1e-7 + 1e-5 * Math.max(Math.abs(g[i]), Math.abs(numeric)), `${label}: param ${i} analytic ${g[i]} vs numeric ${numeric}`);
    }
    assert.ok(picks.length > 100);
  }
});

test('gradients add into the buffer (two chunks = sum of each)', () => {
  const params = noisy(2), m = createOwnModel(params, 's'), ev = eventsFromRows(miniRows());
  const g1 = new Float64Array(params.length), g2 = new Float64Array(params.length), both = new Float64Array(params.length);
  const tape = new Tape();
  m.trainChunk(tape, g1, ev.slice(0, 8), new StateStore());
  m.trainChunk(tape, g2, ev.slice(0, 8), new StateStore());
  m.trainChunk(tape, both, ev.slice(0, 8), new StateStore()); m.trainChunk(tape, both, ev.slice(0, 8), new StateStore());
  for (let i = 0; i < both.length; i += 37) assert.ok(Math.abs(both[i] - (g1[i] + g2[i])) < 1e-12);
});

test('the prediction ignores the rating, the time taken and the replay flag of the answer being predicted', () => {
  const params = noisy(6), m = createOwnModel(params, 's');
  const base = miniRows(), probe = 9;                                    // the 10th answer
  const predictAt = rows => {
    const feats = new OwnFeatures(), st = new StateStore(), ev = eventsFromRows(rows.slice(0, probe), feats);
    m.predictChunk(ev, st);
    const row = rows[probe], g = feats.gaps(row);
    const dec = m.decayAll({ card: st.cards.get(row.cardKey), note: st.notes.get(row.noteKey), deck: st.decks.get(row.deckKey), user: st.user }, g);
    return pAt(m.headOf(dec, feats.features(row, false)), g.card);
  };
  const p0 = predictAt(base);
  for (const change of [{ rating: 1 }, { rating: 4 }, { ms: 1 }, { ms: 500000 }, { kind: 'replay' }]) {
    const rows = base.map((r, i) => (i === probe ? { ...r, ...change } : r));
    assert.equal(predictAt(rows), p0, JSON.stringify(change));
  }
  // and the tape loss of that answer changes with y only through the target, not the prediction: same p either way
  const feats = new OwnFeatures();
  const ev = eventsFromRows(base.slice(0, probe + 1), feats);
  const f1 = ev[probe].f, qf = new OwnFeatures();
  eventsFromRows(base.slice(0, probe), qf);
  const q = qf.features(base[probe], true);
  for (let i = 0; i < 12; i++) assert.equal(f1[i], q[i]);                 // context part identical in query and answered form
});

test('decay goes toward the starting vector', () => {
  const params = noisy(8), m = createOwnModel(params, 's'), off = paramOffsets('s');
  const h = Float32Array.from({ length: 16 }, (_, i) => 3 * Math.sin(i + 1));
  const h0 = m.initVector('note');
  const dist = d => Math.hypot(...Array.from(m.decayAll({ note: h }, { note: d }).note, (v, i) => v - h0[i]));
  const d0 = dist(0), dists = [0.01, 0.1, 1, 10, 100, 1e5].map(dist);
  assert.ok(Math.abs(d0 - Math.hypot(...Array.from(h, (v, i) => v - h0[i]))) < 1e-6);        // no time, no change
  for (let i = 1; i < dists.length; i++) assert.ok(dists[i] <= dists[i - 1] + 1e-12);
  assert.ok(dists[dists.length - 1] < 1e-6);                                                   // long enough: back at the start
  // each channel by its own time: at dt = tau the distance has shrunk to 1/e
  const th = params[off['note.theta'].offset + 5], tau = Math.exp(th);
  const out = m.decayAll({ note: h }, { note: tau }).note;
  assert.ok(Math.abs((out[5] - h0[5]) - (h[5] - h0[5]) / Math.E) < 1e-6);
  // the card memory never decays, and "no gap" or a never-seen entity leaves things alone
  const c = Float32Array.from({ length: 32 }, (_, i) => i / 10);
  assert.deepEqual(Array.from(m.decayAll({ card: c }, { note: 5, deck: 5, user: 5 }).card), Array.from(c));
  assert.deepEqual(Array.from(m.decayAll({ deck: h }, { deck: null }).deck), Array.from(h));
  assert.deepEqual(Array.from(m.decayAll({}, { user: 7 }).user), Array.from(m.initVector('user')));
});

test('the same tape carries over many chunks without leaking buffers', () => {
  const params = noisy(1), m = createOwnModel(params, 's'), ev = eventsFromRows(miniRows());
  const tape = new Tape(), g = new Float64Array(params.length);
  const l = [];
  for (let r = 0; r < 3; r++) l.push(m.trainChunk(tape, g, ev, new StateStore(), false).loss);
  assert.equal(l[0], l[1]); assert.equal(l[1], l[2]);
  assert.equal(tape.used.length, 0);
});

test('size m also works (smaller checks)', () => {
  const params = noisy(5, 'm'), m = createOwnModel(params, 'm'), ev = eventsFromRows(miniRows());
  assert.equal(sizesOf('m').card, 64);
  const ps = m.predictChunk(ev, new StateStore()), { loss } = m.trainChunk(new Tape(), new Float64Array(params.length), ev, new StateStore(), false);
  const scored = ev.filter(e => e.score), bce = scored.reduce((sum, e, i) => sum - (e.y ? Math.log(ps[i]) : Math.log(1 - ps[i])), 0);
  assert.ok(ps.every(p => p > 0 && p < 1));
  assert.ok(Math.abs(loss - bce) < 1e-6);
});
