// autotag.js and reading-cards.js used regexes for {{c1::...}} that were slow on hostile text; they now use the scanner in js/cloze.js.
// Run with: node tests/cloze-regex-followup.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFast, rep } from './speed-helper.mjs';
import { notesOf } from '../js/autotag.js';
import { junky } from '../js/reading-cards.js';

const timed = (name, fn) => test(`fast: ${name}`, () => assertFast(name, fn));
const noteFront = front => notesOf([{ id: 'a', front, back: 'b', tags: [] }])[0].front;
const clozeCardOf = cloze => ({ type: 'cloze', kind: 'fact', front: 'x '.repeat(10), back: 'yy', cloze });

for (const [name, s] of [['unclosed', () => rep('{{c1::a ')], ['unclosed with hint', () => rep('{{c1::a::b ')], ['opened a lot, closed at end', () => rep('{{c1::a ') + '}}']]) {
  timed(`autotag, ${name}`, () => noteFront(s()));
  timed(`reading-cards, ${name}`, () => junky(clozeCardOf(s())));
}

test('autotag keeps the answer and drops the hint', () => {
  assert.equal(noteFront('The {{c1::heart}} pumps {{c2::blood::fluid}}.'), 'The heart pumps blood.');
});
test('reading-cards: a c1 answer of more than 6 words is junk, a short one is not', () => {
  assert.equal(junky(clozeCardOf('The {{c1::one two three four five six seven}} end')), true);
  assert.equal(junky(clozeCardOf('The {{c1::Schlieffen Plan}} aimed to win')), false);
});
