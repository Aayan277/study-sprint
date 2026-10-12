// index.html lists the files the app needs to start (<link rel="modulepreload">), so the browser fetches them all
// at once. This checks that list matches what js/app.js really imports, and that the service worker saves them.
// Run with: node tests/preload.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Every file app.js loads straight away (static imports, and what those import).
function bootFiles() {
  const seen = new Set();
  const walk = f => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of read(f).matchAll(/^import[^;]*?from\s+'(\.\/[^']+)'/gm)) walk('js/' + m[1].slice(2));
  };
  walk('js/app.js');
  return [...seen].sort();
}

test('index.html preloads exactly the modules app.js needs to start', () => {
  const listed = [...read('index.html').matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]).sort();
  assert.deepEqual(listed, bootFiles());
});

test('the service worker saves every preloaded file, and every file in js/', () => {
  const core = read('sw.js').match(/const CORE = \[([\s\S]*?)\];/)[1];
  const saved = new Set([...core.matchAll(/'([^']+)'/g)].map(m => m[1]));
  for (const f of bootFiles()) assert.ok(saved.has(f), f + ' is not in CORE in sw.js');
  for (const f of fs.readdirSync(path.join(ROOT, 'js'))) assert.ok(saved.has('js/' + f), 'js/' + f + ' is not in CORE in sw.js');
});
