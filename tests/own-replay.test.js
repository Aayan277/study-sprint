import './rwkv-utc.mjs';
// Tests for the replay test (tools/own-model/replay-core.mjs) on made-up learners from the sim source and the shipped js/own-params.js model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLearner } from '../tools/own-model/common.mjs';
import { loadShippedParams } from '../tools/own-model/eval-core.mjs';
import { warmUp, simulate, replayUser, crnU, cutoffOf, interpAt, curveOf, matchedPct, matchedPctAtOwn, matchedSideAtOwn, summarizeReplay, parseBand, bandClamp, splitProblem, halfOf, IntervalTracker, ivShares, bandShare, periodIndex, periodDays, PERIODS, log2Bin, LOG2_BINS, runKey, FSRS_TARGETS, OWN_TARGETS, TRUTHS, SCHEDS, REPLAY_VERSION } from '../tools/own-model/replay-core.mjs';
import { runPool } from '../tools/own-model/replay-pool.mjs';
import { fnv1a } from '../js/rwkv-features.js';
import { createOwnModel } from '../js/own-model.js';
import { pAt, largestDayAtLeast, intervalDays } from '../js/own-curve.js';

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
  assert.ok(a.runs[runKey('own', 'own', 0.9)].totalReviews === a.runs[runKey('own', 'own', 0.9)].reviews + a.runs[runKey('own', 'own', 0.9)].day1Reviews);
  assert.ok(a.runs[runKey('own', 'own', 0.9)].reviews > 0);
  const c = replayUser(learner(0), { ...O, targets: [0.9], seed: 4 });
  assert.notDeepEqual(strip(a.runs), strip(c.runs), 'another seed gives other luck');
});

test('truth Own, scheduler Own: the mean chance of passing at scheduled reviews follows the target (fade mode)', () => {
  const mean = {};
  for (const R of [0.8, 0.9]) {
    let sum = 0, n = 0;
    for (const k of [0, 1, 2]) {
      const warm = warmUp(learner(k), { ...O, days: 120 }), r = simulate(warm, { truth: 'own', sched: 'own', R }, { ...O, days: 120 });
      if (r.scheduled) { sum += r.scheduledP * r.scheduled; n += r.scheduled; }
    }
    mean[R] = sum / n;
    // made-up learners on the shipped model: close, not exact (the real-data smoke run is the calibration check)
    assert.ok(n > 50 && Math.abs(mean[R] - R) < 0.12, `R ${R}: mean p ${mean[R].toFixed(3)} over ${n}`);
  }
  assert.ok(mean[0.9] - mean[0.8] > 0.08, `p must rise with R: ${mean[0.8].toFixed(3)} -> ${mean[0.9].toFixed(3)}`);
});

test('day 1, scheduled and repeat reviews are counted apart; the headline starts on day 2', () => {
  const warm = warmUp(learner(0), O), days = new Map(), retries = [];
  const r = simulate(warm, { truth: 'own', sched: 'own', R: 0.9 }, { ...O, onReview: i => { days.set(i.day, (days.get(i.day) || 0) + 1); if (i.retry) retries.push(i); } });
  const d1 = days.get(warm.cutoff + 1) || 0;
  assert.equal(r.day1Reviews, d1);
  assert.equal(r.totalReviews, r.reviews + d1);
  assert.equal(r.reviews, r.scheduled + r.retries);
  assert.ok(r.retries <= retries.length && r.retries > 0, 'some cards lapse and are repeated');
  assert.ok(r.scheduledP > 0 && r.scheduledP < 1 && r.retryP >= 0 && r.retryP <= 1);
  assert.ok(r.ownIntervals > 0 && r.ownOneDay >= 0 && r.ownOneDay <= r.ownIntervals);
  assert.equal(simulate(warm, { truth: 'own', sched: 'fsrs', R: 0.9 }, O).ownIntervals, 0);
});

test('a card that has been dormant is left out for both schedulers; only the active-days window decides', () => {
  const base = learner(0), first = base.rows[0], DAYMS = 86400000;
  const dormant = [0, 1].map(i => ({ ...first, logId: `dormant${i}`, cardKey: 'c:dormant', noteKey: 'n:dormant', day: first.day - 300 + i, t: first.t - (300 - i) * DAYMS, rating: 3 }));
  const rows = [...dormant, ...base.rows], loaded = { ...base, rows };
  const big = { ...O, maxCards: 100000 };
  const cutoff = cutoffOf(rows);
  assert.ok(cutoff - dormant[1].day > 90);
  const w90 = warmUp(loaded, big), w1000 = warmUp(loaded, { ...big, activeDays: 1000 });
  assert.ok(!w90.cards.some(c => c.key === 'c:dormant'));
  assert.ok(w1000.cards.some(c => c.key === 'c:dormant'));
  assert.equal(w1000.cards.length, w90.cards.length + 1);
  assert.equal(w90.cardsActive, w90.cards.length);
  assert.equal(w90.cardsSeen, w90.cardsActive + 1);
  for (const sched of SCHEDS) {
    const seen = new Set();
    const r = simulate(w90, { truth: 'own', sched, R: 0.9 }, { ...big, onReview: i => seen.add(i.card) });
    assert.ok(!seen.has('c:dormant'));
    assert.equal(r.cards, w90.cards.length, 'the same cards under every scheduler');
  }
});

test('fade mode: with a note stream that fades, the interval is no longer than head mode and the prediction at review time meets R', () => {
  const warm = warmUp(learner(0), O), m = warm.model, store = warm.own.store;
  const days = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
  const notes = [...store.notes.values()].slice(0, 40);
  let fading = 0, shorter = 0;
  for (const c of warm.cards) for (const note of notes) {
    const { next: n0, fq } = c.after, next = { ...n0, note };
    const head = m.headOf(next, fq);
    const at = d => pAt(m.headOf(m.decayAll(next, { note: d, deck: 0, user: 0 }), fq), d);   // the slow way, the model's own between-review fade
    for (const R of [0.8, 0.9]) {
      const fade = m.fadedDays(next, fq, R, 36500);
      if (fade > 1) assert.ok(at(fade) >= R, `p at the chosen day ${fade}: ${at(fade)}`);
      if (fade < 36500) assert.ok(!(at(fade + 1) >= R), 'the next day is below the target');
    }
    // a known fading stream: the prediction at review time is below the one read straight after the answer at every day looked at
    if (!days.every(d => at(d) <= pAt(head, d) + 1e-12) || !days.some(d => at(d) < pAt(head, d) - 0.01)) continue;
    fading++;
    for (const R of [0.8, 0.9]) {
      const fade = m.fadedDays(next, fq, R, 36500), plain = Math.min(36500, Math.max(1, Math.round(intervalDays(head, R, 36500))));
      assert.ok(fade <= plain, `fade ${fade} > head ${plain}`);
      if (fade < plain) shorter++;
    }
  }
  assert.ok(fading >= 5, `only ${fading} states with a fading note stream`);
  assert.ok(shorter > 0, 'fading must shorten some interval');
});

test('largestDayAtLeast: exact for a falling curve, always a checked day for an odd one', () => {
  const lin = R => largestDayAtLeast(d => 1 - d / 1000, R, 36500);
  assert.equal(lin(0.9015), 98); assert.equal(lin(0.5), 500); assert.equal(lin(0.9995), 1); assert.equal(lin(0.1005), 899);
  assert.equal(largestDayAtLeast(d => 0.99, 0.9, 365), 365);
  assert.equal(largestDayAtLeast(d => 0.5, 0.9, 365), 1);
  assert.equal(largestDayAtLeast(d => 0.99, 0.9, 1), 1);
  const odd = d => (d <= 20 ? 0.95 : d <= 60 ? 0.5 : d === 61 ? 0.95 : 0.4);
  const got = largestDayAtLeast(odd, 0.9, 36500);
  assert.ok(got >= 1 && odd(got) >= 0.9);
  const wiggly = d => 0.95 - 0.2 * (1 - Math.exp(-d / 40)) + 0.05 * Math.sin(d);
  for (const R of [0.7, 0.8, 0.9]) { const g = largestDayAtLeast(wiggly, R, 5000); assert.ok(g === 1 || wiggly(g) >= R); }
});

test('common random numbers: the same card and review number get the same u under every scheduler', () => {
  const warm = warmUp(learner(1), O), seen = {};
  for (const sched of SCHEDS) {
    seen[sched] = new Map();
    simulate(warm, { truth: 'fsrs', sched, R: 0.9 }, { ...O, days: 90, onReview: i => seen[sched].set(`${i.card}|${i.n}`, i) });
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
  assert.equal(r.totalReviews, seen.length);
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
  // knowledge k costs 400 + 2000 (k - 0.8) reviews for FSRS; Own costs `own` times that at the same knowledge; knowledge = R for both
  const cost = k => 400 + 2000 * (k - 0.8);
  const mk = (id, own) => {
    const runs = {};
    const run = (k, factor) => ({ reviews: factor * cost(k), totalReviews: factor * cost(k) + 50, day1Reviews: 50, scheduled: 90, scheduledP: k, retries: 10, retryP: 0.6, lapses: 5, meanP: k, kEnd: k, kAvg: k, perCard: 1, cards: 10, ownIntervals: 10, ownOneDay: 2 });
    for (const truth of TRUTHS) {
      for (const R of FSRS_TARGETS) runs[runKey(truth, 'fsrs', R)] = run(R, 1);
      OWN_TARGETS.forEach((R, i) => { runs[runKey(truth, 'own', R)] = run(R, own); });
    }
    return { user: id, ok: true, runs };
  };
  assert.ok(Math.abs(matchedPct(mk('a', 0.7), 'own', 0.9) + 30) < 1e-9);
  assert.equal(matchedPct(mk('a', 0.7), 'own', 0.95), null, 'FSRS at 0.95 is above everything Own reaches');
  assert.ok(Math.abs(matchedPctAtOwn(mk('a', 0.7), 'own', 0.85) + 30) < 1e-9);
  assert.equal(matchedPctAtOwn(mk('a', 0.7), 'own', 0.7), null, 'Own at 0.70 reaches less than FSRS at 0.80');
  // a knowledge curve that dips is made monotone before reading: a running maximum, in order of R
  const dip = mk('d', 1);
  dip.runs[runKey('own', 'own', 0.85)].kAvg = 0.65;
  assert.deepEqual(curveOf(dip, 'own', 'own', OWN_TARGETS).map(q => q.x), [0.65, 0.70, 0.75, 0.80, 0.80, 0.90, 0.92]);     // 0.85 dipped to 0.65
  const secret = [mk('secret1', 0.7), mk('secret2', 0.8), mk('secret3', 0.9)];
  const { markdown, data } = summarizeReplay([...secret, { user: 'bad', ok: false, runs: {}, error: 'broke 12' }], { tag: 't', failed: [{ user: 'worse', ok: false, error: 'the worker exited with code 3', runs: {} }], ownSched: 'fade' });
  for (const R of ['0.85', '0.90']) { assert.ok(Math.abs(data.truths.own.headline[R].mean + 20) < 1e-9); assert.equal(data.truths.own.headline[R].users, 3); }
  assert.equal(data.truths.fsrs.headline['0.90'].users, 3);
  assert.equal(data.truths.own.atOwn['0.85'].users, 3);
  assert.deepEqual(Object.keys(data.truths.own.atOwn), ['0.70', '0.75', '0.80', '0.85', '0.90']);
  assert.equal(data.failed, 2);
  assert.match(markdown, /Truth: Own model/); assert.match(markdown, /Truth: FSRS-6/); assert.match(markdown, /2 failed/); assert.match(markdown, /worker exited with code #/);
  assert.match(markdown, /per user on that user's own reviews|fitted per user/); assert.match(markdown, /Own is zero-shot/);
  assert.match(markdown, /Own scheduler mode: fade/); assert.match(markdown, /covers only users inside the range/);
  assert.ok(!/secret/.test(markdown));
});

test('replay version is a number and the pool marks a crashed or silent worker as failed and carries on', async () => {
  assert.ok(Number.isInteger(REPLAY_VERSION) && REPLAY_VERSION >= 4);
  const specs = ['a', 'crash', 'b', 'silent', 'c', 'd', 'e'].map(key => ({ key }));
  const got = [];
  await runPool(specs, (r, n) => got.push({ ...r, n }), { workerUrl: new URL('./own-pool.child.mjs', import.meta.url), workerData: {}, jobs: 2 });
  assert.equal(got.length, specs.length);
  assert.deepEqual(got.map(r => r.n), got.map((_, i) => i + 1));
  const by = Object.fromEntries(got.map(r => [r.user, r]));
  assert.equal(by.crash.ok, false); assert.match(by.crash.error, /exited with code 3/);
  assert.equal(by.silent.ok, false);
  for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(by[k].ok, true);
});

test('a worker that answers and then exits does not fail the spec it was handed next: that spec is tried again', async () => {
  for (const jobs of [1, 2]) {
    const specs = ['post-exit', 'a', 'b', 'c'].map(key => ({ key })), got = [];
    await runPool(specs, (r, n) => got.push({ ...r, n }), { workerUrl: new URL('./own-pool.child.mjs', import.meta.url), workerData: {}, jobs });
    assert.equal(got.length, specs.length);
    assert.deepEqual(got.map(r => r.n), [1, 2, 3, 4]);
    assert.deepEqual(got.map(r => r.user).sort(), ['a', 'b', 'c', 'post-exit']);
    assert.ok(got.every(r => r.ok === true), `jobs ${jobs}: ${JSON.stringify(got.filter(r => !r.ok))}`);
  }
});

test('head mode schedules from the curve right after the answer; an unknown ownSched is refused', () => {
  const warm = warmUp(learner(0), O), run = { truth: 'own', sched: 'own', R: 0.9 };
  const head = simulate(warm, run, { ...O, ownSched: 'head' }), fade = simulate(warm, run, { ...O, ownSched: 'fade' });
  for (const r of [head, fade]) assert.ok(Number.isFinite(r.reviews) && r.reviews > 0 && Number.isFinite(r.kAvg) && r.ownIntervals > 0);
  assert.notDeepEqual(head, fade, 'the two modes schedule differently');
  assert.throws(() => simulate(warm, run, { ...O, ownSched: 'nope' }), /ownSched/);
});

test('users left out of the headline are counted by reason: Own below / above, FSRS-6 with 0 reviews', () => {
  const cost = k => 400 + 2000 * (k - 0.8);
  // knowledge = R + shift for Own (shift 0 for FSRS-6); fsrsCost 0 gives FSRS-6 users with no reviews
  const mk = (id, shift, fsrsCost = 1) => {
    const runs = {}, run = (k, f) => ({ reviews: f * cost(k), kAvg: k, ownIntervals: 10, ownOneDay: 2 });
    for (const truth of TRUTHS) {
      for (const R of FSRS_TARGETS) runs[runKey(truth, 'fsrs', R)] = run(R, fsrsCost);
      for (const R of OWN_TARGETS) runs[runKey(truth, 'own', R)] = run(R + shift, 0.7);
    }
    return { user: id, ok: true, runs };
  };
  const recs = [mk('in', 0), mk('lo', -0.2), mk('hi', 0.3), mk('zero', 0, 0)];
  assert.equal(matchedSideAtOwn(recs[1], 'own', 0.9), 'below');
  assert.equal(matchedSideAtOwn(recs[2], 'own', 0.9), 'above');
  assert.equal(matchedSideAtOwn(recs[0], 'own', 0.9), null);
  const { markdown, data } = summarizeReplay(recs, { tag: 't' });
  const A = data.truths.own.headline['0.90'], B = data.truths.own.atOwn['0.90'];
  assert.deepEqual([A.users, A.below, A.above, A.zeroFsrs, A.leftOut], [1, 1, 1, 1, 3]);
  assert.deepEqual([B.users, B.below, B.above, B.zeroFsrs, B.leftOut], [1, 1, 1, 1, 3]);
  assert.match(markdown, /\| 3: 1 \/ 1 \/ 1 \|/);
  assert.match(markdown, /Left out: Own below \/ above FSRS-6's range \/ FSRS-6 0 reviews/);
});

test('band: parsing, the clamp to 0.25-4x of the FSRS interval and the 3650-day cap', () => {
  assert.equal(parseBand('none'), null); assert.equal(parseBand(undefined), null);
  assert.deepEqual(parseBand('0.25,4'), { lo: 0.25, hi: 4, cap: 3650 });
  for (const bad of ['1', '0,4', '2,1', 'a,b', '0.25,4,5']) assert.throws(() => parseBand(bad), /--band/);
  const b = parseBand('0.25,4');
  assert.equal(bandClamp(5, 10, b), 5);          // inside 3..40
  assert.equal(bandClamp(1, 10, b), 3);          // below: 0.25 x 10 = 2.5 rounds to 3
  assert.equal(bandClamp(100, 10, b), 40);
  assert.equal(bandClamp(1, 1, b), 1); assert.equal(bandClamp(9, 1, b), 4);
  assert.equal(bandClamp(5000, 2000, b), 3650, 'the cap wins over a wide band');
  assert.equal(bandClamp(3, 2, parseBand('1,1')), 2);
});

test('half split: fnv1a of own-val-half|id, low bit 0 = A, 1 = B; the two halves cover everyone', () => {
  const ids = Array.from({ length: 200 }, (_, i) => String(i * 7 + 1));
  for (const id of ids) assert.equal(halfOf(id), (fnv1a('own-val-half|' + id) & 1) === 0 ? 'A' : 'B');
  const a = ids.filter(id => halfOf(id) === 'A').length;
  assert.ok(a > 60 && a < 140, `A has ${a} of 200`);
  assert.equal(halfOf('12'), halfOf('12'));
});

test('periods, log2 ratio bins and the interval tracker count what they should', () => {
  assert.deepEqual([1, 2, 7, 8, 28, 29, 90, 91, 180, 181, 365, 366].map(periodIndex), [-1, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, -1]);
  assert.deepEqual(periodDays(60), [6, 21, 32, 0, 0]); assert.deepEqual(periodDays(180), [6, 21, 62, 90, 0]); assert.equal(PERIODS.length, 5);
  assert.equal(log2Bin(10, 10), LOG2_BINS / 2);           // ratio 1 -> log2 0 -> first bin at or above 0
  assert.equal(log2Bin(20, 10), LOG2_BINS / 2 + 2);       // ratio 2 -> +1 -> two half-steps up
  assert.equal(log2Bin(5, 10), LOG2_BINS / 2 - 2);
  assert.equal(log2Bin(1, 100000), 0); assert.equal(log2Bin(100000, 1), LOG2_BINS - 1, 'the ends take everything beyond');
  const t = new IntervalTracker(3650);
  t.pass('a', 10, false);                 // remembered, not counted
  t.pass('a', 8, true);                   // shrinks (10 -> 8)
  t.pass('a', 12, true);                  // grows
  t.pass('a', 9, true);                   // shrinks (12 -> 9): a is now a card with 2 shrinks
  t.pass('b', 5, true);                   // nothing to compare with
  t.pass('b', 5, true);                   // equal is not a shrink
  t.lapse('b'); t.pass('b', 1, true);     // after a lapse nothing to compare with
  t.pass('c', 3650, true); t.pass('c', 400, true); t.pass('d', 365, true); t.pass('e', 364, true);
  const v = t.summary(4);
  assert.deepEqual([v.n, v.comparable, v.shrinks, v.cardsShrink2], [10, 5, 3, 1]);
  assert.deepEqual([v.ge365, v.ge3650, v.atMax, v.one], [3, 1, 1, 1]);
  const sh = ivShares(v);
  assert.equal(sh.shrink, 0.6); assert.equal(sh.cardsShrink2, 0.25); assert.equal(sh.one, 0.1); assert.equal(sh.ge365, 0.3);
  assert.ok(Number.isNaN(ivShares(new IntervalTracker(10).summary(0)).shrink));
  // percentiles: nearest rank on the sorted intervals
  const q = new IntervalTracker(100);
  for (let i = 1; i <= 100; i++) q.pass('k' + i, i, true);
  const qs = q.summary(100);
  assert.deepEqual([qs.p10, qs.p50, qs.p90, qs.p99], [11, 51, 91, 100]);
  assert.equal(bandShare({ bandBinds: 1, bandTotal: 4 }), 0.25); assert.ok(Number.isNaN(bandShare({ bandBinds: 0, bandTotal: 0 })));
});

test('version 4 runs: mix truth, paired histogram, band, period counts, new cards and cold start', () => {
  const warm = warmUp(learner(0), { ...O, newPerDay: 'real' });
  const base = { ...O, days: 40 };
  let firstLater = 0;
  const mix = simulate(warm, { truth: 'mix', sched: 'own', R: 0.9 }, { ...base, paired: true, onReview: i => { if (i.first && i.day > warm.cutoff + 1) firstLater++; } });
  assert.ok(Number.isFinite(mix.kAvg) && mix.kAvg > 0 && mix.kAvg <= 1 && mix.reviews > 0);
  assert.equal(mix.paired.hist.length, LOG2_BINS);
  assert.equal(mix.paired.hist.reduce((a, b) => a + b, 0), mix.paired.n);
  assert.equal(mix.paired.n, mix.iv.n, 'every counted pass is paired');
  assert.equal(mix.periods.reduce((a, p) => a + p.reviews, 0), mix.reviews + firstLater, 'periods hold every review from day 2, first answers of new cards included');
  assert.deepEqual(mix.periods.map(p => p.days), periodDays(40));
  assert.equal(mix.totalReviews, mix.reviews + mix.day1Reviews + mix.firstReviews);
  assert.ok(simulate(warm, { truth: 'mix', sched: 'fsrs', R: 0.9 }, base).paired === undefined, 'no histogram unless asked');
  // the paired histogram does not depend on which scheduler runs the cards only through the card states; with FSRS scheduling it is still filled
  const pf = simulate(warm, { truth: 'fsrs', sched: 'fsrs', R: 0.9 }, { ...base, paired: true });
  assert.ok(pf.paired.n > 0 && pf.ownIntervals === 0);
  // band: with 1,1 Own's interval equals FSRS-6's wherever it is read
  const tight = simulate(warm, { truth: 'own', sched: 'own', R: 0.9 }, { ...base, band: parseBand('1,1') });
  assert.equal(tight.bandTotal, tight.ownIntervals); assert.ok(tight.bandBinds > 0 && tight.bandBinds <= tight.bandTotal);
  const free = simulate(warm, { truth: 'own', sched: 'own', R: 0.9 }, base);
  assert.equal(free.bandTotal, 0);
  const app = simulate(warm, { truth: 'own', sched: 'own', R: 0.9 }, { ...base, band: parseBand('0.25,4') });
  assert.ok(app.bandBinds <= app.bandTotal && app.iv.n > 0);
  // new cards: introduced once, at most the real list, first answers counted apart
  assert.ok(warm.newCards.length > 0 && warm.newCards.every(c => c.day > warm.cutoff && c.rating >= 1 && c.rating <= 4));
  const nr = simulate(warm, { truth: 'own', sched: 'fsrs', R: 0.9 }, { ...base, days: 80 });
  assert.ok(nr.newCards > 0 && nr.firstReviews === nr.newCards, `${nr.newCards} new, ${nr.firstReviews} first answers`);
  const w2 = warmUp(learner(0), { ...O, newPerDay: 2 });
  assert.deepEqual(w2.newCards.map(c => c.day).slice(0, 5), [1, 2, 3, 4, 5].map(i => warm.cutoff + 1 + ((i - 1) >> 1)));
  assert.deepEqual(w2.newCards.map(c => c.key), warm.newCards.map(c => c.key), 'the same cards in the same order');
  const none = simulate(warmUp(learner(0), O), { truth: 'own', sched: 'fsrs', R: 0.9 }, base);
  assert.equal(none.newCards, 0); assert.equal(none.firstReviews, 0);
  // cold start: fewer warm rows, the start day moves back to the day of the Nth review
  const full = warmUp(learner(0), O), cold = warmUp(learner(0), { ...O, startAt: 200 });
  assert.equal(cold.warmRows, 200); assert.ok(cold.cutoff < full.cutoff && cold.warmRows < full.warmRows);
  assert.ok(simulate(cold, { truth: 'own', sched: 'own', R: 0.9 }, base).reviews >= 0);
  assert.equal(warmUp(learner(0), { ...O, startAt: 10 ** 9 }).warmRows, full.warmRows, 'a start beyond the history changes nothing');
  assert.throws(() => simulate(warm, { truth: 'nope', sched: 'own', R: 0.9 }, base), /truth/);
  const rec = replayUser(learner(0), { ...O, days: 30, targets: [0.9], truths: ['mix'], paired: true, band: parseBand('0.25,4'), newPerDay: 'real' });
  assert.equal(rec.ok, true); assert.deepEqual(Object.keys(rec.runs).sort(), ['mix|fsrs|0.90', 'mix|own|0.90']);
});

test('the test split is refused, with no override', () => {
  assert.match(splitProblem('test'), /Refusing/);
  assert.equal(splitProblem('val'), null); assert.equal(splitProblem('train'), null);
  assert.ok(splitProblem('other'));
});

test('start-at with new cards: a card first answered later on the start day is neither warmed nor new', () => {
  const full = learner(0), cut = 200;
  const dayOf = full.rows[cut - 1].day;
  // a card whose first row is after the cut but on the same day as the cut row
  const lateSame = full.rows.slice(cut).find(r => r.day === dayOf && !full.rows.slice(0, cut).some(q => q.cardKey === r.cardKey));
  if (!lateSame) return;   // this made-up learner has no such card; the case below is built by hand instead
  const warm = warmUp(full, { ...O, startAt: cut, newPerDay: 'real' });
  assert.ok(!warm.newCards.some(c => c.key === lateSame.cardKey), 'not introduced as new');
  assert.ok(!warm.cards.some(c => c.key === lateSame.cardKey), 'not warmed');
});

test('start-at with new cards: a hand-made same-day card is not introduced as new later', () => {
  const base = learner(0), DAYMS = 86400000, cut = 200;
  const rows = base.rows.map(r => ({ ...r })), last = rows[cut - 1];
  const extra = { ...last, cardKey: 'late-same-day', noteKey: 'late-note', t: last.t + 1000, scored: true, rating: 3 };
  const again = { ...last, cardKey: 'late-same-day', noteKey: 'late-note', day: last.day + 2, t: last.t + 2 * DAYMS, scored: true, rating: 3 };
  const all = [...rows.slice(0, cut), extra, ...rows.slice(cut), again].sort((a, b) => a.t - b.t);
  const warm = warmUp({ ...base, rows: all }, { ...O, startAt: all.indexOf(last) + 1, newPerDay: 'real' });
  assert.ok(!warm.newCards.some(c => c.key === 'late-same-day'));
});
