// The RWKV lab branch must never carry the model's weights, any dataset, or any output of the model, and must never talk to the network or sync.
// These checks run on every `npm test`. They need git; without it they skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LAB_BUILD } from '../js/rwkv-flag.js';
import { SYNCED_SETTINGS } from '../js/sync-data.js';

const root = new URL('..', import.meta.url);
let tracked = null;
try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { /* no git */ }
const read = f => fs.readFileSync(new URL(f, root));

test('no weights, checkpoints or datasets are tracked', t => {
  if (!tracked) return t.skip('git is not available');
  assert.deepEqual(tracked.filter(f => /\.(bin|pth|npz)$/i.test(f)), []);
  assert.deepEqual(tracked.filter(f => /(^|\/)(weights.*\.json|architecture\.json|manifest\.json)$/i.test(f)), []);
  assert.deepEqual(tracked.filter(f => /(^|\/)rwkv-lab-private\//.test(f)), []);
});

test('fixtures under tests/fixtures/rwkv are small', t => {
  if (!tracked) return t.skip('git is not available');
  for (const f of tracked.filter(f => f.startsWith('tests/fixtures/rwkv/'))) assert.ok(read(f).length <= 150 * 1024, f + ' is over 150 KB');
});

test('no tracked file holds a weights file (the magic text may be mentioned, but not followed by binary data)', t => {
  if (!tracked) return t.skip('git is not available');
  const needle = Buffer.from('ARWKVWEIGHTS');
  for (const f of tracked) {
    if (!fs.existsSync(new URL(f, root))) continue;
    const buf = read(f);
    for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) {
      for (const b of buf.subarray(at + needle.length, at + needle.length + 12)) {
        assert.ok(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127), `${f} has binary data after the weights marker`);
      }
    }
  }
});

test('the fixture holds our inputs only, never an output of the model', () => {
  const forbidden = new Set(['heads', 'pCurve', 'pImm', 'pRating', 'pAt', 'pActual', 'weightsSha256', 'curveTimes', 'stateBits', 'updates', 'queries']);
  const seen = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) { if (v.length < 400) v.forEach((x, i) => walk(x, path + '[]')); else walk(v[0], path + '[]'); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (forbidden.has(k)) seen.push(path + '.' + k); walk(x, path + '.' + k); }
  };
  walk(JSON.parse(read('tests/fixtures/rwkv/golden.json').toString('utf8')), '$');
  assert.deepEqual(seen, []);
});

test('lab code makes no network requests', () => {
  const files = fs.readdirSync(new URL('js/', root)).filter(f => /^rwkv-.*\.js$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = fs.readFileSync(new URL('js/' + f, root), 'utf8');
    for (const bad of ['fetch(', 'XMLHttpRequest', 'importScripts(', 'http', 'WebSocket', 'sendBeacon', 'EventSource']) assert.ok(!src.includes(bad), `${f} contains ${bad}`);
  }
});

test('no lab setting is synced or backed up with the main settings', () => {
  for (const k of SYNCED_SETTINGS) assert.ok(!/rwkv|lab|shadow/i.test(k), k);
});

test('the main database keeps its shape', () => {
  assert.match(fs.readFileSync(new URL('js/db.js', root), 'utf8'), /const DB_VERSION = 3;/);
});

test('this is the lab build, and sync refuses to start in it', async () => {
  assert.equal(LAB_BUILD, true);
  const src = fs.readFileSync(new URL('js/sync.js', root), 'utf8');
  assert.match(src, /export async function signIn\([^)]*\) \{ if \(LAB_BUILD\) throw new Error\('Sync is off in the lab build\.'\)/);
  assert.match(src, /export async function createAccount\([^)]*\) \{\n  if \(LAB_BUILD\) throw new Error\('Sync is off in the lab build\.'\)/);
  assert.match(src, /async function signedIn\([^)]*\) \{\n  if \(LAB_BUILD\) throw new Error\('Sync is off in the lab build\.'\)/);   // every route that would save an account
  assert.match(src, /export function startAutoSync\(\) \{\n  if \(LAB_BUILD/);
  assert.match(fs.readFileSync(new URL('js/app.js', root), 'utf8'), /const startSync = \(\) => LAB_BUILD \?/);
});

test('git ignores weights, checkpoints, datasets and the private folder', () => {
  const ignore = fs.readFileSync(new URL('.gitignore', root), 'utf8').split('\n').map(s => s.trim());
  for (const line of ['*.bin', '*.pth', '*.npz', 'rwkv-lab-private/', 'weights*.json']) assert.ok(ignore.includes(line), line);
});
