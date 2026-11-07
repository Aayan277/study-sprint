// The pure parts of the evaluation: the pre-registered verdict, the seeded bootstrap, groups, and the aggregate report. No files, no models.
// "Better" was written down before any run (docs/design/own-model.md section 3):
//   mean per-user log-loss difference (Own minus FSRS-6 fitted) is below 0, its 95% bootstrap interval (2,000 resamples over users, seeded)
//   lies entirely below 0, and RMSE is at most 0.01 worse (on average per user). AUC is shown, never a gate.
import { mulberry32, RMSE_SLACK, HOLDOUT_MIN } from '../../js/fsrs-fit.js';
import { fnv1a } from '../../js/rwkv-features.js';

export const BOOT = { resamples: 2000, seed: 20261106, level: 0.95 };
export const CONTROL_TOLERANCE = 0.005;     // in the FSRS-world control Own and FSRS-6 fitted should differ by no more than this
export { RMSE_SLACK, HOLDOUT_MIN };

export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// Percentile bootstrap of the mean of `xs`: resample with replacement (seeded), take the 2.5% and 97.5% points of the resampled means.
export function bootstrapMeanCI(xs, { resamples = BOOT.resamples, seed = BOOT.seed, level = BOOT.level } = {}) {
  const n = xs.length;
  if (!n) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const rng = mulberry32(seed >>> 0), means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rng() * n)];
    means[r] = s / n;
  }
  means.sort();
  const a = (1 - level) / 2, at = q => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))];
  return { mean: mean(xs), lo: at(a), hi: at(1 - a), n };
}

// pairs: [{ user, ll: { own, base }, rmse: { own, base } }] (each a user's number for the two models on the very same reviews)
// -> the pre-registered verdict. Users with fewer than HOLDOUT_MIN held-out reviews must be left out by the caller.
export function verdictOf(diffs, rmseDiffs, opts = {}) {
  const ci = bootstrapMeanCI(diffs, opts);
  const rmse = mean(rmseDiffs);
  const improved = diffs.filter(d => d < 0).length;
  const lossOk = ci.n > 0 && ci.hi < 0;
  const rmseOk = rmse <= RMSE_SLACK;
  return { n: ci.n, meanDiff: ci.mean, lo: ci.lo, hi: ci.hi, rmseMeanDiff: rmse, improvedShare: ci.n ? improved / ci.n : NaN, improved, lossOk, rmseOk, better: lossOk && rmseOk };
}

export const sizeBucket = reviews => (reviews < 5000 ? '<5k' : reviews <= 50000 ? '5k-50k' : '>50k');
export const SIZE_BUCKETS = ['<5k', '5k-50k', '>50k'];

// ---------- the report ----------
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const sgn = (x, d = 4) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : 'n/a');
export const MODEL_NAMES = {
  fsrs6_default: 'FSRS-6 default', fsrs6_fitted: 'FSRS-6 fitted (train part)', fsrs6_rs: 'FSRS-6 fsrs-rs reference',
  own_sim: 'Own (sim weights), zero-shot', own_zero: 'Own, zero-shot', own_ft: 'Own + per-user fine-tune', rwkv: 'RWKV reference (sm72e25)'
};
const nameOf = (key, labels = {}) => labels[key] || MODEL_NAMES[key] || key;

// results: per-user records { user, ok, reviews, hasMeta, n (held-out long reviews), models: { key: { long: { logLoss, rmse, auc, n }, same: {...} } }, rwkv: {...}? }
// opts: { source, split, world ('own'|'fsrs'|null), main: key of the model that is judged, base: key it is judged against, labels, header: [lines] }
// -> { markdown, data }
export function summarize(results, opts = {}) {
  const main = opts.main || 'own_ft', base = opts.base || 'fsrs6_fitted', labels = opts.labels || {};
  const ok = results.filter(r => r.ok), failed = results.length - ok.length;
  const usable = ok.filter(r => (r.n ?? 0) >= HOLDOUT_MIN && r.models[main] && r.models[base]);
  const keys = [...new Set(ok.flatMap(r => Object.keys(r.models)))];
  const order = ['fsrs6_default', 'fsrs6_fitted', 'fsrs6_rs', 'own_sim', 'own_zero', 'own_ft', ...keys.filter(k => !MODEL_NAMES[k]), 'rwkv'];
  const modelKeys = order.filter((k, i) => keys.includes(k) && order.indexOf(k) === i);
  const lines = [];
  const data = { users: results.length, ok: ok.length, failed, usable: usable.length };
  lines.push(`## Evaluation: ${opts.source || '?'}${opts.split ? ` (${opts.split})` : ''}${opts.world ? `, world ${opts.world}` : ''}`);
  for (const h of opts.header || []) lines.push(h);
  lines.push('', `Users: ${results.length} evaluated, ${failed} failed, ${ok.length - usable.length} left out of the comparison (fewer than ${HOLDOUT_MIN} held-out later-day reviews, or a model missing), ${usable.length} compared.`);

  // all models on all of their users
  lines.push('', '### All models (later-day scored reviews after each user\'s cutoff)', '', '| Model | Users | Reviews | Log loss (mean per user) | Log loss (all reviews) | RMSE(20 bins) | AUC |', '|---|---|---|---|---|---|---|');
  data.models = {};
  for (const k of modelKeys) {
    const us = ok.filter(r => r.models[k]?.long && r.models[k].long.n > 0);
    const n = us.reduce((a, r) => a + r.models[k].long.n, 0);
    const row = {
      users: us.length, reviews: n, llUser: mean(us.map(r => r.models[k].long.logLoss)), llAll: us.reduce((a, r) => a + r.models[k].long.logLoss * r.models[k].long.n, 0) / (n || 1),
      rmse: mean(us.map(r => r.models[k].long.rmse)), auc: mean(us.filter(r => r.models[k].long.auc !== null && r.models[k].long.auc !== undefined).map(r => r.models[k].long.auc))
    };
    data.models[k] = row;
    lines.push(`| ${nameOf(k, labels)} | ${row.users} | ${row.reviews} | ${f(row.llUser)} | ${f(row.llAll)} | ${f(row.rmse)} | ${f(row.auc)} |`);
  }

  // the pre-registered comparison, on the users every compared model scored
  const pair = (a, b, set) => {
    const u = set.filter(r => r.models[a]?.long && r.models[b]?.long);
    return { users: u, diffs: u.map(r => r.models[a].long.logLoss - r.models[b].long.logLoss), rmse: u.map(r => r.models[a].long.rmse - r.models[b].long.rmse) };
  };
  const vline = (label, v) => `| ${label} | ${v.n} | ${sgn(v.meanDiff)} | [${sgn(v.lo)}, ${sgn(v.hi)}] | ${sgn(v.rmseMeanDiff)} | ${(v.improvedShare * 100).toFixed(1)}% | ${v.better ? 'BETTER' : 'not better'} |`;
  lines.push('', '### Pre-registered comparison (log-loss difference per user: first model minus second; below 0 is better)', '', '| Comparison | Users | Mean diff | 95% CI (2,000 resamples) | RMSE diff | Users improved | Verdict |', '|---|---|---|---|---|---|---|');
  data.verdicts = {};
  const compare = [[main, base], ['own_zero', 'fsrs6_default'], ['own_zero', 'fsrs6_fitted'], ['own_ft', 'own_zero'], ['own_ft', 'fsrs6_default'], ['own_sim', 'fsrs6_fitted'], ['own_ft', 'fsrs6_rs'], ...modelKeys.filter(k => k.startsWith('x_') || k.startsWith('e_')).map(k => [k, base])];
  const seen = new Set();
  for (const [a, b] of compare) {
    if (a === b || seen.has(a + b) || !modelKeys.includes(a) || !modelKeys.includes(b)) continue;
    seen.add(a + b);
    const p = pair(a, b, ok.filter(r => (r.n ?? 0) >= HOLDOUT_MIN));
    if (!p.diffs.length) continue;
    const v = verdictOf(p.diffs, p.rmse);
    data.verdicts[`${a}|${b}`] = v;
    lines.push(vline(`${nameOf(a, labels)} minus ${nameOf(b, labels)}${a === main && b === base ? ' (the verdict)' : ''}`, v));
  }
  const main2 = data.verdicts[`${main}|${base}`];
  data.verdict = main2 || null;
  lines.push('', main2 ? `**Verdict (${nameOf(main, labels)} against ${nameOf(base, labels)}): ${main2.better ? 'BETTER' : 'NOT BETTER'}.** Mean difference ${sgn(main2.meanDiff)}, interval [${sgn(main2.lo)}, ${sgn(main2.hi)}], RMSE difference ${sgn(main2.rmseMeanDiff)} (limit +${RMSE_SLACK}), ${main2.improved} of ${main2.n} users improved.` : '**No verdict: not enough users with both models.**');
  if (opts.world === 'fsrs') {
    const near = main2 && Math.abs(main2.meanDiff) <= CONTROL_TOLERANCE;
    const leak = main2 && main2.meanDiff < -CONTROL_TOLERANCE;
    lines.push('', `Control world check (Own and FSRS-6 fitted should agree within ${CONTROL_TOLERANCE}): ${!main2 ? 'not enough users to tell.' : near ? 'passed, they are about equal.' : leak ? 'FAILED: Own beats FSRS-6 here by more than the tolerance. Look for a leak before trusting anything.' : 'Own is clearly worse than FSRS-6 here (the model gives up some accuracy when memory is exactly FSRS).'}`);
    data.controlOk = !!near; data.controlLeak = !!leak;
  }

  // groups
  const group = (title, names, pick) => {
    lines.push('', `### ${title}`, '', `| Group | Users | Mean reviews | ${nameOf(main, labels)} minus ${nameOf(base, labels)} | 95% CI | Users improved |`, '|---|---|---|---|---|---|');
    const out = {};
    for (const g of names) {
      const us = usable.filter(r => pick(r) === g);
      if (!us.length) { lines.push(`| ${g} | 0 | | | | |`); continue; }
      const d = us.map(r => r.models[main].long.logLoss - r.models[base].long.logLoss);
      const ci = bootstrapMeanCI(d, { seed: fnv1a('group|' + g) });
      out[g] = { users: us.length, meanDiff: ci.mean, lo: ci.lo, hi: ci.hi, improved: d.filter(x => x < 0).length / d.length };
      lines.push(`| ${g} | ${us.length} | ${Math.round(mean(us.map(r => r.reviews)))} | ${sgn(ci.mean)} | [${sgn(ci.lo)}, ${sgn(ci.hi)}] | ${(out[g].improved * 100).toFixed(1)}% |`);
    }
    return out;
  };
  data.bySize = group('By collection size (all reviews of the user)', SIZE_BUCKETS, r => sizeBucket(r.reviews));
  if (opts.source === 'anki10k') data.byMeta = group('Users with note and deck information against users without', ['has note/deck', 'no note/deck'], r => (r.hasMeta ? 'has note/deck' : 'no note/deck'));

  // same-day rows
  const sames = modelKeys.map(k => ({ k, us: ok.filter(r => r.models[k]?.same && r.models[k].same.n > 0) })).filter(x => x.us.length);
  if (sames.length) {
    lines.push('', '### Same-day reviews (reported separately; FSRS-6 has no same-day curve, so its numbers here are only a reference)', '', '| Model | Users | Reviews | Log loss (all reviews) |', '|---|---|---|---|');
    data.same = {};
    for (const { k, us } of sames) {
      const n = us.reduce((a, r) => a + r.models[k].same.n, 0), ll = us.reduce((a, r) => a + r.models[k].same.logLoss * r.models[k].same.n, 0) / n;
      data.same[k] = { users: us.length, reviews: n, ll };
      lines.push(`| ${nameOf(k, labels)} | ${us.length} | ${n} | ${f(ll)} |`);
    }
  }

  // the RWKV reference: only users that have it, only the very same reviews
  const rw = ok.filter(r => r.rwkvRows && r.models.rwkv?.long?.n >= 1);
  if (rw.length) {
    lines.push('', `### RWKV reference: ${rw.length} users with outside predictions on the same reviews`, '', '| Model | Reviews | Log loss (mean per user) | RMSE | AUC |', '|---|---|---|---|---|');
    const sameKeys = modelKeys.filter(k => rw.every(r => r.rwkvRows[k]));
    data.rwkv = { users: rw.length, models: {} };
    for (const k of sameKeys) {
      const us = rw.map(r => r.rwkvRows[k]);
      const row = { reviews: us.reduce((a, x) => a + x.n, 0), ll: mean(us.map(x => x.logLoss)), rmse: mean(us.map(x => x.rmse)), auc: mean(us.filter(x => x.auc !== null).map(x => x.auc)) };
      data.rwkv.models[k] = row;
      lines.push(`| ${nameOf(k, labels)} | ${row.reviews} | ${f(row.ll)} | ${f(row.rmse)} | ${f(row.auc)} |`);
    }
    lines.push('', '| Comparison on these users | Users | Mean diff | 95% CI | Users improved |', '|---|---|---|---|---|');
    for (const [a, b] of [[main, 'rwkv'], [main, base], ['rwkv', base]]) {
      if (!sameKeys.includes(a) || !sameKeys.includes(b)) continue;
      const d = rw.map(r => r.rwkvRows[a].logLoss - r.rwkvRows[b].logLoss), ci = bootstrapMeanCI(d, { seed: fnv1a('rw|' + a + b) });
      data.rwkv[`${a}|${b}`] = ci;
      lines.push(`| ${nameOf(a, labels)} minus ${nameOf(b, labels)} | ${d.length} | ${sgn(ci.mean)} | [${sgn(ci.lo)}, ${sgn(ci.hi)}] | ${(d.filter(x => x < 0).length / d.length * 100).toFixed(0)}% |`);
    }
  }
  if (opts.notes?.length) lines.push('', ...opts.notes);
  return { markdown: lines.join('\n') + '\n', data };
}
