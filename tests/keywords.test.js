// Tests for js/keywords.js (words, plurals, key phrases, counting and weighing them). Run with: node --test tests/keywords.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOPWORDS, FILLER, words, stem, keyOf, candidatePhrases, countPhrases, termWeights, bestForm, near, groupNear, slugTag, isJunkTerm } from '../js/keywords.js';

test('words: letters and digits, accents kept, with where each starts and whether it opens a sentence', () => {
  const w = words("Café au lait; it's 3.5 days. Then ’tis fine");
  assert.deepEqual(w.map(x => x.w), ['café', 'au', 'lait', "it's", '3', '5', 'days', 'then', 'tis', 'fine']);
  assert.equal(w[0].first, true);
  assert.equal(w[7].first, true, 'a word after a full stop opens a sentence');
  assert.equal(w[2].brk, false);
  assert.equal(w[3].brk, true, 'a semicolon is a break');
  assert.equal(words('well-known facts')[0].w, 'well-known');
  assert.equal(words('end- ')[0].raw, 'end', 'a trailing hyphen is not part of the word');
});

test('stem: plurals and possessives fold, words that end like a plural but are not stay', () => {
  const table = { cells: 'cell', studies: 'study', glasses: 'glass', boxes: 'box', churches: 'church', virus: 'virus', analysis: 'analysis', physics: 'physics', bus: 'bus', bias: 'bias', "cell's": 'cell', process: 'process', processes: 'process', Cell: 'cell', ribosomes: 'ribosome' };
  for (const [w, s] of Object.entries(table)) assert.equal(stem(w), s, w);
});

test('keyOf: stemmed words joined by a space, a hyphen counts as a space', () => {
  assert.equal(keyOf(['Cell', 'membranes']), 'cell membrane');
  assert.equal(keyOf(words('Cell-cycle')), 'cell cycle');
});

test('candidatePhrases: no stopword at either end, an inner "of" in three words, no numbers, no run across a comma', () => {
  const keys = t => candidatePhrases(words(t)).map(p => p.key);
  assert.ok(keys('The Treaty of Versailles was signed.').includes('treaty of versaille'));
  assert.ok(!keys('the cell and the nucleus').includes('cell and'));
  assert.ok(!keys('in the cell').some(k => /^(in|the)\b/.test(k)));
  assert.ok(!keys('about 1914 deaths').includes('1914 death'));
  assert.ok(!keys('red, blue').includes('red blue'), 'a comma is a break');
  assert.ok(keys('cell membrane proteins').includes('cell membrane protein'));
  assert.ok(!keys('a b c d e').some(k => k.split(' ').length > 3));
  const p = candidatePhrases(words('He saw Franz Ferdinand there.')).find(x => x.key === 'franz ferdinand');
  assert.equal(p.caps, true);
  const start = candidatePhrases(words('Franz Ferdinand came.')).find(x => x.key === 'franz ferdinand');
  assert.equal(start.caps, false, 'a capital at the start of a sentence says nothing');
  assert.equal(candidatePhrases(words('the Treaty of Versailles'))[1].caps, true);
});

test('countPhrases: documents and times', () => {
  const c = countPhrases(['The cell divides. The cell grows.', 'A cell membrane.', 'Nothing here but kidneys.']);
  assert.equal(c.get('cell').df, 2);
  assert.equal(c.get('cell').tf, 3);
  assert.deepEqual(c.get('cell').docs, [0, 1]);
  assert.equal(c.get('cell membrane').df, 1);
  assert.equal(c.get('kidney').tf, 1);
  assert.equal(c.get('cell').forms.get('cell'), 3);
});

test('termWeights: 0 to 1; a term in every document counts for less than one in a few', () => {
  const docs = ['cell nucleus', 'cell membrane', 'cell wall', 'cell cycle', 'mitochondria energy'];
  const w = termWeights(countPhrases(docs), docs.length);
  assert.ok(w.get('cell') < w.get('mitochondria'));
  for (const v of w.values()) assert.ok(v >= 0 && v <= 1);
  assert.equal(Math.max(...w.values()), 1);
});

test('bestForm: the usual spelling, in lower case unless it is always written with capitals', () => {
  assert.equal(bestForm(new Map([['Cell', 2], ['cell', 5]])), 'cell');
  assert.equal(bestForm(new Map([['Treaty of Versailles', 3]])), 'Treaty of Versailles');
  assert.equal(bestForm(new Map([['ATP', 4]])), 'ATP');
  assert.equal(bestForm(new Map([['Cell', 1], ['cell', 1]])), 'cell');
});

test('near and groupNear: spellings, plurals and hyphens are one', () => {
  assert.equal(near('colour', 'color'), true);
  assert.equal(near('cell-cycle', 'cell cycle'), true);
  assert.equal(near('cat', 'cut'), false, 'short words are never "near"');
  assert.equal(near('kidney', 'kidneys'), true);
  const g = groupNear(['color', 'colour', 'kidney', 'kidneys', 'cell-cycle', 'cell cycle', 'liver']);
  assert.equal(g.get('colour'), g.get('color'));
  assert.equal(g.get('kidneys'), g.get('kidney'));
  assert.equal(g.get('cell cycle'), g.get('cell-cycle'));
  assert.notEqual(g.get('liver'), g.get('kidney'));
});

test('slugTag', () => {
  assert.equal(slugTag('Cell cycle'), 'cell-cycle');
  assert.equal(slugTag('  Krebs  cycle! '), 'krebs-cycle');
  assert.equal(slugTag('Café'), 'café');
  assert.equal(slugTag('!!'), '');
  assert.equal(slugTag('a'.repeat(60)).length, 40);
  assert.equal(slugTag('x--y'), 'x-y');
});

test('isJunkTerm: stopwords, filler, short words, digits, symbols', () => {
  for (const t of ['the', 'of the', 'example', 'page', 'a', 'it', '1914', '3.5%', '', '--', '$$$ 1', 'see example']) assert.equal(isJunkTerm(t), true, JSON.stringify(t));
  for (const t of ['osmosis', 'Cell cycle', 'ATP', 'Treaty of Versailles', 'DNA']) assert.equal(isJunkTerm(t), false, t);
});

test('the word lists have what the rules count on', () => {
  for (const w of ['the', 'of', 'which', 'would', 'you']) assert.ok(STOPWORDS.has(w), w);
  for (const w of ['example', 'figure', 'todo']) assert.ok(FILLER.has(w), w);
  assert.ok(STOPWORDS.size >= 150);
});
