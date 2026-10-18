// Tests for FSRS-7 (beta) in the app: the memory model, the scheduler, the card-state migration, the setting, routing in srs.js and the
// exam maths. Run with: node tests/fsrs7.test.js
// The parts that need no library run always. The routing tests run the real srs.js, which loads ts-fsrs 5.4.2 from a CDN that Node can't
// open (tests/sim/loader.mjs points it at the local copy), and are skipped, loudly, without it. Agreement with ts-fsrs 6 beta is
// tests/fsrs7-parity.test.js. Design: docs/design/fsrs7-plan.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { W7_DEFAULT, W7_BOUNDS, W7_COUNT, clipWeights7, validWeights7, curve7, forgettingCurve7, nextInterval7, initState7, nextState7, replay7, cleanMemory7 } from '../js/fsrs7-model.js';
import { plan7, NEW, LEARNING, REVIEW, RELEARNING } from '../js/fsrs7-sched.js';
import { savedMemory, memoryFor, seedMemory, replayRows, prepare7, clearRebuilt, wasReplayed } from '../js/srs7.js';
import { cleanFsrsVersion, usesFsrs7, schedulerOptions, deckSchedulerOptions, personalW20, SCHED_DEFAULTS } from '../js/sched-settings.js';
import { recall, recallAt, recallFrom, memory7Of, examClamp, examGainFrom } from '../js/exam.js';
import { acceptSetting, SYNCED_SETTINGS } from '../js/sync-data.js';
import { rowFromRecord, recordFromRow } from '../js/sync-merge.js';
import { DEFAULT_SETTINGS, restoredSettings } from '../js/db.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 12, 10);
const cfg = (over = {}) => ({ w: [...W7_DEFAULT], retention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], maxInterval: 36500, fuzz: false, ...over });
const fresh = over => ({ cardId: 'c1', state: 0, learningStep: 0, reps: 0, lapses: 0, lastReview: null, memory: null, ...over });

// ---------- the memory model ----------
test('model: 34 default weights inside their bounds; clipping keeps them', () => {
  assert.equal(W7_DEFAULT.length, W7_COUNT);
  assert.equal(W7_BOUNDS.length, W7_COUNT);
  assert.ok(validWeights7(W7_DEFAULT));
  assert.deepEqual(clipWeights7(W7_DEFAULT), [...W7_DEFAULT]);
  assert.ok(!validWeights7(W7_DEFAULT.slice(0, 21)) && !validWeights7([...W7_DEFAULT.slice(0, 33), NaN]));
  const wild = clipWeights7(W7_DEFAULT.map(() => 1e6));
  wild.forEach((v, i) => assert.ok(v <= W7_BOUNDS[i][1] + 1e-12 && v >= W7_BOUNDS[i][0] - 1e-12, `w${i}`));
});

test('model: a new card starts with a fast trace at 80% of the slow one; Again is the least stable start, Easy the most', () => {
  const s = [1, 2, 3, 4].map(g => initState7(W7_DEFAULT, g));
  s.forEach(m => assert.ok(Math.abs(m.stabilityFast - 0.8 * m.stability) < 1e-7));
  assert.ok(s[0].stability < s[1].stability && s[1].stability < s[2].stability && s[2].stability < s[3].stability);
  assert.ok(s[0].difficulty > s[3].difficulty);                       // a card that starts with Again is harder
});

test('model: the curve starts at 1, only falls, and the interval for a retention lands on it', () => {
  const m = nextState7(W7_DEFAULT, null, 0, 3);
  assert.ok(forgettingCurve7(W7_DEFAULT, m, 0) > 0.999);
  let last = 1;
  for (const t of [0.01, 0.1, 0.5, 1, 3, 10, 30, 100, 1000]) { const r = forgettingCurve7(W7_DEFAULT, m, t); assert.ok(r < last, `t=${t}`); last = r; }
  for (const dr of [0.7, 0.8, 0.9, 0.95, 0.99]) {
    const t = nextInterval7(W7_DEFAULT, m, dr);
    assert.ok(Math.abs(forgettingCurve7(W7_DEFAULT, m, t) - dr) < 2e-3, `retention ${dr}`);
  }
  assert.ok(nextInterval7(W7_DEFAULT, m, 0.97) < nextInterval7(W7_DEFAULT, m, 0.8));    // a higher target comes back sooner
  assert.equal(nextInterval7(W7_DEFAULT, m, 0.99995), 0);
  assert.throws(() => nextInterval7(W7_DEFAULT, m, 1));
});

test('model: Again never raises a stability; Good raises the slow trace; a same-day repeat is a real update (not skipped)', () => {
  let m = nextState7(W7_DEFAULT, null, 0, 3);
  const again = nextState7(W7_DEFAULT, m, 5, 1);
  assert.ok(again.stability <= m.stability && again.stabilityFast <= m.stabilityFast && again.stabilityFast <= 0.8 * again.stability + 1e-9);
  const good = nextState7(W7_DEFAULT, m, 5, 3);
  assert.ok(good.stability > m.stability);
  const sameDay = nextState7(W7_DEFAULT, m, 0.02, 3);                 // half an hour later
  assert.notDeepEqual(sameDay, m);
  assert.ok(sameDay.stability >= m.stability);
});

test('model: replay7 is the same as stepping by hand; cleanMemory7 rejects broken memories', () => {
  const steps = [{ t: 0, g: 3 }, { t: 0.01, g: 2 }, { t: 4, g: 3 }, { t: 9, g: 1 }];
  let m = null;
  for (const { t, g } of steps) m = nextState7(W7_DEFAULT, m, t, g);
  assert.deepEqual(replay7(W7_DEFAULT, steps), m);
  assert.equal(replay7(W7_DEFAULT, []), null);
  assert.deepEqual(cleanMemory7({ stability: 2, stabilityFast: 1, difficulty: 5, extra: 1 }), { stability: 2, stabilityFast: 1, difficulty: 5 });
  for (const bad of [null, {}, { stability: 0, stabilityFast: 1, difficulty: 5 }, { stability: 2, stabilityFast: NaN, difficulty: 5 }, { stability: 2, stabilityFast: 1, difficulty: 11 }]) assert.equal(cleanMemory7(bad), null);
});

// ---------- the scheduler ----------
test('scheduler: a new card answered Good graduates at once (the model is the interval, the steps only a floor); Again starts the first step', () => {
  const o = plan7(fresh(), cfg(), NOW);
  assert.equal(o(3).state, REVIEW);
  assert.ok(Math.abs(o(3).scheduledDays - 4.78) < 0.02);
  assert.equal(o(1).state, LEARNING);
  assert.ok(Math.abs(o(1).scheduledDays - 1 / 1440) < 1e-9);          // 1 minute
  assert.equal(o(1).learningStep, 0);
  assert.equal(o(3).reps, 1);
  assert.ok(o(1).scheduledDays < o(2).scheduledDays && o(2).scheduledDays < o(3).scheduledDays && o(3).scheduledDays < o(4).scheduledDays);
});

test('scheduler: forgetting a review card relearns it, comes back within a day, and counts the lapse', () => {
  const m = nextState7(W7_DEFAULT, null, 0, 3);
  const card = fresh({ state: REVIEW, reps: 1, lastReview: NOW - 6 * DAY, memory: m });
  const o = plan7(card, cfg(), NOW)(1);
  assert.equal(o.state, RELEARNING);
  assert.equal(o.lapses, 1);
  assert.ok(o.scheduledDays <= 1 && o.scheduledDays >= 10 / 1440 - 1e-9);
  assert.ok(Math.abs(o.due - (NOW + o.scheduledDays * DAY)) < 2);
});

test('scheduler: the maximum interval is a real limit, and no steps means the model alone', () => {
  const m = nextState7(W7_DEFAULT, null, 0, 4);
  const card = fresh({ state: REVIEW, reps: 3, lastReview: NOW - 30 * DAY, memory: m });
  for (const g of [3, 4]) assert.ok(plan7(card, cfg({ maxInterval: 7 }), NOW)(g).scheduledDays <= 7);
  const none = plan7(fresh(), cfg({ learningSteps: [], relearningSteps: [] }), NOW);
  assert.ok(none(1).scheduledDays > 0);
});

// ---------- the setting ----------
test('setting: fsrsVersion is 6 unless it is exactly 7; FSRS-6 options look exactly as before', () => {
  assert.equal(DEFAULT_SETTINGS.fsrsVersion, 6);
  for (const v of [undefined, null, 6, '7', 7.5, 'x', 0]) assert.equal(cleanFsrsVersion(v), 6);
  assert.equal(cleanFsrsVersion(7), 7);
  assert.ok(usesFsrs7({ fsrsVersion: 7 }) && !usesFsrs7({}) && !usesFsrs7(null));
  assert.ok(!('fsrsVersion' in schedulerOptions({})) && !('fsrsVersion' in schedulerOptions({ fsrsVersion: 6 })));
  assert.equal(schedulerOptions({ fsrsVersion: 7 }).fsrsVersion, 7);
  assert.equal(deckSchedulerOptions({ fsrsVersion: 7 }, { options: { fuzz: false } }).fsrsVersion, 7);       // a deck cannot choose its own FSRS
  assert.equal(deckSchedulerOptions({ fsrsVersion: 7 }, { options: { fsrsVersion: 6 } }).fsrsVersion, 7);
  assert.ok(SYNCED_SETTINGS.includes('fsrsVersion'));
  assert.equal(personalW20({}), undefined);                                              // FSRS-6: a number or undefined, as before
  assert.deepEqual(personalW20({ fsrsVersion: 7 }), { w20: undefined, w7: W7_DEFAULT });
});

test('setting: junk fsrsVersion from the server or a backup is ignored, never stored', () => {
  assert.deepEqual(acceptSetting('fsrsVersion', 7), { ok: true, value: 7 });
  assert.deepEqual(acceptSetting('fsrsVersion', 6), { ok: true, value: 6 });
  for (const bad of [null, undefined, '7', 8, {}, true]) assert.deepEqual(acceptSetting('fsrsVersion', bad), { ok: false });
  assert.deepEqual(restoredSettings({ fsrsVersion: 7 }), [['fsrsVersion', 7]]);
  assert.deepEqual(restoredSettings({ fsrsVersion: 'seven', targetRetention: 0.9 }), [['targetRetention', 0.9]]);
});

// ---------- the saved state ----------
const withSeven = (st, memory, at = st.lastReview) => ({ ...st, fsrs7: { ...memory, at } });
const six = { cardId: 'c1', due: NOW + 3 * DAY, stability: 12, difficulty: 6, elapsedDays: 0, scheduledDays: 3, learningSteps: 0, reps: 4, lapses: 0, state: REVIEW, lastReview: NOW };

test('state: the FSRS-7 memory counts only while its `at` is the card\'s lastReview', () => {
  const m = { stability: 9, stabilityFast: 4, difficulty: 5 };
  assert.deepEqual(savedMemory(withSeven(six, m)), m);
  assert.equal(savedMemory(six), null);                                            // never FSRS-7
  assert.equal(savedMemory({ ...withSeven(six, m), lastReview: NOW + 5 }), null);   // reviewed since (by FSRS-6 or an older app)
  assert.equal(savedMemory({ ...six, fsrs7: { stability: 'x', at: NOW } }), null);   // junk
  assert.equal(memory7Of(withSeven(six, m))?.stabilityFast, 4);
});

test('migration: with no log the memory is seeded from the FSRS-6 numbers; with a prepared replay it is the replay', async () => {
  clearRebuilt();
  assert.equal(memoryFor(null), null);
  assert.equal(memoryFor({ ...six, state: NEW }), null);
  const seed = memoryFor(six);
  assert.deepEqual(seed, { stability: 12, stabilityFast: 12 * 0.8, difficulty: 6 });
  assert.deepEqual(seed, seedMemory(six));
  // a log that starts at new and ends at the card's last review
  const rows = [
    { id: 1, cardId: 'c1', timestamp: NOW - 10 * DAY, source: 'review', rating: 3, state: 0 },
    { id: 2, cardId: 'c1', timestamp: NOW - 10 * DAY + 600000, source: 'review', rating: 2, state: 1 },
    { id: 3, cardId: 'c1', timestamp: NOW - 5 * DAY, source: 'review', rating: 3, state: 2 },
    { id: 4, cardId: 'c1', timestamp: NOW, source: 'review', rating: 3, state: 2 }
  ];
  const steps = [{ t: 0, g: 3 }, { t: 600000 / DAY, g: 2 }, { t: 5 - 600000 / DAY, g: 3 }, { t: 5, g: 3 }];
  const expected = replay7(W7_DEFAULT, steps);
  let reads = 0;
  await prepare7([six, null, { ...six, cardId: 'new', state: NEW }], async () => { reads++; return rows; });
  assert.equal(reads, 1);                                                          // one card needed it
  assert.ok(wasReplayed(six));
  const m = memoryFor(six);
  for (const k of ['stability', 'stabilityFast', 'difficulty']) assert.ok(Math.abs(m[k] - expected[k]) < 1e-6, k);
  await prepare7([six], async () => { reads++; return rows; });
  assert.equal(reads, 1);                                                          // already done: not read again
  await prepare7([withSeven(six, { stability: 9, stabilityFast: 4, difficulty: 5 })], async () => { reads++; return rows; });
  assert.equal(reads, 1);                                                          // already has a current FSRS-7 memory: not read
  clearRebuilt();
});

test('migration: replay uses real reviews, imported Anki rows and Play answers that moved the schedule; not other Play rows', () => {
  const T = i => NOW - (10 - i) * DAY;
  const rows = [
    { id: 1, timestamp: T(0), source: 'review', rating: 3, state: 0 },
    { id: 2, timestamp: T(1), source: 'play', applied: false, rating: 1, state: 2 },       // practice only: ignored
    { id: 3, timestamp: T(2), source: 'play', applied: true, rating: 3, state: 2 },       // moved the schedule: counted
    { id: 4, timestamp: T(5), source: 'anki', rating: 3, state: 2 },
    { id: 5, timestamp: T(6), source: 'mystery', rating: 3, state: 2 },                    // unknown source: ignored
    { id: 6, timestamp: T(7), source: 'review', rating: 0, state: 2 }                       // not a rating: ignored
  ];
  const m = replayRows(W7_DEFAULT, rows.map(r => ({ cardId: 'c1', ...r })), T(5));
  const expected = replay7(W7_DEFAULT, [{ t: 0, g: 3 }, { t: 2, g: 3 }, { t: 3, g: 3 }]);
  assert.deepEqual(m, expected);
});

test('migration: a reset restarts the history; a log that does not start at new, or stops short of the last review, is not used', () => {
  const T = i => NOW - (10 - i) * DAY;
  const reset = [
    { id: 1, timestamp: T(0), source: 'review', rating: 3, state: 0 },
    { id: 2, timestamp: T(3), source: 'review', rating: 1, state: 2 },
    { id: 3, timestamp: T(4), source: 'review', rating: 3, state: 0 },                      // "Reset to new", answered again
    { id: 4, timestamp: T(6), source: 'review', rating: 3, state: 2 }
  ];
  reset.forEach(r => { r.cardId = 'c1'; });
  assert.deepEqual(replayRows(W7_DEFAULT, reset, T(6)), replay7(W7_DEFAULT, [{ t: 0, g: 3 }, { t: 2, g: 3 }]));
  assert.equal(replayRows(W7_DEFAULT, [{ id: 1, cardId: 'c1', timestamp: T(2), source: 'review', rating: 3, state: 2 }], T(2)), null);   // starts mid-life
  assert.equal(replayRows(W7_DEFAULT, reset, T(9)), null);                                  // the card was reviewed later than the log says
  assert.equal(replayRows(W7_DEFAULT, [], T(1)), null);
  // a first row with no state counts as "new" only when nothing at all came before it (even a row that is not used)
  const bare = { cardId: 'c1', source: 'review', rating: 3 };
  assert.deepEqual(replayRows(W7_DEFAULT, [{ ...bare, id: 1, timestamp: T(2) }, { ...bare, id: 2, timestamp: T(4), state: 2 }], T(4)), replay7(W7_DEFAULT, [{ t: 0, g: 3 }, { t: 2, g: 3 }]));
  assert.equal(replayRows(W7_DEFAULT, [{ cardId: 'c1', id: 0, timestamp: T(1), source: 'play', applied: false, rating: 3, state: 2 }, { ...bare, id: 1, timestamp: T(2) }], T(2)), null);
});

test('sync and backup: a card state with FSRS-7 fields goes out and comes back unchanged (unknown fields are not dropped)', () => {
  const st = withSeven({ ...six, updatedAt: 77 }, { stability: 9, stabilityFast: 4, difficulty: 5 });
  const row = rowFromRecord('cardStates', st);
  assert.deepEqual(row.data.fsrs7, st.fsrs7);
  assert.equal(row.id, 'c1');
  const back = recordFromRow({ ...row, updated_at: 78 });
  assert.deepEqual(back.fsrs7, st.fsrs7);
  assert.equal(back.stability, 12);                                                       // the FSRS-6 memory travels with it
});

// ---------- exam maths ----------
test('exam: with the FSRS-7 model a card\'s FSRS-7 memory sets the curve; with FSRS-6 (or a stale memory) the FSRS-6 stability does', () => {
  const m = { stability: 30, stabilityFast: 3, difficulty: 5 };
  const st = withSeven({ ...six, stability: 12 }, m);
  const when = NOW + 20 * DAY;
  const model = { w20: undefined, w7: W7_DEFAULT };
  assert.ok(Math.abs(recallAt(st, when, model) - forgettingCurve7(W7_DEFAULT, m, 20)) < 1e-12);
  assert.equal(recallAt(st, when, undefined), recall(12, 20));                              // FSRS-6 mode ignores the FSRS-7 memory
  assert.equal(recallAt(st, when, 0.3), recall(12, 20, 0.3));
  // a card with no current FSRS-7 memory (stale, or never rated with FSRS-7) is read with the FSRS-7 curve from its seeded memory: the two curves are never mixed
  const stale = { ...st, lastReview: NOW + 1 };
  assert.ok(Math.abs(recallAt(stale, when, model) - forgettingCurve7(W7_DEFAULT, seedMemory(six), (when - (NOW + 1)) / DAY)) < 1e-12);
  assert.ok(Math.abs(recallAt(six, when, model) - forgettingCurve7(W7_DEFAULT, seedMemory(six), 20)) < 1e-12);
  assert.equal(recallAt(stale, when, undefined), recall(12, (when - (NOW + 1)) / DAY));            // FSRS-6 mode: the FSRS-6 curve
  assert.equal(recallFrom(7, 3, { w20: 0.3, w7: W7_DEFAULT }), recall(7, 3, 0.3));
  assert.equal(recallFrom({ stability: 7 }, 3, 0.3), recall(7, 3, 0.3));
});

test('exam: the gain of a review uses the memory after Good and Again', () => {
  const m = { stability: 5, stabilityFast: 1, difficulty: 5 };
  const st = withSeven({ ...six }, m);
  const good = nextState7(W7_DEFAULT, m, 1, 3), again = nextState7(W7_DEFAULT, m, 1, 1);
  const gain = examGainFrom(st, good, again, NOW + 30 * DAY, NOW + DAY, { w7: W7_DEFAULT });
  assert.ok(gain > 0 && gain < 1);
  assert.ok(gain >= examGainFrom(st, again, again, NOW + 30 * DAY, NOW + DAY, { w7: W7_DEFAULT }));
});

test('exam: examClamp reads a FSRS-7 card\'s memory (a card that stays above 99% on exam day is left alone)', () => {
  const strong = { stability: 4000, stabilityFast: 4000, difficulty: 3 };
  const weak = { stability: 3, stabilityFast: 0.5, difficulty: 8 };
  const base = { fsrsVersion: 7, maxDue: NOW + 20 * DAY, w7: W7_DEFAULT };
  const mk = memory => ({ due: new Date(NOW + 25 * DAY), stability: 12, scheduled_days: 25, fsrs7: memory });
  assert.equal(examClamp(mk(strong), NOW, base).due.getTime(), NOW + 25 * DAY);
  assert.ok(examClamp(mk(weak), NOW, base).due.getTime() < NOW + 20 * DAY);
});

// ---------- routing in srs.js (needs ts-fsrs 5.4.2) ----------
const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
if (skip) console.warn('\n*** ts-fsrs not installed: the FSRS-7 routing tests in fsrs7.test.js are SKIPPED. Run `npm install`. ***\n');
if (!skip) register('./sim/loader.mjs', import.meta.url);
const srs = () => import('../js/srs.js');
const optsFor = (settings, extra = {}) => ({ ...schedulerOptions({ fuzz: false, ...settings }), ...extra });

test('routing: FSRS-6 mode is untouched (no FSRS-7 fields) and FSRS-7 mode saves the memory with the review', { skip }, async () => {
  const { rate } = await srs();
  const a = rate('c1', null, 3, optsFor({}), NOW);
  assert.ok(!('fsrs7' in a));
  assert.equal(a.state, LEARNING);                                                   // FSRS-6: the 10 minute step
  const b = rate('c1', null, 3, optsFor({ fsrsVersion: 7 }), NOW);
  assert.equal(b.state, REVIEW);                                                     // FSRS-7: the model's interval (about 5 days)
  assert.ok(Math.abs((b.due - NOW) / DAY - 4.78) < 0.02);
  assert.equal(b.fsrs7.at, NOW);
  assert.deepEqual(cleanMemory7(b.fsrs7), { stability: b.fsrs7.stability, stabilityFast: b.fsrs7.stabilityFast, difficulty: b.fsrs7.difficulty });
  assert.ok(b.stability > 0 && b.difficulty >= 1);                                   // the FSRS-6 memory is there too
  assert.equal(b.cardId, 'c1');
  assert.equal(b.lastReview, NOW);
  assert.equal(b.reps, 1);
});

test('routing: the FSRS-6 fields follow the same path whichever scheduler ran (so switching back is lossless)', { skip }, async () => {
  const { rate } = await srs();
  // The same ratings at the same times, once in FSRS-6 mode and once in FSRS-7 mode (the due dates differ, so each answer is "at" a fixed time).
  const plan = [[0, 3], [DAY, 3], [3 * DAY, 2], [9 * DAY, 3], [11 * DAY, 1], [12 * DAY, 3], [20 * DAY, 4]];
  let s6 = null, s7 = null;
  for (const [dt, g] of plan) {
    const now = NOW + dt;
    s6 = rate('c1', s6, g, optsFor({}), now);
    s7 = rate('c1', s7, g, optsFor({ fsrsVersion: 7 }), now);
    assert.ok(Math.abs(s6.stability - s7.stability) < 1e-9 * Math.max(1, s6.stability), `stability after ${dt / DAY}d`);
    assert.ok(Math.abs(s6.difficulty - s7.difficulty) < 1e-9, `difficulty after ${dt / DAY}d`);
    assert.equal(s7.lastReview, now);
  }
});

test('routing: switching on with FSRS-6 history, rating, switching back, and on again', { skip }, async () => {
  const { rate, prepare7: prep } = await srs();
  clearRebuilt();
  // FSRS-6 history for a card: three reviews, logged the way Review logs them.
  const times = [NOW, NOW + 2 * DAY, NOW + 7 * DAY];
  let st = null;
  const rows = [];
  for (const [i, t] of times.entries()) {
    rows.push({ id: i + 1, cardId: 'c1', timestamp: t, source: 'review', rating: 3, state: st ? st.state : 0 });
    st = rate('c1', st, 3, optsFor({}), t);
  }
  assert.ok(!('fsrs7' in st));
  // switch on: the first FSRS-7 review rebuilds the memory from the log
  const t4 = NOW + 15 * DAY;
  await prep([st], async () => rows);
  assert.ok(wasReplayed(st));
  const on = rate('c1', st, 3, optsFor({ fsrsVersion: 7 }), t4);
  const expected = replay7(W7_DEFAULT, [{ t: 0, g: 3 }, { t: 2, g: 3 }, { t: 5, g: 3 }, { t: 8, g: 3 }]);
  for (const k of ['stability', 'stabilityFast', 'difficulty']) assert.ok(Math.abs(on.fsrs7[k] - expected[k]) < 1e-6, k);
  assert.equal(on.reps, st.reps + 1);
  // switch back: FSRS-6 carries on from its own fields; the state it writes has no FSRS-7 memory (it would be stale)
  const back = rate('c1', on, 3, optsFor({}), t4 + 10 * DAY);
  assert.ok(!('fsrs7' in back));
  assert.ok(back.stability > on.stability);
  // switch on again: the memory is stale (an FSRS-6 review since), so it is rebuilt from the log again, now with 5 rows
  assert.equal(savedMemory(back), null);
  const rows2 = [...rows, { id: 4, cardId: 'c1', timestamp: t4, source: 'review', rating: 3, state: 2 }, { id: 5, cardId: 'c1', timestamp: t4 + 10 * DAY, source: 'review', rating: 3, state: 2 }];
  await prep([back], async () => rows2);
  assert.ok(wasReplayed(back));
  const again = rate('c1', back, 3, optsFor({ fsrsVersion: 7 }), t4 + 20 * DAY);
  assert.ok(again.fsrs7.stability > 0);
  clearRebuilt();
});

test('routing: a new card\'s preview (given its id) shows the interval rate() uses, with fuzz on', { skip }, async () => {
  const { rate, previewIntervals } = await srs();
  const opts = optsFor({ fsrsVersion: 7, fuzz: true });
  for (const id of ['a', 'b', 'card-17', 'zz']) {
    const ivl = previewIntervals(null, opts, NOW, id);
    const real = rate(id, null, 3, opts, NOW);
    assert.ok(Math.abs((real.due - NOW) - ivl[3]) < 2, id);
    assert.equal(Number.isInteger(real.scheduledDays), true);                       // fuzz picks whole days from 2.5 days up
  }
});

test('routing: two sets of scheduler options in turn (one rating with and without fuzz) give the same answers as each alone', { skip }, async () => {
  const { rate } = await srs();
  const a = optsFor({ fuzz: true }), b = optsFor({ fuzz: false });
  const alone = [rate('c', null, 3, a, NOW), rate('c', null, 3, b, NOW)];
  const mixed = [rate('c', null, 3, a, NOW), rate('c', null, 3, b, NOW), rate('c', null, 3, a, NOW), rate('c', null, 3, b, NOW)];
  assert.deepEqual([mixed[0], mixed[1]], alone);
  assert.deepEqual([mixed[2], mixed[3]], alone);
});

test('routing: previews, the maximum interval, balancing and the exam all work in FSRS-7 mode', { skip }, async () => {
  const { rate, previewIntervals, examGain } = await srs();
  const opts = optsFor({ fsrsVersion: 7 });
  const ivl = previewIntervals(null, opts, NOW);
  assert.ok(ivl[1] < ivl[2] && ivl[2] < ivl[3] && ivl[3] < ivl[4]);
  assert.equal(ivl[1], 60000);                                                       // Again: the 1 minute step
  // the interval shown is the interval used
  const b = rate('c1', null, 3, opts, NOW);
  assert.ok(Math.abs((b.due - NOW) - ivl[3]) < 2);
  // a maximum interval of 2 days
  const capped = rate('c1', b, 4, optsFor({ fsrsVersion: 7, maxInterval: 2 }), NOW + 5 * DAY);
  assert.ok((capped.due - (NOW + 5 * DAY)) / DAY <= 2 + 1e-9);
  // balancing (fuzz on): the gap is moved to a whole number of days around the model's
  const load = new Map();
  const balanced = rate('c1', b, 3, { ...optsFor({ fsrsVersion: 7, fuzz: true }), balance: { load, easyDays: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal'] } }, NOW + 5 * DAY);
  assert.equal(balanced.state, REVIEW);
  assert.ok(balanced.scheduledDays >= 3 && Number.isInteger(balanced.scheduledDays));       // a whole number of days, picked by balance.js
  assert.equal(load.size, 1);
  // an exam in 40 days: the gain of a review is a probability change
  const exam = NOW + 40 * DAY;
  const g = examGain(b, exam, NOW + DAY, { ...opts, w7: undefined });
  assert.ok(Number.isFinite(g) && Math.abs(g) < 1);
  // an exam soon pulls a card with a long gap in
  const examOpts = { ...optsFor({ fsrsVersion: 7 }), maxDue: NOW + 6 * DAY };
  const pulled = rate('c1', b, 3, examOpts, NOW + DAY);
  assert.ok(pulled.due < NOW + 6 * DAY);                                              // brought forward to before the exam
});
