// Tests for the Anki reader's offline support (js/anki-read.js). Run with: node tests/anki-offline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveAnkiLibraries, shouldSaveAnkiLibraries, loadLibrary, readAnkiFile, FFLATE_URL, FZSTD_URL, SQLJS_BASE, SQLJS_JS_INTEGRITY, SQLJS_WASM_INTEGRITY } from '../js/anki-read.js';
import { readFileSync } from 'node:fs';

const fakeCache = (have = []) => ({ match: async u => (have.includes(u) ? {} : undefined) });
const JS = SQLJS_BASE + 'sql-wasm.js', WASM = SQLJS_BASE + 'sql-wasm.wasm';

test('saveAnkiLibraries loads all four files when none is saved', async () => {
  const loaded = [], fetched = [];
  const n = await saveAnkiLibraries({
    cache: fakeCache(), load: async u => { loaded.push(u); },
    get: async (u, integrity) => { fetched.push([u, integrity]); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; },
  });
  assert.equal(n, 4);
  assert.deepEqual(loaded, [FFLATE_URL, FZSTD_URL]);
  assert.deepEqual(fetched, [[JS, SQLJS_JS_INTEGRITY], [WASM, SQLJS_WASM_INTEGRITY]]);
});

test('saveAnkiLibraries skips what is already saved', async () => {
  const loaded = [], fetched = [];
  const n = await saveAnkiLibraries({
    cache: fakeCache([FFLATE_URL, JS]), load: async u => { loaded.push(u); },
    get: async u => { fetched.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; },
  });
  assert.equal(n, 2);
  assert.deepEqual(loaded, [FZSTD_URL]);
  assert.deepEqual(fetched, [WASM]);
  assert.equal(await saveAnkiLibraries({ cache: fakeCache([FFLATE_URL, FZSTD_URL, JS, WASM]), load: async () => assert.fail(), get: async () => assert.fail() }), 0);
});

test('saveAnkiLibraries never throws, and goes on after a failure', async () => {
  const loaded = [];
  const n = await saveAnkiLibraries({
    cache: { match: async () => { throw new Error('cache broke'); } }, load: async () => { throw new Error('x'); }, get: async () => { throw new Error('offline'); },
  });
  assert.equal(n, 0);
  const m = await saveAnkiLibraries({
    cache: fakeCache(), load: async u => { loaded.push(u); throw new Error('offline'); }, get: async () => { throw new Error('offline'); },
  });
  assert.equal(m, 4);
  assert.deepEqual(loaded, [FFLATE_URL, FZSTD_URL]);
  assert.equal(await saveAnkiLibraries({ cache: undefined, load: async () => {}, get: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) }), 4);
});

test('shouldSaveAnkiLibraries: only installed, online, controlled and not Data Saver', () => {
  const on = { installed: true, online: true, controlled: true, saveData: false };
  assert.equal(shouldSaveAnkiLibraries(on), true);
  for (const k of ['installed', 'online', 'controlled']) assert.equal(shouldSaveAnkiLibraries({ ...on, [k]: false }), false, k);
  assert.equal(shouldSaveAnkiLibraries({ ...on, saveData: true }), false);
  assert.equal(shouldSaveAnkiLibraries({}), false);
  assert.equal(shouldSaveAnkiLibraries(), false);
});

test('a library that did not load is its own error, other errors pass through', async () => {
  await assert.rejects(loadLibrary(async () => { throw new TypeError('Failed to fetch'); }), e => e.code === 'no-library' && e.cause instanceof TypeError);
  const wasm = Object.assign(new Error('iOS'), { code: 'no-wasm' });
  await assert.rejects(loadLibrary(async () => { throw wasm; }), e => e === wasm);
  assert.deepEqual(await loadLibrary(async () => ({ a: 1 })), { a: 1 });
});

test('readAnkiFile: a failed fflate or sql.js load is no-library, not a bad file', async () => {
  const file = { arrayBuffer: async () => new ArrayBuffer(0) };
  await assert.rejects(readAnkiFile(file, async () => { throw new Error('offline'); }), e => e.code === 'no-library');
  const load = async () => ({ unzipSync: () => ({ 'collection.anki2': new Uint8Array([1, 2, 3]) }) });      // (a stand-in for fflate)
  await assert.rejects(readAnkiFile(file, load, async () => { throw new Error('offline'); }), e => e.code === 'no-library');
});

test('the app warms the libraries once, idle, with the checks in place', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /saveAnkiLibrariesWhenIdle\(\);/);
  assert.match(app, /isInstalled\(\) && navigator\.onLine && navigator\.serviceWorker\?\.controller && !navigator\.connection\?\.saveData\)\) return;\s+import\('\.\/anki-read\.js'\)/);
});
