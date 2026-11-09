// The Own database layer: opening, no-create mode, reading and writing every store, typed arrays, deleting the database,
// and the rule that the database is only created on purpose. Uses a small in-memory stand-in for IndexedDB (tests/own-idb-fake.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnDb, ownDbExists, deleteOwnDb, OwnDbError, OWN_DB_NAME, OWN_DB_VERSION, OWN_STORES } from '../js/own-db.js';
import { makeFakeIdb } from './own-idb-fake.mjs';

test('the database is called study-sprint-own, version 1, with all seven stores', async () => {
  assert.equal(OWN_DB_NAME, 'study-sprint-own');
  assert.equal(OWN_DB_VERSION, 1);
  const idb = makeFakeIdb();
  const h = await openOwnDb({ idb });
  assert.deepEqual(OWN_STORES.filter(s => !h.db.objectStoreNames.contains(s)), []);
  assert.deepEqual([...idb.dbs.keys()], ['study-sprint-own']);
  h.close();
});

test('forbidCreate returns null and creates nothing when the database is missing', async () => {
  const idb = makeFakeIdb();
  assert.equal(await openOwnDb({ idb, forbidCreate: true }), null);
  assert.equal(idb.dbs.size, 0);
  assert.equal(await ownDbExists({ idb }), false);
  assert.equal(idb.dbs.size, 0);
});

test('forbidCreate opens the database once it exists', async () => {
  const idb = makeFakeIdb();
  (await openOwnDb({ idb })).close();
  assert.equal(await ownDbExists({ idb }), true);
  const h = await openOwnDb({ idb, forbidCreate: true });
  assert.ok(h);
  h.close();
});

test('meta, model and card states round-trip, typed arrays included', async () => {
  const idb = makeFakeIdb();
  const h = await openOwnDb({ idb });
  await h.put('meta', 'settings', { on: false, autoLocked: false });
  assert.deepEqual(await h.get('meta', 'settings'), { on: false, autoLocked: false });
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  await h.put('model', 'current', { bytes, sha256: 'ab' });
  const m = await h.get('model', 'current');
  assert.deepEqual([...new Uint8Array(m.bytes)], [1, 2, 3]);
  await h.put('cards', 'c1', { state: Float32Array.of(0.5, -1.25), curve: Float32Array.of(1, 2) });
  const c = await h.get('cards', 'c1');
  assert.ok(c.state instanceof Float32Array);
  assert.deepEqual([...c.state], [0.5, -1.25]);
  assert.equal(await h.get('cards', 'missing'), undefined);
  h.close();
});

test('prediction records are keyed by their logId; putMany, getAll, delete and clear work', async () => {
  const h = await openOwnDb({ idb: makeFakeIdb() });
  const rec = id => ({ logId: id, cardId: 'c', t: 1, day: 2, elapsedDays: 3, pOwn: 0.9, pFsrs: 0.8, y: 1, sched: 'fsrs', fsrsKind: 6, modelSha: 'x', tuneId: null });
  await h.putMany('preds', [rec('a'), rec('b'), rec('c')]);
  await h.put('preds', null, rec('b'));            // same logId: replaced, not added
  assert.equal((await h.getAll('preds')).length, 3);
  assert.equal((await h.get('preds', 'a')).pOwn, 0.9);
  await h.delete('preds', 'a');
  assert.deepEqual((await h.getAll('preds')).map(r => r.logId).sort(), ['b', 'c']);
  await h.clear('preds');
  assert.deepEqual(await h.getAll('preds'), []);
  h.close();
});

test('data is still there after closing and opening again', async () => {
  const idb = makeFakeIdb();
  let h = await openOwnDb({ idb });
  await h.put('meta', 'state', { scheduler: 'fsrs' });
  h.close();
  h = await openOwnDb({ idb });
  assert.deepEqual(await h.get('meta', 'state'), { scheduler: 'fsrs' });
  h.close();
});

test('an unknown store or a failed write gives a plain OwnDbError', async () => {
  const h = await openOwnDb({ idb: makeFakeIdb() });
  await assert.rejects(h.get('nope', 'k'), e => e instanceof OwnDbError && /could not be used/.test(e.message));
  h.close();
  const h2 = await openOwnDb({ idb: makeFakeIdb({ failWrites: true }) });
  await assert.rejects(h2.put('meta', 'x', {}), OwnDbError);
  h2.close();
});

test('deleteOwnDb wipes everything and the database is gone afterwards', async () => {
  const idb = makeFakeIdb();
  const h = await openOwnDb({ idb });
  await h.put('meta', 'settings', { on: true });
  h.close();
  assert.equal(await deleteOwnDb({ idb }), true);
  assert.equal(await ownDbExists({ idb }), false);
  assert.equal(idb.dbs.size, 0);
  assert.equal(await deleteOwnDb({ idb }), true); // deleting nothing is fine
});

test('a delete held up by another tab says to close other tabs', async () => {
  await assert.rejects(deleteOwnDb({ idb: makeFakeIdb({ blockDelete: true }) }), e => e instanceof OwnDbError && e.code === 'blocked' && /Close other/.test(e.message));
});

test('no database in the browser gives a plain error, not a crash', async () => {
  await assert.rejects(openOwnDb({ idb: null }), e => e instanceof OwnDbError && /cannot store/.test(e.message));
});

test('putEntries, getEntries and deleteKeys work on many entries at once', async () => {
  const h = await openOwnDb({ idb: makeFakeIdb() });
  await h.putEntries('cards', [['c:1', { state: new Float32Array([1, 2]) }], ['c:2', { state: new Float32Array([3]) }]]);
  const got = await h.getEntries('cards');
  assert.deepEqual(got.map(e => e[0]), ['c:1', 'c:2']);
  assert.deepEqual([...got[0][1].state], [1, 2]);
  await h.putEntries('preds', [[7, { logId: 7, y: null }]]);
  assert.deepEqual((await h.getEntries('preds')).map(e => e[0]), [7]);
  await h.deleteKeys('cards', ['c:1']);
  assert.deepEqual((await h.getEntries('cards')).map(e => e[0]), ['c:2']);
  h.close();
});
