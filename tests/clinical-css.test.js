// css/clinical.css must never change the Original style: every selector in it has to name data-ui="clinical".
// (Today's .goal line is hidden by css/styles.css, so Original does not need this file for anything.)
// Run with: node --test tests/clinical-css.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../css/clinical.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Splits "a, b:is(c, d)" at the commas that are not inside brackets.
const splitSelectors = text => {
  const out = []; let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
// Every style rule with its selector list, looking inside @media and @supports blocks.
function rules(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1, j = open + 1, quote = '';
    for (; j < text.length && depth; j++) {      // find the matching close brace (braces inside quotes, like data: URLs, do not count)
      const c = text[j];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    const body = text.slice(open + 1, j - 1);
    if (/^@(media|supports|layer)/.test(head)) found.push(...rules(body));
    else if (head.startsWith('@')) found.push({ at: head });
    else found.push({ selectors: splitSelectors(head) });
    i = j;
  }
  return found;
}

const all = rules(css);

test('the stylesheet was read (a parser that finds nothing would pass everything)', () => {
  assert.ok(all.filter(r => r.selectors).length > 300, 'rules found: ' + all.length);
});

test('every selector is scoped to data-ui="clinical"', () => {
  const loose = all.filter(r => r.selectors).flatMap(r => r.selectors).filter(sel => !/\[data-ui="clinical"\]/.test(sel));
  assert.deepEqual(loose, [], 'selectors that would also hit Original:\n' + loose.join('\n'));
});

test('no at-rules that act outside the scope (keyframes, font-face, imports)', () => {
  assert.deepEqual(all.filter(r => r.at).map(r => r.at), []);
});

test('no gradient is written in it (patterns are SVG pictures) and no text-shadow is set', () => {
  assert.ok(!/gradient\(/.test(css), 'a gradient is written in clinical.css');
  assert.ok(!/text-shadow\s*:\s*[^n;]/.test(css), 'a text-shadow is set');
});
