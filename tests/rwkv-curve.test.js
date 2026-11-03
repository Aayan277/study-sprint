import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pCurve, pImm, pRating, intervalSeconds, daysForButtons } from '../js/rwkv-curve.js';

// one power curve: R(t) = (1 + t/S)^-d, the other two get no weight
const power = (S, d) => ({ w: [30, -30, -30], s: [Math.log(S), 0, 0], d: [Math.log(d), 0, 0], p: [0, 0, 0, 0] });
const DAY = 86400;
const lift = x => 1e-5 + (1 - 2e-5) * x;
const analytic = (S, d, target) => S * (((target - 1e-5) / (1 - 2e-5)) ** (-1 / d) - 1);

test('a single power curve gives the formula', () => {
  const h = power(10 * DAY, 0.5);
  for (const t of [1, 600, DAY, 10 * DAY, 400 * DAY]) assert.ok(Math.abs(pCurve(h, t) - lift((1 + t / (1e-7 + 10 * DAY)) ** -0.5)) < 1e-9);
});

test('a mixture is the weighted average of its curves', () => {
  const h = { w: [Math.log(3), Math.log(1), -30], s: [Math.log(DAY), Math.log(30 * DAY), 0], d: [0, Math.log(0.3), 0], p: [0, 0, 0, 0] };
  const t = 5 * DAY;
  const want = lift(0.75 * (1 + t / DAY) ** -1 + 0.25 * (1 + t / (30 * DAY)) ** -0.3);
  assert.ok(Math.abs(pCurve(h, t) - want) < 1e-7);
});

test('the curve never goes up, starts near 1 and is clamped', () => {
  const h = power(3 * DAY, 0.7);
  let prev = 2;
  for (let t = 1; t < 1e9; t *= 1.7) { const p = pCurve(h, t); assert.ok(p <= prev + 1e-12 && p >= 1e-5 && p <= 1 - 1e-5 + 1e-12); prev = p; }
  assert.ok(pCurve(h, 1) > 0.999);
  assert.equal(pCurve(h, 0), pCurve(h, 1));                       // times below one second count as one second
  assert.equal(pCurve({ ...h, s: [-100, 0, 0] }, 5), pCurve({ ...h, s: [-25, 0, 0] }, 5));   // the scale is clamped
});

test('rating chances add up to one and pImm is one minus Again', () => {
  const h = { p: [1, 0.5, 2, -1] };
  const r = pRating(h);
  assert.ok(Math.abs(r.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(pImm(h) - (1 - r[0])) < 1e-12);
  assert.equal(pImm({ p: [-100, 0, 0, 0] }), 1 - 1e-5);
  assert.equal(pImm({ p: [100, 0, 0, 0] }), 1e-5);
});

test('the interval found by bisection is within a second of the exact answer', () => {
  for (const [S, d, target] of [[10 * DAY, 0.5, 0.9], [3 * DAY, 0.8, 0.85], [200 * DAY, 0.3, 0.95], [DAY, 1.2, 0.7]]) {
    const got = intervalSeconds(power(S, d), target, 36500 * DAY);
    assert.ok(Math.abs(got - analytic(S, d, target)) < 1, `${S} ${d} ${target}: ${got} vs ${analytic(S, d, target)}`);
  }
});

test('intervalSeconds: limits', () => {
  const slow = power(1e9 * DAY, 0.01);
  assert.equal(intervalSeconds(slow, 0.9, 100 * DAY), 100 * DAY);        // never drops that far: the maximum
  const fast = power(1, 5);
  assert.equal(intervalSeconds(fast, 0.9, 100 * DAY), 60);               // already below at one minute: the minimum
  assert.equal(intervalSeconds(power(DAY, 1), 0.9, 30), 30);              // a maximum below the minimum is returned as is
});

test('buttons: whole days, between 1 and the maximum, never decreasing', () => {
  const curves = { 1: power(0.1 * DAY, 1), 2: power(10 * DAY, 0.5), 3: power(30 * DAY, 0.5), 4: power(100 * DAY, 0.5) };
  const d = daysForButtons(curves, 0.9, 365);
  assert.ok(d[2] >= 1 && d[2] <= d[3] && d[3] <= d[4] && d[4] <= 365);
  assert.equal(d[3], Math.round(analytic(30 * DAY, 0.5, 0.9) / DAY));
  assert.deepEqual(daysForButtons(curves, 0.9, 5), { 2: 2, 3: 5, 4: 5 });     // Hard is 2.3 days; the others are cut at the maximum
  // Good worse than Hard is lifted to Hard, Easy worse than Good to Good
  const odd = { 1: curves[1], 2: power(50 * DAY, 0.5), 3: power(5 * DAY, 0.5), 4: power(2 * DAY, 0.5) };
  const o = daysForButtons(odd, 0.9, 3650);
  assert.ok(o[3] === o[2] && o[4] === o[3]);
  const tiny = daysForButtons({ 1: curves[1], 2: power(1, 5), 3: power(1, 5), 4: power(1, 5) }, 0.9, 365);
  assert.deepEqual(tiny, { 2: 1, 3: 1, 4: 1 });
});
