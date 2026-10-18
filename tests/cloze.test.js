// Tests for js/cloze.js (cloze cards). Run with: node tests/cloze.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clozeNumbers, clozeCard, renderCloze, wrapBlank, nextNumber, lastNumber, makesText, planNoteSave, removalText, healNotes, planLinks } from '../js/cloze.js';

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
  assert.equal(renderCloze(T, 2, 'front'), 'The mitochondria makes <span class="cloze-blank"><span class="sr-only">blank </span><span aria-hidden="true">[…]</span></span> for the cell');
  assert.equal(renderCloze(T, 2, 'back'), 'The mitochondria makes <mark class="cloze-ans">ATP</mark> for the cell');
  assert.equal(renderCloze(T, 1, 'front'), 'The <span class="cloze-blank"><span class="sr-only">blank </span>[organelle]</span> makes ATP for the cell');
  assert.equal(renderCloze('{{c1::a}} {{c2::b}}', 0, 'all'), '<mark class="cloze-ans">a</mark> <mark class="cloze-ans">b</mark>');
});

test('render: bold inside and around blanks keeps working', () => {
  assert.equal(renderCloze('A {{c1::**strong**}} word', 1, 'back'), 'A <mark class="cloze-ans"><b>strong</b></mark> word');
  assert.equal(renderCloze('**A {{c1::big}} word**', 1, 'front'), '<b>A <span class="cloze-blank"><span class="sr-only">blank </span><span aria-hidden="true">[…]</span></span> word</b>');
  assert.equal(renderCloze('Line one\n{{c1::two}}', 1, 'front'), 'Line one<br><span class="cloze-blank"><span class="sr-only">blank </span><span aria-hidden="true">[…]</span></span>');
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

test('saving a note: of two cards with one number, the scheduled one stays and the other is a duplicate', () => {
  const score = c => (c.id === 'dup' ? 5 : 0);              // the caller scores cards by schedule and reviews
  const plan = planNoteSave([sib(1), sib(1, { id: 'dup' }), sib(2)], '{{c1::x}}', score);
  assert.deepEqual(plan.update.map(c => c.id), ['dup']);
  assert.deepEqual(plan.remove.map(c => c.id).sort(), ['k1', 'k2']);
  assert.deepEqual(plan.duplicates.map(c => c.id), ['k1']);
  assert.equal(removalText(plan), 'c2 was removed and duplicate c1 removed: their cards and review history go too.');
  assert.equal(removalText(planNoteSave([sib(1), sib(1, { id: 'dup' })], '{{c1::x}}')), 'duplicate c1 removed: its card and review history go too.');
  assert.equal(removalText(planNoteSave([sib(1), sib(2)], '{{c1::x}}')), 'c2 was removed: its card and review history go too.');
});

test('saving a note: an empty blank is rejected with a message, and nothing is removed', () => {
  for (const text of ['A {{c1::}} b', 'A {{c1::ok}} {{c2:: }} b', 'A {{c1::::hint}} b']) {
    const plan = planNoteSave([sib(1), sib(2)], text);
    assert.match(plan.error, /empty/);
    assert.deepEqual([plan.update, plan.add, plan.remove], [[], [], []]);
  }
  assert.equal(planNoteSave([sib(1)], 'A {{c1::ok}} b').error, undefined);
});

test('saving a note: removed blanks are listed in number order, whatever order the cards come in', () => {
  const plan = planNoteSave([sib(4), sib(2), sib(3), sib(1)], '{{c1::x}}');
  assert.equal(removalText(plan), 'c2, c3 and c4 were removed: their cards and review history go too.');
});

test('saving a note: a sibling without a blank number is an extra card, never "cundefined"', () => {
  const plan = planNoteSave([sib(1), { id: 'odd', noteId: 'N', noteText: T }], '{{c1::x}}');
  assert.deepEqual(plan.remove.map(c => c.id), ['odd']);
  assert.equal(removalText(plan), 'an extra card without a blank number removed: its card and review history go too.');
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

test('healing: a later suspend with the old text does not undo a real note edit', () => {
  const newText = 'The {{c1::mitochondria}} makes {{c2::ATP}} for the {{c3::cell}} and {{c4::more}}';
  const edited = n => ({ id: 'k' + n, deckId: 'd', noteId: 'N', cloze: n, ...clozeCard(newText, n), noteText: newText, noteEditedAt: 100, updatedAt: 100 });
  // Device A edited the note (and added c4). Device B suspended c2 later, still with the old text.
  const c2 = sib(2, { suspended: true, updatedAt: 200 });
  const fixed = healNotes([edited(1), c2, edited(3), edited(4)]);
  assert.deepEqual(fixed.map(c => c.id), ['k2']);
  assert.equal(fixed[0].noteText, newText);
  assert.equal(fixed[0].suspended, true);                 // the suspend stays
  assert.equal(fixed[0].noteEditedAt, 100);               // the edit's own time, not "now"
  // Healed cards agree, so healing again (on either device) changes nothing: no ping-pong.
  assert.equal(healNotes([edited(1), fixed[0], edited(3), edited(4)]).length, 0);
});

test('healing: equal edit times are settled by card id; cards without an edit time only compete with each other', () => {
  const tA = 'x {{c1::a}}', tB = 'x {{c1::b}} {{c2::c}}';
  const a = sib(1, { ...clozeCard(tA, 1), noteEditedAt: 5, noteText: tA }), b = sib(2, { ...clozeCard(tB, 2), noteEditedAt: 5, noteText: tB });
  const one = healNotes([a, b]), two = healNotes([b, a]);
  assert.deepEqual(one, two);                             // the order of the cards doesn't matter
  assert.equal(one[0].noteText, tB);                      // k2 beats k1
  const legacy = sib(3, { updatedAt: 999, noteText: 'old {{c3::z}}' });
  assert.equal(healNotes([a, legacy]).length, 0);         // legacy's blank isn't in the winner: left alone, and it can't win
});

test('healing: an empty noteExtra and a missing one are the same', () => {
  assert.equal(healNotes([sib(1), sib(2, { noteExtra: '' })]).length, 0);
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

test('link tool: answers or hints holding :: or braces would break the note text, so the group is skipped', () => {
  const cards = [old('a', 'Print with […] in C++', 'std::cout'), old('b', 'Print with std::cout in [language]', 'C++')];
  assert.equal(planLinks(cards).notes.length, 0);
  assert.equal(planLinks([old('a', 'Use […] to open', '{{'), old('b', 'Use {{ to [do what]', 'open')]).notes.length, 0);
  assert.equal(planLinks([old('a', 'Use […] to open', 'x'), old('b', 'Use x to [a::b]', 'open')]).notes.length, 0);   // a hint with ::
  assert.equal(planLinks([old('a', 'A […] b', 'x'), old('b', 'A x [c]', 'b')]).notes.length, 1);                     // still links normally
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

test('maths inside a blank is drawn in the answer', () => {
  const html = renderCloze('The area is {{c1::$\\pi r^2$}} here', 1, 'back');
  assert.match(html, /<mark class="cloze-ans"><span class="tex" data-tex="\\pi r\^2">\$\\pi r\^2\$<\/span><\/mark>/);
  assert.match(renderCloze('Solve $x^2$ for {{c1::x}}', 1, 'front'), /<span class="tex" data-tex="x\^2">.*<span class="cloze-blank"><span class="sr-only">blank <\/span><span aria-hidden="true">\[…\]<\/span>/);
});

// ---------- v4.2.2: maths inside blanks (docs/design/katex-review.md, should-fix 3) ----------
import { clozeFull, hasCloze } from '../js/cloze.js';

test('a }} inside a formula does not end the blank', () => {
  const t = 'Find {{c1::$\\sqrt{x^{2}}$}} and {{c2::$\\frac{a}{b}$::hint}}';
  assert.deepEqual(clozeNumbers(t), [1, 2]);
  assert.deepEqual(clozeCard(t, 1), { front: 'Find […] and $\\frac{a}{b}$', back: '$\\sqrt{x^{2}}$' });
  assert.deepEqual(clozeCard(t, 2), { front: 'Find $\\sqrt{x^{2}}$ and [hint]', back: '$\\frac{a}{b}$' });
  assert.equal(clozeFull(t), 'Find $\\sqrt{x^{2}}$ and $\\frac{a}{b}$');
  const html = renderCloze(t, 1, 'back');
  assert.ok(html.includes('<mark class="cloze-ans"><span class="tex" data-tex="\\sqrt{x^{2}}">$\\sqrt{x^{2}}$</span></mark>'), html);
  assert.ok(renderCloze(t, 1, 'front').includes('<span class="cloze-blank"><span class="sr-only">blank </span><span aria-hidden="true">[…]</span></span>'));
  assert.ok(renderCloze(t, 2, 'all').split('<mark class="cloze-ans">').length === 3);
  assert.equal(planNoteSave([], t).add.length, 2);
  assert.equal(planNoteSave([], 'x {{c1::$a$}}').error, undefined);
});

test('a blank that starts inside a formula is not a blank (it shows as typed); prices and private characters are fine', () => {
  assert.deepEqual(clozeNumbers('$x + {{c1::y}}$'), []);
  assert.equal(hasCloze('{{c1::$5}} and $10'), true);
  assert.equal(clozeCard('{{c1::ab}} $x$', 1).back, 'ab');
});

test("healing: the note's other fields (noteFields) follow the newest sibling too", () => {
  const fields = [{ name: 'First Aid', text: 'p. 41' }];
  const cards = [sib(1), sib(2, { updatedAt: 99, noteFields: fields }), sib(3, { noteFields: [] })];
  const fixed = healNotes(cards);
  assert.deepEqual(fixed.map(c => c.id), ['k1', 'k3']);
  assert.ok(fixed.every(c => JSON.stringify(c.noteFields) === JSON.stringify(fields)));
  // the newest sibling has none: the others lose theirs
  const gone = healNotes([sib(1, { noteFields: fields }), sib(2, { updatedAt: 99 }), sib(3, { noteFields: fields })]);
  assert.deepEqual(gone.map(c => c.id), ['k1', 'k3']);
  assert.ok(gone.every(c => !('noteFields' in c)));
  assert.equal(healNotes([sib(1, { noteFields: [] }), sib(2)]).length, 0, 'none and an empty list agree');
});
