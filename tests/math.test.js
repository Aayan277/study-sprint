// Tests for js/math.js (the pure parts: finding formulas, and turning them into words). Run with: node tests/math.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMath, hasMath, replaceMath, maskMath, holdMath, unholdMath, wrapMath, texToPlain, texToSpeech, KATEX_BASE } from '../js/math.js';

const maths = text => splitMath(text).filter(s => s.type === 'math').map(s => s.tex);
const plain = text => splitMath(text).filter(s => s.type === 'text').map(s => s.value).join('');

test('KaTeX is pinned to one version', () => {
  assert.equal(KATEX_BASE, 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/');
});

test('prices are not maths (Pandoc rules)', () => {
  for (const t of ['$5 and $10', '$5,000 to $6,000', 'US$5/$10', 'It costs $20.', 'Pay $5 or $ 6', '$ x$', '$x $', '$x', 'x$', '$', '$$', '$$$$', '$ $']) {
    assert.deepEqual(maths(t), [], t);
    assert.equal(hasMath(t), false, t);
  }
  assert.deepEqual(splitMath('$5 and $10'), [{ type: 'text', value: '$5 and $10' }]);
});

test('inline $...$', () => {
  assert.deepEqual(splitMath('What is $\\frac{a}{b}$?'), [
    { type: 'text', value: 'What is ' }, { type: 'math', tex: '\\frac{a}{b}', display: false, raw: '$\\frac{a}{b}$' }, { type: 'text', value: '?' }]);
  assert.deepEqual(maths('$x^2$ and $y_i$'), ['x^2', 'y_i']);
  assert.deepEqual(maths('Costs $5 but $x$ is a variable'), ['x']);       // the price is skipped, the formula after it is found
  assert.deepEqual(maths('$a$5'), []);                                     // a digit right after the closing $
  assert.deepEqual(maths('$a\nb$'), []);                                   // not across lines
  assert.deepEqual(maths(`$${'x'.repeat(1001)}$`), []);                    // at most 1000 characters
  assert.equal(maths(`$${'x'.repeat(900)}$`).length, 1);
  assert.deepEqual(maths('$f(x) = {a + {b}}$'), ['f(x) = {a + {b}}']);     // nested braces
});

test('escaped dollar signs', () => {
  assert.deepEqual(splitMath('A \\$5 note'), [{ type: 'text', value: 'A $5 note' }]);
  assert.deepEqual(maths('\\$x\\$ and $y$'), ['y']);
  assert.deepEqual(maths('$a\\$b$'), ['a\\$b']);                           // \$ inside a formula stays in it
  assert.equal(plain('\\\\$x$'), '\\\\');                                   // \\ is not an escape: the $ opens
  assert.deepEqual(maths('\\\\$x$'), ['x']);
});

test('display maths: $$...$$, \\[...\\], over several lines', () => {
  assert.deepEqual(splitMath('$$E=mc^2$$'), [{ type: 'math', tex: 'E=mc^2', display: true, raw: '$$E=mc^2$$' }]);
  assert.deepEqual(splitMath('see\n$$a\n= b$$\nok').map(s => s.type === 'math' ? [s.tex, s.display] : s.value), ['see\n', ['a\n= b', true], '\nok']);
  assert.deepEqual(splitMath('\\[x\\]').map(s => [s.tex, s.display]), [['x', true]]);
  assert.deepEqual(splitMath('\\(x\\) and \\(y\\)').map(s => s.type === 'math' ? [s.tex, s.display] : s.value), [['x', false], ' and ', ['y', false]]);
  assert.deepEqual(maths('$$ $$'), []);                                   // blank
  assert.deepEqual(maths('\\( \\)'), []);
  assert.deepEqual(maths('$$ unclosed'), []);
  assert.deepEqual(maths('\\(unclosed'), []);
});

test('text with private characters inside a formula is not maths', () => {
  assert.deepEqual(maths('$ab$'), []);
  assert.deepEqual(maths('$ab$'), []);
  assert.equal(maths('$x$').length, 1);                       // next to them is fine
});

test('no $ and no backslash: one text piece (fast path)', () => {
  assert.deepEqual(splitMath('plain text'), [{ type: 'text', value: 'plain text' }]);
  assert.deepEqual(splitMath(''), [{ type: 'text', value: '' }]);
  assert.deepEqual(splitMath(null), [{ type: 'text', value: '' }]);
});

test('replaceMath and maskMath', () => {
  assert.equal(replaceMath('a $x$ b \\$ c', s => `[${s.tex}]`), 'a [x] b $ c');
  const line = 'Energy - $E = mc^2 - 1$ - done';
  const masked = maskMath(line);
  assert.equal(masked.length, line.length);
  assert.equal(masked.indexOf(' - '), line.indexOf(' - '));              // the first separator is the real one
  assert.equal(masked.indexOf(' = '), -1);                                // none inside the formula
  assert.equal(maskMath('no maths'), 'no maths');
  assert.equal(maskMath('\\$5 - \\$6'), '\\$5 - \\$6');                   // an escaped dollar is left as it is
});

test('holdMath lifts formulas out and puts them back', () => {
  const { text, items } = holdMath('a $x*y*z$ b $$q$$');
  assert.equal(items.length, 2);
  assert.ok(!text.includes('$'));
  assert.equal(unholdMath(text, items, it => it.raw), 'a $x*y*z$ b $$q$$');
  assert.equal(unholdMath(text, items, it => it.tex), 'a x*y*z b q');
  assert.deepEqual(holdMath('nothing'), { text: 'nothing', items: [] });
});

test('wrapMath: the ∑ button on a plain box', () => {
  assert.deepEqual(wrapMath('area is x^2 here', 8, 11), { value: 'area is $x^2$ here', start: 9, end: 12 });
  assert.deepEqual(wrapMath('ab', 1, 1), { value: 'a$$b', start: 2, end: 2 });                 // nothing selected: a pair, cursor inside
  assert.deepEqual(wrapMath('a $x$ b', 3, 4), { value: 'a x b', start: 2, end: 3 });            // wrapped already: take the $ off
  assert.deepEqual(wrapMath('a $x$ b', 2, 5), { value: 'a x b', start: 2, end: 3 });            // the $ are in the selection
  assert.equal(wrapMath(' x ', 0, 3).value, ' $x$ ');                                            // spaces stay outside
});

test('texToPlain', () => {
  const table = [
    ['\\frac{a}{b}', 'a/b'], ['\\dfrac{1}{2}', '1/2'], ['\\frac{a+b}{c}', '(a+b)/c'], ['\\sqrt{x}', 'sqrt(x)'], ['\\sqrt{x+1}', 'sqrt(x+1)'],
    ['\\alpha + \\beta', 'alpha + beta'], ['\\Delta x', 'Delta x'], ['a \\cdot b', 'a b'], ['2 \\times 3', '2 3'],
    ['\\text{speed} = d/t', 'speed = d/t'], ['\\mathrm{kg}', 'kg'], ['x^{10}', 'x^10'], ['x^2', 'x^2'], ['E = mc^2', 'E = mc^2'],
    ['\\left( x \\right)', '( x )'], ['\\unknown{x}y', 'xy'], ['{a}{b}', 'ab'], ['a \\\\ b', 'a b'], ['\\pi r^2', 'pi r^2'],
    ['\\sqrt[3]{8}', 'root3(8)'], ['a \\leq b', 'a <= b'], ['\\infty', 'infinity'], ['50\\%', '50%'], ['', '']
  ];
  for (const [tex, want] of table) assert.equal(texToPlain(tex), want, tex);
});

test('texToSpeech', () => {
  const table = [
    ['x^2', 'x squared'], ['x^3', 'x cubed'], ['x^n', 'x to the power n'], ['x^{n+1}', 'x to the power n plus 1'], ['x_i', 'x sub i'],
    ['\\frac{a}{b}', 'a over b'], ['\\sqrt{x}', 'square root of x'], ['a = b + c - d', 'a equals b plus c minus d'],
    ['\\int f(x)', 'integral f x'], ['\\sum_{i=1}^{n} i', 'sum from i equals 1 to n i'], ['\\alpha', 'alpha'], ['a \\cdot b', 'a times b'],
    ['\\text{mass}', 'mass'], ['\\pi', 'pi'], ['\\left( x \\right)', 'x']
  ];
  for (const [tex, want] of table) assert.equal(texToSpeech(tex), want, tex);
});

// ---------- v4.2.2 (docs/design/katex-review.md) ----------
import fs from 'node:fs';
import { KATEX_JS_INTEGRITY, KATEX_CSS_INTEGRITY } from '../js/math.js';

test('a formula of exactly 1000 characters is maths, 1001 is not', () => {
  assert.equal(maths('$' + 'x'.repeat(1000) + '$').length, 1);
  assert.equal(maths('$' + 'x'.repeat(1001) + '$').length, 0);
});

test('$$ is display maths wherever it stands (the header comment no longer claims an own-line rule)', () => {
  assert.deepEqual(splitMath('$$5 and $$10').map(s => s.type + ':' + (s.tex ?? s.value)), ['math:5 and', 'text:10']);
  assert.deepEqual(splitMath('see $$x$$ now').map(s => s.type), ['text', 'math', 'text']);
  assert.ok(!/own line/.test(fs.readFileSync(new URL('../js/math.js', import.meta.url), 'utf8').split('\n').slice(0, 14).join('\n')));
});

test('existing private characters get placeholders that output themselves', () => {
  const text = 'a $x$ ';
  const { text: held, items } = holdMath(text);
  assert.equal(items.length, 3);
  assert.equal(unholdMath(held, items, it => it.raw), text);
  assert.equal(unholdMath(held, items, () => 'M'), 'a M ');
  // placeholders that are not ours are still dropped
  assert.equal(unholdMath('x\ue900y', [{ raw: 'r' }], it => it.raw), 'xy');
});

test('texToSpeech: absolute value, limits of integrals and sums', () => {
  assert.equal(texToSpeech('|x|'), 'absolute value of x');
  assert.equal(texToSpeech('|x| + |y|'), 'absolute value of x plus absolute value of y');
  assert.equal(texToSpeech('\\int_0^1 f(x)'), 'integral from 0 to 1 f x');
  assert.equal(texToSpeech('\\int_{0}^{\\infty} e'), 'integral from 0 to infinity e');
  assert.equal(texToSpeech('\\sum_{k=1}^{n} k'), 'sum from k equals 1 to n k');
  assert.equal(texToSpeech('\\int f'), 'integral f');
  assert.equal(texToSpeech('\\int^2 f'), 'integral to 2 f');
});

test('texToPlain: Greek letters as names, or as letters', () => {
  assert.equal(texToPlain('2\\pi r'), '2 pi r');
  assert.equal(texToPlain('2\\pi r', { greek: true }), '2 π r');
  assert.equal(texToPlain('\\Omega + \\vartheta', { greek: true }), 'Ω + θ');
});

test('the fingerprints in math.js are the ones in index.html (import map for katex.mjs)', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  assert.equal(map.integrity[KATEX_BASE + 'katex.mjs'], KATEX_JS_INTEGRITY);
  assert.match(KATEX_CSS_INTEGRITY, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.match(KATEX_JS_INTEGRITY, /^sha384-[A-Za-z0-9+/]{64}$/);
});

test('loadKatex: no ?again retry address, integrity on the stylesheet, crossorigin anonymous', () => {
  const src = fs.readFileSync(new URL('../js/math.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('again='), 'a retry address would not match the import map');
  assert.ok(src.includes('link.integrity = KATEX_CSS_INTEGRITY') && src.includes("link.crossOrigin = 'anonymous'"));
});
