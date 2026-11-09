// Loading a model file: a good file is saved whole with its sha256, every kind of bad file gives a plain message and saves nothing,
// and removing the model deletes the Own database. Model bytes are made in memory with writeOwnFile (nothing is read from disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeOwnFile, OWN_FILE_LIMITS } from '../js/own-file.js';
import { initParams } from '../js/own-model.js';
import { loadModelFile, getLoadedModel, removeModel, checkModelBytes, sha256Hex } from '../js/own-load.js';
import { openOwnDb } from '../js/own-db.js';
import { makeFakeIdb } from './own-idb-fake.mjs';

const trainedOn = [{ id: 'sim-v1', licence: 'ours' }];
const good = (over = {}) => writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 3)), trainedOn, seed: 3, gitStamp: 'abc1234', createdAt: '2026-11-06T00:00:00.000Z', ...over });
const fileOf = (bytes, name = 'a.own') => ({ name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
const nothingSaved = idb => assert.equal(idb.dbs.size, 0, 'no database should have been created');

test('sha256Hex matches the standard sha256', async () => {
  const b = good();
  assert.equal(await sha256Hex(b), createHash('sha256').update(b).digest('hex'));
});

test('a good file loads, is saved whole with its sha256, and settings start switched off', async () => {
  const idb = makeFakeIdb(), bytes = good();
  const r = await loadModelFile(fileOf(bytes, 'my model.own'), { idb, now: () => 1234 });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'my model.own');
  assert.equal(r.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(r.header.size, 's');
  const h = await openOwnDb({ idb });
  const rec = await h.get('model', 'current');
  assert.deepEqual(new Uint8Array(rec.bytes), bytes);
  assert.equal(rec.loadedAt, 1234);
  assert.deepEqual(await h.get('meta', 'settings'), { on: false, autoLocked: false });
  h.close();
});

test('loading again replaces the model and keeps the owner\'s settings', async () => {
  const idb = makeFakeIdb();
  await loadModelFile(fileOf(good()), { idb });
  const h = await openOwnDb({ idb });
  await h.put('meta', 'settings', { on: true, autoLocked: false });
  h.close();
  const second = good({ seed: 9 });
  const r = await loadModelFile(fileOf(second, 'b.own'), { idb });
  assert.equal(r.ok, true);
  const got = await getLoadedModel({ idb });
  assert.equal(got.name, 'b.own');
  assert.equal(got.sha256, r.sha256);
  const h2 = await openOwnDb({ idb });
  assert.equal((await h2.get('meta', 'settings')).on, true);
  h2.close();
});

test('getLoadedModel reads the file again and gives the parameters back', async () => {
  const idb = makeFakeIdb();
  assert.deepEqual(await getLoadedModel({ idb }), { ok: true, loaded: false });
  nothingSaved(idb); // asking never creates the database
  await loadModelFile(fileOf(good()), { idb });
  const g = await getLoadedModel({ idb });
  assert.equal(g.loaded, true);
  assert.ok(g.params instanceof Float32Array);
  assert.equal(g.params.length, g.header.paramCount);
});

test('a saved model that was changed afterwards is refused', async () => {
  const idb = makeFakeIdb();
  await loadModelFile(fileOf(good()), { idb });
  const h = await openOwnDb({ idb });
  const rec = await h.get('model', 'current');
  rec.sha256 = '0'.repeat(64);
  await h.put('model', 'current', rec);
  h.close();
  const g = await getLoadedModel({ idb });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'damaged');
});

test('a file that is not an Own model says so and saves nothing', async () => {
  const idb = makeFakeIdb();
  const r = await loadModelFile(fileOf(new TextEncoder().encode('hello there, I am a text file')), { idb });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-own');
  assert.match(r.message, /isn't an Own model/);
  nothingSaved(idb);
});

test('a file over the size limit is refused before it is even read', async () => {
  const idb = makeFakeIdb();
  let read = false;
  const r = await loadModelFile({ name: 'big.own', size: OWN_FILE_LIMITS.maxBytes + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(1); } }, { idb });
  assert.equal(r.code, 'too-big');
  assert.equal(read, false);
  nothingSaved(idb);
  // and a file whose real bytes are too big even if it claims a small size
  const r2 = await loadModelFile({ name: 'liar.own', size: 10, arrayBuffer: async () => new ArrayBuffer(OWN_FILE_LIMITS.maxBytes + 1) }, { idb });
  assert.equal(r2.code, 'too-big');
  nothingSaved(idb);
});

test('a model made for another app version is refused with its own message', async () => {
  const idb = makeFakeIdb(), bytes = good();
  // change the header's feature version in place (same length) so the strict reader sees a different version
  const text = new TextDecoder().decode(bytes.subarray(13, 13 + new DataView(bytes.buffer).getUint32(9, true)));
  const patched = text.replace(/"featureVersion":(\d+)/, (_, n) => `"featureVersion":${String(Number(n) + 1).slice(-String(n).length).padStart(String(n).length, '9')}`);
  assert.equal(patched.length, text.length);
  const copy = bytes.slice();
  copy.set(new TextEncoder().encode(patched), 13);
  const r = await loadModelFile(fileOf(copy), { idb });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'wrong-version');
  assert.match(r.message, /different app version/);
  nothingSaved(idb);
});

test('cut-off, extra-data and damaged files are refused as damaged and save nothing', async () => {
  const idb = makeFakeIdb(), bytes = good();
  const cut = await loadModelFile(fileOf(bytes.subarray(0, bytes.length - 8)), { idb });
  assert.equal(cut.code, 'damaged');
  assert.match(cut.message, /incomplete/);
  const extra = new Uint8Array(bytes.length + 4); extra.set(bytes);
  assert.match((await loadModelFile(fileOf(extra), { idb })).message, /extra data/);
  const nan = bytes.slice(); new DataView(nan.buffer).setUint32(nan.length - 4, 0x7fc00000, true);
  assert.equal((await loadModelFile(fileOf(nan), { idb })).code, 'damaged');
  nothingSaved(idb);
});

test('an unreadable or missing file gives a plain error', async () => {
  const idb = makeFakeIdb();
  assert.equal((await loadModelFile(null, { idb })).code, 'unreadable');
  const r = await loadModelFile({ name: 'x', size: 5, arrayBuffer: async () => { throw new Error('boom'); } }, { idb });
  assert.equal(r.code, 'unreadable');
  assert.doesNotMatch(r.message, /boom/);
  nothingSaved(idb);
});

test('a storage failure is reported, not thrown', async () => {
  const r = await loadModelFile(fileOf(good()), { idb: makeFakeIdb({ failWrites: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'storage');
  const none = await loadModelFile(fileOf(good()), { idb: null, now: () => 1 }).catch(e => e);
  assert.equal(none.ok, false);
});

test('checkModelBytes accepts raw bytes and an ArrayBuffer', async () => {
  const bytes = good();
  assert.equal((await checkModelBytes(bytes)).ok, true);
  assert.equal((await checkModelBytes(bytes.slice().buffer)).ok, true);
});

test('removeModel deletes the whole Own database, and is fine when there is none', async () => {
  const idb = makeFakeIdb();
  await loadModelFile(fileOf(good()), { idb });
  const h = await openOwnDb({ idb });
  await h.put('cards', 'c1', { state: Float32Array.of(1) });
  h.close();
  assert.deepEqual(await removeModel({ idb }), { ok: true });
  nothingSaved(idb);
  assert.deepEqual(await getLoadedModel({ idb }), { ok: true, loaded: false });
  assert.deepEqual(await removeModel({ idb }), { ok: true });
});

test('removeModel held up by another tab returns a plain message', async () => {
  const r = await removeModel({ idb: makeFakeIdb({ blockDelete: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'blocked');
});
