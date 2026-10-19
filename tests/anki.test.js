// Tests for js/anki.js (turning Anki notes into cards). Run with: node tests/anki.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ankiMath, htmlToText, clozeNumbers, clozeCard, notesToImport, onlyDeck, deckList, replayHistory, seedFromAnki, isCram, isReset, imageNames, mediaList, subdeckPaths, isOcclusionNote, ioLabels, soundNames, soundReport } from '../js/anki.js';
import { splitMath } from '../js/math.js';
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
  assert.deepEqual(r.rows, [['A […] c', 'b', ''], ['A b […]', 'c', ''], ['perro', 'dog', 'El perro corre']]);     // Back Extra is the note's extra, not a column
  assert.deepEqual(r.noteExtras, ['extra', 'extra', '']);
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
  assert.deepEqual(list, [{ name: 'brain.png', zipName: undefined, size: 123 }, { name: 'heart.jpg', zipName: '7', size: 5 }]);
});

test('keeping Anki subdecks: paths below what all rows share', () => {
  assert.deepEqual(subdeckPaths(['Psych', 'Psych::Unit 1', 'Psych::Unit 1::Lecture 3']), [[], ['Unit 1'], ['Unit 1', 'Lecture 3']]);
  assert.deepEqual(subdeckPaths(['Psych::Unit 1', 'Psych::Unit 2']), [['Unit 1'], ['Unit 2']]);
  assert.deepEqual(subdeckPaths(['Bio', 'Chem::Acids']), [['Bio'], ['Chem', 'Acids']]);
  assert.deepEqual(subdeckPaths(['Psych', 'Psych']), [[], []]);
  assert.deepEqual(subdeckPaths(['', 'A']), [[], ['A']]);
});

// ---------- replay, the way Anki's own FSRS code reads a history ----------
// A fake scheduler that records what it was asked, so the order and the flags are easy to check.
const fakeRate = (st, rating, when, isLast) => ({ state: rating === 1 ? 3 : 2, n: (st?.n || 0) + 1, last: when, isLast });
const DAYMS = 86400000;

test('cram reviews from filtered decks are ignored (type 3 with factor 0)', () => {
  assert.ok(isCram({ type: 3, factor: 0, ease: 1 }));
  assert.ok(!isCram({ type: 3, factor: 2300, ease: 3 }));         // a filtered-deck review that did reschedule: real
  assert.ok(!isCram({ type: 3, ease: 1 }));                        // unknown factor (older rows): can't tell, so real
  const { state, logs } = replayHistory([
    { timestamp: 1, ease: 3, ivl: -600, type: 0, factor: 0 },
    { timestamp: 2, ease: 3, ivl: 4, type: 1, factor: 2500 },
    { timestamp: 3, ease: 1, ivl: 0, type: 3, factor: 0 }          // a miss while cramming
  ], fakeRate);
  assert.equal(state.n, 2);
  assert.equal(state.state, 2);                                     // not sent to relearning by the cram miss
  assert.deepEqual(logs.map(l => l.timestamp), [1, 2]);
  assert.equal(replayHistory([{ timestamp: 1, ease: 1, ivl: 0, type: 3, factor: 0 }], fakeRate).state, null);   // only cram: still new
});

test('Forget (type 4, factor 0) resets the card; "Set due date" does not', () => {
  assert.ok(isReset({ ease: 0, type: 4, factor: 0, ivl: 0 }));
  assert.ok(!isReset({ ease: 0, type: 4, factor: 2500, ivl: 12 }));   // moved by hand
  assert.ok(!isReset({ ease: 0, type: 5, factor: 0, ivl: 0 }));       // rescheduled, not forgotten
  assert.ok(isReset({ ease: 0, type: 4, ivl: 0 }));                   // older rows without a factor: a gap of 0
  assert.ok(isReset({ ease: 0, type: 4, factor: 2500, ivl: 0 }));     // some exports keep a factor on it
  const rows = [
    { timestamp: 1, ease: 3, ivl: -600, type: 0, factor: 0 }, { timestamp: 2, ease: 3, ivl: 5, type: 1, factor: 2500 },
    { timestamp: 3, ease: 0, ivl: 12, type: 4, factor: 2500 },        // set due date
    { timestamp: 4, ease: 3, ivl: 9, type: 1, factor: 2500 },
    { timestamp: 5, ease: 0, ivl: 0, type: 4, factor: 0 },            // Forget
    { timestamp: 6, ease: 3, ivl: -600, type: 0, factor: 0 }, { timestamp: 7, ease: 4, ivl: 6, type: 1, factor: 2500 }
  ];
  const { state, logs } = replayHistory(rows, fakeRate);
  assert.deepEqual([state.n, state.last, state.isLast], [2, 7, true]);        // only what came after the Forget sets the schedule
  assert.deepEqual(logs.map(l => [l.timestamp, l.state]), [[1, 0], [2, 2], [4, 2], [6, 0], [7, 2]]);   // the earlier reviews stay in the log
  assert.equal(replayHistory(rows.slice(0, 5), fakeRate).state, null);        // ends with a Forget: new
});

test('old Anki did not log resets: a new learning group after reviews starts the card again', () => {
  const rows = [
    { timestamp: 1, ease: 3, ivl: -600, type: 0, factor: 0 }, { timestamp: 2, ease: 1, ivl: -600, type: 0, factor: 0 },   // one group (several steps)
    { timestamp: 3, ease: 3, ivl: 3, type: 1, factor: 2500 }, { timestamp: 4, ease: 3, ivl: 8, type: 1, factor: 2500 },
    { timestamp: 5, ease: 3, ivl: -600, type: 0, factor: 0 }, { timestamp: 6, ease: 3, ivl: 2, type: 1, factor: 2500 }       // learned again
  ];
  const { state, logs } = replayHistory(rows, fakeRate);
  assert.equal(state.n, 2);                                         // only the last group counts
  assert.equal(logs.length, 6);
  assert.deepEqual(logs.map(l => l.state), [0, 2, 3, 2, 0, 2]);          // the state before each answer (the fake scheduler sends a miss to relearning)
  // learning steps repeated at the start of a normal history do not restart it
  assert.equal(replayHistory(rows.slice(0, 4), fakeRate).state.n, 4);
});

test('a cut-off history starts from the interval and ease Anki has, not from a new card', () => {
  const cut = [{ timestamp: 1000, ease: 3, ivl: 30, type: 1, factor: 2500 }, { timestamp: 2000, ease: 3, ivl: 75, type: 1, factor: 2500 }];
  const asked = [];
  const { state, logs } = replayHistory(cut, (st, rating, when, isLast) => { asked.push(st); return { ...st, n: (st.n || 1) + 1, last: when, isLast }; }, 'c1');
  assert.equal(asked.length, 1);                                    // the first row seeds the card, only the second is replayed
  assert.equal(asked[0].state, 2);
  assert.equal(asked[0].stability, 30);
  assert.equal(asked[0].lastReview, 1000);
  assert.equal(asked[0].cardId, 'c1');
  assert.equal(state.n, 2);
  assert.deepEqual(logs.map(l => [l.timestamp, l.state, l.rating]), [[1000, 2, 3], [2000, 2, 3]]);   // both reviews were from a card in review
  // one row only: the card is just the seed
  assert.equal(replayHistory([cut[0]], fakeRate, 'c1').state.stability, 30);
  // the deck's longest gap still applies to a seed that is the whole history: it comes back by then
  const capped = replayHistory([cut[0]], fakeRate, 'c1', 20).state;
  assert.equal(capped.due, 1000 + 20 * DAYMS);
  assert.equal(capped.scheduledDays, 20);
  // a first row that is a miss (no positive gap), or that is a learning step, replays as a new card
  assert.equal(replayHistory([{ timestamp: 1, ease: 1, ivl: -600, type: 2, factor: 2300 }], fakeRate).state.state, 3);
  assert.equal(replayHistory([{ timestamp: 1, ease: 3, ivl: 5, type: 0, factor: 0 }], fakeRate).state.n, 1);
});

test('seeding: stability from the interval, difficulty from the ease (higher ease = easier)', () => {
  const at = (ivl, factor) => seedFromAnki('c', { timestamp: 0, ivl, factor });
  assert.equal(at(30, 2500).stability, 30);
  assert.equal(at(30, 2500).due, 30 * DAYMS);
  assert.equal(at(30, 2500).state, 2);
  assert.ok(at(30, 1800).difficulty > at(30, 2500).difficulty && at(30, 2500).difficulty > at(30, 3200).difficulty);
  assert.ok(at(30, 1300).difficulty <= 10 && at(30, 9000).difficulty >= 1);
  assert.deepEqual(at(30, 0).difficulty, at(30, 2500).difficulty);        // an unknown ease is Anki's usual 250%
});

test('the reviews counted for progress leave out cram rows and hand-made changes', () => {
  const reviews = new Map([['c1', [{ timestamp: 1, ease: 3, type: 0, factor: 0 }, { timestamp: 2, ease: 1, type: 3, factor: 0 }, { timestamp: 3, ease: 0, type: 4, factor: 0, ivl: 0 }]]]);
  const r = notesToImport([{ mid: '1', fields: ['a', '1'], cards: { 0: 'c1' } }], models, reviews);
  assert.deepEqual(r.progress, { cards: 1, reviews: 1 });
});

// ---------- image-occlusion notes ----------
const ioModels = new Map([['9', { name: 'Image Occlusion', fields: ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'], cloze: true }]]);
const ioNote = (header, extra = '') => ({ mid: '9', fields: ['{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}{{c2::image-occlusion:rect:left=.5:top=.5:width=.2:height=.2}}',
  '<img src="heart.png">', header, extra, ''], tags: ['Anatomy'], deck: 'Bio', cards: { 0: 'x1', 1: 'x2' } });

test('image-occlusion notes become one card for each group of boxes, with all the boxes', () => {
  assert.ok(isOcclusionNote(ioNote('H'), ioModels.get('9')));
  assert.ok(!isOcclusionNote({ fields: ['A {{c1::b}}'] }, ioModels.get('9')));
  assert.ok(!isOcclusionNote(ioNote('H'), { name: 'Basic', fields: ['Front', 'Back'], cloze: false }));      // text alone is not enough
  const n1 = { ...ioNote('Heart anatomy', '<b>Left</b> side pumps'), id: '501', guid: 'g-io' };
  const r = notesToImport([n1, ioNote('')], ioModels, new Map([['x1', [{ timestamp: 1, ease: 3, type: 0, factor: 0 }]]]));
  assert.equal(r.rows.length, 4);                                    // two boxes in each of two notes
  assert.deepEqual(r.rows[0], ['Heart anatomy: hidden part 1 of 2', '']);
  assert.deepEqual(r.rows[1], ['Heart anatomy: hidden part 2 of 2', '']);
  assert.deepEqual(r.rows[2], ['Diagram: hidden part 1 of 2', '']);  // no heading: "Diagram"
  assert.deepEqual(r.pictures[0], { front: null, back: 'heart.png' });
  assert.deepEqual(r.occluded, [false, false, false, false]);
  assert.deepEqual(r.clozes, [null, null, null, null]);
  assert.deepEqual(r.noteExtras, ['**Left** side pumps', '**Left** side pumps', '', '']);
  assert.deepEqual(r.ankiIds, ['x1', 'x2', 'x1', 'x2']);              // history comes along: box n is Anki card n - 1
  assert.equal(r.guids[0], 'g-io');
  const [o1, o2] = r.occlusions;
  assert.deepEqual([o1.noteKey, o1.n, o1.header, o1.image, o1.pixels], ['501', 1, 'Heart anatomy', 'heart.png', false]);
  assert.equal(o2.n, 2);
  assert.equal(o1.shapes, o2.shapes);                                // every card has all the boxes
  assert.deepEqual(o1.shapes.map(s => [s.n, s.x, s.w]), [[1, 0.1, 0.2], [2, 0.5, 0.2]]);
  assert.notEqual(r.occlusions[2].noteKey, o1.noteKey);
  assert.deepEqual(r.tags[0], ['anatomy']);
  assert.deepEqual(r.progress, { cards: 2, reviews: 2 });           // (both test notes use the Anki card x1)
  assert.equal(r.images, 2);
  assert.ok(r.rows.every(row => !row.join(' ').includes('[…]') && !row.join(' ').includes('image-occlusion')));
});

test('image-occlusion: the Comments field ("1. Aorta<br>2. Vein") names the groups by position', () => {
  const withComments = html => ({ ...ioNote('Heart'), fields: [...ioNote('Heart').fields.slice(0, 4), html] });
  const r = notesToImport([withComments('1. Aorta &amp; arch<br>2. <b>Left</b> ventricle')], ioModels);
  assert.deepEqual(r.rows.map(x => x[1]), ['Aorta & arch', 'Left ventricle']);
  assert.deepEqual(r.occlusions[0].shapes.map(x => x.label), ['Aorta & arch', 'Left ventricle']);
  // a gap in the numbers is fine (an unlabelled group), and line breaks work like <br>
  assert.deepEqual(notesToImport([withComments('2. Vein')], ioModels).rows.map(x => x[1]), ['', 'Vein']);
  assert.deepEqual(notesToImport([withComments('1. Aorta\n2. Vein')], ioModels).rows.map(x => x[1]), ['Aorta', 'Vein']);
  // a labelled position that has no group is ignored
  assert.deepEqual(notesToImport([withComments('1. A<br>2. B<br>3. C')], ioModels).rows.map(x => x[1]), ['A', 'B']);
  // free text in Comments (not every line numbered) is left alone
  for (const text of ['Some notes', '1. Aorta<br>and more', '', 'See 1. above']) assert.deepEqual(notesToImport([withComments(text)], ioModels).rows.map(x => x[1]), ['', ''], text);
  assert.equal(ioLabels('Some notes'), null);
  assert.deepEqual(ioLabels('<div>1. A</div><div>2. B</div>'), ['A', 'B']);
});

test('image-occlusion: boxes in one group make one card; text boxes are skipped; pixels are flagged', () => {
  const field = '{{c1::image-occlusion:rect:left=10:top=10:width=50:height=50}}{{c1::image-occlusion:ellipse:left=100:top=10:rx=20:ry=20}}{{c4::image-occlusion:text:left=1:top=1:text=hi}}';
  const r = notesToImport([{ mid: '9', fields: [field, '<img src="a.png">', 'H', '', ''], cards: { 0: 'k' } }], ioModels);
  assert.equal(r.rows.length, 1);
  assert.equal(r.occlusions[0].shapes.length, 2);
  assert.equal(r.occlusions[0].pixels, true);
  assert.deepEqual(r.ankiIds, ['k']);
});

test('image-occlusion: a note with no readable boxes or no picture is still one plain picture card', () => {
  const noBoxes = { mid: '9', fields: ['{{c1::image-occlusion:text:left=1:top=1:text=hi}}', '<img src="a.png">', 'Heart', 'Extra', ''] };
  const noPic = { mid: '9', fields: ['{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}', '', '', '', ''] };
  const r = notesToImport([noBoxes, noPic], ioModels);
  assert.deepEqual(r.rows, [['Heart', 'Extra'], ['Diagram', '']]);
  assert.deepEqual(r.occluded, [true, true]);
  assert.deepEqual(r.occlusions, [null, null]);
  assert.deepEqual(r.pictures, [{ front: null, back: 'a.png' }, { front: null, back: null }]);
});

test('Image Occlusion Enhanced add-on notes: one plain picture card for each group of notes', () => {
  const ioe = new Map([['7', { name: 'Image Occlusion Enhanced', fields: ['ID (hidden)', 'Header', 'Image', 'Question Mask', 'Footer', 'Remarks', 'Sources', 'Extra 1', 'Extra 2', 'Answer Mask', 'Original Mask'], cloze: false }]]);
  const note = (id, deck = 'Bio') => ({ mid: '7', fields: [id, 'Skull', '<img src="skull.png">', '<img src="q.svg">', '', 'Bones', '', '', '', '<img src="a.svg">', '<img src="o.svg">'], tags: [], deck });
  const r = notesToImport([note('2017-1'), note('2017-2'), note('2017-3'), note('2018-1'), note('2017-1', 'Other')], ioe);
  assert.equal(r.rows.length, 3);                                  // 2017 (Bio), 2018 (Bio), 2017 (Other)
  assert.deepEqual(r.rows[0], ['Skull', 'Bones']);
  assert.deepEqual(r.occluded, [true, true, true]);
  assert.deepEqual(r.pictures[0], { front: null, back: 'skull.png' });
  assert.deepEqual(r.occlusions, [null, null, null]);
  assert.equal(r.images, 3);
});

test('occlusion and other notes together; picking a deck keeps every list in step', () => {
  const r = notesToImport([{ mid: '1', fields: ['Q', 'A'], deck: 'Other' }, ioNote('Heart')], new Map([...models, ...ioModels]));
  assert.deepEqual(r.occluded, [false, false, false]);
  assert.deepEqual(r.occlusions.map(o => o && o.n), [null, 1, 2]);
  const bio = onlyDeck(r, 'Bio');
  assert.deepEqual(bio.occlusions.map(o => o.n), [1, 2]);
  assert.deepEqual(bio.rows, [['Heart: hidden part 1 of 2', ''], ['Heart: hidden part 2 of 2', '']]);
  assert.equal(bio.noteExtras.length, 2);
  assert.equal(bio.ankiIds.length, 2);
});

test('a cloze note: its cards share one note key, with the note text and Back Extra', () => {
  const r = notesToImport([
    { id: '101', guid: 'g-one', mid: '2', fields: ['The {{c1::mito}} makes {{c2::ATP}}', '<b>Extra</b> info'], tags: [], deck: 'D', cards: { 0: 'k1', 1: 'k2' } },
    { id: '102', guid: 'g-two', mid: '2', fields: ['{{c1::Solo}} note', ''], tags: [], deck: 'D' },
    { id: '103', guid: 'g-three', mid: '1', fields: ['Front', 'Back'], tags: [], deck: 'D' }
  ], models);
  assert.deepEqual(r.clozes, [
    { noteKey: '101', n: 1, text: 'The {{c1::mito}} makes {{c2::ATP}}' }, { noteKey: '101', n: 2, text: 'The {{c1::mito}} makes {{c2::ATP}}' },
    { noteKey: '102', n: 1, text: '{{c1::Solo}} note' }, null]);
  assert.deepEqual(r.noteExtras, ['**Extra** info', '**Extra** info', '', '']);
  assert.deepEqual(r.guids, ['g-one', 'g-one', 'g-two', 'g-three']);
  assert.deepEqual(r.ankiIds, ['k1', 'k2', null, null]);
  // choosing one Anki deck keeps the lists in step
  const picked = onlyDeck({ ...r, decks: ['A', 'A', 'B', 'B'] }, 'B');
  assert.deepEqual(picked.clozes.map(c => c && c.noteKey), ['102', null]);
  assert.deepEqual(picked.guids, ['g-two', 'g-three']);
});

test('maths: Anki [$] and [$$] become \\( \\) and \\[ \\], which are kept as they are', () => {
  assert.equal(ankiMath('A [$]x^2[/$] and [$$]y[/$$]'), 'A \\(x^2\\) and \\[y\\]');       // v4.2.2: \( \) take spaces and line breaks
  assert.equal(ankiMath('plain'), 'plain');
  const r = notesToImport([{ mid: '1', fields: ['Area [$]\\pi r^2[/$]', 'Energy \\(E=mc^2\\) and [$$]a[/$$]'], tags: [], deck: 'D' }], models);
  assert.deepEqual(r.rows, [['Area \\(\\pi r^2\\)', 'Energy \\(E=mc^2\\) and \\[a\\]']]);
  // spaces and a line break inside still make maths (they would not between $ signs)
  assert.equal(ankiMath('[$] x + 1 [/$]'), '\\( x + 1 \\)');
  const br = notesToImport([{ mid: '1', fields: ['Sum [$]a +<br>b[/$] and [$$] c<br> d [/$$]', 'x'], tags: [], deck: 'D' }], models);
  assert.equal(br.rows[0][0], 'Sum \\(a +\nb\\) and \\[ c\nd \\]');
  assert.deepEqual(splitMath(br.rows[0][0]).filter(p => p.type === 'math').map(p => p.tex), ['a +\nb', 'c\nd']);
});

// ---------- sounds (item 3) and what could not be kept (item B) ----------
test('sound names in Anki fields: in order, URL-decoded, and the tags leave the text', () => {
  assert.deepEqual(soundNames('dog [sound:dog.mp3] and [sound:my%20cat.wav]<br>[sound:a&amp;b.ogg]'), ['dog.mp3', 'my cat.wav', 'a&b.ogg']);
  assert.deepEqual(soundNames('[sound:100%.mp3]'), ['100%.mp3']);          // not valid URL-encoding: kept as it is
  assert.deepEqual(soundNames('<img src="a.png"> nothing here'), []);
  assert.deepEqual(soundNames(undefined), []);
  const r = notesToImport([{ id: '1', mid: 'b', fields: ['dog [sound:dog.mp3]', 'inu'], tags: [], deck: 'D' }], SOUND_MODELS);
  assert.deepEqual(r.rows[0], ['dog', 'inu']);                              // the text has no [sound:] left in it
});

// A package stand-in: files with sizes, like media.info in anki-read.js.
const pack = files => ({ info: name => (name in files ? { size: files[name], type: /\.(mp3|wav)$/.test(name) ? 'audio/' + name.split('.').pop() : 'application/octet-stream' } : null) });
const SOUND_MODELS = new Map([
  ['b', { name: 'Basic', fields: ['Front', 'Back'], cloze: false }],
  ['c', { name: 'Cloze', fields: ['Text', 'Back Extra'], cloze: true }],
  ['o', { name: 'Image Occlusion', fields: ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'], cloze: true }]
]);

test('sounds: the first field is the front, the other fields are the back', () => {
  const media = pack({ 'dog.mp3': 100, 'cat.wav': 200, 'x.mp3': 50 });
  const r = notesToImport([
    { id: '1', mid: 'b', fields: ['dog [sound:dog.mp3]', 'inu [sound:cat.wav][sound:x.mp3]'], tags: [], deck: 'D' },
    { id: '2', mid: 'b', fields: ['no sound', 'none'], tags: [], deck: 'D' }
  ], SOUND_MODELS, new Map(), media);
  assert.deepEqual(r.sounds[0], { note: '1', front: ['dog.mp3'], back: ['cat.wav', 'x.mp3'], lost: [] });
  assert.equal(r.sounds[1], null);
  assert.deepEqual([...r.soundFiles.keys()].sort(), ['cat.wav', 'dog.mp3', 'x.mp3']);
});

test('sounds: a cloze note keeps its Text sounds on the front of every card and the rest on the back; occlusion notes get none', () => {
  const media = pack({ 'p.mp3': 10, 'e.mp3': 20 });
  const r = notesToImport([{ id: '7', mid: 'c', fields: ['{{c1::Paris}} is in {{c2::France}} [sound:p.mp3]', 'Europe [sound:e.mp3]'], tags: [], deck: 'D' }], SOUND_MODELS, new Map(), media);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.sounds.map(s => [s.front, s.back]), [[['p.mp3'], ['e.mp3']], [['p.mp3'], ['e.mp3']]]);       // both blanks share the note's sounds
  const occ = notesToImport([{ id: '8', mid: 'o', fields: ['image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:oi=1 [sound:p.mp3]', '<img src="a.png">', 'Head', '', ''], tags: [], deck: 'D' }], SOUND_MODELS, new Map(), media);
  assert.ok(occ.rows.length > 0 && occ.sounds.every(s => s === null));
});

test('sounds not kept are counted by reason, and a file named many times counts once', () => {
  const MB = 1024 * 1024;
  const numbered = Object.fromEntries(['1', '2', '3', '4', '5'].map(n => [n + '.mp3', 10]));
  const media = pack({ 'ok.mp3': 1000, 'big.wav': MB + 1, 'old.wma': 500, 'edge.mp3': MB, ...numbered });
  const notes = [
    { id: '1', mid: 'b', fields: ['a [sound:ok.mp3]', 'b [sound:big.wav]'], tags: [], deck: 'A' },
    { id: '2', mid: 'b', fields: ['c [sound:gone.mp3]', 'd [sound:old.wma][sound:big.wav]'], tags: [], deck: 'A' },
    { id: '3', mid: 'b', fields: ['e [sound:gone.mp3]', 'f [sound:edge.mp3]'], tags: [], deck: 'B' },
    { id: '4', mid: 'b', fields: ['g [sound:gone.mp3]', 'h [sound:1.mp3][sound:2.mp3][sound:3.mp3][sound:4.mp3][sound:5.mp3]'], tags: [], deck: 'B' }
  ];
  const r = notesToImport(notes, SOUND_MODELS, new Map(), media);
  const rep = soundReport(r);
  assert.deepEqual({ missing: rep.missing, tooBig: rep.tooBig, format: rep.format, extra: rep.extra, dropped: rep.dropped },
    { missing: 1, tooBig: 1, format: 1, extra: 1, dropped: 4 });            // gone.mp3 on 3 cards counts once; exactly 1 MB is allowed
  assert.equal(rep.notes, 3);                                                // notes 1, 3 and 4 have a sound that comes along
  assert.deepEqual(rep.files.sort(), ['1.mp3', '2.mp3', '3.mp3', '4.mp3', 'edge.mp3', 'ok.mp3']);
  assert.equal(rep.bytes, 1000 + MB + 40);
  // picking one deck changes the counts
  const a = soundReport(onlyDeck(r, 'A'));
  assert.deepEqual({ missing: a.missing, tooBig: a.tooBig, format: a.format, extra: a.extra, notes: a.notes }, { missing: 1, tooBig: 1, format: 1, extra: 0, notes: 1 });
  const b = soundReport(onlyDeck(r, 'B'));
  assert.deepEqual({ missing: b.missing, tooBig: b.tooBig, format: b.format, extra: b.extra, notes: b.notes }, { missing: 1, tooBig: 0, format: 0, extra: 1, notes: 2 });
});

test('sounds: without a package every sound with a known ending is taken as present', () => {
  const r = notesToImport([{ id: '1', mid: 'b', fields: ['a [sound:a.mp3][sound:b.amr]', 'x'], tags: [], deck: '' }], SOUND_MODELS);
  assert.deepEqual(r.sounds[0].front, ['a.mp3']);
  assert.deepEqual(r.sounds[0].lost, [{ name: 'b.amr', reason: 'format' }]);
});

// ---------- round 3, batch 1b: cards that work in both directions (item 5) and note fields (item A) ----------
import { reverseModel, templateFormats, fieldReport } from '../js/anki.js';
import { buildCards, hasKeptFields } from '../js/import.js';

const tmpl = (ord, qfmt, afmt = '') => ({ ord, qfmt, afmt });
const revModels = new Map([
  ['10', { name: 'Basic (and reversed card)', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}'), tmpl(1, '{{Back}}')] }],
  ['11', { name: 'Basic (optional reversed card)', fields: ['Front', 'Back', 'Add Reverse'], cloze: false,
    templates: [tmpl(0, '{{Front}}', '{{FrontSide}}<hr id=answer>{{Back}}'), tmpl(1, '{{#Add Reverse}}{{Back}}{{/Add Reverse}}', '{{FrontSide}}<hr id=answer>{{Front}}')] }],
  ['12', { name: 'Vocab with listening', fields: ['Word', 'Meaning', 'Audio'], cloze: false, templates: [tmpl(0, '{{Word}}'), tmpl(1, '{{Audio}}'), tmpl(2, '{{Meaning}}')] }],
  ['13', { name: 'Basic', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}')] }],
  ['14', { name: 'Two cards, both ask the front', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}'), tmpl(1, '{{Front}} again')] }],
  ['15', { name: 'Typed', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}'), tmpl(1, '{{type:Back}}')] }]
]);

test('reverseModel: exactly two card types, the second asking with the Back field and not the Front', () => {
  assert.equal(reverseModel(revModels.get('10')), true);
  assert.equal(reverseModel(revModels.get('11')), true, 'optional reversed card: {{#Add Reverse}}{{Back}}{{/Add Reverse}}');
  assert.equal(reverseModel(revModels.get('12')), false, 'three card types');
  assert.equal(reverseModel(revModels.get('13')), false, 'one card type');
  assert.equal(reverseModel(revModels.get('14')), false, 'the second card asks with the Front');
  assert.equal(reverseModel(revModels.get('15')), true, '{{type:Back}} still asks with the Back field');
  assert.equal(reverseModel({ name: 'No templates read', fields: ['Front', 'Back'], cloze: false }), false);
  assert.equal(reverseModel({ name: 'Cloze', fields: ['Text', 'Back Extra'], cloze: true, templates: [tmpl(0, '{{cloze:Text}}'), tmpl(1, '{{Back Extra}}')] }), false);
});

test('templateFormats: the front and back template out of a new-layout config record', () => {
  const enc = new TextEncoder();
  const field = (n, text) => { const b = enc.encode(text); return [(n << 3) | 2, b.length, ...b]; };
  const config = new Uint8Array([...field(1, '{{Front}}'), ...field(2, '{{FrontSide}}<hr id=answer>{{Back}}'), 24, 5]);
  assert.deepEqual(templateFormats(config), { qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' });
  assert.deepEqual(templateFormats(null), { qfmt: '', afmt: '' });
});

test('"Basic (and reversed card)": the note brings both cards, and the reverse card keeps its own history', () => {
  const r = notesToImport([
    { id: 'n1', mid: '10', fields: ['Mitosis', 'Cell division'], tags: [], deck: 'Bio', cards: { 0: 'a1', 1: 'a2' } },
    { id: 'n2', mid: '11', fields: ['Meiosis', 'Gametes', 'y'], tags: [], deck: 'Chem', cards: { 0: 'b1', 1: 'b2' } },
    { id: 'n3', mid: '11', fields: ['Nucleus', 'Holds DNA', ''], tags: [], deck: 'Bio', cards: { 0: 'c1' } },       // optional reverse not asked for
    { id: 'n4', mid: '13', fields: ['Ribosome', 'Makes proteins'], tags: [], deck: 'Bio', cards: { 0: 'd1' } }
  ], revModels, new Map([['a1', [{ timestamp: 1, ease: 3, ivl: 1, ms: 1000, type: 0, factor: 2500 }]], ['a2', [{ timestamp: 2, ease: 3, ivl: 1, ms: 1000, type: 0, factor: 2500 }, { timestamp: 3, ease: 1, ivl: 0, ms: 900, type: 1, factor: 2300 }]]]));
  assert.deepEqual(r.reversed, [{ ankiId: 'a2' }, { ankiId: 'b2' }, null, null]);
  assert.deepEqual(r.ankiIds, ['a1', 'b1', 'c1', 'd1']);
  assert.deepEqual(r.progress, { cards: 2, reviews: 3 }, "the reverse card's two reviews count too");
  assert.deepEqual([...r.reviews.keys()].sort(), ['a1', 'a2']);
  // "Add Reverse" is only a switch: it is not a field of the note
  assert.deepEqual(r.fieldNames[1], ['Front', 'Back', null]);
  assert.equal(buildCards(r, 0, 1)[1].noteFields, undefined);
  assert.deepEqual(buildCards(r, 0, 1).map(c => c.reversed), [{ ankiId: 'a2' }, { ankiId: 'b2' }, undefined, undefined]);
  // a deck picker keeps the arrays together, and the progress follows the rows left
  const chem = onlyDeck(r, 'Chem');
  assert.equal(chem.rows.length, 1);
  assert.deepEqual(chem.reversed, [{ ankiId: 'b2' }]);
  assert.deepEqual(chem.progress, { cards: 0, reviews: 0 });
  assert.deepEqual(onlyDeck(r, 'Bio').progress, { cards: 2, reviews: 3 });
});

test('notes with more card types than come in are counted (a listening card), not reversed', () => {
  const r = notesToImport([
    { id: 'n1', mid: '12', fields: ['犬', 'dog', '[sound:dog.mp3]'], tags: [], deck: 'V', cards: { 0: 'a', 1: 'b', 2: 'c' } },
    { id: 'n2', mid: '12', fields: ['猫', 'cat', ''], tags: [], deck: 'V', cards: { 0: 'd' } },
    { id: 'n3', mid: '12', fields: ['鳥', 'bird', ''], tags: [], deck: 'W', cards: { 0: 'e', 1: 'f' } }
  ], revModels);
  assert.deepEqual(r.reversed, [null, null, null]);
  assert.equal(fieldReport(r).more, 2, 'n2 has only the first card in Anki, so nothing is left out');
  assert.equal(fieldReport(onlyDeck(r, 'V')).more, 1);
});

// AnKing-style notes: Text, Extra, Personal Notes, First Aid, Sketchy, Pathoma
const anking = new Map([['20', { name: 'AnKingOverhaul', fields: ['Text', 'Extra', 'Personal Notes', 'First Aid', 'Sketchy', 'Pathoma'], cloze: true }]]);
const ankingNote = (fields, extra = {}) => ({ id: 'k1', mid: '20', fields, tags: ['#AK_Step1_v12::#UWorld::Step::12345'], deck: 'AnKing', ...extra });

test('note fields: a cloze note keeps its extra open and the other fields as named folded sections', () => {
  const r = notesToImport([ankingNote(['{{c1::Aorta}} leaves the {{c2::left ventricle}}', 'Remember <b>this</b>', '', 'p. 41', 'Video 3<br>Part two', ''])], anking);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.extraSplits[0], { extra: 'Remember **this**', fields: [{ name: 'First Aid', text: 'p. 41' }, { name: 'Sketchy', text: 'Video 3\nPart two' }] });
  assert.deepEqual(r.extraSplits[1], r.extraSplits[0], 'every card of the note');
  assert.equal(r.noteExtras[0], 'Remember **this**\np. 41\nVideo 3\nPart two', 'with the switch off, all of it joined as before');
  const on = buildCards(r, 0, 1, { keepFields: true });
  assert.equal(on[0].noteExtra, 'Remember **this**');
  assert.deepEqual(on[0].noteFields, [{ name: 'First Aid', text: 'p. 41' }, { name: 'Sketchy', text: 'Video 3\nPart two' }]);
  const off = buildCards(r, 0, 1, { keepFields: false });
  assert.equal(off[0].noteExtra, 'Remember **this**\np. 41\nVideo 3\nPart two');
  assert.equal(off[0].noteFields, undefined);
  assert.equal(hasKeptFields(r), true);
});

test('note fields: the Back Extra field is the extra even when it is not second; empty fields are dropped; duplicate names both stay', () => {
  const m = new Map([['21', { name: 'Odd', fields: ['Text', 'Notes', 'Back Extra', 'Notes'], cloze: true }]]);
  const r = notesToImport([{ id: 'k2', mid: '21', fields: ['{{c1::a}} b', 'one', 'extra text', 'two'], tags: [], deck: 'D' }], m);
  assert.deepEqual(r.extraSplits[0], { extra: 'extra text', fields: [{ name: 'Notes', text: 'one' }, { name: 'Notes', text: 'two' }] });
  const plain = notesToImport([{ id: 'k3', mid: '2', fields: ['{{c1::x}} y', 'Only an extra'], tags: [], deck: 'D' }], models);
  assert.equal(plain.extraSplits[0], null, 'nothing else to keep');
  assert.equal(hasKeptFields(plain), false, 'the switch is not shown');
  assert.equal(buildCards(plain)[0].noteExtra, 'Only an extra');
});

test('note fields: a field with only a picture is dropped and counted; very long fields are cut', () => {
  const long = 'x'.repeat(25000);
  const r = notesToImport([ankingNote(['{{c1::a}} b', 'Extra', '', '<img src="fa.png">', long, 'ok'])], anking);
  assert.deepEqual(r.extraSplits[0].fields.map(f => f.name), ['Sketchy', 'Pathoma']);
  assert.equal(r.extraSplits[0].fields[0].text.length, 20000);
  assert.ok(r.extraSplits[0].fields[0].text.endsWith('…'));
  assert.deepEqual(fieldReport(r), { pictures: 1, cut: 1, more: 0 });
  // {{c1::…}} inside another field stays plain text
  const t = notesToImport([ankingNote(['{{c1::a}} b', '', '', 'A {{c1::fake}} cloze'])], anking);
  assert.equal(t.extraSplits[0].fields[0].text, 'A {{c1::fake}} cloze');
});

test('note fields: a basic note keeps the columns that are not the front or back', () => {
  const r = notesToImport([{ id: 'v1', mid: '3', fields: ['犬', 'dog', 'Inu wa kawaii', ''], tags: [], deck: 'V' }], new Map([['3', { name: 'Vocab', fields: ['Word', 'Meaning', 'Example', 'Notes'], cloze: false }]]));
  assert.deepEqual(r.fieldNames[0], ['Word', 'Meaning', 'Example', 'Notes']);
  assert.deepEqual(buildCards(r, 0, 1)[0].noteFields, [{ name: 'Example', text: 'Inu wa kawaii' }]);
  assert.deepEqual(buildCards(r, 0, 2)[0].noteFields, [{ name: 'Meaning', text: 'dog' }], 'choosing other columns changes which are left over');
  assert.equal(buildCards(r, 0, 1, { keepFields: false })[0].noteFields, undefined);
  assert.equal(hasKeptFields(r), true);
});

test("note fields: <details><summary> sections are read back as fields (what this app's Anki export writes)", () => {
  const back = 'The answer<br><br>Hook<details><summary>First Aid</summary>p. 12<br>line two</details><details><summary>Sketchy &amp; co</summary>video</details>';
  const r = notesToImport([{ id: 'x1', mid: '1', fields: ['Front', back], tags: [], deck: 'D' }], models);
  assert.deepEqual(r.rows[0], ['Front', 'The answer\n\nHook']);
  assert.deepEqual(buildCards(r)[0].noteFields, [{ name: 'First Aid', text: 'p. 12\nline two' }, { name: 'Sketchy & co', text: 'video' }]);
  assert.equal(buildCards(r, 0, 1, { keepFields: false })[0].noteFields, undefined);
  // a cloze note's Back Extra
  const c = notesToImport([{ id: 'x2', mid: '2', fields: ['{{c1::a}} b', 'Extra<details><summary>Sketchy</summary>vid</details>'], tags: [], deck: 'D' }], models);
  assert.deepEqual(c.extraSplits[0], { extra: 'Extra', fields: [{ name: 'Sketchy', text: 'vid' }] });
  assert.equal(c.noteExtras[0], 'Extra\nSketchy\nvid');
});

// ---------- typing cards: {{type:…}} in a card type ----------
import { typedOrds } from '../js/anki.js';
{
  const typeModels = new Map([
    ['t1', { name: 'Basic (type in the answer)', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}\n\n{{type:Back}}', '{{Front}}<hr id=answer>{{type:Back}}')] }],
    ['t2', { name: 'Basic (no composition)', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}\n{{type:nc:Back}}')] }],
    ['t3', { name: 'Cloze (type)', fields: ['Text', 'Back Extra'], cloze: true, templates: [tmpl(0, '{{cloze:Text}}\n{{type:cloze:Text}}')] }],
    ['t4', { name: 'Basic (and reversed, typed back)', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}'), tmpl(1, '{{Back}}\n\n{{type:Front}}')] }],
    ['t5', { name: 'Typed only on the answer side', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}', '{{FrontSide}}<hr id=answer>{{type:Back}}')] }],
    ['t6', { name: 'Plain', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}', '{{Back}}')] }],
    ['t7', { name: 'Cloze', fields: ['Text', 'Back Extra'], cloze: true, templates: [tmpl(0, '{{cloze:Text}}')] }]
  ]);

  test('typedOrds: the card types whose question side has a {{type:…}} box', () => {
    assert.deepEqual([...typedOrds(typeModels.get('t1'))], [0]);
    assert.deepEqual([...typedOrds(typeModels.get('t2'))], [0], '{{type:nc:Back}}');
    assert.deepEqual([...typedOrds(typeModels.get('t3'))], [0], '{{type:cloze:Text}}');
    assert.deepEqual([...typedOrds(typeModels.get('t4'))], [1]);
    assert.deepEqual([...typedOrds(typeModels.get('t5'))], [], 'a box only on the answer side does not count');
    assert.deepEqual([...typedOrds(typeModels.get('t6'))], []);
    assert.deepEqual([...typedOrds({ name: 'x' })], []);
  });

  test('"Basic (type in the answer)" notes import as typing cards; other notes do not', () => {
    const r = notesToImport([
      { id: 'n1', mid: 't1', fields: ['Capital of France', 'Paris'], tags: [], deck: 'Geo', cards: { 0: 'a1' } },
      { id: 'n2', mid: 't2', fields: ['Capital of Italy', 'Rome'], tags: [], deck: 'Geo', cards: { 0: 'a2' } },
      { id: 'n3', mid: 't6', fields: ['Capital of Spain', 'Madrid'], tags: [], deck: 'Geo', cards: { 0: 'a3' } },
      { id: 'n4', mid: 't5', fields: ['Capital of Peru', 'Lima'], tags: [], deck: 'Geo', cards: { 0: 'a4' } }
    ], typeModels);
    assert.deepEqual(r.typeIns, [true, true, false, false]);
    const cards = buildCards(r);
    assert.deepEqual(cards.map(c => c.typeIn), [true, true, undefined, undefined], 'only true is ever set');
  });

  test('a cloze type with {{type:cloze:Text}} types every card of the note', () => {
    const r = notesToImport([
      { id: 'n1', mid: 't3', fields: ['The {{c1::heart}} pumps {{c2::blood}}', ''], tags: [], deck: 'A', cards: { 0: 'c1', 1: 'c2' } },
      { id: 'n2', mid: 't7', fields: ['The {{c1::lung}} breathes', ''], tags: [], deck: 'A', cards: { 0: 'c3' } }
    ], typeModels);
    assert.deepEqual(r.typeIns, [true, true, false]);
  });

  test('a reverse model with {{type:Front}} on card 2: reverse card typed, forward card not', () => {
    assert.equal(reverseModel(typeModels.get('t4')), true, 'the Back is shown and the Front only typed');
    assert.equal(reverseModel({ name: 'both typed', fields: ['Front', 'Back'], cloze: false, templates: [tmpl(0, '{{Front}}'), tmpl(1, '{{Back}}{{type:Front}}')] }), true);
    const r = notesToImport([{ id: 'n1', mid: 't4', fields: ['Mitosis', 'Cell division'], tags: [], deck: 'Bio', cards: { 0: 'a1', 1: 'a2' } }], typeModels);
    assert.deepEqual(r.typeIns, [false]);
    assert.deepEqual(r.reversed, [{ ankiId: 'a2', typeIn: true }]);
  });

  test('onlyDeck keeps typeIns lined up with the rows', () => {
    const r = notesToImport([
      { id: 'n1', mid: 't6', fields: ['a', 'b'], tags: [], deck: 'One', cards: { 0: 'x1' } },
      { id: 'n2', mid: 't1', fields: ['c', 'd'], tags: [], deck: 'Two', cards: { 0: 'x2' } },
      { id: 'n3', mid: 't1', fields: ['e', 'f'], tags: [], deck: 'Two::Sub', cards: { 0: 'x3' } }
    ], typeModels);
    assert.deepEqual(r.typeIns, [false, true, true]);
    assert.deepEqual(onlyDeck(r, 'Two').typeIns, [true, true]);
    assert.deepEqual(onlyDeck(r, 'One').typeIns, [false]);
    assert.deepEqual(buildCards(onlyDeck(r, 'Two')).map(c => c.front), ['c', 'e']);
  });
}
