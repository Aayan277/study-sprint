process.env.TZ = 'UTC';
// Evaluate the Own model against FSRS-6 on held-out learners.   node tools/own-model/eval.mjs --source sim|anki10k [options]
//   --source sim       200 held-out made-up learners (seeds 20001..) and 200 of the FSRS-world control (30001..)
//   --source anki10k   the test users of the real data (390 of 2,004 with the hash split); each user split by time 80/20
//   --model FILE       the Own model to judge (default: ~/own-model-private/own-sim-v1.own or own-real-v1.own)
//   --sim-model FILE   a second Own model to show as "Own (sim weights)" (default: the shipped js/own-params.js)
//   --extra "label=FILE"   more Own models, shown zero-shot (repeat it; for example a model trained with --ablate=user)
//   --split test|val   real data only (default test; val is for choosing settings, the test users are counted: see test-runs.json)
//   --limit N, --users 1,2,3, --cap N (rows per user, default 40000), --jobs N, --tag NAME (reuse a tag to continue a stopped run)
//   --count N, --days a,b, --seed N   simulator learners (default 200, days 40,150)
//   --legacy-gap        real data: keep the old card gap that still contains the answer's own duration (for models trained before the fix)
//   --no-fit            skip the FSRS-6 fit (quick check of the Own side only)
//   --ft-epochs N --ft-lr X --ft-l2 X   per-user fine-tune settings
// Per-user records go to ~/own-model-private/results/<tag>.jsonl (override: OWN_PRIVATE), the aggregate report to summary-<tag>.md and the screen.
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { cpus } from 'node:os';
import { privateDir, parseArgs, refuseInsideRepo, gitStamp, sha256OfParams, helpAndExit } from './common.mjs';
import { summarize } from './eval-lib.mjs';
import { loadModelFile, loadShippedParams, FT_DEFAULTS } from './eval-core.mjs';
import { listUsers, dataRoot, LICENCE } from './sources/anki10k.mjs';
import { getSource } from './sources/index.mjs';

helpAndExit(process.argv.slice(2), import.meta.url);
const flags = parseArgs(process.argv.slice(2), ['no-fit', 'legacy-gap']);
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]));
const source = flags.source || 'sim';
if (!['sim', 'anki10k'].includes(source)) { console.error('Use --source sim or --source anki10k.'); process.exit(2); }
const split = flags.split || 'test';
const jobs = Math.max(1, num('jobs', cpus().length));
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
const resultsDir = join(privateDir(), 'results');
try { refuseInsideRepo('the results folder', resultsDir); } catch (e) { console.error(e.message); process.exit(2); }
mkdirSync(resultsDir, { recursive: true });
const git = gitStamp();

// ---------- the models ----------
const modelPath = flags.model || join(privateDir(), source === 'sim' ? 'own-sim-v1.own' : 'own-real-v1.own');
if (!existsSync(modelPath)) { console.error(`No model file at ${modelPath}. Train one first (npm run own:train${source === 'anki10k' ? ':real' : ''}) or pass --model.`); process.exit(2); }
const main = loadModelFile(modelPath);
const labels = {}, models = [{ key: 'own_zero', path: modelPath, finetune: 'own_ft' }];
const shas = { [basename(modelPath)]: sha256OfParams(main.params).slice(0, 12) };
if (source === 'anki10k') {
  if (flags['sim-model']) models.push({ key: 'own_sim', path: flags['sim-model'] });
  else { const s = await loadShippedParams(); if (s) models.push({ key: 'own_sim', params: Array.from(s.params), size: s.size, ablate: [] }); }
}
[].concat(flags.extra || []).forEach((e, i) => {
  const at = e.indexOf('=');
  if (at < 1) { console.error('--extra needs label=FILE'); process.exit(2); }
  const key = `x_${i + 1}`;
  labels[key] = `${e.slice(0, at)} (zero-shot)`;
  models.push({ key, path: e.slice(at + 1) });
  shas[basename(e.slice(at + 1))] = sha256OfParams(loadModelFile(e.slice(at + 1)).params).slice(0, 12);
});
if (source === 'sim') { labels.own_zero = 'Own pretrained, zero-shot'; labels.own_ft = 'Own pretrained + per-learner fine-tune'; }
const ft = { ...FT_DEFAULTS };
for (const [k, f] of [['ft-epochs', 'epochs'], ['ft-lr', 'lr'], ['ft-l2', 'l2']]) if (flags[k] !== undefined) ft[f] = Number(flags[k]);

// ---------- who is evaluated ----------
function plan() {
  if (source === 'sim') {
    const count = num('count', 200), days = flags.days ? String(flags.days).split(',').map(Number) : [40, 150], cfg = { days };
    const mk = sp => Array.from({ length: count }, (_, k) => ({ kind: 'sim', split: sp, k: k + num('seed', 0), config: cfg, key: `${sp}-${k + num('seed', 0)}` }));
    return [{ name: 'test', world: 'own', specs: mk('test') }, { name: 'control', world: 'fsrs', specs: mk('control') }];
  }
  if (!getSource('anki10k').available({}).ok) { console.error('The real data folder is not available.'); process.exit(2); }
  let users = listUsers({}).filter(u => u.split === split);
  if (flags.users) { const want = new Set(String(flags.users).split(',')); users = users.filter(u => want.has(String(u.id))); }
  if (flags.limit) users = users.slice(0, num('limit', 0));
  return [{ name: split, world: null, specs: users.map(u => ({ kind: 'real', id: String(u.id), key: String(u.id), cap: num('cap', 40000), seed: 0, legacyGap: !!flags['legacy-gap'] })) }];
}

function runPool(specs, workerData, onResult) {
  return new Promise((resolve, reject) => {
    let next = 0, finished = 0;
    const workers = [];
    const feed = w => { if (next < specs.length) w.postMessage({ spec: specs[next++] }); else w.terminate(); };
    if (!specs.length) return resolve();
    for (let k = 0; k < Math.min(jobs, specs.length); k++) {
      const w = new Worker(new URL('./eval-worker.mjs', import.meta.url), { workerData, env: { ...process.env, TZ: 'UTC' } });
      workers.push(w);
      w.on('message', r => { onResult(r, ++finished); if (finished === specs.length) { workers.forEach(x => x.terminate()); resolve(); } else feed(w); });
      w.on('error', e => { reject(e); });
      feed(w);
    }
  });
}

const sections = plan();
const rsDir = source === 'anki10k' && existsSync(join(dataRoot({}), 'weights')) ? join(dataRoot({}), 'weights') : null;
const rwkvDir = source === 'anki10k' && existsSync(join(dataRoot({}), 'rwkv-preds')) ? join(dataRoot({}), 'rwkv-preds') : null;
const baseTag = flags.tag || `${source}-${stamp}`;
const summaries = [];
for (const sec of sections) {
  const tag = source === 'sim' ? `${baseTag}-${sec.name}` : `${baseTag}${split === 'test' ? '' : '-' + split}`;
  const file = join(resultsDir, `${tag}.jsonl`);
  const done = new Map();
  if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r.ok) done.set(String(r.user), r); } catch { /* half-written last line */ } }
  const todo = sec.specs.filter(s => !done.has(s.key));
  console.log(`[${sec.name}] ${sec.specs.length} learners, ${done.size} already done, ${todo.length} to do, ${jobs} jobs; model ${basename(modelPath)}; code ${git}`);
  const t0 = Date.now();
  await runPool(todo, { models, ft, rsDir, rwkvDir, fitFsrs: !flags['no-fit'] }, (r, n) => {
    appendFileSync(file, JSON.stringify(r) + '\n');
    done.set(String(r.user), r);
    const el = (Date.now() - t0) / 1000;
    console.log(`${n}/${todo.length} ${r.ok ? `user ${r.user}: ${r.reviews} reviews, ${r.n} held out, ${r.seconds}s` : `user ${r.user}: FAILED ${r.error}`}  (ETA ${Math.round(el / n * (todo.length - n) / 60)} min)`);
  });
  const results = [...done.values()];
  const header = [`Code ${git}; Node ${process.version}; model file ${Object.entries(shas).map(([f, s]) => `${f} (${s})`).join(', ')}; fine-tune: ${ft.epochs} epochs, lr ${ft.lr}, leash ${ft.l2}${source === 'anki10k' ? `; cap ${num('cap', 40000)} rows per user${flags['legacy-gap'] ? '; legacy card gap' : ''}; data licence: ${LICENCE}` : ''}.`];
  if (source === 'anki10k') {
    const rw = results.filter(r => r.rwkv === 'used').length, rwNo = results.filter(r => r.rwkv && r.rwkv !== 'used').length, rs = results.filter(r => r.rs === 'used').length;
    header.push(`Reference rows: fsrs-rs weights matched the split for ${rs} users; outside RWKV predictions lined up for ${rw} users${rwNo ? ` (${rwNo} present but not used)` : ''}.`);
  }
  const { markdown, data } = summarize(results, { source, split: source === 'anki10k' ? split : sec.name, world: sec.world, labels, header });
  const out = join(resultsDir, `summary-${tag}.md`);
  writeFileSync(out, markdown);
  console.log('\n' + markdown + `(saved to ${out})\n`);
  summaries.push({ tag, data });
  if (source === 'anki10k' && split === 'test') {
    const f = join(resultsDir, 'test-runs.json');
    let rec = { runs: 0, log: [] };
    try { rec = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first run */ }
    if (!todo.length && !flags.limit) { /* a re-read of finished results is not a new run */ } else {
      rec.runs++; rec.log.push({ at: new Date().toISOString(), tag, users: results.length, model: shas, code: git, limit: flags.limit ? num('limit', 0) : null });
      writeFileSync(f, JSON.stringify(rec, null, 1));
    }
    console.log(`Test-set runs recorded so far: ${rec.runs} (${f})`);
  }
}
