// Summaries of run.mjs output: means with 95% CIs per version, paired differences vs a base version, verdict.
//   node summarize.mjs <results.json> [base=v30] [cmp=v31]
import { readFileSync } from 'node:fs';
const [,, file, base = 'v30', cmp = 'v31'] = process.argv;
const R = JSON.parse(readFileSync(file, 'utf8'));
const T975 = n => (n >= 30 ? 2.045 : n >= 20 ? 2.09 : 2.26);
const stat = a => { const n = a.length, m = a.reduce((x, y) => x + y, 0) / n; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1)); return { m, h: T975(n) * sd / Math.sqrt(n), n }; };
const pct = (s, d = 2) => `${(s.m * 100).toFixed(d)} ± ${(s.h * 100).toFixed(d)}`;
const num = (s, d = 0) => `${s.m.toFixed(d)} ± ${s.h.toFixed(d)}`;
const groups = new Map();
for (const r of R) { const k = `${r.sc}|${r.le}`; if (!groups.has(k)) groups.set(k, {}); (groups.get(k)[r.v] ||= []).push(r); }
const sc0 = [...new Set(R.map(r => r.sc))];
const rows = [], fails = [];
console.log(`| Scenario | Learner | mean exam-day true R ${base} | ${cmp} | Δ (paired, pp) | ≥80% ${base} | ${cmp} | Δ pp | ≥90% ${base} | ${cmp} | score ${base} | ${cmp} | reviews ${base} | ${cmp} | last 5 d ${base} | ${cmp} | max/day ${base} | ${cmp} | eve ${base} | ${cmp} | left after exam (needed) ${cmp} | leeches ${base}/${cmp} |`);
console.log('|' + '---|'.repeat(22));
for (const sc of sc0) for (const le of ['default', 'forgetful', 'strong']) {
  const g = groups.get(`${sc}|${le}`); if (!g || !g[base] || !g[cmp]) continue;
  const a = g[base].sort((x, y) => x.seed - y.seed), b = g[cmp].sort((x, y) => x.seed - y.seed);
  const S = (arr, f) => stat(arr.map(f));
  const D = f => stat(a.map((x, i) => f(b[i]) - f(x)));
  const noExam = a[0].eve === undefined;
  const dR = D(x => x.meanR), d80 = D(x => x.p80);
  const line = [sc, le, pct(S(a, x => x.meanR)), pct(S(b, x => x.meanR)), `${(dR.m * 100).toFixed(2)} ± ${(dR.h * 100).toFixed(2)}`,
    pct(S(a, x => x.p80), 1), pct(S(b, x => x.p80), 1), `${(d80.m * 100).toFixed(2)}`,
    pct(S(a, x => x.p90), 1), pct(S(b, x => x.p90), 1), pct(S(a, x => x.score), 1), pct(S(b, x => x.score), 1),
    num(S(a, x => x.reviews)), num(S(b, x => x.reviews)),
    noExam ? '–' : num(S(a, x => x.last5)), noExam ? '–' : num(S(b, x => x.last5)),
    num(S(a, x => x.maxDaily)), num(S(b, x => x.maxDaily)),
    noExam ? '–' : num(S(a, x => x.eve)), noExam ? '–' : num(S(b, x => x.eve)),
    noExam ? '–' : `${S(b, x => x.afterNeed).m.toFixed(2)} (max ${Math.max(...b.map(x => x.afterNeed))})`,
    `${S(a, x => x.suspended).m.toFixed(2)}/${S(b, x => x.suspended).m.toFixed(2)}`];
  console.log('| ' + line.join(' | ') + ' |');
  if (noExam) { if (Math.abs(dR.m) >= 0.005) fails.push(`${sc}/${le}: |Δ retention| = ${(dR.m * 100).toFixed(2)} pp ≥ 0.5`); }
  else {
    if (dR.m < -0.005) fails.push(`${sc}/${le}: Δ mean R = ${(dR.m * 100).toFixed(2)} pp < −0.5`);
    if (d80.m < -0.01) fails.push(`${sc}/${le}: Δ ≥80% = ${(d80.m * 100).toFixed(2)} pp < −1`);
  }
}
console.log('\nCriterion failures:\n' + (fails.length ? fails.map(f => '- ' + f).join('\n') : '- none'));
