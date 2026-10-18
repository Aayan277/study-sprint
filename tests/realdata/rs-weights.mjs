// Reference fits by the official fsrs-rs optimizer (npm @open-spaced-repetition/binding), for the same train/test splits run.mjs uses.
//   FSRS_BINDING_DIR=/folder/with/node_modules node tests/realdata/rs-weights.mjs [--users 1,2,3] [--jobs 4]
// For every user and scenario (full, first1000, first5000) it trains FSRS-6 and FSRS-7 on the head of splitHistories(cards, 0.8)
// only and writes ~/fsrs-data/weights/<user>.<scenario>.json = { fsrs6: [21] | null, fsrs7: [34] | null, binding, settings }.
// run.mjs scores those weights as fsrs6_rs / fsrs7_rs. Files that exist are skipped, so it can be stopped and started again.
// The binding is not a repo dependency, see README.md.

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, cpus } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { splitHistories } from '../../js/fsrs-fit.js';
import { toHistories, truncate, refuseInsideRepo } from './lib.mjs';

const ROOT = process.env.FSRS_DATA || join(homedir(), 'fsrs-data');
const SCENARIOS = [['full', Infinity], ['first1000', 1000], ['first5000', 5000]];
const MAX_SEQ = 1024;                       // the binding's own CSV converter keeps at most this many reviews per item
const SETTINGS = { enableShortTerm: true, numRelearningSteps: 1 };   // the app uses short-term steps, one relearning step (as run.mjs)
const rows = cards => cards.reduce((a, c) => a + c.ratings.length, 0);

async function loadBinding() {
  const dir = process.env.FSRS_BINDING_DIR || process.cwd();
  const req = createRequire(join(dir, 'noop.js'));
  const mod = await import(pathToFileURL(req.resolve('@open-spaced-repetition/binding')).href);
  let version = '?';
  try { version = JSON.parse(readFileSync(req.resolve('@open-spaced-repetition/binding/package.json'), 'utf8')).version; } catch {
    try { version = JSON.parse(readFileSync(join(dir, 'node_modules/@open-spaced-repetition/binding/package.json'), 'utf8')).version; } catch { /* keep ? */ }
  }
  return { ...mod, version };
}

// One item per review after the first: the card's history up to that review (the last one is the target). FSRS-6 gets whole-day
// gaps, FSRS-7 fractional days (tFrac, sliced to the head length). Returns weights or null.
async function train(b, cards, model) {
  const v7 = model === 'fsrs7', items = [];
  for (const c of cards) {
    const n = c.ratings.length;
    const revs = [];
    for (let i = 0; i < n; i++) {
      revs.push(new b.FSRSBindingReview(c.ratings[i], i === 0 ? 0 : (v7 ? c.tFrac[i] : c.deltas[i])));
      if (i >= 1) items.push(new b.FSRSBindingItem(revs.length > MAX_SEQ ? revs.slice(-MAX_SEQ) : revs.slice()));
    }
  }
  if (!items.length) return { w: null, why: 'no items' };
  try {
    const w = await b.computeParameters(items, { modelVersion: v7 ? 'FSRS-7' : 'FSRS-6', ...SETTINGS });
    return Array.isArray(w) && w.length === (v7 ? 34 : 21) && w.every(Number.isFinite) ? { w } : { w: null, why: 'bad output' };
  } catch (e) { return { w: null, why: String(e?.message || e).slice(0, 200) }; }
}

async function doUser(b, user) {
  const file = s => join(ROOT, 'weights', `${user}.${s}.json`);
  // done = file exists and carries the split it was trained for (older files without cutoff are redone, run.mjs would not trust them)
  const done = s => { try { return JSON.parse(readFileSync(file(s), 'utf8')).cutoff !== undefined; } catch { return false; } };
  if (SCENARIOS.every(([s]) => done(s))) return { user, skipped: true };
  const data = JSON.parse(readFileSync(join(ROOT, 'users', `${user}.json`), 'utf8'));
  const { cards: all } = toHistories(data);
  const log = [];
  for (const [name, limit] of SCENARIOS) {
    if (done(name)) continue;
    if (limit !== Infinity && rows(all) < limit) continue;           // run.mjs skips these scenarios too
    const cards = limit === Infinity ? all : truncate(all, limit);
    const { head, cutoff } = splitHistories(cards, 0.8);
    const t0 = performance.now();
    const r6 = await train(b, head, 'fsrs6'), r7 = await train(b, head, 'fsrs7');
    const doc = { fsrs6: r6.w, fsrs7: r7.w, binding: b.version, settings: SETTINGS, headRows: rows(head), cutoff, seconds: Math.round(performance.now() - t0) / 1000 };
    if (r6.why) doc.fsrs6_error = r6.why;
    if (r7.why) doc.fsrs7_error = r7.why;
    mkdirSync(join(ROOT, 'weights'), { recursive: true });
    writeFileSync(file(name) + '.tmp', JSON.stringify(doc));
    renameSync(file(name) + '.tmp', file(name));
    log.push(`${name}${r6.w ? '' : ' fsrs6=null'}${r7.w ? '' : ' fsrs7=null'}`);
  }
  return { user, log };
}

if (!isMainThread) {
  const b = await loadBinding();
  parentPort.on('message', async ({ user }) => {
    let res;
    try { res = await doUser(b, user); } catch (e) { res = { user, error: String(e?.stack || e).slice(0, 400) }; }
    parentPort.postMessage(res);
  });
  parentPort.postMessage({ ready: true });
} else {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  refuseInsideRepo('the data folder (FSRS_DATA)', ROOT);
  const jobs = Math.max(1, +arg('jobs', Math.min(4, cpus().length)));
  let users = readdirSync(join(ROOT, 'users')).filter(f => /^\d+\.json$/.test(f)).map(f => parseInt(f)).sort((a, b) => a - b);
  if (arg('users')) { const want = new Set(arg('users').split(',').map(Number)); users = users.filter(u => want.has(u)); }
  console.log(`${users.length} users, ${jobs} workers, weights -> ${join(ROOT, 'weights')}`);
  let next = 0, finished = 0, t0 = performance.now();
  const total = users.length;
  const feed = w => { if (next < total) w.postMessage({ user: users[next++] }); else w.terminate(); };
  if (!total) process.exit(0);
  for (let k = 0; k < Math.min(jobs, total); k++) {
    const w = new Worker(new URL(import.meta.url));
    w.on('message', res => {
      if (res.ready) return feed(w);
      finished++;
      console.log(`${finished}/${total} user ${res.user}: ${res.error ? 'ERROR ' + res.error.split('\n')[0] : res.skipped ? 'skipped' : res.log.join(', ') || 'nothing to do'} [${Math.round((performance.now() - t0) / 1000)}s]`);
      feed(w);
    });
    w.on('error', e => { console.error('worker crashed', e); process.exit(1); });
  }
}
