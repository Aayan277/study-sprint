// Tests for js/steps.js (step-by-step problems). Run with: node tests/steps.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, isStepped, finalStep, joinSteps } from '../js/steps.js';

// A stand-in for maskMath (js/math.js): blank out $$ ... $$ and $ ... $ with spaces, keeping the length.
const stubMask = text => text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, m => m.replace(/[^\n]/g, ' '));

test('the marker variants: Step N followed by : . or ), in any case', () => {
  const p = parseSteps('Step 1: add\nstep 2. carry\nSTEP 3) check');
  assert.deepEqual(p, { intro: '', steps: ['add', 'carry', 'check'], final: null });
  assert.deepEqual(parseSteps('Step1:a\nStep 2 :b').steps, ['a', 'b']);
});

test('a step can run over several lines, and text before Step 1 is the intro', () => {
  const p = parseSteps('Solve 2x + 3 = 7.\n\nStep 1: subtract 3\nso 2x = 4\n\nStep 2: divide by 2\nx = 2');
  assert.equal(p.intro, 'Solve 2x + 3 = 7.');
  assert.deepEqual(p.steps, ['subtract 3\nso 2x = 4', 'divide by 2\nx = 2']);
});

test('an Answer line is the final answer; without one the last step is the answer', () => {
  const p = parseSteps('Step 1: a\nStep 2: b\nAnswer: 42');
  assert.deepEqual(p.steps, ['a', 'b']);
  assert.equal(p.final, '42');
  assert.equal(finalStep('Step 1: a\nStep 2: b\nAnswer: 42'), '42');
  assert.equal(finalStep('Step 1: a\nStep 2: b'), 'b');
  assert.equal(finalStep('plain back'), null);
  assert.equal(parseSteps('Step 1: a\nStep 2: b\nanswer: x\nmore').final, 'x\nmore');
});

test('one step, no steps, or numbers out of order are not stepped', () => {
  assert.equal(parseSteps('Step 1: only one'), null);
  assert.equal(parseSteps('just a back, with the word step in it'), null);
  assert.equal(parseSteps('Step 1: a\nStep 3: c'), null);
  assert.equal(parseSteps('Step 2: a\nStep 3: b'), null);
  assert.equal(parseSteps('Step 1: a\nStep 1: b'), null);
  assert.equal(parseSteps('Step 1: a\nStep 2:'), null);               // an empty step
  assert.equal(parseSteps(''), null);
  assert.equal(parseSteps(undefined), null);
  assert.equal(isStepped('Step 1: a\nStep 2: b'), true);
  assert.equal(isStepped('Step 1: a'), false);
});

test('a marker in the middle of a line is not a marker', () => {
  assert.equal(parseSteps('First do this. Step 1: a\nStep 2: b'), null);
  assert.equal(parseSteps('see Step 1: a, then Step 2: b'), null);
});

test('Windows line endings work', () => {
  assert.deepEqual(parseSteps('Step 1: a\r\nStep 2: b\r\nAnswer: c').steps, ['a', 'b']);
});

test('inside $$ ... $$ a "Step 2:" is maths, not a split (with a mask)', () => {
  const back = 'Step 1: write\n$$\nStep 2: x\n$$\nStep 2: done';
  assert.deepEqual(parseSteps(back, { mask: stubMask }).steps, ['write\n$$\nStep 2: x\n$$', 'done']);
  // Without the mask the formula line is taken as the marker for step 2 and the real one then repeats it.
  assert.equal(parseSteps(back), null);
  // A mask that changes the length is ignored rather than trusted.
  assert.deepEqual(parseSteps('Step 1: a\nStep 2: b', { mask: () => 'x' }).steps, ['a', 'b']);
});

test('joinSteps writes the back, and parseSteps reads it again', () => {
  const parts = { intro: 'Find x.', steps: ['subtract 3', 'divide\nby 2'], final: 'x = 2' };
  const back = joinSteps(parts);
  assert.equal(back, 'Find x.\nStep 1: subtract 3\nStep 2: divide\nby 2\nAnswer: x = 2');
  assert.deepEqual(parseSteps(back), parts);
  assert.deepEqual(parseSteps(joinSteps({ steps: ['a', 'b'] })), { intro: '', steps: ['a', 'b'], final: null });
  assert.equal(joinSteps({ steps: ['a', 'b'], final: '  ' }), 'Step 1: a\nStep 2: b');
});

// ---------- elements cards (item 4) ----------
import { parseElements, parseStructured, joinElements, elementsRoundTrip, suggestRating, isElements } from '../js/steps.js';

test('elements: an optional intro, then "Element N:" lines numbered one after the other', () => {
  const p = parseElements('Negligence\nElement 1: Duty\nElement 2: Breach\nelement 3) Causation\nElement 4. Damages');
  assert.deepEqual(p, { intro: 'Negligence', items: ['Duty', 'Breach', 'Causation', 'Damages'] });
  assert.deepEqual(parseElements('Element 1: a\nElement 2: b').items, ['a', 'b']);
  assert.equal(parseElements('Element 1: a\nElement 2: b').intro, '');
  assert.ok(isElements('Element 1: a\nElement 2: b'));
});

test('elements: an element can run over several lines; there is no Answer line', () => {
  const p = parseElements('Rule.\nElement 1: first\nline two\nElement 2: second\nAnswer: still part of element 2');
  assert.deepEqual(p.items, ['first\nline two', 'second\nAnswer: still part of element 2']);
});

test('elements: not an elements card (one element, a gap, an empty element, "Elements: H, O")', () => {
  assert.equal(parseElements('Element 1: only'), null);
  assert.equal(parseElements('Element 1: a\nElement 3: c'), null);
  assert.equal(parseElements('Element 1: a\nElement 2:'), null);
  assert.equal(parseElements('Elements: H, O\nElement of surprise'), null);
  assert.equal(parseElements('plain'), null);
  assert.equal(parseElements(null), null);
});

test('elements: parseSteps ignores Element lines; steps win when a back has both', () => {
  assert.equal(parseSteps('Element 1: a\nElement 2: b'), null);
  const both = 'Step 1: a\nStep 2: b\nElement 1: x\nElement 2: y';
  assert.equal(parseElements(both), null);
  assert.deepEqual(parseSteps(both).steps, ['a', 'b\nElement 1: x\nElement 2: y']);
  assert.equal(parseStructured(both).kind, 'steps');
  assert.deepEqual(parseStructured('Element 1: a\nElement 2: b'), { kind: 'elements', intro: '', steps: ['a', 'b'], final: null });
  assert.equal(parseStructured('plain'), null);
});

test('elements: maths masks keep a marker inside a formula from counting', () => {
  const p = parseElements('Element 1: write $$\nElement 2: not one\n$$\nElement 2: real second', { mask: stubMask });
  assert.equal(p.items.length, 2);
  assert.ok(p.items[0].includes('not one'));
});

test('elements: join and round trip', () => {
  const parts = { intro: 'Negligence', items: ['Duty', 'Breach'] };
  assert.equal(joinElements(parts), 'Negligence\nElement 1: Duty\nElement 2: Breach');
  assert.deepEqual(parseElements(joinElements(parts)), parts);
  assert.ok(elementsRoundTrip(parts));
  assert.ok(!elementsRoundTrip({ intro: '', items: ['a\nElement 3: sneaky', 'b'] }));
  assert.ok(!elementsRoundTrip({ intro: '', items: ['only'] }));
  assert.ok(!elementsRoundTrip({ intro: '', items: ['a\nStep 1: x\nStep 2: y', 'b'] }));       // would save as a steps card
});

test('suggestRating: none missed is Good, a quarter or fewer is Hard, more is Again, never Easy', () => {
  assert.equal(suggestRating(4, 0), 3);
  assert.equal(suggestRating(4, 1), 2);       // 25%
  assert.equal(suggestRating(3, 1), 1);       // 33%
  assert.equal(suggestRating(8, 2), 2);
  assert.equal(suggestRating(8, 3), 1);
  assert.equal(suggestRating(2, 1), 1);
  assert.equal(suggestRating(5, 5), 1);
  for (let n = 2; n <= 12; n++) for (let m = 0; m <= n; m++) assert.notEqual(suggestRating(n, m), 4);
});
