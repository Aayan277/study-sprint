// Recently deleted: its separate database (js/trash-db.js), on the in-memory stand-in for IndexedDB (tests/own-idb-fake.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, listEntries, getPart, removeEntry, removeEntries, purgeExpired, clearTrash, mediaIds, protectedMedia, TRASH_DB_NAME, TRASH_DB_VERSION, TrashDbError } from '../js/trash-db.js';
import { makeFakeIdb } from './own-idb-fake.mjs';

const DAY = 86400000;
const mk = (id, deletedAt, extra = {}) => ({ entry: { id, kind: 'cards', title: id, deletedAt, settledAt: deletedAt, parts: 2, mediaIds: [], ...extra }, parts: [{ gone: { cards: [{ id: id + '-a' }] } }, { gone: { cards: [{ id: id + '-b' }] } }] });
const add = (idb, id, at, extra) => { const { entry, parts } = mk(id, at, extra); return addEntry(entry, parts, { idb }); };

test('the database is called study-sprint-trash, version 1, with entries and parts', async () => {
  assert.equal(TRASH_DB_NAME, 'study-sprint-trash');
  assert.equal(TRASH_DB_VERSION, 1);
  const idb = makeFakeIdb();
  await add(idb, 'a', 1);
  assert.deepEqual([...idb.dbs.keys()], ['study-sprint-trash']);
  assert.deepEqual([...idb.dbs.get('study-sprint-trash').stores.keys()].sort(), ['entries', 'parts']);
});

test('reading never creates the database', async () => {
  const idb = makeFakeIdb();
  assert.deepEqual(await listEntries({ idb }), []);
  assert.equal(await getPart('x', 0, { idb }), undefined);
  assert.equal((await mediaIds({ idb })).size, 0);
  assert.equal(await purgeExpired(Date.now(), { idb }), 0);
  await clearTrash({ idb });
  await removeEntry({ id: 'x', parts: 1 }, { idb });
  assert.equal(idb.dbs.size, 0);
});

test('add and list: newest first, with the pieces readable one by one', async () => {
  const idb = makeFakeIdb();
  await add(idb, 'old', 100); await add(idb, 'new', 300); await add(idb, 'mid', 200);
  assert.deepEqual((await listEntries({ idb })).map(e => e.id), ['new', 'mid', 'old']);
  assert.deepEqual((await getPart('mid', 0, { idb })).gone.cards, [{ id: 'mid-a' }]);
  assert.deepEqual((await getPart('mid', 1, { idb })).gone.cards, [{ id: 'mid-b' }]);
  assert.equal(await getPart('mid', 2, { idb }), undefined);
});

test('removing an entry takes its pieces too', async () => {
  const idb = makeFakeIdb();
  await add(idb, 'a', 1); await add(idb, 'b', 2);
  await removeEntry((await listEntries({ idb })).find(e => e.id === 'a'), { idb });
  assert.deepEqual((await listEntries({ idb })).map(e => e.id), ['b']);
  assert.equal(await getPart('a', 0, { idb }), undefined);
  assert.ok(await getPart('b', 0, { idb }));
  await removeEntries(await listEntries({ idb }), { idb });
  assert.deepEqual(await listEntries({ idb }), []);
  assert.equal(idb.dbs.get('study-sprint-trash').stores.get('parts').rows.size, 0);
});

test('purge removes what is 30 days old or more, and only that', async () => {
  const idb = makeFakeIdb();
  const now = 100 * DAY;
  await add(idb, 'fresh', now - 29 * DAY); await add(idb, 'edge', now - 30 * DAY); await add(idb, 'old', now - 45 * DAY);
  assert.equal(await purgeExpired(now, { idb }), 2);
  assert.deepEqual((await listEntries({ idb })).map(e => e.id), ['fresh']);
  assert.equal(idb.dbs.get('study-sprint-trash').stores.get('parts').rows.size, 2);
});

test('clear empties both stores', async () => {
  const idb = makeFakeIdb();
  await add(idb, 'a', 1); await add(idb, 'b', 2);
  await clearTrash({ idb });
  assert.deepEqual(await listEntries({ idb }), []);
  assert.equal(idb.dbs.get('study-sprint-trash').stores.get('parts').rows.size, 0);
});

test('the pictures and sounds of every entry are kept', async () => {
  const idb = makeFakeIdb();
  await add(idb, 'a', 1, { mediaIds: ['p1', 's1'] }); await add(idb, 'b', 2, { mediaIds: ['s1', 'p2'] }); await add(idb, 'c', 3);
  assert.deepEqual([...await mediaIds({ idb })].sort(), ['p1', 'p2', 's1']);
  assert.deepEqual([...await protectedMedia({ idb })].sort(), ['p1', 'p2', 's1']);
});

test('two connections at once see each other\'s entries', async () => {
  const idb = makeFakeIdb();
  await Promise.all([add(idb, 'a', 1), add(idb, 'b', 2)]);
  const [x, y] = await Promise.all([listEntries({ idb }), listEntries({ idb })]);
  assert.deepEqual(x.map(e => e.id), ['b', 'a']);
  assert.deepEqual(y.map(e => e.id), ['b', 'a']);
});

test('a connection steps aside when another tab wants to delete the database', async () => {
  const idb = makeFakeIdb();
  await add(idb, 'a', 1);
  // the stand-in tells every open connection; ours are closed after each call, so deleting never blocks
  await new Promise((resolve, reject) => { const r = idb.deleteDatabase('study-sprint-trash'); r.onsuccess = resolve; r.onblocked = () => reject(new Error('blocked')); });
  assert.deepEqual(await listEntries({ idb }), []);
});

test('a write that fails is reported (code quota for a full device), and nothing half-saved is left', async () => {
  const idb = makeFakeIdb({ failWrites: true });
  await assert.rejects(add(idb, 'a', 1), e => e instanceof TrashDbError && e.code === 'quota');
  assert.deepEqual(await listEntries({ idb }), []);
});

test('protectedMedia gives null (not an empty list) when the database can not be read', async () => {
  const broken = { open() { throw new Error('nope'); } };
  const was = console.error; console.error = () => {};
  try { assert.equal(await protectedMedia({ idb: broken }), null); } finally { console.error = was; }
});
