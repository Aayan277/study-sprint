process.env.TZ = 'UTC';
// The whole synthetic track in one go (npm run own:all):
//   1. sim-report   what the simulator makes and what a perfect predictor would score
//   2. train        on made-up learners (tools/own-model/train.mjs)
//   3. eval         held-out made-up learners and the FSRS-world control (tools/own-model/eval.mjs)
//   4. js/own-params.js is written from the trained model, only when it is within budget and trained on simulator output only
//   node tools/own-model/all.mjs [--learners 500] [--epochs 6] [--days 40,150] [--eval-count 200] [--workers N] [--jobs N] [--seed 1] [--no-write]
// The model and the results go to ~/own-model-private (OWN_PRIVATE), never into the repo; only js/own-params.js is written inside it.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { parseArgs, privateDir } from './common.mjs';
import { paramsModuleFrom } from './params-module.mjs';

const flags = parseArgs(process.argv.slice(2), ['no-write', 'skip-report']);
const here = p => fileURLToPath(new URL(p, import.meta.url));
const run = (script, args) => {
  console.log(`\n$ node tools/own-model/${script} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [here(script), ...args], { stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
  if (r.status !== 0) { console.error(`${script} failed (exit ${r.status}).`); process.exit(r.status || 1); }
};
const days = flags.days || '40,150', cores = String(flags.workers || cpus().length), model = join(privateDir(), 'own-sim-v1.own');
const t0 = Date.now();
if (!flags['skip-report']) run('sim-report.mjs', ['--learners', '24', '--days', days]);
run('train.mjs', ['--source', 'sim', '--sim-train', String(flags.learners || 500), '--epochs', String(flags.epochs || 6), '--sim-days', days, '--workers', cores, '--seed', String(flags.seed || 1), '--out', model]);
run('eval.mjs', ['--source', 'sim', '--model', model, '--count', String(flags['eval-count'] || 200), '--days', days, '--jobs', String(flags.jobs || cores)]);
if (!flags['no-write']) {
  const r = paramsModuleFrom(readFileSync(model));
  if (!r.ok) console.log('\n' + r.reason);
  else { const out = fileURLToPath(new URL('../../js/own-params.js', import.meta.url)); writeFileSync(out, r.text); console.log(`\nWrote js/own-params.js (${r.text.length} bytes, ${r.body.paramCount} parameters, sha256 ${r.body.sha256.slice(0, 12)}). Run node tests/update-sw-hash.mjs and bump CACHE in sw.js before committing.`); }
}
console.log(`\nown:all took ${Math.round((Date.now() - t0) / 60000)} minutes.`);
