import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../js/own-verdict.js';

// A small repeatable random stream for building test records.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Records where the truth is `pTrue`, FSRS guesses pTrue+fOff and Own guesses pTrue+oOff.
function make(n, cards, { oOff = 0, fOff = 0.1, seed = 1 } = {}) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const pTrue = 0.5 + 0.4 * r();
    const y = r() < pTrue ? 1 : 0;
    out.push({ cardId: 'c' + (i % cards), pOwn: pTrue + oOff, pFsrs: pTrue + fOff, y });
  }
  return out;
}
const enough = { totalScored: 5000, daysWatching: 30 };
const good = make(600, 100);

test('constants match the written rule', () => {
  assert.equal(V.N_LIVE, 300); assert.equal(V.MIN_SCORED, 1000); assert.equal(V.MIN_DAYS, 7);
  assert.equal(V.DWELL_DAYS, 14); assert.equal(V.DWELL_RECORDS, 200); assert.equal(V.EXIT_WINDOW, 1000);
  assert.equal(V.MAX_AUTO_RETURNS, 2); assert.equal(V.RMSE_LIMIT, 0.01); assert.equal(V.BOOTSTRAP_RESAMPLES, 1000);
});

// ---------- verdict: the "not enough yet" edges ----------
test('scored reviews: 999 is too few, 1000 is enough', () => {
  assert.equal(V.liveVerdict(good, { ...enough, totalScored: 999 }).status, 'few');
  assert.notEqual(V.liveVerdict(good, { ...enough, totalScored: 1000 }).status, 'few');
});
test('live records: 299 is too few, 300 is enough', () => {
  const r = make(300, 60);
  assert.equal(V.liveVerdict(r.slice(0, 299), enough).status, 'few');
  assert.notEqual(V.liveVerdict(r, enough).status, 'few');
});
test('days watching: 6 is too few, 7 is enough', () => {
  assert.equal(V.liveVerdict(good, { ...enough, daysWatching: 6 }).status, 'few');
  assert.notEqual(V.liveVerdict(good, { ...enough, daysWatching: 7 }).status, 'few');
});
test('few reports the progress counts and no interval', () => {
  const v = V.liveVerdict(good, { totalScored: 400, daysWatching: 2, nLive: 120 });
  assert.equal(v.status, 'few');
  assert.deepEqual(v.need, { scored: { have: 400, need: 1000 }, live: { have: 120, need: 300 }, days: { have: 2, need: 7 } });
  assert.equal(v.lo, null);
});

// ---------- verdict: better / not ----------
test('a clearly better Own gives Better with the whole interval below 0', () => {
  const v = V.liveVerdict(good, enough);
  assert.equal(v.status, 'better');
  assert.ok(v.hi < 0 && v.lo <= v.hi && v.meanDiff < 0);
  assert.equal(v.n, 600); assert.equal(v.cards, 100);
});
test('all differences 0 gives Not better', () => {
  const same = good.map(r => ({ ...r, pOwn: r.pFsrs }));
  const v = V.liveVerdict(same, enough);
  assert.equal(v.status, 'not');
  assert.equal(v.meanDiff, 0); assert.equal(v.hi, 0); // an interval touching 0 is not "below 0"
});
test('a clearly worse Own gives Not better', () => {
  assert.equal(V.liveVerdict(make(600, 100, { oOff: 0.1, fOff: 0 }), enough).status, 'not');
});
test('the interval must be wholly below 0: a mixed set is Not better', () => {
  // half the cards favour Own, half favour FSRS
  const r = make(600, 100).map((x, i) => (i % 2 ? { ...x, pOwn: x.pFsrs, pFsrs: x.pOwn } : x));
  const v = V.liveVerdict(r, enough);
  assert.equal(v.status, 'not');
  assert.ok(v.hi >= 0);
});
// Own tells the groups apart (better log loss) but is overconfident (bad calibration);
// FSRS says one steady number that is well calibrated.
const overconfident = () => {
  const r = [];
  for (let i = 0; i < 600; i++) {
    const groupA = i % 10 < 7;                       // 70% of records
    const y = groupA ? (i % 20 !== 0 ? 1 : 0) : (i % 5 === 0 ? 1 : 0); // A: ~95% remembered, B: 20%
    r.push({ cardId: 'c' + (i % 100), pOwn: groupA ? 0.99 : 0.4, pFsrs: 0.725, y });
  }
  return r;
};
test('RMSE limit: better log loss but RMSE worse by more than 0.01 is Not better', () => {
  const v = V.liveVerdict(overconfident(), enough);
  assert.ok(v.meanDiff < 0 && v.hi < 0, 'log loss clearly favours Own');
  assert.ok(v.rmseOwn - v.rmseFsrs > V.RMSE_LIMIT);
  assert.equal(v.status, 'not');
});
test('RMSE limit edge values', () => {
  assert.equal(V.rmseBroken(0.06, 0.05 + 1e-15), false);       // exactly at the limit is allowed
  assert.equal(V.rmseBroken(0.0601, 0.05), true);              // just over is not
  assert.equal(V.rmseBroken(0.04, 0.05), false);
});
test('binnedRmse: perfect calibration is 0, known miss is exact', () => {
  assert.equal(V.binnedRmse([0.5, 0.5], [1, 0]), 0);
  assert.ok(Math.abs(V.binnedRmse([0.9, 0.9], [0, 0]) - 0.9) < 1e-12);
  assert.ok(Number.isNaN(V.binnedRmse([], [])));
});
test('broken records are ignored', () => {
  const bad = [...good, { cardId: 'x', pOwn: NaN, pFsrs: 0.5, y: 1 }, { cardId: 'x', pOwn: 0.5, pFsrs: 0.5, y: 2 }, null];
  assert.equal(V.liveVerdict(bad, enough).n, 600);
});

// ---------- determinism ----------
test('same records and seed give identical results; order does not matter', () => {
  const a = V.liveVerdict(good, { ...enough, seed: 7 });
  const b = V.liveVerdict(good, { ...enough, seed: 7 });
  const c = V.liveVerdict([...good].reverse(), { ...enough, seed: 7 });
  assert.deepEqual(a, b);
  // a different record order may differ in the last decimal places only
  assert.equal(a.status, c.status); assert.ok(Math.abs(a.lo - c.lo) < 1e-12 && Math.abs(a.hi - c.hi) < 1e-12);
  assert.ok(Math.abs(a.meanDiff - c.meanDiff) < 1e-12);
});
test('a different seed moves the interval a little', () => {
  const a = V.liveVerdict(good, { ...enough, seed: 1 }), b = V.liveVerdict(good, { ...enough, seed: 2 });
  assert.notEqual(a.lo, b.lo); assert.equal(a.meanDiff, b.meanDiff);
});
test('5,000 records over 800 cards is fast', () => {
  const big = make(5000, 800, { seed: 9 });
  const t = process.hrtime.bigint();
  const v = V.liveVerdict(big, enough);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(v.status, 'better');
  assert.ok(ms < 200, `took ${ms} ms`);
});

// ---------- the exit check ----------
test('exitCheck: Own still ahead means stay', () => {
  assert.equal(V.exitCheck(good, 600).status, 'stay');
});
test('exitCheck: mean exactly 0 exits, just below 0 stays', () => {
  const same = good.map(r => ({ ...r, pOwn: r.pFsrs }));
  const e = V.exitCheck(same, 600);
  assert.equal(e.status, 'exit'); assert.equal(e.why, 'worse');
  // Own very slightly better (below 0 by a hair, RMSE close)
  const hair = good.map(r => ({ ...r, pOwn: r.pFsrs + (r.y ? 1e-4 : -1e-4) }));
  assert.equal(V.exitCheck(hair, 600).status, 'stay');
});
test('exitCheck: RMSE limit broken exits even when the mean is below 0', () => {
  const e = V.exitCheck(overconfident(), 600);
  assert.ok(e.meanDiff < 0);
  assert.equal(e.status, 'exit'); assert.equal(e.why, 'rmse');
});
test('exitCheck window: 200+ since the switch uses those, fewer uses the last 1,000', () => {
  const old = make(1000, 100, { oOff: 0.1, fOff: 0, seed: 3 });      // Own was bad before the switch
  const fresh = make(200, 40, { seed: 4 });                           // Own good after it
  const all = [...old, ...fresh];
  assert.equal(V.exitCheck(all, 200).status, 'stay');                 // only the 200 fresh ones count
  assert.equal(V.exitCheck(all, 199).status, 'exit');                 // 199: falls back to the last 1,000
  assert.equal(V.exitCheck([...old, ...old], 5000).n, 1000);          // never more than 1,000
});
test('exitCheck: no records means stay', () => {
  assert.equal(V.exitCheck([], 0).status, 'stay');
});

// ---------- the switch rule ----------
const better = d => ({ day: d, status: 'better' });
const withState = (o = {}) => ({ ...V.newState(0), ...o });
const ready = (o = {}) => ({ on: true, verdicts: [better(9), better(10)], recordsSinceSwitch: 500, plans: { total: 100, failed: 0 }, ...o });

test('two Better checks on consecutive days switch to Own', () => {
  const r = V.nextScheduler(withState(), ready(), 10);
  assert.equal(r.scheduler, 'own'); assert.equal(r.switched, true); assert.equal(r.why, 'better');
  assert.deepEqual(r.state.switches, [{ day: 10, to: 'own', why: 'better' }]);
  assert.equal(r.state.sinceDay, 10);
});
test('one Better check is not enough; a gap or a Not breaks the run', () => {
  assert.equal(V.nextScheduler(withState(), ready({ verdicts: [better(10)] }), 10).switched, false);
  assert.equal(V.nextScheduler(withState(), ready({ verdicts: [better(8), better(10)] }), 10).switched, false);
  assert.equal(V.nextScheduler(withState(), ready({ verdicts: [better(9), { day: 10, status: 'not' }] }), 10).switched, false);
  assert.equal(V.nextScheduler(withState(), ready({ verdicts: [{ day: 9, status: 'few' }, better(10)] }), 10).switched, false);
});
test('recordCheck keeps one per day and the last two', () => {
  let v = V.recordCheck([], 1, 'better');
  v = V.recordCheck(v, 2, 'better'); v = V.recordCheck(v, 3, 'not');
  assert.deepEqual(v, [{ day: 2, status: 'better' }, { day: 3, status: 'not' }]);
  assert.deepEqual(V.recordCheck(v, 3, 'better'), [{ day: 2, status: 'better' }, { day: 3, status: 'better' }]);
  assert.equal(V.betterTwiceInARow(V.recordCheck(V.recordCheck([], 4, 'better'), 5, 'better')), true);
});
test('checkDue: once per study day', () => {
  assert.equal(V.checkDue(withState({ lastCheckDay: 5 }), 5), false);
  assert.equal(V.checkDue(withState({ lastCheckDay: 4 }), 5), true);
  assert.equal(V.checkDue(withState(), 5), true);
});
test('owner switch off keeps FSRS; autoLocked keeps FSRS', () => {
  assert.equal(V.nextScheduler(withState(), ready({ on: false }), 10).switched, false);
  assert.equal(V.nextScheduler(withState({ autoLocked: true }), ready(), 10).switched, false);
});
test('turning off while Own schedules returns to FSRS at once and does not count as a return', () => {
  const s = withState({ scheduler: 'own', switches: [{ day: 10, to: 'own', why: 'better' }] });
  const r = V.nextScheduler(s, { on: false }, 11);
  assert.equal(r.scheduler, 'fsrs'); assert.equal(r.why, 'off');
  assert.equal(V.autoReturns(r.state.switches), 0);
});

// switch spacing: 14 days AND 200 records
const afterOwn = (o = {}) => withState({ scheduler: 'own', switches: [{ day: 10, to: 'own', why: 'better' }], ...o });
const exitIn = { status: 'exit', why: 'worse' };
test('spacing before Own returns: 13 days is too soon, 14 is fine', () => {
  assert.equal(V.nextScheduler(afterOwn(), { on: true, exit: exitIn, recordsSinceSwitch: 500 }, 23).switched, false);
  assert.equal(V.nextScheduler(afterOwn(), { on: true, exit: exitIn, recordsSinceSwitch: 500 }, 24).switched, true);
});
test('spacing: 199 new records is too few, 200 is fine', () => {
  assert.equal(V.nextScheduler(afterOwn(), { on: true, exit: exitIn, recordsSinceSwitch: 199 }, 30).switched, false);
  assert.equal(V.nextScheduler(afterOwn(), { on: true, exit: exitIn, recordsSinceSwitch: 200 }, 30).switched, true);
});
test('spacing also holds before Own takes over again', () => {
  const s = withState({ switches: [{ day: 10, to: 'own', why: 'better' }, { day: 30, to: 'fsrs', why: 'worse' }] });
  assert.equal(V.nextScheduler(s, ready({ verdicts: [better(42), better(43)] }), 43).switched, false); // 13 days
  assert.equal(V.nextScheduler(s, ready({ verdicts: [better(43), better(44)] }), 44).switched, true);  // 14 days
  assert.equal(V.nextScheduler(s, ready({ verdicts: [better(43), better(44)], recordsSinceSwitch: 199 }), 44).switched, false);
});
test('Own stays when exit check says stay or is missing', () => {
  assert.equal(V.nextScheduler(afterOwn(), { on: true, exit: { status: 'stay' }, recordsSinceSwitch: 900 }, 40).switched, false);
  assert.equal(V.nextScheduler(afterOwn(), { on: true, recordsSinceSwitch: 900 }, 40).switched, false);
});
test('the reason for an exit follows the check (worse or rmse)', () => {
  const r = V.nextScheduler(afterOwn(), { on: true, exit: { status: 'exit', why: 'rmse' }, recordsSinceSwitch: 900 }, 40);
  assert.equal(r.why, 'rmse');
});

// lock after 2 returns
test('after 2 automatic returns Own is autoLocked and cannot come back', () => {
  let s = withState();
  s = V.nextScheduler(s, ready({ verdicts: [better(9), better(10)] }), 10).state;                       // to own, day 10
  let r = V.nextScheduler(s, { on: true, exit: exitIn, recordsSinceSwitch: 300 }, 25);                  // back, day 25
  assert.equal(r.state.autoLocked, false); s = r.state;
  s = V.nextScheduler(s, ready({ verdicts: [better(39), better(40)] }), 40).state;                      // to own, day 40
  r = V.nextScheduler(s, { on: true, exit: exitIn, recordsSinceSwitch: 300 }, 55);                      // back again, day 55
  assert.equal(r.scheduler, 'fsrs'); assert.equal(r.state.autoLocked, true);
  assert.equal(V.autoReturns(r.state.switches), 2);
  const again = V.nextScheduler(r.state, ready({ verdicts: [better(99), better(100)] }), 100);
  assert.equal(again.switched, false);
  // owner turns it off and on again: a fresh state is unlocked
  assert.equal(V.newState(120).autoLocked, false);
});

// error pause
test('error share: exactly 5% is fine, above 5% is an error', () => {
  assert.equal(V.planErrorsTooMany({ total: 100, failed: 5 }), false);
  assert.equal(V.planErrorsTooMany({ total: 100, failed: 6 }), true);
  assert.equal(V.planErrorsTooMany({ total: 200, failed: 10 }), false);
  assert.equal(V.planErrorsTooMany({ total: 200, failed: 11 }), true);
  assert.equal(V.planErrorsTooMany({ total: 0, failed: 0 }), false);
  assert.equal(V.planErrorsTooMany(undefined), false);
});
test('error returns to FSRS at once (even inside the 14-day gap) and pauses 14 days', () => {
  const r = V.nextScheduler(afterOwn(), { on: true, plans: { total: 100, failed: 6 }, recordsSinceSwitch: 5 }, 12);
  assert.equal(r.scheduler, 'fsrs'); assert.equal(r.why, 'error');
  assert.equal(r.state.errorPauseUntil, 26);
  // 5% exactly: no error
  assert.equal(V.nextScheduler(afterOwn(), { on: true, plans: { total: 100, failed: 5 }, recordsSinceSwitch: 5 }, 12).switched, false);
});
test('after an error, Own waits 14 days: day 25 no, day 26 yes (given the evidence)', () => {
  const s = V.nextScheduler(afterOwn(), { on: true, plans: { total: 100, failed: 6 } }, 12).state;
  assert.equal(V.nextScheduler(s, ready({ verdicts: [better(24), better(25)] }), 25).switched, false);
  assert.equal(V.nextScheduler(s, ready({ verdicts: [better(25), better(26)] }), 26).switched, true);
});

// scripted 60 days: no flip inside the gap, lock after 2 returns
test('60-day script: no flip-flop inside the gap, lock after 2 returns', () => {
  let s = V.newState(0), verdicts = [], since = 0, log = [];
  for (let day = 1; day <= 60; day++) {
    // Own looks better on every check until day 20, worse (exit) on days 21-35, better again 36-45, worse after.
    const status = day <= 20 || (day >= 36 && day <= 45) ? 'better' : 'not';
    verdicts = V.recordCheck(verdicts, day, status);
    since += 40;
    const exit = status === 'better' ? { status: 'stay' } : { status: 'exit', why: 'worse' };
    const r = V.nextScheduler(s, { on: true, verdicts, exit, recordsSinceSwitch: since, plans: { total: 40, failed: 0 } }, day);
    if (r.switched) { log.push([day, r.scheduler]); since = 0; }
    s = r.state;
  }
  // Own takes over at day 2, goes back when the exit signal appears (day 21), returns at day 37, leaves again at day 51 (14-day gap).
  assert.deepEqual(log.map(x => x[1]), ['own', 'fsrs', 'own', 'fsrs']);
  for (let i = 1; i < log.length; i++) assert.ok(log[i][0] - log[i - 1][0] >= V.DWELL_DAYS, `gap before switch ${i}`);
  assert.equal(s.autoLocked, true);
  assert.equal(s.scheduler, 'fsrs');
});
