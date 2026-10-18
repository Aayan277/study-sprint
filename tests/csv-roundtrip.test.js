// CSV round trip (bug-hunt #5): what Export writes, Import must read back whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseText, buildCards, stripMarker } from '../js/import.js';
import { toCSV, csvRowCount } from '../js/export.js';

const roundTrip = cards => buildCards(parseText(toCSV(cards)));
const pairs = list => list.map(c => [c.front, c.back]);

test('multi-line cells keep blank lines, bullets and inner spacing', () => {
  const back = 'Intro line\n\n- first point\n- second point\n\n  indented line\n• dot bullet';
  const [c] = roundTrip([{ front: 'Topic', back, tags: [] }]);
  assert.equal(c.front, 'Topic');
  assert.equal(c.back, back);
});
test('a quoted cell with a comma and a quote survives', () => {
  const [c] = roundTrip([{ front: 'He said "hi", twice', back: 'greeting', tags: [] }]);
  assert.deepEqual([c.front, c.back], ['He said "hi", twice', 'greeting']);
});
test('the Tags column is imported and is not a card column', () => {
  const r = parseText(toCSV([{ front: 'a', back: 'b', tags: ['bio', 'week1'] }, { front: 'c', back: 'd', tags: [] }]));
  assert.equal(r.columns.length, 2);
  const list = buildCards(r);
  assert.deepEqual(list[0].tags, ['bio', 'week1']);
  assert.deepEqual(list[1].tags, []);
  assert.deepEqual(pairs(list), [['a', 'b'], ['c', 'd']]);
});
test('several decks: the Deck column stays, tags still come in', () => {
  const r = parseText(toCSV([{ front: 'a', back: 'b', tags: ['x'], deckName: 'D1' }, { front: 'c', back: 'd', tags: [], deckName: 'D2' }]));
  assert.deepEqual(buildCards(r).map(c => c.tags), [['x'], []]);
  assert.equal(r.columns.length, 3);
});
test('a front that is only a marker is not eaten', () => {
  for (const m of ['-', '*', '•']) {
    const [c] = roundTrip([{ front: m, back: 'a bullet', tags: [] }]);
    assert.deepEqual([c.front, c.back], [m, 'a bullet'], `front ${m}`);
  }
  assert.deepEqual(pairs(buildCards(parseText('-\tdash\n*\tstar\n•\tbullet'))), [['-', 'dash'], ['*', 'star'], ['•', 'bullet']]);
  assert.deepEqual(pairs(buildCards(parseText('- | dash\n* | star'))), [['-', 'dash'], ['*', 'star']]);
  assert.equal(stripMarker('- Term'), 'Term');
  assert.equal(stripMarker('1.\tTerm'), 'Term');
});
test('export neutralises cells that start with = + - @ and import strips it back', () => {
  const cards = [
    { front: '=SUM(A1)', back: '+1 charge', tags: [] },
    { front: '-5 degrees', back: '@home', tags: [] },
    { front: 'plain', back: 'a-b', tags: [] }
  ];
  const csv = toCSV(cards);
  assert.ok(csv.includes("'=SUM(A1),'+1 charge"));
  assert.ok(csv.includes("'-5 degrees,'@home"));
  assert.ok(csv.includes('plain,a-b'));
  assert.deepEqual(pairs(roundTrip(cards)), pairs(cards));
});
test('a plain apostrophe is left alone', () => {
  const [c] = roundTrip([{ front: "'Tis the season", back: "it's", tags: [] }]);
  assert.deepEqual([c.front, c.back], ["'Tis the season", "it's"]);
});
test('ordinary pasted lists still lose their bullets and numbers', () => {
  assert.deepEqual(pairs(buildCards(parseText('1. Mitosis - division\n- Meiosis - gametes'))), [['Mitosis', 'division'], ['Meiosis', 'gametes']]);
});
test('a comma file whose cells contain ": " still reads as columns', () => {
  const r = parseText('Front,Back\r\nMitosis,"Note: two cells"\r\nMeiosis,"Note: four cells"\r\n');
  assert.deepEqual(pairs(buildCards(r)), [['Mitosis', 'Note: two cells'], ['Meiosis', 'Note: four cells']]);
});

// ---- batch 1 review fixes ----
import { withClozeLines } from '../js/cloze.js';

test('a CSV with a cloze card and a multi-line cell: cloze per parsed row, tags kept, nothing re-split', () => {
  const multi = 'Line one\n\nLine three, with a comma';
  const cards = [
    { front: 'Topic', back: multi, tags: ['week 1', 'x'] },
    { front: '{{c1::DNA}} carries {{c2::genes}}', back: 'Extra, with comma', tags: ['bio', 'cell biology'] },
    { front: 'plain', back: 'card', tags: [] }
  ];
  const { result, notes } = withClozeLines(toCSV(cards), parseText);
  assert.equal(notes, 1);
  const list = buildCards(result);
  assert.equal(list.length, 4);
  assert.deepEqual(pairs(list), [['Topic', multi], ['[…] carries genes', 'DNA'], ['DNA carries […]', 'genes'], ['plain', 'card']]);
  assert.deepEqual(list.map(c => c.tags), [['week 1', 'x'], ['bio', 'cell biology'], ['bio', 'cell biology'], []]);
  assert.equal(list[1].noteExtra, 'Extra, with comma');
  assert.equal(list[1].cloze.text, '{{c1::DNA}} carries {{c2::genes}}');
  assert.ok(!list.some(c => c.front.includes(',,')), 'no CSV tail in the front');
});
test('a value starting with an apostrophe and a quote-led formula both round trip; a spaced tag stays one tag', () => {
  const cards = [
    { front: "'=x", back: "'quoted", tags: ['two words', 'one'] },
    { front: '=SUM(A1)', back: "''-1", tags: [] },
    { front: '\tTabbed', back: 'CR', tags: [] }
  ];
  const csv = toCSV(cards);
  assert.ok(csv.includes("''=x,'quoted"));
  const list = roundTrip(cards);
  assert.deepEqual(pairs(list), pairs(cards));
  assert.deepEqual(list[0].tags, ['two words', 'one']);
});
test('export guards a leading tab or carriage return and writes tags comma-separated', () => {
  const csv = toCSV([{ front: '\tx', back: '\ry', tags: ['a b', 'c'] }]);
  assert.ok(csv.includes("'\tx"));
  assert.ok(csv.includes('"\'\ry"'));
  assert.ok(csv.includes('"a b, c"'));
});
test('pasted text keeps its leading apostrophe (only the export header turns the guard off)', () => {
  assert.deepEqual(pairs(buildCards(parseText("'+' operator - adds\n'-' operator - subtracts"))), [["'+' operator", 'adds'], ["'-' operator", 'subtracts']]);
  assert.deepEqual(pairs(buildCards(parseText("Front,Back\r\n'=x,'+y\r\n"))), [["'=x", "'+y"]]);
});
test('a Word bullet list with tabs loses its bullets', () => {
  assert.deepEqual(pairs(buildCards(parseText('•\tMitosis - cell division\n•\tMeiosis - makes gametes'))), [['Mitosis', 'cell division'], ['Meiosis', 'makes gametes']]);
  assert.deepEqual(pairs(buildCards(parseText('-\tMitosis - cell division\n-\tMeiosis - makes gametes\n-\tOsmosis - water moves'))), [['Mitosis', 'cell division'], ['Meiosis', 'makes gametes'], ['Osmosis', 'water moves']]);
});
test('only a column headed exactly Tags is the tags column', () => {
  const r = parseText('Term,Meaning,Tag\r\nhola,hello,spanish\r\nadios,bye,spanish\r\n');
  assert.equal(r.columns.length, 3);
  assert.equal(r.tags, undefined);
});

// ---- round 3, batch 1b: both directions ----
import { reverseOf } from '../js/reverse.js';

test('a pair is exported as one row and imported as one card that wants a reverse card', () => {
  const f = { id: 'f1', noteId: 'N1', front: 'Mitosis', back: 'Cell division', tags: ['bio'] };
  const cards = [f, reverseOf(f, 'r1'), { id: 'p', front: 'Meiosis', back: 'Gametes', tags: [] }, { id: 'q', front: 'Nucleus', back: 'Holds DNA', tags: ['x'] }];
  const r = parseText(toCSV(cards));
  assert.deepEqual(r.columns, ['Front', 'Back'], 'the Both directions column is not a card side');
  assert.deepEqual(r.both, [true, false, false]);
  const list = buildCards(r);
  assert.deepEqual(list.map(c => [c.front, c.back, !!c.reversed]), [['Mitosis', 'Cell division', true], ['Meiosis', 'Gametes', false], ['Nucleus', 'Holds DNA', false]]);
  assert.deepEqual(list[0].tags, ['bio']);
  assert.deepEqual(list[2].tags, ['x']);
});

test('the Both directions column is only read in a file with the export\'s own header', () => {
  const r = parseText('Term,Definition,Both directions\r\nMitosis,Division,yes\r\nMeiosis,Gametes,\r\n');
  assert.equal(r.both, undefined);
  assert.ok(buildCards(r).every(c => !c.reversed));
  assert.equal(parseText(toCSV([{ id: 'a', front: 'x', back: 'y', tags: [] }])).both, undefined, 'and not when no card has one');
});

// ---- QA item 7: cloze notes round trip through CSV as one row each ----
import { clozeCard } from '../js/cloze.js';
// ---- review fix 7: one readable row per cloze card, a "Cloze note" column, deleted blanks stay deleted ----
test('CSV export: one front/back row per cloze card with a Cloze note column; import groups them into one note', () => {
  const text = '{{c1::DNA}} carries {{c2::genes}}';
  const mk = n => ({ id: 'k' + n, noteId: 'n1', noteText: text, noteExtra: 'Extra, line', cloze: n, ...clozeCard(text, n), tags: ['bio'], deckName: 'D' });
  const cards = [mk(1), mk(2), { id: 'p', front: 'plain', back: 'card', tags: [], deckName: 'D' }];
  const csv = toCSV(cards);
  assert.equal(csv.trim().split('\r\n').length, 4, 'header + a row per cloze card + the plain row');
  assert.ok(csv.startsWith('﻿Front,Back,Tags,Cloze note,Cloze extra\r\n'));
  assert.ok(csv.includes('[…] carries genes,DNA,bio,{{c1::DNA}} carries {{c2::genes}},"Extra, line"'));
  const { result, notes } = withClozeLines(csv, parseText);
  assert.equal(notes, 0, 'the rows are already per card');
  const list = buildCards(result);
  assert.deepEqual(pairs(list), [['[…] carries genes', 'DNA'], ['DNA carries […]', 'genes'], ['plain', 'card']]);
  assert.equal(list[0].cloze.noteKey, list[1].cloze.noteKey, 'one note');
  assert.deepEqual(list.map(c => c.cloze?.n), [1, 2, undefined]);
  assert.equal(list[0].cloze.text, text);
  assert.equal(list[1].noteExtra, 'Extra, line');
  assert.equal(list[2].cloze, undefined);
  assert.equal(list[2].noteExtra, undefined);
  assert.deepEqual(list[0].tags, ['bio']);
});
test('CSV export: a cloze blank whose card was deleted is not written, and does not come back', () => {
  const text = 'A {{c1::one}} B {{c2::two}} C {{c3::three}}';
  const mk = n => ({ id: 'k' + n, noteId: 'n1', noteText: text, cloze: n, ...clozeCard(text, n), tags: [] });
  const csv = toCSV([mk(1), mk(3)]);       // the card for c2 was deleted
  assert.equal(csv.trim().split('\r\n').length, 3);
  assert.ok(!csv.includes('two,'));
  const list = buildCards(withClozeLines(csv, parseText).result);
  assert.deepEqual(list.map(c => c.cloze.n), [1, 3]);
  assert.equal(csvRowCount([mk(1), mk(3)]), 2);
});
test('a Cloze note column only counts with the export header; a changed front is an ordinary card', () => {
  const r = parseText('Term,Definition,Cloze note\r\n[…] x,a,{{c1::a}} x\r\n');
  assert.equal(r.clozes, undefined);
  const edited = parseText('Front,Back,Tags,Cloze note\r\nMy own front,a,,{{c1::a}} x\r\n[…] x,a,,{{c1::a}} x\r\n');
  assert.deepEqual(edited.clozes.map(c => !!c), [false, true]);
  assert.deepEqual(edited.columns, ['Front', 'Back']);
});
