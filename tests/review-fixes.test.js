// Tests for the v4.8.1 review fixes (docs/design/batch2-review.md). Run with: node --test tests/review-fixes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });      // ui.js (imported by the sheet) asks for it at load
const { newPlan } = await import('../js/rescue-sheet.js');
import { MIX_DISMISS } from '../js/study-data.js';
import { DISMISS_KEY } from '../js/confusion.js';
import { stepsRoundTrip, parseSteps, joinSteps } from '../js/steps.js';
import { maskMath } from '../js/math.js';
import { buildAnswerIndex, indexedMixup, checkTyped } from '../js/match.js';
import { answerTargets } from '../js/format.js';
import { canSplit, splitCards, withoutLeechTag, forgottenText, unleeched } from '../js/leech-logic.js';
import { dayStart } from '../js/days.js';

const DAY = 86400000, NOW = new Date(2026, 9, 14, 12).getTime();

test('rescue sheet: Start counts the backlog again, against the day it starts on (review nit)', () => {
  const cards = ['a', 'b', 'c', 'e'].map(id => ({ id, deckId: 'd' }));
  const statesById = new Map([['a', { state: 2, due: NOW - 3 * DAY }], ['b', { state: 2, due: NOW - DAY }], ['c', { state: 2, due: NOW + 2 * DAY }], ['e', { state: 2, due: NOW + 3600000 }]]);
  const data = { cards, statesById, exempt: new Set() };
  assert.equal(newPlan(data, 3, true, NOW).backlog, 2);                    // opened today: e is due later today, so it is not overdue
  const next = NOW + DAY;                                                  // Today stayed open past the next day's start: e is overdue now
  const p = newPlan(data, 3, false, next);
  assert.deepEqual([p.start, p.backlog, p.days, p.pauseNew, p.at], [dayStart(next), 3, 3, false, next]);
});

test('steps: text that would not read back as the same steps is caught (review fix 4)', () => {
  const opts = { mask: maskMath };
  assert.equal(stepsRoundTrip({ intro: '', steps: ['add', 'divide'], final: '4' }, opts), true);
  assert.equal(stepsRoundTrip({ intro: '', steps: ['add', 'then\nAnswer: x'], final: '' }, opts), false);   // "Answer:" inside a step
  assert.equal(stepsRoundTrip({ intro: '', steps: ['add', 'divide'], final: 'so\nStep 3: more' }, opts), false);   // "Step 3:" in the answer
  assert.equal(stepsRoundTrip({ intro: 'Step 9: hm', steps: ['a', 'b'], final: '' }, opts), false);
  assert.equal(stepsRoundTrip({ intro: '', steps: ['a', '', 'b'], final: '' }, opts), true);                // blank steps are dropped, as saved
  assert.equal(stepsRoundTrip({ intro: '', steps: ['a'], final: '' }, opts), false);                        // one step is not steps
  assert.equal(stepsRoundTrip({ intro: '', steps: ['use $Step 2: x$', 'b'], final: '' }, opts), true);      // inside a formula it is fine
  const parts = { intro: 'Solve:', steps: ['a', 'b'], final: '3' };
  assert.deepEqual(parseSteps(joinSteps(parts), opts), { intro: 'Solve:', steps: ['a', 'b'], final: '3' });
});

test('play: the typed mix-up lookup gives the same answers as scanning every card (review fix 7)', () => {
  const cards = [
    { id: 'a', front: 'A', answer: 'mitosis' }, { id: 'b', front: 'B', answer: 'meiosis; reduction division' },
    { id: 'n1', noteId: 'N', front: 'N1', answer: 'sibling answer' }, { id: 'n2', noteId: 'N', front: 'N2', answer: 'other' },
    { id: 'dup', front: 'D', answer: 'Mitosis' }, { id: 'sp', front: 'S', answer: 'self esteem' }, { id: 'none', front: 'X', answer: '' }
  ];
  const targetsOf = c => (c.answer ? answerTargets(c.answer) : []);
  const index = buildAnswerIndex(cards, targetsOf);
  const scan = (typed, card) => {
    for (const other of cards) {
      if (other.id === card.id || (card.noteId && other.noteId === card.noteId)) continue;
      const ans = other.answer;
      if (ans && checkTyped(typed, answerTargets(ans), { forgiving: false }).correct) return other.id;
    }
    return undefined;
  };
  for (const [typed, from] of [['meiosis', 'a'], ['MEIOSIS', 'a'], ['reduction division', 'a'], ['mitosis', 'b'], ['Mitosis', 'dup'], ['selfesteem', 'a'],
    ['sibling answer', 'n2'], ['sibling answer', 'a'], ['mitosiss', 'b'], ['', 'a'], ['  ', 'a'], ['other', 'n1'], ['nothing', 'a']]) {
    const card = cards.find(c => c.id === from);
    assert.equal(indexedMixup(index, typed, card), scan(typed, card), `${typed} from ${from}`);
  }
  assert.equal(indexedMixup(index, 'mitosis', cards[1]), 'a');                   // the first card in order wins
  const big = Array.from({ length: 2500 }, (_, i) => ({ id: 'c' + i, answer: 'ans' + i }));
  assert.equal(indexedMixup(buildAnswerIndex(big, targetsOf), 'ans2400', { id: 'x' }), undefined);   // the cap of 2000 is kept
  assert.equal(indexedMixup(buildAnswerIndex(big, targetsOf), 'ans1999', { id: 'x' }), 'c1999');
});

test('leech coach: Split is only for plain Basic cards (L2)', () => {
  assert.equal(canSplit({ id: 'x', front: 'q', back: 'a; b' }), true);
  assert.equal(canSplit({ id: 'x', noteId: 'n', cloze: 1 }), false);
  assert.equal(canSplit({ id: 'x', noteId: 'n' }), false);
  assert.equal(canSplit({ id: 'x', occlusion: { masks: [] } }), false);
});

test('leech coach: a split keeps the back picture and memory hook on the first new card (L2)', () => {
  let n = 0;
  const card = { id: 'x', deckId: 'd', front: 'Q', back: 'a; b', frontImage: 'fi', backImage: 'bi', noteExtra: 'hook', tags: ['leech'] };
  const out = splitCards(card, [{ front: 'Q', back: ' ' }, { front: 'Q', back: 'a' }, { front: 'Q', back: 'b' }], { newId: () => 'n' + n++, now: 1 });
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].backImage, out[0].noteExtra, out[0].frontImage], ['bi', 'hook', 'fi']);
  assert.deepEqual([out[1].backImage, out[1].noteExtra, out[1].frontImage], [undefined, undefined, 'fi']);
});

test('leech coach: Edit gets the card without its leech tag, and the wording says "times" (L6, nit)', () => {
  const c = { id: 'x', noteId: 'n', cloze: 2, tags: ['leech', 'bio'] };
  assert.deepEqual(withoutLeechTag(c).tags, ['bio']);
  assert.deepEqual(c.tags, ['leech', 'bio']);                       // the stored card is not touched
  assert.deepEqual(withoutLeechTag({ id: 'y' }).tags, []);
  assert.equal(forgottenText(3), 'Forgotten 3 times');
  assert.equal(forgottenText(1), 'Forgotten 1 time');
  assert.equal(unleeched({ id: 'x', suspended: true, tags: ['leech'] }).suspended, false);
});

test('study-data repeats the mix-up dismissal key (so Today does not load Play at start)', () => assert.equal(MIX_DISMISS, DISMISS_KEY));
