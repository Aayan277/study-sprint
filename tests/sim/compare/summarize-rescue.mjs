// Summary of the B1 rescue grid (called by `summarize2.mjs <files> new new rescue`; files are joined with commas,
// and a row in a later file replaces the same seed and env from an earlier one).
//
// A cell is (scenario, BREAK, RL, RESCUE, PAUSE, AWAY, learner). Each is paired by seed with the same cell without a
// plan and without AWAY. Pass rules, set before the run (docs/design/round2-plan.md B1):
//   1  RL none, N >= 5: recPeak (largest day's answers after the break) at least 40% lower than base.
//   2  recMeanR, R14, R30end no worse than base by more than 0.5 points in any cell; recLostDays at most +5%.
//   3  RL = 60: no cell worse than -0.3 points on those three.
//   4  Exam deck (Ab): exam-day recall within +-0.2 points.
//   5  Away mode (AWAY=all): R7 up by >= 0.5 points, total reviews up by <= 15%, R30end no worse than -0.3 points.
// A plan is judged on the seeds where the offer fires (rescueOffer: backlog >= 30 and >= 2 x a typical day), because
// elsewhere the app would not show the banner and the run would be identical to base.
// "Cell" = one learner (default / forgetful / strong), one break, one RL, one N, one pause setting; the delta is the mean
// over the seeds, so a failure here is a mean shift, not one unlucky student.
import { readFileSync } from 'node:fs';

const T975 = n => (n >= 30 ? 2.045 : n >= 20 ? 2.09 : n >= 10 ? 2.26 : 2.78);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const ci = a => { if (a.length < 2) return 0; const m = mean(a); return T975(a.length) * Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) / Math.sqrt(a.length); };
const sgn = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
const RLS = ['none', '150', '60'];

function load(files) {
  const map = new Map();
  for (const f of files) for (const l of readFileSync(f, 'utf8').trim().split('\n')) {
    const r = JSON.parse(l);
    map.set(`${r.sc}|${r.le}|${JSON.stringify(r.env)}|${r.seed}`, r);
  }
  return [...map.values()];
}

// Cells for one set of rows: pair every variant with the plain run of the same (scenario, learner, BREAK, RL, CARDS).
function cellsOf(rows) {
  const key = r => `${r.sc}|${r.le}|${r.env.BREAK}|${r.env.RL}|${r.env.CARDS || ''}`;
  const variantOf = e => `${e.RESCUE || 0}|${e.RESCUE ? e.PAUSE : '-'}|${e.AWAY || '-'}`;
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(key(r)) || groups.set(key(r), new Map()).get(key(r));
    const v = variantOf(r.env);
    (g.get(v) || g.set(v, new Map()).get(v)).set(r.seed, r);
  }
  const cells = [];
  for (const [k, g] of groups) {
    const base = g.get('0|-|-');
    if (!base) continue;
    const [sc, le, BREAK, RL, CARDS] = k.split('|');
    for (const [v, seeds] of g) {
      if (v === '0|-|-') continue;
      const [N, PAUSE, AWAY] = v.split('|');
      const ids = [...seeds.keys()].filter(s => base.has(s));
      const planned = +N > 0;
      const use = planned && sc === 'Gb' ? ids.filter(s => seeds.get(s).offered) : ids;
      const c = { sc, le, BREAK: +BREAK, RL, CARDS, N: +N, PAUSE, AWAY, n: use.length, offered: ids.length ? ids.filter(s => seeds.get(s).offered).length / ids.length : 0 };
      if (!use.length) { cells.push({ ...c, empty: true }); continue; }
      const B = use.map(s => base.get(s)), V = use.map(s => seeds.get(s));
      const d = f => V.map((x, i) => f(x) - f(B[i]));
      const has = f => B.every(x => Number.isFinite(f(x))) && V.every(x => Number.isFinite(f(x)));
      const m = f => ({ b: mean(B.map(f)), v: mean(V.map(f)) });
      for (const [name, f] of Object.entries({ recMeanR: x => x.recMeanR, R14: x => x.R14, R30end: x => x.R30end, R7: x => x.R7, Rret: x => x.Rret, meanR: x => x.meanR }))
        if (has(f)) { const dd = d(f); c[name] = { d: mean(dd), h: ci(dd) }; }
      c.peak = m(x => x.recPeak); c.peakCut = 1 - c.peak.v / c.peak.b; c.p90 = m(x => x.recP90);
      c.lost = m(x => x.recLostDays); c.lostPct = c.lost.b > 0 ? c.lost.v / c.lost.b - 1 : 0;
      c.revPct = m(x => x.reviews).v / m(x => x.reviews).b - 1;
      cells.push(c);
    }
  }
  return cells;
}

const avg = (cs, f) => mean(cs.map(f));
const bucketBy = (cs, keyOf) => { const m = new Map(); for (const c of cs) { const k = keyOf(c); (m.get(k) || m.set(k, []).get(k)).push(c); } return m; };
const byBreakRl = (a, b) => a.BREAK - b.BREAK || RLS.indexOf(a.RL) - RLS.indexOf(b.RL) || a.N - b.N;

export default function report(files) {
  const rows = load(files);
  const out = [];
  const main = cellsOf(rows.filter(r => !r.env.CARDS));
  const gb = main.filter(c => c.sc === 'Gb' && !c.empty);

  // ----- the plan -----
  out.push('### The catch-up plan (Gb: 1000 cards, 60 days of study, a break, 30 days back)\n');
  out.push('Averages over the 3 learners; deltas are plan minus no plan, in percentage points (pp) of true recall, paired by seed. "Peak" and "P90" are the largest and the 90th-percentile number of answers in a day after the break.\n');
  const H = ['Break', 'RL', 'N', 'offer fires', 'peak', 'peak cut', 'P90', 'Δ recMeanR', 'Δ R14', 'Δ R30end', 'Δ R7', 'lost-days Δ%', 'reviews Δ%'];
  out.push('| ' + H.join(' | ') + ' |\n|' + '---|'.repeat(H.length));
  const plans = gb.filter(c => c.N > 0 && c.AWAY === '-' && c.PAUSE === '1').sort(byBreakRl);
  for (const [, cs] of bucketBy(plans, c => `${c.BREAK}|${c.RL}|${c.N}`)) {
    const c0 = cs[0], a = f => avg(cs, f);
    out.push('| ' + [c0.BREAK, c0.RL, c0.N, `${(a(c => c.offered) * 100).toFixed(0)}%`, `${a(c => c.peak.b).toFixed(0)}→${a(c => c.peak.v).toFixed(0)}`, `${(a(c => c.peakCut) * 100).toFixed(0)}%`,
      `${a(c => c.p90.b).toFixed(0)}→${a(c => c.p90.v).toFixed(0)}`, sgn(a(c => c.recMeanR.d) * 100), sgn(a(c => c.R14.d) * 100), sgn(a(c => c.R30end.d) * 100), sgn(a(c => c.R7.d) * 100),
      sgn(a(c => c.lostPct) * 100, 1), sgn(a(c => c.revPct) * 100, 1)].join(' | ') + ' |');
  }
  const worstOf = (f, filt) => gb.filter(c => c.N > 0 && c.AWAY === '-' && filt(c)).reduce((w, c) => (f(c) < f(w) ? c : w));
  out.push('');
  const paused = gb.filter(c => c.N > 0 && c.AWAY === '-' && c.PAUSE === '1'), open = gb.filter(c => c.N > 0 && c.AWAY === '-' && c.PAUSE === '0');
  const same = paused.every(c => { const o = open.find(x => x.le === c.le && x.BREAK === c.BREAK && x.RL === c.RL && x.N === c.N); return o && Math.abs(o.recMeanR.d - c.recMeanR.d) < 1e-12; });
  out.push(`Pause new cards on or off ${same ? 'gives identical numbers in this grid, because all 1000 cards are already introduced by the break (see the 2000-card test below)' : 'differs; only pause on is shown'}.`);

  // ----- away mode -----
  out.push('\n### "I\'m away" (review ahead everything that comes due during the break, the day before it starts)\n');
  out.push('Without a plan. Rret is mean true recall on the first day back, before studying (only where the run recorded it).\n');
  const H2 = ['Break', 'RL', 'peak', 'peak cut', 'Δ Rret', 'Δ R7', 'Δ R14', 'Δ R30end', 'Δ recMeanR', 'lost-days Δ%', 'reviews Δ%'];
  out.push('| ' + H2.join(' | ') + ' |\n|' + '---|'.repeat(H2.length));
  const aways = gb.filter(c => c.N === 0 && c.AWAY === 'all').sort(byBreakRl);
  for (const [, cs] of bucketBy(aways, c => `${c.BREAK}|${c.RL}`)) {
    const c0 = cs[0], a = f => avg(cs, f);
    out.push('| ' + [c0.BREAK, c0.RL, `${a(c => c.peak.b).toFixed(0)}→${a(c => c.peak.v).toFixed(0)}`, `${(a(c => c.peakCut) * 100).toFixed(0)}%`,
      cs.every(c => c.Rret) ? sgn(a(c => c.Rret.d) * 100) : '–', sgn(a(c => c.R7.d) * 100), sgn(a(c => c.R14.d) * 100), sgn(a(c => c.R30end.d) * 100), sgn(a(c => c.recMeanR.d) * 100),
      sgn(a(c => c.lostPct) * 100, 1), sgn(a(c => c.revPct) * 100, 1)].join(' | ') + ' |');
  }

  // ----- exam deck -----
  const ab = main.filter(c => c.sc === 'Ab' && !c.empty);
  if (ab.length) {
    out.push('\n### Exam deck (Ab: break from day 26, exam on day 50). Exam decks are exempt from the plan, so a plan changes nothing there by design.\n');
    out.push('| Break | RL | what | Δ exam-day recall (pp), mean of 3 learners | worst learner |\n|---|---|---|---|---|');
    for (const [, cs] of bucketBy(ab.sort(byBreakRl), c => `${c.BREAK}|${c.RL}|${c.N}|${c.AWAY}`)) {
      const c0 = cs[0], worst = cs.reduce((w, c) => (Math.abs(c.meanR.d) > Math.abs(w.meanR.d) ? c : w));
      out.push(`| ${c0.BREAK} | ${c0.RL} | ${c0.N ? `plan N=${c0.N}` : 'away mode'} | ${sgn(avg(cs, c => c.meanR.d) * 100)} | ${sgn(worst.meanR.d * 100)} ± ${(worst.meanR.h * 100).toFixed(2)} (${worst.le}) |`);
    }
  }

  // ----- pause test -----
  const more = cellsOf(rows.filter(r => r.env.CARDS)).filter(c => !c.empty);
  if (more.length) {
    out.push('\n### Does pausing new cards matter? (2000 cards, so new cards are still arriving at the break; break 14, plan N=5)\n');
    out.push('Note: recMeanR, R14 and R30end average over ALL cards, and a card that has not been introduced yet counts as 0. Pausing delays about 25 new cards a day for N days, so those columns fall by roughly that share of the deck while the plan runs; "lost-days" counts only cards that were started.\n');
    out.push('| RL | pause | peak | Δ recMeanR | Δ R14 | Δ R30end | lost-days Δ% | reviews Δ% |\n|---|---|---|---|---|---|---|---|');
    for (const [, cs] of bucketBy(more.sort(byBreakRl), c => `${c.RL}|${c.PAUSE}`)) {
      const c0 = cs[0], a = f => avg(cs, f);
      out.push(`| ${c0.RL} | ${c0.PAUSE === '1' ? 'on' : 'off'} | ${a(c => c.peak.b).toFixed(0)}→${a(c => c.peak.v).toFixed(0)} | ${sgn(a(c => c.recMeanR.d) * 100)} | ${sgn(a(c => c.R14.d) * 100)} | ${sgn(a(c => c.R30end.d) * 100)} | ${sgn(a(c => c.lostPct) * 100, 1)} | ${sgn(a(c => c.revPct) * 100, 1)} |`);
    }
  }

  // ----- the pass rules -----
  const fails = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const failN = new Map();
  const cellsN = new Map();
  const note = (c, rule, text) => {
    fails[rule].push(`break ${c.BREAK}, RL ${c.RL}, N=${c.N}, ${c.le}: ${text}`);
    const set = failN.get(c.N) || failN.set(c.N, new Set()).get(c.N);
    set.add(rule);
    set.cells = (set.cells || new Set()).add(`${c.BREAK}|${c.RL}|${c.le}`);
  };
  const metrics = ['recMeanR', 'R14', 'R30end'];
  for (const c of gb.filter(c => c.N > 0 && c.AWAY === '-' && c.PAUSE === '1')) {
    cellsN.set(c.N, (cellsN.get(c.N) || 0) + 1);
    if (c.RL === 'none' && c.N >= 5 && c.peakCut < 0.4) note(c, 1, `peak cut ${(c.peakCut * 100).toFixed(0)}%`);
    const lim = c.RL === '60' ? -0.003 : -0.005, rule = c.RL === '60' ? 3 : 2;
    for (const mt of metrics) if (c[mt].d < lim) note(c, rule, `${mt} ${sgn(c[mt].d * 100)} pp`);
    if (c.lostPct > 0.05) note(c, 2, `recLostDays ${sgn(c.lostPct * 100, 1)}%`);
  }
  for (const c of ab.filter(c => c.N > 0)) if (Math.abs(c.meanR.d) > 0.002) note(c, 4, `exam-day R ${sgn(c.meanR.d * 100)} pp`);
  for (const c of aways) {
    const bad = [];
    if (c.R7.d < 0.005) bad.push(`R7 ${sgn(c.R7.d * 100)} pp (needs +0.5)`);
    if (c.revPct > 0.15) bad.push(`reviews ${sgn(c.revPct * 100, 1)}%`);
    if (c.R30end.d < -0.003) bad.push(`R30end ${sgn(c.R30end.d * 100)} pp`);
    if (bad.length) fails[5].push(`break ${c.BREAK}, RL ${c.RL}, ${c.le}: ${bad.join(', ')}`);
  }
  out.push('\n### Pass rules (set before the run)\n');
  const names = { 1: 'peak day at least 40% lower (RL none, N >= 5)', 2: 'recovery recall within -0.5 pp and lost days within +5% (RL none and 150)', 3: 'RL 60: no cell worse than -0.3 pp', 4: 'exam day within +-0.2 pp', 5: 'away mode: R7 +0.5 pp, reviews <= +15%, R30end >= -0.3 pp' };
  for (const r of [1, 2, 3, 4, 5]) out.push(`- Rule ${r}, ${names[r]}: ${fails[r].length ? `**FAIL** in ${fails[r].length} check(s)` : 'pass'}`);
  for (const r of [2, 5, 1, 3, 4]) if (fails[r].length) out.push(`\nRule ${r} failures:\n` + fails[r].map(f => '- ' + f).join('\n'));
  out.push('\n### Which N pass rules 1 to 4 everywhere\n');
  for (const N of [3, 5, 7, 10]) {
    const f = failN.get(N);
    out.push(`- N=${N}: ${f ? `fails rule ${[...f].sort().join(', ')} in ${f.cells.size} of ${cellsN.get(N)} cells (3 breaks x RL none/150/60 x 3 learners)` : 'passes'}`);
  }
  const worstR = worstOf(c => c.recMeanR.d, () => true);
  out.push(`\nWorst recMeanR cell: break ${worstR.BREAK}, RL ${worstR.RL}, N=${worstR.N}, ${worstR.le}: ${sgn(worstR.recMeanR.d * 100)} pp.`);
  console.log(out.join('\n'));
}
