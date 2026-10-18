// Summarise results.jsonl (from run.mjs) into summary.md: per scenario and test set, per model and paired comparisons.
//   node tests/realdata/summarize.mjs [results.jsonl] [summary.md]
// Only aggregate numbers are written; nothing that identifies a user's cards.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mulberry32 } from '../../js/fsrs-fit.js';
import { refuseInsideRepo } from './lib.mjs';

const ROOT = process.env.FSRS_DATA || join(homedir(), 'fsrs-data');
const inFile = process.argv[2] || join(ROOT, 'results', 'results.jsonl');
const outFile = process.argv[3] || join(ROOT, 'results', 'summary.md');
refuseInsideRepo('the data folder (FSRS_DATA)', ROOT);
refuseInsideRepo('the summary output path', outFile);
const MODELS = ['base_rate', 'fsrs6_default', 'fsrs6_tuned', 'fsrs6_app', 'fsrs7_default', 'fsrs6_rs', 'fsrs7_rs'];
const PAIRS = [['fsrs7_default', 'fsrs6_default'], ['fsrs7_default', 'fsrs6_app'], ['fsrs7_default', 'fsrs6_tuned'], ['fsrs6_tuned', 'fsrs6_default'],
  ['fsrs6_app', 'fsrs6_default'], ['fsrs6_rs', 'fsrs6_tuned'], ['fsrs6_rs', 'fsrs6_default'], ['fsrs7_rs', 'fsrs7_default'], ['fsrs7_rs', 'fsrs6_rs'],
  ['fsrs7_rs', 'fsrs6_tuned'], ['fsrs7_rs', 'fsrs6_app'], ['fsrs7_default', 'base_rate'], ['fsrs7_rs', 'base_rate'], ['fsrs6_app', 'base_rate']];
const METRICS = [['logLoss', 'log loss', false], ['rmse', 'RMSE (bins)', false], ['auc', 'AUC', true]];     // [key, label, higherIsBetter]
const MIN_N = 30;                       // a user needs this many scored reviews in a set to count (a handful gives a meaningless average)

// last line per user wins (a retried user replaces its error line)
const byUser = new Map();
for (const l of readFileSync(inFile, 'utf8').split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); byUser.set(r.user, r); } catch { /* half-written line */ } }
const users = [...byUser.values()];
const stamps = new Map();
for (const u of users) stamps.set(u.stamp || 'none', (stamps.get(u.stamp || 'none') || 0) + 1);
const errors = users.filter(u => u.error);
const ok = users.filter(u => !u.error);

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) + '%' : '-');

function bootstrapCI(diffs, resamples = 2000) {
  const rng = mulberry32(12345), n = diffs.length, means = [];
  for (let r = 0; r < resamples; r++) { let s = 0; for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)]; means.push(s / n); }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * resamples)], means[Math.min(resamples - 1, Math.floor(0.975 * resamples))]];
}

// one value per user for (scenario, set, model, metric), only for users with enough reviews and a defined value
const column = (scn, set, model, key) => {
  const out = new Map();
  for (const u of ok) {
    const m = u.scenarios?.[scn]?.models?.[model]?.[set];
    if (m && m.n >= MIN_N && Number.isFinite(m[key])) out.set(u.user, { v: m[key], n: m.n });
  }
  return out;
};

const lines = [];
const out = s => lines.push(s);
out('# FSRS real-data check');
out('');
out(`Users in the file: ${users.length} (${ok.length} scored, ${errors.length} with an error). A user counts in a set only with at least ${MIN_N} scored reviews there.`);
out('`long` = reviews on a later day than the card\'s previous review (what the app predicts). `same` = repeats on the same Anki day;');
out('FSRS-6 has no real same-day prediction (the app uses learning steps); its number there uses the fractional gap on a curve made for days used at minutes, and is kept only for reference.');
out('`base_rate` is a constant: the recall rate of the user\'s train half (separately for long and same-day reviews), so AUC is 0.5 by construction.');
out('Lower is better for log loss and RMSE, higher for AUC. Difference = first model minus second.');
out(`Code version of the results: ${[...stamps].map(([k, v]) => `${k} (${v} users)`).join(', ')}`);
if (stamps.size > 1) { out(''); out('**WARNING: this file mixes results from different code versions. Do not compare its numbers; rerun into a fresh file.**'); console.error('WARNING: results file mixes code versions: ' + [...stamps.keys()].join(', ')); }
const warned = ok.filter(u => u.warnings?.length).length;
if (warned) { out(''); out(`**WARNING: ${warned} users had fsrs-rs weights for another split, which were skipped (first: ${ok.find(u => u.warnings?.length).warnings[0]})**`); console.error(`WARNING: ${warned} users had stale fsrs-rs weights`); }
out('');
const rowsAll = ok.reduce((a, u) => a + (u.rawRows || 0), 0);
out(`Reviews in the scored users' logs: ${rowsAll.toLocaleString('en')}. Cards skipped (history did not start at new): ${ok.reduce((a, u) => a + (u.scenarios?.full?.skipped || 0), 0).toLocaleString('en')}. Users capped: ${ok.filter(u => u.scenarios?.full?.capped).length}.`);
if (errors.length) out(`Errors: ${errors.map(e => `${e.user}: ${e.error.split('\n')[0].slice(0, 80)}`).join('; ')}`);
out('');

for (const scn of ['full', 'first1000', 'first5000']) {
  const have = ok.filter(u => u.scenarios?.[scn]);
  if (!have.length) continue;
  out(`## Scenario: ${scn} (${have.length} users)`);
  out('');
  // how often the app's keep rule kept its fit
  const st = new Map();
  for (const u of have) { const m = u.scenarios[scn].models.fsrs6_app; if (m) { const k = m.status + (m.reason ? ` (${m.reason})` : ''); st.set(k, (st.get(k) || 0) + 1); } }
  out(`fsrs6_app outcome: ${[...st].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  const tr = new Map();
  for (const u of have) { const m = u.scenarios[scn].models.fsrs6_tuned; if (m) tr.set(m.status, (tr.get(m.status) || 0) + 1); }
  out(`fsrs6_tuned status: ${[...tr].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  out(`Users dropped by the >= ${MIN_N} scored-reviews filter: ${['long', 'same'].map(set => `${set} ${have.filter(u => !(u.scenarios[scn].models.fsrs6_default?.[set]?.n >= MIN_N)).length}`).join(', ')}`);
  out('');
  for (const set of ['long', 'same']) {
    out(`### ${scn} / ${set}`);
    out('');
    out('| model | users | metric | mean | weighted mean | median |');
    out('|---|---:|---|---:|---:|---:|');
    for (const model of MODELS) {
      for (const [key, label] of METRICS) {
        const col = column(scn, set, model, key);
        if (!col.size) continue;
        const vals = [...col.values()], wsum = vals.reduce((a, x) => a + x.n, 0);
        out(`| ${model} | ${col.size} | ${label} | ${f(mean(vals.map(x => x.v)))} | ${f(vals.reduce((a, x) => a + x.v * x.n, 0) / wsum)} | ${f(median(vals.map(x => x.v)))} |`);
      }
    }
    out('');
    out('| first vs second | metric | users | mean diff | 95% CI (bootstrap over users) | relative | first better | tied |');
    out('|---|---|---:|---:|---|---:|---:|---:|');
    for (const [a, b] of PAIRS) {
      for (const [key, label, higher] of METRICS) {
        const ca = column(scn, set, a, key), cb = column(scn, set, b, key);
        const diffs = [], base = [];
        let better = 0, tied = 0;
        for (const [user, x] of ca) { const y = cb.get(user); if (!y) continue; diffs.push(x.v - y.v); base.push(y.v); if (Math.abs(x.v - y.v) < 1e-12) tied++; else if (higher ? x.v > y.v : x.v < y.v) better++; }
        if (diffs.length < 2) continue;
        const [lo, hi] = bootstrapCI(diffs);
        out(`| ${a} vs ${b} | ${label} | ${diffs.length} | ${f(mean(diffs), 5)} | [${f(lo, 5)}, ${f(hi, 5)}] | ${pct(100 * mean(diffs) / mean(base))} | ${(100 * better / diffs.length).toFixed(1)}% | ${(100 * tied / diffs.length).toFixed(1)}% |`);
      }
    }
    out('');
  }
}
const text = lines.join('\n') + '\n';
writeFileSync(outFile, text);
console.log(text);
