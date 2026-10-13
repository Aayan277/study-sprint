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
  assert.ok(csv.includes('Classical conditioning,"Learning by association, e.g. ""Pavlov""",learning exam 1'));
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
