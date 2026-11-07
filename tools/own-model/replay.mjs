process.env.TZ = 'UTC';
// Replay test: how many reviews would a learner need over the next months if their cards were scheduled by FSRS-6 or by the Own model,
// at the same memory target?   node tools/own-model/replay.mjs [options]
// Real anki10k users are cut at their eval cutoff (nothing after it is read). Both models are warmed up on the earlier reviews (Own: its states;
// FSRS-6: weights fitted like eval's fsrs6_fitted, then every card's memory). Then a made-up learner reviews the kept cards day by day.
// For each user 16 runs from the same warm-up: truth (Own or FSRS-6 decides if a review succeeds) x scheduler (FSRS-6 or Own) x R (0.80 0.85 0.90 0.95).
// A review succeeds when u < p, u from a hash of (user, card, review number of the card), so every scheduler meets the same luck.
// A success is rating 3, a failure rating 1 (repeated 10 minutes later, up to 3 times a day, then due the next day).
//   --model FILE       the Own model (default: ~/own-model-private/own-real-v1.own)
//   --split val|train  which real users (default val; test is refused unless --allow-test is given)
//   --limit N (default 60), --users 1,2,3, --cap N (rows per user as in eval, default 40000), --legacy-gap (as in eval)
//   --days H           days to simulate after the cutoff (default 180)
//   --max-cards K      keep a seeded random subset of K whole cards when the user has more (default 800; all rows still warm up the states)
//   --seed N           seed of the luck and of the card subset (default 0)
//   --jobs N           worker threads (default: number of cores)
//   --tag NAME         results file name; rerunning the same tag skips users already done
// Per-user records go to ~/own-model-private/results/replay-<tag>.jsonl (override: OWN_PRIVATE); the aggregate report to summary-replay-<tag>.md and the screen.
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { cpus } from 'node:os';
import { privateDir, parseArgs, refuseInsideRepo, gitStamp, sha256OfParams, helpAndExit } from './common.mjs';
import { loadModelFile } from './eval-core.mjs';
import { summarizeReplay, DEFAULTS, TARGETS } from './replay-core.mjs';
import { listUsers, dataRoot, LICENCE } from './sources/anki10k.mjs';
import { getSource } from './sources/index.mjs';

helpAndExit(process.argv.slice(2), import.meta.url);
const flags = parseArgs(process.argv.slice(2), ['legacy-gap', 'allow-test']);
const fail = msg => { console.error(msg); process.exit(2); };
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]));
const split = flags.split || 'val';
if (!['train', 'val', 'test'].includes(split)) fail('Use --split val, train or test.');
if (split === 'test' && !flags['allow-test']) fail('Refusing to run on the test users: they are counted (see test-runs.json). Use --split val, or --allow-test if you mean it.');
const jobs = Math.max(1, num('jobs', cpus().length));
const days = num('days', DEFAULTS.days), maxCards = num('max-cards', DEFAULTS.maxCards), seed = num('seed', DEFAULTS.seed), cap = num('cap', 40000);
for (const [k, v] of [['days', days], ['max-cards', maxCards], ['cap', cap]]) if (!Number.isInteger(v) || v < 1) fail(`--${k} must be a whole number of at least 1.`);
const resultsDir = join(privateDir(), 'results');
try { refuseInsideRepo('the results folder', resultsDir); } catch (e) { fail(e.message); }
mkdirSync(resultsDir, { recursive: true });
const git = gitStamp();

const modelPath = flags.model || join(privateDir(), 'own-real-v1.own');
if (!existsSync(modelPath)) fail(`No model file at ${modelPath}. Pass --model.`);
const sha = sha256OfParams(loadModelFile(modelPath).params).slice(0, 12);

if (!getSource('anki10k').available({}).ok) fail('The real data folder is not available.');
let users = listUsers({}).filter(u => u.split === split);
if (flags.users) { const want = new Set(String(flags.users).split(',')); users = users.filter(u => want.has(String(u.id))); }
users = users.slice(0, num('limit', 60));
const specs = users.map(u => ({ kind: 'real', id: String(u.id), key: String(u.id), cap, seed: 0, legacyGap: !!flags['legacy-gap'] }));

// the settings that make records comparable; a record made with other settings is not reused
const cfg = { days, maxCards, seed, cap, legacyGap: !!flags['legacy-gap'], model: sha, code: git, targets: TARGETS, maxDays: DEFAULTS.maxDays, snapshotEvery: DEFAULTS.snapshotEvery };
cfg.id = JSON.stringify({ ...cfg, code: undefined });
const tag = flags.tag || `${split}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-')}`;
const file = join(resultsDir, `replay-${tag}.jsonl`);
const done = new Map();
let stale = 0;
if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) {
  if (!l) continue;
  try { const r = JSON.parse(l); if (r.ok && r.cfg === cfg.id) done.set(String(r.user), r); else if (r.ok) stale++; } catch { /* half-written last line */ }
}
const todo = specs.filter(s => !done.has(s.key));
console.log(`[${split}] ${specs.length} users, ${done.size} already done${stale ? ` (${stale} made with other settings, ignored)` : ''}, ${todo.length} to do, ${jobs} jobs; ${days} days, up to ${maxCards} cards; model ${basename(modelPath)}; code ${git}`);

function runPool(list, onResult) {
  return new Promise((resolve, reject) => {
    let next = 0, finished = 0;
    const workers = [];
    const feed = w => { if (next < list.length) w.postMessage({ spec: list[next++] }); else w.terminate(); };
    if (!list.length) return resolve();
    for (let k = 0; k < Math.min(jobs, list.length); k++) {
      const w = new Worker(new URL('./replay-worker.mjs', import.meta.url), { workerData: { modelPath, cfg }, env: { ...process.env, TZ: 'UTC' } });
      workers.push(w);
      w.on('message', r => { onResult(r, ++finished); if (finished === list.length) { workers.forEach(x => x.terminate()); resolve(); } else feed(w); });
      w.on('error', e => { workers.forEach(x => x.terminate()); reject(e); });
      feed(w);
    }
  });
}

const t0 = Date.now();
await runPool(todo, (r, n) => {
  if (r.ok) { appendFileSync(file, JSON.stringify(r) + '\n'); done.set(String(r.user), r); }
  const el = (Date.now() - t0) / 1000;
  console.log(`${n}/${todo.length} user ${r.user}: ${r.ok ? `done in ${r.seconds}s` : `FAILED ${r.error}`}  (ETA ${Math.round(el / n * (todo.length - n) / 60)} min)`);
});
const results = specs.map(s => done.get(s.key)).filter(Boolean);
const { markdown } = summarizeReplay(results, { tag, split, git, modelName: basename(modelPath), modelSha: sha, targets: TARGETS,
  cfg: `${days} days, up to ${maxCards} cards per user, rows capped at ${cap} per user, seed ${seed}${flags['legacy-gap'] ? ', legacy card gap' : ''}; data licence: ${LICENCE}` });
const out = join(resultsDir, `summary-replay-${tag}.md`);
writeFileSync(out, markdown);
console.log('\n' + markdown + `(saved to ${out})\n`);
if (split === 'test') {
  const f = join(resultsDir, 'test-runs.json');
  let rec = { runs: 0, log: [] };
  try { rec = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first run */ }
  if (todo.length) { rec.runs++; rec.log.push({ at: new Date().toISOString(), tag: `replay-${tag}`, users: results.length, model: { [basename(modelPath)]: sha }, code: git, limit: num('limit', 60) }); writeFileSync(f, JSON.stringify(rec, null, 1)); }
  console.log(`Test-set runs recorded so far: ${rec.runs} (${f})`);
}
