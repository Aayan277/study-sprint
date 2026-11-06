process.env.TZ = 'UTC';
// Prints what the simulator makes, and the "oracle" log loss: the loss of a predictor that knows the hidden truth. No model can beat it.
//   node tools/own-model/sim-report.mjs [--learners 24] [--seed 0] [--days 60,400]
// For each world (and each effect switched off, one at a time) it shows, on later-day reviews of the same learners:
//   oracle     log loss using the true recall chance
//   base rate  log loss of one constant chance (the average recall)
//   FSRS-6     log loss of the default FSRS-6 walked over the rows (what the learner's scheduler believes)
//   headroom   FSRS-6 minus oracle: how much a model that finds the hidden pattern could gain at most
import { learners, scoredRows, logLossOf, EFFECTS, SIM_VERSION, DEFAULT_W } from './sim.mjs';
import { buildHistories } from '../../js/fsrs-data.js';
import { evaluate } from '../../js/fsrs-fit.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('learners', 24), SEED = +arg('seed', 1);
const days = arg('days') ? arg('days').split(',').map(Number) : [60, 400];

function run(label, config) {
  const t0 = performance.now();
  let reviews = 0, nLong = 0, nSame = 0, yes = 0, orc = 0, fs = 0, ms = 0, fsN = 0;
  for (const l of learners({ ...config, days, count: N }, SEED)) {
    const { long, same } = scoredRows(l);
    reviews += l.logs.length; nLong += long.length; nSame += same.length;
    for (const r of long) yes += r.y;
    orc += logLossOf(long) * long.length;
    const e = evaluate(buildHistories(l.logs).cards, DEFAULT_W);
    fs += e.logLoss * e.n; fsN += e.n;
  }
  const rate = yes / nLong, base = -(rate * Math.log(rate) + (1 - rate) * Math.log(1 - rate));
  return { label, learners: N, reviews, perLearner: Math.round(reviews / N), long: nLong, same: nSame, recall: rate, oracle: orc / nLong, base, fsrs6: fs / fsN, headroom: fs / fsN - orc / nLong, seconds: (performance.now() - t0) / 1000 };
}

const rows = [run('own, all effects', { world: 'own' }), run('fsrs control', { world: 'fsrs' })];
for (const e of EFFECTS) rows.push(run(`own, no ${e}`, { world: 'own', effects: { [e]: false } }));
console.log(`simulator ${SIM_VERSION}: ${N} learners per row, seeds ${SEED}..${SEED + N - 1}, study period ${days.join(' to ')} days`);
console.log('(log loss on reviews that happen on a later day than the card\'s previous answer; lower is better)\n');
const f = (x, d = 4) => x.toFixed(d);
console.log(['row'.padEnd(26), 'reviews'.padStart(9), 'per learner'.padStart(12), 'recall'.padStart(7), 'oracle'.padStart(8), 'base rate'.padStart(10), 'FSRS-6'.padStart(8), 'headroom'.padStart(9), 'sec'.padStart(5)].join(' '));
for (const r of rows) console.log([r.label.padEnd(26), String(r.reviews).padStart(9), String(r.perLearner).padStart(12), f(r.recall, 3).padStart(7), f(r.oracle).padStart(8), f(r.base).padStart(10), f(r.fsrs6).padStart(8), f(r.headroom).padStart(9), f(r.seconds, 1).padStart(5)].join(' '));
console.log('\nIn the fsrs control the headroom should be close to 0: the true memory is FSRS-6 with slightly different weights.');
