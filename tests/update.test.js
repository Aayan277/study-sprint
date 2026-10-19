// The update logic (js/update.js): when a new version restarts the app, and when it waits. Run with: node tests/update.test.js
// (The real thing with a real service worker is tests/browser/e2e-update.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, isRestSpot, CHECK_GAP, CHECK_EVERY, UPDATE_READY_TEXT } from '../js/update.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function rig(extra = {}) {
  const t = { busy: false, reloads: 0, skips: 0, shown: 0, hidden: 0, checks: 0, clock: 1_000_000, waitingWorker: true };
  const u = createUpdater({
    busy: () => t.busy, reload: () => { t.reloads++; },
    skipWaiting: () => { if (!t.waitingWorker) return false; t.skips++; return true; },
    show: () => { t.shown++; }, hide: () => { t.hidden++; }, update: () => { t.checks++; }, now: () => t.clock, settleMs: 5, watchdogMs: 100000, ...extra
  });
  return { t, u };
}

test('nothing open: the waiting version is told to take over at once', () => {
  const { t, u } = rig();
  u.waiting();
  assert.equal(t.skips, 1);
  assert.equal(t.shown, 0);
  u.changed();                                   // and when it has, the page reloads
  assert.equal(t.reloads, 1);
});

test('something unsaved: no restart, the bar is shown once', () => {
  const { t, u } = rig();
  t.busy = true;
  u.waiting(); u.waiting();
  assert.deepEqual([t.skips, t.reloads, t.shown], [0, 0, 1]);
  assert.equal(u.pending, true);
  u.changed();                                   // another tab or an older worker took over: still no reload while busy
  assert.equal(t.reloads, 0);
  assert.equal(t.shown, 1);
});

test('tapping the bar restarts even though work is open (the person chose)', () => {
  const { t, u } = rig();
  t.busy = true;
  u.waiting();
  u.tap();
  assert.equal(t.skips, 1);
  assert.ok(t.hidden >= 1);
  assert.equal(u.pending, false);
  u.changed();                                   // the controller change that follows reloads although busy
  assert.equal(t.reloads, 1);
});

test('tapping when the new version already took over reloads straight away', () => {
  const { t, u } = rig();
  t.waitingWorker = false; t.busy = true;
  u.changed();
  assert.deepEqual([t.reloads, t.shown], [0, 1]);
  u.tap();
  assert.equal(t.reloads, 1);
});

test('a held update restarts by itself on Today or Decks with nothing open, not before', async () => {
  const { t, u } = rig();
  t.busy = true;
  u.waiting();
  u.routed('today');                             // still busy
  u.routed('import'); u.routed('stats'); u.routed('review');
  assert.equal(t.skips, 0);
  t.busy = false;
  u.routed('import');                            // not a resting place
  assert.equal(t.skips, 0);
  u.routed('decks');
  assert.equal(t.skips, 0, 'not at once: the screen is still loading');
  await sleep(40);
  assert.equal(t.skips, 1);
  u.routed('today'); await sleep(40);            // and only once
  assert.equal(t.skips, 1);
  assert.deepEqual(['today', 'decks', 'deck', 'play', 'import'].map(isRestSpot), [true, true, false, false, false]);
});

test('leaving the resting place, or getting busy, during the settle delay cancels the restart', async () => {
  const { t, u } = rig();
  t.busy = true; u.waiting(); t.busy = false;
  u.routed('today'); u.routed('import'); await sleep(40);
  assert.equal(t.skips, 0);
  u.routed('today'); t.busy = true; await sleep(40);
  assert.equal(t.skips, 0);
});

test('a switch that comes long after the page asked does not reload a page that is busy now; a stuck switch brings the bar back', async () => {
  const { t, u } = rig();
  u.waiting();                                   // asks (skips 1)
  t.clock += 60_000; t.busy = true;
  u.changed();                                   // the worker finally took over, a minute later, mid-round
  assert.equal(t.reloads, 0);
  assert.equal(u.pending, true);
  const r = rig({ watchdogMs: 30 });
  r.u.waiting(); assert.equal(r.t.shown, 0);
  await sleep(60);                               // no controller change: stuck
  assert.equal(r.u.pending, true);
  assert.equal(r.t.shown, 1, 'the bar is back');
  r.u.changed();                                 // it goes through after all, page idle: reloads
  assert.equal(r.t.reloads, 1);
  const q = rig(); q.u.waiting(); q.u.changed();
  assert.equal(q.t.reloads, 1, 'a switch right after asking reloads, busy or not');
});

test('with no update held, routing does nothing', () => {
  const { t, u } = rig();
  u.routed('today'); u.routed('decks');
  assert.deepEqual([t.skips, t.reloads, t.shown], [0, 0, 0]);
});

test('looking for a new version: at most once an hour when the app comes back, and on a 6 hour timer', async () => {
  const { t, u } = rig();
  await u.visible();
  assert.equal(t.checks, 0, 'just started: no need to ask again');
  t.clock += CHECK_GAP - 1;
  await u.visible();
  assert.equal(t.checks, 0);
  t.clock += 1;
  await u.visible();
  assert.equal(t.checks, 1);
  await u.visible();
  assert.equal(t.checks, 1, 'not again within the hour');
  t.clock += CHECK_GAP;
  await u.visible();
  assert.equal(t.checks, 2);
  await u.check();                               // the timer's call always asks
  assert.equal(t.checks, 3);
  assert.equal(CHECK_EVERY, 6 * 3600 * 1000);
});

test('a failing update check is swallowed', async () => {
  const { u } = rig({ update: () => Promise.reject(new Error('offline')) });
  await u.check();
  const { u: u2 } = rig({ update: () => { throw new Error('boom'); } });
  await u2.check();
});

test('the wording', () => assert.equal(UPDATE_READY_TEXT, 'Update ready — tap to restart'));
