// Hostile text must not hang the page: a blank that is never closed made the old regex in js/cloze.js reread the rest of the text
// from every position (3 KB of "{{c1::a " took 150 ms, 50 KB never finished), and card text can come from an imported file or a synced card.
// Also checks that the scanner that replaced the regex gives what the regex gave. Run with: node tests/cloze-speed.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clozeBlanks, clozeNumbers, clozeCard, clozeFull, renderCloze, hasCloze, parseCloze, planNoteSave, withClozeLines, planLinks, makesText } from '../js/cloze.js';
import { parseText } from '../js/import.js';

const LIMIT = 300;       // ms; the regex took seconds to minutes on the first four of these
const fast = (name, fn) => test(`fast on hostile text: ${name}`, () => {
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  assert.ok(ms < LIMIT, `${name} took ${ms.toFixed(0)} ms`);
});
const rep = (s, bytes = 50000) => s.repeat(Math.ceil(bytes / s.length));
// every function that reads blanks
const all = s => { clozeNumbers(s); clozeCard(s, 1); clozeFull(s); renderCloze(s, 1, 'front'); renderCloze(s, 1, 'all'); hasCloze(s); makesText(s); };

fast('{{c1:: never closed', () => all(rep('{{c1::a ')));
fast('{{c1:: never closed, 150 KB', () => all(rep('{{c1::a ', 150000)));
fast('{{c1::a::hint never closed', () => all(rep('{{c1::a::b ')));
fast('{{c1:: and a lot of ::', () => all('{{c1::' + rep('::')));
fast('{{c1:: and a lot of :::', () => all('{{c1::' + rep(':::', 150000)));
fast('blanks opened a lot, closed once at the very end', () => all(rep('{{c1::a ') + '}}'));
fast('blanks opened a lot, one hint, closed at the end', () => all(rep('{{c1::a ') + '::h}}'));
fast('many whole blanks without a hint', () => all(rep('{{c1::a}} ', 150000)));
fast('many whole blanks with a hint', () => all(rep('{{c1::a::b}} ', 150000)));
fast('many whole blanks, the only :: is far at the end', () => all(rep('{{c1::a}} ') + '::'));
fast('{{c with no digits or no ::', () => all(rep('{{c ') + rep('{{c1 ') + rep('{{cx::')));
fast('{{c and a huge number', () => all('{{c' + '1'.repeat(50000) + ' {{c' + '1'.repeat(50000) + '::a}}'));
fast('{{{{{{ and }}}}}}', () => all(rep('{{') + rep('}}')));
fast('blanks inside formulas that never close', () => all(rep('$a {{c1::b ')));
fast('planNoteSave on an unclosed text', () => planNoteSave([], rep('{{c1::a ')));
fast('parseCloze on many lines', () => parseCloze(rep('{{c1::a}} and {{c2::b::h}}\n', 150000)));
fast('parseCloze on one long unclosed line', () => parseCloze(rep('{{c1::a ')));
fast('withClozeLines on an unclosed text', () => withClozeLines(rep('{{c1::a '), parseText));
fast('planLinks with long fronts', () => planLinks([{ id: 'a', front: rep('[x] '), back: 'b' }, { id: 'b', front: rep('[x] '), back: 'b' }]));
fast('many [ with no ]', () => planLinks([{ id: 'a', front: rep('[a'), back: 'b' }]));

// What the scanner must still give: the same as the regex it replaced. Each row was made by running the OLD module
// (git show origin/main:js/cloze.js): the text, the matches [index, lastIndex, number, text, hint (null: none)], then
// clozeNumbers, clozeFull, clozeCard(text, 1) and renderCloze(text, 1, 'back').
const OLD_ANSWERS = [
  ["{{c1::a::b}}",[[0,12,"1","a","b"]],[1],"a",{"front":"[b]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::a}}::b}}",[[0,9,"1","a",null]],[1],"a::b}}",{"front":"[…]::b}}","back":"a"},"<mark class=\"cloze-ans\">a</mark>::b}}"],
  ["{{c1::a:::b}}",[[0,13,"1","a",":b"]],[1],"a",{"front":"[:b]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::a::}}",[[0,11,"1","a",""]],[1],"a",{"front":"[…]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::::}}",[[0,10,"1","",""]],[1],"",{"front":"[…]","back":""},"<mark class=\"cloze-ans\"></mark>"],
  ["{{c1:::}}",[[0,9,"1",":",null]],[1],":",{"front":"[…]","back":":"},"<mark class=\"cloze-ans\">:</mark>"],
  ["{{c1::a::b::c}}",[[0,15,"1","a","b::c"]],[1],"a",{"front":"[b::c]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::a}}}",[[0,9,"1","a",null]],[1],"a}",{"front":"[…]}","back":"a"},"<mark class=\"cloze-ans\">a</mark>}"],
  ["{{c1::a}} {{c2::b::h}}",[[0,9,"1","a",null],[10,22,"2","b","h"]],[1,2],"a b",{"front":"[…] b","back":"a"},"<mark class=\"cloze-ans\">a</mark> b"],
  ["{{c1::a\nb::h\ni}}",[[0,16,"1","a\nb","h\ni"]],[1],"a\nb",{"front":"[h\ni]","back":"a\nb"},"<mark class=\"cloze-ans\">a<br>b</mark>"],
  ["{{c1::a\r\nb}}",[[0,12,"1","a\r\nb",null]],[1],"a\r\nb",{"front":"[…]","back":"a\r\nb"},"<mark class=\"cloze-ans\">a<br>b</mark>"],
  ["{{c1::a {{c2::b}}",[[0,17,"1","a {{c2","b"]],[1],"a {{c2",{"front":"[b]","back":"a {{c2"},"<mark class=\"cloze-ans\">a {{c2</mark>"],
  ["{{c1::a {{c2::b}} c}}",[[0,17,"1","a {{c2","b"]],[1],"a {{c2 c}}",{"front":"[b] c}}","back":"a {{c2"},"<mark class=\"cloze-ans\">a {{c2</mark> c}}"],
  ["{{c1::a::b {{c2::c}}",[[0,20,"1","a","b {{c2::c"]],[1],"a",{"front":"[b {{c2::c]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::a::b {{c2::c::d}}",[[0,23,"1","a","b {{c2::c::d"]],[1],"a",{"front":"[b {{c2::c::d]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::a",[],[],"{{c1::a",{"front":"{{c1::a","back":""},"{{c1::a"],
  ["{{c1::a::b",[],[],"{{c1::a::b",{"front":"{{c1::a::b","back":""},"{{c1::a::b"],
  ["{{c10::x}}{{c2::y}}{{c1::z}}",[[0,10,"10","x",null],[10,19,"2","y",null],[19,28,"1","z",null]],[1,2,10],"xyz",{"front":"xy[…]","back":"z"},"xy<mark class=\"cloze-ans\">z</mark>"],
  ["{{c::x}}{{cx::y}}{{c1:x}}{{c1::ok}}",[[25,35,"1","ok",null]],[1],"{{c::x}}{{cx::y}}{{c1:x}}ok",{"front":"{{c::x}}{{cx::y}}{{c1:x}}[…]","back":"ok"},"{{c::x}}{{cx::y}}{{c1:x}}<mark class=\"cloze-ans\">ok</mark>"],
  ["{{c01::a}}",[[0,10,"01","a",null]],[1],"a",{"front":"[…]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::a::b}}::c}} {{c2::d}}",[[0,12,"1","a","b"],[18,27,"2","d",null]],[1,2],"a::c}} d",{"front":"[b]::c}} d","back":"a"},"<mark class=\"cloze-ans\">a</mark>::c}} d"],
  ["x}} {{c1::a}}",[[4,13,"1","a",null]],[1],"x}} a",{"front":"x}} […]","back":"a"},"x}} <mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::{c2::a}}",[[0,14,"1","{c2","a"]],[1],"{c2",{"front":"[a]","back":"{c2"},"<mark class=\"cloze-ans\">{c2</mark>"],
  ["{{{c1::a}}}",[[1,10,"1","a",null]],[1],"{a}",{"front":"{[…]}","back":"a"},"{<mark class=\"cloze-ans\">a</mark>}"],
  ["{{c1::a:b}}",[[0,11,"1","a:b",null]],[1],"a:b",{"front":"[…]","back":"a:b"},"<mark class=\"cloze-ans\">a:b</mark>"],
  ["{{c1::a::b}c}}",[[0,14,"1","a","b}c"]],[1],"a",{"front":"[b}c]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
  ["{{c1::a}::b}}",[[0,13,"1","a}","b"]],[1],"a}",{"front":"[b]","back":"a}"},"<mark class=\"cloze-ans\">a}</mark>"],
  ["{{c1::$x^{2}$}}",[[0,15,"1","$x^{2}$",null]],[1],"$x^{2}$",{"front":"[…]","back":"$x^{2}$"},"<mark class=\"cloze-ans\"><span class=\"tex\" data-tex=\"x^{2}\">$x^{2}$</span></mark>"],
  ["{{c1::a::$y^{2}$}}",[[0,18,"1","a","$y^{2}$"]],[1],"a",{"front":"[$y^{2}$]","back":"a"},"<mark class=\"cloze-ans\">a</mark>"],
];
for (const [text, matches, numbers, full, card, back] of OLD_ANSWERS) {
  test(`same answers as the old regex: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(clozeBlanks(text).map(b => [b.index, b.end, b.num, b.text, b.hint ?? null]), matches);
    assert.deepEqual(clozeBlanks(text).map(b => b.hint === undefined), matches.map(m => m[4] === null));     // (no hint is undefined, an empty hint is '')
    assert.deepEqual(clozeNumbers(text), numbers);
    assert.equal(clozeFull(text), full);
    assert.deepEqual(clozeCard(text, 1), card);
    assert.equal(renderCloze(text, 1, 'back'), back);
  });
}
