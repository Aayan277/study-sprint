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
//   --split val|train  which real users (default val; test is refused, no override)
//   --limit N (default 60), --users 1,2,3, --cap N (rows per user as in eval, default 40000), --legacy-gap (as in eval)
//   --days H           days to simulate after the cutoff (default 180); the headline numbers start on day 2, day 1 is the backlog and is listed apart
//   --active-days N    simulate only cards last reviewed within N days before the cutoff (default 90), the same cards for both schedulers
//   --own-sched M      head: Own's interval is read from the curve right after the answer; fade (default): note memory faded over the
//                      gap, other query features as of the answer (the interval the app gives)
//   --own-grid LIST    Own's R values (default 0.65,0.70,0.75,0.80,0.85,0.90,0.92);  --fsrs-grid LIST  FSRS-6's (default 0.80,0.85,0.90,0.95)
//   --no-fsrs-fit      use FSRS-6's default weights instead of fitting them per user (faster, for smoke tests)
//   --fsrs-weights W   fitted (default) | default; default is the same as --no-fsrs-fit
//   --truth LIST       which models play the learner's true memory: own, fsrs, mix (mean of the two p); default own,fsrs
//   --new-per-day V    real | N: also start new cards. real = the cards the user really first reviewed after the start, on the day they really did, in real order;
//                      N = N of those per day (in real order). The first answer is the real first rating; a failure is repeated like any lapse.
//   --paired           for every counted pass record log2(Own interval / FSRS-6 interval) at the same card state and R (histogram, 0.5 steps, -6..+6)
//   --band lo,hi|none  keep Own's interval within lo..hi times FSRS-6's (app: 0.25,4) and at most 3650 days; none (default) = no clamp
//   --start-at N       cold start: only the first N reviews of the user warm the memory; the simulation starts the day of the Nth (needs fewer than all rows before the cutoff)
//   --half A|B         only the val users with fnv1a('own-val-half|' + id) & 1 equal to 0 (A) or 1 (B)
//   --max-cards K      keep a seeded random subset of K whole cards when the user has more (default 800; all rows still warm up the states)
//   --seed N           seed of the luck and of the card subset (default 0)
//   --jobs N           worker threads (default: number of cores)
//   --tag NAME         results file name; rerunning the same tag skips users already done
// Per-user records go to ~/own-model-private/results/replay-<tag>.jsonl (override: OWN_PRIVATE); the aggregate report to summary-replay-<tag>.md and the screen.
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { privateDir, parseArgs, refuseInsideRepo, gitStamp, sha256OfParams, helpAndExit } from './common.mjs';
import { loadModelFile } from './eval-core.mjs';
import { summarizeReplay, DEFAULTS, OWN_SCHEDS, REPLAY_VERSION, ALL_TRUTHS, TRUTHS, parseBand, halfOf, splitProblem } from './replay-core.mjs';
import { runPool } from './replay-pool.mjs';
import { listUsers, dataRoot, LICENCE } from './sources/anki10k.mjs';
import { getSource } from './sources/index.mjs';

helpAndExit(process.argv.slice(2), import.meta.url);
const flags = parseArgs(process.argv.slice(2), ['legacy-gap', 'no-fsrs-fit', 'paired']);
const fail = msg => { console.error(msg); process.exit(2); };
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]));
const split = flags.split || 'val';
const splitError = splitProblem(split);
if (splitError) fail(splitError);
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
const fsrsWeights = flags['fsrs-weights'] === undefined ? 'fitted' : String(flags['fsrs-weights']);
if (!['fitted', 'default'].includes(fsrsWeights)) fail('--fsrs-weights must be fitted or default.');
const fitFsrs = !flags['no-fsrs-fit'] && fsrsWeights === 'fitted';
const truths = flags.truth === undefined ? TRUTHS : [...new Set(String(flags.truth).split(','))];
if (!truths.length || truths.some(t => !ALL_TRUTHS.includes(t))) fail('--truth must be a comma-separated list of own, fsrs, mix.');
let newPerDay = null;
if (flags['new-per-day'] !== undefined) {
  newPerDay = flags['new-per-day'] === 'real' ? 'real' : Number(flags['new-per-day']);
  if (newPerDay !== 'real' && !(Number.isInteger(newPerDay) && newPerDay >= 1)) fail('--new-per-day must be real or a whole number of at least 1.');
}
const paired = !!flags.paired;
let band = null;
try { band = parseBand(flags.band); } catch (e) { fail(e.message); }
const startAt = num('start-at', 0);
if (flags['start-at'] !== undefined && (!Number.isInteger(startAt) || startAt < 1)) fail('--start-at must be a whole number of at least 1.');
const half = flags.half === undefined ? null : String(flags.half);
if (half !== null && !['A', 'B'].includes(half)) fail('--half must be A or B.');
const resultsDir = join(privateDir(), 'results');
try { refuseInsideRepo('the results folder', resultsDir); } catch (e) { fail(e.message); }
mkdirSync(resultsDir, { recursive: true });
const git = gitStamp();

const modelPath = flags.model || join(privateDir(), 'own-real-v1.own');
if (!existsSync(modelPath)) fail(`No model file at ${modelPath}. Pass --model.`);
const sha = sha256OfParams(loadModelFile(modelPath).params).slice(0, 12);

if (!getSource('anki10k').available({}).ok) fail('The real data folder is not available.');
let users = listUsers({}).filter(u => u.split === split);
if (half) users = users.filter(u => halfOf(String(u.id)) === half);
if (flags.users) { const want = new Set(String(flags.users).split(',')); users = users.filter(u => want.has(String(u.id))); }
users = users.slice(0, limit);
const specs = users.map(u => ({ kind: 'real', id: String(u.id), key: String(u.id), cap, seed: 0, legacyGap: !!flags['legacy-gap'] }));

// a short hash of the app files the replay runs on, so a change to them is a change of settings
const libs = createHash('sha256').update(['own-model', 'own-curve', 'fsrs-fit', 'own-plan'].map(n => readFileSync(new URL(`../../js/${n}.js`, import.meta.url))).join('\0')).digest('hex').slice(0, 12);
// the settings that make records comparable; a record made with other settings is not reused
const cfg = {
  version: REPLAY_VERSION, days, maxCards, seed, cap, legacyGap: !!flags['legacy-gap'], model: sha, code: git, ownTargets, fsrsTargets, maxDays: DEFAULTS.maxDays,
  snapshotEvery: DEFAULTS.snapshotEvery, retryMinutes: DEFAULTS.retryMinutes, maxRetries: DEFAULTS.maxRetries, fitFsrs, activeDays, ownSched, libs,
  truths, newPerDay, paired, band, startAt: startAt || null, half
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
const { markdown } = summarizeReplay(results, { tag, split, git, modelName: basename(modelPath), modelSha: sha, ownTargets, fsrsTargets, ownSched, fitFsrs, failed: failedNow, truths,
  cfg: `${days} days, up to ${maxCards} cards per user (last reviewed within ${activeDays} days of the cutoff), rows capped at ${cap} per user, seed ${seed}${flags['legacy-gap'] ? ', legacy card gap' : ''}; data licence: ${LICENCE}` });
const out = join(resultsDir, `summary-replay-${tag}.md`);
writeFileSync(out, markdown);
console.log('\n' + markdown + `(saved to ${out})\n`);
