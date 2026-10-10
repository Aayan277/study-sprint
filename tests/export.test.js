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
