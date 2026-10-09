// Tests for js/anki.js (turning Anki notes into cards). Run with: node tests/anki.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, clozeNumbers, clozeCard, notesToImport, onlyDeck, deckList } from '../js/anki.js';

test('HTML becomes plain text', () => {
  assert.equal(htmlToText('Learning by <b>association</b>&nbsp;(Pavlov)'), 'Learning by association (Pavlov)');
  assert.equal(htmlToText('rewards &amp; punishments<br>e.g. &lt;praise&gt;'), 'rewards & punishments\ne.g. <praise>');
  assert.equal(htmlToText('<div>one</div><div>two</div>'), 'one\ntwo');
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '• a\n• b');
  assert.equal(htmlToText('Forms memories <img src="brain.png">'), 'Forms memories');
  assert.equal(htmlToText('[sound:beep.mp3]Neuron'), 'Neuron');
  assert.equal(htmlToText('caf&#233; &#x2192; it&rsquo;s'), 'café → it’s');
  assert.equal(htmlToText('<style>.x{}</style>  spaced   out  '), 'spaced out');
});

test('cloze: one card per number, the others shown', () => {
  const t = 'The {{c1::frontal lobe}} plans and {{c2::Broca::speech area}} is for {{c1::thinking}}.';
  assert.deepEqual(clozeNumbers(t), [1, 2]);
  assert.deepEqual(clozeCard(t, 1), { front: 'The […] plans and Broca is for […].', back: 'frontal lobe, thinking' });
  assert.deepEqual(clozeCard(t, 2), { front: 'The frontal lobe plans and [speech area] is for thinking.', back: 'Broca' });
  assert.deepEqual(clozeNumbers('no cloze here'), []);
});

const models = new Map([
  ['1', { name: 'Basic', fields: ['Front', 'Back'], cloze: false }],
  ['2', { name: 'Cloze', fields: ['Text', 'Back Extra'], cloze: true }],
  ['3', { name: 'Vocab', fields: ['Word', 'Meaning', 'Example'], cloze: false }]
]);

test('notes become rows, with tags and decks', () => {
  const r = notesToImport([
    { mid: '1', fields: ['Classical <b>conditioning</b>', 'Pavlov'], tags: ['Exam1', 'learning'], deck: 'Psych' },
    { mid: '1', fields: ['Hippocampus', 'Memory <img src="a.png">'], tags: [], deck: 'Psych::Unit 2' }
  ], models);
  assert.deepEqual(r.columns, ['Front', 'Back']);       // one note type: its field names
  assert.deepEqual(r.rows, [['Classical conditioning', 'Pavlov'], ['Hippocampus', 'Memory']]);
  assert.deepEqual(r.tags, [['exam1', 'learning'], []]);
  assert.equal(r.images, 1);
  assert.equal(r.format.id, 'anki');
});

test('cloze notes and mixed note types', () => {
  const r = notesToImport([
    { mid: '2', fields: ['A {{c1::b}} {{c2::c}}', 'extra'], tags: ['x'], deck: 'D' },
    { mid: '3', fields: ['perro', 'dog', 'El perro corre'], tags: [], deck: 'D' }
  ], models);
  assert.deepEqual(r.rows, [['A […] c', 'b', 'extra'], ['A b […]', 'c', 'extra'], ['perro', 'dog', 'El perro corre']]);
  assert.deepEqual(r.tags, [['x'], ['x'], []]);
  assert.deepEqual(r.columns, ['Front (field 1)', 'Back (field 2)', 'Field 3']);
});

test('picking one Anki deck includes its subdecks', () => {
  const r = notesToImport([
    { mid: '1', fields: ['a', '1'], deck: 'Psych' },
    { mid: '1', fields: ['b', '2'], deck: 'Psych::Unit 2' },
    { mid: '1', fields: ['c', '3'], deck: 'Psychology' },
    { mid: '1', fields: ['d', '4'], deck: 'Bio' }
  ], models);
  assert.deepEqual(onlyDeck(r, 'Psych').rows.map(x => x[0]), ['a', 'b']);
  assert.deepEqual(onlyDeck(r, '').rows.length, 4);
  assert.deepEqual(deckList(r), [
    { name: 'Bio', count: 1 }, { name: 'Psych', count: 2 }, { name: 'Psych::Unit 2', count: 1 }, { name: 'Psychology', count: 1 }
  ]);
});
