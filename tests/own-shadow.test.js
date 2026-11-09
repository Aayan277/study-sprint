// The page's side of Own: no model or switch off means nothing happens and nothing is created; the shadow flow from the first
// card to a stored record; plans and how they are counted; Play stays on FSRS; reviews from sync only change the memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OwnClient, fingerprintOf, recentMs } from '../js/own-shadow.js';
import { OwnCore } from '../js/own-core.js';
import { ownModule, resetOwnGate } from '../js/own-gate.js';
import { makeFakeIdb } from './own-idb-fake.mjs';
import { poke, DAY, T0, DECKS, CARDS, loadedIdb, setSettings, history, rowsOf, reviewAt, clock } from './own-helpers.mjs';

// A client wired to a stand-in database and a review log you can add to. calls: every message sent to the engine room.
function makeClient(idb, { logs = history(6), clk = clock() } = {}) {
  const calls = [], core = new OwnCore({ idb, now: clk.now }), state = { logs: [...logs] };
  const client = new OwnClient({
    now: clk.now, idb,
    source: { read: async () => ({ logs: state.logs, cards: CARDS, decks: DECKS }), cardLogs: async id => state.logs.filter(l => l.cardId === id) },
    makeTransport: () => ({ call: (type, payload, ms, onProgress) => { calls.push(type); return core.handle(type, payload, onProgress); }, stop() {} })
  });
  return { client, calls, core, state, clk };
}
const recordsOf = core => core._do(h => h.getAll('preds'));
const planArgs = (client, over = {}) => ({ card: CARDS[0], state: { state: 2, lastReview: T0 + 10 * DAY }, now: T0 + 14 * DAY, opts: { retention: 0.9, maxInterval: 36500 }, decks: DECKS, ...over });

// ---------- no model, or switched off: no extra work ----------
test('no Own database: the gate says no, nothing is opened for writing and nothing is created', async () => {
  const idb = makeFakeIdb();
  resetOwnGate();
  assert.equal(await ownModule({ idb }), null);
  assert.equal(idb.dbs.size, 0);
  const { client, calls } = makeClient(idb);
  assert.equal(await client.begin(), false);
  assert.equal(client.isPlanning(), false);
  assert.equal(idb.dbs.size, 0);
  assert.deepEqual(calls, ['open']);                          // one look, then nothing
  assert.deepEqual(await client.plan(planArgs(client)), null);   // (not ready: not asked for in practice, see review.js)
  assert.equal((await client.status()).loaded, false);
  assert.equal(idb.dbs.size, 0);
  resetOwnGate();
});

test('a model is loaded but the switch is off: the gate says no (no Own code is loaded) and nothing runs', async () => {
  const idb = await loadedIdb();
  resetOwnGate();
  assert.equal(await ownModule({ idb }), null);
  const { client, calls, core } = makeClient(idb);
  assert.equal(await client.begin(), false);
  assert.deepEqual(calls, ['open']);                          // the history is never read, nothing is rebuilt
  assert.equal(core.engine, null);
  assert.deepEqual(await recordsOf(core), []);
  resetOwnGate();
});

test('switched on: the gate hands over the Own code', async () => {
  const idb = await loadedIdb();
  await setSettings(idb, { on: true, autoLocked: false });
  resetOwnGate();
  const m = await ownModule({ idb });
  assert.equal(typeof m.afterAnswer, 'function'); assert.equal(typeof m.plan, 'function'); assert.equal(typeof m.ownStatus, 'function');
  resetOwnGate();
});

// ---------- the flow ----------
test('turning on builds the memory; the next session finds it ready and does not rebuild', async () => {
  const idb = await loadedIdb(), clk = clock();
  const a = makeClient(idb, { clk });
  assert.equal((await a.client.setOn(true)).ok, true);
  assert.equal(await a.client.begin(), true);
  assert.equal(a.calls.filter(c => c === 'rebuild').length, 1);
  assert.equal(a.client.isPlanning(), false);                // watching only: FSRS schedules
  const b = makeClient(idb, { clk });
  assert.equal(await b.client.begin(), true);
  assert.equal(b.calls.filter(c => c === 'rebuild').length, 0);
  assert.equal(b.core.status, 'fresh');
  resetOwnGate();
});

test('shadow flow: answers make records with both numbers and y; Undo removes the record', async () => {
  const idb = await loadedIdb(), { client, core, state } = makeClient(idb, { clk: clock(T0 + 11 * DAY) });
  await client.setOn(true); await client.begin();
  const log = reviewAt(100, 'a', 12);
  await client.afterAnswer({ logId: 100, log, card: CARDS[0], decks: DECKS, pFsrs: 0.9, fsrsKind: 7 });
  let recs = await recordsOf(core);
  assert.equal(recs.length, 1); assert.equal(recs[0].fsrsKind, 7); assert.equal(recs[0].pFsrs, 0.9); assert.equal(recs[0].y, 1);
  assert.equal((await client.status()).records, 1);
  await client.afterUndo(100);
  assert.deepEqual(await recordsOf(core), []);
  assert.ok(state);
});

test('Play answers only change the memory: no record, even for a card in Review (Play always stays on FSRS)', async () => {
  const idb = await loadedIdb(), { client, core } = makeClient(idb);
  await client.setOn(true); await client.begin();
  const rows0 = core.fp.rows;
  await client.afterAnswer({ logId: 200, log: reviewAt(200, 'a', 12, { source: 'play', applied: true }), card: CARDS[0], decks: DECKS, pFsrs: 0.9, memoryOnly: true });
  assert.equal(core.fp.rows, rows0 + 1);
  assert.deepEqual(await recordsOf(core), []);
});

test('Play and the practice test never ask Own for a plan and never hand a plan to the scheduler', () => {
  for (const f of ['js/play.js', 'js/practice-save.js', 'js/mock-exam.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.equal(/ownPlan|isPlanning|\.plan\(|preparePlan|settlePlan/.test(src), false, f);
  }
  const ps = readFileSync(new URL('../js/practice-save.js', import.meta.url), 'utf8');
  assert.match(ps, /memoryOnly: true/);
});

test('plans: only while Own schedules; a plan is made from the saved memory and counts when settled', async () => {
  const idb = await loadedIdb(), { client, core } = makeClient(idb);
  await client.setOn(true); await client.begin();
  await poke(core, { scheduler: 'own' }); client.scheduler = 'own';
  const plan = await client.plan(planArgs(client));
  assert.deepEqual(Object.keys(plan.days), ['2', '3', '4']);
  assert.equal(plan.cardId, 'a'); assert.equal(plan.lastReview, T0 + 10 * DAY); assert.equal(plan.at, T0 + 14 * DAY); assert.equal(plan.modelSha.length, 64);
  assert.equal(client.settled(plan), plan);
  assert.equal(client.settled(null), null);                  // a missing plan: FSRS, counted as failed
  assert.equal(client.settled({ skip: true }), null);        // starting up: not counted
  await client._counter().call('flush', {});
  const s = await client.status();
  assert.deepEqual([s.plansToday.total, s.plansToday.failed, s.fallbacks], [2, 1, 1]);
  // a card that is not in review is never planned
  assert.equal(await client.plan(planArgs(client, { state: { state: 1, lastReview: 1 } })), null);
  assert.ok(core);
});

test('too many failed plans in a day send Own back to FSRS through the page too', async () => {
  const idb = await loadedIdb(), { client, core } = makeClient(idb);
  await client.setOn(true); await client.begin();
  await poke(core, { scheduler: 'own', switches: [{ day: 1, to: 'own', why: 'better' }] }); client.scheduler = 'own';
  for (let i = 0; i < 20; i++) client.settled(null);
  await client.status(); await new Promise(r => setTimeout(r, 0));       // (the status call waits behind the 20 notes in the queue)
  assert.equal(client.isPlanning(), false);
  assert.equal((await client.status()).paused, true);
});

test('a worker that is gone: plans fail (and count), answers are skipped, FSRS carries on, the next session tries again', async () => {
  const idb = await loadedIdb(), clk = clock();
  const core = new OwnCore({ idb, now: clk.now });
  let broken = false, fail;
  const client = new OwnClient({ now: clk.now, idb, source: { read: async () => ({ logs: history(6), cards: CARDS, decks: DECKS }), cardLogs: async () => [] },
    makeTransport: onFail => { fail = onFail; return { call: (t, p, ms, pr) => (broken ? Promise.reject(new Error('worker down')) : core.handle(t, p, pr)), stop() {} }; } });
  await client.setOn(true); await client.begin();
  client.scheduler = 'own';
  broken = true; fail(new Error('crash'));
  assert.equal(client.failed, true);
  assert.equal(await client.plan(planArgs(client)), null);
  client.settled(null);                                      // counted by the plain database work on the page
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await client.status()).plansToday.failed, 1);
  await client.afterAnswer({ logId: 300, log: reviewAt(300, 'a', 12), card: CARDS[0], decks: DECKS, pFsrs: 0.9 });     // does not throw
  assert.deepEqual(await recordsOf(core), []);
  broken = false;
  assert.equal(await client.begin(), true);                  // a new session starts the worker again
  assert.equal(client.failed, false);
});

test('a plan request that throws is a failed plan, not an error', async () => {
  const idb = await loadedIdb(), clk = clock();
  const core = new OwnCore({ idb, now: clk.now });
  const client = new OwnClient({ now: clk.now, idb, source: { read: async () => ({ logs: history(6), cards: CARDS, decks: DECKS }), cardLogs: async () => { throw new Error('db'); } },
    makeTransport: () => ({ call: (t, p, ms, pr) => core.handle(t, p, pr), stop() {} }) });
  await client.setOn(true); await client.begin(); client.scheduler = 'own';
  assert.equal(await client.plan(planArgs(client)), null);
});

// ---------- sync ----------
test('a review from another device only changes the memory (after a rebuild); it never makes a record; plans wait meanwhile', async () => {
  const idb = await loadedIdb(), { client, core, state } = makeClient(idb);
  await client.setOn(true); await client.begin();
  await poke(core, { scheduler: 'own' }); client.scheduler = 'own';
  const fp0 = core.fp.rows;
  state.logs.push(reviewAt(900, 'a', 12));                  // arrives by sync: it is in the log, nobody told Own about the answer
  await client.markStale();
  assert.equal(core.status, 'stale');
  assert.deepEqual(await client.plan(planArgs(client)), { skip: true });      // not counted as a failed plan
  await client.rebuild();
  assert.equal(core.status, 'fresh');
  assert.equal(core.fp.rows, fp0 + 1);
  assert.deepEqual(await recordsOf(core), []);
  assert.equal(typeof (await client.plan(planArgs(client))).days[3], 'number');
});

test('a sync that lands while a rebuild runs starts it once more', async () => {
  const idb = await loadedIdb(), { client, state } = makeClient(idb);
  await client.setOn(true); await client.begin();
  state.logs.push(reviewAt(901, 'a', 12));
  const first = client.rebuild();
  state.logs.push(reviewAt(902, 'b', 12));
  assert.equal(await client.rebuild(), null);               // (already running: asks for another round)
  await first;
  assert.equal(client.rebuildAgain, false);
  const fp = fingerprintOf(rowsOf(state.logs));
  assert.equal((await client.call('open', { fp })).fresh, true);
});

test('the rest of the app never names the Own database; sync only asks the gate', () => {
  const sync = readFileSync(new URL('../js/sync.js', import.meta.url), 'utf8');
  assert.match(sync, /own-gate\.js/); assert.equal(sync.includes('study-sprint-own'), false);
});

test('recentMs: the middle of the last five review times, 8 s when there are none', () => {
  assert.equal(recentMs([]), 8000);
  const l = ms => ({ source: 'review', ms, timestamp: ms });
  assert.equal(recentMs([l(1000), l(9000), l(5000)]), 5000);
  assert.equal(recentMs([{ source: 'play', ms: 99999, timestamp: 1 }]), 8000);
});
