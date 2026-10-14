// CSV round trip (bug-hunt #5): what Export writes, Import must read back whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseText, buildCards, stripMarker } from '../js/import.js';
import { toCSV } from '../js/export.js';

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
