// Fixes after the code review of the Own model: a new model file starts clean, two tabs share one database, a session re-checks the
// saved memory, an unknown card is a skip, and the database does not get looked up where the browser says there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnCore } from '../js/own-core.js';
import { OwnClient } from '../js/own-shadow.js';
import { loadModelFile } from '../js/own-load.js';
import { openOwnDb, deleteOwnDb, ownDbExists } from '../js/own-db.js';
import { wipeOwn, resetOwnGate, ownModule } from '../js/own-gate.js';
import { fingerprintOf } from '../js/own-shadow.js';
import { studyDay } from '../js/own-rows.js';
import { makeFakeIdb } from './own-idb-fake.mjs';
import { poke, DAY, T0, DECKS, CARDS, loadedIdb, setSettings, history, rowsOf, reviewAt, clock, modelBytes, fileOf } from './own-helpers.mjs';

async function room({ idb = null, clk = clock(), on = true } = {}) {
  idb ||= await loadedIdb();
  if (on) await setSettings(idb, { on: true, autoLocked: false });
  const core = new OwnCore({ idb, now: clk.now });
  await core.handle('open', {});
  if (on) await core.handle('setOn', { on: true });
  await core.handle('rebuild', { rows: rowsOf(history(6)) });
  return { idb, core, clk };
}
const planArgs = { card: CARDS[0], decks: DECKS, now: T0 + 14 * DAY, ms: 5000, target: 0.9, maxDays: 365 };
const stored = (idb, store, key) => openOwnDb({ idb }).then(async h => { try { return key === undefined ? await h.getAll(store) : await h.get(store, key); } finally { h.close(); } });

// ---------- 1. a different model file starts clean ----------
test('loading a different model file resets the state, the memory and the records; the same file changes nothing', async () => {
  const { idb, core, clk } = await room();
  await poke(core, { scheduler: 'own', switches: [{ day: 1, to: 'own', why: 'better' }], verdicts: [{ day: 1, status: 'better' }], autoLocked: true });
  await core._do(h => h.put('preds', null, { logId: 5, cardId: 'a', t: T0, y: 1, pOwn: 0.5, pFsrs: 0.5, modelSha: core.model.sha256 }));
  await setSettings(idb, { on: true, autoLocked: true });
  // the same file again: nothing is touched
  assert.equal((await loadModelFile(fileOf(modelBytes(3), 'same.own'), { idb })).ok, true);
  assert.equal((await stored(idb, 'meta', 'state')).scheduler, 'own');
  assert.equal((await stored(idb, 'preds')).length, 1);
  // another file
  const r = await loadModelFile(fileOf(modelBytes(9), 'other.own'), { idb });
  assert.equal(r.ok, true);
  assert.equal((await stored(idb, 'preds')).length, 0);
  assert.equal((await stored(idb, 'cards')).length, 0);
  const fresh = new OwnCore({ idb, now: clk.now });
  const s = await fresh.handle('status');
  assert.equal(s.scheduler, 'fsrs'); assert.deepEqual(s.switches, []); assert.deepEqual(s.verdicts, []); assert.equal(s.verdict, null);
  assert.equal(s.autoLocked, false); assert.equal(s.on, true); assert.equal(s.records, 0); assert.equal(s.watchDay, studyDay(clk.now()));        // watching starts from scratch today
  assert.equal(s.name, 'other.own');
  assert.equal((await fresh.handle('open', { fp: fingerprintOf(rowsOf(history(6))) })).fresh, false);   // the old memory is gone: it must be rebuilt
  assert.deepEqual(await fresh.handle('plan', planArgs), { fail: 'stale' });
  // the engine room that was running with the old model notices too (another tab)
  assert.deepEqual(await core.handle('plan', planArgs), { skip: 'changed' });
});

// ---------- 4. two tabs, one database ----------
test('two tabs: a plan stops when the other tab switched Own off, or removed the model', async () => {
  const { idb, core: a } = await room();
  const b = new OwnCore({ idb, now: a.now });
  await b.handle('open', { fp: fingerprintOf(rowsOf(history(6))) });
  assert.ok((await a.handle('plan', planArgs)).days);
  await b.handle('setOn', { on: false });
  assert.deepEqual(await a.handle('plan', planArgs), { skip: 'off' });
  await b.handle('setOn', { on: true });
  assert.ok((await a.handle('plan', planArgs)).days);
  await deleteOwnDb({ idb });
  assert.deepEqual(await a.handle('plan', planArgs), { skip: 'gone' });
  assert.equal((await a.handle('notePlan', { ok: false })).ok, false);
  assert.equal((await a.handle('status')).loaded, false);
  assert.equal((await a.handle('check', {})).ran, false);
  assert.equal(await ownDbExists({ idb }), false);                      // nothing was created again
});

test('two tabs: a note about a plan keeps what the other tab saved meanwhile (no stale overwrite)', async () => {
  const { idb, core: a } = await room();
  const b = new OwnCore({ idb, now: a.now });
  await b.handle('open', {});
  await poke(b, { verdicts: [{ day: 3, status: 'better' }], noticePending: 2, errors: 4 });
  await a.handle('notePlan', { ok: true });                              // a still holds the old copy in memory
  const st = await stored(idb, 'meta', 'state');
  assert.deepEqual(st.verdicts, [{ day: 3, status: 'better' }]); assert.equal(st.noticePending, 2); assert.equal(st.errors, 4);
  assert.equal(st.plans.total, 1);
  await a.handle('dismissNotice');
  assert.equal((await stored(idb, 'meta', 'state')).verdicts.length, 1);
  // the daily check also starts from what is saved
  await poke(b, { errors: 9 });
  await a.handle('check', { force: true });
  assert.equal((await stored(idb, 'meta', 'state')).errors, 9);
});

// ---------- 3. a session re-checks the memory; an unknown card is a skip ----------
function clientFor(idb, clk, logs) {
  const core = new OwnCore({ idb, now: clk.now }), calls = [];
  const client = new OwnClient({ now: clk.now, idb, source: { read: async () => ({ logs: logs.list, cards: CARDS, decks: DECKS }), cardLogs: async () => [] },
    makeTransport: () => ({ call: (t, p, ms, pr) => { calls.push(t); return core.handle(t, p, pr); }, stop() {} }) });
  return { client, core, calls };
}
test('begin() trusts the memory for the page load; begin({ session: true }) compares it with the log again', async () => {
  const idb = await loadedIdb(), clk = clock(), logs = { list: history(6) };
  await setSettings(idb, { on: true, autoLocked: false });
  const { client, calls } = clientFor(idb, clk, logs);
  assert.equal(await client.begin(), true);
  assert.equal(calls.filter(c => c === 'rebuild').length, 1);
  logs.list = [...logs.list, reviewAt(500, 'a', 12)];                   // a review the memory does not know of (sync, import, restore)
  await client.begin();
  assert.equal(calls.filter(c => c === 'rebuild').length, 1);          // same page load: not looked at again
  assert.equal(await client.begin({ session: true }), true);
  assert.equal(calls.filter(c => c === 'rebuild').length, 2);          // a new session does
  await client.begin({ session: true });
  assert.equal(calls.filter(c => c === 'rebuild').length, 2);          // ... and finds the memory fresh
});

test('a plan for a card the memory does not know is a skip (not a failed plan); the memory is marked out of date and rebuilt', async () => {
  const idb = await loadedIdb(), clk = clock(), logs = { list: history(6) };
  await setSettings(idb, { on: true, autoLocked: false });
  const { client, core } = clientFor(idb, clk, logs);
  await client.begin();
  await poke(core, { scheduler: 'own' }); client.scheduler = 'own';
  const unknown = { id: 'zzz', deckId: 'd', noteId: 'nz' };
  const r = await client.plan({ card: unknown, state: { state: 2, lastReview: T0 }, now: T0 + 14 * DAY, opts: { retention: 0.9, maxInterval: 365 }, decks: DECKS });
  assert.deepEqual(r, { skip: true });
  assert.equal(client.settled(r), null);
  assert.equal(client.rebuildPending, true);
  assert.equal(client.ready, false);
  await client._counter().call('status', {});
  assert.equal((await core.handle('status')).plansToday.total, 0);       // nothing counted
  assert.equal((await core.handle('status')).memory, 'stale');
});

// ---------- the database is not looked up where the browser says there is none ----------
test('where indexedDB.databases() exists it is asked first: no Own database listed means the database is never opened', async () => {
  const inner = makeFakeIdb(); let opened = 0;
  const idb = { databases: async () => [...inner.dbs.keys()].map(name => ({ name })), open: (...a) => { opened++; return inner.open(...a); }, deleteDatabase: n => inner.deleteDatabase(n) };
  assert.equal(await openOwnDb({ idb, forbidCreate: true }), null);
  assert.equal(opened, 0);
  assert.equal(await ownDbExists({ idb }), false);
  assert.equal(opened, 0);
  const r = await loadModelFile(fileOf(modelBytes(3)), { idb });               // (creating still works)
  assert.equal(r.ok, true);
  assert.equal(await ownDbExists({ idb }), true);
  const broken = { ...idb, databases: async () => { throw new Error('nope'); } };
  assert.equal(await ownDbExists({ idb: broken }), true);                      // any doubt: look the old way
});

// ---------- 2. the wipe takes the Own database with it ----------
test('wipeOwn deletes the Own database and the gate then says no', async () => {
  const idb = await loadedIdb(); await setSettings(idb, { on: true, autoLocked: false });
  resetOwnGate();
  assert.ok(await ownModule({ idb }));
  await wipeOwn({ idb });
  assert.equal(await ownDbExists({ idb }), false);
  assert.equal(idb.dbs.size, 0);
  assert.equal(await ownModule({ idb }), null);
  resetOwnGate();
});
