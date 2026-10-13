// Tests for js/cloze.js (cloze cards). Run with: node tests/cloze.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clozeNumbers, clozeCard, renderCloze, wrapBlank, nextNumber, lastNumber, makesText, planNoteSave, healNotes, planLinks } from '../js/cloze.js';

const T = 'The {{c1::mitochondria::organelle}} makes {{c2::ATP}} for the {{c3::cell}}';

test('numbers: sorted as numbers, each once', () => {
  assert.deepEqual(clozeNumbers(T), [1, 2, 3]);
  assert.deepEqual(clozeNumbers('{{c10::a}} {{c9::b}} {{c2::c}} {{c2::d}}'), [2, 9, 10]);
  assert.deepEqual(clozeNumbers('nothing'), []);
  assert.deepEqual(clozeNumbers(undefined), []);
});

test('card: the blank is hidden (or hinted), the others are shown', () => {
  assert.deepEqual(clozeCard(T, 1), { front: 'The [organelle] makes ATP for the cell', back: 'mitochondria' });
  assert.deepEqual(clozeCard(T, 2), { front: 'The mitochondria makes […] for the cell', back: 'ATP' });
});

test('card: the same number twice is one card with both blanks hidden', () => {
  assert.deepEqual(clozeCard('{{c1::A}} and {{c1::B}} and {{c2::C}}', 1), { front: '[…] and […] and C', back: 'A, B' });
});

test('render: front and back go through formatHTML', () => {
  assert.equal(renderCloze(T, 2, 'front'), 'The mitochondria makes <span class="cloze-blank">[…]</span> for the cell');
  assert.equal(renderCloze(T, 2, 'back'), 'The mitochondria makes <mark class="cloze-ans">ATP</mark> for the cell');
  assert.equal(renderCloze(T, 1, 'front'), 'The <span class="cloze-blank">[organelle]</span> makes ATP for the cell');
  assert.equal(renderCloze('{{c1::a}} {{c2::b}}', 0, 'all'), '<mark class="cloze-ans">a</mark> <mark class="cloze-ans">b</mark>');
});

test('render: bold inside and around blanks keeps working', () => {
  assert.equal(renderCloze('A {{c1::**strong**}} word', 1, 'back'), 'A <mark class="cloze-ans"><b>strong</b></mark> word');
  assert.equal(renderCloze('**A {{c1::big}} word**', 1, 'front'), '<b>A <span class="cloze-blank">[…]</span> word</b>');
  assert.equal(renderCloze('Line one\n{{c1::two}}', 1, 'front'), 'Line one<br><span class="cloze-blank">[…]</span>');
});

test('render: nothing in the text can inject HTML', () => {
  const evil = '{{c1::<script>alert(1)</script>}} and <img src=x onerror=alert(2)> {{c2::"q"}}';
  for (const side of ['front', 'back', 'all']) {
    const html = renderCloze(evil, 1, side);
    assert.ok(!html.includes('<script'), side);
    assert.ok(!html.includes('<img'), side);
  }
  assert.ok(renderCloze(evil, 1, 'back').includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // Even the private stand-in characters are removed from the text.
  assert.ok(!renderCloze('xyz {{c1::a}}', 1, 'front').includes('class="cloze-ans"'));
  // A hint is escaped too.
  assert.ok(renderCloze('{{c1::a::<b onclick=1>}}', 1, 'front').includes('&lt;b onclick=1&gt;'));
});

test('editor buttons: wrap the selection, numbers', () => {
  assert.deepEqual(wrapBlank('The cell wall', 4, 8, 1), { value: 'The {{c1::cell}} wall', start: 10, end: 14 });
  assert.deepEqual(wrapBlank('ab', 1, 1, 2), { value: 'a{{c2::}}b', start: 7, end: 7 });
  assert.equal(nextNumber('{{c1::a}} {{c3::b}}'), 4);
  assert.equal(nextNumber('plain'), 1);
  assert.equal(lastNumber('{{c1::a}} {{c3::b}}'), 3);
  assert.equal(lastNumber('plain'), 1);
  assert.equal(makesText(T), 'Makes 3 cards: c1 c2 c3');
  assert.equal(makesText('{{c1::a}}'), 'Makes 1 card: c1');
  assert.match(makesText('none'), /Select a word/);
});

const sib = (n, extra = {}) => ({ id: 'k' + n, deckId: 'd', noteId: 'N', cloze: n, ...clozeCard(T, n), noteText: T, updatedAt: 10, ...extra });

test('saving a note: existing numbers keep their card, new ones are added, gone ones are removed', () => {
  const old = [sib(1), sib(2), sib(3)];
  const text = 'The {{c1::mitochondria}} makes {{c3::ATP}} for the {{c4::cell}}';
  const plan = planNoteSave(old, text);
  assert.deepEqual(plan.update.map(c => c.id), ['k1', 'k3']);
  assert.equal(plan.update[1].front, 'The mitochondria makes […] for the cell');
  assert.equal(plan.update[1].back, 'ATP');
  assert.ok(plan.update.every(c => c.noteText === text && c.noteId === 'N'));
  assert.deepEqual(plan.add.map(c => [c.cloze, c.back]), [[4, 'cell']]);
  assert.deepEqual(plan.remove.map(c => c.id), ['k2']);
});

test('saving a note: a new note adds every blank; a duplicate number is cleaned up', () => {
  assert.deepEqual(planNoteSave([], T).add.map(c => c.cloze), [1, 2, 3]);
  const plan = planNoteSave([sib(1), sib(1, { id: 'dup' })], '{{c1::x}}');
  assert.deepEqual(plan.update.map(c => c.id), ['k1']);
  assert.deepEqual(plan.remove.map(c => c.id), ['dup']);
});

test('healing: the newest sibling wins and the others follow it', () => {
  const text2 = 'The {{c1::mitochondria}} makes {{c2::energy}} for the {{c3::cell}}';
  const cards = [sib(1), sib(2, { ...clozeCard(text2, 2), noteText: text2, updatedAt: 99, noteExtra: 'more' }), sib(3), { id: 'solo', front: 'a', back: 'b' }];
  const fixed = healNotes(cards);
  assert.deepEqual(fixed.map(c => c.id), ['k1', 'k3']);
  assert.ok(fixed.every(c => c.noteText === text2 && c.noteExtra === 'more'));
  assert.equal(fixed[0].front, 'The […] makes energy for the cell');
  assert.equal(healNotes([sib(1), sib(2), sib(3)]).length, 0);       // already agree
});

test('healing: a sibling whose blank is gone is left alone', () => {
  const text2 = '{{c1::only}} one';
  const fixed = healNotes([sib(1, { updatedAt: 5 }), sib(2, { updatedAt: 6 }), sib(3, { ...clozeCard(text2, 1), cloze: 1, noteText: text2, updatedAt: 50, id: 'k9' })]);
  assert.deepEqual(fixed.map(c => c.id).sort(), ['k1']);
});

const old = (id, front, back, deckId = 'd') => ({ id, deckId, front, back });

test('link tool: cards of one older import become a note', () => {
  const cards = [
    old('a', 'The […] makes ATP for the cell', 'mitochondria'),
    old('b', 'The mitochondria makes [chemical] for the cell', 'ATP'),
    old('c', 'The mitochondria makes ATP for the […]', 'cell'),
    old('x', 'Capital of France?', 'Paris')
  ];
  const { notes, skipped } = planLinks(cards);
  assert.equal(skipped, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].noteText, 'The {{c1::mitochondria}} makes {{c2::ATP::chemical}} for the {{c3::cell}}');
  assert.deepEqual(notes[0].members.map(m => [m.card.id, m.cloze]), [['a', 1], ['b', 2], ['c', 3]]);
  // The rebuilt cards say the same as the old ones.
  assert.equal(clozeCard(notes[0].noteText, 1).front, cards[0].front);
  assert.equal(clozeCard(notes[0].noteText, 2).front, cards[1].front);
});

test('link tool: a lone card, other decks, cards in notes and two blanks are not linked', () => {
  const cards = [
    old('a', 'The […] is big', 'sun'), old('b', 'The sun is […]', 'big', 'other'),       // different decks
    old('c', 'Only […] here', 'one'),                                                    // alone
    old('d', '[…] and […] up', 'x'), old('e', 'x and y up', 'y'),                        // two blanks: left out
    { ...old('f', 'In [1] a [x]', 'q'), noteId: 'n', cloze: 1 }                          // already a note
  ];
  assert.deepEqual(planLinks(cards), { notes: [], skipped: 0 });
});

test('link tool: overlapping blanks are skipped as unclear', () => {
  const { notes, skipped } = planLinks([old('a', 'A […] b', 'x'), old('b', 'A [hint] b', 'x')]);
  assert.equal(notes.length, 0);
  assert.equal(skipped, 1);
});

test('pasted lines: one note per line, lines without blanks left out', async () => {
  const { parseCloze, hasClozeLines } = await import('../js/cloze.js');
  const text = 'The {{c1::cell}} has a {{c2::nucleus}}\nplain line\n\n{{c1::Solo}}';
  assert.ok(hasClozeLines(text) && !hasClozeLines('nothing here'));
  const { result, notes, skipped } = parseCloze(text);
  assert.equal(notes, 2); assert.equal(skipped, 1);
  assert.deepEqual(result.rows, [['The […] has a nucleus', 'cell'], ['The cell has a […]', 'nucleus'], ['[…]', 'Solo']]);
  assert.deepEqual(result.clozes.map(c => c.noteKey), ['paste0', 'paste0', 'paste2']);
  assert.equal(result.format.id, 'cloze');
});
