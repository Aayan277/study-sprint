// Tests for js/export.js (CSV and Anki deck export). Run with: node tests/export.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, fileName, toAnkiHTML, ankiChecksum, ankiGuid, ankiContents } from '../js/export.js';
import { parseText } from '../js/import.js';

const CSUM = 638429259;     // from Python: int(sha1('Classical conditioning').hexdigest()[:8], 16)
const cards = [
  { id: 'c1', front: 'Classical conditioning', back: 'Learning by association, e.g. "Pavlov"', tags: ['learning', 'exam 1'] },
  { id: 'c2', front: 'Café', back: 'Line one\nLine two', tags: [] }
];

test('CSV: quoted where needed, Excel-friendly, and imports back in', () => {
  const csv = toCSV(cards);
  assert.ok(csv.startsWith('﻿Front,Back,Tags\r\n'));
  assert.ok(csv.includes('Classical conditioning,"Learning by association, e.g. ""Pavlov""","learning, exam 1"'));
  assert.ok(csv.includes('Café,"Line one\nLine two",'));
  const back = parseText(csv.replace(/^﻿/, ''));          // round trip through the importer
  assert.equal(back.rows.length, 2);
  assert.equal(back.rows[0][1], 'Learning by association, e.g. "Pavlov"');
});

test('file names', () => {
  assert.equal(fileName('Cell Biology / Unit 2', 'csv'), 'Cell Biology - Unit 2.csv');
  assert.equal(fileName('   ', 'apkg'), 'deck.apkg');
});

test('Anki: HTML, checksum and stable ids', async () => {
  assert.equal(toAnkiHTML('a < b & "c"\nd'), 'a &lt; b &amp; &quot;c&quot;<br>d');
  assert.equal(await ankiChecksum('Classical conditioning'), CSUM);
  assert.equal(ankiGuid('c1'), ankiGuid('c1'));
  assert.notEqual(ankiGuid('c1'), ankiGuid('c2'));
  assert.equal(ankiGuid('c1').length, 10);
});

test('Anki: deck, note type and new cards', async () => {
  const NOW = 1_800_000_000_000;
  const { col, notes, cards: ac } = await ankiContents({ id: 'd', name: 'Psych' }, cards, NOW);
  const decks = JSON.parse(col.decks), models = JSON.parse(col.models);
  assert.deepEqual(Object.values(decks).map(d => d.name).sort(), ['Default', 'Psych']);
  const model = Object.values(models)[0];
  assert.deepEqual(model.flds.map(f => f.name), ['Front', 'Back']);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].flds, 'Classical conditioning\x1fLearning by association, e.g. &quot;Pavlov&quot;');
  assert.equal(notes[0].tags, ' learning exam_1 ');
  assert.equal(notes[1].flds, 'Café\x1fLine one<br>Line two');
  assert.deepEqual(ac.map(c => [c.nid, c.type, c.queue, c.due]), [[notes[0].id, 0, 0, 1], [notes[1].id, 0, 0, 2]]);
  assert.ok(ac.every(c => c.did === NOW));
});

test('Anki export: a side\'s picture goes after its text', async () => {
  const { notes } = await ankiContents({ id: 'd', name: 'P' }, [{ id: 'c', front: 'Heart', back: '', tags: [], frontImageFile: 'a1.jpg', backImageFile: 'b2.png' }], 1_800_000_000_000);
  assert.equal(notes[0].flds, 'Heart<br><img src="a1.jpg">\x1f<img src="b2.png">');
});

test('subdecks: a Deck column, and Anki subdecks with their parents', async () => {
  const sub = [{ ...cards[0], deckName: 'Psych' }, { ...cards[1], deckName: 'Psych::Unit 1::Lecture 3' }];
  assert.ok(toCSV(sub).startsWith('﻿Front,Back,Tags,Deck\r\n'));
  assert.ok(toCSV(sub).includes(',Psych::Unit 1::Lecture 3\r\n'));
  assert.ok(toCSV(cards).startsWith('﻿Front,Back,Tags\r\n'));                // one deck: no Deck column
  const NOW = 1_800_000_000_000;
  const { col, cards: ac } = await ankiContents({ id: 'd', name: 'Psych' }, sub, NOW);
  const decks = Object.values(JSON.parse(col.decks));
  assert.deepEqual(decks.map(d => d.name).sort(), ['Default', 'Psych', 'Psych::Unit 1', 'Psych::Unit 1::Lecture 3']);
  const nameOf = id => decks.find(d => d.id === id).name;
  assert.deepEqual(ac.map(c => nameOf(c.did)), ['Psych', 'Psych::Unit 1::Lecture 3']);
});

// ---------- cloze notes ----------
test('cloze cards export as one Anki Cloze note, a card for each blank', async () => {
  const { clozeCard } = await import('../js/cloze.js');
  const text = 'The {{c1::mitochondria::organelle}} makes {{c2::ATP}} for <b>the</b> {{c3::cell}}';
  const sib = n => ({ id: 'k' + n, front: clozeCard(text, n).front, back: clozeCard(text, n).back, tags: ['bio'], noteId: 'N1', cloze: n, noteText: text, noteExtra: 'Extra <i>x</i>', deckName: 'Bio' });
  const cards = [{ id: 'p1', front: 'Plain', back: 'Card', tags: [], deckName: 'Bio' }, sib(1), sib(2), sib(3)];
  const { col, notes, cards: ac } = await ankiContents({ id: 'd', name: 'Bio' }, cards, 1_800_000_000_000);
  assert.equal(notes.length, 2);                                  // the plain card, and one cloze note
  assert.equal(ac.length, 4);
  const models = JSON.parse(col.models);
  const cloze = Object.values(models).find(m => m.type === 1);
  assert.ok(cloze && cloze.tmpls[0].qfmt === '{{cloze:Text}}' && cloze.tmpls[0].afmt.includes('{{Back Extra}}'));
  assert.deepEqual(cloze.flds.map(f => f.name), ['Text', 'Back Extra']);
  const note = notes.find(n => n.mid === cloze.id);
  assert.equal(note.guid, ankiGuid('N1'));
  assert.equal(note.flds, `${toAnkiHTML(text)}\x1f${toAnkiHTML('Extra <i>x</i>')}`);
  assert.ok(note.flds.includes('{{c1::mitochondria::organelle}}'));      // the blanks stay as Anki writes them
  assert.deepEqual(ac.filter(c => c.nid === note.id).map(c => c.ord).sort(), [0, 1, 2]);       // blank n is card n - 1
  assert.equal(new Set([...notes.map(n => n.id), ...ac.map(c => c.id)]).size, notes.length + ac.length);   // every id is different
  // a deck with no cloze cards has no Cloze note type at all
  const plain = await ankiContents({ id: 'd', name: 'Bio' }, [cards[0]], 1_800_000_000_000);
  assert.ok(!Object.values(JSON.parse(plain.col.models)).some(m => m.type === 1));
});

test('cloze round trip: export, then read the notes back as the importer sees them', async () => {
  const { clozeCard } = await import('../js/cloze.js');
  const { notesToImport } = await import('../js/anki.js');
  const text = 'The {{c1::mitochondria::organelle}} makes {{c2::ATP}} for the {{c3::cell}}';
  const cards = [1, 2, 3].map(n => ({ id: 'k' + n, ...clozeCard(text, n), tags: ['bio'], noteId: 'N1', cloze: n, noteText: text, noteExtra: 'Extra', deckName: 'Bio' }));
  const { col, notes, cards: ac } = await ankiContents({ id: 'd', name: 'Bio' }, cards);
  const models = new Map(Object.entries(JSON.parse(col.models)).map(([id, m]) => [id, { name: m.name, fields: m.flds.map(f => f.name), cloze: m.type === 1 }]));
  const back = notes.map(n => ({ id: String(n.id), guid: n.guid, mid: String(n.mid), fields: n.flds.split('\x1f'), tags: n.tags.trim().split(/\s+/).filter(Boolean), deck: 'Bio',
    cards: Object.fromEntries(ac.filter(c => c.nid === n.id).map(c => [c.ord, String(c.id)])) }));
  const r = notesToImport(back, models);
  assert.deepEqual(r.rows.map(x => [x[0], x[1]]), cards.map(c => [c.front, c.back]));
  assert.deepEqual(r.clozes.map(c => [c.n, c.text]), [[1, text], [2, text], [3, text]]);
  assert.equal(new Set(r.clozes.map(c => c.noteKey)).size, 1);
  assert.deepEqual(r.noteExtras, ['Extra', 'Extra', 'Extra']);
  assert.deepEqual(r.tags, [['bio'], ['bio'], ['bio']]);
});

test('import then export keeps the Anki guids, so re-importing updates the notes instead of copying them', async () => {
  const { notesToImport } = await import('../js/anki.js');
  const models = new Map([['1', { name: 'Basic', fields: ['Front', 'Back'], cloze: false }], ['2', { name: 'Cloze', fields: ['Text', 'Back Extra'], cloze: true }]]);
  const r = notesToImport([
    { id: '10', guid: 'plainGuid', mid: '1', fields: ['Q', 'A'], tags: [], deck: 'Bio' },
    { id: '11', guid: 'clozeGuid', mid: '2', fields: ['{{c1::a}} and {{c2::b}}', ''], tags: [], deck: 'Bio' }], models);
  // What the import screen saves on each card (import-screen.js): the guid and, for cloze rows, the note.
  const cards = r.rows.map((row, i) => ({ id: 'c' + i, front: row[0], back: row[1], tags: [], deckName: 'Bio', ankiGuid: r.guids[i],
    ...(r.clozes[i] ? { noteId: 'N' + r.clozes[i].noteKey, cloze: r.clozes[i].n, noteText: r.clozes[i].text } : {}) }));
  const { notes } = await ankiContents({ id: 'd', name: 'Bio' }, cards, 1_800_000_000_000);
  assert.deepEqual(notes.map(n => n.guid), ['plainGuid', 'clozeGuid']);
  // Cards that were made here have no saved guid: it comes from their id, as before.
  const mine = await ankiContents({ id: 'd', name: 'Bio' }, [{ id: 'p', front: 'a', back: 'b', tags: [], deckName: 'Bio' }], 1_800_000_000_000);
  assert.equal(mine.notes[0].guid, ankiGuid('p'));
});

// ---------- image occlusion ----------
test('image-occlusion cards export as one Anki Image Occlusion note, a card for each group', async () => {
  const { occFrontBack } = await import('../js/occlusion.js');
  const masks = [{ id: 'a', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'Aorta <b>' }, { id: 'b', n: 4, shape: 'ellipse', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, { id: 'c', n: 4, shape: 'rect', x: 0.1, y: 0.8, w: 0.1, h: 0.1, label: 'Vein' }];
  const sib = n => ({ id: 'o' + n, noteId: 'N9', ...occFrontBack({ header: 'Heart', masks }, n), tags: ['bio'], deckName: 'Bio', backImage: 'm1', backImageFile: 'm1.jpg', noteExtra: 'Extra', occlusion: { n, w: 2048, h: 1365, header: 'Heart', masks } });
  const plain = { id: 'p1', front: 'Plain', back: 'Card', tags: [], deckName: 'Bio' };
  const { col, notes, cards: ac } = await ankiContents({ id: 'd', name: 'Bio' }, [plain, sib(4), sib(1)], 1_800_000_000_000);
  assert.equal(notes.length, 2);                                   // the plain card, and one occlusion note
  assert.equal(ac.length, 3);
  const io = Object.values(JSON.parse(col.models)).find(m => m.originalStockKind === 6);
  assert.ok(io && io.type === 1 && io.id !== JSON.parse(col.conf).curModel * 1);
  assert.deepEqual(io.flds.map(f => f.name), ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments']);
  assert.ok(io.tmpls[0].qfmt.includes('{{cloze:Occlusion}}') && io.tmpls[0].qfmt.includes('anki.imageOcclusion.setup()') && io.tmpls[0].afmt.includes('Toggle Masks'));
  assert.ok(io.css.includes('#image-occlusion-canvas'));
  const note = notes.find(n => n.mid === io.id);
  const [occ, image, header, extra, comments] = note.flds.split('\x1f');
  assert.equal(occ, '{{c1::image-occlusion:rect:left=.1000:top=.2000:width=.3000:height=.4000:oi=1}}{{c4::image-occlusion:ellipse:left=.5000:top=.5000:rx=.1000:ry=.1000:oi=1}}{{c4::image-occlusion:rect:left=.1000:top=.8000:width=.1000:height=.1000:oi=1}}');
  assert.equal(image, '<img src="m1.jpg">');
  assert.deepEqual([header, extra], ['Heart', 'Extra']);
  assert.equal(comments, '1. Aorta &lt;b&gt;<br>2. Vein');           // numbered by position, escaped
  assert.equal(note.sfld, 'Heart');
  assert.equal(note.guid, ankiGuid('N9'));
  assert.deepEqual(ac.filter(c => c.nid === note.id).map(c => c.ord).sort(), [0, 3]);        // group n is card n - 1
  // no occlusion cards: no Image Occlusion note type
  const none = await ankiContents({ id: 'd', name: 'Bio' }, [plain], 1_800_000_000_000);
  assert.ok(!Object.values(JSON.parse(none.col.models)).some(m => m.originalStockKind === 6));
  // a card whose group is gone is exported as an ordinary card
  const orphan = { ...sib(1), occlusion: { ...sib(1).occlusion, n: 7 } };
  assert.equal((await ankiContents({ id: 'd', name: 'Bio' }, [orphan], 1_800_000_000_000)).notes[0].mid, 1_600_000_000_001);
});

test('image-occlusion round trip: export, then read the note back as the importer sees it', async () => {
  const { notesToImport } = await import('../js/anki.js');
  const { toFractions, occFrontBack } = await import('../js/occlusion.js');
  const masks = [{ id: 'a', n: 1, shape: 'rect', x: 0.1234, y: 0.2, w: 0.3, h: 0.4, label: 'Aorta' }, { id: 'b', n: 2, shape: 'ellipse', x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    { id: 'c', n: 3, shape: 'polygon', x: 0.2, y: 0.6, w: 0.2, h: 0.3, points: [[0.2, 0.9], [0.4, 0.9], [0.3, 0.6]], label: 'Vein &amp; <i>duct</i>' }];
  const cards = [1, 2, 3].map(n => ({ id: 'o' + n, noteId: 'N9', ...occFrontBack({ header: 'Heart', masks }, n), tags: [], deckName: 'Bio', backImageFile: 'm1.jpg', occlusion: { n, w: 100, h: 100, header: 'Heart', masks } }));
  const { col, notes, cards: ac } = await ankiContents({ id: 'd', name: 'Bio' }, cards);
  const models = new Map(Object.entries(JSON.parse(col.models)).map(([id, m]) => [id, { name: m.name, fields: m.flds.map(f => f.name), cloze: m.type === 1 }]));
  const back = notes.map(n => ({ id: String(n.id), guid: n.guid, mid: String(n.mid), fields: n.flds.split('\x1f'), tags: [], deck: 'Bio',
    cards: Object.fromEntries(ac.filter(c => c.nid === n.id).map(c => [c.ord, String(c.id)])) }));
  const r = notesToImport(back, models);
  // Anki's file: every shape has left/top, a polygon too (Anki draws it offset by left - minX, top - minY)
  assert.ok(notes[0].flds.split('\x1f')[0].endsWith('{{c3::image-occlusion:polygon:left=.2000:top=.6000:points=.2000,.9000 .4000,.9000 .3000,.6000:oi=1}}'));
  assert.deepEqual(r.rows, [['Heart: hidden part 1 of 3', 'Aorta'], ['Heart: hidden part 2 of 3', ''], ['Heart: hidden part 3 of 3', 'Vein &amp; <i>duct</i>']]);
  assert.deepEqual(r.pictures, [{ front: null, back: 'm1.jpg' }, { front: null, back: 'm1.jpg' }, { front: null, back: 'm1.jpg' }]);
  const again = toFractions(r.occlusions[0].shapes, r.occlusions[0].pixels, 100, 100);
  assert.deepEqual(again.map(m => [m.n, m.shape]), [[1, 'rect'], [2, 'ellipse'], [3, 'polygon']]);
  assert.deepEqual(again.map(m => m.label), ['Aorta', undefined, 'Vein &amp; <i>duct</i>']);            // the labels come back from Comments
  masks.forEach((m, i) => ['x', 'y', 'w', 'h'].forEach(k => assert.ok(Math.abs(again[i][k] - m[k]) <= 1e-4)));
});

test('CSV: image-occlusion cards are their text only (the fallback front and the label)', async () => {
  const csv = toCSV([{ front: 'Heart: hidden part 1 of 2', back: 'Aorta', tags: [], occlusion: {} }]);
  assert.ok(csv.includes('Heart: hidden part 1 of 2,Aorta'));
});

test('image-occlusion export: no picture file on this device means Basic cards, not a note with an empty Image field', async () => {
  const { occFrontBack } = await import('../js/occlusion.js');
  const masks = [{ id: 'a', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'Aorta' }, { id: 'b', n: 2, shape: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }];
  const sib = (n, over = {}) => ({ id: 'o' + n, noteId: 'N9', ...occFrontBack({ header: 'Heart', masks }, n), tags: [], deckName: 'Bio', occlusion: { n, w: 100, h: 100, header: 'Heart', masks }, ...over });
  const { col, notes, cards: ac } = await ankiContents({ id: 'd', name: 'Bio' }, [sib(1), sib(2)], 1_800_000_000_000);
  assert.equal(notes.length, 2);
  assert.ok(notes.every(n => n.mid === 1_600_000_000_001 && n.flds.split('\x1f').length === 2));
  assert.deepEqual(notes.map(n => n.flds.split('\x1f')), [['Heart: hidden part 1 of 2', 'Aorta'], ['Heart: hidden part 2 of 2', '']]);
  assert.equal(ac.length, 2);
  assert.ok(!Object.values(JSON.parse(col.models)).some(m => m.originalStockKind === 6));
  // the picture exists on one sibling only: still one occlusion note
  const some = await ankiContents({ id: 'd', name: 'Bio' }, [sib(1), sib(2, { backImageFile: 'm1.jpg' })], 1_800_000_000_000);
  assert.equal(some.notes.length, 1);
  assert.equal(some.notes[0].flds.split('\x1f')[1], '<img src="m1.jpg">');
});

test('image-occlusion export: a sibling whose group is not among the note\'s boxes goes out as a Basic card', async () => {
  const { occFrontBack } = await import('../js/occlusion.js');
  const masks = [{ id: 'a', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { id: 'b', n: 2, shape: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }];
  const sib = (n, over = {}) => ({ id: 'o' + n, noteId: 'N9', ...occFrontBack({ header: 'Heart', masks }, n), tags: [], deckName: 'Bio', backImageFile: 'm1.jpg', occlusion: { n, w: 100, h: 100, header: 'Heart', masks }, ...over });
  // c7 has boxes of its own (so it passes hasMasks) but n 7 is not in the first card's boxes
  const other = [{ id: 'z', n: 7, shape: 'rect', x: 0.1, y: 0.1, w: 0.1, h: 0.1 }];
  const stray = sib(7, { occlusion: { n: 7, w: 100, h: 100, masks: other }, front: 'Stray', back: 'Card' });
  const { notes, cards: ac } = await ankiContents({ id: 'd', name: 'Bio' }, [sib(1), sib(2), stray], 1_800_000_000_000);
  assert.equal(notes.length, 2);
  assert.deepEqual(ac.filter(c => c.nid === notes[0].id).map(c => c.ord).sort(), [0, 1]);
  assert.equal(notes[1].mid, 1_600_000_000_001);
  assert.deepEqual(notes[1].flds.split('\x1f'), ['Stray', 'Card<br><img src="m1.jpg">']);
});

test('maths: Anki gets \\( \\) and \\[ \\], CSV keeps the text as typed', () => {
  assert.equal(toAnkiHTML('Area $\\pi r^2$ and $$x<y$$'), 'Area \\(\\pi r^2\\) and \\[x&lt;y\\]');
  assert.equal(toAnkiHTML('$5 and $10'), '$5 and $10');
  assert.ok(toCSV([{ front: 'What is $x^2$?', back: '$$E=mc^2$$', tags: [] }]).includes('What is $x^2$?,$$E=mc^2$$'));
});

test('Anki export: a Basic card\'s memory hook (noteExtra) goes at the end of Back as an Extra line', async () => {
  const NOW = 1_800_000_000_000;
  const { notes } = await ankiContents({ id: 'd', name: 'P' }, [
    { id: 'a', front: 'Mitosis', back: 'Cell division', noteExtra: 'My-TOE-sis: toes split', tags: [] },
    { id: 'b', front: 'Meiosis', back: '', backImageFile: 'b.png', noteExtra: 'Think "halves"', tags: [] },
    { id: 'c', front: 'Cell', back: 'Unit', noteExtra: '  ', tags: [] }], NOW);
  assert.equal(notes[0].flds, 'Mitosis\x1fCell division<br><br>My-TOE-sis: toes split');
  assert.equal(notes[1].flds, 'Meiosis\x1f<img src="b.png"><br><br>Think &quot;halves&quot;');
  assert.equal(notes[2].flds, 'Cell\x1fUnit');                         // a blank hook adds nothing
  // CSV stays Front, Back, Tags
  assert.equal(toCSV([{ id: 'a', front: 'Mitosis', back: 'Cell division', noteExtra: 'hook', tags: [] }]).includes('hook'), false);
});

test('Anki export: a stepped back goes out as its Step lines, one per line', async () => {
  const { notes } = await ankiContents({ id: 'd', name: 'P' }, [{ id: 'a', front: '2x+3=7', back: 'Step 1: subtract 3\nStep 2: divide by 2\nAnswer: x = 2', tags: [] }], 1_800_000_000_000);
  assert.equal(notes[0].flds, '2x+3=7\x1fStep 1: subtract 3<br>Step 2: divide by 2<br>Answer: x = 2');
  assert.ok(toCSV([{ id: 'a', front: 'q', back: 'Step 1: a\nStep 2: b', tags: [] }]).includes('Step 1: a\nStep 2: b'));
});
