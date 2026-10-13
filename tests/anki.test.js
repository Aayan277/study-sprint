// Tests for js/anki.js (turning Anki notes into cards). Run with: node tests/anki.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, clozeNumbers, clozeCard, notesToImport, onlyDeck, deckList, replayHistory, seedFromAnki, isCram, isReset, imageNames, mediaList, subdeckPaths, isOcclusionNote } from '../js/anki.js';
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
  assert.deepEqual(list, [{ name: 'brain.png', zipName: undefined }, { name: 'heart.jpg', zipName: '7' }]);
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

test('image-occlusion notes become one plain picture card, not broken cloze cards', () => {
  assert.ok(isOcclusionNote(ioNote('H'), ioModels.get('9')));
  assert.ok(!isOcclusionNote({ fields: ['A {{c1::b}}'] }, ioModels.get('9')));
  assert.ok(!isOcclusionNote(ioNote('H'), { name: 'Basic', fields: ['Front', 'Back'], cloze: false }));      // text alone is not enough
  const r = notesToImport([ioNote('Heart anatomy', 'Left side pumps'), ioNote('')], ioModels, new Map([['x1', [{ timestamp: 1, ease: 3, type: 0, factor: 0 }]]]));
  assert.equal(r.rows.length, 2);                                    // one per note, not one per mask
  assert.deepEqual(r.rows[0], ['Heart anatomy', 'Left side pumps']);
  assert.deepEqual(r.rows[1], ['Diagram', '']);                      // no heading: "Diagram"
  assert.deepEqual(r.pictures, [{ front: null, back: 'heart.png' }, { front: null, back: 'heart.png' }]);
  assert.ok(r.rows.every(row => !row.join(' ').includes('[…]') && !row.join(' ').includes('image-occlusion')));
  assert.deepEqual(r.occluded, [true, true]);
  assert.deepEqual(r.ankiIds, [null, null]);                         // masks' history does not fit a plain picture card
  assert.deepEqual(r.tags, [['anatomy'], ['anatomy']]);
  assert.equal(r.progress.cards, 0);
  assert.equal(r.images, 2);
});

test('occlusion and other notes together; picking a deck keeps the flags in step', () => {
  const r = notesToImport([{ mid: '1', fields: ['Q', 'A'], deck: 'Other' }, ioNote('Heart')], new Map([...models, ...ioModels]));
  assert.deepEqual(r.occluded, [false, true]);
  assert.deepEqual(onlyDeck(r, 'Bio').occluded, [true]);
  assert.deepEqual(onlyDeck(r, 'Bio').rows, [['Heart', '']]);
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
