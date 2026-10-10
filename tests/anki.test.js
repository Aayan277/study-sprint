// Tests for js/anki.js (turning Anki notes into cards). Run with: node tests/anki.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, clozeNumbers, clozeCard, notesToImport, onlyDeck, deckList, replayHistory, imageNames, mediaList, subdeckPaths } from '../js/anki.js';
import { isAnswerLog, isDueReview, reviewsPerDay } from '../js/stats-calc.js';

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
  assert.deepEqual(r.rows, [['Classical **conditioning**', 'Pavlov'], ['Hippocampus', 'Memory']]);   // bold kept as marks
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

test('rows remember which Anki card they came from, and its history', () => {
  const reviews = new Map([['c10', [{ timestamp: 1, ease: 3 }, { timestamp: 2, ease: 0, type: 4, ivl: 5 }]], ['c21', [{ timestamp: 5, ease: 1 }]], ['c20', []]]);
  const r = notesToImport([
    { mid: '1', fields: ['a', '1'], cards: { 0: 'c10', 1: 'c11' } },
    { mid: '2', fields: ['x {{c1::y}} {{c2::z}}', ''], cards: { 0: 'c20', 1: 'c21' } },
    { mid: '1', fields: ['b', '2'] }
  ], models, reviews);
  assert.deepEqual(r.ankiIds, ['c10', 'c20', 'c21', null]);
  assert.deepEqual([...r.reviews.keys()], ['c10', 'c21']);
  assert.deepEqual(r.progress, { cards: 2, reviews: 2 });       // the hand-made change isn't a review
  assert.deepEqual(onlyDeck({ ...r, decks: ['A', 'B', 'B', 'A'] }, 'B').progress, { cards: 1, reviews: 1 });
});

test('replaying Anki reviews: ratings, hand-made changes and Forget', () => {
  // A fake scheduler that just counts reviews, so the replay order is easy to check.
  const rate = (st, rating, when) => ({ state: rating === 1 ? 3 : 2, n: (st?.n || 0) + 1, last: when });
  const { state, logs } = replayHistory([
    { timestamp: 100, ease: 3, ms: 4000, type: 0 },
    { timestamp: 200, ease: 0, ivl: 9, type: 4 },             // "Set due date": skipped
    { timestamp: 300, ease: 1, ms: 90000, type: 1 },
    { timestamp: 400, ease: 0, ivl: 0, type: 4 },             // "Forget": back to new
    { timestamp: 500, ease: 4, ms: 2000, type: 0 }
  ], rate);
  assert.deepEqual(state, { state: 2, n: 1, last: 500 });
  assert.deepEqual(logs.map(l => [l.timestamp, l.rating, l.correct, l.state, l.ms]), [[100, 3, true, 0, 4000], [300, 1, false, 2, 60000], [500, 4, true, 0, 2000]]);
  assert.ok(logs.every(l => l.source === 'anki'));
  assert.equal(replayHistory([{ timestamp: 1, ease: 0, ivl: 0, type: 4 }], rate).state, null);
});

test('reviews from Anki count in the stats', () => {
  const l = { source: 'anki', state: 2, correct: true, timestamp: Date.now() };
  assert.ok(isAnswerLog(l) && isDueReview(l));
  assert.equal(reviewsPerDay([l]).at(-1).review, 1);
});


test('picture names in Anki fields', () => {
  assert.deepEqual(imageNames('Text <img src="brain.png"> and <IMG alt="x" src=\'heart 2.jpg\'>'), ['brain.png', 'heart 2.jpg']);
  assert.deepEqual(imageNames('<img src=cell%20diagram.png>'), ['cell diagram.png']);
  assert.deepEqual(imageNames('<img src="a&amp;b.png">'), ['a&b.png']);
  assert.deepEqual(imageNames('no pictures'), []);
});

test('each row keeps the first picture on each side', () => {
  const r = notesToImport([
    { mid: '1', fields: ['Brain <img src="brain.png">', 'Thinks <img src="a.png"><img src="b.png">'] },
    { mid: '1', fields: ['<img src="only.png">', 'Answer'] },
    { mid: '1', fields: ['Plain', 'Text'] }
  ], models);
  assert.deepEqual(r.pictures, [{ front: 'brain.png', back: 'a.png' }, { front: 'only.png', back: null }, { front: null, back: null }]);
  assert.equal(r.images, 2);
  assert.equal(r.extraImages, 1);
  assert.deepEqual(r.rows[1], ['', 'Answer']);                  // a picture-only front
});

test('the picture list in newer Anki files', () => {
  // Hand-made protobuf: entries "brain.png" and "heart.jpg" (the second with zip name 7).
  const enc = new TextEncoder();
  const str = (field, s) => { const b = enc.encode(s); return [field * 8 + 2, b.length, ...b]; };
  const entry = bytes => [1 * 8 + 2, bytes.length, ...bytes];
  const e1 = [...str(1, 'brain.png'), 2 * 8, 123];
  const e2 = [...str(1, 'heart.jpg'), 2 * 8, 5, 0xf8, 0x0f, 7];          // field 255 (key 2040 = 0xf8 0x0f), value 7
  const list = mediaList(new Uint8Array([...entry(e1), ...entry(e2)]));
  assert.deepEqual(list, [{ name: 'brain.png', zipName: undefined }, { name: 'heart.jpg', zipName: '7' }]);
});

test('keeping Anki subdecks: paths below what all rows share', () => {
  assert.deepEqual(subdeckPaths(['Psych', 'Psych::Unit 1', 'Psych::Unit 1::Lecture 3']), [[], ['Unit 1'], ['Unit 1', 'Lecture 3']]);
  assert.deepEqual(subdeckPaths(['Psych::Unit 1', 'Psych::Unit 2']), [['Unit 1'], ['Unit 2']]);
  assert.deepEqual(subdeckPaths(['Bio', 'Chem::Acids']), [['Bio'], ['Chem', 'Acids']]);
  assert.deepEqual(subdeckPaths(['Psych', 'Psych']), [[], []]);
  assert.deepEqual(subdeckPaths(['', 'A']), [[], ['A']]);
});
