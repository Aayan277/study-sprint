// Tests for duplicating cards (js/browse-logic.js duplicateCards) and the editor panel's width limits (js/panel-resize.js).
// Run with: node --test tests/duplicate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateCards } from '../js/browse-logic.js';
import { PANEL_MIN, PANEL_KEY, panelMax, clampPanel, savedPanel, savePanel } from '../js/panel-resize.js';

const mkId = () => { let n = 0; return () => 'new' + ++n; };
const NOW = 1_800_000_000_000;
const basic = {
  id: 'a', deckId: 'd1', front: 'F', back: 'B', frontImage: 'm1', backImage: 'm2', noteExtra: 'hook', tags: ['x', 'y'],
  acceptAnswers: ['alt'], frontSounds: ['s1'], backSounds: ['s2', 's3'], created: 5, flag: 2, suspended: true, buriedUntil: NOW + 1000, updatedAt: 99
};

test('a basic card is copied with everything but its id, schedule and own state', () => {
  const { copies, firstCopy, of } = duplicateCards([basic], [basic], mkId(), NOW);
  assert.equal(copies.length, 1);
  const c = firstCopy;
  assert.equal(c.id, 'new1'); assert.equal(of.get('a'), 'new1');
  for (const k of ['deckId', 'front', 'back', 'frontImage', 'backImage', 'noteExtra']) assert.equal(c[k], basic[k], k);
  assert.deepEqual(c.tags, ['x', 'y']); assert.deepEqual(c.acceptAnswers, ['alt']);
  assert.equal(c.created, NOW);
  for (const k of ['flag', 'suspended', 'buriedUntil', 'updatedAt']) assert.ok(!(k in c), k + ' should not be copied');
  // the copy's lists are its own
  assert.deepEqual(c.frontSounds, ['s1']); assert.deepEqual(c.backSounds, ['s2', 's3']);
  c.tags.push('z'); c.acceptAnswers.push('q'); c.backSounds.push('s9');
  assert.deepEqual(basic.backSounds, ['s2', 's3']);
  assert.deepEqual(basic.tags, ['x', 'y']); assert.deepEqual(basic.acceptAnswers, ['alt']);
});

test('a cloze note is copied whole under one new noteId', () => {
  const mk = (id, n) => ({ id, deckId: 'd', front: 'f', back: 'b', noteId: 'N', noteText: '{{c1::a}} {{c2::b}}', cloze: n, created: n, tags: ['t'] });
  const all = [mk('c2', 2), mk('c1', 1), { id: 'other', deckId: 'd', noteId: 'M', front: '', back: '', created: 3 }];
  const { copies, firstCopy } = duplicateCards([all[0]], all, mkId(), NOW);
  assert.equal(copies.length, 2);
  assert.equal(new Set(copies.map(c => c.noteId)).size, 1);
  assert.notEqual(copies[0].noteId, 'N');
  assert.deepEqual(copies.map(c => c.cloze), [1, 2]);          // in the note's own order
  assert.equal(firstCopy.cloze, 2);                              // the copy of the card that was picked
  assert.ok(copies.every(c => c.noteText === '{{c1::a}} {{c2::b}}' && c.id !== 'c1' && c.id !== 'c2'));
});

test('an occlusion note is copied whole, with its own copy of the boxes', () => {
  const occ = n => ({ id: 'o' + n, deckId: 'd', noteId: 'P', backImage: 'img', created: n, occlusion: { n, w: 10, h: 10, masks: [{ n, x: 1, y: 1, w: 2, h: 2 }] } });
  const all = [occ(1), occ(2), occ(3)];
  const { copies } = duplicateCards([all[1]], all, mkId(), NOW);
  assert.equal(copies.length, 3);
  assert.ok(copies.every(c => c.backImage === 'img' && c.noteId !== 'P'));
  copies[0].occlusion.masks[0].x = 99;
  assert.equal(all[0].occlusion.masks[0].x, 1);
});

test('several picked cards of one note make one copy of the note; other cards are copied one each', () => {
  const mk = (id, n) => ({ id, deckId: 'd', noteId: 'N', noteText: 't', cloze: n, created: n });
  const all = [mk('c1', 1), mk('c2', 2), basic];
  const { copies } = duplicateCards([all[0], all[1], basic], all, mkId(), NOW);
  assert.equal(copies.length, 3);
  assert.equal(copies.filter(c => c.noteId).length, 2);
  assert.equal(new Set(copies.map(c => c.id)).size, 3);
});

test('a copy gets no Anki guid, sync stamp or uid, and no leech tag (two notes must not share a guid)', () => {
  const c = { ...basic, ankiGuid: 'G1', ankiId: 5, syncedAt: 7, uid: 'u', tags: ['x', 'leech'] };
  const { firstCopy } = duplicateCards([c], [c], mkId(), NOW);
  for (const k of ['ankiGuid', 'ankiId', 'syncedAt', 'uid']) assert.ok(!(k in firstCopy), k);
  assert.deepEqual(firstCopy.tags, ['x']);
  assert.deepEqual(c.tags, ['x', 'leech']);
});

test('a reverse pair is copied as a new pair (both cards, one new noteId, links pointing at the copies)', () => {
  const fwd = { id: 'f', deckId: 'd', front: 'a', back: 'b', noteId: 'P', created: 1 };
  const rev = { id: 'r', deckId: 'd', front: 'b', back: 'a', noteId: 'P', reverse: true, reverseOf: 'f', created: 2 };
  const { copies, of } = duplicateCards([rev], [fwd, rev], mkId(), NOW);
  assert.equal(copies.length, 2);
  assert.equal(new Set(copies.map(c => c.noteId)).size, 1);
  assert.notEqual(copies[0].noteId, 'P');
  const r2 = copies.find(c => c.reverse);
  assert.equal(r2.reverseOf, of.get('f'));
});

test('a lone pair card (its partner is missing) is copied as an ordinary card', () => {
  const rev = { id: 'r', deckId: 'd', front: 'b', back: 'a', noteId: 'P', reverse: true, reverseOf: 'gone', created: 2 };
  const { copies, firstCopy } = duplicateCards([rev], [rev], mkId(), NOW);
  assert.equal(copies.length, 1);
  for (const k of ['noteId', 'reverse', 'reverseOf']) assert.ok(!(k in firstCopy), k);
});

test('panel width limits: 360 px up to 70% of the window, the list keeps 320 px', () => {
  assert.equal(PANEL_MIN, 360);
  assert.equal(panelMax(1440, 248), 872);                         // 1440 - 248 - 320 is less than 70% (1008)
  assert.equal(panelMax(2400, 248), 1680);                        // 70% is less than 2400 - 248 - 320
  assert.equal(clampPanel(100, 1440, 248), 360);
  assert.equal(clampPanel(5000, 1440, 248), 872);
  assert.equal(clampPanel(500, 1440, 248), 500);
  assert.equal(panelMax(1200, 1000), 360);                        // a tiny window: the editor keeps its minimum
  assert.equal(clampPanel('x', 1440, 0), 360);
});

test('the saved panel width: junk and a broken storage are ignored', () => {
  const mem = new Map();
  const store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  assert.equal(savedPanel(store), null);
  savePanel(store, 512.4);
  assert.equal(mem.get(PANEL_KEY), '512');
  assert.equal(savedPanel(store), 512);
  mem.set(PANEL_KEY, '12'); assert.equal(savedPanel(store), null);
  mem.set(PANEL_KEY, 'abc'); assert.equal(savedPanel(store), null);
  savePanel(store, null); assert.equal(mem.has(PANEL_KEY), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(savedPanel(broken), null);
  assert.doesNotThrow(() => savePanel(broken, 500));
});
