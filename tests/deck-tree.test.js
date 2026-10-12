// Tests for js/deck-tree.js (subdecks). Run with: node tests/deck-tree.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, chainMap, subtreeIds, deckPath, treeOrder, canNest, effectiveDeck, ankiPath, deckChoices } from '../js/deck-tree.js';

const decks = [
  { id: 'psy', name: 'Psych 101', options: { targetRetention: 0.95 }, examDate: '2026-12-01', ttsLang: 'en-GB' },
  { id: 'bio', name: 'Biology' },
  { id: 'u1', name: 'Unit 1', parentId: 'psy' },
  { id: 'l3', name: 'Lecture 3', parentId: 'u1', ttsLang: 'fr-FR', ttsAuto: true },
  { id: 'u2', name: 'Unit 2', parentId: 'psy', options: { targetRetention: 0.85 } },
  { id: 'lost', name: 'Orphan', parentId: 'gone' }
];

test('paths and ancestors', () => {
  assert.deepEqual(ancestors(decks, 'l3').map(d => d.id), ['l3', 'u1', 'psy']);
  assert.equal(deckPath(decks, 'l3'), 'Psych 101 › Unit 1 › Lecture 3');
  assert.equal(ankiPath(decks, 'l3'), 'Psych 101::Unit 1::Lecture 3');
  assert.equal(deckPath(decks, 'lost'), 'Orphan');                       // missing parent: top level
  assert.deepEqual(chainMap(decks).get('u2'), ['u2', 'psy']);
});

test('a deck includes everything inside it', () => {
  assert.deepEqual([...subtreeIds(decks, 'psy')].sort(), ['l3', 'psy', 'u1', 'u2']);
  assert.deepEqual([...subtreeIds(decks, 'u1')].sort(), ['l3', 'u1']);
  assert.deepEqual([...subtreeIds(decks, 'bio')], ['bio']);
});

test('tree order with depth', () => {
  assert.deepEqual(treeOrder(decks).map(x => `${'-'.repeat(x.depth)}${x.deck.id}`), ['psy', '-u1', '--l3', '-u2', 'bio', 'lost']);
});

test('no loops', () => {
  assert.equal(canNest(decks, 'psy', 'l3'), false);         // not inside its own subdeck
  assert.equal(canNest(decks, 'u1', 'u1'), false);
  assert.equal(canNest(decks, 'u1', 'bio'), true);
  assert.equal(canNest(decks, 'u1', ''), true);
  const looped = [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }];
  assert.ok(ancestors(looped, 'a').length <= 2);            // a broken loop can't hang
  assert.equal(treeOrder(looped).length, 2);
});

test('subdecks inherit settings unless they set their own', () => {
  const l3 = effectiveDeck(decks, 'l3');
  assert.deepEqual([l3.options, l3.examDate, l3.ttsLang, l3.ttsAuto], [{ targetRetention: 0.95 }, '2026-12-01', 'fr-FR', true]);
  assert.equal(effectiveDeck(decks, 'u2').options.targetRetention, 0.85);
  assert.equal(effectiveDeck(decks, 'bio').options, null);
  assert.equal(effectiveDeck(decks, 'nope'), null);
});

test('choices for deck lists use full paths in tree order', () => {
  assert.deepEqual(deckChoices(decks).slice(0, 3).map(c => c.label), ['Psych 101', 'Psych 101 › Unit 1', 'Psych 101 › Unit 1 › Lecture 3']);
  assert.deepEqual(deckChoices(decks, new Set(['u2', 'bio'])).map(c => c.id), ['u2', 'bio']);
});
