// Tests for js/match.js (typed answers). Run with: node tests/match.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, acceptedAnswers, allowedTypos, editDistance, checkAnswer, canType } from '../js/match.js';

const ok = (typed, back, opts) => checkAnswer(typed, back, opts).correct;

test('ignores capitals, punctuation and leading articles', () => {
  assert.equal(normalizeAnswer('  The Mitochondria! '), 'mitochondria');
  assert.equal(normalizeAnswer('An apple.'), 'apple');
  assert.equal(normalizeAnswer('Café'), 'cafe');
  assert.ok(ok('mitochondria', 'The mitochondria'));
  assert.ok(ok('self esteem', 'Self-esteem'));
});

test('typo allowance grows with length', () => {
  assert.deepEqual([0, 4, 5, 9, 10, 30].map(allowedTypos), [0, 0, 1, 1, 2, 2]);
  assert.equal(ok('cst', 'cat'), false);              // short answers must be exact
  assert.equal(ok('ribosme', 'ribosome'), true);      // 1 typo in 8 letters
  assert.equal(ok('rbosme', 'ribosome'), false);      // 2 typos in 8 letters is too many
  assert.equal(ok('photosynthsis', 'photosynthesis'), true);
  assert.equal(ok('fotosynthsis', 'photosynthesis'), false);
});

test('alternates separated by ; or / and optional words in brackets', () => {
  assert.deepEqual(acceptedAnswers('red / scarlet'), ['red scarlet', 'red', 'scarlet']);
  assert.ok(ok('scarlet', 'red / scarlet'));
  assert.ok(ok('crimson', 'red; crimson'));
  assert.ok(ok('cell division', 'cell division (mitosis)'));
  assert.ok(ok('cell division mitosis', 'cell division (mitosis)'));
});

test('no typo forgiveness when forgiving is off (Hard mode)', () => {
  assert.equal(ok('ribosme', 'ribosome', { forgiving: false }), false);
  assert.equal(ok('Ribosome.', 'ribosome', { forgiving: false }), true);
});

test('empty answers are wrong, exact answers are flagged as exact', () => {
  assert.equal(ok('', 'anything'), false);
  assert.deepEqual(checkAnswer('ATP', 'atp'), { correct: true, exact: true });
  assert.deepEqual(checkAnswer('ribosme', 'ribosome'), { correct: true, exact: false });
});

test('edit distance', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
});

test('typing is only offered for backs of 40 characters or less', () => {
  assert.equal(canType('x'.repeat(40)), true);
  assert.equal(canType('x'.repeat(41)), false);
});
