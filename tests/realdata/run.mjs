// Score FSRS models on real Anki review logs, per user, on held-out reviews. See README.md.
//   node tests/realdata/run.mjs [--users 1,2,3 | --limit N] [--jobs 4] [--out file] [--cap N]
// Reads ~/fsrs-data/users/*.json (folder: env FSRS_DATA), appends one JSON line per user to results/results.jsonl and skips
// users already done, so it can be stopped and started again. Users run in a pool of worker threads.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, readdirSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fit, fitChecked, splitHistories, clipWeights, mulberry32 } from '../../js/fsrs-fit.js';
import { W7_DEFAULT, clipWeights7 } from '../../js/fsrs7-model.js';
import { toHistories, truncate, eval6, eval7 } from './lib.mjs';

const ROOT = process.env.FSRS_DATA || join(homedir(), 'fsrs-data');
const SCENARIOS = [['full', Infinity], ['first1000', 1000], ['first5000', 5000]];
const RELEARN_STEPS = 1;                 // the app's default relearningSteps is '10m' (js/sched-settings.js): one step
// No cap by default: the biggest user measured (776,000 rows) took 43 seconds. --cap N thins bigger users by whole cards (capCards).
const DEFAULT_CAP = Infinity;

// ts-fsrs 5.4.2 from node_modules: the default weights and bounds the app uses (js/srs.js loads the same version from a CDN).
const ts = await import(pathToFileURL(createRequire(import.meta.url).resolve('ts-fsrs')).href);
const DEFAULT_W = Array.from(ts.default_w);
const BOUNDS = ts.CLAMP_PARAMETERS(ts.W17_W18_Ceiling, true);

const drive = gen => { for (;;) { const r = gen.next(); if (r.done) return r.value; } };
const seconds = t0 => Math.round((performance.now() - t0)) / 1000;
const rows = cards => cards.reduce((a, c) => a + c.ratings.length, 0);

// Thin a user to whole cards, picked by a shuffle seeded with the user id, until at most `cap` rows are left (card order is kept).
function capCards(cards, cap, user) {
  const rng = mulberry32(user), order = cards.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const take = new Set();
  let total = 0;
  for (const i of order) { const n = cards[i].ratings.length; if (total + n <= cap) { take.add(i); total += n; } }
  return cards.filter((_, i) => take.has(i));
}

function readWeights(user, scenario) {
  const file = join(ROOT, 'weights', `${user}.${scenario}.json`);
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function scoreScenario(user, scenario, cards, skipped, cap) {
  const split = splitHistories(cards, 0.8);
  const out = { rows: rows(cards), cards: cards.length, skipped, headCards: split.head.length, headRows: rows(split.head), cutoff: split.cutoff, models: {} };
  if (cap) { out.capped = true; out.cap = cap; }
  const clip6 = w => clipWeights(w, RELEARN_STEPS, BOUNDS);
  const score6 = (w, extra = {}) => ({ ...eval6(split.test, w), ...extra });
  const add = (name, f) => { const t0 = performance.now(); const r = f(); r.fitSeconds = seconds(t0); out.models[name] = r; };

  add('fsrs6_default', () => score6(clip6(DEFAULT_W)));
  add('fsrs6_tuned', () => {
    const r = drive(fit({ cards: split.head, current: DEFAULT_W, defaults: DEFAULT_W, bounds: BOUNDS, config: { skipCheck: true } }));
    return score6(clip6(r.status === 'trained' ? r.fitted : DEFAULT_W), { status: r.status });
  });
  add('fsrs6_app', () => {
    const r = drive(fitChecked({ cards: split.head, current: DEFAULT_W, defaults: DEFAULT_W, bounds: BOUNDS }));
    return score6(clip6(r.status === 'better' ? r.w : DEFAULT_W), { status: r.status, reason: r.reason });
  });
  add('fsrs7_default', () => eval7(split.test, W7_DEFAULT));
  const rs = readWeights(user, scenario);                   // reference fits by fsrs-rs, written by another script
  if (Array.isArray(rs.fsrs6) && rs.fsrs6.length === 21) add('fsrs6_rs', () => score6(clip6(rs.fsrs6)));
  if (Array.isArray(rs.fsrs7) && rs.fsrs7.length === 34) add('fsrs7_rs', () => eval7(split.test, clipWeights7(rs.fsrs7)));
  return out;
}

function scoreUser(user, cap) {
  const data = JSON.parse(readFileSync(join(ROOT, 'users', `${user}.json`), 'utf8'));
  const { cards: all, skipped } = toHistories(data);
  const res = { user, rawRows: data.card_id.length, scenarios: {} };
  for (const [name, limit] of SCENARIOS) {
    let cards = limit === Infinity ? all : truncate(all, limit);
    if (limit !== Infinity && rows(all) < limit) continue;      // the user has fewer reviews than this scenario needs
    let capped = 0;
    if (rows(cards) > cap) { cards = capCards(cards, cap, user); capped = cap; }
    res.scenarios[name] = scoreScenario(user, name, cards, skipped, capped);
  }
  return res;
}

if (!isMainThread) {
  parentPort.on('message', ({ user, cap }) => {
    const t0 = performance.now();
    let res;
    try { res = scoreUser(user, cap); res.seconds = seconds(t0); } catch (e) { res = { user, error: String(e?.stack || e).slice(0, 600) }; }
    parentPort.postMessage(res);
  });
} else {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const out = arg('out', join(ROOT, 'results', 'results.jsonl'));
  const jobs = Math.max(1, +arg('jobs', cpus().length));
  const cap = +arg('cap', DEFAULT_CAP);
  mkdirSync(dirname(out), { recursive: true });
  const done = new Set();
  if (existsSync(out)) for (const l of readFileSync(out, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (!r.error) done.add(r.user); } catch { /* a half-written last line */ } }
  let users = readdirSync(join(ROOT, 'users')).filter(f => /^\d+\.json$/.test(f)).map(f => parseInt(f)).sort((a, b) => a - b);
  if (arg('users')) { const want = new Set(arg('users').split(',').map(Number)); users = users.filter(u => want.has(u)); }
  users = users.filter(u => !done.has(u));
  if (arg('limit')) users = users.slice(0, +arg('limit'));
  console.log(`${users.length} users to do (${done.size} already done), ${jobs} workers, results -> ${out}`);
  let next = 0, finished = 0;
  const pool = [];
  const feed = w => { if (next < users.length) w.postMessage({ user: users[next++], cap }); else { w.terminate(); } };
  const total = users.length;
  if (!total) process.exit(0);
  for (let k = 0; k < Math.min(jobs, total); k++) {
    const w = new Worker(new URL(import.meta.url));
    pool.push(w);
    w.on('message', res => {
      appendFileSync(out, JSON.stringify(res) + '\n');
      finished++;
      const sc = res.scenarios?.full;
      console.log(`${finished}/${total} user ${res.user}: ${res.error ? 'ERROR ' + res.error.split('\n')[0] : `${res.rawRows} rows${sc?.capped ? ' (capped)' : ''}, ${res.seconds}s`}`);
      feed(w);
    });
    w.on('error', e => { console.error('worker crashed', e); process.exit(1); });
    feed(w);
  }
}
