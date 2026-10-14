// withClozeLines (A3): cloze lines in a paste are included automatically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClozeLines } from '../js/cloze.js';
import { parseText, buildCards } from '../js/import.js';

test('no cloze lines is just the normal parse', () => {
  const text = 'Mitosis - cell division\nMeiosis - makes gametes';
  const out = withClozeLines(text, parseText);
  assert.equal(out.notes, 0);
  assert.deepEqual(out.result, parseText(text));
});
test('every line a cloze note is the cloze import', () => {
  const out = withClozeLines('The {{c1::cell}} has a {{c2::nucleus}}\nWater is {{c1::H2O}}', parseText);
  assert.equal(out.notes, 2);
  assert.equal(out.result.format.id, 'cloze');
  assert.equal(out.result.rows.length, 3);
  assert.equal(out.result.clozes.length, 3);
  assert.deepEqual(out.result.rows[2], ['Water is […]', 'H2O']);
});
test('mixed lines keep both, padded so clozes line up with rows', () => {
  const text = 'Mitosis - cell division\nThe {{c1::cell}} has a {{c2::nucleus}}\nMeiosis - makes gametes';
  const { result, notes } = withClozeLines(text, parseText);
  assert.equal(notes, 1);
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.slice(0, 2), [['Mitosis', 'cell division'], ['Meiosis', 'makes gametes']]);
  assert.equal(result.clozes.length, 4);                       // null-padded for the plain rows
  assert.deepEqual(result.clozes.slice(0, 2), [null, null]);
  assert.equal(result.clozes[2].n, 1);
  assert.equal(result.clozes[3].text, 'The {{c1::cell}} has a {{c2::nucleus}}');
  assert.equal(result.format.label, "separated by '-', plus 1 cloze note");
  assert.equal(result.format.id, 'separator');
});
test('the label counts several notes', () => {
  const text = 'a - b\nc - d\n{{c1::x}} one\n{{c1::y}} two';
  assert.equal(withClozeLines(text, parseText).result.format.label, "separated by '-', plus 2 cloze notes");
});
test('other lines with no pattern are left out, and counted', () => {
  const out = withClozeLines('The {{c1::cell}} is small\nA plain line with nothing', parseText);
  assert.equal(out.result.format.id, 'cloze');
  assert.equal(out.result.format.skipped, 1);
  assert.equal(out.result.rows.length, 1);
});
test('a markdown table wins over automatic cloze', () => {
  const text = '| Term | Back |\n| --- | --- |\n| a {{c1::b}} | c |\n| d | e |';
  const out = withClozeLines(text, parseText);
  assert.equal(out.notes, 0);
  assert.equal(out.result.format.id, 'table');
});
test('buildCards: cloze rows use columns 0 and 1 whatever columns are chosen', () => {
  const text = 'Mitosis\tdivision\tx\nMeiosis\tgametes\ty\nThe {{c1::cell}} is small';
  const { result } = withClozeLines(text, parseText);
  assert.equal(result.columns.length, 3);
  const list = buildCards(result, 2, 1);
  const clozeRow = list.find(c => c.cloze);
  assert.ok(clozeRow);
  assert.equal(clozeRow.front, 'The […] is small');
  assert.equal(clozeRow.back, 'cell');
  assert.equal(list.filter(c => !c.cloze).length, 2);
});
