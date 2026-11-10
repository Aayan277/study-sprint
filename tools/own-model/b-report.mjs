// Part B report: plain-words aggregate tables from the replay and shadow result files.
//   node tools/own-model/b-report.mjs --kind replay|shadow --tags a,b,c [--out NAME]
// Reads ~/own-model-private/results/<kind>-<tag>.jsonl (override: OWN_PRIVATE), writes b-report-<NAME>.md next to them and prints it.
// Aggregates only: no per-user row and no user id is ever written or printed.
// Of a result file only the records of its last settings (cfg) count, one per user (the last one).
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir, parseArgs, refuseInsideRepo } from './common.mjs';
import { ivShares, bandShare, PERIODS, LOG2_BINS, LOG2_LO, LOG2_STEP } from './replay-core.mjs';
import { falseBetter, returnsByWhy, variantKey, SHIPPED } from './shadow-core.mjs';

const finite = xs => xs.filter(Number.isFinite);
const mean = xs => { const a = finite(xs); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; };
const median = xs => { const a = finite(xs).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const pc = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : 'n/a');
const row = cells => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

// the records of one result file: those with the last cfg, one per user (the last one), ok only
// info (optional): gets `dropped`, the number of ok records left out because they were made with other settings than the last one (or were replaced by a later record of the same user is NOT counted)
export function parseResults(text, info = {}) {
  const all = [];
  for (const l of text.split('\n')) { if (!l) continue; try { all.push(JSON.parse(l)); } catch { /* half-written last line */ } }
  const okRecs = all.filter(r => r && r.ok);
  if (!okRecs.length) return [];
  const cfg = okRecs[okRecs.length - 1].cfg, byUser = new Map();
  info.dropped = 0;
  for (const r of okRecs) if (r.cfg === cfg) byUser.set(String(r.user), r); else info.dropped++;
  return [...byUser.values()];
}
export const droppedWarning = (tag, n) => `WARNING: tag ${tag}: ${n} result line${n === 1 ? '' : 's'} made with other settings than the last one ${n === 1 ? 'was' : 'were'} left out. Only the last settings count.`;
export function loadResults(kind, tag, dir = join(privateDir(), 'results'), info = {}) {
  const file = join(dir, `${kind}-${tag}.jsonl`);
  if (!existsSync(file)) throw new Error(`No results file for tag "${tag}" (${kind}).`);
  return parseResults(readFileSync(file, 'utf8'), info);
}

// ---------- replay ----------
const parseKey = k => { const [truth, sched, R] = k.split('|'); return { truth, sched, R: Number(R) }; };
const sortKeys = keys => keys.map(k => ({ k, ...parseKey(k) })).sort((a, b) => (a.truth < b.truth ? -1 : a.truth > b.truth ? 1 : a.sched === b.sched ? a.R - b.R : a.sched === 'own' ? -1 : 1));
const label = o => `${o.truth} / ${o.sched === 'own' ? 'Own' : 'FSRS'} / R ${o.R.toFixed(2)}`;

// paired histogram -> shares. Within-20%: the two bins next to 0 (-0.5..0 and 0..+0.5) are taken in proportion (assuming an even spread inside a bin):
// the part of each bin with |log2| <= log2(1.2). Two-times apart: |log2| >= 1, whole bins only (1 is a bin edge); the two end bins hold everything beyond +-6.
export function pairedShares(hist) {
  const n = hist.reduce((a, b) => a + b, 0), lim = Math.log2(1.2);
  let within = 0, far = 0;
  for (let i = 0; i < LOG2_BINS; i++) {
    const lo = LOG2_LO + i * LOG2_STEP, hi = lo + LOG2_STEP;
    const overlap = Math.max(0, Math.min(hi, lim) - Math.max(lo, -lim));
    within += hist[i] * overlap / LOG2_STEP;
    if (hi <= -1 || lo >= 1) far += hist[i];
  }
  return { n, within: n ? within / n : NaN, far: n ? far / n : NaN };
}

// everything per (truth, sched, R) over the users of one tag
export function replayCells(records) {
  const keys = [...new Set(records.flatMap(r => Object.keys(r.runs || {})))];
  const cells = new Map();
  for (const key of keys) {
    const runs = records.map(r => r.runs?.[key]).filter(Boolean);
    const per = PERIODS.map((_, i) => mean(runs.map(r => (r.periods?.[i]?.days > 0 ? r.periods[i].reviews / r.periods[i].days : NaN))));
    const days = runs.map(r => (r.periods || []).reduce((a, p) => a + p.days, 0)), revs = runs.map(r => (r.periods || []).reduce((a, p) => a + p.reviews, 0));
    const ivs = runs.filter(r => r.iv && r.iv.n > 0);
    const sh = ivs.map(r => ivShares(r.iv));
    const pairedRuns = runs.filter(r => r.paired?.hist);
    const hist = new Array(LOG2_BINS).fill(0);
    for (const r of pairedRuns) r.paired.hist.forEach((c, i) => { hist[i] += c; });
    const comparable = ivs.reduce((a, r) => a + r.iv.comparable, 0), shrinks = ivs.reduce((a, r) => a + r.iv.shrinks, 0);
    const cardsAll = ivs.reduce((a, r) => a + r.iv.cards, 0), cards2 = ivs.reduce((a, r) => a + r.iv.cardsShrink2, 0);
    const bands = runs.filter(r => r.bandTotal > 0);
    cells.set(key, {
      key, n: runs.length, perPeriod: per, perDayAll: mean(runs.map((r, i) => (days[i] > 0 ? revs[i] / days[i] : NaN))),
      meanP: mean(runs.map(r => r.meanP)), lapses: mean(runs.map(r => r.lapses)),
      p10: median(ivs.map(r => r.iv.p10)), p50: median(ivs.map(r => r.iv.p50)), p90: median(ivs.map(r => r.iv.p90)), p99: median(ivs.map(r => r.iv.p99)),
      ge365: mean(sh.map(s => s.ge365)), ge3650: mean(sh.map(s => s.ge3650)), atMax: mean(sh.map(s => s.atMax)), one: mean(sh.map(s => s.one)),
      paired: pairedRuns.length ? { ...pairedShares(hist), users: pairedRuns.length } : null,
      shrink: comparable ? shrinks / comparable : NaN, cards2: cardsAll ? cards2 / cardsAll : NaN,
      band: bands.length ? mean(bands.map(bandShare)) : NaN, bandUsers: bands.length
    });
  }
  return cells;
}

export function replayReport(tags, recordsByTag) {
  const L = ['# Replay report', '', `Tags: ${tags.join(', ')}. Every number is a mean across users unless it says median; n is the number of users with that run.`, ''];
  const cellsByTag = tags.map(t => replayCells(recordsByTag[t]));
  tags.forEach((tag, ti) => {
    const cells = cellsByTag[ti];
    if (tags.length > 1) L.push(`## Tag ${tag}`, '');
    const ks = sortKeys([...cells.keys()]);
    L.push(`### Reviews per day (reviews divided by days), memory and lapses${tags.length > 1 ? '' : ` (${tag})`}`, '');
    L.push('The per-period and "Days 2-end" counts include the first answers of new cards and the repeats after a failure; the headline `reviews` of a run leaves first answers out, so the two are not the same number.', '');
    L.push(`Retention range across truths: for the same scheduler and R, the highest minus the lowest mean retention over the truths (0 when only one truth was run).`, '');
    const rng = new Map();
    for (const o of ks) {
      const same = ks.filter(p => p.sched === o.sched && p.R === o.R).map(p => cells.get(p.k).meanP);
      rng.set(o.k, finite(same).length ? Math.max(...finite(same)) - Math.min(...finite(same)) : NaN);
    }
    L.push(table(['Truth / scheduler / R', 'Users', ...PERIODS.map(([a, b]) => `Days ${a}-${b}`), 'Days 2-end', 'Mean retention', 'Range across truths', 'Lapses per user'],
      ks.map(o => { const c = cells.get(o.k); return [label(o), c.n, ...c.perPeriod.map(x => f(x)), f(c.perDayAll), f(c.meanP, 3), f(rng.get(o.k), 3), f(c.lapses, 1)]; })), '');
    L.push('', '### Interval shape (median across users of each percentile, in days; shares are means across users)', '');
    L.push('"At the maximum" means a different limit for each scheduler: Own with a band 3650 days, FSRS 36500 days, and Own cards that fall back to FSRS intervals are not capped. Compare it across schedulers with care.', '');
    L.push(table(['Truth / scheduler / R', 'p10', 'p50', 'p90', 'p99', 'At least 365 d', 'At least 3650 d', 'At the maximum', 'Exactly 1 d'],
      ks.map(o => { const c = cells.get(o.k); return [label(o), f(c.p10, 1), f(c.p50, 1), f(c.p90, 1), f(c.p99, 1), pc(c.ge365), pc(c.ge3650), pc(c.atMax), pc(c.one)]; })), '');
    const pk = ks.filter(o => cells.get(o.k).paired);
    L.push('', '### Own against FSRS at the same card state (pooled over users)', '');
    if (pk.length) {
      L.push('Taken from the histogram of log2(Own interval / FSRS interval) in half-steps. Within 20% (|log2| up to log2(1.2) = 0.263): the two middle bins are counted in proportion, as if passes were evenly spread inside a bin, so this share is approximate. Two times apart or more (|log2| at least 1): whole bins, exact at the bin edge (the end bins hold everything beyond +-6).', '');
      L.push(table(['Truth / scheduler / R', 'Users', 'Passes', 'Within 20% (about)', 'At least 2x apart, either way'], pk.map(o => { const c = cells.get(o.k).paired; return [label(o), c.users, c.n, pc(c.within), pc(c.far)]; })), '');
    } else L.push('No run in this tag has a paired histogram (it was run without --paired).', '');
    L.push('', '### Intervals that got shorter after a success, and the band', '');
    L.push('Shrink share = shorter intervals divided by intervals that could be compared with the card\'s previous one (pooled over users). Cards with 2 or more shrinks are a share of all cards (pooled). Band share = share of Own intervals the band changed (mean across users; n/a without a band).', '');
    L.push(table(['Truth / scheduler / R', 'Shrink share', 'Cards with 2 or more shrinks', 'Band changed the interval', 'Users with a band'],
      ks.map(o => { const c = cells.get(o.k); return [label(o), pc(c.shrink), pc(c.cards2), pc(c.band), c.bandUsers]; })), '');
    L.push('');
  });
  if (tags.length > 1) {
    L.push('## Side by side', '', 'Same truth / scheduler / R in every tag; each cell is the mean across that tag\'s users (n users per tag in the header).', '');
    const ns = tags.map((t, i) => `${t} (n ${Math.max(0, ...[...cellsByTag[i].values()].map(c => c.n))})`);
    const allKeys = sortKeys([...new Set(cellsByTag.flatMap(c => [...c.keys()]))].filter(Boolean));
    const metrics = [
      ['Reviews per day, days 2-end', c => f(c.perDayAll)], ['Mean retention', c => f(c.meanP, 3)], ['Lapses per user', c => f(c.lapses, 1)],
      ['Median interval p50 (days)', c => f(c.p50, 1)], ['Share of intervals at least 3650 d', c => pc(c.ge3650)],
      ['Shrink share', c => pc(c.shrink)], ['Own against FSRS within 20% (about)', c => (c.paired ? pc(c.paired.within) : 'n/a')], ['Band changed the interval', c => pc(c.band)]
    ];
    for (const [name, fn] of metrics) {
      L.push(`### ${name}`, '', table(['Truth / scheduler / R', ...ns], allKeys.map(o => [label(o), ...cellsByTag.map(c => (c.has(o.k) ? fn(c.get(o.k)) : 'n/a'))])), '');
    }
  }
  return L.join('\n') + '\n';
}

// ---------- shadow ----------
const SHIPPED_KEY = variantKey(SHIPPED.nLive, SHIPPED.level, SHIPPED.consecutive);
const parseVariant = key => { const m = /^n(\d+)-l(\d+)-c(\d+)$/.exec(key); return m ? { nLive: +m[1], level: +m[2], consecutive: +m[3] } : { nLive: 0, level: 0, consecutive: 0 }; };
const sortVariants = keys => [...keys].sort((a, b) => { const x = parseVariant(a), y = parseVariant(b); return x.nLive - y.nLive || x.level - y.level || x.consecutive - y.consecutive; });

// per variant over the evaluated users of the given records (real or simulated); oracle and null rates are only from records that have them
export function shadowCells(records) {
  const ev = records.filter(r => r.ok && !r.skipped && r.variants);
  const live = ev.filter(r => !r.oracle), orc = ev.filter(r => r.oracle);
  const keys = sortVariants([...new Set(ev.flatMap(r => Object.keys(r.variants)))]);
  const out = new Map();
  for (const key of keys) {
    const vs = live.map(r => r.variants[key]).filter(Boolean), fb = vs.filter(v => v.firstBetter);
    const nx = fb.filter(v => v.next && v.next.n > 0).map(v => v.next.diff);
    const withNull = live.filter(r => r.null?.[key]);
    out.set(key, {
      key, users: vs.length, reached: vs.length ? vs.filter(v => v.reached).length / vs.length : NaN, better: vs.length ? fb.length / vs.length : NaN,
      medDay: median(fb.map(v => v.firstBetter.daysAfter)), medRecords: median(fb.map(v => v.firstBetter.records)),
      flips: mean(vs.map(v => v.flips)), returns: mean(vs.map(v => v.returns)), returnsRmse: mean(vs.map(v => returnsByWhy(v).rmse)), returnsWorse: mean(vs.map(v => returnsByWhy(v).worse)), next: mean(nx), nextUsers: nx.length,
      nullFb: withNull.length ? falseBetter(withNull, key) : null, oracleFb: orc.length ? falseBetter(orc, key) : null
    });
  }
  return out;
}
const fbText = (fb, field) => (fb && fb[field] !== undefined ? pc(fb[field]) : 'n/a');

// the fastest variant (median day of the first Better, then fewer records) whose false-Better rate is at most 5% under both nulls
export function fastestSafe(cells) {
  const ok = [...cells.values()].filter(c => c.nullFb?.nullRate <= 0.05 && c.oracleFb?.oracleRate <= 0.05 && Number.isFinite(c.medDay));
  ok.sort((a, b) => a.medDay - b.medDay || a.medRecords - b.medRecords);
  return ok[0] || null;
}
export function verdictLine(cells, scope) {
  const hasNull = [...cells.values()].some(c => c.nullFb?.nullRate !== undefined), hasOracle = [...cells.values()].some(c => c.oracleFb?.oracleRate !== undefined);
  if (!hasNull || !hasOracle) return `${scope}: cannot name the fastest variant under both nulls; ${!hasNull ? 'no sign-flip null' : 'no oracle control'} in these results.`;
  const best = fastestSafe(cells), sh = cells.get(SHIPPED_KEY);
  const shipped = !sh ? `the shipped ${SHIPPED_KEY} is not in these results`
    : (sh.nullFb?.nullRate <= 0.05 && sh.oracleFb?.oracleRate <= 0.05) ? `the shipped ${SHIPPED_KEY} passes (null ${pc(sh.nullFb.nullRate)}, oracle ${pc(sh.oracleFb.oracleRate)})`
      : `the shipped ${SHIPPED_KEY} does not pass (null ${fbText(sh.nullFb, 'nullRate')}, oracle ${fbText(sh.oracleFb, 'oracleRate')})`;
  return `${scope}: ${best ? `the fastest variant with a false-Better rate of 5% or less under both nulls is ${best.key} (median day ${f(best.medDay, 0)}, null ${pc(best.nullFb.nullRate)}, oracle ${pc(best.oracleFb.oracleRate)})` : 'no variant keeps the false-Better rate at 5% or less under both nulls'}; ${shipped}.`;
}

export function shadowReport(tags, recordsByTag) {
  const L = ['# Shadow report', '', `Tags: ${tags.join(', ')}. Users are those that reached the start point. First Better = the first switch to Own; days and records are medians over users that got one. Flips = switches after the first, returns = switches back to FSRS (means per evaluated user), split by the reason the rule gave: the rate limit on Own's calibration (rmse) or Own's loss getting worse than FSRS's. Next 90 days = mean over users with a Better of Own minus FSRS log loss (below 0 = Own better). False Better = share of (user, draw) pairs with a Better under the sign-flip null (once over all evaluated users, once over those that reached the checks), and share of oracle users with a Better under the oracle control.`, ''];
  const cellsByTag = tags.map(t => shadowCells(recordsByTag[t]));
  const head = ['Variant', 'Users', 'Reached the checks', 'Got a Better', 'Median day', 'Median records', 'Flips', 'Returns', 'Returns: rate limit', 'Returns: loss worse', 'Next 90 days', 'False Better (null)', 'False Better (null, reached the checks)', 'False Better (oracle)'];
  tags.forEach((tag, ti) => {
    L.push(`## Tag ${tag}`, '');
    const cells = cellsByTag[ti];
    if (!cells.size) { L.push('No evaluated users.', ''); return; }
    L.push(table(head, [...cells.values()].map(c => [c.key + (c.key === SHIPPED_KEY ? ' (shipped)' : ''), c.users, pc(c.reached), pc(c.better), f(c.medDay, 0), f(c.medRecords, 0), f(c.flips), f(c.returns), f(c.returnsRmse), f(c.returnsWorse), f(c.next, 4), fbText(c.nullFb, 'nullRate'), fbText(c.nullFb, 'nullReachedRate'), fbText(c.oracleFb, 'oracleRate')])), '');
    if (tags.length > 1) L.push(verdictLine(cells, `Tag ${tag}`), '');
  });
  if (tags.length > 1) {
    const ks = sortVariants([...new Set(cellsByTag.flatMap(c => [...c.keys()]))]);
    L.push('## Side by side', '', 'Each cell: reached the checks / median day of the first Better / false Better under the null.', '');
    L.push(table(['Variant', ...tags], ks.map(k => [k + (k === SHIPPED_KEY ? ' (shipped)' : ''), ...cellsByTag.map(c => { const x = c.get(k); return x ? `${pc(x.reached, 0)} / ${f(x.medDay, 0)} / ${fbText(x.nullFb, 'nullRate')}` : 'n/a'; })])), '');
  }
  const pooled = shadowCells(tags.flatMap(t => recordsByTag[t]));
  L.push('## Verdict', '', verdictLine(pooled, 'All tags pooled'), '');
  return L.join('\n') + '\n';
}

// ---------- command line ----------
async function main() {
  const flags = parseArgs(process.argv.slice(2), []);
  const fail = msg => { console.error(msg); process.exit(2); };
  const kind = flags.kind;
  if (!['replay', 'shadow'].includes(kind)) fail('Use --kind replay or --kind shadow.');
  const tags = String(flags.tags || '').split(',').filter(Boolean);
  if (!tags.length) fail('Use --tags a,b,c (the tags of the result files).');
  const name = String(flags.out || `${kind}-${tags.join('+')}`);
  if (!/^[\w.+-]+$/.test(name)) fail('--out may only hold letters, digits, dot, plus, dash and underscore.');
  const dir = join(privateDir(), 'results');
  try { refuseInsideRepo('the results folder', dir); } catch (e) { fail(e.message); }
  mkdirSync(dir, { recursive: true });
  const recordsByTag = {};
  const warnings = [];
  try { for (const t of tags) { const info = {}; recordsByTag[t] = loadResults(kind, t, dir, info); if (info.dropped) warnings.push(droppedWarning(t, info.dropped)); } } catch (e) { fail(e.message); }
  const md = (warnings.length ? warnings.join('\n') + '\n\n' : '') + (kind === 'replay' ? replayReport : shadowReport)(tags, recordsByTag);
  const out = join(dir, `b-report-${name}.md`);
  writeFileSync(out, md);
  console.log(md + `(saved to ${out})`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
