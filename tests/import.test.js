// Tests for js/import.js. Run with: node tests/import.test.js
// Each test pastes some text and checks the cards that come out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, stripMarker, parseDelimited, parseText, parseRows, buildCards, isComplete,
  findDuplicates, dupKey, sheetsCsvUrl, claudePrompt, CLAUDE_PROMPT, isHeaderRow
} from '../js/import.js';

// Parse text and return just [front, back] pairs, to keep the tests short.
const cards = text => buildCards(parseText(text)).map(c => [c.front, c.back]);
const formatOf = text => parseText(text).format;

// ---------- rule 1: line endings, trimming, empty lines ----------
test('rule 1: Windows line endings and extra blank lines', () => {
  const text = '\r\n\r\nMitosis - cell division\r\n\r\n\r\nMeiosis - makes gametes\r\n   \r\n';
  assert.deepEqual(cards(text), [['Mitosis', 'cell division'], ['Meiosis', 'makes gametes']]);
});
test('rule 1: old Mac line endings, byte-order mark and non-breaking spaces', () => {
  assert.equal(normalize('﻿a\rb c '), 'a\nb c');
});

// ---------- rule 2: list markers ----------
test('rule 2: strips numbers, dashes, stars and bullets', () => {
  assert.equal(stripMarker('1. Term'), 'Term');
  assert.equal(stripMarker('12) Term'), 'Term');
  assert.equal(stripMarker('- Term'), 'Term');
  assert.equal(stripMarker('* Term'), 'Term');
  assert.equal(stripMarker('• Term'), 'Term');
  assert.equal(stripMarker('**Bold** stays'), '**Bold** stays');
  assert.equal(stripMarker('-5 degrees'), '-5 degrees');
  assert.equal(stripMarker('1.5 litres'), '1.5 litres');
});
test('rule 2: mixed bullets in one list', () => {
  const text = '1. Osmosis: water moving across a membrane\n- Diffusion: particles spreading out\n• Active transport: uses ATP\n* Endocytosis: cell swallows material';
  assert.deepEqual(cards(text), [
    ['Osmosis', 'water moving across a membrane'],
    ['Diffusion', 'particles spreading out'],
    ['Active transport', 'uses ATP'],
    ['Endocytosis', 'cell swallows material']
  ]);
});

// ---------- rule 3: separators ----------
test('rule 3: each separator is detected', () => {
  const pairs = [['Tab', 'a\tb'], ['pipe', 'a | b'], ['dash', 'a - b'], ['en dash', 'a – b'], ['em dash', 'a — b'], ['colon', 'a: b'], ['equals', 'a = b'], ['comma', 'a,b']];
  for (const [name, line] of pairs) {
    const text = [line, line.replace('a', 'c').replace('b', 'd')].join('\n');
    assert.deepEqual(cards(text), [['a', 'b'], ['c', 'd']], name);
  }
});
test('rule 3: splits at the FIRST separator only', () => {
  assert.deepEqual(cards('Ratio - part - to - whole\nRate - change over time'), [['Ratio', 'part - to - whole'], ['Rate', 'change over time']]);
});
test('rule 3: definitions containing colons', () => {
  const text = 'Supply - amount offered at a price: more at higher prices\nDemand - amount wanted: falls as price rises';
  assert.deepEqual(cards(text), [
    ['Supply', 'amount offered at a price: more at higher prices'],
    ['Demand', 'amount wanted: falls as price rises']
  ]);
});
test('rule 3: "Term: definition - more" splits at the colon (shorter fronts win)', () => {
  const text = 'GDP: total output - measured yearly\nCPI: price index - tracks inflation';
  assert.deepEqual(cards(text), [['GDP', 'total output - measured yearly'], ['CPI', 'price index - tracks inflation']]);
});
test('rule 3: definitions containing commas use the dash, not the comma', () => {
  const text = 'Paris, France - capital city\nCatalyst - speeds up a reaction, without being used up';
  assert.deepEqual(cards(text), [['Paris, France', 'capital city'], ['Catalyst', 'speeds up a reaction, without being used up']]);
});
test('rule 3: needs 70% of lines to fit', () => {
  // Only 1 of 4 lines has a dash, so it is not treated as dash-separated.
  const f = formatOf('Alpha - first\nBeta\nGamma\nDelta');
  assert.notEqual(f.sep, ' - ');
  // 3 of 4 lines (75%) is enough.
  assert.equal(formatOf('A - 1\nB - 2\nC - 3\nD').sep, ' - ');
});
test('rule 3: hyphenated words are not separators', () => {
  assert.deepEqual(cards('Self-esteem - how you value yourself\nWell-being - overall health'), [
    ['Self-esteem', 'how you value yourself'], ['Well-being', 'overall health']
  ]);
});
test('rule 3: says which separator it found', () => {
  assert.equal(formatOf('a - b\nc - d').label, "separated by '-'");
  assert.equal(formatOf('a\tb\nc\td').label, 'separated by tabs');
});

// ---------- rule 4: quoted CSV fields ----------
test('rule 4: quoted fields with commas, quotes and line breaks', () => {
  const rows = parseDelimited('"Paris, France",capital\n"He said ""hi""",greeting\n"two\nlines",x', ',');
  assert.deepEqual(rows, [['Paris, France', 'capital'], ['He said "hi"', 'greeting'], ['two\nlines', 'x']]);
});
test('rule 4: CSV with commas inside quoted definitions', () => {
  const text = 'Mitochondria,"Powerhouse of the cell, makes ATP"\nRibosome,"Builds proteins, reads mRNA"';
  assert.deepEqual(cards(text), [['Mitochondria', 'Powerhouse of the cell, makes ATP'], ['Ribosome', 'Builds proteins, reads mRNA']]);
});
test('rule 4: unquoted comma lines keep extra commas in the back', () => {
  const text = 'Inflation,prices rising, money buys less\nDeflation,prices falling';
  assert.deepEqual(cards(text), [['Inflation', 'prices rising, money buys less'], ['Deflation', 'prices falling']]);
});
test('rule 4: a stray quote mark does not swallow the rest', () => {
  const rows = parseDelimited('"Quote,thing\nnext,line', ',');
  assert.equal(rows.length, 2);
});
test('rule 4: spreadsheet CSV with 3 columns keeps all 3', () => {
  const r = parseText('Term,Definition,Chapter\nAtom,Smallest unit,1\nIon,Charged atom,2');
  assert.deepEqual(r.columns, ['Term', 'Definition', 'Chapter']);
  assert.deepEqual(r.rows, [['Atom', 'Smallest unit', '1'], ['Ion', 'Charged atom', '2']]);
  assert.deepEqual(buildCards(r, 0, 2), [{ front: 'Atom', back: '1' }, { front: 'Ion', back: '2' }]);
});

// ---------- rule 5: header rows ----------
test('rule 5: skips common header rows', () => {
  for (const h of ['term, definition', 'Front,Back', 'Question - Answer', 'TERM\tDEFINITION', 'Word: Meaning']) {
    const sep = h.match(/, ?|\t| - |: /)[0];
    const r = parseText(`${h}\nx${sep}y\nz${sep}w`);
    assert.equal(r.headerSkipped, true, h);
    assert.equal(r.rows.length, 2, h);
  }
});
test('rule 5: a normal first card is not mistaken for a header', () => {
  assert.equal(isHeaderRow(['Mitosis', 'cell division']), false);
  assert.equal(parseText('Mitosis - division\nMeiosis - gametes').headerSkipped, false);
});

// ---------- rule 6: markdown and Notion tables ----------
test('rule 6: markdown table with header and divider', () => {
  const text = '| Term | Definition |\n| --- | --- |\n| Atom | Smallest unit |\n| Ion | Charged atom |';
  const r = parseText(text);
  assert.equal(r.format.id, 'table');
  assert.deepEqual(r.columns, ['Term', 'Definition']);
  assert.deepEqual(r.rows, [['Atom', 'Smallest unit'], ['Ion', 'Charged atom']]);
});
test('rule 6: Notion-style table with alignment colons and an escaped pipe', () => {
  const text = '|Concept|Meaning|\n|:---|---:|\n|OR|a \\| b|\n|AND|a & b|';
  assert.deepEqual(parseText(text).rows, [['OR', 'a | b'], ['AND', 'a & b']]);
});

// ---------- rule 7: blocks and alternating lines ----------
test('rule 7: blocks separated by blank lines', () => {
  const text = 'Photosynthesis\nPlants turn light into sugar\nHappens in chloroplasts\n\nRespiration\nCells break down sugar for energy';
  const r = parseText(text);
  assert.equal(r.format.id, 'blocks');
  assert.deepEqual(cards(text), [
    ['Photosynthesis', 'Plants turn light into sugar\nHappens in chloroplasts'],
    ['Respiration', 'Cells break down sugar for energy']
  ]);
});
test('rule 7: alternating lines when there is no separator', () => {
  const text = 'Photosynthesis\nPlants make sugar from light\nRespiration\nCells release energy from sugar';
  assert.equal(formatOf(text).id, 'alternating');
  assert.deepEqual(cards(text), [['Photosynthesis', 'Plants make sugar from light'], ['Respiration', 'Cells release energy from sugar']]);
});
test('rule 7: odd number of plain lines gives fronts to fill in', () => {
  const r = parseText('One\nTwo\nThree');
  assert.equal(r.format.id, 'none');
  assert.equal(buildCards(r).filter(isComplete).length, 0);
  assert.equal(r.rows.length, 3);
});

// ---------- rule 8: bold terms ----------
test('rule 8: **Term** definition and **Term**: definition', () => {
  const text = '**Osmosis** water crossing a membrane\n**Diffusion**: spreading from high to low\n**Turgor:** pressure in plant cells\n- **Plasmolysis** - cell shrinks';
  assert.equal(formatOf(text).id, 'bold');
  assert.deepEqual(cards(text), [
    ['Osmosis', 'water crossing a membrane'],
    ['Diffusion', 'spreading from high to low'],
    ['Turgor', 'pressure in plant cells'],
    ['Plasmolysis', 'cell shrinks']
  ]);
});

// ---------- rule 9: Quizlet ----------
test('rule 9: Quizlet default export (tab between term and definition, new line between cards)', () => {
  const text = 'mitochondria\tpowerhouse of the cell, makes ATP\nribosome\tsite of protein synthesis: reads mRNA\nnucleus\tholds DNA - the control center';
  const r = parseText(text);
  assert.equal(r.format.sep, '\t');
  assert.deepEqual(cards(text), [
    ['mitochondria', 'powerhouse of the cell, makes ATP'],
    ['ribosome', 'site of protein synthesis: reads mRNA'],
    ['nucleus', 'holds DNA - the control center']
  ]);
});
test('rule 9: Quizlet export with a definition that starts with a quote mark', () => {
  const text = 'Hamlet\t"To be or not to be" speaker\nOthello\tJealous general';
  assert.deepEqual(cards(text)[1], ['Othello', 'Jealous general']);
  assert.equal(cards(text).length, 2);
});

// ---------- messy real-world paste ----------
test('messy: lecture notes pasted from a doc', () => {
  const text = '\r\n  1. Opportunity cost – the next best thing you give up\r\n\r\n  2. Sunk cost – money already spent, can\'t be recovered\r\n  3. Marginal cost – cost of one more unit: rises with output\r\n\r\n';
  assert.deepEqual(cards(text), [
    ['Opportunity cost', 'the next best thing you give up'],
    ['Sunk cost', "money already spent, can't be recovered"],
    ['Marginal cost', 'cost of one more unit: rises with output']
  ]);
});
test('messy: Claude output in "front | back" format', () => {
  const text = 'Mitosis | Division into two identical cells\nMeiosis | Division into four gametes, half the chromosomes';
  assert.deepEqual(cards(text), [['Mitosis', 'Division into two identical cells'], ['Meiosis', 'Division into four gametes, half the chromosomes']]);
});
test('messy: empty or whitespace input', () => {
  assert.equal(parseText('').rows.length, 0);
  assert.equal(parseText('   \n\n  ').rows.length, 0);
});
test('messy: a single card', () => {
  assert.deepEqual(cards('Entropy = disorder'), [['Entropy', 'disorder']]);
});

// ---------- spreadsheets (.xlsx) ----------
test('xlsx rows: numbers become text, empty rows and columns are dropped, header skipped', () => {
  const r = parseRows([['Term', null, 'Definition'], [], ['Pi', null, 3.14], ['Year', undefined, 1066]]);
  assert.deepEqual(r.rows, [['Pi', '3.14'], ['Year', '1066']]);
  assert.equal(r.headerSkipped, true);
});

// ---------- duplicates ----------
test('duplicates: inside the import and already in the deck', () => {
  const list = [{ front: 'Mitosis' }, { front: 'mitosis!' }, { front: 'Meiosis' }, { front: 'Osmosis' }];
  assert.deepEqual(findDuplicates(list, ['OSMOSIS']), [null, 'import', null, 'deck']);
  assert.equal(dupKey('  Café  Au-Lait '), 'cafe au lait');
});

// ---------- Google Sheets links ----------
test('Google Sheets: normal and published links become CSV links', () => {
  assert.equal(sheetsCsvUrl('https://docs.google.com/spreadsheets/d/abc123/edit#gid=456'),
    'https://docs.google.com/spreadsheets/d/abc123/gviz/tq?tqx=out%3Acsv&gid=456');
  assert.equal(sheetsCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pubhtml'),
    'https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=csv');
  assert.equal(sheetsCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?gid=7&single=true&output=csv'),
    'https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=csv&gid=7');
  assert.equal(sheetsCsvUrl('https://example.com/sheet'), null);
  assert.equal(sheetsCsvUrl('not a link'), null);
});

// ---------- Claude prompt ----------
test('Claude prompt: the plan\'s prompt followed by the material', () => {
  assert.ok(CLAUDE_PROMPT.startsWith('Turn the study material below into flashcards for an exam.'));
  assert.ok(claudePrompt('  my notes \r\n').endsWith('Material:\nmy notes'));
});

test('a side can be just a picture (Anki imports)', () => {
  assert.equal(isComplete({ front: '', back: 'Heart', pictures: { front: 'heart.png', back: null } }), true);
  assert.equal(isComplete({ front: '', back: 'Heart', pictures: { front: null, back: null } }), false);
  assert.equal(isComplete({ front: '', back: 'Heart' }), false);
});
