// Tests for js/anki-match.js (finding the cards a re-imported Anki deck already has). Run with: node tests/anki-match.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotOf, rowSlot, indexByGuid, matchRows, mergeCard, noteIdMap, sameContent, countMatches } from '../js/anki-match.js';

test('a card\'s place in its note', () => {
  assert.equal(slotOf({ front: 'a', back: 'b' }), 'f');
  assert.equal(slotOf({ front: 'a', back: 'b', reverse: true, noteId: 'n' }), 'r');
  assert.equal(slotOf({ cloze: 2, noteText: 'x' }), 'c2');
  assert.equal(slotOf({ occlusion: { n: 3, masks: [] } }), 'o3');
  assert.equal(rowSlot({ cloze: { noteKey: 'k', n: 1 } }), 'c1');
  assert.equal(rowSlot({ occlusion: { noteKey: 'k', n: 2 } }), 'o2');
  assert.equal(rowSlot({ front: 'x' }), 'f');
});

test('sibling cards of one note do not collide', () => {
  const saved = [
    { id: 'a', ankiGuid: 'G', cloze: 1, created: 1 }, { id: 'b', ankiGuid: 'G', cloze: 2, created: 2 },
    { id: 'c', ankiGuid: 'H', created: 3 }, { id: 'd', ankiGuid: 'H', reverse: true, created: 4 }, { id: 'e', front: 'no guid' }
  ];
  const idx = indexByGuid(saved);
  const m = matchRows([{ guid: 'G', slot: 'c2' }, { guid: 'G', slot: 'c1' }, { guid: 'G', slot: 'c3' }, { guid: 'H', slot: 'r' }, { guid: 'H', slot: 'f' }, { guid: '', slot: 'f' }, { guid: 'Z', slot: 'f' }], idx);
  assert.deepEqual(m.map(c => c?.id ?? null), ['b', 'a', null, 'd', 'c', null, null]);
});

test('a saved card is matched once; the oldest copy wins', () => {
  const idx = indexByGuid([{ id: 'new', ankiGuid: 'G', created: 9 }, { id: 'old', ankiGuid: 'G', created: 1 }]);
  const m = matchRows([{ guid: 'G', slot: 'f' }, { guid: 'G', slot: 'f' }], idx);
  assert.deepEqual(m.map(c => c?.id ?? null), ['old', null]);
});

test('an update replaces content and keeps everything else', () => {
  const old = { id: 'x', deckId: 'D', front: 'old', back: 'old b', frontImage: 'm1', noteFields: [{ name: 'A', text: 'a' }], noteExtra: 'e', typeIn: true,
    tags: ['mine'], created: 5, flag: 2, suspended: true, acceptAnswers: ['q'], ankiGuid: 'G', updatedAt: 7, syncedAt: 8 };
  const fresh = { id: 'other', deckId: 'E', front: 'new', back: 'new b', tags: ['mine', 'anki'], created: 99, ankiGuid: 'G', backImage: 'm2' };
  const m = mergeCard(old, fresh, undefined, 1000);
  assert.equal(m.id, 'x'); assert.equal(m.deckId, 'D'); assert.equal(m.created, 5);
  assert.equal(m.front, 'new'); assert.equal(m.back, 'new b'); assert.equal(m.backImage, 'm2');
  for (const k of ['frontImage', 'noteFields', 'noteExtra', 'typeIn']) assert.equal(k in m, false, k);
  assert.deepEqual(m.tags, ['mine', 'anki']);
  assert.equal(m.flag, 2); assert.equal(m.suspended, true); assert.deepEqual(m.acceptAnswers, ['q']);
  assert.equal(m.noteId, undefined);
});

test('cloze and occlusion data come from the new card', () => {
  const old = { id: 'x', cloze: 1, noteText: 'old {{c1::a}}', noteId: 'A', front: 'old […]', back: 'a', ankiGuid: 'G' };
  const fresh = { cloze: 1, noteText: 'new {{c1::b}}', noteId: 'tmp', front: 'new […]', back: 'b', ankiGuid: 'G' };
  const m = mergeCard(old, fresh, 'A', 5);
  assert.equal(m.noteText, 'new {{c1::b}}'); assert.equal(m.noteId, 'A'); assert.equal(m.noteEditedAt, 5);
  const o = mergeCard({ id: 'o', occlusion: { n: 1, masks: [1] }, backImage: 'p1', ankiGuid: 'G' }, { occlusion: { n: 1, masks: [2] }, backImage: 'p2', ankiGuid: 'G' });
  assert.deepEqual(o.occlusion.masks, [2]); assert.equal(o.backImage, 'p2');
});

test('new siblings join the note the saved cards already belong to', () => {
  const map = noteIdMap([[{ noteId: 'A' }, { noteId: 'tmp1' }], [{ noteId: 'A' }, { noteId: 'tmp1' }], [{}, { noteId: 'tmp2' }], [{ id: 'p' }, {}]]);
  assert.equal(map.get('tmp1'), 'A');
  assert.equal(map.get('tmp2'), 'tmp2');       // a saved card with no note takes the new one
  assert.equal(map.size, 2);
});

test('unchanged content is recognised, a change to the text or tags is not', () => {
  const a = { id: 'x', front: 'f', back: 'b', tags: ['t', 'u'], deckId: 'D', updatedAt: 1 };
  assert.ok(sameContent(a, { ...a, updatedAt: 2, deckId: 'E', tags: ['u', 't'] }));
  assert.ok(!sameContent(a, { ...a, back: 'c' }));
  assert.ok(!sameContent(a, { ...a, tags: ['t'] }));
  assert.ok(!sameContent(a, { ...a, frontImage: 'm' }));
});

test('counting what a preview would update (both directions can match twice)', () => {
  const idx = indexByGuid([{ id: '1', ankiGuid: 'G' }, { id: '2', ankiGuid: 'G', reverse: true }, { id: '3', ankiGuid: 'H', cloze: 1 }]);
  const n = countMatches([{ ankiGuid: 'G', reverse: true }, { ankiGuid: 'H', cloze: { n: 1 } }, { ankiGuid: 'H', cloze: { n: 2 } }, { ankiGuid: 'Q' }], idx);
  assert.equal(n, 3);
  assert.equal(countMatches([{ ankiGuid: 'G' }], null), 0);
});

test('cards of one note that share a guid and a note id are told apart by templateOrd', () => {
  const saved = [
    { id: 'a', ankiGuid: 'G', noteId: 'N', templateOrd: 0, created: 1 }, { id: 'b', ankiGuid: 'G', noteId: 'N', templateOrd: 1, created: 2 },
    { id: 'old', ankiGuid: 'H', created: 3 }      // saved before templateOrd existed
  ];
  const idx = indexByGuid(saved);
  assert.equal(slotOf(saved[0]), 'ft0'); assert.equal(slotOf(saved[1]), 'ft1'); assert.equal(slotOf(saved[2]), 'f');
  const m = matchRows([{ guid: 'G', slot: 'ft1' }, { guid: 'G', slot: 'ft0' }, { guid: 'G', slot: 'ft2' }, { guid: 'G', slot: 'f' }, { guid: 'H', slot: 'f' }, { guid: 'H', slot: 'ft0' }], idx);
  // ft2 has no saved card: it is added, not used to overwrite a sibling. A missing templateOrd is its own key, not t0 (G has no plain card).
  assert.deepEqual(m.map(c => c?.id ?? null), ['b', 'a', null, null, 'old', null]);      // (the last one: old was already taken by the plain f)
  // the preview's rows carry templateOrd too, and a reverse card keeps its own key
  assert.equal(rowSlot({ templateOrd: 1 }), 'ft1'); assert.equal(rowSlot({ templateOrd: 0 }, true), 'rt0'); assert.equal(rowSlot({}), 'f');
  assert.equal(countMatches([{ ankiGuid: 'G', templateOrd: 0 }, { ankiGuid: 'G', templateOrd: 1 }, { ankiGuid: 'G', templateOrd: 2 }], idx), 2);
});

test('a card saved before templateOrd existed becomes template 0 of its note', () => {
  const old = { id: 'old', ankiGuid: 'G', front: 'Q', back: 'A', tags: [], created: 1 };      // imported with only its first card
  const idx = indexByGuid([old, { id: 'cloze', ankiGuid: 'G', cloze: 1 }, { id: 'rev', ankiGuid: 'G', reverse: true, noteId: 'P' }]);
  // incoming: the note's cards ft0, ft1, ft2
  const m = matchRows([{ guid: 'G', slot: 'ft0' }, { guid: 'G', slot: 'ft1' }, { guid: 'G', slot: 'ft2' }], idx);
  assert.deepEqual(m.map(c => c?.id ?? null), ['old', null, null]);
  // the update relinks it: templateOrd 0 and the note's shared noteId
  const fresh = { ankiGuid: 'G', front: 'Q2', back: 'A2', templateOrd: 0, noteId: 'tmp' };
  const map = noteIdMap([[old, fresh]]);
  const merged = mergeCard(old, fresh, map.get('tmp'), 9);
  assert.equal(merged.templateOrd, 0); assert.equal(merged.noteId, 'tmp'); assert.equal(merged.id, 'old'); assert.equal(merged.front, 'Q2');
  assert.ok(!sameContent(old, merged));
  // a second import finds it by its exact key, with no fallback needed
  assert.equal(matchRows([{ guid: 'G', slot: 'ft0' }], indexByGuid([merged]))[0].id, 'old');
  // an exact ft0 card wins over a plain one; the plain one is not stolen
  const both = indexByGuid([merged, { id: 'plain', ankiGuid: 'G' }]);
  assert.deepEqual(matchRows([{ guid: 'G', slot: 'ft0' }], both).map(c => c.id), ['old']);
  // a reverse card has no fallback
  assert.equal(matchRows([{ guid: 'G', slot: 'rt0' }], idx)[0], null);
});
