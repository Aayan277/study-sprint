// Using Own's plan inside the scheduler (srs.js rate): the safety band, the 3,650-day cap, every reason a plan is refused (FSRS then
// schedules exactly as before), fuzz, and recallNow. Also the 300 ms freeze and the fall back to FSRS.
// srs.js loads ts-fsrs from a CDN, which Node can't open: tests/sim/loader.mjs points it at a local copy (skipped when it is missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { OWN_BAND_LOW, OWN_BAND_HIGH, OWN_MAX_DAYS, clampOwnDays, planFits, freezePlan, PLAN_MS } from '../js/own-plan.js';

const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
if (!skip) register('./sim/loader.mjs', import.meta.url);
const DAY = 86400000, NOW = new Date(2026, 9, 12, 10).getTime();
const OPTS = { retention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], maxInterval: 36500, fuzz: false };

test('the band and the cap are the written numbers', () => {
  assert.equal(OWN_BAND_LOW, 0.25); assert.equal(OWN_BAND_HIGH, 4); assert.equal(OWN_MAX_DAYS, 3650); assert.equal(PLAN_MS, 300);
});

test('clampOwnDays: inside the band it stays, outside it is held at 0.25x and 4x, never over 3,650 or maxInterval, whole days of at least 1', () => {
  assert.equal(clampOwnDays(30, 20, 36500), 30);
  assert.equal(clampOwnDays(500, 20, 36500), 80);
  assert.equal(clampOwnDays(1, 20, 36500), 5);
  assert.equal(clampOwnDays(100000, 2000, 36500), 3650);          // 4x would be 8000: the cap decides
  assert.equal(clampOwnDays(100000, 2000, 1000), 1000);           // maxInterval is lower than the cap
  assert.equal(clampOwnDays(0.2, 1, 36500), 1);
  assert.equal(clampOwnDays(12.4, 10, 36500), 12);
});

test('planFits: every reason to refuse a plan', () => {
  const plan = { cardId: 'a', lastReview: 100, at: NOW, days: { 2: 5, 3: 9, 4: 14 } }, st = { state: 2, lastReview: 100 };
  assert.equal(planFits(plan, 'a', st, 2, 3, NOW + 1000), true);
  assert.equal(planFits(null, 'a', st, 2, 3, NOW), false);
  assert.equal(planFits(plan, 'b', st, 2, 3, NOW), false);                          // another card
  assert.equal(planFits(plan, 'a', { ...st, lastReview: 99 }, 2, 3, NOW), false);   // the card was reviewed since
  assert.equal(planFits(plan, 'a', st, 2, 3, NOW + 3600000), false);                // an hour old
  assert.equal(planFits(plan, 'a', { ...st, state: 1 }, 2, 3, NOW), false);         // not in review before
  assert.equal(planFits(plan, 'a', st, 3, 3, NOW), false);                          // FSRS sent it to relearning
  assert.equal(planFits(plan, 'a', st, 2, 1, NOW), false);                          // Again: no plan for it
  for (const bad of [NaN, Infinity, 0, -3, undefined]) assert.equal(planFits({ ...plan, days: { ...plan.days, 3: bad } }, 'a', st, 2, 3, NOW), false);
});

test('freezePlan: a plan in time is used; a late plan, a missing plan and an error are all "no plan" and are counted once', async () => {
  const seen = [], settled = p => { seen.push(p); return p && !p.skip ? p : null; };
  const plan = { days: { 2: 3 } };
  assert.deepEqual(await freezePlan(Promise.resolve(plan), settled, 50), plan);
  assert.equal(await freezePlan(new Promise(r => setTimeout(() => r(plan), 200)), settled, 20), null);       // too late: frozen without it
  assert.equal(await freezePlan(Promise.resolve(null), settled, 50), null);
  assert.equal(await freezePlan(Promise.reject(new Error('worker down')), settled, 50), null);
  assert.equal(await freezePlan(Promise.resolve({ skip: true }), settled, 50), null);
  assert.deepEqual(seen, [plan, null, null, null, { skip: true }]);
  assert.equal(await freezePlan(Promise.resolve(plan), () => { throw new Error('x'); }, 50), null);          // even a failing counter cannot break the review
});

test('freezePlan waits at most the freeze time (300 ms by default)', async () => {
  const t = Date.now();
  await freezePlan(new Promise(() => {}), () => null);
  const took = Date.now() - t;
  assert.ok(took >= PLAN_MS - 20 && took < PLAN_MS + 400, `took ${took} ms`);
});

// ---------- inside the scheduler ----------
async function sched() { return import('../js/srs.js'); }
async function reviewCard(rate, opts = OPTS) {
  let st = rate('a', null, 3, opts, NOW - 60 * DAY);                       // new -> learning
  let t = NOW - 60 * DAY;
  for (let i = 0; i < 8 && st.state !== 2; i++) { t = st.due; st = rate('a', st, 3, opts, t); }
  for (let i = 0; i < 2; i++) { t = st.due; st = rate('a', st, 3, opts, t); }
  assert.equal(st.state, 2);
  return st;
}
const planFor = (st, at, days) => ({ cardId: 'a', lastReview: st.lastReview, at, days });

test('no plan: rate is exactly what FSRS gives, and an unused plan changes nothing', { skip }, async () => {
  const { rate } = await sched();
  const st = await reviewCard(rate), now = st.due;
  for (const r of [1, 2, 3, 4]) {
    const plain = rate('a', st, r, OPTS, now);
    assert.deepEqual(rate('a', st, r, { ...OPTS, ownPlan: undefined }, now), plain);
    assert.deepEqual(rate('a', st, r, { ...OPTS, ownPlan: { cardId: 'zzz', lastReview: st.lastReview, at: now, days: { 2: 50, 3: 50, 4: 50 } } }, now), plain);
  }
});

test('a plan sets the gap after Hard, Good and Easy (inside the band); Again stays FSRS; the memory numbers stay FSRS\'s', { skip }, async () => {
  const { rate } = await sched();
  const st = await reviewCard(rate), now = st.due;
  const fsrs = r => rate('a', st, r, OPTS, now);
  const g = fsrs(3).scheduledDays;
  const plan = planFor(st, now, { 2: Math.round(g * 0.6), 3: Math.round(g * 1.5), 4: Math.round(g * 2.5) });
  const own = r => rate('a', st, r, { ...OPTS, ownPlan: plan }, now);
  assert.equal(own(3).scheduledDays, plan.days[3]);
  assert.equal(own(3).due, now + plan.days[3] * DAY);
  assert.equal(own(2).scheduledDays, plan.days[2]); assert.equal(own(4).scheduledDays, plan.days[4]);
  assert.deepEqual(own(1), fsrs(1));
  for (const r of [2, 3, 4]) { assert.equal(own(r).stability, fsrs(r).stability); assert.equal(own(r).difficulty, fsrs(r).difficulty); assert.equal(own(r).reps, fsrs(r).reps); assert.equal(own(r).state, 2); }
});

test('the safety band: Own is held to 0.25x - 4x of FSRS\'s gap, and to 3,650 days', { skip }, async () => {
  const { rate } = await sched();
  const st = await reviewCard(rate), now = st.due;
  const f = rate('a', st, 3, OPTS, now).scheduledDays;
  assert.equal(rate('a', st, 3, { ...OPTS, ownPlan: planFor(st, now, { 2: 1, 3: f * 50, 4: f * 100 }) }, now).scheduledDays, Math.round(f * 4));
  assert.equal(rate('a', st, 3, { ...OPTS, ownPlan: planFor(st, now, { 2: 1, 3: 1, 4: 1 }) }, now).scheduledDays, Math.max(1, Math.round(f * 0.25)));
  const huge = rate('a', st, 3, { ...OPTS, ownPlan: planFor(st, now, { 2: 1e9, 3: 1e9, 4: 1e9 }) }, now).scheduledDays;
  assert.ok(huge <= 3650 && huge <= 4 * f);
  // a lower maxInterval wins over the plan
  assert.ok(rate('a', st, 4, { ...OPTS, maxInterval: 20, ownPlan: planFor(st, now, { 2: 90, 3: 90, 4: 90 }) }, now).scheduledDays <= 20);
});

test('every refusal leaves exactly FSRS\'s result (another card, newer review, old plan, bad numbers, learning card)', { skip }, async () => {
  const { rate } = await sched();
  const st = await reviewCard(rate), now = st.due;
  const days = { 2: 40, 3: 40, 4: 40 };
  const plain = r => rate('a', st, r, OPTS, now);
  const refused = [
    { cardId: 'b', lastReview: st.lastReview, at: now, days }, { cardId: 'a', lastReview: st.lastReview - 1, at: now, days },
    { cardId: 'a', lastReview: st.lastReview, at: now - 3600001, days }, { cardId: 'a', lastReview: st.lastReview, at: now, days: { 2: NaN, 3: NaN, 4: NaN } },
    { cardId: 'a', lastReview: st.lastReview, at: now, days: { 2: -1, 3: 0, 4: Infinity } }, { cardId: 'a', lastReview: st.lastReview, at: now }
  ];
  for (const ownPlan of refused) for (const r of [1, 2, 3, 4]) assert.deepEqual(rate('a', st, r, { ...OPTS, ownPlan }, now), plain(r));
  const learning = rate('a', null, 3, OPTS, now);
  assert.deepEqual(rate('a', learning, 3, { ...OPTS, ownPlan: { cardId: 'a', lastReview: learning.lastReview, at: learning.due, days } }, learning.due), rate('a', learning, 3, OPTS, learning.due));
});

test('with fuzz on, FSRS\'s own fuzz is applied to Own\'s days; the plan is held to the band either way', { skip }, async () => {
  const { rate } = await sched();
  const st = await reviewCard(rate), now = st.due, o = { ...OPTS, fuzz: true };
  const exact = rate('a', st, 3, OPTS, now).scheduledDays;
  const plan = planFor(st, now, { 2: exact * 2, 3: exact * 2, 4: exact * 2 });
  for (let i = 0; i < 20; i++) {
    const d = rate('a', st, 3, { ...o, ownPlan: plan }, now).scheduledDays;
    assert.ok(d >= Math.floor(exact * 2 * 0.8) && d <= Math.ceil(exact * 2 * 1.25) && d <= 4 * exact + 1, `${d} vs ${exact * 2}`);
  }
});

test('preview labels use the plan too (previewIntervals runs rate)', { skip }, async () => {
  const { rate, previewIntervals } = await sched();
  const st = await reviewCard(rate), now = st.due;
  const f = rate('a', st, 3, OPTS, now).scheduledDays;
  const plan = planFor(st, now, { 2: f, 3: f * 2, 4: f * 3 });
  assert.equal(Math.round((await previewIntervals(st, { ...OPTS, ownPlan: plan }, now, 'a'))[3] / DAY), f * 2);
});

test('recallNow is the FSRS forgetting curve at this moment, with the owner\'s own decay', { skip }, async () => {
  const { recallNow } = await sched();
  const { recall } = await import('../js/exam.js');
  const st = { stability: 12, lastReview: NOW - 9 * DAY, state: 2 };
  assert.equal(recallNow(st, OPTS, NOW), recall(12, 9));
  const w = Array.from({ length: 21 }, (_, i) => (i === 20 ? 0.3 : 1));
  assert.equal(recallNow(st, { ...OPTS, w }, NOW), recall(12, 9, 0.3));
  assert.notEqual(recallNow(st, { ...OPTS, w }, NOW), recallNow(st, OPTS, NOW));
  assert.equal(recallNow(null, OPTS, NOW), null); assert.equal(recallNow({ stability: 0 }, OPTS, NOW), null);
  const p = recallNow(st, OPTS, NOW); assert.ok(p > 0 && p < 1);
});
