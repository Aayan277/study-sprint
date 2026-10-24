// Hostile text must not hang the page: card text can come from an imported file or a synced card, and js/format.js reads it on the
// main thread. Each pattern gets 50 KB (more where the old code was only slightly slow) built to make a careless regex reread the text from every start (that took seconds before).
// Also checks the answers a faster scanner must not change (a "<" inside an attribute, "]" inside [sound:…]). Run with: node tests/format-speed.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fast, rep, size } from './speed-helper.mjs';
import { formatHTML, plainText, answerText, hasFormatting, htmlToMarks, toggleBullets } from '../js/format.js';


// bold, italic and bold-italic marks (formatHTML, plainText / answerText, hasFormatting)
fast('** never closed (formatHTML)', () => formatHTML(rep('**a ')));
fast('** never closed (plainText)', () => plainText(rep('**a ')));
fast('** never closed (answerText)', () => answerText(rep('**a ')));
fast('** never closed (hasFormatting)', () => hasFormatting(rep('**a ')));
fast('*** never closed', () => formatHTML(rep('***a ')));
fast('* never closed', () => formatHTML(rep('*a ')) + plainText(rep(' *a')));
fast('** that only closes after a space', () => formatHTML(rep('**a **')));
fast('bullet line with a stray line break', () => formatHTML(`- ${' '.repeat(size(25000))}${'a'.repeat(size(25000))}\ra`));
fast('blank lines (hasFormatting)', () => hasFormatting('\n'.repeat(size(50000))));
fast('blank lines in a bullet toggle', () => toggleBullets(`${' '.repeat(size(50000))}x`, 0, size(50000)));

// htmlToMarks: tags
fast('<ruby never closed', () => htmlToMarks(rep('<ruby')));
fast('<ruby> never closed', () => htmlToMarks(rep('<ruby>', 150000)));
fast('<ruby> opened a lot, closed once', () => htmlToMarks(`${rep('<ruby>', 40000)}</ruby>`));
fast('<script and <style never closed', () => htmlToMarks(rep('<script') + rep('<style>')));
fast('<style> opened a lot, one ">" at the very end', () => htmlToMarks(`${rep('<style')}>`));
fast('<b> never closed', () => htmlToMarks(rep('<b>x', 150000)));
fast('<strong> never closed', () => htmlToMarks(rep('<strong>x', 150000)));
fast('<i> and <em> never closed', () => htmlToMarks(rep('<i>x') + rep('<em>x')));
fast('<b> with a long run of spaces', () => htmlToMarks(`<b>a${' '.repeat(size(50000))}b</b>`));
fast('<p, <div and <ul with no ">"', () => htmlToMarks(rep('<p') + rep('<div') + rep('<ul')));
fast('<li with no ">"', () => htmlToMarks(rep('<li')));
fast('"<" with no ">" (any tag)', () => htmlToMarks(rep('<a')));
fast('"<" with one ">" at the very end', () => htmlToMarks(`${rep('<a')}>`));
fast('[sound: never closed', () => htmlToMarks(rep('[sound:', 150000)));
fast('[sound: with one "]" at the very end', () => htmlToMarks(`${rep('[sound:')}]`));
fast('marks=false on the same text', () => htmlToMarks(rep('<b>x') + rep('<li') + rep('[sound:'), { marks: false }));

// What the faster scanners must still give (the same as the regexes they replaced)
test('a "<" inside an attribute does not end the tag early', () => {
  assert.equal(htmlToMarks('<img alt="a<b" src="x.png">hi'), 'hi');
  assert.equal(htmlToMarks('<span title="1 < 2">t</span> end'), 't end');
  assert.equal(htmlToMarks('<b title="a<b">bold</b>'), '**bold**');
  assert.equal(htmlToMarks('<p title="1 < 2">para</p>'), 'para');
});
test('[sound:…] ends at the first "]"', () => {
  assert.equal(htmlToMarks('[sound:a[1].mp3]'), '.mp3]');
  assert.equal(htmlToMarks('a [sound:x.mp3] b [sound:y.mp3]c'), 'a b c');
  assert.equal(htmlToMarks('[sound:open and no end'), '[sound:open and no end');
});
test('tags that never close or never end are left alone', () => {
  assert.equal(htmlToMarks('<b>half'), 'half');
  assert.equal(htmlToMarks('a <b and more'), 'a <b and more');
  assert.equal(htmlToMarks('1 < 2 > 0 <> x'), '1 0 <> x');          // ("< 2 >" is read as a tag, as it always was)
  assert.equal(htmlToMarks('<style>.a{}</style>x<SCRIPT>1</Script>y'), 'xy');
  assert.equal(htmlToMarks('<style>never closed</b>'), 'never closed');
  assert.equal(htmlToMarks('<link rel=x>a<br>b'), '- a\nb');          // ("<li" has no word edge, so <link> is a bullet too)
});
test('the first closing tag ends a bold or italic span', () => {
  assert.equal(htmlToMarks('<b>a<b>b</b>c</b>'), '**ab**c');
  assert.equal(htmlToMarks('<B> a </STRONG><strong> b </strong>'), 'a **b**');
  assert.equal(htmlToMarks('<i> x </i>and<em>y</em>'), '*x* and*y*');
  assert.equal(htmlToMarks('<br>x<bold>y</bold>'), 'xy');
});
test('marks that hug words, with the old answers', () => {
  assert.equal(formatHTML('**a** and ***b*** and *c*'), '<b>a</b> and <b><i>b</i></b> and <i>c</i>');
  assert.equal(formatHTML('** a ** and **b **'), '** a ** and **b **');
  assert.equal(formatHTML('**a\nb**'), '**a<br>b**');
  assert.equal(formatHTML('**a**b**'), '<b>a</b>b**');
  assert.equal(plainText('**a** ***b*** *c* - x'), 'a b c - x');
  assert.equal(hasFormatting('x\n  - y'), true);
  assert.equal(hasFormatting('x - y'), false);
  assert.equal(hasFormatting('-x'), false);
  assert.equal(hasFormatting('**a**'), true);
});
