// Rules for the "Own" memory model in the app. They run on every `npm test`; the git checks skip when git is missing.
// 1. A model file (or any dataset) is never committed. 2. Own's code never touches the network. 3. The dataset is never named in
// app code or tests. 4. Own's storage stays out of the main database, sync, export and backup, and only the wipe path reaches it from outside.
// 5. The service worker never caches a model. 6. A reset of this device removes the Own database. 7. The word for the other model family never appears.
// Each rule is a small function over text, and the self-test at the bottom feeds every one a planted bad input to prove it catches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SYNCED_SETTINGS, isSyncedSetting } from '../js/sync-data.js';
import { writeOwnFile, parseOwnFile } from '../js/own-file.js';
import { initParams } from '../js/own-model.js';

const root = new URL('..', import.meta.url);
let tracked = null;
try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { /* no git */ }
const exists = f => fs.existsSync(new URL(f, root));
const readText = f => fs.readFileSync(new URL(f, root), 'utf8');
const walkFiles = (dir) => !exists(dir) ? [] : fs.readdirSync(new URL(dir, root), { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? (d.name === 'node_modules' ? [] : walkFiles(`${dir}${d.name}/`)) : [`${dir}${d.name}`]);
const diskFiles = list => list.filter(exists);

// ---------- the rules, each as a function that returns a list of problems (empty = fine) ----------
const NET_WORDS = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', "importScripts('http", 'importScripts("http'];
const DATASET_WORDS = ['anki-revlogs', '10k', 'open-spaced-repetition'];
const OWN_DB = 'study-sprint-own';

// files: { name: text }
const networkProblems = files => Object.entries(files).flatMap(([f, src]) => NET_WORDS.filter(w => src.includes(w)).map(w => `${f} contains ${w}`));
const datasetProblems = files => Object.entries(files).flatMap(([f, src]) => DATASET_WORDS.filter(w => src.includes(w)).map(w => `${f} names ${w}`));
// Own's code is every js/own-*.js file, its Settings section and its Today note
const ownFilesOf = names => names.filter(f => /^js\/(own-[^/]*|settings-own|today-own)\.js$/.test(f));
// Any way of reaching Own's code from a file that must not know of it: an import (static or dynamic) of './own-...', './settings-own' or
// './today-own', or the words own-db / own-load. `allow` lists, per file, the few files it may import, and only dynamically (import('...')).
const OWN_SPEC = /(import\s*\(\s*|\bfrom\s+|\bimport\s+|\brequire\s*\(\s*)['"](\.\/(?:own-|settings-own|today-own)[^'"]*)['"]/g;
const ownReachProblems = (files, allow = {}) => Object.entries(files).flatMap(([f, src]) => {
  const out = [...src.matchAll(OWN_SPEC)].filter(m => !(/^import\s*\(/.test(m[1]) && (allow[f] || []).includes(m[2]))).map(m => `${f} imports ${m[2]}${/^import\s*\(/.test(m[1]) ? ' (not an allowed one)' : ' (statically)'}`);
  if (/\bown-(?:db|load)\b/.test(src.replace(OWN_SPEC, ''))) out.push(`${f} names own-db or own-load`);
  return out;
});
// settings.js may reach Own in exactly two ways, both loaded only when needed: import('./own-gate.js') (the wipe) and import('./settings-own.js') (its section).
const SETTINGS_ALLOW = { 'js/settings.js': ['./own-gate.js', './settings-own.js'] };
const settingsOwnProblems = src => ownReachProblems({ 'js/settings.js': src }, SETTINGS_ALLOW);
// sync.js may ask the gate (and only the gate) whether Own's memory needs a rebuild after a review arrives
const SYNC_ALLOW = { 'js/sync.js': ['./own-gate.js'] };
// the one place that clears this device's data: it must remove the Own database right after the main one; nothing else may call resetAll
const wipeProblems = (settingsSrc, others) => {
  const m = settingsSrc.match(/async function wipeThisDevice\(\) \{([\s\S]*?)\n\}/);
  if (!m) return ['wipeThisDevice not found in settings.js'];
  const body = m[1], out = [];
  const a = body.indexOf('db.resetAll('), b = body.indexOf('.wipeOwn(');
  if (a < 0) out.push('wipeThisDevice does not clear the main database');
  if (b < 0 || b < a) out.push('wipeThisDevice does not remove the Own database after the main one');
  if (b >= 0 && !/import\(\s*['"]\.\/own-gate\.js['"]\s*\)/.test(body)) out.push('wipeThisDevice does not reach Own through its gate');
  for (const [f, src] of Object.entries(others)) if (/\bresetAll\s*\(/.test(src)) out.push(`${f} calls resetAll outside the wipe`);
  return out;
};
const WORD = 'rw' + 'kv';          // (spelled in two pieces so this file does not hold it)
const wordProblems = files => Object.entries(files).filter(([, src]) => src.toLowerCase().includes(WORD)).map(([f]) => `${f} holds the word`);
const ownDbProblems = files => Object.entries(files).filter(([, src]) => src.includes(OWN_DB)).map(([f]) => `${f} mentions ${OWN_DB}`);
const badTrackedNames = names => names.filter(f => /\.(own|npz|parquet)$/i.test(f)).map(f => `${f} is tracked`);
const syncedKeyProblems = (keys, isSynced) => [
  ...keys.filter(k => /own/i.test(k)).map(k => `SYNCED_SETTINGS has ${k}`),
  ...['own', 'ownModel', 'own-model', 'ownSettings', 'ownState'].filter(k => isSynced(k)).map(k => `${k} counts as a synced setting`)
];
const swCoreProblems = sw => {
  const m = sw.match(/const CORE = \[([\s\S]*?)\];/);
  if (!m) return ['CORE list not found in sw.js'];
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]).filter(p => /\.own(\?|$)/i.test(p)).map(p => `CORE caches ${p}`);
};
// a model marker followed by anything but plain text means a real model file is inside
const markerProblems = (name, buf) => {
  const needle = Buffer.from('OWNMODEL1'), out = [];
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) {
    for (const b of buf.subarray(at + needle.length, at + needle.length + 12)) {
      if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))) { out.push(`${name} has binary data after the model marker`); break; }
    }
  }
  return out;
};
// a model file kept in the repo (tests only) must say it was trained on simulated data alone
const trainedOnProblems = (name, bytes) => {
  try {
    const ids = parseOwnFile(bytes).header.trainedOn.map(t => t.id);
    return ids.length === 1 && ids[0] === 'sim-v1' ? [] : [`${name} trainedOn is ${JSON.stringify(ids)}, not ["sim-v1"]`];
  } catch (e) { return [`${name} does not parse: ${e.message}`]; }
};

// RESEARCH BRANCH ONLY (claude/own-model, never merged to main). These allowances do not exist on main:
// the training/replay tests name the dataset they read, and the older lab (its files, tests and the few hooks it has in app files) holds the other family's word.
const RESEARCH_DATASET_OK = ['tests/own-eval.test.js', 'tests/own-sources.test.js', 'tests/own-train.test.js'];
const RESEARCH_WORD_FILES = ['js/app-config.js', 'js/app.js', 'js/help.js', 'js/own-params.js', 'js/settings.js', 'js/supa.js', 'js/sync.js', 'tests/app-config.test.js', 'tests/auth-errors.test.js', 'tests/media-sweep.test.js', 'tests/sync.test.js',
  'tests/own-eval.test.js', 'tests/own-replay.test.js', 'tests/own-sim.test.js', 'tests/own-sources.test.js', 'tests/own-train.test.js'];
const RESEARCH_WORD_OK = f => RESEARCH_WORD_FILES.includes(f) || new RegExp('(^|/)((e2e-)?' + WORD + '-[^/]*|' + WORD + ')(/|$)').test(f);
const ownJs = () => ownFilesOf(walkFiles('js/'));
const texts = list => Object.fromEntries(list.map(f => [f, readText(f)]));

// ---------- the checks on the real repository ----------
test('Own code makes no network requests (every own-*.js file, its Settings section and its Today note)', () => {
  assert.ok(ownJs().length >= 6, 'expected the Own runtime files');
  assert.ok(ownJs().includes('js/settings-own.js') && ownJs().includes('js/today-own.js') && ownJs().includes('js/own-core.js'), 'expected the Settings section and the Today note');
  assert.deepEqual(networkProblems(texts(ownJs())), []);
});

test('no dataset name appears in js/ or tests/ (except this file and tests/realdata/, the existing scorer for real review logs)', () => {
  const me = 'tests/own-guardrails.test.js';
  const list = [...walkFiles('js/'), ...walkFiles('tests/')].filter(f => f !== me && !RESEARCH_DATASET_OK.includes(f) && !f.startsWith('tests/realdata/') && !/\.(png|jpe?g|webp|ico|woff2?|zst|gz|db|sqlite)$/i.test(f) && !f.startsWith('tests/browser/out/'));
  const files = {};
  for (const f of list) { try { files[f] = readText(f); } catch { /* unreadable: skip */ } }
  assert.deepEqual(datasetProblems(files), []);
});

test('no model file, dataset or converted data is tracked', t => {
  if (!tracked) return t.skip('git is not available');
  assert.deepEqual(badTrackedNames(tracked), []);
});

test('no tracked file holds a model file (the magic text may be mentioned, but not followed by binary data)', t => {
  if (!tracked) return t.skip('git is not available');
  for (const f of diskFiles(tracked)) assert.deepEqual(markerProblems(f, fs.readFileSync(new URL(f, root))), []);
});

test('any model file kept in the repo says it was trained on simulated data only', t => {
  if (!tracked) return t.skip('git is not available');
  for (const f of diskFiles(tracked).filter(f => /\.own$/i.test(f))) assert.deepEqual(trainedOnProblems(f, fs.readFileSync(new URL(f, root))), []);
});

test('the main database keeps its shape (version 3)', () => {
  assert.match(readText('js/db.js'), /^const DB_VERSION = 3;/m);
});

test('Own has no place in the synced settings', () => {
  assert.deepEqual(syncedKeyProblems(SYNCED_SETTINGS, isSyncedSetting), []);
});

test('export, sync, backup and the main database never mention the Own database', () => {
  const names = walkFiles('js/').filter(f => /^js\/(export|sync[^/]*|backup[^/]*|db|import[^/]*|doc-import)\.js$/.test(f));
  assert.ok(names.includes('js/export.js') && names.includes('js/sync.js') && names.includes('js/backup-nudge.js') && names.includes('js/db.js'), 'expected the real export, sync, backup and db files');
  assert.deepEqual(ownDbProblems(texts(names)), []);
});

test('export, sync, backup, import and the main database import nothing from Own', () => {
  const names = walkFiles('js/').filter(f => /^js\/(export[^/]*|sync[^/]*|backup[^/]*|db|import[^/]*|doc-import|anki[^/]*)\.js$/.test(f));
  assert.ok(names.length >= 6, 'expected the real files');
  assert.ok(names.includes('js/sync.js') && names.includes('js/export.js') && names.includes('js/db.js'));
  assert.deepEqual(ownReachProblems(texts(names), SYNC_ALLOW), []);
});

test('settings.js reaches Own only through import() of its gate (the wipe) and of its Settings section', () => {
  const src = readText('js/settings.js');
  assert.deepEqual(settingsOwnProblems(src), []);
  assert.match(src, /import\(\s*['"]\.\/own-gate\.js['"]\s*\)/);
});

test('"Reset all data" and "Just this device" (wipeThisDevice) remove the Own database; no other code resets the main database', () => {
  const others = texts(walkFiles('js/').filter(f => f !== 'js/db.js' && f !== 'js/settings.js'));
  assert.deepEqual(wipeProblems(readText('js/settings.js'), others), []);
  // every caller of resetAll in settings.js sits inside wipeThisDevice
  const src = readText('js/settings.js');
  assert.equal((src.match(/\bresetAll\s*\(/g) || []).length, 1);
});

test('the word for the other model family is nowhere in js/ or tests/', () => {
  const list = [...walkFiles('js/'), ...walkFiles('tests/')].filter(f => !RESEARCH_WORD_OK(f) && !f.startsWith('tests/browser/out/') && !/\.(png|jpe?g|webp|ico|woff2?|zst|gz|db|sqlite|own|mp3|ogg|wav|bin)$/i.test(f));
  const files = {};
  for (const f of list) { try { files[f] = readText(f); } catch { /* unreadable: skip */ } }
  assert.ok(Object.keys(files).length > 50);
  assert.deepEqual(wordProblems(files), []);
});

test('the service worker caches no model file', () => {
  assert.deepEqual(swCoreProblems(readText('sw.js')), []);
});

test('git ignores model files, datasets and converted data', () => {
  const ignore = readText('.gitignore').split('\n').map(s => s.trim());
  for (const line of ['*.own', '*.parquet']) assert.ok(ignore.includes(line), line);
});

// ---------- self-test: every rule catches a planted bad input (in memory only, nothing touches the disk) ----------
test('self-test: each rule flags a planted bad input and passes a clean one', () => {
  // network
  for (const w of NET_WORDS) assert.equal(networkProblems({ 'js/own-x.js': `x ${w} y` }).length, 1, w);
  assert.deepEqual(networkProblems({ 'js/own-x.js': 'const a = 1;' }), []);
  // dataset names
  for (const w of DATASET_WORDS) assert.equal(datasetProblems({ 'tests/x.js': `// ${w}` }).length, 1, w);
  assert.deepEqual(datasetProblems({ 'tests/x.js': 'nothing here' }), []);
  // the Own database name
  assert.equal(ownDbProblems({ 'js/export.js': `indexedDB.open('${OWN_DB}')` }).length, 1);
  assert.deepEqual(ownDbProblems({ 'js/export.js': 'indexedDB.open("study-sprint")' }), []);
  // reaching into Own
  assert.equal(ownReachProblems({ 'js/export.js': "import { x } from './own-load.js';" }).length, 1);
  assert.equal(ownReachProblems({ 'js/sync.js': "import('./own-gate.js')" }, SYNC_ALLOW).length, 0);
  assert.equal(ownReachProblems({ 'js/sync.js': "import('./own-gate.js')" }).length, 1);
  assert.equal(ownReachProblems({ 'js/sync.js': "import { g } from './own-gate.js'" }, SYNC_ALLOW).length, 1);
  assert.equal(ownReachProblems({ 'js/sync.js': "import('./own-load.js')" }, SYNC_ALLOW).length, 1);
  assert.equal(ownReachProblems({ 'js/sync.js': "await import('./own-shadow.js')" }).length, 1);
  assert.equal(ownReachProblems({ 'js/backup.js': "import('./settings-own.js')" }).length, 1);
  assert.equal(ownReachProblems({ 'js/db.js': 'const a = own-db;' }).length, 1);
  assert.deepEqual(ownReachProblems({ 'js/export.js': "import { x } from './owner.js'; // own words" }), []);
  // settings.js: only dynamic imports of two files
  assert.deepEqual(settingsOwnProblems("const g = await import('./own-gate.js'); import('./settings-own.js');"), []);
  assert.equal(settingsOwnProblems("import { wipeOwn } from './own-gate.js';").length, 1);
  assert.equal(settingsOwnProblems("await import('./own-db.js')").length, 1);
  assert.equal(settingsOwnProblems("await import('./own-load.js')").length, 1);
  assert.deepEqual(settingsOwnProblems("import { a } from './owner-name.js'"), []);
  // the wipe
  const good = "async function wipeThisDevice() {\n  await db.resetAll();\n  await (await import('./own-gate.js')).wipeOwn();\n}\n";
  assert.deepEqual(wipeProblems(good, {}), []);
  assert.equal(wipeProblems(good.replace('.wipeOwn()', '.nothing()'), {}).length, 1);
  assert.equal(wipeProblems("async function wipeThisDevice() {\n  await (await import('./own-gate.js')).wipeOwn();\n  await db.resetAll();\n}\n", {}).length, 1);
  assert.equal(wipeProblems(good, { 'js/x.js': 'await db.resetAll()' }).length, 1);
  assert.equal(wipeProblems('nothing here', {}).length, 1);
  // the word
  assert.equal(wordProblems({ 'js/a.js': 'x ' + WORD.toUpperCase() }).length, 1);
  assert.deepEqual(wordProblems({ 'js/a.js': 'nothing' }), []);
  // tracked names
  assert.equal(badTrackedNames(['a.js', 'models/a6.own', 'x/y.NPZ', 'z.parquet']).length, 3);
  assert.deepEqual(badTrackedNames(['a.js', 'owner.md', 'own.json']), []);
  // synced settings
  assert.equal(syncedKeyProblems(['fuzz', 'ownModel'], k => false).length, 1);
  assert.equal(syncedKeyProblems(['fuzz'], k => k === 'own').length, 1);
  assert.deepEqual(syncedKeyProblems(['fuzz', 'newPerDay'], () => false), []);
  // service worker
  assert.equal(swCoreProblems("const CORE = [ 'js/a.js', 'models/a6.own' ];").length, 1);
  assert.deepEqual(swCoreProblems("const CORE = [ 'js/own-model.js', 'js/own-file.js' ];"), []);
  assert.equal(swCoreProblems('no list').length, 1);
  // model marker followed by binary vs. plain text
  assert.equal(markerProblems('a', Buffer.concat([Buffer.from('xx OWNMODEL1'), Buffer.from([0, 1, 2, 200, 9, 9, 9, 9, 9, 9, 9, 9])])).length, 1);
  assert.deepEqual(markerProblems('a', Buffer.from('the magic text OWNMODEL1 is mentioned in prose here')), []);
  // trainedOn: a real file written in memory, once clean and once not
  const params = Float32Array.from(initParams('s', 3));
  const mk = trainedOn => writeOwnFile({ size: 's', params, trainedOn, seed: 3 });
  assert.deepEqual(trainedOnProblems('ok.own', mk([{ id: 'sim-v1', licence: 'ours' }])), []);
  assert.equal(trainedOnProblems('bad.own', mk([{ id: 'real-data', licence: 'x' }])).length, 1);
  assert.equal(trainedOnProblems('bad2.own', mk([{ id: 'sim-v1', licence: 'ours' }, { id: 'other', licence: 'x' }])).length, 1);
  assert.equal(trainedOnProblems('junk.own', new Uint8Array([1, 2, 3])).length, 1);
});
