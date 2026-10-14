// Tests for js/match.js (typed answers). Run with: node tests/match.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, acceptedAnswers, allowedTypos, editDistance, checkAnswer, canType, answerChoices, closestChoice } from '../js/match.js';

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

test('spaces are ignored, including where brackets were', () => {
  assert.ok(ok('selfesteem', 'self-esteem'));
  assert.ok(ok('ひとつ', 'one; いち / ひと(つ)'));
  assert.ok(ok('ひと', 'one; いち / ひと(つ)'));
  assert.equal(ok('ひとつ', 'one; いち / ひと(つ)', { forgiving: false }), true);
});

test('edit distance', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
});

test('typing is only offered for backs of 40 characters or less', () => {
  assert.equal(canType('x'.repeat(40)), true);
  assert.equal(canType('x'.repeat(41)), false);
});

test('answerChoices: pieces, then pieces without brackets, then the whole back, de-duplicated by key', () => {
  assert.deepEqual(answerChoices('red / scarlet (dark red)'),
    [{ display: 'red', key: 'red' }, { display: 'scarlet (dark red)', key: 'scarletdarkred' }, { display: 'scarlet', key: 'scarlet' },
      { display: 'red / scarlet (dark red)', key: 'redscarletdarkred' }]);
  assert.deepEqual(answerChoices('The Mitochondria'), [{ display: 'The Mitochondria', key: 'mitochondria' }]);
  assert.deepEqual(answerChoices('self-esteem; Self Esteem').map(c => c.key), ['selfesteem', 'selfesteemselfesteem']);   // the 2nd piece has the same key as the 1st
  assert.deepEqual(answerChoices(''), []);
  assert.deepEqual(answerChoices(null), []);
});

test('closestChoice: the nearest answer, the earliest on a tie', () => {
  assert.equal(closestChoice('scarlett', 'red / scarlet').display, 'scarlet');
  assert.equal(closestChoice('crimsin', 'red; crimson').display, 'crimson');
  assert.equal(closestChoice('scarlet', 'scarlet (dark red)').display, 'scarlet');      // the bracket-free version is exact
  assert.equal(closestChoice('xx', 'ab; cd').display, 'ab');
  assert.equal(closestChoice('x', ''), null);
});
