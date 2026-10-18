// Tests for the app-icon badge logic (js/badge-logic.js). Run with: node tests/badge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyBadge, makeRefresher, supported } from '../js/badge-logic.js';

const fakeNav = () => { const calls = []; return { calls, setAppBadge: n => { calls.push(['set', n]); return Promise.resolve(); }, clearAppBadge: () => { calls.push(['clear']); return Promise.resolve(); } }; };

test('applyBadge sets the count, clears at 0, ignores junk and unsupported browsers', () => {
  const n = fakeNav();
  assert.equal(applyBadge(n, 12), 'set');
  assert.equal(applyBadge(n, 0), 'clear');
  assert.equal(applyBadge(n, -3), 'clear');
  assert.equal(applyBadge(n, NaN), 'clear');
  assert.equal(applyBadge(n, 7.9), 'set');
  assert.deepEqual(n.calls, [['set', 12], ['clear'], ['clear'], ['clear'], ['set', 7]]);
  assert.equal(applyBadge({}, 5), 'unsupported');
  assert.equal(supported({}), false);
  assert.equal(supported(n), true);
});

test('applyBadge never throws, even when the browser rejects', async () => {
  const bad = { setAppBadge: () => Promise.reject(new Error('no')), clearAppBadge: () => { throw new Error('boom'); } };
  assert.equal(applyBadge(bad, 3), 'set');
  assert.equal(applyBadge(bad, 0), 'unsupported');
  await new Promise(r => setTimeout(r, 5));      // an unhandled rejection would fail the test run
});

// A clock we control.
const clock = () => { let id = 0; const q = new Map(); return { timer: (f, ms) => { q.set(++id, f); return id; }, untimer: i => q.delete(i), fire: () => { const fs = [...q.values()]; q.clear(); fs.forEach(f => f()); }, pending: () => q.size }; };
const settle = () => new Promise(r => setTimeout(r, 0));

test('refresher: many requests make one count; it shows the number', async () => {
  const c = clock(); let computed = 0; const shown = [];
  const r = makeRefresher({ compute: async () => ++computed * 10, apply: n => shown.push(n), enabled: async () => true, timer: c.timer, untimer: c.untimer });
  r.request(); r.request(); r.request();
  assert.equal(c.pending(), 1);
  c.fire(); await settle();
  assert.equal(computed, 1);
  assert.deepEqual(shown, [10]);
});

test('refresher: off means no work; turning off clears once', async () => {
  const c = clock(); let on = false, computed = 0; const shown = [];
  const r = makeRefresher({ compute: async () => { computed++; return 4; }, apply: n => shown.push(n), enabled: async () => on, timer: c.timer, untimer: c.untimer });
  await r.now(true);
  assert.equal(computed, 0); assert.deepEqual(shown, []);
  on = true; await r.now(true);
  assert.deepEqual(shown, [4]);
  on = false; await r.now(true); await r.now(true);
  assert.deepEqual(shown, [4, 0], 'cleared exactly once');
});

test('refresher: nothing is worked out during a round, unless forced (leaving the app)', async () => {
  const c = clock(); let held = true, computed = 0; const shown = [];
  const r = makeRefresher({ compute: async () => { computed++; return 9; }, apply: n => shown.push(n), enabled: async () => true, held: () => held, timer: c.timer, untimer: c.untimer });
  r.request(); c.fire(); await settle();
  assert.equal(computed, 0);
  await r.now(true);
  assert.deepEqual(shown, [9]);
  held = false; r.request(); c.fire(); await settle();
  assert.deepEqual(shown, [9, 9]);
});

test('refresher: a count that is zero clears the badge, and errors are swallowed', async () => {
  const c = clock(); const n = fakeNav(); let fail = false;
  const r = makeRefresher({ compute: async () => { if (fail) throw new Error('db'); return 0; }, apply: v => applyBadge(n, v), enabled: async () => true, timer: c.timer, untimer: c.untimer });
  await r.now(true);
  assert.deepEqual(n.calls, [['clear']]);
  fail = true;
  await r.now(true);
  assert.equal(n.calls.length, 1);
});
