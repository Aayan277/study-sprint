import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headFromRaw, pAt, intervalDays, daysForButtons, headFinite } from '../js/own-curve.js';

const single = (a, s, beta) => ({ a, pi: [1, 0, 0], s: [s, 1, 1], beta: [beta, 1, 1] });
const three = { a: 0.95, pi: [0.3, 0.3, 0.4], s: [0.5, 5, 50], beta: [0.8, 0.6, 0.4] };
const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('headFromRaw: ranges, and the mix weights add up to 1', () => {
  for (const raw of [new Array(10).fill(0), [-50, -9, 0, 9, -50, 0, 50, -50, 0, 50], [50, 50, 50, 50, 99, 99, 99, 99, 99, 99]]) {
    const h = headFromRaw(raw);
    assert.ok(h.a >= 0.02 && h.a <= 0.99);
    near(h.pi.reduce((x, y) => x + y, 0), 1, 1e-12);
    assert.ok(headFinite(h));
    for (const k of [0, 1, 2]) { assert.ok(h.s[k] > 0 && Number.isFinite(h.s[k])); assert.ok(h.beta[k] >= 0.1 && Number.isFinite(h.beta[k])); }
  }
  const z = headFromRaw(new Array(10).fill(0));
  near(z.a, 0.02 + 0.97 / 2, 1e-12);
  near(z.pi[0], 1 / 3, 1e-12);
  near(z.s[0], 1, 1e-12);
  near(z.beta[0], 0.1 + Math.log(2), 1e-12);
  const init = headFromRaw([0, 0, 0, 0, Math.log(0.5), Math.log(5), Math.log(50), 0, 0, 0]);
  near(init.s[2], 50, 1e-9);
});

test('pAt: by hand, clamps, and always falling', () => {
  near(pAt(single(0.9, 2, 1), 0), 0.9, 1e-12);
  near(pAt(single(0.9, 2, 1), 2), 0.45, 1e-12);                 // 0.9 * (1 + 1)^-1
  near(pAt(single(0.9, 2, 0.5), 6), 0.9 / 2, 1e-12);            // (1 + 3)^-0.5 = 0.5
  assert.equal(pAt(single(0.9, 2, 1), -5), pAt(single(0.9, 2, 1), 0));
  assert.equal(pAt(single(1, 1, 1), 0), 1 - 1e-4);              // clamped below 1
  assert.equal(pAt(single(0.02, 1, 5), 1e9), 1e-4);             // clamped above 0
  let prev = 2;
  for (let t = 0; t <= 4000; t += 0.7) { const p = pAt(three, t); assert.ok(p <= prev); prev = p; }
});

test('a mix of curves forgets fast first and slowly after', () => {
  const rate = t => Math.log(pAt(three, t) / pAt(three, t + 1));        // how fast it falls around day t, per day
  assert.ok(rate(0) > 5 * rate(10) && rate(10) > 5 * rate(300));
  assert.ok(pAt(three, 400) > 0.05, 'a slow tail remains');
});

test('intervalDays: within 0.01 day of the analytic answer for one power law', () => {
  for (const [a, s, beta, target] of [[0.99, 3, 0.7, 0.5], [0.97, 20, 0.4, 0.6], [0.95, 100, 1.2, 0.4], [0.99, 1, 0.3, 0.5]]) {
    const exact = s * (Math.pow(a / target, 1 / beta) - 1);
    assert.ok(exact > 1 && exact < 36500, 'the case is inside the search range');
    near(intervalDays(single(a, s, beta), target, 36500), exact, 0.01);
    near(pAt(single(a, s, beta), intervalDays(single(a, s, beta), target, 36500)), target, 1e-6);
  }
});

test('intervalDays: limits', () => {
  assert.equal(intervalDays(single(0.8, 100, 0.2), 0.9, 365), 1);            // the ceiling is under the target
  assert.equal(intervalDays(single(0.99, 0.01, 3), 0.9, 365), 1);            // already at or under the target after a day
  assert.equal(intervalDays(single(0.99, 1e6, 0.1), 0.9, 365), 365);         // never reaches the target
  assert.equal(intervalDays(single(0.99, 5, 1), 0.9, 1), 1);
  const d = intervalDays(three, 0.3, 36500);
  assert.ok(d >= 1 && d <= 36500);
  assert.ok(d > 1 && pAt(three, d - 0.01) >= 0.3 - 1e-9 && pAt(three, d + 0.01) <= 0.3 + 1e-9);
  // a higher target never gives a longer interval
  let prev = Infinity;
  for (const target of [0.2, 0.3, 0.4, 0.5]) { const x = intervalDays(three, target, 36500); assert.ok(x <= prev); prev = x; }
});

test('daysForButtons: whole days, in range, Hard <= Good <= Easy', () => {
  const heads = { 2: single(0.99, 10, 0.8), 3: single(0.99, 4, 0.8), 4: single(0.99, 2, 0.8) };   // deliberately in the wrong order
  const out = daysForButtons(heads, 0.5, 365);
  assert.ok(out[2] <= out[3] && out[3] <= out[4]);
  for (const r of [2, 3, 4]) assert.ok(Number.isInteger(out[r]) && out[r] >= 1 && out[r] <= 365);
  assert.equal(out[2], Math.round(intervalDays(heads[2], 0.5, 365)));
  assert.equal(out[3], out[2]);
  const ordered = daysForButtons({ 2: single(0.99, 2, 0.8), 3: single(0.99, 6, 0.8), 4: single(0.99, 20, 0.8) }, 0.5, 365);
  assert.ok(ordered[2] < ordered[3] && ordered[3] < ordered[4]);
  const capped = daysForButtons({ 2: single(0.99, 1e6, 0.1), 3: single(0.99, 1e6, 0.1), 4: single(0.99, 1e6, 0.1) }, 0.9, 30);
  assert.deepEqual(capped, { 2: 30, 3: 30, 4: 30 });
  const low = daysForButtons({ 2: single(0.5, 1, 1), 3: single(0.5, 1, 1), 4: single(0.5, 1, 1) }, 0.9, 30);
  assert.deepEqual(low, { 2: 1, 3: 1, 4: 1 });
});

test('headFinite spots broken heads', () => {
  assert.equal(headFinite(three), true);
  assert.equal(headFinite({ ...three, a: NaN }), false);
  assert.equal(headFinite({ ...three, s: [1, Infinity, 3] }), false);
  assert.equal(headFinite({ ...three, pi: [1, 2] }), false);
  assert.equal(headFinite(null), false);
});
