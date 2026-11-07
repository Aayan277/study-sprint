process.env.TZ = 'UTC';
// Replay test: how many reviews would a learner need over the next months if their cards were scheduled by FSRS-6 or by the Own model,
// at the same memory target?   node tools/own-model/replay.mjs [options]
// Real anki10k users are cut at their eval cutoff (nothing after it is read). Both models are warmed up on the earlier reviews (Own: its states;
// FSRS-6: weights fitted like eval's fsrs6_fitted, then every card's memory). Then a made-up learner reviews the kept cards day by day.
// For each user runs from the same warm-up: truth (Own or FSRS-6 decides if a review succeeds) x scheduler (FSRS-6 or Own) x R
// (FSRS-6: 0.80 0.85 0.90 0.95; Own: 0.65 0.70 0.75 0.80 0.85 0.90 0.92). FSRS-6 uses per-user fitted weights, Own is zero-shot.
// A review succeeds when u < p, u from a hash of (user, card, review number of the card), so every scheduler meets the same luck.
// A success is rating 3, a failure rating 1 (repeated 10 minutes later, up to 3 times a day, then due the next day).
//   --model FILE       the Own model (default: ~/own-model-private/own-real-v1.own)
//   --split val|train  which real users (default val; test is refused unless --allow-test is given)
//   --limit N (default 60), --users 1,2,3, --cap N (rows per user as in eval, default 40000), --legacy-gap (as in eval)
//   --days H           days to simulate after the cutoff (default 180); the headline numbers start on day 2, day 1 is the backlog and is listed apart
//   --active-days N    simulate only cards last reviewed within N days before the cutoff (default 90), the same cards for both schedulers
//   --own-sched M      head: Own's interval is read from the curve right after the answer; fade (default): from the model's own prediction at
//                      review time, with the note memory faded over the gap (the interval the app gives)
//   --own-grid LIST    Own's R values (default 0.65,0.70,0.75,0.80,0.85,0.90,0.92);  --fsrs-grid LIST  FSRS-6's (default 0.80,0.85,0.90,0.95)
//   --no-fsrs-fit      use FSRS-6's default weights instead of fitting them per user (faster, for smoke tests)
//   --max-cards K      keep a seeded random subset of K whole cards when the user has more (default 800; all rows still warm up the states)
//   --seed N           seed of the luck and of the card subset (default 0)
//   --jobs N           worker threads (default: number of cores)
//   --tag NAME         results file name; rerunning the same tag skips users already done
// Per-user records go to ~/own-model-private/results/replay-<tag>.jsonl (override: OWN_PRIVATE); the aggregate report to summary-replay-<tag>.md and the screen.
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { cpus } from 'node:os';
import { privateDir, parseArgs, refuseInsideRepo, gitStamp, sha256OfParams, helpAndExit } from './common.mjs';
import { loadModelFile } from './eval-core.mjs';
import { summarizeReplay, DEFAULTS, OWN_SCHEDS, REPLAY_VERSION } from './replay-core.mjs';
import { runPool } from './replay-pool.mjs';
import { listUsers, dataRoot, LICENCE } from './sources/anki10k.mjs';
import { getSource } from './sources/index.mjs';

helpAndExit(process.argv.slice(2), import.meta.url);
const flags = parseArgs(process.argv.slice(2), ['legacy-gap', 'allow-test', 'no-fsrs-fit']);
const fail = msg => { console.error(msg); process.exit(2); };
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]));
const split = flags.split || 'val';
if (!['train', 'val', 'test'].includes(split)) fail('Use --split val, train or test.');
if (split === 'test' && !flags['allow-test']) fail('Refusing to run on the test users: they are counted (see test-runs.json). Use --split val, or --allow-test if you mean it.');
const jobs = Math.max(1, num('jobs', cpus().length));
const days = num('days', DEFAULTS.days), maxCards = num('max-cards', DEFAULTS.maxCards), seed = num('seed', DEFAULTS.seed), cap = num('cap', 40000);
const limit = num('limit', 60), activeDays = num('active-days', DEFAULTS.activeDays);
for (const [k, v] of [['days', days], ['max-cards', maxCards], ['cap', cap], ['limit', limit], ['active-days', activeDays]]) if (!Number.isInteger(v) || v < 1) fail(`--${k} must be a whole number of at least 1.`);
if (!Number.isInteger(seed) || seed < 0) fail('--seed must be a whole number, 0 or more.');
const ownSched = flags['own-sched'] === undefined ? DEFAULTS.ownSched : String(flags['own-sched']);
if (!OWN_SCHEDS.includes(ownSched)) fail('--own-sched must be head or fade.');
const gridFlag = (k, d) => {
  if (flags[k] === undefined) return d;
  const g = String(flags[k]).split(',').map(Number);
  if (!g.length || g.some(x => !(x > 0 && x < 1))) fail(`--${k} must be a comma-separated list of numbers between 0 and 1.`);
  return [...new Set(g)].sort((a, b) => a - b);
};
const ownTargets = gridFlag('own-grid', DEFAULTS.ownTargets), fsrsTargets = gridFlag('fsrs-grid', DEFAULTS.fsrsTargets);
const fitFsrs = !flags['no-fsrs-fit'];
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
users = users.slice(0, limit);
const specs = users.map(u => ({ kind: 'real', id: String(u.id), key: String(u.id), cap, seed: 0, legacyGap: !!flags['legacy-gap'] }));

// the settings that make records comparable; a record made with other settings is not reused
const cfg = {
  version: REPLAY_VERSION, days, maxCards, seed, cap, legacyGap: !!flags['legacy-gap'], model: sha, code: git, ownTargets, fsrsTargets, maxDays: DEFAULTS.maxDays,
  snapshotEvery: DEFAULTS.snapshotEvery, retryMinutes: DEFAULTS.retryMinutes, maxRetries: DEFAULTS.maxRetries, fitFsrs, activeDays, ownSched
};
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

const t0 = Date.now();
const failedNow = [];
await runPool(todo, (r, n) => {
  if (r.ok) { appendFileSync(file, JSON.stringify(r) + '\n'); done.set(String(r.user), r); } else failedNow.push(r);
  const el = (Date.now() - t0) / 1000;
  console.log(`${n}/${todo.length} user ${r.user}: ${r.ok ? `done in ${r.seconds}s` : `FAILED ${r.error}`}  (ETA ${Math.round(el / n * (todo.length - n) / 60)} min)`);
}, { workerUrl: new URL('./replay-worker.mjs', import.meta.url), workerData: { modelPath, cfg }, jobs: Math.min(jobs, todo.length || 1), env: { ...process.env, TZ: 'UTC' } });
const results = specs.map(s => done.get(s.key)).filter(Boolean);
const { markdown } = summarizeReplay(results, { tag, split, git, modelName: basename(modelPath), modelSha: sha, ownTargets, fsrsTargets, ownSched, fitFsrs, failed: failedNow,
  cfg: `${days} days, up to ${maxCards} cards per user (last reviewed within ${activeDays} days of the cutoff), rows capped at ${cap} per user, seed ${seed}${flags['legacy-gap'] ? ', legacy card gap' : ''}; data licence: ${LICENCE}` });
const out = join(resultsDir, `summary-replay-${tag}.md`);
writeFileSync(out, markdown);
console.log('\n' + markdown + `(saved to ${out})\n`);
if (split === 'test') {
  const f = join(resultsDir, 'test-runs.json');
  let rec = { runs: 0, log: [] };
  try { rec = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first run */ }
  if (todo.length) { rec.runs++; rec.log.push({ at: new Date().toISOString(), tag: `replay-${tag}`, users: results.length, model: { [basename(modelPath)]: sha }, code: git, limit }); writeFileSync(f, JSON.stringify(rec, null, 1)); }
  console.log(`Test-set runs recorded so far: ${rec.runs} (${f})`);
}
