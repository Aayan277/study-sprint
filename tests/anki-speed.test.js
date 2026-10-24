// Hostile text must not hang the page: an imported deck can hold 50 KB of openings that never close. Times each Anki text reader on
// such text, and checks ioLabels (now a linear scan) still answers as the old regex split did. Run with: node tests/anki-speed.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fast, rep } from './speed-helper.mjs';
import { ankiMath, soundNames, imageNames, ioLabels } from '../js/anki.js';


fast('[$] never closed', () => ankiMath(rep('[$]')));
fast('[$$] never closed', () => ankiMath(rep('[$$]a ')));
fast('[sound: never closed', () => soundNames(rep('[sound:')));
fast('<img never closed', () => imageNames(rep('<img')));
fast('<div never closed (ioLabels)', () => ioLabels(rep('<div')));
fast('<div with a space (ioLabels)', () => ioLabels(rep('<div ')));
fast('</div never closed (ioLabels)', () => ioLabels(rep('</div ')));
fast('<br never closed (ioLabels)', () => ioLabels(rep('<br ')));

test('ankiMath on normal input', () => {
  assert.equal(ankiMath('a [$]x^2[/$] b [$$]y[/$$]'), 'a \\(x^2\\) b \\[y\\]');
});
test('soundNames and imageNames on normal input', () => {
  assert.deepEqual(soundNames('dog [sound:dog.mp3] x [sound:my%20s.wav]'), ['dog.mp3', 'my s.wav']);
  assert.deepEqual(imageNames(`<img src="a%20b.png"><IMG alt=x src='c.png'><img src=d.png>`), ['a b.png', 'c.png', 'd.png']);
});
test('ioLabels on normal input', () => {
  assert.deepEqual(ioLabels('1. Aorta<br>2. Vena cava<BR/>3. Atrium<div>4. Valve</div>\r\n5. Last'), ['Aorta', 'Vena cava', 'Atrium', 'Valve', 'Last']);
  assert.deepEqual(ioLabels('<div class="x">1. A</div><br />2. B\n'), ['A', 'B']);
  assert.equal(ioLabels('just text'), null);
});
test('ioLabels splits like the old regex on odd text', () => {
  const old = t => t.split(/<br\s*\/?>|<\/?div\b[^>]*>|\r?\n/i);
  const bits = ['<br>', '<br />', '<BR/', '<div', '</div>', '<div a=">">', '<divx>', '\r\n', '\r', '\n', '<', '>', ' ', 'a', '1. ', '</ div>'];
  let seed = 7;
  const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let k = 0; k < 500; k++) {
    const text = Array.from({ length: 1 + rnd(12) }, () => bits[rnd(bits.length)]).join('');
    // ioLabels reads the lines through htmlToText, so compare it with the same reading of the lines the old split gives
    assert.deepEqual(ioLabels(text), ioLabels(old(text).join('\n')), JSON.stringify(text));
  }
});
test('imageNames, soundNames and ankiMath match the old regexes on odd text', () => {
  const oldImg = t => [...t.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map(m => m[1] ?? m[2] ?? m[3]);
  const oldSnd = t => [...t.matchAll(/\[sound:([^\]]+)\]/g)].map(m => m[1]);
  const oldMath = t => t.replace(/\[\$\$\]([\s\S]+?)\[\/\$\$\]/g, (m, x) => `\\[${x}\\]`).replace(/\[\$\]([\s\S]+?)\[\/\$\]/g, (m, x) => `\\(${x}\\)`);
  const bits = ['<img', '<IMG ', ' src', 'SRC', '=', ' ', '"', "'", '>', 'a.png', 'x', '[sound:', ']', 'b.mp3', '[$]', '[/$]', '[$$]', '[/$$]', '<imgx', 'osrc'];
  let seed = 11;
  const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let k = 0; k < 2000; k++) {
    const text = Array.from({ length: 1 + rnd(14) }, () => bits[rnd(bits.length)]).join('');
    // names go through htmlToMarks afterwards, so compare how many come out, which shows any tag the scan found or missed
    assert.equal(imageNames(text).length, oldImg(text).map(n => n.trim()).filter(Boolean).length, `img ${JSON.stringify(text)}`);
    assert.equal(soundNames(text).length, oldSnd(text).map(n => n.trim()).filter(Boolean).length, `sound ${JSON.stringify(text)}`);
    assert.equal(ankiMath(text), oldMath(text), `math ${JSON.stringify(text)}`);
  }
});
