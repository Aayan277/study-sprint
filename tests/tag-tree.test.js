// Tests for js/tag-tree.js (tags as folders, and finding cards by question ID). Run with: node tests/tag-tree.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdsDetailed, tagTree, findNode, cardsUnder, parseIds, matchIds, idKey, normTag, hasFolders, crumbs, tagTreeHTML } from '../js/tag-tree.js';

const card = (id, tags) => ({ id, deckId: 'd', front: id, back: id, tags, created: 0 });
const AK = '#ak_step1_v12::#uworld::step';
// A small AnKing-style deck: UWorld Step 1 questions (two with two cards each), an AMBOSS question with an ID that UWorld also uses, and a plain tag.
const cards = [
  card('c1', [`${AK}::12345`, '#ak_step1_v12::#subject::cardio']),
  card('c2', [`${AK}::12345`]),
  card('c3', [`${AK}::23456`]),
  card('c4', [`${AK}::00789`, 'leech']),
  card('c5', ['#ak_step1_v12::#amboss::99999', '#ak_step1_v12::#amboss::12345']),
  card('c6', ['biology']),
  card('c7', [])
];

test('tagTree: folders, counts and order', () => {
  const tree = tagTree(cards);
  assert.deepEqual(tree.map(n => n.name), ['#ak_step1_v12', 'biology', 'leech']);
  const ak = findNode(tree, '#ak_step1_v12');
  assert.equal(ak.count, 5);                              // c1..c5, each once
  assert.equal(ak.own, 0);                                // the folder is not a tag itself
  assert.deepEqual(ak.children.map(n => n.name), ['#amboss', '#subject', '#uworld']);
  assert.equal(findNode(tree, `${AK}`).count, 4);
  assert.equal(findNode(tree, `${AK}::12345`).count, 2);
  assert.equal(findNode(tree, `${AK}::12345`).own, 2);
  assert.equal(findNode(tree, 'biology').children.length, 0);
  assert.equal(findNode(tree, 'nothing::here'), null);
});

test('tagTree: a card with two tags in one folder counts once there; a tag that is also a folder keeps its own count', () => {
  const t = tagTree([card('a', ['x::y', 'x::z', 'x']), card('b', ['x::y'])]);
  const x = findNode(t, 'x');
  assert.equal(x.count, 2);
  assert.equal(x.own, 1);
  assert.equal(findNode(t, 'x::y').count, 2);
});

test('numbers inside tag names sort in order', () => {
  const t = tagTree([card('a', ['s::10']), card('b', ['s::9']), card('c', ['s::100'])]);
  assert.deepEqual(findNode(t, 's').children.map(n => n.name), ['9', '10', '100']);
});

test('empty pieces ("a::::b") read as "a::b", and capitals do not matter', () => {
  assert.equal(normTag('A::::B'), 'a::b');
  const t = tagTree([card('a', ['a::::b'])]);
  assert.equal(findNode(t, 'a::b').count, 1);
  assert.equal(cardsUnder([card('a', ['a::::b'])], 'A').length, 1);
  assert.equal(hasFolders(cards), true);
  assert.equal(hasFolders([card('a', ['plain'])]), false);
});

test('cardsUnder: the tag itself and everything below it, not a longer name', () => {
  assert.deepEqual(cardsUnder(cards, '#ak_step1_v12::#uworld').map(c => c.id), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(cardsUnder(cards, `${AK}::12345`).map(c => c.id), ['c1', 'c2']);
  assert.deepEqual(cardsUnder(cards, '#AK_STEP1_V12::#UWorld::Step::23456').map(c => c.id), ['c3']);
  assert.deepEqual(cardsUnder([card('a', ['abc::x']), card('b', ['ab'])], 'ab').map(c => c.id), ['b']);      // "abc" is not under "ab"
  assert.deepEqual(cardsUnder(cards, ''), []);
});

test('parseIds: splits on spaces, commas, semicolons and lines; trims punctuation; no repeats', () => {
  assert.deepEqual(parseIds('12345, 23456 34567;45678\n56789'), ['12345', '23456', '34567', '45678', '56789']);
  assert.deepEqual(parseIds('(123), "456". [789]'), ['123', '456', '789']);
  assert.deepEqual(parseIds('123 123 0123 Q-9 q-9 A12B'), ['123', 'Q-9', 'A12B']);        // 0123 is 123; Q-9 is q-9
  assert.deepEqual(parseIds(''), []);
  assert.deepEqual(parseIds(null), []);
  assert.deepEqual(parseIds(' , ; '), []);
});

test('parseIds: only words with a digit are IDs; plain words are ignored and listed', () => {
  const r = parseIdsDetailed('Step 12345 the Step 2 CK step, 99');
  assert.deepEqual(r.ids, ['12345', '2', '99']);
  assert.deepEqual(r.ignored, ['Step', 'the', 'CK']);          // each once, ignoring capitals
  assert.deepEqual(parseIdsDetailed('hello world').ids, []);
  assert.deepEqual(parseIdsDetailed('').ignored, []);
});

test('parseIds: at most 5000 IDs', () => {
  const text = Array.from({ length: 6000 }, (_, i) => i + 1).join(' ');
  const ids = parseIds(text);
  assert.equal(ids.length, 5000);
  assert.equal(ids[0], '1');
});

test('idKey: numbers compare without leading zeros', () => {
  assert.equal(idKey('000123'), '123');
  assert.equal(idKey('0'), '0');
  assert.equal(idKey('00'), '0');
  assert.equal(idKey('Q-12'), 'q-12');
});

test('matchIds: finds cards by the last piece of a tag, in the order of the IDs', () => {
  const m = matchIds(cards, ['23456', '12345', '789', '55555']);
  assert.deepEqual(m.cards.map(c => c.id), ['c3', 'c1', 'c2', 'c5', 'c4']);      // 12345 is in both UWorld and AMBOSS
  assert.deepEqual(m.found, ['23456', '12345', '789']);
  assert.deepEqual(m.missing, ['55555']);
});

test('matchIds: leading zeros and capitals do not matter', () => {
  const m = matchIds(cards, ['789', '00012345']);
  assert.deepEqual(m.found, ['789', '00012345']);
  assert.equal(m.cards.length, 4);
  assert.equal(matchIds([card('a', ['bank::Q-ABC'])], ['q-abc']).cards.length, 1);
});

test('matchIds: IDs under more than one folder give a source for each, and `under` narrows to one', () => {
  const m = matchIds(cards, ['12345', '23456', '99999']);
  assert.deepEqual(m.sources.map(s => [s.path, s.ids.length, s.cards]), [
    ['#ak_step1_v12::#uworld::step', 2, 3],
    ['#ak_step1_v12::#amboss', 2, 1]
  ]);
  const uworld = matchIds(cards, ['12345', '23456', '99999'], { under: '#ak_step1_v12::#uworld' });
  assert.deepEqual(uworld.cards.map(c => c.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(uworld.found, ['12345', '23456']);
  assert.deepEqual(uworld.missing, ['99999']);
  assert.deepEqual(uworld.sources.length, 2);                  // the choice stays on screen
  const amboss = matchIds(cards, ['12345', '23456', '99999'], { under: '#AK_Step1_v12::#amboss' });
  assert.deepEqual(amboss.cards.map(c => c.id), ['c5']);
});

test('matchIds: a tag with no folder is matched by its whole name; a plain word is not an ID of a folder name', () => {
  const m = matchIds([card('a', ['12345']), card('b', ['x::12345::y'])], ['12345']);
  assert.deepEqual(m.cards.map(c => c.id), ['a']);              // "12345" in the middle of a path is a folder, not an ID
});

test('matchIds: 5000 IDs over 20000 cards is one pass', () => {
  const many = Array.from({ length: 20000 }, (_, i) => card('k' + i, [`bank::step::${i}`]));
  const ids = Array.from({ length: 5000 }, (_, i) => String(i * 4));
  const t0 = Date.now();
  const m = matchIds(many, ids);
  assert.equal(m.found.length, 5000);
  assert.ok(Date.now() - t0 < 1500);
});

test('crumbs and the tree HTML', () => {
  assert.equal(crumbs('#a::#b::c'), '#a › #b › c');
  const html = tagTreeHTML(tagTree(cards), { mode: 'manage' });
  assert.match(html, /data-path="#ak_step1_v12"/);
  assert.match(html, /5 cards/);
  assert.match(html, /data-tf-rename/);
  assert.doesNotMatch(html, /#ak_step1_v12::#uworld/);          // folders are drawn when opened
  assert.match(tagTreeHTML(tagTree([card('a', ['<b>'])]), { mode: 'pick' }), /&lt;b&gt;/);          // text is escaped
});
