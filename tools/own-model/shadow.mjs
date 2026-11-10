process.env.TZ = 'UTC';
// Shadow run ("watch first"): turn Own on at some point, keep FSRS scheduling, and run the app's own verdict rule (js/own-verdict.js: liveVerdict
// and nextScheduler) forward in time. When would it first say "Own is better", does it change its mind, and how often would it say Better when
// there is no real difference?   node tools/own-model/shadow.mjs [options]
// Each later-day scored review after the turn-on is a live record (Own's p, FSRS's p, what happened). Each study day (a day with a live record), up
// to --horizon days after the turn-on, the rule runs for every setting of N_live {50,100,200,300,500} x level {95%,99%} x consecutive checks {1,2}.
// The shipped setting (300, 95%, 2) is one of the 20 and is flagged. consecutive 2 is the shipped rule (two Better checks on different days at most 7
// days apart); consecutive 1 flips on a single Better check. A "scored review" is a later-day one (not a card's first answer, not the same day).
//   --model FILE       the Own model (zero-shot, memory replayed through all earlier rows). Default: ~/own-model-private/own-real-v1.own
//   --source anki10k|sim   real users (default) or made-up learners
//   --split val|train  real users (default val). The test users are never run by this tool.
//   --half A|B         only the val users with fnv1a('own-val-half|'+id) & 1 equal to 0 (A) or 1 (B)
//   --limit N (default 60), --users 1,2,3, --cap N (rows per user, default 40000), --legacy-gap
//   --start first|scored:N|cutoff   when Own is turned on (default scored:1000). first: the day of the first review; scored:N: the day of the user's
//                      Nth scored review (live records are the scored reviews on later days); cutoff: the eval cutoff day. Users who never get there are counted and skipped.
//   --tune none|monthly   none (default): Own as it is. monthly: at the turn-on and every 30 days after it Own is fine-tuned on the user's reviews up to that day (eval's per-user fine-tune)
//   --fsrs default|fitted-at-start|refit-monthly   FSRS-6 weights: standard (default), fitted once on the reviews up to the turn-on, or refitted every 30 days (all causal)
//   --null signflip:D  also D draws of the sign-flip null: every card's loss differences change sign by a seeded coin (Own and FSRS swapped on that card), the rule runs again;
//                      any Better there is a false Better (default: no null)
//   --horizon H        study days to watch after the turn-on (default 365); the loss after the first Better is read over the 90 days after it, also past H
//   --seed N           seed of the null draws (default 0)
//   --oracle           sim only: FSRS's side is the TRUE chance of remembering, so any Better is wrong (the control)
//   --world own|fsrs   sim only: made-up learners from the own-world or the FSRS-world (default fsrs for --oracle, else own); --count N (default 40), --sim-days a,b (default 150,400)
//   --jobs N, --tag NAME (rerunning the same tag skips users already done with the same settings)
// Per-user records go to ~/own-model-private/results/shadow-<tag>.jsonl (override: OWN_PRIVATE); the aggregate report to summary-shadow-<tag>.md and the screen.
// Record fields: user, ok, skipped?, start, tune, fsrs, oracle, turnDay, histScored, liveRecords, liveInHorizon, cards, liveDays, half, horizon, nextDays,
//   live {n, llOwn, llFsrs, meanDiff}, fitStatus, tuned, variants { key: { reached, firstBetter {day, daysAfter, records} | null, switches [{day, to, why, n}],
//   flips, returns, final, locked, next {n, diff} | null } }, null { key: { draws, better, days[] } } | undefined, cfg, seconds.
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { privateDir, parseArgs, refuseInsideRepo, gitStamp, sha256OfParams, helpAndExit } from './common.mjs';
import { loadModelFile } from './eval-core.mjs';
import { summarizeShadow, parseStart, halfOf, SHADOW_VERSION, DEFAULTS, TUNES, FSRS_MODES } from './shadow-core.mjs';
import { runPool } from './replay-pool.mjs';
import { listUsers, LICENCE } from './sources/anki10k.mjs';
import { getSource } from './sources/index.mjs';

helpAndExit(process.argv.slice(2), import.meta.url);
const flags = parseArgs(process.argv.slice(2), ['legacy-gap', 'oracle']);
const fail = msg => { console.error(msg); process.exit(2); };
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]));
const source = flags.source || 'anki10k';
if (!['anki10k', 'sim'].includes(source)) fail('Use --source anki10k or --source sim.');
const split = flags.split || 'val';
if (!['train', 'val'].includes(split)) fail('Use --split val or train. The test users are used up and never run here.');
const half = flags.half === undefined ? null : String(flags.half).toUpperCase();
if (half !== null && !['A', 'B'].includes(half)) fail('--half must be A or B.');
if (half !== null && (source !== 'anki10k' || split !== 'val')) fail('--half works on the real val users only.');
const jobs = Math.max(1, num('jobs', cpus().length));
const horizon = num('horizon', DEFAULTS.horizon), cap = num('cap', DEFAULTS.cap), limit = num('limit', 60), seed = num('seed', DEFAULTS.seed), count = num('count', 40);
for (const [k, v] of [['horizon', horizon], ['cap', cap], ['limit', limit], ['count', count]]) if (!Number.isInteger(v) || v < 1) fail(`--${k} must be a whole number of at least 1.`);
if (!Number.isInteger(seed) || seed < 0) fail('--seed must be a whole number, 0 or more.');
const startText = flags.start === undefined ? DEFAULTS.start : String(flags.start);
try { parseStart(startText); } catch (e) { fail(e.message); }
const tune = flags.tune === undefined ? DEFAULTS.tune : String(flags.tune);
if (!TUNES.includes(tune)) fail(`--tune must be ${TUNES.join(' or ')}.`);
const fsrs = flags.fsrs === undefined ? DEFAULTS.fsrs : String(flags.fsrs);
if (!FSRS_MODES.includes(fsrs)) fail(`--fsrs must be ${FSRS_MODES.join(', ')}.`);
let nullDraws = 0;
if (flags.null !== undefined && flags.null !== 'none') {
  const m = /^signflip:(\d+)$/.exec(String(flags.null));
  if (!m || Number(m[1]) < 1) fail('--null must be signflip:D (D a whole number of at least 1) or none.');
  nullDraws = Number(m[1]);
}
const oracle = !!flags.oracle;
if (oracle && source !== 'sim') fail('--oracle needs --source sim.');
const world = flags.world === undefined ? (oracle ? 'fsrs' : 'own') : String(flags.world);
if (!['own', 'fsrs'].includes(world)) fail('--world must be own or fsrs.');
const simDays = flags['sim-days'] ? String(flags['sim-days']).split(',').map(Number) : DEFAULTS.simDays;
const resultsDir = join(privateDir(), 'results');
try { refuseInsideRepo('the results folder', resultsDir); } catch (e) { fail(e.message); }
mkdirSync(resultsDir, { recursive: true });
const git = gitStamp();

const modelPath = flags.model || join(privateDir(), 'own-real-v1.own');
if (!existsSync(modelPath)) fail(`No model file at ${modelPath}. Pass --model.`);
const sha = sha256OfParams(loadModelFile(modelPath).params).slice(0, 12);

let specs;
if (source === 'sim') {
  const sp = world === 'fsrs' ? 'control' : 'val';
  specs = Array.from({ length: count }, (_, k) => ({ kind: 'sim', split: sp, k: k + seed, config: { days: simDays }, key: `${sp}-${k + seed}` }));
} else {
  if (!getSource('anki10k').available({}).ok) fail('The real data folder is not available.');
  let users = listUsers({}).filter(u => u.split === split);
  if (half !== null) users = users.filter(u => halfOf(String(u.id)) === half);
  if (flags.users) { const want = new Set(String(flags.users).split(',')); users = users.filter(u => want.has(String(u.id))); }
  users = users.slice(0, limit);
  specs = users.map(u => ({ kind: 'real', id: String(u.id), key: String(u.id), cap, seed: 0, legacyGap: !!flags['legacy-gap'], half: split === 'val' ? halfOf(String(u.id)) : null }));
}

// a short hash of the app files the run uses, so a change to them is a change of settings
const libs = createHash('sha256').update(['own-model', 'own-curve', 'fsrs-fit', 'own-verdict'].map(n => readFileSync(new URL(`../../js/${n}.js`, import.meta.url))).join('\0')).digest('hex').slice(0, 12);
const cfg = { version: SHADOW_VERSION, source, split, world: source === 'sim' ? world : null, oracle, start: startText, tune, fsrs, nullDraws, horizon, nextDays: DEFAULTS.nextDays, epochDays: DEFAULTS.epochDays, seed, cap, legacyGap: !!flags['legacy-gap'], simDays: source === 'sim' ? simDays : null, model: sha, libs };
cfg.id = JSON.stringify(cfg);
const tag = flags.tag || `${source === 'sim' ? 'sim-' + world : split}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-')}`;
const file = join(resultsDir, `shadow-${tag}.jsonl`);
const done = new Map();
let stale = 0;
if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) {
  if (!l) continue;
  try { const r = JSON.parse(l); if (r.ok && r.cfg === cfg.id) done.set(String(r.user), r); else if (r.ok) stale++; } catch { /* half-written last line */ }
}
const todo = specs.filter(s => !done.has(s.key));
console.log(`[${source === 'sim' ? 'sim ' + world : split}${half ? ' half ' + half : ''}] ${specs.length} users, ${done.size} already done${stale ? ` (${stale} made with other settings, ignored)` : ''}, ${todo.length} to do, ${jobs} jobs; start ${startText}, tune ${tune}, fsrs ${fsrs}${nullDraws ? `, null signflip:${nullDraws}` : ''}${oracle ? ', oracle' : ''}; horizon ${horizon} days; model ${basename(modelPath)}; code ${git}`);

const t0 = Date.now();
const failedNow = [];
await runPool(todo, (r, n) => {
  if (r.ok) { appendFileSync(file, JSON.stringify(r) + '\n'); done.set(String(r.user), r); } else failedNow.push(r);
  const el = (Date.now() - t0) / 1000;
  console.log(`${n}/${todo.length} ${r.ok ? `done in ${r.seconds}s` : `FAILED ${r.error}`}  (ETA ${Math.round(el / n * (todo.length - n) / 60)} min)`);   // (no user ids or numbers: aggregates only)
}, { workerUrl: new URL('./shadow-worker.mjs', import.meta.url), workerData: { modelPath, cfg }, jobs: Math.min(jobs, todo.length || 1), env: { ...process.env, TZ: 'UTC' } });
const results = specs.map(s => done.get(s.key)).filter(Boolean).concat(failedNow);
const header = [`Code ${git}; Node ${process.version}; model ${basename(modelPath)} (${sha}); start ${startText}; Own tune ${tune}; FSRS ${oracle ? 'true chance (oracle)' : fsrs}; null ${nullDraws ? 'signflip:' + nullDraws : 'none'}; horizon ${horizon} days${half ? `; half ${half}` : ''}; ${source === 'anki10k' ? `split ${split}; rows capped at ${cap} per user; data licence: ${LICENCE}` : `sim world ${world}, ${count} learners`}.`];
const { markdown } = summarizeShadow(results, { tag, header });
const out = join(resultsDir, `summary-shadow-${tag}.md`);
writeFileSync(out, markdown);
console.log('\n' + markdown + `(saved to ${out})\n`);
