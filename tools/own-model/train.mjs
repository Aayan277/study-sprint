process.env.TZ = 'UTC';
// Train the Own model.   node tools/own-model/train.mjs --source sim|anki10k|sim+anki10k [options]
//   --source        sim (made-up learners, ours), anki10k (real logs from the data folder), or sim+anki10k (both mixed)
//   --size s|m      memory size (s ships; m is a research size)
//   --cap N         real data: at most N rows per user, thinned by whole cards (default 40000)
//   --users-per-epoch N   use only N (seeded, different each epoch) of the train users per epoch (default: all)
//   --epochs N, --seed N, --workers N (default: all cores)
//   --init FILE     start from this .own model (for example the sim model, then real data)
//   --ablate=user,note,deck,decay   switch parts off, to see what they add
//   --out FILE      where to write the model. Never inside the repo. Default: ~/own-model-private/ (override: OWN_PRIVATE)
//   --legacy-gap    real data: keep the old card gap that still contains the answer's own duration (only to repeat a model trained before the fix)
//   --ema D         keep a moving average of the weights (decay D, 0 = off, typical 0.999); validation and the saved model use the average
//   --resume        continue from the checkpoint next to --out (<out>.ckpt) after a stop
//   more: --lr --lr-end --clip --l2 --batch --chunk --patience --val-users --val-cap --sim-train --sim-val --sim-days a,b
import { join } from 'node:path';
import { train, DEFAULTS, SOURCE_IDS } from './train-core.mjs';
import { privateDir, refuseInsideRepo, helpAndExit } from './common.mjs';

helpAndExit(process.argv.slice(2), import.meta.url);
const argv = process.argv.slice(2), flags = {};
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { console.error(`Unexpected argument: ${argv[i]}`); process.exit(2); }
  if (m[2] !== undefined) flags[m[1]] = m[2];
  else if (['resume', 'quiet', 'legacy-gap'].includes(m[1])) flags[m[1]] = true;
  else flags[m[1]] = argv[++i];
}
const num = (k, d) => (flags[k] === undefined ? d : Number(flags[k]));
const source = flags.source || DEFAULTS.source;
if (!SOURCE_IDS.includes(source)) { console.error(`Unknown --source ${source}. Use ${SOURCE_IDS.join(', ')}.`); process.exit(2); }
const defaultName = { sim: 'own-sim-v1.own', anki10k: 'own-real-v1.own', 'sim+anki10k': 'own-simreal-v1.own' }[source];
const cfg = {
  source, size: flags.size || DEFAULTS.size, cap: num('cap', DEFAULTS.cap), epochs: num('epochs', DEFAULTS.epochs), seed: num('seed', DEFAULTS.seed),
  workers: num('workers', DEFAULTS.workers), lr: num('lr', DEFAULTS.lr), lrEnd: num('lr-end', DEFAULTS.lrEnd), clip: num('clip', DEFAULTS.clip), l2: num('l2', DEFAULTS.l2),
  batch: num('batch', DEFAULTS.batch), chunk: num('chunk', DEFAULTS.chunk), patience: num('patience', DEFAULTS.patience), usersPerEpoch: num('users-per-epoch', 0),
  ema: num('ema', DEFAULTS.ema), valUsers: num('val-users', DEFAULTS.valUsers), valCap: num('val-cap', DEFAULTS.valCap), simTrain: num('sim-train', DEFAULTS.simTrain), simVal: num('sim-val', DEFAULTS.simVal),
  init: flags.init || null, ablate: flags.ablate ? String(flags.ablate).split(',').filter(Boolean) : [], resume: !!flags.resume, legacyGap: !!flags['legacy-gap'], quiet: !!flags.quiet,
  out: flags.out || join(privateDir(), defaultName)
};
if (flags['sim-days']) cfg.simConfig = { days: String(flags['sim-days']).split(',').map(Number) };
try {
  refuseInsideRepo('--out', cfg.out);
  await train(cfg);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
