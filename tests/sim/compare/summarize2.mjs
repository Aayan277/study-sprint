// Paired summaries of run2.mjs output: per cell (scenario × learner × env), base vs variant, mean ± 95% CI
// (t·sd/√n over seeds) and the paired Δ. Criterion: the retention metrics (exam-day true R for exam decks; final
// and last-60-day mean true R for non-exam decks; end-of-recovery R for breaks) must not drop by more than 0.3 pp.
//   node summarize2.mjs <file.jsonl> <base> <variant> <kind: play|break> [filter env key=value,...]
// B1 rescue grid (one copy, the env decides the variant; several files may be joined with commas):
//   node summarize2.mjs <gb.jsonl,ab.jsonl> new new rescue
import { readFileSync } from 'node:fs';
const [,, file, base, cmp, kind = 'play', filt = ''] = process.argv;
if (kind === 'rescue') { await import('./summarize-rescue.mjs').then(m => m.default(file.split(','))); process.exit(0); }
const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const filters = filt ? filt.split(',').map(x => x.split('=')) : [];
const T975 = n => (n >= 30 ? 2.045 : n >= 20 ? 2.09 : n >= 10 ? 2.26 : 2.78);
const stat = a => { a = a.filter(x => x !== null && Number.isFinite(x)); const n = a.length, m = a.reduce((x, y) => x + y, 0) / n; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1)); return { m, h: T975(n) * sd / Math.sqrt(n), n }; };
const envKey = e => Object.entries(e).sort().map(([k, v]) => `${k}=${v}`).join(' ') || '-';
const groups = new Map();
for (const r of rows) {
  if (filters.some(([k, v]) => String(r.env[k] ?? '') !== v)) continue;
  const k = `${r.sc}|${r.le}|${envKey(r.env)}`;
  if (!groups.has(k)) groups.set(k, {});
  (groups.get(k)[r.v] ||= new Map()).set(r.seed, r);
}
const pp = (s, d = 2) => `${(s.m * 100).toFixed(d)} ± ${(s.h * 100).toFixed(d)}`;
const nn = (s, d = 0) => `${s.m.toFixed(d)} ± ${s.h.toFixed(d)}`;
const ratio = (a, b) => (b > 0 ? a / b : null);
const M = kind === 'play' ? {
  ret: r => r.meanR, long: r => r.longR,
  acc: r => ratio(r.play.accApplied, r.play.nApplied), accAll: r => ratio(r.play.acc, r.play.corr), acc2: r => (r.play.acc2Applied === undefined ? null : ratio(r.play.acc2Applied, r.play.nApplied)),
  hardPct: r => ratio(r.play.given[2], r.play.nApplied), easyPct: r => ratio(r.play.given[4], r.play.nApplied),
  reviews: r => r.reviews, answers: r => r.answers, mcDue: r => r.play.mcDueApplied, over: r => r.over, p80: r => r.p80
} : {
  ret: r => r.meanR, recR: r => r.recMeanR, R7: r => r.R7 ?? null, cleared: r => r.recCleared, lost: r => r.recLostDays,
  endLost: r => r.endLost, recReviews: r => r.recReviews, recLapses: r => r.recLapses, pre: r => r.preBreakR ?? null, backlog0: r => r.recBacklog0
};
const out = [], fails = [], worst = { d: Infinity, cell: '' };
for (const [k, g] of [...groups].sort()) {
  if (!g[base] || !g[cmp]) continue;
  const [sc, le, ek] = k.split('|');
  const seeds = [...g[base].keys()].filter(s => g[cmp].has(s));
  const A = seeds.map(s => g[base].get(s)), B = seeds.map(s => g[cmp].get(s));
  const S = (arr, f) => stat(arr.map(f));
  const D = f => stat(A.map((x, i) => { const a = f(x), b = f(B[i]); return a === null || b === null ? null : b - a; }));
  const noExam = A[0].longR !== null && A[0].longR !== undefined || sc.startsWith('G');
  const checks = kind === 'play' ? (noExam ? ['ret', 'long'] : ['ret']) : (noExam ? ['ret', 'recR'] : ['ret']);
  for (const c of checks) {
    const d = D(M[c]);
    if (d.m < worst.d) { worst.d = d.m; worst.cell = `${sc}/${le}/${ek} ${c}`; worst.h = d.h; }
    if (d.m < -0.003) fails.push(`${sc} / ${le} / ${ek}: Δ ${c} = ${(d.m * 100).toFixed(2)} ± ${(d.h * 100).toFixed(2)} pp`);
  }
  const dR = D(M.ret);
  if (kind === 'play') {
    const dL = noExam ? D(M.long) : null;
    out.push([sc, le, ek, pp(S(A, M.ret)), pp(S(B, M.ret)), `${(dR.m * 100).toFixed(2)} ± ${(dR.h * 100).toFixed(2)}`,
      noExam ? `${(dL.m * 100).toFixed(2)} ± ${(dL.h * 100).toFixed(2)}` : '–',
      pp(S(A, M.acc), 1), pp(S(B, M.acc), 1), pp(S(A, M.accAll), 1), pp(S(B, M.accAll), 1),
      pp(S(A, M.hardPct), 1), pp(S(B, M.hardPct), 1), pp(S(A, M.easyPct), 1), pp(S(B, M.easyPct), 1),
      nn(S(A, M.reviews)), nn(D(M.reviews)), nn(S(A, M.mcDue), 1), nn(S(B, M.mcDue), 1), `${(S(A, M.over).m * 100).toFixed(2)} / ${(S(B, M.over).m * 100).toFixed(2)}`]);
  } else {
    const dRec = D(M.recR), dC = D(M.cleared), dLost = D(M.lost), dW = D(M.recReviews);
    out.push([sc, le, ek, pp(S(A, M.ret)), pp(S(B, M.ret)), `${(dR.m * 100).toFixed(2)} ± ${(dR.h * 100).toFixed(2)}`,
      `${(dRec.m * 100).toFixed(2)} ± ${(dRec.h * 100).toFixed(2)}`, A[0].R7 != null ? `${(D(M.R7).m * 100).toFixed(2)} ± ${(D(M.R7).h * 100).toFixed(2)}` : '–',
      nn(S(A, M.backlog0)), nn(S(A, M.cleared), 1), nn(S(B, M.cleared), 1), nn(dC, 1),
      nn(S(A, M.lost)), nn(S(B, M.lost)), nn(dLost), nn(S(A, M.endLost), 1), nn(S(B, M.endLost), 1),
      nn(S(A, M.recReviews)), nn(dW), nn(D(M.recLapses))]);
  }
}
const H = kind === 'play'
  ? ['Deck', 'Learner', 'Play', `R ${base}`, `R ${cmp}`, 'Δ R pp', 'Δ long-run R pp', `acc ${base}`, `acc ${cmp}`, `acc(all) ${base}`, `acc(all) ${cmp}`, `Hard% ${base}`, `Hard% ${cmp}`, `Easy% ${base}`, `Easy% ${cmp}`, `reviews ${base}`, 'Δ reviews', `MC-due ${base}`, `MC-due ${cmp}`, 'app−true R pp']
  : ['Deck', 'Learner', 'Env', `R end ${base}`, `R end ${cmp}`, 'Δ R end pp', 'Δ R recovery-avg pp', 'Δ R +7d pp', 'backlog', `days ${base}`, `days ${cmp}`, 'Δ days', `card-days R<.5 ${base}`, `${cmp}`, 'Δ', `lost at end ${base}`, `${cmp}`, `recovery reviews ${base}`, 'Δ reviews', 'Δ lapses'];
console.log(`### ${cmp} vs ${base}\n`);
console.log('| ' + H.join(' | ') + ' |\n|' + '---|'.repeat(H.length));
for (const l of out) console.log('| ' + l.join(' | ') + ' |');
console.log(`\nWorst cell: ${worst.cell}: ${(worst.d * 100).toFixed(2)} ± ${((worst.h || 0) * 100).toFixed(2)} pp`);
console.log('Criterion failures (Δ < −0.3 pp):\n' + (fails.length ? fails.map(f => '- ' + f).join('\n') : '- none') + '\n');
