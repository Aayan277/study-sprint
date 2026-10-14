// Tests for js/answer-diff.js (which letters of a typed answer were wrong). Run with: node tests/answer-diff.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffAnswer, diffHTML, diffAgainstBack, hasMarks } from '../js/answer-diff.js';

const marked = (segs, kind) => segs.filter(s => s.kind === kind).map(s => s.text);
const clean = d => d && !d.tooDifferent && d.counts.wrong + d.counts.extra + d.counts.missing === 0;

test('identical answers have no marks', () => {
  const d = diffAnswer('mitochondria', 'mitochondria');
  assert.ok(clean(d));
  assert.equal(hasMarks(d), false);
});

test('a missing letter: mitocondria vs mitochondria', () => {
  const d = diffAnswer('mitocondria', 'mitochondria');
  assert.deepEqual(d.counts, { wrong: 0, extra: 0, missing: 1 });
  assert.deepEqual(marked(d.answer, 'missing'), ['h']);
  assert.equal(d.typed.filter(s => s.kind === 'missing').length, 1);     // the caret
  assert.equal(d.typed.map(s => s.text).join(''), 'mitocondria');
  assert.equal(d.answer.map(s => s.text).join(''), 'mitochondria');
});

test('swapped letters are two wrong letters: recieve vs receive', () => {
  const d = diffAnswer('recieve', 'receive');
  assert.deepEqual(d.counts, { wrong: 2, extra: 0, missing: 0 });
  assert.deepEqual(marked(d.typed, 'wrong'), ['ie']);
  assert.deepEqual(marked(d.answer, 'wrong'), ['ei']);
});

test('an extra letter', () => {
  const d = diffAnswer('ribosomee', 'ribosome');
  assert.deepEqual(d.counts, { wrong: 0, extra: 1, missing: 0 });
  assert.deepEqual(marked(d.typed, 'extra'), ['e']);
});

test('case, accents, punctuation, spaces and a leading article are never marked', () => {
  for (const [t, a] of [['MITOCHONDRIA', 'mitochondria'], ['cafe', 'café'], ['café', 'cafe'], ['self esteem', 'self-esteem'],
    ['self-esteem', 'self esteem'], ['mitochondria', 'The mitochondria'], ['the mitochondria', 'mitochondria'], ['an apple!', 'Apple']]) {
    const d = diffAnswer(t, a);
    assert.ok(clean(d), `${t} / ${a}`);
    assert.equal(d.typed.map(s => s.text).join(''), t);
    assert.equal(d.answer.map(s => s.text).join(''), a);
  }
  const d = diffAnswer('the mitochondria', 'mitochondria');
  assert.equal(d.typed[0].kind, 'ignored');
});

test('a single-letter article is only ignored when more follows', () => {
  assert.deepEqual(diffAnswer('a', 'b').counts, { wrong: 1, extra: 0, missing: 0 });
  assert.ok(clean(diffAnswer('a cat', 'cat')));
});

test('alternates: the nearest allowed answer is the target', () => {
  const d = diffAgainstBack('scarlett', 'red / scarlet');
  assert.equal(d.expected, 'scarlet');
  assert.deepEqual(d.counts, { wrong: 0, extra: 1, missing: 0 });
  assert.ok(clean(diffAgainstBack('scarlet', 'scarlet (dark red)')));
  assert.equal(diffAgainstBack('crimsin', 'red; crimson').expected, 'crimson');
});

test('kana, emoji and astral characters are not split', () => {
  const k = diffAnswer('ひとう', 'ひとつ');
  assert.deepEqual(k.counts, { wrong: 1, extra: 0, missing: 0 });
  assert.deepEqual(marked(k.typed, 'wrong'), ['う']);
  const e = diffAnswer('cat 😀', 'cat 😀');
  assert.ok(clean(e));
  const astral = diffAnswer('𝒜bc', '𝒜bd');
  assert.deepEqual(marked(astral.typed, 'wrong'), ['c']);
  assert.ok(astral.typed.every(s => !s.text.includes('�')));
  const emoji = diffAnswer('😀 cat', 'cot');
  assert.equal(emoji.typed.map(s => s.text).join(''), '😀 cat');
});

test('an empty answer has no diff', () => {
  assert.equal(diffAnswer('', 'abc'), null);
  assert.equal(diffAnswer('   ', 'abc'), null);
  assert.equal(diffHTML(null), '');
});

test('answers that are too different show the plain texts', () => {
  const d = diffAnswer('xyzzy', 'mitochondria');
  assert.equal(d.tooDifferent, true);
  assert.deepEqual(d.typed, [{ kind: 'ok', text: 'xyzzy' }]);
  const html = diffHTML(d);
  assert.ok(!/<(mark|ins|del)/.test(html));
  assert.ok(!html.includes('adiff-sum'));
  assert.ok(html.includes('xyzzy') && html.includes('mitochondria'));
});

test('over 300 characters is too different without working it out', () => {
  const long = 'a'.repeat(301);
  assert.equal(diffAnswer(long, 'a').tooDifferent, true);
  assert.equal(diffAnswer('a', long).tooDifferent, true);
});

test('text is escaped', () => {
  const html = diffHTML(diffAnswer('<img src=x onerror=alert(1)>', '"><script>x</script>'));
  assert.ok(!/<img|<script/.test(html));
  assert.ok(html.includes('&lt;img'));
  const small = diffHTML(diffAnswer('catz<', 'cat&'));
  assert.ok(small.includes('&amp;') && !small.includes('cat&<'));
});

test('plurals read well', () => {
  assert.ok(diffHTML(diffAnswer('cxt', 'cat0')).includes('1 letter wrong'));
  assert.ok(diffHTML(diffAnswer('recieve', 'receive')).includes('2 letters wrong'));
});

test('diffHTML marks and describes the differences', () => {
  const html = diffHTML(diffAnswer('mitocondria', 'mitochondria'));
  assert.ok(html.includes('<ins class="d-miss">h</ins>'));
  assert.ok(html.includes('<i class="d-caret">‸</i>'));
  assert.ok(html.includes('<p class="adiff-sum" aria-hidden="true">1 missing</p>'));
  assert.match(html, /<span class="sr-only">[^<]*missing[^<]*<\/span>/);
  assert.equal((html.match(/aria-hidden="true"/g) || []).length, 3);
  const mix = diffHTML(diffAnswer('mitocondrix', 'mitochondria'));
  assert.ok(mix.includes('1 letter wrong · 1 missing'));
  assert.ok(diffHTML(diffAnswer('scarlett', 'scarlet')).includes('<del class="d-extra">'));
  assert.ok(diffHTML(diffAnswer('recieve', 'receive'), { small: true }).startsWith('<div class="adiff small'));
});
