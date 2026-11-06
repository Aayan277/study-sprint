// Rules for the "Own" memory model. They run on every `npm test`; the git checks skip when git is missing.
// 1. Model code never touches the network. 2. The real review dataset is named only in the two files that read it (and in docs).
// 3. Nothing derived from that dataset is ever tracked. 4. Shipped parameters come from synthetic data only and stay small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { insideRepo, REPO } from './realdata/lib.mjs';

const root = new URL('..', import.meta.url);
let tracked = null;
try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { /* no git */ }
const exists = f => fs.existsSync(new URL(f, root));
const readText = f => fs.readFileSync(new URL(f, root), 'utf8');
const walkFiles = (dir) => !exists(dir) ? [] : fs.readdirSync(new URL(dir, root), { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? (d.name === 'node_modules' ? [] : walkFiles(`${dir}${d.name}/`)) : [`${dir}${d.name}`]);

const ownJs = () => walkFiles('js/').filter(f => /^js\/(own|lab)-[^/]*\.js$/.test(f));
const ownTools = () => walkFiles('tools/own-model/').filter(f => !/\/(out|\.cache)\//.test(f));
const modelFiles = () => [...ownJs(), ...ownTools()];
const DATA_READERS = ['tools/own-model/sources/anki10k.mjs', 'tools/own-model/data/convert.py'];

test('model code makes no network requests', () => {
  for (const f of modelFiles()) {
    const src = readText(f);
    for (const bad of ['fetch(', 'XMLHttpRequest', 'importScripts(', 'http', 'WebSocket', 'sendBeacon', 'EventSource']) assert.ok(!src.includes(bad), `${f} contains ${bad}`);
  }
});

test('the real dataset is named only in the two readers and in docs', () => {
  for (const f of modelFiles()) {
    if (DATA_READERS.includes(f)) continue;
    const src = readText(f).replaceAll('fsrs-data.js', '');     // the app's own module js/fsrs-data.js is fine to import
    for (const bad of ['fsrs-data', 'anki-revlogs', '.parquet', 'revlog', 'FSRS_DATA']) assert.ok(!src.includes(bad), `${f} mentions ${bad}`);
  }
  // nothing the browser loads may name the dataset or its files, whatever the file is called
  for (const f of walkFiles('js/')) {
    const src = readText(f).replaceAll('fsrs-data.js', '');
    for (const bad of ['anki-revlogs', 'FSRS_DATA', '.parquet', '~/fsrs-data', '/fsrs-data/']) assert.ok(!src.includes(bad), `${f} mentions ${bad}`);
  }
});

test('no dataset, converted data, model file or run output is tracked', t => {
  if (!tracked) return t.skip('git is not available');
  assert.deepEqual(tracked.filter(f => /\.(parquet|npz|own)$/i.test(f)), []);
  assert.deepEqual(tracked.filter(f => /^tools\/own-model\/(out|\.cache)\//.test(f)), []);
  for (const f of tracked.filter(f => f.startsWith('tools/own-model/') && exists(f))) {
    assert.ok(fs.statSync(new URL(f, root)).size <= 200 * 1024, f + ' is over 200 KB');
  }
});

test('no tracked file holds a model file (the magic text may be mentioned, but not followed by binary data)', t => {
  if (!tracked) return t.skip('git is not available');
  const needle = Buffer.from('OWNMODEL1');
  for (const f of tracked) {
    if (!exists(f)) continue;
    const buf = fs.readFileSync(new URL(f, root));
    for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) {
      for (const b of buf.subarray(at + needle.length, at + needle.length + 12)) {
        assert.ok(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127), `${f} has binary data after the model marker`);
      }
    }
  }
});

test('shipped parameters are synthetic only and within budget', async t => {
  if (!exists('js/own-params.js')) return t.skip('js/own-params.js does not exist yet');
  assert.ok(fs.statSync(new URL('js/own-params.js', root)).size <= 128 * 1024, 'js/own-params.js is over 128 KB');
  const { OWN_PARAMS } = await import('../js/own-params.js');
  assert.deepEqual(OWN_PARAMS.trainedOn, ['sim-v1']);
  assert.ok(OWN_PARAMS.paramCount <= 25000, `${OWN_PARAMS.paramCount} parameters`);
});

test('insideRepo spots paths in the repo, and real-data output folders are outside it', () => {
  assert.equal(insideRepo(REPO), true);
  assert.equal(insideRepo(path.join(REPO, 'tools', 'own-model', 'out', 'x.own')), true);
  assert.equal(insideRepo(path.join(REPO, '..', path.basename(REPO) + '-sibling', 'x')), false);
  assert.equal(insideRepo(path.join(os.homedir(), 'own-model-private', 'own-real-v1.own')), false);
  assert.equal(insideRepo(path.join(os.tmpdir(), 'x')), false);
});

test('the trainer and evaluator refuse output paths inside the repo (checked once they exist)', t => {
  const scripts = ['tools/own-model/train.mjs', 'tools/own-model/eval.mjs'].filter(exists);
  if (!scripts.length) return t.skip('no trainer yet');
  for (const f of scripts) assert.match(readText(f), /insideRepo|refuseInsideRepo/, f);
});

test('git ignores model files, caches and run output', () => {
  const ignore = readText('.gitignore').split('\n').map(s => s.trim());
  for (const line of ['*.own', 'tools/own-model/out/', 'tools/own-model/.cache/', '*.parquet', '*.npz']) assert.ok(ignore.includes(line), line);
});

test('the main database keeps its shape', () => {
  assert.match(readText('js/db.js'), /const DB_VERSION = 3;/);
});
