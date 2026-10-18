// Downloading pictures and sounds when a card first needs them (js/lazy-media.js, backlog 16): what a sync fetches ahead, when a failed
// download may be tried again, and that "this device doesn't hold the file" is never read as "nobody uses it" by the 30-day sweep
// or the re-upload. Run with: node tests/lazy-media.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFiles, wantedMedia, planPrefetch, retryWait, canTry, failedAgain, mediaMessage, notDownloadedLine, leftOutNote, PREFETCH_FILES, NEW_AHEAD } from '../js/lazy-media.js';
import { planSweep, droppedRefs, WAIT_MS } from '../js/media-sweep.js';
import { usedMediaIds, isLocalOnly } from '../js/db.js';
import { isSyncedSetting } from '../js/sync-data.js';

const NOW = Date.UTC(2026, 5, 10, 12);
const DAY = 86400000;
const card = (id, extra = {}) => ({ id, deckId: 'd', created: Number(id.replace(/\D/g, '')) || 0, ...extra });
const pic = (id, p) => card(id, { frontImage: p });
const due = (cardId, at, state = 2) => [cardId, { cardId, state, due: at }];

test('cardFiles lists a card\'s pictures and sounds, ignoring junk', () => {
  assert.deepEqual(cardFiles({ frontImage: 'a', backImage: 'b', frontSounds: ['s1'], backSounds: ['s2', 's3'] }), { pictures: ['a', 'b'], sounds: ['s1', 's2', 's3'] });
  assert.deepEqual(cardFiles({ frontSounds: 'abc', backSounds: null, frontImage: '' }), { pictures: [], sounds: [] });
});

test('wantedMedia: what cards use and the device lacks, once each', () => {
  const cards = [pic('c1', 'p1'), pic('c2', 'p1'), pic('c3', 'p2'), card('c4', { backSounds: ['s1'] })];
  assert.deepEqual(wantedMedia(cards, new Set(['p2'])), { pictures: ['p1'], sounds: ['s1'] });
  assert.deepEqual(wantedMedia(cards, new Set(['p1', 'p2', 's1'])), { pictures: [], sounds: [] });
});

test('a sync fetches ahead only for cards due today, not for the whole account', () => {
  const cards = [];
  const states = new Map();
  for (let i = 1; i <= 2000; i++) cards.push(pic('c' + i, 'p' + i));      // 2,000 cards with a picture each
  for (let i = 1; i <= 25; i++) states.set(...due('c' + i, NOW - DAY));    // 25 of them are due
  for (let i = 26; i <= 2000; i++) states.set(...due('c' + i, NOW + 20 * DAY));
  const plan = planPrefetch({ cards, statesById: states, have: new Set(), now: NOW });
  assert.deepEqual(plan.ids, Array.from({ length: 25 }, (_, i) => 'p' + (i + 1)));      // just the 25 due cards (no new cards: all have a state)
});

test('a heavy day is capped per sync; the rest loads when its cards are shown', () => {
  const cards = Array.from({ length: 300 }, (_, i) => pic('c' + (i + 1), 'p' + (i + 1)));
  const states = new Map(cards.map(c => due(c.id, NOW - DAY)));
  const plan = planPrefetch({ cards, statesById: states, have: new Set(), now: NOW });
  assert.equal(plan.ids.length, PREFETCH_FILES);
});

test('new cards: only the first few after the due ones', () => {
  const cards = Array.from({ length: 100 }, (_, i) => pic('c' + (i + 1), 'p' + (i + 1)));
  const plan = planPrefetch({ cards, statesById: new Map(), have: new Set(), now: NOW, limit: 1000 });
  assert.equal(plan.ids.length, NEW_AHEAD);
  assert.deepEqual(plan.ids.slice(0, 3), ['p1', 'p2', 'p3']);             // in the order they were added
});

test('due cards come before new ones, learning cards due later today are included, tomorrow\'s are not', () => {
  const cards = [pic('c1', 'new1'), pic('c2', 'due'), pic('c3', 'later'), pic('c4', 'tomorrow')];
  const st = new Map([due('c2', NOW - 1000), due('c3', NOW + 2 * 3600000, 1), due('c4', NOW + 2 * DAY)]);
  const ids = planPrefetch({ cards, statesById: st, have: new Set(), now: NOW, newAhead: 5 }).ids;
  assert.deepEqual(ids, ['due', 'later', 'new1']);
});

test('suspended and buried cards, files already here, shared files and recent failures are left out', () => {
  const cards = [
    pic('c1', 'held'), pic('c2', 'x'), pic('c3', 'x'), pic('c4', 'failed'),
    card('c5', { frontImage: 'susp', suspended: true }), card('c6', { frontImage: 'buried', buriedUntil: NOW + DAY }),
    card('c7', { backSounds: ['snd'] })
  ];
  const plan = planPrefetch({ cards, statesById: new Map(), have: new Set(['held']), now: NOW, skip: id => id === 'failed' });
  assert.deepEqual(plan.ids, ['x', 'snd']);
});

test('over the limit: the rest is left for when its card shows', () => {
  const cards = Array.from({ length: 10 }, (_, i) => pic('c' + (i + 1), 'p' + (i + 1)));
  const plan = planPrefetch({ cards, statesById: new Map(), have: new Set(), now: NOW, limit: 4, newAhead: 10 });
  assert.equal(plan.ids.length, 4);
});

test('"keep everything" fetches every missing file, suspended cards too, without a limit', () => {
  const cards = [...Array.from({ length: 100 }, (_, i) => pic('c' + (i + 1), 'p' + (i + 1))), card('c200', { frontImage: 'susp', suspended: true })];
  const plan = planPrefetch({ cards, statesById: new Map(), have: new Set(['p5']), now: NOW, keepAll: true });
  assert.equal(plan.ids.length, 100);              // 101 files, minus the one held
  assert.ok(plan.ids.includes('susp') && !plan.ids.includes('p5'));
});

test('a failed download waits before it is tried again; the person asking always goes through', () => {
  const off = failedAgain(undefined, 'offline', 1000);
  assert.deepEqual(off, { at: 1000, reason: 'offline', tries: 1 });
  assert.equal(canTry(undefined, 5, 'view'), true);
  assert.equal(canTry(off, 1000 + 1000, 'view'), false);                  // a card drawn twice in a row doesn't ask twice
  assert.equal(canTry(off, 1000 + 3000, 'view'), true);
  assert.equal(canTry(off, 1000 + 5 * 60000, 'prefetch'), false);         // a sync doesn't hammer an offline server
  assert.equal(canTry(off, 1000 + 10 * 60000, 'prefetch'), true);
  assert.equal(canTry(off, 1000, 'force'), true);
  const missing = failedAgain(undefined, 'missing', 0);
  assert.equal(canTry(missing, 60000, 'view'), false);
  assert.equal(canTry(missing, 2 * 60000, 'view'), true);
  assert.equal(canTry(missing, 3600000, 'prefetch'), false);              // the account doesn't have it: not worth asking each sync
});

test('repeated errors back off, up to 6 hours', () => {
  let e;
  const waits = [];
  for (let i = 0; i < 12; i++) { e = failedAgain(e, 'error', 0); waits.push(retryWait(e, 'prefetch')); }
  assert.equal(waits[0], 2 * 60000);
  assert.equal(waits[1], 4 * 60000);
  assert.equal(Math.max(...waits), 6 * 3600000);
  assert.ok(waits.every((w, i) => i === 0 || w >= waits[i - 1]));
  assert.equal(failedAgain(e, 'offline', 0).tries, 1);                    // a different reason starts over
});

test('the words are quiet and say what will happen', () => {
  assert.match(mediaMessage('offline'), /Picture not downloaded yet\. It will load when you're online/);
  assert.match(mediaMessage('offline', true), /^Sound not downloaded yet/);
  assert.match(mediaMessage('signed-out'), /Sign in/);
  assert.match(mediaMessage('missing'), /isn't in your account any more/);
  assert.match(mediaMessage('error'), /Couldn't load this picture/);
  assert.equal(notDownloadedLine({ pictures: 3, sounds: 0 }), '3 pictures will download when a card needs them.');
  assert.equal(notDownloadedLine({ pictures: 1, sounds: 1 }), '1 picture and 1 sound will download when a card needs them.');
  assert.equal(notDownloadedLine({ pictures: 0, sounds: 0 }), '');
  assert.match(leftOutNote(2, 'offline'), /2 pictures and sounds aren't on this device yet, so they aren't included\. Connect to the internet/);
  assert.match(leftOutNote(1, 'signed-out'), /Sign in to download it/);
  assert.match(leftOutNote(3, 'missing', 3), /in your account any more/);
});

// ---------- what lazy loading must not change ----------
test('sweep: a device that does not hold a file never marks it, and a card that uses it keeps it', () => {
  // A: nothing is removed here (it never had the file), so nothing is marked; the card uses it, so nothing is swept.
  assert.deepEqual(planSweep({ used: new Set(['p1']), held: new Set(), removed: [], now: NOW }), { mark: [], unmark: [], sweep: [], reupload: [] });
  // B: a month-old mark on a file this device does not hold, but a card here uses it: un-marked, not swept.
  const p = planSweep({ marks: { p1: NOW - 40 * DAY }, used: new Set(['p1']), held: new Set(), now: NOW });
  assert.deepEqual(p.unmark, ['p1']);
  assert.deepEqual(p.sweep, []);
  // C: not holding a file says nothing about other devices: a file no card here uses is still only swept after the wait.
  assert.deepEqual(planSweep({ marks: { p2: NOW - WAIT_MS + 1000 }, used: new Set(), held: new Set(), now: NOW }).sweep, []);
});

test('re-upload: a device only sends again what it holds', () => {
  const p = planSweep({ gone: ['held', 'notheld', 'unused'], used: new Set(['held', 'notheld']), held: new Set(['held']), now: NOW });
  assert.deepEqual(p.reupload, ['held']);
});

test('which files a card uses does not depend on what the device holds', () => {
  const cards = [pic('c1', 'p1'), card('c2', { frontSounds: ['s1'] })];
  assert.deepEqual([...usedMediaIds(cards)].sort(), ['p1', 's1']);
});

test('keepAllMedia belongs to this device: not synced, not in backups', () => {
  assert.equal(isLocalOnly('keepAllMedia'), true);
  assert.equal(isSyncedSetting('keepAllMedia'), false);
});

// ---------- a card deleted before its picture was ever downloaded here ----------
test('droppedRefs: files the last sweep saw in use and no card uses now', () => {
  const prev = { userId: 'u1', ids: ['a', 'b', 'c'] };
  assert.deepEqual(droppedRefs({ prev, used: new Set(['a']), userId: 'u1' }), ['b', 'c']);
  assert.deepEqual(droppedRefs({ prev, used: new Set(['a', 'b', 'c', 'd']), userId: 'u1' }), []);
});

test('droppedRefs: no snapshot, another account or junk gives nothing (the snapshot is just taken again)', () => {
  const used = new Set();
  assert.deepEqual(droppedRefs({ prev: undefined, used, userId: 'u1' }), []);
  assert.deepEqual(droppedRefs({ prev: { userId: 'u2', ids: ['a'] }, used, userId: 'u1' }), []);
  assert.deepEqual(droppedRefs({ prev: { userId: 'u1', ids: 'abc' }, used, userId: 'u1' }), []);
  assert.deepEqual(droppedRefs({ prev: { userId: 'u1', ids: ['a', 5, null] }, used, userId: 'u1' }), ['a']);
});

test('a dropped file this device never held is marked, then swept after 30 days; the usual guards still apply', () => {
  const dropped = droppedRefs({ prev: { userId: 'u', ids: ['p1', 'p2', 'p3', 'p4'] }, used: new Set(['p4']), userId: 'u' });
  const p = planSweep({ marks: { p2: NOW - 2 * DAY }, gone: ['p3'], removed: dropped, used: new Set(['p4']), held: new Set(), now: NOW });
  assert.deepEqual(p.mark, ['p1']);               // p2 is already marked (keeps its date), p3 is gone, p4 is in use
  assert.deepEqual(p.sweep, []);
  const later = planSweep({ marks: { p1: NOW - 31 * DAY }, used: new Set(), held: new Set(), now: NOW });
  assert.deepEqual(later.sweep, ['p1']);
  // a file another card (here) still uses is never marked, even though the card that used it first was deleted
  assert.deepEqual(planSweep({ removed: droppedRefs({ prev: { userId: 'u', ids: ['s'] }, used: new Set(['s']), userId: 'u' }), used: new Set(['s']), now: NOW }).mark, []);
});

test('mediaRefs is this device only', () => {
  assert.equal(isLocalOnly('mediaRefs'), true);
  assert.equal(isSyncedSetting('mediaRefs'), false);
});
