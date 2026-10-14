// Tests for js/match.js (typed answers). Run with: node tests/match.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, acceptedAnswers, allowedTypos, editDistance, checkAnswer, canType, answerChoices, closestChoice } from '../js/match.js';
import { diffAgainstBack, hasMarks } from '../js/answer-diff.js';

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
      { display: 'red / scarlet (dark red)', key: 'redscarletdarkred' },
      // v4.2.1: the whole back without its brackets is accepted by checkAnswer, so it is a choice too
      { display: 'red / scarlet', key: 'redscarlet' }]);
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

test('maths: the answer to type is the formula as plain text', async () => {
  const { answerText } = await import('../js/format.js');
  const back = answerText('$x^2$');
  assert.equal(checkAnswer('x^2', back).correct, true);
  assert.equal(checkAnswer('x2', back).correct, true);
  assert.equal(checkAnswer('x3', back).correct, false);
  assert.equal(checkAnswer('a/b', answerText('$\\frac{a}{b}$')).correct, true);
  assert.equal(canType(answerText('$\\frac{a}{b}$')), true);
});


// ---------- v4.2.1 ----------
test('normalizeAnswer keeps marks that change the letter (kana, Devanagari) and folds only Latin accents', () => {
  assert.notEqual(normalizeAnswer('か'), normalizeAnswer('が'));
  assert.notEqual(normalizeAnswer('は'), normalizeAnswer('ぱ'));
  assert.notEqual(normalizeAnswer('は'), normalizeAnswer('ば'));
  assert.notEqual(normalizeAnswer('कताब'), normalizeAnswer('किताब'));
  assert.notEqual(normalizeAnswer('कि'), normalizeAnswer('की'));
  assert.equal(normalizeAnswer('が'), 'が');                       // composed and decomposed forms agree
  assert.equal(normalizeAnswer('が'), 'が');
  assert.equal(normalizeAnswer('Café'), 'cafe');
  assert.equal(normalizeAnswer('Ελλάς'), normalizeAnswer('ΕΛΛΑΣ'));  // Greek tonos folds like any accent
  assert.equal(checkAnswer('か', 'が').correct, false);
  assert.equal(checkAnswer('ぱん', 'はん').correct, false);
  assert.equal(checkAnswer('がっこう', 'がっこう').exact, true);
});

test('normalizeAnswer: a final sigma is a sigma, and an answer made only of symbols can be typed', () => {
  assert.equal(normalizeAnswer('λόγος'), normalizeAnswer('λόγοσ'));
  assert.equal(normalizeAnswer('ΛΌΓΟΣ'), normalizeAnswer('λόγος'));
  for (const sym of ['🧠', '+', '❤️', '?!']) {
    assert.notEqual(normalizeAnswer(sym), '', sym);
    assert.deepEqual(checkAnswer(sym, sym), { correct: true, exact: true });
  }
  assert.equal(checkAnswer('❤', '❤️').exact, true);              // with or without the emoji selector
  assert.equal(checkAnswer('-', '+').correct, false);
  assert.equal(normalizeAnswer('+ '), '+');
});

test('answerChoices is exactly the set acceptedAnswers allows', () => {
  for (const back of ['red / scarlet (dark red)', 'The Mitochondria', 'a (b) / c; d (e) f', 'self-esteem; Self Esteem', '(optional) word', 'ひと(つ)', '+; 🧠', '']) {
    const fromChoices = [...new Set(answerChoices(back).map(c => normalizeAnswer(c.display)))].sort();
    assert.deepEqual(fromChoices, [...acceptedAnswers(back)].sort(), back);
  }
});

test('closestChoice prefers a choice that accepts the answer over a nearer one that does not', () => {
  const back = 'abc; abcde';        // typed 'abcd': 'abc' is 1 away but allows no typos (3 letters); 'abcde' is 1 away and allows 1
  assert.equal(checkAnswer('abcd', back).correct, true);
  assert.equal(closestChoice('abcd', back).display, 'abcde');          // (the earliest nearest choice, 'abc', would not accept it)
  assert.equal(closestChoice('abd', 'abc; xyz').display, 'abc');     // nothing accepts it: the nearest
});

test('a typed answer that is accepted exactly has no marks; one accepted with a typo has marks within its budget (property)', () => {
  let seed = 11;
  const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const words = ['mitochondria', 'photosynthesis', 'scarlet', 'Café au lait', 'the Nile', 'self-esteem', 'neuron', 'ribosome', 'cat', 'Ελλάς'];
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let round = 0; round < 400; round++) {
    const back = [words[rnd(words.length)], words[rnd(words.length)]].join(rnd(2) ? ' / ' : '; ') + (rnd(3) ? '' : ' (extra)');
    const choices = answerChoices(back);
    const base = choices[rnd(choices.length)].display;
    if (checkAnswer(base, back).exact) {
      const d = diffAgainstBack(base, back);
      assert.ok(d && !d.tooDifferent && !hasMarks(d), 'exact has no marks: ' + base + ' | ' + back);
    }
    // up to 3 random edits
    let typed = Array.from(base);
    for (let e = rnd(4); e > 0; e--) {
      const at = rnd(typed.length + 1), op = rnd(3);
      if (op === 0) typed.splice(at, 0, alphabet[rnd(26)]); else if (op === 1) typed.splice(at, 1); else if (at < typed.length) typed[at] = alphabet[rnd(26)];
    }
    typed = typed.join('');
    const r = checkAnswer(typed, back);
    if (!r.correct || r.exact || !typed.trim()) continue;
    const d = diffAgainstBack(typed, back);
    assert.ok(d, typed);
    if (d.tooDifferent) continue;                                   // (two texts shown instead: nothing to bound)
    const marks = d.counts.wrong + d.counts.extra + d.counts.missing;
    const c = closestChoice(typed, back);
    assert.ok(marks <= allowedTypos(c.key.length), `marks ${marks} within budget for "${typed}" vs "${c.display}" (${back})`);
  }
});
