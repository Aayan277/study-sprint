// Tests for js/format.js (bold, italics and lists on cards). Run with: node tests/format.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHTML, plainText, hasFormatting, htmlToMarks, toggleWrap, toggleBullets, mathHTML, answerText } from '../js/format.js';

test('showing formatted text', () => {
  assert.equal(formatHTML('The **mitochondria** is *the* powerhouse'), 'The <b>mitochondria</b> is <i>the</i> powerhouse');
  assert.equal(formatHTML('Line one\nLine two'), 'Line one<br>Line two');
  assert.equal(formatHTML('Parts:\n- nucleus\n- **ribosome**\nThe end'), 'Parts:<ul><li>nucleus</li><li><b>ribosome</b></li></ul>The end');
  assert.equal(formatHTML('• dot bullets work too'), '<ul><li>dot bullets work too</li></ul>');
  assert.equal(formatHTML('5 * 3 * 2 = 30'), '5 * 3 * 2 = 30');                 // spaced stars aren't marks
  assert.equal(formatHTML('2*x*3'), '2*x*3');                                     // nor stars inside a word
  assert.equal(formatHTML('-5 degrees'), '-5 degrees');                           // not a bullet (no space)
  assert.equal(formatHTML('<script>"hi" & bye</script>'), '&lt;script&gt;&quot;hi&quot; &amp; bye&lt;/script&gt;');
  assert.equal(formatHTML('**a** and *b* and ***c***'), '<b>a</b> and <i>b</i> and <b><i>c</i></b>');
});

test('plain text for typed answers and Play', () => {
  assert.equal(plainText('**Classical** *conditioning*'), 'Classical conditioning');
  assert.equal(plainText('- one\n- two'), '• one\n• two');
  assert.equal(plainText('5 * 3 * 2'), '5 * 3 * 2');
  assert.equal(hasFormatting('a **b**'), true);
  assert.equal(hasFormatting('5 * 3 * 2'), false);
  assert.equal(hasFormatting('x\n- y'), true);
});

test('HTML (Anki fields, the computer editor) back to marks', () => {
  assert.equal(htmlToMarks('Learning by <b>association</b>&nbsp;(Pavlov)'), 'Learning by **association** (Pavlov)');
  assert.equal(htmlToMarks('<b>bold </b>then <i> italic</i>'), '**bold** then *italic*');
  assert.equal(htmlToMarks('<div>one</div><div><strong>two</strong></div>'), 'one\n**two**');
  assert.equal(htmlToMarks('Parts<ul><li>a</li><li>b</li></ul>'), 'Parts\n- a\n- b');
  assert.equal(htmlToMarks('<span style="color:red">red</span> <b></b>x'), 'red x');
  assert.equal(htmlToMarks('a<br>b <img src="x.png">'), 'a\nb');
  assert.equal(htmlToMarks('<b>bold</b> <ul><li>a</li></ul>', { marks: false }), 'bold\n• a');
  // round trip: marks → HTML → marks
  const text = 'The **cell** has:\n- a *nucleus*\n- ribosomes';
  assert.equal(htmlToMarks(formatHTML(text)), text);
});

test('the B and I buttons', () => {
  assert.deepEqual(toggleWrap('make this bold', 5, 9, '**'), { value: 'make **this** bold', start: 7, end: 11 });
  assert.deepEqual(toggleWrap('make **this** bold', 7, 11, '**'), { value: 'make this bold', start: 5, end: 9 });     // again: off
  assert.deepEqual(toggleWrap('make **this** bold', 5, 13, '**'), { value: 'make this bold', start: 5, end: 9 });    // marks selected too
  assert.deepEqual(toggleWrap('one word', 5, 5, '*'), { value: 'one *word*', start: 5, end: 9 });                 // cursor in a word
  assert.deepEqual(toggleWrap('a  b', 2, 2, '*'), { value: 'a ** b', start: 3, end: 3 });                       // empty: marks to type between
  assert.deepEqual(toggleWrap('pick these ', 5, 11, '*'), { value: 'pick *these* ', start: 6, end: 11 });          // spaces stay outside
});

test('the • button', () => {
  assert.deepEqual(toggleBullets('one\ntwo\nthree', 0, 7), { value: '- one\n- two\nthree', start: 0, end: 11 });
  assert.deepEqual(toggleBullets('- one\n- two', 0, 11), { value: 'one\ntwo', start: 0, end: 7 });
  assert.equal(toggleBullets('intro\nitem', 8, 8).value, 'intro\n- item');                                          // just the cursor's line
});

// ---------- maths (js/math.js) ----------
test('maths: formulas become spans for KaTeX, in the three modes', () => {
  assert.equal(formatHTML('What is $x^2$?'), 'What is <span class="tex" data-tex="x^2">$x^2$</span>?');
  assert.equal(formatHTML('$$E=mc^2$$'), '<span class="tex tex-d" data-tex="E=mc^2">$$E=mc^2$$</span>');
  assert.equal(formatHTML('a $x<y$ b', { math: 'raw' }), 'a $x&lt;y$ b');
  assert.equal(formatHTML('a $x<y$ b', { math: 'anki' }), 'a \\(x&lt;y\\) b');
  assert.equal(formatHTML('$$x\ny$$', { math: 'anki' }), '\\[x y\\]');
  assert.equal(formatHTML('a $x$', { math: 'raw' }).includes('<span'), false);
});

test('maths: bold and italics around a formula, and stars inside one', () => {
  assert.equal(formatHTML('**$x$**'), '<b><span class="tex" data-tex="x">$x$</span></b>');
  assert.equal(formatHTML('*$x$* and **b**'), '<i><span class="tex" data-tex="x">$x$</span></i> and <b>b</b>');
  assert.equal(formatHTML('$a*b*c$'), '<span class="tex" data-tex="a*b*c">$a*b*c$</span>');       // not read as italics
  assert.equal(formatHTML('$a**b**c$ **d**'), '<span class="tex" data-tex="a**b**c">$a**b**c$</span> <b>d</b>');
  assert.equal(formatHTML('- $x$\n- y'), '<ul><li><span class="tex" data-tex="x">$x$</span></li><li>y</li></ul>');
});

test('maths: prices and escaped dollars are plain text', () => {
  assert.equal(formatHTML('$5 and $10'), '$5 and $10');
  assert.equal(formatHTML('\\$x\\$'), '$x$');
  assert.equal(formatHTML('It is \\$5'), 'It is $5');
});

test('maths: tags in a formula cannot get out, and stray placeholders are dropped', () => {
  const html = formatHTML('$"><img src=x onerror=alert(1)>$');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('data-tex="&quot;&gt;&lt;img'));
  assert.equal(formatHTML('ab'), 'ab');
});

test('maths: plainText and hasFormatting leave formulas alone', () => {
  assert.equal(plainText('**bold** $a*b*c$'), 'bold $a*b*c$');
  assert.equal(plainText('- $x$'), '• $x$');
  assert.equal(plainText('\\$5'), '\\$5');
  assert.equal(hasFormatting('$a*b*c$'), false);
  assert.equal(hasFormatting('$a*b*c$ and *i*'), true);
});

test('maths: answerText is what to type', () => {
  assert.equal(answerText('$x^2$'), 'x^2');
  assert.equal(answerText('**$\\frac{a}{b}$**'), 'a/b');
  assert.equal(answerText('about \\$5 or $\\alpha$'), 'about $5 or alpha');
  assert.equal(answerText('- one\n- $\\sqrt{x}$'), '• one\n• sqrt(x)');
  assert.equal(answerText('plain *text*'), 'plain text');
});

test('maths: mathHTML escapes and draws formulas only', () => {
  assert.equal(mathHTML('**a** < $x$'), '**a** &lt; <span class="tex" data-tex="x">$x$</span>');
  assert.equal(mathHTML('$$x$$', { inline: true }), '<span class="tex" data-tex="x">$$x$$</span>');
  assert.equal(mathHTML('\\$5'), '$5');
});
