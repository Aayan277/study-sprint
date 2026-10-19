// The app's font is served from fonts/ (privacy: Google Fonts would see every visitor's address). Run with: node tests/fonts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const css = read('css/styles.css'), sw = read('sw.js');

test('every @font-face file exists, is a woff2, and is saved by the service worker', () => {
  const files = [...css.matchAll(/@font-face\{[^}]*url\(\.\.\/(fonts\/[^)]+)\)/g)].map(m => m[1]);
  assert.ok(files.length >= 5);
  for (const f of files) {
    assert.equal(fs.readFileSync(new URL('../' + f, import.meta.url)).subarray(0, 4).toString(), 'wOF2', f);
    assert.ok(sw.includes(`'${f}'`), f + ' is not in CORE in sw.js');
  }
  assert.ok(read('index.html').includes('href="fonts/geist-latin.woff2"'));
});

test('the licence travels with the fonts', () => {
  const ofl = read('fonts/OFL.txt');
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(ofl, /Geist Project Authors/);
});

test('nothing refers to Google Fonts any more', () => {
  for (const f of ['index.html', 'css/styles.css', 'css/clinical.css', 'sw.js']) {
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(read(f).replace(/\/\/.*$/gm, '')), f);
  }
});
