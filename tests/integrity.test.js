// The import map in index.html gives every CDN module the app imports a SHA-384 fingerprint, so the browser refuses a
// swapped file. This checks the map is complete and placed before anything that loads a module. (That Chromium really
// refuses a tampered file is tests/browser/e2e-integrity.mjs.) Run with: node tests/integrity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KATEX_BASE, KATEX_JS_INTEGRITY } from '../js/math.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
const files = fs.readdirSync(new URL('../js/', import.meta.url));
const source = files.map(f => fs.readFileSync(new URL('../js/' + f, import.meta.url), 'utf8')).join('\n');

test('the import map comes before every module script and preload', () => {
  const at = html.indexOf('<script type="importmap">');
  assert.ok(at > 0);
  assert.ok(at < html.indexOf('<link rel="modulepreload"'));
  assert.ok(at < html.indexOf('<script type="module"'));
});

test('every module the app imports from a CDN has a fingerprint, and every fingerprint is used', () => {
  const urls = new Set();
  for (const m of source.matchAll(/https:\/\/cdn\.(?:jsdelivr\.net|sheetjs\.com)\/[^'"`\s)]+\.m?js(?=['"`])/g)) urls.add(m[0]);
  urls.add(KATEX_BASE + 'katex.mjs');                       // built from KATEX_BASE
  urls.delete('https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.js');
  for (const u of urls) assert.match(map.integrity[u] ?? '', /^sha384-[A-Za-z0-9+/]{64}$/, 'no fingerprint for ' + u);
  for (const u of Object.keys(map.integrity)) assert.ok(urls.has(u), u + ' has a fingerprint but nothing imports it');
});

test('the KaTeX fingerprint is the one the maths code and the review name', () => {
  assert.equal(map.integrity[KATEX_BASE + 'katex.mjs'], KATEX_JS_INTEGRITY);
  assert.equal(KATEX_JS_INTEGRITY, 'sha384-7P2cqEHJR2IlPITv70b7D/BOl8yOGOe/LHzf5acWjXiVJl0HVGb0aGUG8Jc8FA+2');
});
