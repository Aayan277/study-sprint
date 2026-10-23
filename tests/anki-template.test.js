// Tests for js/anki-template.js (Anki card templates) and for how anki.js / import.js use them: a note type whose card shows more than
// the first two fields is drawn from its template. Run with: node tests/anki-template.test.js
// (All the decks here are made up; none of this is from a real person's deck.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCard, shownFields, htmlToLines, fieldIsEmpty } from '../js/anki-template.js';
import { notesToImport, onlyDeck, fieldReport } from '../js/anki.js';
import { buildCards, hasKeptFields, basicFieldsCut } from '../js/import.js';
import { htmlToMarks, formatHTML, plainText, answerText, answerTargets } from '../js/format.js';
import { speakableText } from '../js/speech.js';

const model = (fields, qfmt, afmt = '{{FrontSide}}<hr id=answer>{{' + fields[1] + '}}', extra = {}) =>
  ({ name: 'Test type', cloze: false, fields, templates: [{ ord: 0, qfmt, afmt }], ...extra });
const draw = (m, fields) => { const { q, a } = renderCard(m, fields); return { q: htmlToLines(q), a: htmlToLines(a) }; };

// The verb note type of the report that started this (made up again here).
const VERB_FIELDS = ['Verb', 'Meaning', 'Form', 'Pattern', 'Gloss', 'Answer', 'AnswerKana', 'Rule', 'Group'];
const VERB = model(VERB_FIELDS,
  `<div class=verb>{{Verb}}</div><div class=meaning>{{Meaning}}</div>
<div class=ask><span class=form>{{Form}}</span></div><div class=hint>{{Pattern}} · {{Gloss}}</div>`,
  `{{FrontSide}}<hr id=answer><div class=ans>{{Answer}}</div><div class=kana>{{AnswerKana}}</div>
<div class=rule>{{Rule}}</div><div class=grp>{{Group}}</div>`);
const VERB_NOTE = ['<ruby>見<rt>み</rt></ruby>る', 'to see', 'Plain negative', '~ない', "doesn't ~", '見ない', 'みない', 'る-verb: drop る, add the ending', 'る-verb'];

test('a template is drawn with the note\'s fields: the verb type gives four lines on the front and four on the back', () => {
  const { q, a } = draw(VERB, VERB_NOTE);
  assert.equal(q, "｜見《み》る\nto see\nPlain negative\n~ない · doesn't ~");
  assert.equal(a, '見ない\nみない\nる-verb: drop る, add the ending\nる-verb');          // (no front again: Review shows it above)
});

test('{{FrontSide}} is left out of the back: after <hr id=answer> when there is one, else the tag is dropped', () => {
  const m = model(['A', 'B', 'C'], '{{A}}', '{{FrontSide}}<hr id=answer>{{B}} {{C}}');
  assert.equal(draw(m, ['q', 'b', 'c']).a, 'b c');
  const noHr = model(['A', 'B', 'C'], '{{A}}', '{{FrontSide}}<br>{{B}}{{C}}');
  assert.equal(draw(noHr, ['q', 'b', 'c']).a, 'bc');
  assert.equal(draw(model(['A', 'B', 'C'], '{{A}}', '<hr id="answer"/>{{B}}'), ['q', 'b', 'c']).a, 'b');
  assert.equal(draw(model(['A', 'B', 'C'], '{{A}}', '<div>{{FrontSide}}</div><HR ID=answer>{{C}}'), ['q', 'b', 'c']).a, 'c');
});

test('{{#F}} and {{^F}} sections follow whether the field has anything in it (Anki\'s rule), also nested', () => {
  const m = model(['A', 'B', 'C'], '{{A}}{{#C}} [{{C}}]{{/C}}{{^C}} (none){{/C}}', '{{FrontSide}}{{#B}}<div>{{B}}{{#C}}+{{C}}{{/C}}</div>{{/B}}');
  assert.equal(draw(m, ['q', 'b', 'c']).q, 'q [c]');
  assert.equal(draw(m, ['q', 'b', '']).q, 'q (none)');
  assert.equal(draw(m, ['q', 'b', '<br>']).q, 'q (none)');            // only bare breaks and spaces count as empty
  assert.ok(draw(m, ['q', 'b', '&nbsp;']).q.includes('['));            // (&nbsp; is something, so the section shows)
  assert.ok(!fieldIsEmpty('&nbsp;') && !fieldIsEmpty('<img src=a.png>') && fieldIsEmpty(' <div></div><br/> '));
  assert.equal(draw(m, ['q', 'b', 'c']).a, 'b+c');
  assert.equal(draw(m, ['q', '', 'c']).a, '');
  assert.equal(draw(m, ['q', 'b', '']).a, 'b');
  // a field that doesn't exist counts as empty, and shows nothing
  const odd = model(['A', 'B'], '{{A}}{{Nope}}{{#Nope}}x{{/Nope}}{{^Nope}}y{{/Nope}}');
  assert.equal(draw(odd, ['q', 'b']).q, 'qy');
  // a closing tag with no opening one, and an unclosed section, don't break anything
  assert.equal(draw(model(['A', 'B'], '{{/A}}{{A}}{{#B}}{{B}}'), ['q', 'b']).q, 'qb');
});

test('filters: text, hint and type; unknown ones show the field as it is', () => {
  const m = model(['A', 'B', 'C'], '{{text:A}}|{{hint:B}}|{{type:C}}|{{edit:B}}|{{nc:type:C}}');
  assert.equal(draw(m, ['<b>x</b> &lt;y&gt;', '<i>h</i>', 'typed']).q, 'x <y>|*h*||*h*|');
});

test('Japanese filters: furigana, kana and kanji read the 漢字[かんじ] syntax', () => {
  const m = model(['A', 'B', 'C'], '{{furigana:A}}', '{{FrontSide}}<hr id=answer>{{kana:A}}/{{kanji:A}}/{{A}}');
  const f = ['日本語[にほんご] 勉強[べんきょう]する', 'b', 'c'];
  assert.equal(renderCard(m, f).q, '<ruby>日本語<rt>にほんご</rt></ruby><ruby>勉強<rt>べんきょう</rt></ruby>する');
  assert.equal(draw(m, f).q, '｜日本語《にほんご》｜勉強《べんきょう》する');
  assert.equal(draw(m, f).a, 'にほんごべんきょうする/日本語勉強する/日本語[にほんご] 勉強[べんきょう]する');
  // a [sound:...] is not a reading, and text with no brackets is left alone
  assert.equal(renderCard(m, ['a[sound:x.mp3]', 'b', 'c']).q, 'a[sound:x.mp3]');
  assert.equal(renderCard(m, ['plain', 'b', 'c']).q, 'plain');
  // a very long field is left alone rather than searched
  const big = '日'.repeat(150000) + '[ひ]';
  assert.equal(renderCard(m, [big, 'b', 'c']).q.length, big.length);
});

test('scripts, styles and pictures in the template or fields are not text; nothing but text comes out', () => {
  const m = model(['A', 'B'], '<style>.x{color:red}</style><script>alert(1)</script><img src="logo.png"><div onclick="evil()">{{A}}</div>');
  const { q } = draw(m, ['hi <script>alert(2)</script><style>p{}</style><a href="javascript:evil()">link</a> <img src="x.png" onerror="evil()">', 'b']);
  assert.equal(q, 'hi link');
  assert.ok(!/[<>]/.test(draw(m, ['<iframe src=x></iframe><b>ok</b>', 'b']).q.replace(/\*\*/g, '')));
  // a picture that a field brings is kept in the HTML for the importer to find, the template's own is not
  const pic = renderCard(model(['A', 'B'], '<img src="logo.png">{{A}}'), ['<img src="cat.png">', 'b']).q;
  assert.ok(pic.includes('cat.png') && !pic.includes('logo.png'));
});

test('a template that repeats a big field cannot grow without end', () => {
  const m = model(['A', 'B'], '{{A}}'.repeat(5000));
  assert.ok(renderCard(m, ['x'.repeat(100000), 'b']).q.length <= 2_100_000);
});

test('blocks and line breaks make lines, with no blank lines between blocks and bold kept', () => {
  assert.equal(htmlToLines('<div>one</div><div>two</div>three<br>four<br><br>five'), 'one\ntwo\nthree\nfour\n\nfive');
  assert.equal(htmlToLines('<div><b>Bold</b> text<br></div>\n<p>next</p>'), '**Bold** text\nnext');
  assert.equal(htmlToLines('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
});

test('which fields a template shows', () => {
  assert.deepEqual([...shownFields(VERB)].sort(), [...VERB_FIELDS].sort());
  const m = model(['Front', 'Back', 'Extra', 'Hidden', 'Switch'], '{{Front}}{{type:Back}}{{#Switch}}{{/Switch}}', '{{FrontSide}}<hr id=answer>{{Back}}{{hint:Extra}}');
  assert.deepEqual([...shownFields(m)].sort(), ['Back', 'Extra', 'Front']);          // (the type box and the section's switch are not shown)
});

// ---------- furigana in the app's text ----------
test('ruby tags become furigana marks, and a mark is drawn as ruby, and in plain text as 見(み)る', () => {
  assert.equal(htmlToMarks('<ruby>見<rt>み</rt></ruby>る'), '｜見《み》る');
  assert.equal(htmlToMarks('<ruby>見<rt>み</rt></ruby>る', { marks: false }), '見(み)る');
  assert.equal(htmlToMarks('<ruby><rb>日</rb><rp>(</rp><rt>に</rt><rp>)</rp><rb>本</rb><rt>ほん</rt></ruby>語'), '｜日《に》｜本《ほん》語');
  assert.equal(htmlToMarks('<ruby>字<rt></rt></ruby>'), '字');
  assert.equal(formatHTML('｜見《み》る'), '<ruby>見<rt>み</rt></ruby>る');
  assert.equal(plainText('｜見《み》る **x**'), '見(み)る x');
  assert.equal(answerText('｜見《み》る'), '見る');            // what to type
  assert.deepEqual(answerTargets('｜見《み》る'), ['見る', 'みる']);          // the reading is accepted too
  assert.equal(speakableText('｜見《み》る'), 'みる');            // what to say
  // ordinary text never looks like a mark
  assert.equal(formatHTML('[見](み) 見[み] {{c1::x}}'), '[見](み) 見[み] {{c1::x}}');
});

test('furigana can never bring HTML in', () => {
  assert.equal(formatHTML('｜<img src=x onerror=evil()>《<b>》'), '<ruby>&lt;img src=x onerror=evil()&gt;<rt>&lt;b&gt;</rt></ruby>');          // (escaped: only text goes in the ruby)
  assert.equal(formatHTML('｜a《"><script>》'), '<ruby>a<rt>&quot;&gt;&lt;script&gt;</rt></ruby>');
  assert.equal(htmlToMarks('<ruby>x<rt><img src=x onerror=1>《み》</rt></ruby>'), '｜x《み》');
  assert.ok(!/<(?!\/?(ruby|rt)\b)/.test(formatHTML('｜a《b》 <script>')));
});

// ---------- in the import ----------
const noteOf = (mid, fields, extra = {}) => ({ id: '1', guid: 'g1', mid, fields, tags: [], deck: 'D', cards: { 0: '10' }, ...extra });
const one = (m, fields, extra) => { const r = notesToImport([noteOf('9', fields, extra)], new Map([['9', m]])); return { r, card: buildCards(r)[0] }; };

test('import: a note of the verb type makes one card from its template, with no folded fields', () => {
  const { r, card } = one(VERB, VERB_NOTE);
  assert.deepEqual(r.templated, [true]);
  assert.deepEqual(r.rows, [["｜見《み》る\nto see\nPlain negative\n~ない · doesn't ~", '見ない\nみない\nる-verb: drop る, add the ending\nる-verb']]);
  assert.equal(card.front, r.rows[0][0]);
  assert.equal(card.back, r.rows[0][1]);
  assert.equal(card.noteFields, undefined);          // every field is on the card
  assert.equal(card.noteExtra, undefined);
  assert.equal(card.templated, true);
  assert.equal(hasKeptFields(r), false);
  assert.equal(card.ankiId, '10');
  assert.equal(card.ankiGuid, 'g1');
});

test('import: the front and back columns picked do not change a templated card (and its fields stay out of the folds)', () => {
  const { r } = one(VERB, VERB_NOTE);
  const [c] = buildCards(r, 4, 5, { keepFields: true });
  assert.equal(c.front, r.rows[0][0]);
  assert.equal(c.back, r.rows[0][1]);
  assert.equal(c.noteFields, undefined);
  assert.equal(basicFieldsCut(r, 4, 5), 0);
});

test('import: fields the template never shows stay as folded sections (but not a switch, or a Back Extra)', () => {
  const m = model(['Word', 'Meaning', 'Example', 'Notes', 'Add Reverse', 'Back Extra'], '{{Word}}{{#Add Reverse}}!{{/Add Reverse}}', '{{FrontSide}}<hr id=answer>{{Meaning}}<br>{{Example}}');
  const { r, card } = one(m, ['犬', 'dog', '犬が好き', 'my note', 'y', 'extra text']);
  assert.deepEqual(r.templated, [true]);
  assert.equal(card.front, '犬!');
  assert.equal(card.back, 'dog\n犬が好き');
  assert.deepEqual(card.noteFields, [{ name: 'Notes', text: 'my note' }]);          // Example is on the card, Add Reverse is a switch
  assert.equal(card.noteExtra, 'extra text');          // Back Extra is the open extra, as it is for other notes
  // the hidden first two fields are kept too
  const hidden = model(['A', 'B', 'C'], '{{C}}', '{{FrontSide}}<hr id=answer>{{C}}!');
  const h = one(hidden, ['a', 'b', 'c']).card;
  assert.deepEqual([h.front, h.back, h.noteFields], ['c', 'c!', [{ name: 'A', text: 'a' }, { name: 'B', text: 'b' }]]);
});

test('import: Basic note types behave exactly as before (only the first two fields shown)', () => {
  const basic = model(['Front', 'Back'], '{{Front}}');
  const r = notesToImport([noteOf('9', ['Q', 'A'])], new Map([['9', basic]]));
  assert.deepEqual(r.templated, [false]);
  assert.deepEqual(r.rows, [['Q', 'A']]);
  assert.deepEqual(r.fieldNames, [['Front', 'Back']]);
  // a type with an Extra the template does not show: a column row, the Extra a folded field
  const spare = model(['Front', 'Back', 'Source'], '{{Front}}');
  const s = notesToImport([noteOf('9', ['Q', 'A', 'book'])], new Map([['9', spare]]));
  assert.deepEqual(s.templated, [false]);
  assert.deepEqual(buildCards(s)[0].noteFields, [{ name: 'Source', text: 'book' }]);
  // Back Extra in the template (this app's own export): still the open extra, still a column row
  const extra = model(['Front', 'Back', 'Back Extra'], '{{Front}}', '{{FrontSide}}<hr id=answer>{{Back}}<br>{{Back Extra}}');
  const e = notesToImport([noteOf('9', ['Q', 'A', 'more'])], new Map([['9', extra]]));
  assert.deepEqual(e.templated, [false]);
  assert.equal(buildCards(e)[0].noteExtra, 'more');
  assert.equal(buildCards(e)[0].back, 'A');
  // reversed types keep their two cards
  const rev = { name: 'Basic (and reversed card)', cloze: false, fields: ['Front', 'Back', 'More'], templates: [{ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}{{More}}' }, { ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Front}}' }] };
  const v = notesToImport([noteOf('9', ['Q', 'A', 'm'], { cards: { 0: '1', 1: '2' } })], new Map([['9', rev]]));
  assert.deepEqual(v.templated, [false]);
  assert.deepEqual(v.reversed, [{ ankiId: '2' }]);
});

test('import: cloze notes are not templated, and a templated note type mixes with the others in one deck', () => {
  const cloze = { name: 'Cloze', cloze: true, fields: ['Text', 'Back Extra', 'Source'], templates: [{ ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}{{Source}}' }] };
  const basic = model(['Front', 'Back', 'Note'], '{{Front}}');
  const r = notesToImport([
    noteOf('9', VERB_NOTE.map(String)), noteOf('c', ['A {{c1::b}}', 'x', 'src'], { id: '2' }), noteOf('b', ['Q', 'A', 'n'], { id: '3' })
  ], new Map([['9', VERB], ['c', cloze], ['b', basic]]));
  assert.deepEqual(r.templated, [true, false, false]);
  const cards = buildCards(r, 1, 0);          // (Front = column 2, Back = column 1: swapped)
  assert.equal(cards[0].front.split('\n').length, 4);          // the templated card ignores it
  assert.equal(cards[1].front, 'A […]');          // so does the cloze card
  assert.deepEqual([cards[2].front, cards[2].back], ['A', 'Q']);          // the column card follows it
  assert.deepEqual(onlyDeck(r, 'D').templated, [true, false, false]);
});

test('import: sounds and pictures belong to the side of the card they are drawn on', () => {
  const m = model(['Word', 'Meaning', 'Audio', 'Picture', 'Example'], '{{Word}}{{Audio}}', '{{FrontSide}}<hr id=answer>{{Meaning}}{{Picture}}{{Example}}');
  const r = notesToImport([noteOf('9', ['犬', 'dog', '[sound:inu.mp3]', '<img src="inu.png">', 'x[sound:ex.mp3]'])], new Map([['9', m]]));
  assert.deepEqual(r.pictures, [{ front: null, back: 'inu.png' }]);
  assert.deepEqual([r.sounds[0].front, r.sounds[0].back], [['inu.mp3'], ['ex.mp3']]);
  const c = buildCards(r)[0];
  assert.equal(c.front, '犬');
  assert.equal(c.back, 'dogx');
});

test('import: a card whose side would come out empty falls back to columns, and very long sides are cut and counted', () => {
  const m = model(['A', 'B', 'C'], '{{C}}', '{{FrontSide}}<hr id=answer>{{C}}');
  assert.deepEqual(notesToImport([noteOf('9', ['a', 'b', ''])], new Map([['9', m]])).templated, [false]);
  const long = notesToImport([noteOf('9', ['a', 'b', 'x'.repeat(25000)])], new Map([['9', model(['A', 'B', 'C'], '{{A}}', '{{FrontSide}}<hr id=answer>{{C}}')]]));
  assert.equal(long.rows[0][1].length, 20000);
  assert.ok(long.rows[0][1].endsWith('…'));
  assert.equal(fieldReport(long).cut, 1);
});

test('import: type-in boxes keep working only when the back is the typed answer', () => {
  const typed = model(['Word', 'Meaning', 'Note'], '{{Word}} {{Note}}{{type:Meaning}}', '{{FrontSide}}<hr id=answer>{{Meaning}}');
  const t = notesToImport([noteOf('9', ['a', 'dog', 'n'])], new Map([['9', typed]]));
  assert.deepEqual([t.templated, t.typeIns], [[true], [true]]);
  const more = model(['Word', 'Meaning', 'Note'], '{{Word}}{{type:Meaning}}', '{{FrontSide}}<hr id=answer>{{Meaning}}<br>{{Note}}');
  const m = notesToImport([noteOf('9', ['a', 'dog', 'n'])], new Map([['9', more]]));
  assert.deepEqual([m.templated, m.typeIns], [[true], [false]]);
});

test('import: a note with fewer fields than its type, or no templates at all, does not crash', () => {
  assert.deepEqual(notesToImport([noteOf('9', ['a', 'b'])], new Map([['9', VERB]])).templated, [false]);
  const none = { name: 'x', cloze: false, fields: ['A', 'B', 'C'], templates: [] };
  assert.deepEqual(notesToImport([noteOf('9', ['a', 'b', 'c'])], new Map([['9', none]])).templated, [false]);
});
