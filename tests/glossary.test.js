// Tests for js/glossary.js (your own glossary). Run with: node --test tests/glossary.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesFrom, cleanEntry, cleanGlossary, buildMatcher, findTerms, termIdsIn, LIMITS } from '../js/glossary.js';
import { parseGlossaryList } from '../js/glossary-list.js';

const E = (id, term, extra = {}) => ({ id, term, aliases: [], def: `${term} means…`, at: 1, ...extra });
const marks = (text, entries, opts) => findTerms(text, buildMatcher(entries), opts).map(t => text.slice(t.start, t.end));

test('entriesFrom reads gloss: settings A to Z and skips deleted and broken ones', () => {
  const list = entriesFrom({
    'gloss:b': { term: 'Osmosis', aliases: [], def: 'x', at: 2 }, 'gloss:a': { term: 'ATP', aliases: ['adenosine triphosphate'], def: 'y', at: 1 },
    'gloss:gone': null, 'gloss:bad': { term: '' }, 'gloss:worse': 'text', newPerDay: 20
  });
  assert.deepEqual(list.map(e => e.id), ['a', 'b']);
  assert.deepEqual(list[0].aliases, ['adenosine triphosphate']);
});

test('limits: term 80, five other spellings of 80, definition 1,000, 2,000 terms', () => {
  const e = cleanEntry({ term: 'x'.repeat(200), aliases: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'.repeat(200)], def: 'd'.repeat(2000), at: 5 });
  assert.equal(e.term.length, LIMITS.term);
  assert.equal(e.aliases.length, 5);
  assert.equal(e.def.length, LIMITS.def);
  assert.ok(cleanEntry({ term: 'T', aliases: ['t', 'T', 'T2'] }).aliases.join() === 'T2');      // a spelling equal to the term is dropped
  const many = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`gloss:${i}`, { term: `t${i}`, aliases: [], def: '', at: 1 }]));
  assert.equal(Object.keys(cleanGlossary(many)).length, 2000);
});

test('cleanGlossary drops bad terms, keeps deleted ones and other settings', () => {
  const out = cleanGlossary({ theme: 1, 'gloss:ok': { term: 'A', def: 'a' }, 'gloss:bad': { def: 'no term' }, 'gloss:del': null, 'gloss:': { term: 'x' } });
  assert.deepEqual(Object.keys(out).sort(), ['gloss:del', 'gloss:ok', 'theme']);
});

test('whole words only, any capitals', () => {
  const es = [E('1', 'ATP')];
  assert.deepEqual(marks('ATP makes atp. Not WATP or ATPase or xATP, but (ATP) yes', es), ['ATP']);          // first time only
  assert.deepEqual(marks('Not WATP or ATPase. atp, though', es), ['atp']);
  assert.deepEqual(marks('co-ATP, ATP-ase', es), ['ATP']);
});

test('regular-expression characters in a term are plain text', () => {
  assert.deepEqual(marks('We use C++ and (a|b)* here.', [E('1', 'C++'), E('2', '(a|b)*')]), ['C++', '(a|b)*']);
  assert.deepEqual(marks('a.b and axb', [E('1', 'a.b')]), ['a.b']);
});

test('Chinese, Japanese and Thai match as substrings', () => {
  assert.deepEqual(marks('これは水素です', [E('1', '水素')]), ['水素']);
  assert.deepEqual(marks('我喜欢学习中文', [E('1', '学习')]), ['学习']);
});

test('terms of 1 or 2 characters must match capitals exactly', () => {
  const es = [E('1', 'Na'), E('2', 'pH')];
  assert.deepEqual(marks('na na Na and ph PH pH', es), ['Na', 'pH']);
  assert.deepEqual(marks('banana', es), []);
});

test('the longest term wins, and a shorter one inside it is not marked', () => {
  const es = [E('1', 'ATP'), E('2', 'ATP synthase')];
  assert.deepEqual(marks('ATP synthase makes ATP', es), ['ATP synthase', 'ATP']);
  assert.deepEqual(marks('ATP synthase only', es), ['ATP synthase']);
});

test('other spellings mark the same term, once', () => {
  const es = [E('1', 'ATP', { aliases: ['adenosine triphosphate'] })];
  assert.deepEqual(marks('Adenosine triphosphate (ATP) is energy', es), ['Adenosine triphosphate']);
});

test('a spelling shared by two terms goes to the one defined first', () => {
  const es = [E('b', 'Cell', { at: 9 }), E('a', 'Wall', { aliases: ['cell'], at: 1 })];
  const found = findTerms('A cell', buildMatcher(es));
  assert.equal(found.length, 1);
  assert.equal(found[0].entry.id, 'a');
});

test('seen and skip: each term once per face, and skipped terms are never marked (the front-answer rule)', () => {
  const m = buildMatcher([E('1', 'ATP'), E('2', 'Osmosis')]);
  const seen = new Set();
  assert.equal(findTerms('ATP and', m, { seen }).length, 1);
  assert.equal(findTerms('more ATP and osmosis', m, { seen }).length, 1);           // ATP already seen on this face
  const inAnswer = termIdsIn('Made by ATP synthase', m);
  assert.deepEqual([...inAnswer], ['1']);
  assert.deepEqual(findTerms('What makes ATP? Not osmosis', m, { skip: inAnswer }).map(t => t.entry.id), ['2']);
});

test('no terms means no matcher; RTL text matches', () => {
  assert.equal(buildMatcher([]), null);
  assert.deepEqual(findTerms('abc', null), []);
  assert.deepEqual(marks('مرحبا العالم', [E('1', 'العالم')]), ['العالم']);
});

test('the matcher is cached per glossary version', () => {
  const es = [E('1', 'ATP')];
  assert.equal(buildMatcher(es), buildMatcher([...es]));
  assert.notEqual(buildMatcher(es), buildMatcher([E('1', 'ATP'), E('2', 'ADP')]));
});

test('hyphenated and regex-special terms never break matching', () => {
  const es = [E('1', 'X-ray'), E('2', 'T-cell'), E('3', 'beta-blocker'), E('4', 'C++'), E('5', '(a)'), E('6', 'x.y'), E('7', '$'), E('8', '?'), E('9', 'a|b'), E('10', '[x]'), E('11', 'back\\slash'), E('12', 'a/b')];
  const text = 'An X-ray and a t-cell, a beta-blocker, C++ and (a) with x.y, then $ and ? and a|b plus [x] and back\\slash and a/b. Not xzy.';
  assert.deepEqual(marks(text, es), ['X-ray', 't-cell', 'beta-blocker', 'C++', '(a)', 'x.y', '$', '?', 'a|b', '[x]', 'back\\slash', 'a/b']);
  assert.deepEqual(marks('X-RAY machines and x-rays', [E('1', 'X-ray')]), ['X-RAY']);       // whole words: "x-rays" is not "X-ray"
});

test('2,000 terms: matching a card is fast', () => {
  const es = Array.from({ length: 2000 }, (_, i) => E(`id${i}`, `term${i} word${i % 7}`));
  const m = buildMatcher(es);
  const text = 'This card talks about term17 word3 and a lot of other things, '.repeat(6) + 'term1999 word4';
  findTerms(text, m);                                             // (warm up)
  let each = Infinity;
  for (let i = 0; i < 15; i++) { const t0 = performance.now(); findTerms(text, m); each = Math.min(each, performance.now() - t0); }
  assert.ok(each < 10, `${each.toFixed(1)} ms per card`);
  assert.equal(findTerms(text, m).length, 2);
});

test('2,000 terms on a 5,000-character text: under 10 ms (also with many terms sharing a first letter)', () => {
  const es = Array.from({ length: 2000 }, (_, i) => E(`id${i}`, i % 2 ? `term${i}` : `Tissue type ${i}`));
  es.push(E('x', 'ATP synthase'), E('y', 'mitochondria'));
  const m = buildMatcher(es);
  const text = ('The mitochondria make ATP with the help of ATP synthase, a tissue that tends to talk about term and terms. ').repeat(48);
  assert.ok(text.length >= 5000);
  findTerms(text, m);
  let found, each = Infinity;
  for (let i = 0; i < 15; i++) {            // the best of 15, so a busy computer running other tests does not fail it
    const t0 = performance.now();
    found = findTerms(text, m);
    each = Math.min(each, performance.now() - t0);
  }
  assert.ok(each < 10, `${each.toFixed(1)} ms for 5k characters`);
  assert.deepEqual(found.map(f => f.entry.id).sort(), ['x', 'y']);
});

test('paste a list: new terms, ones already there, lines without a definition', () => {
  const have = [E('1', 'ATP')];
  const r = parseGlossaryList('ATP - energy\nOsmosis - water moving\nDiffusion - spreading out\nOsmosis - again\nLonely', have);
  assert.deepEqual(r.items.map(i => i.term), ['Osmosis', 'Diffusion']);
  assert.equal(r.already, 1);
  assert.equal(r.repeated, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.items[0].def, 'water moving');
  assert.deepEqual(parseGlossaryList('', []).items, []);
});

test('plurals and singulars: s, es and ies <-> y (the last word only)', () => {
  const es = [E('1', 'ACE inhibitor'), E('2', 'study'), E('3', 'box'), E('4', 'lymph nodes'), E('5', 'bus'), E('6', 'virus'), E('7', 'diagnosis')];
  const m = buildMatcher(es);
  assert.deepEqual(marks('ACE inhibitors work. Many studies. Two boxes. A lymph node. Buses and bu. Viruses and viru. Diagnoses and diagnosi.', es),
    ['ACE inhibitors', 'studies', 'boxes', 'lymph node']);
  assert.deepEqual(marks('Many studies and one study', es), ['studies']);                      // (still only the first time each term appears)
  assert.deepEqual(marks('one study and many studies', es), ['study']);
  assert.deepEqual(marks('The bus and the buses. A virus.', es), ['bus', 'virus']);            // the exact terms still match
  assert.ok(m);
});

test('hyphen or space: "ACE inhibitor", "ACE inhibitors" and "ACE-inhibitor" are one term', () => {
  const es = [E('1', 'ACE inhibitor'), E('2', 'T-cell')];
  assert.deepEqual(marks('an ACE-inhibitor', es), ['ACE-inhibitor']);
  assert.deepEqual(marks('some ace-inhibitors', es), ['ace-inhibitors']);
  assert.deepEqual(marks('ACE inhibitors', es), ['ACE inhibitors']);
  assert.deepEqual(marks('a T cell and T-cells', es), ['T cell']);
  assert.deepEqual(marks('t cells', es), ['t cells']);
  assert.deepEqual(marks('ACE inhibitorsX and ACEinhibitor and cellular', es), []);            // whole words only
  assert.equal(findTerms('ACE-inhibitors', buildMatcher(es))[0].entry.id, '1');
});

test('variants: aliases get them too, an exact spelling always wins, short terms stay exact', () => {
  const es = [E('1', 'Heart attack', { aliases: ['myocardial infarction'] }), E('2', 'cells'), E('3', 'cell'), E('4', 'Na'), E('5', 'ATP')];
  assert.deepEqual(marks('Myocardial infarctions', es), ['Myocardial infarctions']);
  assert.deepEqual(marks('Heart-attacks', es), ['Heart-attacks']);
  assert.deepEqual(marks('Heart attacks and a myocardial   infarction (one term, once)', es), ['Heart attacks']);
  const m = buildMatcher(es);
  assert.equal(findTerms('cells', m)[0].entry.id, '2');             // both exist: the exact spelling is not replaced by the plural of "cell"
  assert.equal(findTerms('cell', m)[0].entry.id, '3');
  assert.deepEqual(marks('Na, na and Nas. NA.', es), ['Na']);        // 1-2 character terms: exact case, no plurals
  assert.deepEqual(marks('The ATPs and atp', es), ['ATPs']);        // 3 characters: plural yes (once)
  assert.deepEqual(marks('The Heart attacks here', [E('1', 'Heart attack')]), ['Heart attacks']);
});

test('variants keep the performance budget (2,000 terms with other spellings: build and match)', () => {
  const es = Array.from({ length: 2000 }, (_, i) => E(`id${i}`, i % 4 === 1 ? `lymph node ${i} type` : i % 4 === 0 ? `Tissue type ${i} inhibitor` : `organ${i} system`, { aliases: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(g => `${g}${i % 50} ${i}`) }));
  es.push(E('x', 'ACE inhibitor'), E('y', 'mitochondrion'));
  const t0 = performance.now();
  const m = buildMatcher(es);
  const build = performance.now() - t0;
  assert.ok(build < 1500, `${build.toFixed(0)} ms to build`);
  const text = ('The ACE inhibitors and mitochondrion, a tissue that tends to talk about term and terms, plus lymph nodes. ').repeat(48);
  assert.ok(text.length >= 5000);
  findTerms(text, m);
  let found, each = Infinity;
  for (let i = 0; i < 15; i++) { const t = performance.now(); found = findTerms(text, m); each = Math.min(each, performance.now() - t); }
  assert.ok(each < 10, `${each.toFixed(1)} ms for 5k characters`);
  assert.deepEqual(found.map(f => f.entry.id).sort(), ['x', 'y']);
});

test('paste a list: every line picks its own separator (tab, " - ", " – ", ": ", "=")', () => {
  const r = parseGlossaryList('beta-agonist - stimulates beta receptors\nMallory-Weiss tear - mucosal tear at the GE junction\nAnti-HBs: antibody showing immunity\nOsmosis\twater moving\nPaO2 – oxygen pressure\nx = unknown\nNo definition here\n\nA - \n', []);
  assert.deepEqual(r.items.map(i => [i.term, i.def]), [
    ['beta-agonist', 'stimulates beta receptors'], ['Mallory-Weiss tear', 'mucosal tear at the GE junction'], ['Anti-HBs', 'antibody showing immunity'],
    ['Osmosis', 'water moving'], ['PaO2', 'oxygen pressure'], ['x', 'unknown']]);
  assert.equal(r.noDef, 2);
  assert.equal(r.skipped, 2);
  // A dash inside the definition, or a colon after a dash, does not move the split.
  assert.deepEqual(parseGlossaryList('ACE inhibitor - blocks ACE: lowers BP\nHb:Hemoglobin: the protein', []).items.map(i => [i.term, i.def]), [['ACE inhibitor', 'blocks ACE: lowers BP'], ['Hb:Hemoglobin', 'the protein']]);
});

test('paste a list: the counts add up (new, in the glossary, repeated, no definition, too long)', () => {
  const have = [E('1', 'ATP')];
  const long = 'x'.repeat(LIMITS.term + 1);
  const r = parseGlossaryList(`atp - again\nA - 1\na - 2\nB: 3\nC\n${long} - 4\n  \nD = 5`, have);
  assert.deepEqual([r.items.length, r.already, r.repeated, r.noDef, r.tooLong, r.over], [3, 1, 1, 1, 1, 0]);
  // 5 lines of mixed separators (the QA case): none are dropped.
  assert.equal(parseGlossaryList('a - 1\nb - 2\nc - 3\nd: 4\ne\t5', []).items.length, 5);
});
