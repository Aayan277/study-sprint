// Research branch only: the autodiff tape (js/own-grad.js) against the app's plain-loop model (js/own-model.js).
// These were part of tests/own-model.test.js before the app's cleaned-up version of that file was taken from main.
import './own-utc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnModel, initParams, StateStore, eventsFromRows } from '../js/own-model.js';
import { Tape } from '../js/own-grad.js';
import { paramOffsets, paramLayout, sizesOf, paramCount } from '../js/own-spec.js';
import { mulberry32 } from '../js/fsrs-fit.js';
import { miniRows } from './own-mini.mjs';

// small random noise on top of the starting values, so no gradient is exactly zero for a lucky reason
const noisy = (seed = 3, size = 's') => { const p = initParams(size, seed), r = mulberry32(seed + 100); for (let i = 0; i < p.length; i++) p[i] += (r() - 0.5) * 0.3; return p; };

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
