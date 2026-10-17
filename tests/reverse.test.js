// Tests for js/reverse.js (cards that work in both directions) and how Play uses them. Run with: node tests/reverse.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPair, canReverse, reverseOf, pairPlan, healPairs, playRole, playPool, unpaired, syncPairChanges, swappedSides, reverseSwitchHTML } from '../js/reverse.js';
import { questionFor, playableCards } from '../js/game.js';
import { replaceInCards } from '../js/browse-logic.js';

const fwd = (extra = {}) => ({ id: 'f', deckId: 'd', noteId: 'N', front: 'Mitosis', back: 'Cell division', tags: ['bio'], created: 1000, ...extra });
const pair = (fx = {}, rx = {}) => { const f = fwd(fx); return [f, { ...reverseOf(f, 'r'), ...rx }]; };

test('isPair: a noteId and no cloze, occlusion or note text', () => {
  assert.equal(isPair(fwd()), true);
  assert.equal(isPair(fwd({ reverse: true })), true);
  assert.equal(isPair({ id: 'x', front: 'a', back: 'b' }), false);
  assert.equal(isPair(fwd({ cloze: 1, noteText: '{{c1::a}}' })), false);
  assert.equal(isPair(fwd({ noteText: 'x' })), false);
  assert.equal(isPair(fwd({ occlusion: { n: 1, masks: [] } })), false);
  assert.equal(isPair(null), false);
});

test('canReverse: not cloze, occlusion, steps or elements; both sides need something', () => {
  const ok = { front: 'a', back: 'b' };
  assert.equal(canReverse(ok), true);
  assert.equal(canReverse({ ...ok, noteId: 'N', cloze: 1, noteText: '{{c1::a}}' }), false);
  assert.equal(canReverse({ ...ok, noteId: 'N', occlusion: { n: 1, masks: [] } }), false);
  assert.equal(canReverse({ front: 'Make tea', back: 'Step 1: boil\nStep 2: pour' }), false);
  assert.equal(canReverse({ front: 'Negligence', back: 'Element 1: Duty\nElement 2: Breach' }), false);
  assert.equal(canReverse({ front: 'Element 1: the lightest?', back: 'Hydrogen' }), true, 'only the back is read for elements');
  assert.equal(canReverse({ front: 'a', back: '' }), false);
  assert.equal(canReverse({ front: '', back: 'b' }), false);
  assert.equal(canReverse({ front: '', frontImage: 'm1', back: 'Heart' }), true, 'a picture-only front is fine: the reverse card answers with the picture');
  assert.equal(canReverse({ front: 'dog', back: '', backSounds: ['s1'] }), true, 'and so is a sound');
});

test('reverseOf: the sides swapped with their pictures and sounds, a new schedule, shared fields kept', () => {
  const f = fwd({ frontImage: 'i1', backSounds: ['s1', 's2'], noteExtra: 'Hook', noteFields: [{ name: 'First Aid', text: 'p. 12' }], suspended: true, flag: 2, buriedUntil: 5, updatedAt: 9 });
  const r = reverseOf(f, 'r');
  assert.equal(r.id, 'r');
  assert.equal(r.front, 'Cell division'); assert.equal(r.back, 'Mitosis');
  assert.equal(r.backImage, 'i1'); assert.equal(r.frontImage, undefined);
  assert.deepEqual(r.frontSounds, ['s1', 's2']); assert.equal(r.backSounds, undefined);
  assert.equal(r.reverse, true);
  assert.equal(r.noteId, 'N'); assert.equal(r.deckId, 'd');
  assert.deepEqual(r.tags, ['bio']); assert.equal(r.noteExtra, 'Hook'); assert.deepEqual(r.noteFields, [{ name: 'First Aid', text: 'p. 12' }]);
  assert.equal(r.suspended, undefined); assert.equal(r.flag, undefined); assert.equal(r.buriedUntil, undefined); assert.equal(r.updatedAt, undefined);
  assert.equal(r.created, 1000.5, 'sits right after the forward card in the new-card order');
  assert.deepEqual(swappedSides(r), { front: 'Mitosis', back: 'Cell division', frontImage: 'i1', backSounds: ['s1', 's2'] }, 'swapping twice is the original');
});

test('pairPlan: an edit to either card rewrites the other, swapped', () => {
  const [f, r] = pair({ frontImage: 'i1' });
  const [a, b] = pairPlan(f, r, { front: 'Mitosis (M phase)', back: 'Division of the nucleus', frontImage: null });
  assert.equal(a.front, 'Mitosis (M phase)'); assert.equal(a.frontImage, undefined);
  assert.equal(b.front, 'Division of the nucleus'); assert.equal(b.back, 'Mitosis (M phase)'); assert.equal(b.backImage, undefined);
  assert.equal(b.reverse, true); assert.equal(b.id, 'r');
  // editing the reverse card: its front is the forward card's back
  const [a2, b2] = pairPlan(r, f, { front: 'New back', back: 'New front' });
  assert.equal(a2.id, 'r'); assert.equal(b2.id, 'f');
  assert.equal(b2.front, 'New front'); assert.equal(b2.back, 'New back');
  assert.equal(b2.reverse, undefined, 'the forward card stays the forward card');
});

test('healPairs: after a sync clash the newer note edit wins and rewrites the other card', () => {
  const [f, r] = pair({ noteEditedAt: 100, updatedAt: 100 }, { noteEditedAt: 100, updatedAt: 100 });
  assert.deepEqual(healPairs([f, r]), [], 'cards that agree are left alone');
  // the forward card was edited later on another device
  const f2 = { ...f, front: 'Mitosis!', noteEditedAt: 200, updatedAt: 200 };
  const [fixed] = healPairs([f2, r]);
  assert.equal(fixed.id, 'r'); assert.equal(fixed.back, 'Mitosis!'); assert.equal(fixed.front, 'Cell division');
  assert.equal(fixed.noteEditedAt, 200, 'the winner\'s time, never "now"');
  assert.equal(fixed.reverse, true);
  // the reverse card's back was edited later: the forward card's front follows
  const r2 = { ...r, back: 'Mitosis?!', noteEditedAt: 300, updatedAt: 300 };
  const [fixed2] = healPairs([f2, r2]);
  assert.equal(fixed2.id, 'f'); assert.equal(fixed2.front, 'Mitosis?!'); assert.equal(fixed2.reverse, undefined);
  // the hook and other fields are part of what must agree
  const r3 = { ...r, noteExtra: 'New hook', noteFields: [{ name: 'A', text: 'b' }], noteEditedAt: 400 };
  const [fixed3] = healPairs([f, r3]);
  assert.equal(fixed3.noteExtra, 'New hook'); assert.deepEqual(fixed3.noteFields, [{ name: 'A', text: 'b' }]);
  // an equal time: the forward card wins, on every device
  const tie = healPairs([{ ...f, front: 'X' }, { ...r, noteEditedAt: 100 }].map(c => ({ ...c, noteEditedAt: 100 })));
  assert.equal(tie[0].id, 'r'); assert.equal(tie[0].back, 'X');
  // cards saved before noteEditedAt existed compete by updatedAt
  const old = healPairs([{ ...f, front: 'Y', updatedAt: 500, noteEditedAt: undefined }, { ...r, updatedAt: 100, noteEditedAt: undefined }]);
  assert.equal(old[0].id, 'r'); assert.equal(old[0].back, 'Y');
});

test('healPairs: a card whose partner is gone becomes an ordinary card (after a few minutes), cloze and picture notes are left to their own healing', () => {
  const now = 1_000_000_000;
  const [f] = pair({ noteEditedAt: now - 3_600_000, updatedAt: now - 3_600_000 });
  const [lone] = healPairs([f], now);
  assert.equal(lone.noteId, undefined); assert.equal(lone.reverse, undefined); assert.equal(lone.noteEditedAt, undefined); assert.equal(lone.front, 'Mitosis');
  // saved a minute ago: its partner may still be on its way
  assert.deepEqual(healPairs([{ ...f, updatedAt: now - 60_000 }], now), []);
  // the reverse card alone is just as ordinary
  const [, r] = pair({ updatedAt: 1, noteEditedAt: 1 }, { updatedAt: 1, noteEditedAt: 1 });
  assert.equal(healPairs([r], now)[0].reverse, undefined);
  // cloze and occlusion notes are not pairs
  const cloze = { id: 'c1', noteId: 'C', cloze: 1, noteText: '{{c1::a}}', front: 'x', back: 'a', updatedAt: 1 };
  assert.deepEqual(healPairs([cloze], now), []);
  // two forward cards with one note id are not a clean pair: nothing is guessed
  assert.deepEqual(healPairs([fwd({ id: 'a', updatedAt: 1 }), fwd({ id: 'b', updatedAt: 1 })], now), []);
});

test('Play: front → back and typing use the forward card, back → front uses the reverse card asked front → back', () => {
  const [f, r] = pair();
  const plain = { id: 'p', front: 'Meiosis', back: 'Gametes' };
  const cards = [f, r, plain];
  assert.deepEqual(playPool(cards, 'front').map(c => c.id), ['f', 'p']);
  assert.deepEqual(playPool(cards, 'typing').map(c => c.id), ['f', 'p']);
  assert.deepEqual(playPool(cards, 'back').map(c => c.id), ['r', 'p']);
  assert.equal(playRole(r, 'back'), 'front'); assert.equal(playRole(f, 'back'), null); assert.equal(playRole(plain, 'back'), 'back');
  // the question is the same either way round, but the right card is graded
  assert.deepEqual(questionFor(f, 'front'), { prompt: 'Mitosis', answer: 'Cell division' });
  assert.deepEqual(questionFor(r, 'back'), { prompt: 'Cell division', answer: 'Mitosis' });
  assert.equal(questionFor(r, 'front'), null); assert.equal(questionFor(f, 'back'), null);
  assert.deepEqual(playableCards(cards, 'back').map(c => c.id), ['r', 'p']);
  assert.deepEqual(questionFor(plain, 'back'), { prompt: 'Gametes', answer: 'Meiosis' }, 'ordinary cards are not affected');
});

test('Find and replace: a pair changes together, whichever card the change was made on', () => {
  const [f, r] = pair();
  const all = [f, r];
  const both = (cards, opts) => syncPairChanges(replaceInCards(cards, opts), all, 777);
  // only the forward card is selected, in the front
  let out = both([f], { find: 'Mitosis', replace: 'Meiosis', field: 'front' });
  assert.deepEqual(out.map(c => [c.id, c.front, c.back]), [['f', 'Meiosis', 'Cell division'], ['r', 'Cell division', 'Meiosis']]);
  assert.ok(out.every(c => c.noteEditedAt === 777));
  // only the reverse card is selected, and the change is to its front (the forward card's back)
  out = both([r], { find: 'Cell', replace: 'Nuclear', field: 'front' });
  assert.deepEqual(out.map(c => [c.id, c.front, c.back]), [['f', 'Mitosis', 'Nuclear division'], ['r', 'Nuclear division', 'Mitosis']]);
  // both selected, front and back: no double change
  out = both([f, r], { find: 'i', replace: 'I', field: 'both' });
  const [nf, nr] = out;
  assert.equal(nf.front, 'MItosIs'); assert.equal(nf.back, 'Cell dIvIsIon');
  assert.equal(nr.front, nf.back); assert.equal(nr.back, nf.front);
  // ordinary cards pass through, and no match gives nothing
  assert.deepEqual(both([{ id: 'p', front: 'abc', back: 'd' }], { find: 'a', replace: 'z' }).map(c => c.front), ['zbc']);
  assert.deepEqual(both([f, r], { find: 'zzz', replace: 'y' }), []);
});

test('unpaired: an ordinary card again', () => {
  const [f] = pair({ noteEditedAt: 5 });
  const u = unpaired(f);
  assert.equal(u.noteId, undefined); assert.equal(u.reverse, undefined); assert.equal(u.noteEditedAt, undefined); assert.equal(u.front, 'Mitosis');
  assert.equal(isPair(u), false);
});

test('the switch: shown, checked, or replaced by its note while steps are on', () => {
  assert.ok(/id="acRevOn"/.test(reverseSwitchHTML('ac')) && !/checked/.test(reverseSwitchHTML('ac')));
  assert.ok(/checked/.test(reverseSwitchHTML('ce', { on: true })));
  const blocked = reverseSwitchHTML('ac', { blocked: true });
  assert.ok(/id="acRevRow" hidden/.test(blocked) && /id="acRevNote" >/.test(blocked) && /can't be reversed/.test(blocked));
});
