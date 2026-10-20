// Tests for js/type-in.js (typing cards). Run with: node --test tests/type-in.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownTypeIn, cleanTypeIn, typeFacts, typeNote, answerMode, isTypingCard, setTypeIn, TYPE_HARD_MAX } from '../js/type-in.js';
import { checkTyped } from '../js/match.js';
import { answerTargets } from '../js/format.js';

const basic = (back = 'Paris', extra = {}) => ({ id: 'c', deckId: 'd', front: 'Capital of France', back, ...extra });
const cloze = (extra = {}) => ({ id: 'z1', deckId: 'd', noteId: 'N', cloze: 1, noteText: 'The {{c1::heart}} pumps {{c1::blood}}', front: 'x', back: 'heart, blood', ...extra });
const pic = (label, extra = {}) => ({ id: 'p1', deckId: 'd', noteId: 'P', front: 'Picture', back: label || 'Hidden area',
  occlusion: { n: 1, masks: [{ n: 1, label, shape: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }, ...extra });
const mode = (card, deck = false, session = false) => answerMode(card, typeFacts(card), deck, session);
const SHORT = 'Paris', FORTY_ONE = 'a'.repeat(41), FIVE_HUNDRED_ONE = 'b'.repeat(501);

test('ownTypeIn: true, false, or null for anything else', () => {
  assert.equal(ownTypeIn({ typeIn: true }), true);
  assert.equal(ownTypeIn({ typeIn: false }), false);
  for (const v of [undefined, null, 'yes', 1, 0, '', [], {}]) assert.equal(ownTypeIn({ typeIn: v }), null);
  assert.equal(ownTypeIn(null), null);
});

test('cleanTypeIn drops a value that is not a boolean and leaves the rest of the card alone', () => {
  assert.deepEqual(cleanTypeIn({ id: 'a', typeIn: 'yes', back: 'b' }), { id: 'a', back: 'b' });
  assert.deepEqual(cleanTypeIn({ id: 'a', typeIn: 1 }), { id: 'a' });
  const ok = { id: 'a', typeIn: false };
  assert.equal(cleanTypeIn(ok), ok);
  const none = { id: 'a' };
  assert.equal(cleanTypeIn(none), none);
  assert.equal(cleanTypeIn(null), null);
});

test('answerMode: the card value, the deck default and the Today switch, for a short answer', () => {
  const rows = [
    // own, deck, session → type
    [undefined, false, false, false], [undefined, true, false, true], [undefined, false, true, true], [undefined, true, true, true],
    [true, false, false, true], [true, true, true, true],
    [false, false, false, false], [false, true, false, false], [false, false, true, false], [false, true, true, false],
  ];
  for (const [own, deck, session, want] of rows) {
    const card = basic(SHORT, own === undefined ? {} : { typeIn: own });
    assert.equal(mode(card, deck, session).type, want, `own=${own} deck=${deck} session=${session}`);
  }
  assert.equal(mode(basic(SHORT, { typeIn: false }), true, true).why, 'card');
  assert.equal(mode(basic(SHORT), false, false).why, 'off');
});

test('answerMode: junk values follow the deck', () => {
  assert.equal(mode(basic(SHORT, { typeIn: 'yes' }), false, false).type, false);
  assert.equal(mode(basic(SHORT, { typeIn: 1 }), true, false).type, true);
});

test('answerMode: a long answer is typed only when the card says so, up to 500 characters', () => {
  assert.equal(TYPE_HARD_MAX, 500);
  const at = (back, own, deck = false, session = false) => mode(basic(back, own === undefined ? {} : { typeIn: own }), deck, session);
  assert.deepEqual(at('a'.repeat(40), undefined, true), { type: true, wanted: true, why: '' });
  assert.deepEqual(at(FORTY_ONE, undefined, true), { type: false, wanted: true, why: 'long' });          // a deck default stops at 40
  assert.deepEqual(at(FORTY_ONE, undefined, false, true), { type: false, wanted: true, why: 'long' });   // so does the Today switch
  assert.deepEqual(at(FORTY_ONE, true), { type: true, wanted: true, why: '' });                          // a card that asks is typed anyway
  assert.equal(at('c'.repeat(500), true).type, true);
  assert.deepEqual(at(FIVE_HUNDRED_ONE, true), { type: false, wanted: true, why: 'long' });
  assert.equal(at(FORTY_ONE, false, true, true).type, false);
});

test('answerMode: nothing to type flips, whatever is asked', () => {
  const emptyBack = basic('', { backImage: 'img1', typeIn: true });
  assert.deepEqual(mode(emptyBack, true, true), { type: false, wanted: true, why: 'empty' });
  assert.equal(mode(basic('', { typeIn: true })).why, 'empty');
  const unlabelled = pic('', { typeIn: true });
  assert.deepEqual(mode(unlabelled, true, true), { type: false, wanted: true, why: 'nolabel' });
  assert.equal(mode(pic('Aorta', { typeIn: true })).type, true);
  assert.equal(mode(pic('Aorta')).type, false);
  assert.equal(mode(pic('Aorta'), false, true).type, true);
  assert.equal(mode(pic('Aorta'), true).type, true);
});

test('answerMode: step-by-step and elements cards are always flipped, even with typeIn true', () => {
  const steps = basic('Step 1: add\nStep 2: divide', { typeIn: true });
  const els = basic('Element 1: red\nElement 2: blue', { typeIn: true });
  for (const c of [steps, els]) {
    assert.deepEqual(mode(c, true, true), { type: false, wanted: true, why: 'structured' });
    assert.equal(typeFacts(c).structured, true);
  }
  assert.equal(mode(basic('Step 1: add\nStep 2: divide'), false, false).type, false);
});

test('typeFacts: plain, cloze, picture, formula and alternates', () => {
  assert.deepEqual(typeFacts(basic('Paris')), { structured: false, answer: 'Paris', picture: false });
  assert.deepEqual(typeFacts(cloze()), { structured: false, answer: 'heart, blood', picture: false });
  assert.deepEqual(typeFacts(pic('Aorta')), { structured: false, answer: 'Aorta', picture: true });
  assert.deepEqual(typeFacts(pic('')), { structured: false, answer: '', picture: true });
  assert.equal(typeFacts(basic('$x^2$')).answer, 'x^2');
  assert.equal(typeFacts(basic('red / scarlet')).answer, 'red / scarlet');
  // a cloze card whose answer looks like steps is still a cloze card
  assert.equal(typeFacts(cloze({ back: 'Step 1: a\nStep 2: b' })).structured, false);
});

test('a formula answer: both the written and the plain wording are right, but not one half of a fraction', () => {
  const targets = answerTargets('$\\frac{1}{2}$');
  assert.equal(checkTyped('1/2', targets).correct, true);
  assert.equal(checkTyped('2', targets).correct, false);
});

test('isTypingCard ignores the Today switch', () => {
  assert.equal(isTypingCard(basic(SHORT, { typeIn: true }), false), true);
  assert.equal(isTypingCard(basic(SHORT), true), true);
  assert.equal(isTypingCard(basic(SHORT), false), false);
  assert.equal(isTypingCard(basic(SHORT, { typeIn: false }), true), false);
  assert.equal(isTypingCard(basic(FORTY_ONE), true), false);
});

test('setTypeIn: sets only the cards that change', () => {
  const a = basic(SHORT, { id: 'a' }), b = basic(SHORT, { id: 'b', typeIn: true }), c = basic(SHORT, { id: 'c', typeIn: false });
  const r = setTypeIn([a, b, c], true, [a, b, c]);
  assert.deepEqual(r.changed.map(x => [x.id, x.typeIn]), [['a', true], ['c', true]]);
  assert.equal(r.skipped, 0);
  assert.deepEqual(setTypeIn([a, b, c], false, [a, b, c]).changed.map(x => x.id), ['a', 'b']);
  assert.equal(a.typeIn, undefined, 'the cards given are not changed');
});

test('setTypeIn: null removes the field, and a card without it is not returned', () => {
  const a = basic(SHORT, { id: 'a' }), b = basic(SHORT, { id: 'b', typeIn: true }), c = basic(SHORT, { id: 'c', typeIn: 'junk' });
  const r = setTypeIn([a, b, c], null, [a, b, c]);
  assert.deepEqual(r.changed.map(x => x.id), ['b', 'c']);
  for (const x of r.changed) assert.equal(Object.hasOwn(x, 'typeIn'), false);
});

test('setTypeIn: a cloze or picture note changes all its cards, a reverse partner is left alone', () => {
  const z1 = cloze(), z2 = cloze({ id: 'z2', cloze: 2 }), other = cloze({ id: 'y1', noteId: 'M' });
  const p1 = pic('Aorta'), p2 = { ...pic('Vena'), id: 'p2', occlusion: { n: 2, masks: [{ n: 2, label: 'Vena', shape: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 }] } };
  const fwd = basic(SHORT, { id: 'f', noteId: 'R' }), rev = { ...basic('Capital of France', { id: 'r', noteId: 'R', reverse: true }), front: 'Paris' };
  const all = [z1, z2, other, p1, p2, fwd, rev];
  assert.deepEqual(setTypeIn([z1], true, all).changed.map(x => x.id).sort(), ['z1', 'z2']);
  assert.deepEqual(setTypeIn([p2], true, all).changed.map(x => x.id).sort(), ['p1', 'p2']);
  assert.deepEqual(setTypeIn([fwd], true, all).changed.map(x => x.id), ['f']);
  assert.deepEqual(setTypeIn([z1, z2], true, all).changed.map(x => x.id).sort(), ['z1', 'z2'], 'no card twice');
});

test('setTypeIn: typing skips step-by-step and elements cards and counts them', () => {
  const s = basic('Step 1: a\nStep 2: b', { id: 's' }), e = basic('Element 1: a\nElement 2: b', { id: 'e' }), n = basic(SHORT, { id: 'n' });
  const r = setTypeIn([s, e, n], true, [s, e, n]);
  assert.deepEqual(r.changed.map(x => x.id), ['n']);
  assert.equal(r.skipped, 2);
  const f = setTypeIn([s, e, n], false, [s, e, n]);
  assert.equal(f.changed.length, 3, 'flipping and "same as the deck" still apply to them');
  assert.equal(f.skipped, 0);
});

test('answerMode: a deck that types short answers also types "red; scarlet; crimson" listed as short alternatives', () => {
  const part = 'x'.repeat(30);
  assert.equal(mode({ back: `${part}; ${part}; ${part}` }, true).type, true);
  assert.equal(mode({ back: `${part}; ${'x'.repeat(41)}` }, true).why, 'long');
});

test('typeNote: the editor hint agrees with canType (alternatives are judged one by one)', () => {
  assert.equal(typeNote({ value: null, deckDefault: true, length: 70, typeable: true }), '', 'long list of short alternatives: no warning');
  assert.match(typeNote({ value: null, deckDefault: true, length: 70, typeable: false }), /only types answers of 40/);
  assert.match(typeNote({ value: true, length: 70, typeable: false }), /Long answer/);
  assert.match(typeNote({ value: true, length: 50 }), /Long answer/, 'without typeable it follows the length');
});
