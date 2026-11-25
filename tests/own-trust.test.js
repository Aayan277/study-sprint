// The trust test (opt-in experiment): the trust rule (own-plan.js, applied in srs.js rate()), the arms (own-trust.js), the results table,
// and the engine room's switch (own-core.js setTrust). Like own-plan.test.js, rate() needs ts-fsrs (see tests/sim/loader.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { dayStart } from '../js/days.js';
import { TRUST_RATIO, trustUsesOwn, planFits, clampOwnDays, orderOwnDays } from '../js/own-plan.js';
import { trustArm, trustEligible, trustArmFor, trustAvailable, trustResults } from '../js/own-trust.js';

const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
if (!skip) register('./sim/loader.mjs', import.meta.url);
const DAY = 86400000, NOW = new Date(2026, 9, 12, 10).getTime();
const OPTS = { retention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], maxInterval: 36500, fuzz: false };
const TOOLS = { planFits, clampOwnDays, orderOwnDays, trustUsesOwn };

test('trustUsesOwn: Own only when it is more than the square root of 2 times FSRS, or after a lapse', () => {
  assert.equal(TRUST_RATIO, Math.SQRT2);
  assert.equal(trustUsesOwn(false, 14, 10), false);          // 1.4x is not enough
  assert.equal(trustUsesOwn(false, 14.2, 10), true);         // 1.42x is
  assert.equal(trustUsesOwn(false, 5, 10), false);           // shorter than FSRS: never
  assert.equal(trustUsesOwn(false, 10 * Math.SQRT2, 10), false);   // exactly the ratio is not "more than"
  assert.equal(trustUsesOwn(true, 3, 10), true);             // after a lapse Own's gap is used even when it is shorter
});

test('planFits: a relearning card fits only in trust mode, and only when FSRS moves it back to review', () => {
  const st = { lastReview: 5, state: 3 }, plan = { cardId: 'a', lastReview: 5, at: NOW, days: { 2: 3, 3: 4, 4: 5 } };
  assert.equal(planFits(plan, 'a', st, 2, 3, NOW), false);
  assert.equal(planFits(plan, 'a', st, 2, 3, NOW, false), false);
  assert.equal(planFits(plan, 'a', st, 2, 3, NOW, true), true);
  assert.equal(planFits(plan, 'a', st, 3, 2, NOW, true), false, 'Hard that stays in relearning stays FSRS');
  assert.equal(planFits(plan, 'a', st, 2, 1, NOW, true), false, 'Again is untouched');
  assert.equal(planFits(plan, 'a', { ...st, state: 1 }, 2, 3, NOW, true), false, 'a learning card is untouched');
  assert.equal(planFits(plan, 'a', { ...st, state: 2 }, 2, 3, NOW, true), true);
});

test('arms: stable, by the hash of the card id, and about half and half', () => {
  const ids = Array.from({ length: 10000 }, (_, i) => 'card-' + i);
  const arms = ids.map(trustArm);
  assert.deepEqual(ids.map(trustArm), arms);
  const trust = arms.filter(a => a === 'trust').length;
  assert.ok(trust > 4700 && trust < 5300, `trust arm has ${trust} of 10000`);
  assert.ok(arms.every(a => a === 'trust' || a === 'fsrs'));
  assert.equal(trustArm(123), trustArm('123'));
});

test('who is in the test: FSRS-6 at 90% only (the deck can have its own retention); arm null otherwise', () => {
  const s = { fsrsVersion: 6, targetRetention: 0.9 };
  assert.equal(trustEligible(s, null), true);
  assert.equal(trustEligible({}, null), true, 'the default is FSRS-6 at 90%');
  assert.equal(trustEligible({ ...s, fsrsVersion: 7 }, null), false);
  assert.equal(trustEligible({ ...s, targetRetention: 0.85 }, null), false);
  assert.equal(trustEligible(s, { options: { targetRetention: 0.8 } }), false);
  assert.equal(trustEligible({ ...s, targetRetention: 0.8 }, { options: { targetRetention: 0.9 } }), true);
  assert.equal(trustArmFor({ on: false }, s, null, 'x'), null);
  assert.equal(trustArmFor(null, s, null, 'x'), null);
  assert.equal(trustArmFor({ on: true }, { ...s, fsrsVersion: 7 }, null, 'x'), null);
  assert.equal(trustArmFor({ on: true }, s, null, 'x'), trustArm('x'));
  assert.equal(trustAvailable(s, []), true);
  assert.equal(trustAvailable({ ...s, targetRetention: 0.8 }, []), false);
  assert.equal(trustAvailable({ ...s, targetRetention: 0.8 }, [{ options: { targetRetention: 0.9 } }]), true);
  assert.equal(trustAvailable({ ...s, fsrsVersion: 7 }, [{ options: { targetRetention: 0.9 } }]), false);
});

// ---------- inside the scheduler ----------
async function sched() {
  const m = await import('../js/srs.js');
  m.useOwnPlan(TOOLS);
  return m;
}
async function reviewCard(rate, opts = OPTS) {
  let st = rate('a', null, 3, opts, NOW - 60 * DAY), t = NOW - 60 * DAY;
  for (let i = 0; i < 8 && st.state !== 2; i++) { t = st.due; st = rate('a', st, 3, opts, t); }
  for (let i = 0; i < 2; i++) { t = st.due; st = rate('a', st, 3, opts, t); }
  assert.equal(st.state, 2);
  return st;
}
const planFor = (st, at, days) => ({ cardId: 'a', lastReview: st.lastReview, at, days, trust: true });

test('rate in trust mode: FSRS keeps its gap unless Own is more than sqrt 2 times longer (each button on its own); the clamp still applies', { skip }, async () => {
  const { rate } = await sched();
  const st = await reviewCard(rate), now = st.due;
  const f = r => rate('a', st, r, OPTS, now).scheduledDays;
  const f2 = f(2), f3 = f(3), f4 = f(4);
  // Hard: Own a bit above FSRS (1.2x): FSRS stays. Good: Own at 1.6x: Own. Easy: Own shorter: FSRS stays.
  const days = { 2: f2 * 1.2, 3: f3 * 1.6, 4: f4 * 0.5 };
  const plan = planFor(st, now, days), own = r => rate('a', st, r, { ...OPTS, ownPlan: plan, ownTrust: true }, now);
  assert.equal(own(3).scheduledDays, Math.round(f3 * 1.6));
  assert.equal(own(3).due, now + Math.round(f3 * 1.6) * DAY);
  assert.equal(own(2).scheduledDays, f2);
  assert.equal(own(4).scheduledDays, Math.max(f4, Math.round(f3 * 1.6) + 1), 'Easy is FSRS\'s, kept after Good by the usual order');
  assert.deepEqual(rate('a', st, 1, { ...OPTS, ownPlan: plan, ownTrust: true }, now), rate('a', st, 1, OPTS, now), 'Again is FSRS');
  // nothing above the ratio: exactly FSRS for every button
  const calm = planFor(st, now, { 2: f2 * 1.3, 3: f3 * 1.4, 4: f4 * 0.9 });
  for (const r of [1, 2, 3, 4]) assert.deepEqual(rate('a', st, r, { ...OPTS, ownPlan: calm, ownTrust: true }, now), rate('a', st, r, OPTS, now));
  // the plan is ignored without the trust flag when the card is in review the usual way (full Own uses all three)
  assert.equal(rate('a', st, 2, { ...OPTS, ownPlan: calm }, now).scheduledDays, Math.round(f2 * 1.3));
  // the clamp: 4x of FSRS at most, and the arithmetic of the usual band
  const wild = planFor(st, now, { 2: 1e9, 3: 1e9, 4: 1e9 });
  assert.equal(rate('a', st, 3, { ...OPTS, ownPlan: wild, ownTrust: true }, now).scheduledDays, Math.min(3650, Math.round(f3 * 4)));
  // previews show what is saved
  const o = { ...OPTS, ownPlan: plan, ownTrust: true };
  const { previewIntervals } = await import('../js/srs.js');
  const lab = previewIntervals(st, o, now, 'a');
  for (const r of [2, 3, 4]) assert.equal(lab[r], rate('a', st, r, { ...o, fuzz: false }, now).due - now);
});

test('rate in trust mode after a lapse: Own\'s clamped gap is used for Good and Easy; Again and a Hard that stays in relearning are FSRS\'s', { skip }, async () => {
  const { rate } = await sched();
  const st = await reviewCard(rate);
  const lapsed = rate('a', st, 1, OPTS, st.due);                 // forgot it: relearning
  assert.equal(lapsed.state, 3);
  const now = lapsed.due;
  const f = r => rate('a', lapsed, r, OPTS, now);
  assert.equal(f(3).state, 2);
  const g = f(3).scheduledDays;
  // Own plans shorter than FSRS, but after a lapse Own's gap is used (inside 0.25x - 4x)
  const days = { 2: g, 3: Math.max(1, Math.round(g * 0.5)), 4: g * 3 };
  const plan = { cardId: 'a', lastReview: lapsed.lastReview, at: now, days, trust: true };
  const own = (r, trust = true) => rate('a', lapsed, r, { ...OPTS, ownPlan: plan, ownTrust: trust }, now);
  assert.equal(own(3).scheduledDays, clampOwnDays(days[3], g, 36500));
  assert.equal(own(3).state, 2);
  assert.equal(own(4).scheduledDays, Math.max(clampOwnDays(days[4], f(4).scheduledDays, 36500), own(3).scheduledDays + 1));
  assert.deepEqual(own(1), f(1));
  // without the trust flag a relearning card is never planned
  for (const r of [1, 2, 3, 4]) assert.deepEqual(own(r, false), f(r));
  // a Hard that stays in relearning is FSRS's own
  if (f(2).state === 3) assert.deepEqual(own(2), f(2));
});

test('rate in trust mode: with fuzz and evening out the three labels are the saved days, in order', { skip }, async () => {
  const { rate, previewIntervals } = await sched();
  const st = await reviewCard(rate, { ...OPTS, fuzz: true }), now = st.due;
  const base = { ...OPTS, fuzz: true, balance: { load: new Map(), easyDays: [] } };
  const exact = r => rate('a', st, r, { ...OPTS }, now).scheduledDays;
  const plan = planFor(st, now, { 2: exact(2) * 2, 3: exact(3) * 2, 4: exact(4) * 2 });
  const o = { ...base, ownPlan: plan, ownTrust: true };
  for (const opts of [o, { ...o, balance: undefined }]) {
    const lab = previewIntervals(st, opts, now, 'a');
    assert.ok(lab[2] < lab[3] && lab[3] < lab[4], JSON.stringify(lab));
    for (const r of [2, 3, 4]) assert.ok(rate('a', st, r, opts, now).scheduledDays >= exact(r));
  }
});

// ---------- the results table ----------
test('trustResults: per arm, cards, reviews, pass rate on scheduled reviews and reviews per card per week since the start', () => {
  const since = NOW - 14 * DAY, due = t => dayStart(t);
  const L = (arm, cardId, daysAgo, rating, over = {}) => ({ source: 'review', arm, cardId, timestamp: NOW - daysAgo * DAY, rating, state: 2, due: NOW - daysAgo * DAY - DAY, ...over });
  const logs = [
    L('trust', 'a', 10, 3), L('trust', 'a', 3, 1), L('trust', 'b', 2, 4), L('trust', 'b', 1, 2, { due: NOW + 5 * DAY }),   // the last one is early: not scheduled
    L('trust', 'c', 1, 3, { state: 3 }),                                                      // a relearning step: a review, not a scheduled one
    L('fsrs', 'd', 12, 3), L('fsrs', 'd', 4, 3), L('fsrs', 'e', 3, 1),
    L('fsrs', 'f', 20, 3),                                                                       // before the start
    L(undefined, 'g', 2, 3), { ...L('trust', 'h', 2, 3), source: 'play' }                       // not in the test / not a review
  ];
  const r = trustResults(logs, { since, until: null }, NOW);
  assert.equal(r.days, 14);
  assert.deepEqual({ ...r.trust, passRate: +r.trust.passRate.toFixed(4), perCardWeek: +r.trust.perCardWeek.toFixed(4) }, { cards: 3, reviews: 5, scheduled: 3, passed: 2, passRate: 0.6667, perCardWeek: +(5 / 3 / 2).toFixed(4) });
  assert.deepEqual({ ...r.fsrs, passRate: +r.fsrs.passRate.toFixed(4) }, { cards: 2, reviews: 3, scheduled: 3, passed: 2, passRate: 0.6667, perCardWeek: 3 / 2 / 2 });
  // stopped: only what happened before it was switched off, and the days stop running
  const stopped = trustResults(logs, { since, until: NOW - 2 * DAY }, NOW);
  assert.equal(stopped.days, 12);
  assert.equal(stopped.trust.reviews, 2); assert.equal(stopped.fsrs.reviews, 3);
  // nothing yet
  const none = trustResults([], { since: NOW, until: null }, NOW);
  assert.deepEqual(none.trust, { cards: 0, reviews: 0, scheduled: 0, passed: 0, passRate: null, perCardWeek: null });
  assert.equal(trustResults(logs, { since: null }, NOW).days, 0);
  void due;
});

// ---------- the engine room ----------
import { OwnCore } from '../js/own-core.js';
import { modelRows } from '../js/own-features.js';
import { DAY as D1, T0, DECKS, CARDS, loadedIdb, setSettings, history, rowsOf, clock } from './own-helpers.mjs';

async function fresh(on = true) {
  const idb = await loadedIdb(), clk = clock();
  if (on) await setSettings(idb, { on: true, autoLocked: false });
  const core = new OwnCore({ idb, now: clk.now });
  await core.handle('open', {});
  if (on) await core.handle('setOn', { on: true });
  await core.handle('rebuild', { rows: rowsOf(history(6)) });
  return core;
}

test('own-core: setTrust needs Own switched on, keeps the start time, stops with Own, and shows in status', async () => {
  const core = await fresh(false);
  const refused = await core.handle('setTrust', { on: true });
  assert.equal(refused.ok, false);
  await core.handle('setOn', { on: true });
  const a = await core.handle('setTrust', { on: true });
  assert.equal(a.ok, true); assert.ok(Number.isFinite(a.trustSince)); assert.equal(a.trustUntil, null);
  const st = await core.handle('status');
  assert.equal(st.trustTest, true); assert.equal(st.trustSince, a.trustSince);
  const off = await core.handle('setTrust', { on: false });
  assert.equal(off.trustTest, false); assert.ok(Number.isFinite(off.trustUntil));
  assert.equal((await core.handle('status')).trustSince, a.trustSince, 'the numbers stay');
  assert.equal((await core.handle('setTrust', { on: true })).trustSince, a.trustSince, 'the start time is kept');
  await core.handle('setOn', { on: false });
  const after = await core.handle('status');
  assert.equal(after.trustTest, false); assert.equal(after.trustSince, a.trustSince);
});

test('own-core: a trust plan needs the test switched on; it uses the v2 read, the normal plan does not', async () => {
  const core = await fresh(true);
  const args = { card: CARDS[0], decks: DECKS, now: T0 + 14 * D1, ms: 5000, target: 0.9, maxDays: 36500 };
  assert.deepEqual(await core.handle('plan', { ...args, trust: true }), { skip: 'off' });
  await core.handle('setTrust', { on: true });
  const t = await core.handle('plan', { ...args, trust: true }), n = await core.handle('plan', args);
  assert.ok(t.days && t.trust === true);
  assert.ok(n.days && n.trust === false);
  const want = core.engine.daysForButtons(modelRows([{ id: -1, cardId: 'a', timestamp: args.now, source: 'review', rating: 3, ms: 5000 }], [CARDS[0]], DECKS)[0], 5000, 0.9, 3650, { sched: 'v2' });
  assert.deepEqual(t.days, want);
});
