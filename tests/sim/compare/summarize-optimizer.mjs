// Paired summary of the FSRS optimizer run (harness2.mjs with OPT=0 and OPT=1; the pass rule, with its amendment, is in report-optimizer.md).
//   node run2.mjs opt.jsonl 30 new G,A default,forgetful,strong '[{"OPT":"0","PLAY_P":"0"},{"OPT":"1","PLAY_P":"0"}]'
//   node summarize-optimizer.mjs opt.jsonl new
// Pairs the same seed with the optimizer off (OPT=0) and on (OPT=1). Prints a table per scenario and the verdict for each rule.
import { readFileSync } from 'node:fs';
const [,, file, copy = 'new'] = process.argv;
const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.v === copy);
const T975 = n => (n >= 30 ? 2.045 : n >= 20 ? 2.09 : n >= 10 ? 2.26 : 2.78);
const stat = a => { a = a.filter(x => x !== null && x !== undefined && Number.isFinite(x)); const n = a.length, m = a.reduce((x, y) => x + y, 0) / n; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1)); return { m, h: T975(n) * sd / Math.sqrt(n), n }; };
const pp = (x, d = 2) => (x * 100).toFixed(d);
const pm = (s, d = 2) => `${pp(s.m, d)} ± ${pp(s.h, d)}`;
const k3 = s => `${(s.m * 1000).toFixed(2)} ± ${(s.h * 1000).toFixed(2)}`;

const cells = new Map();
for (const r of rows) {
  const k = `${r.sc}|${r.le}`;
  if (!cells.has(k)) cells.set(k, { 0: new Map(), 1: new Map() });
  cells.get(k)[r.env.OPT].set(r.seed, r);
}
const verdicts = [];
const note = (ok, text) => verdicts.push({ ok, text });
const lines = [];
for (const sc of ['G', 'A']) {
  const out = [];
  for (const le of ['default', 'forgetful', 'strong']) {
    const c = cells.get(`${sc}|${le}`);
    if (!c) continue;
    const seeds = [...c[0].keys()].filter(s => c[1].has(s));
    const A = seeds.map(s => c[0].get(s)), B = seeds.map(s => c[1].get(s));
    const d = f => stat(A.map((x, i) => (f(x) == null || f(B[i]) == null ? null : f(B[i]) - f(x))));
    const m = f => stat(A.map(f)), mB = f => stat(B.map(f));
    const dMean = d(r => r.meanR), dLong = d(r => r.longR);
    const revA = m(r => r.revR), revB = mB(r => r.revR);
    const reviewsA = m(r => r.reviews).m, reviewsB = mB(r => r.reviews).m;
    const ratio = reviewsB / reviewsA - 1;
    const oos = stat(B.map(r => (r.oos ? r.oos.before - r.oos.after : null)));          // positive = the weights the app would use predict the last 20% better
    const oosRaw = stat(B.map(r => (r.oos ? r.oos.before - r.oos.rawAfter : null)));    // the same if it always took the fit
    const kept = mB(r => r.optKept), runs = mB(r => r.optRuns);
    out.push([le, `${pp(m(r => r.meanR).m)} → ${pp(mB(r => r.meanR).m)}`, pm(dMean), sc === 'G' ? pm(dLong) : '–',
      `${pp(revA.m)} → ${pp(revB.m)}`, `${reviewsA.toFixed(0)} → ${reviewsB.toFixed(0)} (${(ratio * 100).toFixed(1)}%)`,
      `${kept.m.toFixed(1)} / ${runs.m.toFixed(1)}`, k3(oos), k3(oosRaw), String(seeds.length)]);
    const tag = `${sc} / ${le}`;
    if (sc === 'A') {
      // R1 in the exam scenario (unchanged): exam-day recall no worse
      note(dMean.m >= -0.003, `R1 ${tag}: Δ exam-day recall ${pp(dMean.m)} pp (needs ≥ −0.30)`);
      continue;
    }
    // R1 (amended): where the standard weights already recall at least 0.5 pp above target when reviewed, retention above target may be
    // traded for fewer reviews, so R1 does not apply there; "reviews not higher" stands in for it (default: R3 governs instead).
    const aboveTarget = revA.m > 0.905;
    if (!aboveTarget) note(dMean.m >= -0.003 && dLong.m >= -0.003, `R1 ${tag}: Δ mean R ${pp(dMean.m)} pp, Δ long-run R ${pp(dLong.m)} pp (needs ≥ −0.30; baseline recall when reviewed ${pp(revA.m)} ≤ 90.5)`);
    else if (le !== 'default') note(ratio <= 0, `R1' ${tag}: baseline recall when reviewed ${pp(revA.m)} > 90.5, so R1 is replaced by: reviews not higher (${(ratio * 100).toFixed(1)}%); Δ mean R ${pp(dMean.m)} pp shown for information`);
    else note(true, `R1 ${tag}: not applied (baseline recall when reviewed ${pp(revA.m)} > 90.5); R3 governs; Δ mean R ${pp(dMean.m)} pp, Δ long-run R ${pp(dLong.m)} pp shown for information`);
    // R2: recall at the moment of a review is on target (0.90), or at least not further away than the defaults
    const dist = x => Math.abs(x - 0.9);
    const okR2 = le === 'default' ? dist(revB.m) <= dist(revA.m) + 0.005 : dist(revB.m) < dist(revA.m);
    note(okR2, `R2 ${tag}: recall when reviewed ${pp(revA.m)} → ${pp(revB.m)} (target 90; ${le === 'default' ? 'may move away by at most 0.5 pp' : 'must get closer'})`);
    if (le === 'default') note(ratio <= 0.03, `R3 ${tag}: reviews ${(ratio * 100).toFixed(1)}% (needs ≤ +3%)`);
    // R4: out-of-sample log loss of what the app would do (the keep rule included)
    if (le === 'default') note(oos.m >= -0.001, `R4 ${tag}: out-of-sample log loss gain ${k3(oos)} (×10⁻³; must not lose more than 1)`);
    else note(oos.m - oos.h > 0, `R4 ${tag}: out-of-sample log loss gain ${k3(oos)} (×10⁻³; the interval must be above 0)`);
  }
  const H = ['Learner', 'mean true R (pp), off → on', 'Δ mean R pp', 'Δ long-run R pp', 'recall when reviewed, off → on', 'reviews, off → on', 'fits kept / run', 'out-of-sample log loss gain ×10⁻³ (what the app does)', '… if it always took the fit', 'seeds'];
  lines.push(`### Scenario ${sc} (${sc === 'G' ? '500 cards, 120 days, no exam' : '300 cards, exam on day 30'})\n`, '| ' + H.join(' | ') + ' |', '|' + '---|'.repeat(H.length), ...out.map(l => '| ' + l.join(' | ') + ' |'), '');
}
console.log(lines.join('\n'));
console.log('### Pass rule\n');
for (const v of verdicts) console.log(`- ${v.ok ? 'PASS' : 'FAIL'}  ${v.text}`);
console.log(`\n**${verdicts.every(v => v.ok) ? 'All rules pass.' : `${verdicts.filter(v => !v.ok).length} rule(s) fail.`}**`);
