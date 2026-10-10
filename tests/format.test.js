// Tests for js/format.js (bold, italics and lists on cards). Run with: node tests/format.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHTML, plainText, hasFormatting, htmlToMarks, toggleWrap, toggleBullets } from '../js/format.js';

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
