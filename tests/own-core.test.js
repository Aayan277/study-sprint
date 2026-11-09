// Own's engine room: opening and staleness, the shadow record lifecycle, undo, plans, the daily check and the switch, the error rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnCore } from '../js/own-core.js';
import { Engine } from '../js/own-engine.js';
import { initParams } from '../js/own-model.js';
import { parseOwnFile } from '../js/own-file.js';
import { openOwnDb } from '../js/own-db.js';
import { fingerprintOf } from '../js/own-shadow.js';
import { studyDay } from '../js/own-rows.js';
import { DAY, T0, DECKS, CARDS, loadedIdb, setSettings, history, rowsOf, slim, reviewAt, clock, modelBytes } from './own-helpers.mjs';

async function fresh({ on = true, n = 6, clk = clock() } = {}) {
  const idb = await loadedIdb();
  if (on) await setSettings(idb, { on: true, autoLocked: false });
  const core = new OwnCore({ idb, now: clk.now });
  const logs = history(n);
  await core.handle('open', {});
  if (on) await core.handle('setOn', { on: true });
  await core.handle('rebuild', { rows: rowsOf(logs) });
  return { idb, core, logs, clk };
}
const records = async core => (await core._do(h => h.getAll('preds'))).sort((a, b) => a.logId - b.logId);
const answer = (core, log, extra = {}) => core.handle('answer', { log: slim(log), card: CARDS.find(c => c.id === log.cardId), decks: DECKS, pFsrs: 0.8, fsrsKind: 6, ...extra });

test('a rebuilt memory is saved and a new engine room opens it as fresh, with the same plans', async () => {
  const { idb, core, logs } = await fresh();
  const fp = fingerprintOf(rowsOf(logs));
  const args = { card: CARDS[0], decks: DECKS, now: T0 + 14 * DAY, ms: 5000, target: 0.9, maxDays: 36500 };
  const before = await core.handle('plan', args);
  assert.ok(before.days);
  const other = new OwnCore({ idb });
  const o = await other.handle('open', { fp });
  assert.equal(o.fresh, true);
  assert.deepEqual(await other.handle('plan', args), before);
});

test('a log that changed (rows, or a different model) makes the saved memory out of date: no plans', async () => {
  const { idb, logs } = await fresh();
  const fp = fingerprintOf(rowsOf(logs));
  const a = new OwnCore({ idb });
  assert.equal((await a.handle('open', { fp: { ...fp, rows: fp.rows + 1 } })).status, 'stale');
  assert.deepEqual(await a.handle('plan', { card: CARDS[0], decks: DECKS, now: T0 + 14 * DAY, ms: 5000, target: 0.9, maxDays: 365 }), { fail: 'stale' });
  const b = new OwnCore({ idb });
  assert.equal((await b.handle('open', { fp: { ...fp, idSum: fp.idSum + 1 } })).fresh, false);
  // another model file: same log, but the memory belongs to the old model
  const { loadModelFile } = await import('../js/own-load.js');
  const { fileOf } = await import('./own-helpers.mjs');
  await loadModelFile(fileOf(modelBytes(9), 'other.own'), { idb });
  const c = new OwnCore({ idb });
  assert.equal((await c.handle('open', { fp })).fresh, false);
});

test('shadow record lifecycle: numbers fixed first (y not known), then y filled; pOwn is the engine\'s own pre-answer prediction', async () => {
  const { core, logs } = await fresh();
  const writes = [];
  const h = await core._db(), put = h.put;
  h.put = (store, key, value) => { if (store === 'preds') writes.push(value.y); return put(store, key, value); };
  const log = reviewAt(1000, 'a', 12);
  const r = await answer(core, log);
  assert.deepEqual(r, { row: true, record: true });
  assert.deepEqual(writes, [null, 1]);
  const [rec] = await records(core);
  assert.equal(rec.logId, 1000); assert.equal(rec.cardId, 'a'); assert.equal(rec.y, 1); assert.equal(rec.pFsrs, 0.8);
  assert.equal(rec.sched, 'fsrs'); assert.equal(rec.fsrsKind, 6); assert.equal(rec.tuneId, null);
  assert.equal(rec.modelSha.length, 64); assert.equal(rec.day, studyDay(rec.t)); assert.equal(rec.t, log.timestamp);
  // the same prediction from a fresh engine that replays the same history and is asked the same row
  const params = parseOwnFile(modelBytes()).params;
  const e = new Engine(params); for (const _ of e.replay(rowsOf(logs))); /* eslint-disable-line */
  const want = e.review(rowsOf([...logs, log]).at(-1), { score: true, keepToken: false }).pCurve;
  assert.equal(rec.pOwn, want);
  assert.ok(rec.pOwn > 0 && rec.pOwn < 1);
  assert.ok(rec.elapsedDays >= 1);
});

test('a forgotten answer (Again) is y = 0; a record is kept for each scored review', async () => {
  const { core } = await fresh();
  await answer(core, reviewAt(1001, 'a', 12, { rating: 1 }));
  await answer(core, reviewAt(1002, 'b', 12, { rating: 4 }));
  assert.deepEqual((await records(core)).map(r => [r.logId, r.y]), [[1001, 0], [1002, 1]]);
});

test('no record for: a first answer, a same-day repeat, a card not in Review, Play or test answers, a missing FSRS number, or Own switched off', async () => {
  const { core } = await fresh();
  const none = async (log, extra) => { const r = await answer(core, log, extra); assert.equal(r.record, false, JSON.stringify(log)); };
  await none({ id: 2001, cardId: 'new', timestamp: T0 + 12 * DAY, source: 'review', rating: 3, ms: 3000, state: 0 });     // first answer of a card
  await answer(core, reviewAt(2003, 'a', 12));                                               // scored: record
  await none(reviewAt(2004, 'a', 12 + 0.01));                                                // same study day as 2003
  await none(reviewAt(2005, 'b', 12, { state: 1 }));                                         // card was in learning
  await none(reviewAt(2006, 'b', 12, { source: 'play', applied: true }));                    // Play: memory only
  await none(reviewAt(2007, 'c', 12), { pFsrs: null });                                      // no FSRS number
  await none(reviewAt(2008, 'c', 12), { memoryOnly: true });
  const ids = (await records(core)).map(r => r.logId);
  assert.deepEqual(ids, [2003]);
  await core.handle('setOn', { on: false });
  await none(reviewAt(2009, 'a', 20));
});

test('a Play answer that only logged (not applied) never reaches the memory; an applied one changes the memory but makes no record', async () => {
  const { core } = await fresh();
  const rows0 = core.fp.rows;
  assert.deepEqual(await answer(core, reviewAt(3001, 'a', 12, { source: 'play', applied: false })), { row: false, record: false });
  assert.equal(core.fp.rows, rows0);
  assert.deepEqual(await answer(core, reviewAt(3002, 'a', 12, { source: 'play', applied: true }), { memoryOnly: true }), { row: true, record: false });
  assert.equal(core.fp.rows, rows0 + 1);
  assert.deepEqual(await records(core), []);
});

test('undo gives back the exact states, the fingerprint and removes the record; an answer that was only logged has nothing to undo', async () => {
  const { core } = await fresh();
  const snap = () => JSON.stringify(core.engine.toJSON()), fp = JSON.stringify(core.fp);
  const before = snap();
  await answer(core, reviewAt(4001, 'a', 12));
  assert.notEqual(snap(), before);
  assert.equal((await records(core)).length, 1);
  assert.deepEqual(await core.handle('undo', { logId: 4001 }), { ok: true, undone: true });
  assert.equal(snap(), before);
  assert.equal(JSON.stringify(core.fp), fp);
  assert.deepEqual(await records(core), []);
  await answer(core, reviewAt(4002, 'a', 12, { source: 'play', applied: false }));
  assert.deepEqual(await core.handle('undo', { logId: 4002 }), { ok: true, undone: false });
  assert.equal(core.status, 'fresh');
});

test('an answer that cannot be rolled back exactly makes the memory out of date (rebuilt later)', async () => {
  const { core } = await fresh();
  await answer(core, reviewAt(4101, 'a', 12));
  await answer(core, reviewAt(4102, 'b', 12));
  const r = await core.handle('undo', { logId: 4101 });       // not the newest
  assert.equal(r.stale, true);
  assert.equal(core.status, 'stale');
  assert.deepEqual((await records(core)).map(r => r.logId), [4102]);           // (the undone answer's record is gone)
});

test('while the memory is out of date or rebuilding: no records, no plans (a plan during a rebuild is skipped at once)', async () => {
  const { core } = await fresh();
  await core.handle('stale');
  assert.equal(core.status, 'stale');
  assert.equal((await answer(core, reviewAt(5001, 'a', 12))).record, false);
  const args = { card: CARDS[0], decks: DECKS, now: T0 + 14 * DAY, ms: 5000, target: 0.9, maxDays: 365 };
  assert.deepEqual(await core.handle('plan', args), { fail: 'stale' });
  core.status = 'rebuilding';
  assert.deepEqual(await core.handle('plan', args), { skip: 'rebuilding' });
});

test('a plan gives whole days for Hard, Good and Easy, never decreasing, capped; an unknown card or bad target is a failed plan', async () => {
  const { core } = await fresh();
  const args = { card: CARDS[0], decks: DECKS, now: T0 + 14 * DAY, ms: 5000, target: 0.9, maxDays: 36500 };
  const p = await core.handle('plan', args);
  assert.ok(p.days[2] >= 1 && p.days[3] >= p.days[2] && p.days[4] >= p.days[3]);
  const capped = await core.handle('plan', { ...args, maxDays: 5000 });
  assert.ok(capped.days[4] <= 3650);
  assert.deepEqual(await core.handle('plan', { ...args, card: { id: 'zzz', deckId: 'd', noteId: 'nz' } }), { fail: 'unknown-card' });
  assert.deepEqual(await core.handle('plan', { ...args, target: 2 }), { fail: 'bad-numbers' });
});

// ---------- the daily check and the switch ----------
function synthetic(core, n, { ownBetter = true, cards = 60, from = 0 } = {}) {
  let a = 7; const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const sha = core.model.sha256, recs = [];
  for (let i = 0; i < n; i++) {
    const p = 0.5 + 0.4 * rnd(), y = rnd() < p ? 1 : 0;
    recs.push([from + i, { logId: from + i, cardId: 'x' + (i % cards), t: core.state.watchT + 1 + i, day: 0, elapsedDays: 5, pOwn: p + (ownBetter ? 0 : 0.1), pFsrs: p + (ownBetter ? 0.1 : 0), y, sched: 'fsrs', fsrsKind: 6, modelSha: sha, tuneId: null }]);
  }
  return core._do(h => h.putEntries('preds', recs));
}

test('the daily check: nothing before enough records; Better twice (days may be apart) switches to Own, with a one-time notice', async () => {
  const { core, clk } = await fresh();
  const s0 = await core.handle('check', {});
  assert.equal(s0.ran, true); assert.equal(s0.verdict.status, 'few'); assert.equal(s0.scheduler, 'fsrs');
  assert.equal((await core.handle('check', {})).ran, false);                 // once per study day
  await synthetic(core, 400);
  core.fp = { ...core.fp, scored: 5000 };
  core.state = { ...core.state, watchDay: Math.floor(clk.t / DAY) - 30 };
  clk.advance(2);                                                             // every other day is fine
  let s = await core.handle('check', {});
  assert.equal(s.verdict.status, 'better'); assert.equal(s.scheduler, 'fsrs'); assert.equal(s.switched, null);
  clk.advance(2);
  s = await core.handle('check', {});
  assert.equal(s.scheduler, 'own'); assert.deepEqual(s.switched, { to: 'own', why: 'better' });
  assert.equal(s.noticePending, 1);
  await core.handle('dismissNotice');
  assert.equal((await core.handle('status')).noticePending, null);
  // saved: a new engine room reads the same state
  assert.equal((await new OwnCore({ idb: core.idb, now: clk.now }).handle('status')).scheduler, 'own');
});

test('"Check now" refreshes the verdict but does not run the daily switch rule twice in a day', async () => {
  const { core, clk } = await fresh();
  await synthetic(core, 400);
  core.fp = { ...core.fp, scored: 5000 };
  core.state = { ...core.state, watchDay: Math.floor(clk.t / DAY) - 30 };
  await core.handle('check', {});
  const s = await core.handle('check', { force: true });
  assert.equal(s.ran, false); assert.equal(s.verdict.status, 'better'); assert.equal(s.verdicts.length, 1);
});

test('records of another model, or from before the watch started, do not count', async () => {
  const { core, clk } = await fresh();
  await synthetic(core, 50);
  await core._do(h => h.putEntries('preds', [[9999, { logId: 9999, cardId: 'q', t: T0, y: 1, pOwn: 0.5, pFsrs: 0.5, modelSha: 'other' }], [9998, { logId: 9998, cardId: 'q', t: 1, y: 1, pOwn: 0.5, pFsrs: 0.5, modelSha: core.model.sha256 }], [9997, { logId: 9997, cardId: 'q', t: core.state.watchT + 5, y: null, pOwn: 0.5, pFsrs: 0.5, modelSha: core.model.sha256 }]]));
  assert.equal((await core.handle('status')).records, 50);
  assert.ok(clk.t);
});

test('turning Own off while it schedules goes back to FSRS at once (no notice); turning it on starts a fresh state', async () => {
  const { core, clk } = await fresh();
  core.state = { ...core.state, scheduler: 'own', switches: [{ day: 5, to: 'own', why: 'better' }], noticePending: 1 };
  const off = await core.handle('setOn', { on: false });
  assert.equal(off.scheduler, 'fsrs');
  const s = await core.handle('status');
  assert.equal(s.on, false); assert.equal(s.noticePending, null); assert.equal(s.switches.at(-1).why, 'off');
  await core.handle('setOn', { on: true });
  const s2 = await core.handle('status');
  assert.equal(s2.on, true); assert.deepEqual(s2.switches, []); assert.equal(s2.autoLocked, false);
  assert.ok(clk);
});

test('plan errors: more than 5% of at least 20 plans in a day goes back to FSRS at once and pauses; fewer than 20 cannot', async () => {
  const { core } = await fresh();
  core.state = { ...core.state, scheduler: 'own', switches: [{ day: 1, to: 'own', why: 'better' }] };
  for (let i = 0; i < 19; i++) await core.handle('notePlan', { ok: false });
  assert.equal(core.state.scheduler, 'own');                                  // 19 plans, all failed: too few to trip
  const r = await core.handle('notePlan', { ok: false });                    // the 20th
  assert.equal(r.scheduler, 'fsrs');
  const s = await core.handle('status');
  assert.equal(s.paused, true); assert.equal(s.fallbacks, 20); assert.equal(s.switches.at(-1).why, 'error');
  // 20 plans with exactly one failure (5%) is fine
  const f = await fresh();
  f.core.state = { ...f.core.state, scheduler: 'own', switches: [{ day: 1, to: 'own', why: 'better' }] };
  await f.core.handle('notePlan', { ok: false });
  for (let i = 0; i < 19; i++) await f.core.handle('notePlan', { ok: true });
  assert.equal(f.core.state.scheduler, 'own');
});

test('no database: every call answers and nothing is created', async () => {
  const { makeFakeIdb } = await import('./own-idb-fake.mjs');
  const idb = makeFakeIdb(), core = new OwnCore({ idb });
  assert.equal((await core.handle('open', { fp: { rows: 0, idSum: 0 } })).loaded, false);
  assert.equal((await core.handle('status')).loaded, false);
  assert.equal((await core.handle('check', {})).ran, false);
  assert.equal((await core.handle('setOn', { on: true })).ok, false);
  assert.equal(idb.dbs.size, 0);
  assert.ok(openOwnDb && initParams);
});
