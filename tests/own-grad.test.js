import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tape, Adam, clipGlobalNorm, globalNorm, cosineLr } from '../js/own-grad.js';
import { mulberry32 } from '../js/fsrs-fit.js';

const H = 1e-6, TOL = 1e-5, FLOOR = 1e-4;
const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), FLOOR);

// Finite-difference check. `inputs` are arrays of numbers; `build(tape, vars)` returns the output Var of the op under test.
// The loss is sum(out * w) with fixed random w, so every output number gets a different pull on its inputs.
function check(name, inputs, build, seed = 7) {
  const rng = mulberry32(seed);
  const run = (values, grads) => {
    const tape = new Tape();
    const vars = values.map((v, i) => tape.param(v, grads[i]));
    const out = build(tape, vars);
    const w = Float64Array.from({ length: out.n }, () => rng() * 2 - 1);
    const loss = tape.sum(tape.mul(out, tape.constant(w)));
    tape.backward(loss);
  };
  const vals = inputs.map(a => Float64Array.from(a));
  const grads = vals.map(v => new Float64Array(v.length));
  run(vals, grads);
  let checked = 0, worst = 0;
  vals.forEach((v, k) => {
    for (let i = 0; i < v.length; i++) {
      const keep = v[i];
      v[i] = keep + H; const plus = runSeeded(vals, build, seed);
      v[i] = keep - H; const minus = runSeeded(vals, build, seed);
      v[i] = keep;
      const numeric = (plus - minus) / (2 * H);
      const e = relErr(grads[k][i], numeric);
      worst = Math.max(worst, e);
      assert.ok(e < TOL, `${name}: input ${k}[${i}] analytic ${grads[k][i]} vs numeric ${numeric} (relative error ${e})`);
      checked++;
    }
  });
  assert.ok(checked > 0);
  return worst;
}
function runSeeded(vals, build, seed) {
  const rng = mulberry32(seed);
  const tape = new Tape();
  const vars = vals.map(v => tape.param(v, new Float64Array(v.length)));
  const out = build(tape, vars);
  const w = Float64Array.from({ length: out.n }, () => rng() * 2 - 1);
  return tape.sum(tape.mul(out, tape.constant(w))).v[0];
}

const rng = mulberry32(12345);
const rand = (n, lo = -1, hi = 1) => Array.from({ length: n }, () => lo + (hi - lo) * rng());

test('matvec', () => { check('matvec', [rand(12), rand(4)], (t, [W, x]) => t.matvec(W, x, 3, 4)); });
test('add, sub, mul, div (same length)', () => {
  check('add', [rand(5), rand(5)], (t, [a, b]) => t.add(a, b));
  check('sub', [rand(5), rand(5)], (t, [a, b]) => t.sub(a, b));
  check('mul', [rand(5), rand(5)], (t, [a, b]) => t.mul(a, b));
  check('div', [rand(5), rand(5, 0.5, 2)], (t, [a, b]) => t.div(a, b));
});
test('binary ops with one single number used for all', () => {
  check('add scalar', [rand(5), rand(1)], (t, [a, b]) => t.add(a, b));
  check('add scalar first', [rand(1), rand(5)], (t, [a, b]) => t.add(a, b));
  check('sub scalar', [rand(5), rand(1)], (t, [a, b]) => t.sub(a, b));
  check('mul scalar', [rand(1), rand(5)], (t, [a, b]) => t.mul(a, b));
  check('div scalar', [rand(5), rand(1, 0.5, 2)], (t, [a, b]) => t.div(a, b));
  check('div by vector', [rand(1), rand(5, 0.5, 2)], (t, [a, b]) => t.div(a, b));
  check('pow scalar exponent', [rand(5, 0.5, 2), rand(1)], (t, [a, b]) => t.pow(a, b));
  check('same var twice', [rand(4)], (t, [a]) => t.mul(a, a));
  assert.throws(() => check('bad', [rand(3), rand(4)], (t, [a, b]) => t.add(a, b)), /shape mismatch/);
});
test('pow', () => { check('pow', [rand(6, 0.5, 2), rand(6, -1.5, 1.5)], (t, [a, b]) => t.pow(a, b)); });
test('scale (c * a + d)', () => { check('scale', [rand(5)], (t, [a]) => t.scale(a, -2.5, 0.7)); });
test('sigmoid', () => { check('sigmoid', [rand(6, -4, 4)], (t, [a]) => t.sigmoid(a)); });
test('tanh', () => { check('tanh', [rand(6, -3, 3)], (t, [a]) => t.tanh(a)); });
test('exp', () => { check('exp', [rand(6, -2, 2)], (t, [a]) => t.exp(a)); });
test('log1p', () => { check('log1p', [rand(6, -0.5, 3)], (t, [a]) => t.log1p(a)); });
test('softplus', () => {
  check('softplus', [rand(6, -5, 5)], (t, [a]) => t.softplus(a));
  const t = new Tape();
  assert.ok(Math.abs(t.softplus(t.constant([50])).v[0] - 50) < 1e-9);        // no overflow for big inputs
});
test('softmax', () => {
  check('softmax', [rand(5, -3, 3)], (t, [a]) => t.softmax(a));
  const t = new Tape(), s = t.softmax(t.constant([1000, 1001, 999]));
  assert.ok(Math.abs(s.v[0] + s.v[1] + s.v[2] - 1) < 1e-12 && s.v.every(Number.isFinite));    // no overflow for big inputs
});
test('concat and slice', () => {
  check('concat', [rand(3), rand(1), rand(4)], (t, [a, b, c]) => t.concat([a, b, c]));
  check('slice', [rand(8)], (t, [a]) => t.slice(a, 2, 4));
  check('slice then concat', [rand(6)], (t, [a]) => t.concat([t.slice(a, 3, 3), t.slice(a, 0, 3), t.slice(a, 2, 2)]));   // overlapping slices add up
  assert.throws(() => new Tape().slice(new Tape().constant([1, 2]), 1, 5), /out of range/);
});
test('sum', () => { check('sum', [rand(7)], (t, [a]) => t.sum(a)); });
test('clamp: the real slope', () => {
  check('clamp', [rand(8, -1, 1).map(x => (Math.abs(Math.abs(x) - 0.5) < 1e-3 ? x + 0.01 : x))], (t, [a]) => t.clamp(a, -0.5, 0.5));
  const t = new Tape(), a = t.param(Float64Array.from([-2, 0, 2]), new Float64Array(3)), out = t.clamp(a, -1, 1);
  assert.deepEqual(Array.from(out.v), [-1, 0, 1]);
  out.g.set([1, 1, 1]); t.nodes.forEach(n => n());
  assert.deepEqual(Array.from(a.g), [0, 1, 0]);
});
test('clampThrough: values are limited, the gradient passes straight through', () => {
  const t = new Tape(), a = t.param(Float64Array.from([-2, 0, 2]), new Float64Array(3)), out = t.clampThrough(a, -1, 1);
  assert.deepEqual(Array.from(out.v), [-1, 0, 1]);
  out.g.set([0.5, 2, -3]); t.nodes.forEach(n => n());
  assert.deepEqual(Array.from(a.g), [0.5, 2, -3]);
  check('clampThrough inside the range', [rand(5, -0.4, 0.4)], (tp, [x]) => tp.clampThrough(x, -0.5, 0.5));
});
test('bce', () => {
  const y = [1, 0, 1, 0, 1];
  const rng2 = mulberry32(5);
  const p = Array.from({ length: 5 }, () => 0.05 + 0.9 * rng2());
  const tape = new Tape();
  const pv = tape.param(Float64Array.from(p), new Float64Array(5));
  const loss = tape.bce(pv, y);
  const hand = -y.reduce((s, yi, i) => s + yi * Math.log(p[i]) + (1 - yi) * Math.log(1 - p[i]), 0);
  assert.ok(Math.abs(loss.v[0] - hand) < 1e-12);
  tape.backward(loss);
  for (let i = 0; i < 5; i++) assert.ok(Math.abs(pv.g[i] - (p[i] - y[i]) / (p[i] * (1 - p[i]))) < 1e-9);
  // finite differences on the loss directly (bce already returns one number)
  for (let i = 0; i < 5; i++) {
    const f = d => { const q = p.slice(); q[i] += d; return new Tape().bce(new Tape().constant(Float64Array.from(q)), y).v[0]; };
    assert.ok(relErr(pv.g[i], (f(H) - f(-H)) / (2 * H)) < TOL);
  }
  // p of exactly 0 or 1 does not give infinity
  const edge = new Tape().bce(new Tape().constant([0, 1]), [1, 0]);
  assert.ok(Number.isFinite(edge.v[0]));
  assert.throws(() => new Tape().bce(new Tape().constant([0.5]), [1, 0]), /same length/);
});

test('a whole small cell and curve head, end to end (gate, candidate, mix of power laws, bce)', () => {
  const n = 3, nin = 5;
  const inputs = [rand(n * nin), rand(n), rand(n * nin), rand(n), rand(nin), rand(n), rand(3 * n), rand(3)];
  const build = (t, [Wz, bz, Wc, bc, x, h, W2, b2]) => {
    const z = t.sigmoid(t.add(t.matvec(Wz, x, n, nin), bz));
    const c = t.tanh(t.add(t.matvec(Wc, x, n, nin), bc));
    const hNew = t.add(t.mul(t.scale(z, -1, 1), h), t.mul(z, c));            // (1 - z) * h + z * c
    const raw = t.add(t.matvec(W2, hNew, 3, n), b2);                 // 3 raw numbers
    const pi = t.softmax(raw);
    const s = t.exp(t.scale(t.slice(raw, 0, 3), 0.5));
    const beta = t.scale(t.softplus(raw), 1, 0.1);
    const decay = t.pow(t.add(t.scale(t.div(t.constant([2, 2, 2]), s), 1, 1), t.constant([0, 0, 0])), t.scale(beta, -1));
    const p = t.scale(t.sum(t.mul(pi, decay)), 0.9);
    return t.bce(t.clamp(t.concat([p]), 1e-4, 1 - 1e-4), [1]);
  };
  check('cell+head', inputs, build);
});

test('the arena gives the same results as fresh buffers, also after a differently shaped graph', () => {
  const W = Float64Array.from(rand(12)), x = Float64Array.from(rand(4)), bias = Float64Array.from(rand(3));
  const go = tape => {
    const gW = new Float64Array(12), gx = new Float64Array(4), gb = new Float64Array(3);
    const out = tape.softmax(tape.add(tape.matvec(tape.param(W, gW), tape.param(x, gx), 3, 4), tape.param(bias, gb)));
    const loss = tape.bce(tape.slice(out, 0, 2), [1, 0]);
    tape.backward(loss);
    return JSON.stringify([loss.v[0], Array.from(gW), Array.from(gx), Array.from(gb)]);
  };
  const fresh = go(new Tape());
  const reused = new Tape();
  assert.equal(go(reused), fresh);
  reused.reset();
  // a different graph in between, to leave junk in the recycled buffers
  const junk = reused.exp(reused.constant(rand(3, 1, 5)));
  reused.sum(reused.concat([junk, reused.constant(rand(9))]));
  reused.reset();
  assert.equal(go(reused), fresh);
  reused.reset();
  assert.equal(go(reused), fresh);
  reused.reset();
  const sizeBefore = [...reused.pool.values()].reduce((s, l) => s + l.length, 0);
  go(reused); reused.reset();
  assert.equal([...reused.pool.values()].reduce((s, l) => s + l.length, 0), sizeBefore, 'buffers are reused, not grown');
});

test('gradients add up across several backward passes into the same param gradient', () => {
  const w = Float64Array.from([0.3, -0.2]), g = new Float64Array(2);
  const tape = new Tape();
  for (let k = 0; k < 3; k++) {
    const wv = tape.param(w, g);
    tape.backward(tape.sum(tape.mul(wv, tape.constant([1, 2]))));
    tape.reset();
  }
  assert.deepEqual(Array.from(g), [3, 6]);
  assert.throws(() => new Tape().backward(new Tape().constant([1, 2])), /single number/);
});

test('globalNorm and clipGlobalNorm', () => {
  const a = Float64Array.from([3, 0]), b = Float64Array.from([0, 4]);
  assert.equal(globalNorm([a, b]), 5);
  assert.equal(clipGlobalNorm([a, b], 10), 5);
  assert.deepEqual([Array.from(a), Array.from(b)], [[3, 0], [0, 4]]);      // under the limit: unchanged
  assert.equal(clipGlobalNorm([a, b], 1), 5);                               // returns the length before
  assert.ok(Math.abs(globalNorm([a, b]) - 1) < 1e-12);
  assert.ok(Math.abs(a[0] / b[1] - 0.75) < 1e-12, 'same direction');
  const z = new Float64Array(3);
  assert.equal(clipGlobalNorm(z, 1), 0);
  assert.deepEqual(Array.from(z), [0, 0, 0]);
});

test('Adam converges on a quadratic', () => {
  const target = Float64Array.from([1, -2, 3, 0.5]);
  const p = new Float64Array(4), grad = new Float64Array(4), opt = new Adam(4, { lr: 0.1 });
  for (let i = 0; i < 600; i++) { for (let k = 0; k < 4; k++) grad[k] = 2 * (p[k] - target[k]); opt.step(p, grad); }
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(p[k] - target[k]) < 1e-3, `p[${k}] = ${p[k]}`);
});

test('Adam through the tape: fits a tiny logistic regression', () => {
  const data = Array.from({ length: 40 }, (_, i) => { const x = (i - 20) / 5; return { x, y: x + 0.3 > 0 ? 1 : 0 }; });
  const w = Float64Array.from([0, 0]), g = new Float64Array(2), opt = new Adam(2, { lr: 0.05 }), tape = new Tape();
  const lossAt = () => {
    g.fill(0);
    let total = 0;
    for (const { x, y } of data) {
      const wv = tape.param(w, g);
      const p = tape.sigmoid(tape.add(tape.mul(tape.slice(wv, 0, 1), tape.constant([x])), tape.slice(wv, 1, 1)));
      const loss = tape.bce(p, [y]);
      tape.backward(loss); total += loss.v[0];
    }
    tape.reset();
    return total;
  };
  const first = lossAt();
  for (let i = 0; i < 300; i++) { lossAt(); opt.step(w, g); }
  assert.ok(lossAt() < first / 5, `${lossAt()} vs ${first}`);
  assert.ok(w[0] > 1, 'positive slope');
});

test('Adam: the first step has size lr, and the first-step bias correction is exact', () => {
  const p = Float64Array.from([0, 0]), opt = new Adam(2, { lr: 0.01 });
  opt.step(p, Float64Array.from([5, -0.001]));
  assert.ok(Math.abs(p[0] + 0.01) < 1e-6 && Math.abs(p[1] - 0.01) < 1e-4);
});

test('Adam: the L2 leash pulls toward the anchor (and toward 0 without one)', () => {
  const anchor = Float64Array.from([1, -1, 2]);
  const p = Float64Array.from([5, 5, 5]), zero = new Float64Array(3), opt = new Adam(3, { lr: 0.05, l2: 1, anchor });
  for (let i = 0; i < 2000; i++) opt.step(p, zero);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k] - anchor[k]) < 0.01, `p[${k}] = ${p[k]}`);
  const q = Float64Array.from([5, 5, 5]), plain = new Adam(3, { lr: 0.05, l2: 1 });
  for (let i = 0; i < 2000; i++) plain.step(q, zero);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(q[k]) < 0.01);
  // a stronger leash keeps the fit closer to the anchor when the data pulls the other way
  const fit = l2 => {
    const w = Float64Array.from([0]), o = new Adam(1, { lr: 0.02, l2, anchor: [0] }), gr = new Float64Array(1);
    for (let i = 0; i < 1500; i++) { gr[0] = 2 * (w[0] - 4); o.step(w, gr); }
    return w[0];
  };
  assert.ok(fit(0) > fit(0.5) && fit(0.5) > fit(5) && fit(5) > 0);
  assert.throws(() => new Adam(2, { anchor: [1] }), /anchor length/);
});

test('Adam: clipping by global norm, and the caller gradient is left alone', () => {
  const run = clip => {
    const p = Float64Array.from([0, 0]), opt = new Adam(2, { lr: 0.1, clip });
    const huge = Float64Array.from([300, 400]);
    const norm1 = opt.step(p, huge);
    assert.equal(norm1, 500);                                   // the norm before clipping
    assert.deepEqual(Array.from(huge), [300, 400]);             // untouched
    opt.step(p, Float64Array.from([0.3, 0.4]));
    return Array.from(p);
  };
  assert.deepEqual(run(1000), run(Infinity));                   // a limit above the norm changes nothing
  assert.notDeepEqual(run(1), run(Infinity));                   // a small limit changes the path (the second step now counts for more)
});

test('Adam state can be saved and loaded', () => {
  const a = new Adam(2, { lr: 0.1 }), p = Float64Array.from([1, 2]);
  a.step(p, Float64Array.from([0.5, -0.5])); a.step(p, Float64Array.from([0.1, 0.2]));
  const b = new Adam(2, { lr: 0.1 }); b.loadState(JSON.parse(JSON.stringify(a)));
  const p1 = Float64Array.from(p), p2 = Float64Array.from(p), g = Float64Array.from([0.3, 0.3]);
  a.step(p1, g); b.step(p2, g);
  assert.deepEqual(Array.from(p1), Array.from(p2));
});

test('cosineLr falls from lr0 to lr1', () => {
  assert.equal(cosineLr(0, 100, 3e-3, 3e-4), 3e-3);
  assert.ok(Math.abs(cosineLr(100, 100, 3e-3, 3e-4) - 3e-4) < 1e-15);
  assert.ok(Math.abs(cosineLr(50, 100, 3e-3, 3e-4) - 1.65e-3) < 1e-12);
  assert.equal(cosineLr(500, 100, 3e-3, 3e-4), cosineLr(100, 100, 3e-3, 3e-4));
});
