// The forced-update check (js/app-config.js): reading the server's minimum version, failing open, and the sync gate.
// (The screen, with the fake server: tests/browser/e2e-forced-update.mjs.) Run with: node tests/app-config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, isTooOld, minClientOf, fetchMinClient, setSyncGate, syncGateClosed, SYNC_PAUSED_MESSAGE, holdSync, syncHeld, rememberMinClient, cachedMinClient } from '../js/app-config.js';

test('versions compare as numbers, not text', () => {
  assert.deepEqual(parseVersion('v4.36'), [4, 36]);
  assert.equal(parseVersion('4.x'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(compareVersions('4.9', '4.36'), -1);
  assert.equal(compareVersions('4.36', '4.36.0'), 0);
  assert.equal(compareVersions('5.0', '4.99'), 1);
  assert.equal(compareVersions('4.36', 'banana'), null);
  assert.equal(isTooOld('4.36', '4.37'), true);
  assert.equal(isTooOld('4.36', '4.36'), false);
  assert.equal(isTooOld('4.36', '4.9'), false);
  assert.equal(isTooOld('4.36', null), false, 'no minimum');
  assert.equal(isTooOld('4.36', 'garbage'), false, 'an unreadable minimum is no minimum');
});

test('min_client is found in an object, a one-row list or a bare value', () => {
  assert.equal(minClientOf({ min_client: '4.40' }), '4.40');
  assert.equal(minClientOf([{ min_client: '4.40', other: 1 }]), '4.40');
  assert.equal(minClientOf('4.40'), '4.40');
  assert.equal(minClientOf(4.4), '4.4');
  assert.equal(minClientOf({ min_client: null }), null);
  assert.equal(minClientOf({}), null);
  assert.equal(minClientOf([]), null);
  assert.equal(minClientOf(null), null);
  assert.equal(minClientOf({ min_client: 'soon' }), null);
});

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const base = 'https://x.supabase.co';

test('fetchMinClient asks the app_config function with the public key', async () => {
  let seen;
  const min = await fetchMinClient({ base, key: 'k', fetchFn: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ min_client: '4.40' }) }; } });
  assert.equal(min, '4.40');
  assert.equal(seen.url, base + '/rest/v1/rpc/app_config');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.apikey, 'k');
});

test('every problem means no minimum', async () => {
  assert.equal(await fetchMinClient({ base, key: 'k', fetchFn: reply(404, { code: 'PGRST202' }) }), null, 'no such function yet');
  assert.equal(await fetchMinClient({ base, key: 'k', fetchFn: reply(500, {}) }), null);
  assert.equal(await fetchMinClient({ base, key: 'k', fetchFn: async () => { throw new TypeError('offline'); } }), null);
  assert.equal(await fetchMinClient({ base, key: 'k', fetchFn: async () => ({ ok: true, json: async () => { throw new Error('not json'); } }) }), null);
  assert.equal(await fetchMinClient({ base, key: 'k', fetchFn: reply(200, { min_client: 'later' }) }), null);
  assert.equal(await fetchMinClient({ base: '', key: 'k' }), null, 'sync not configured: nothing is asked');
});

test('an answer slower than the timeout is given up on', async () => {
  const slow = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t0 = Date.now();
  assert.equal(await fetchMinClient({ base, key: 'k', timeout: 40, fetchFn: slow }), null);
  assert.ok(Date.now() - t0 < 1000);
});

test('the last minimum and the offline choice are remembered (the choice only for one app version)', () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  assert.equal(cachedMinClient(), null);
  rememberMinClient('4.40');
  assert.equal(cachedMinClient(), '4.40');
  assert.equal(syncHeld('4.36'), false);
  holdSync('4.36');
  assert.equal(syncHeld('4.36'), true);
  assert.equal(syncHeld('4.37'), false, 'an update ends the hold');
  delete globalThis.localStorage;
  assert.equal(cachedMinClient(), null);       // no storage at all: still fine
  assert.equal(syncHeld('4.36'), false);
});

test('the sync gate turns requests to the sync server into a plain "update" answer, and lets everything else through', async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return new Response('{"ok":true}', { status: 200 }); };
  setSyncGate(true, base);
  assert.equal(syncGateClosed(), true);
  const blocked = await fetch(base + '/rest/v1/sync_items');
  assert.equal(blocked.status, 426);
  assert.equal((await blocked.json()).message, SYNC_PAUSED_MESSAGE);
  assert.deepEqual(calls, [], 'nothing reached the server');
  assert.equal((await fetch('https://elsewhere.example/x')).status, 200);
  assert.equal((await fetch(base + '/rest/v1/rpc/app_config', { method: 'POST' })).status, 200, 'the version question itself is let through');
  setSyncGate(false);
  assert.equal((await fetch(base + '/rest/v1/sync_items')).status, 200, 'open again');
  assert.equal(calls.length, 3);
});
