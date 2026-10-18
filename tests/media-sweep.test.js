// The 30-day wait before pictures and sounds are deleted from the account (js/media-sweep.js), the import's "too big" sentences
// and the check for files the account already holds (js/sync-quota.js). Run with: node tests/media-sweep.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSweep, markKey, isMarkKey, isSeenKey, markId, validMark, WAIT_MS, GONE } from '../js/media-sweep.js';
import { acceptSetting, isSyncedSetting } from '../js/sync-data.js';
import { isLocalOnly } from '../js/db.js';
import { alreadyOnServer } from '../js/sync-quota.js';
import { tooBigNotes, importWarnings, MB } from '../js/quota.js';

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86400000;

test('a file nobody uses is marked with today, not deleted', () => {
  assert.deepEqual(planSweep({ removed: ['a', 'b'], now: NOW }), { mark: ['a', 'b'], unmark: [], sweep: [], reupload: [] });
});

test('an already marked file keeps its first date', () => {
  const p = planSweep({ marks: { a: NOW - 5 * DAY }, removed: ['a'], now: NOW });
  assert.deepEqual(p, { mark: [], unmark: [], sweep: [], reupload: [] });
});

test('a marked file is swept only once 30 days have passed', () => {
  assert.deepEqual(planSweep({ marks: { a: NOW - 30 * DAY + 1 }, now: NOW }).sweep, []);
  assert.deepEqual(planSweep({ marks: { a: NOW - 30 * DAY }, now: NOW }).sweep, ['a']);
  assert.deepEqual(planSweep({ marks: { a: NOW - 90 * DAY }, now: NOW }).sweep, ['a']);
  assert.equal(WAIT_MS, 30 * DAY);
});

test('a marked file that a card uses again is un-marked, even after 30 days', () => {
  const p = planSweep({ marks: { a: NOW - 40 * DAY, b: NOW - DAY }, used: new Set(['a', 'b']), now: NOW });
  assert.deepEqual(p, { mark: [], unmark: ['a', 'b'], sweep: [], reupload: [] });
});

test('a used file is never marked, and a mark for a file this device never had is still swept', () => {
  assert.deepEqual(planSweep({ removed: ['a'], used: new Set(['a']), now: NOW }).mark, []);
  assert.deepEqual(planSweep({ marks: { z: NOW - 31 * DAY }, used: new Set(['q']), now: NOW }).sweep, ['z']);
});

test('two devices agree: both read the same synced mark and make the same decision', () => {
  const marks = { a: NOW - 31 * DAY, b: NOW - 3 * DAY };
  const A = planSweep({ marks, used: new Set(), now: NOW });
  const B = planSweep({ marks, used: new Set(), now: NOW });
  assert.deepEqual(A, B);
  assert.deepEqual(A.sweep, ['a']);
  // A device that still has a card using "a" un-marks it; once that null mark reaches the others, nobody sweeps it.
  assert.deepEqual(planSweep({ marks, used: new Set(['a']), now: NOW }).unmark, ['a']);
  assert.deepEqual(planSweep({ marks: { b: marks.b }, used: new Set(), now: NOW }).sweep, []);
});

test('marks are synced settings, checked on the way in, and left out of backups', () => {
  assert.equal(markKey('x1'), 'mdel:x1');
  assert.ok(isMarkKey('mdel:x1') && !isMarkKey('gloss:x1') && !isMarkKey(5));
  assert.equal(markId('mdel:x1'), 'x1');
  assert.ok(isSyncedSetting('mdel:x1'));
  assert.ok(isLocalOnly('mdel:x1'));
  assert.deepEqual(acceptSetting('mdel:x1', NOW), { ok: true, value: NOW });
  assert.deepEqual(acceptSetting('mdel:x1', null), { ok: true, value: null });
  for (const junk of ['yesterday', -5, 0, NaN, {}, true]) assert.equal(acceptSetting('mdel:x1', junk).ok, false);
  assert.ok(validMark(null) && validMark(1) && validMark(GONE) && !validMark(undefined) && !validMark('other'));
  assert.deepEqual(acceptSetting('mdel:x1', GONE), { ok: true, value: GONE });
  assert.ok(isLocalOnly('mseen:x1') && isSeenKey('mseen:x1') && !isSyncedSetting('mseen:x1'));
});

test('too big pictures and sounds are counted in plain words', () => {
  assert.deepEqual(tooBigNotes({ pictures: 3 }), ['3 pictures were too big and were left out']);
  assert.deepEqual(tooBigNotes({ pictures: 1, sounds: 2 }), ['1 picture was too big and was left out', '2 sounds were too big and were left out']);
  assert.deepEqual(tooBigNotes({ sounds: 1 }), ['1 sound was too big and was left out']);
  assert.deepEqual(tooBigNotes({}), []);
});

test('a big deck with sounds asks "Import without sounds?"', () => {
  assert.match(importWarnings({ mediaBytes: 300 * MB, soundBytes: 100 * MB })[0], /Import without sounds\?/);
  assert.doesNotMatch(importWarnings({ mediaBytes: 300 * MB })[0], /Import without sounds/);
  assert.deepEqual(importWarnings({ mediaBytes: 10 * MB, soundBytes: 5 * MB }), []);
});

test('a kept-back file the account already holds is found, and the asking is limited', async () => {
  const held = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const asked = [];
  const exists = async id => { asked.push(id); return id === 'b'; };
  const checked = new Set();
  assert.deepEqual(await alreadyOnServer(held, exists, checked, 2), ['b']);       // cap 2: only a and b are asked
  assert.deepEqual(asked.sort(), ['a', 'b']);
  assert.ok(checked.has('a') && !checked.has('b'));
  asked.length = 0;
  await alreadyOnServer(held, exists, checked, 25);
  assert.ok(!asked.includes('a'));                                                // one found missing is not asked again
  assert.ok(asked.includes('c') && asked.includes('d'));
});

test('a swept file that a card here still uses, and this device has, is sent again', () => {
  const p = planSweep({ gone: ['a', 'b', 'c', 'd'], used: new Set(['a', 'b', 'c']), held: new Set(['a', 'b', 'd']), now: NOW });
  assert.deepEqual(p.reupload, ['a', 'b']);                       // c: used but not held here; d: held but unused
  assert.deepEqual(planSweep({ gone: ['a'], used: new Set(['a']), now: NOW }).reupload, []);
});

test("a file the account already lost is never marked again (the 'gone' note must stay for devices that hold it)", () => {
  assert.deepEqual(planSweep({ gone: ['a'], removed: ['a'], now: NOW }).mark, []);
});

test('after a re-upload every kept-back file is checked (cap Infinity), a few at a time', async () => {
  const held = Array.from({ length: 60 }, (_, i) => ({ id: 'f' + i }));
  let now = 0, most = 0;
  const exists = async id => { most = Math.max(most, ++now); await new Promise(r => setTimeout(r, 1)); now--; return Number(id.slice(1)) % 2 === 0; };
  const seen = [];
  const found = await alreadyOnServer(held, exists, new Set(), Infinity, { size: 8, onProgress: (i, n) => seen.push([i, n]) });
  assert.equal(found.length, 30);                                   // all 60 were asked about, not 25
  assert.ok(most > 4 && most <= 8, 'concurrency ' + most);
  assert.deepEqual(seen.at(-1), [60, 60]);                          // and progress is reported
});
