// The "watch first" shadow run, pure core (no files, no threads). Importable; tests/own-shadow-run.test.js runs the pure parts on made-up records.
//
// Question: if a learner turns Own on at some point and the app only watches (FSRS keeps scheduling), when would the app's own rule
// (js/own-verdict.js: liveVerdict + nextScheduler) say "Own is better", how often does it change its mind, and how often would it say
// "Better" when there is no real difference (a false Better)?
//
//   startDay(rows, start, cutoff)  the study day Own is turned on
//   gridVariants()                 the settings swept: N_live x level x consecutive checks (the shipped setting is one of them, flagged)
//   signFlip(records, seed)        the null: every card's loss differences change sign (Own and FSRS swapped for that card)
//   runVariants(live, opts)        the daily check loop for every variant -> first Better, switches, loss over the next 90 days
//   shadowUser(loaded, ctx)        one learner end to end -> one record
//   summarizeShadow(results)       aggregate report (no per-user numbers)
import { fit, clipWeights, forgettingCurve, initState, nextState, mulberry32, splitHistories } from '../../js/fsrs-fit.js';
import { createOwnModel, StateStore, eventsFromRows } from '../../js/own-model.js';
import { fnv1a } from '../../js/rwkv-features.js';
import { liveVerdict, newState, nextScheduler, recordCheck, exitCheck, N_LIVE, CHECKS_IN_A_ROW } from '../../js/own-verdict.js';
import { DEFAULT_W, BOUNDS, FT_DEFAULTS, fsrsCardsFromRows, finetuneParams } from './eval-core.mjs';
import { isLong, predictAll, frozenFor } from './common.mjs';
import { bootstrapMeanCI, mean } from './eval-lib.mjs';
import { halfOf } from './replay-core.mjs';

// Bump when a change to this file changes what a run computes: it is part of the resume key (shadow.mjs).
export const SHADOW_VERSION = 1;
export const START_KINDS = ['first', 'scored', 'cutoff'];
export const TUNES = ['none', 'monthly'];
export const FSRS_MODES = ['default', 'fitted-at-start', 'refit-monthly'];
export const NULLS = ['none', 'signflip'];
export const GRID = { nLive: [50, 100, 200, 300, 500], level: [0.95, 0.99], consecutive: [1, 2] };
export const SHIPPED = { nLive: N_LIVE, level: 0.95, consecutive: CHECKS_IN_A_ROW };
export const DEFAULTS = { horizon: 365, nextDays: 90, epochDays: 30, cap: 40000, start: 'scored:1000', tune: 'none', fsrs: 'default', nullDraws: 0, seed: 0, simDays: [150, 400] };
const EPS = 1e-6;

// ---------- small pure pieces ----------
// The val users are split in two halves by a hash of the id: 0 = A, 1 = B (defined in replay-core.mjs).
export { halfOf };

// "first", "scored:1000", "cutoff" -> { kind, n }
export function parseStart(text) {
  const m = /^(first|cutoff|scored(?::(\d+))?)$/.exec(String(text));
  if (!m) throw new Error('--start must be first, scored:N or cutoff.');
  if (m[1].startsWith('scored')) {
    const n = m[2] === undefined ? DEFAULTS_SCORED : Number(m[2]);
    if (!(n >= 1)) throw new Error('--start scored:N needs N of at least 1.');
    return { kind: 'scored', n };
  }
  return { kind: m[1], n: 0 };
}
const DEFAULTS_SCORED = 1000;

// The user's eval cutoff day (as in eval-core / replay-core): the day by which 80% of the later-day scored reviews have happened.
export const cutoffOfRows = rows => splitHistories(fsrsCardsFromRows(rows), 0.8).cutoff;

// The study day Own is turned on (at the end of that day; live records are the later-day scored reviews on LATER days), or null when the
// learner never gets there. rows: time order, each { day, dDays, scored }. A "scored review" is a later-day one (isLong), the kind the app scores.
//   first       the day of the very first review (nothing scored yet)
//   scored:N    the day of the learner's Nth scored review
//   cutoff      the given cutoff day (the day by which 80% of the scored reviews have happened)
export function startDay(rows, start, cutoff) {
  const s = typeof start === 'string' ? parseStart(start) : start;
  if (!rows.length) return null;
  if (s.kind === 'first') return rows[0].day;
  if (s.kind === 'cutoff') return Number.isFinite(cutoff) ? cutoff : null;
  let n = 0;
  for (const r of rows) if (isLong(r) && ++n === s.n) return r.day;
  return null;
}

// Every setting swept. The shipped one (N 300, 95%, 2 checks) is one of them and is flagged, not added twice.
export function gridVariants(grid = GRID, shipped = SHIPPED) {
  const out = [];
  for (const nLive of grid.nLive) for (const level of grid.level) for (const consecutive of grid.consecutive) {
    out.push({ key: variantKey(nLive, level, consecutive), nLive, level, consecutive, shipped: nLive === shipped.nLive && level === shipped.level && consecutive === shipped.consecutive });
  }
  return out;
}
export const variantKey = (nLive, level, consecutive) => `n${nLive}-l${Math.round(level * 100)}-c${consecutive}`;

// The sign-flip null: each card gets a seeded coin; on a "flipped" card Own's and FSRS's predictions are swapped, so every loss difference of
// that card changes sign exactly (the card-level bootstrap in liveVerdict then sees a world where Own is as likely to be worse as better).
// Same seed text, same flips; the coin of a card does not depend on the order of the records.
export function signFlip(records, seedText) {
  const flip = new Map();
  const coin = id => {
    const k = String(id);
    let v = flip.get(k);
    if (v === undefined) flip.set(k, v = mulberry32(fnv1a(`shadow-null|${seedText}|${k}`))() < 0.5);
    return v;
  };
  return records.map(r => (coin(r.cardId) ? { ...r, pOwn: r.pFsrs, pFsrs: r.pOwn } : r));
}

const clip = p => Math.min(1 - EPS, Math.max(EPS, p));
export const logLoss = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));
const lossDiff = r => logLoss(r.pOwn, r.y) - logLoss(r.pFsrs, r.y);

// liveVerdict has a fixed N_LIVE of 300. For a smaller N the records are repeated k times (k = ceil(300 / count)): the card sums and counts
// are all multiplied by k, so the mean, the bootstrap interval (it draws cards, not records) and the binned RMSE come out exactly the same.
// The smaller N itself is checked by the caller (count < N means "few").
function verdictOf(recs, { level, totalScored, daysWatching }) {
  const k = Math.max(1, Math.ceil(N_LIVE / recs.length));
  const rr = k === 1 ? recs : Array.from({ length: recs.length * k }, (_, i) => recs[i % recs.length]);
  return liveVerdict(rr, { level, totalScored, daysWatching, nLive: rr.length });
}
export const verdictForN = verdictOf;

// ---------- the daily check loop ----------
// live: the live records (days after the turn-on, oldest first): [{ day, cardId, pOwn, pFsrs, y }]
// o: { turnDay, histScored, horizon, nextDays, variants, stopAtFirst }
// One check per study day (a day with at least one live record) up to `horizon` days after the turn-on, for every variant:
//   status = 'few' when fewer than N_live records, else liveVerdict's answer (all live records so far, `level`, totalScored = history + live,
//   daysWatching = day - turnDay). nextScheduler then decides from the last checks (consecutive 2: the shipped "two Better checks on different
//   days at most 7 days apart"; consecutive 1: one Better check is enough: the two-check list is fed with that one check twice, on days D-1 and D).
// Returns { [key]: { reached, firstBetter: { day, daysAfter, records } | null, switches: [{ day, to, why, n }], flips, returns, final, locked, next }, ... }
// flips = switches after the first one (the flip-flops); returns = switches back to FSRS; next = { n, diff } the mean loss difference
// (Own minus FSRS, below 0 is Own better) over the records in the nextDays days after the first Better.
export function runVariants(live, o) {
  const variants = o.variants || gridVariants(), levels = [...new Set(variants.map(v => v.level))], minN = Math.min(...variants.map(v => v.nLive));
  const nextDays = o.nextDays ?? DEFAULTS.nextDays;
  const st = variants.map(v => ({ v, state: newState(o.turnDay), verdicts: [], sinceCount: 0, first: null, switches: [], reached: false }));
  const days = [...new Set(live.map(r => r.day))].sort((a, b) => a - b);
  let idx = 0;
  for (const D of days) {
    if (D - o.turnDay > o.horizon) break;
    while (idx < live.length && live[idx].day <= D) idx++;
    const recs = idx === live.length ? live : live.slice(0, idx);
    const daysWatching = D - o.turnDay, totalScored = o.histScored + idx;
    const byLevel = {};
    if (idx >= minN) for (const level of levels) byLevel[level] = verdictOf(recs, { level, totalScored, daysWatching });
    for (const s of st) {
      const { v } = s;
      const status = idx < v.nLive ? 'few' : byLevel[v.level].status;
      if (status !== 'few') s.reached = true;
      let verdicts;
      if (v.consecutive >= 2) { s.verdicts = recordCheck(s.verdicts, D, status); verdicts = s.verdicts; }
      else verdicts = status === 'better' ? [{ day: D - 1, status }, { day: D, status }] : [{ day: D, status }];
      const since = idx - s.sinceCount;
      const input = { on: true, verdicts, recordsSinceSwitch: since, plans: { total: 0, failed: 0 } };
      if (s.state.scheduler === 'own') input.exit = exitCheck(recs, since);
      const r = nextScheduler(s.state, input, D);
      s.state = r.state;
      if (r.switched) {
        s.switches.push({ day: D, to: r.scheduler, why: r.why, n: idx });
        s.sinceCount = idx;
        if (!s.first && r.scheduler === 'own') s.first = { day: D, daysAfter: D - o.turnDay, records: idx };
      }
    }
    if (o.stopAtFirst && st.every(s => s.first)) break;
  }
  const out = {};
  for (const s of st) {
    let next = null;
    if (s.first && !o.skipNext) {
      let n = 0, sum = 0;
      for (const r of live) if (r.day > s.first.day && r.day <= s.first.day + nextDays) { n++; sum += lossDiff(r); }
      next = { n, diff: n ? sum / n : null };
    }
    out[s.v.key] = {
      reached: s.reached, firstBetter: s.first, switches: s.switches, flips: Math.max(0, s.switches.length - 1),
      returns: s.switches.filter(x => x.to === 'fsrs').length, final: s.state.scheduler, locked: !!s.state.autoLocked, next
    };
  }
  return out;
}

// ---------- predictions ----------
const clip6 = w => clipWeights(w, 1, BOUNDS);

// FSRS-6 probability for every row, replayed the way eval6 walks the histories (whole-day gaps, scored lives only). NaN for rows that are
// not a later-day scored review. w: 21 weights (already clipped).
export function fsrsPredictions(rows, w) {
  const out = new Float64Array(rows.length).fill(NaN), by = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.scored === false) continue;
    const c = by.get(r.cardKey);
    if (!c) { by.set(r.cardKey, { ...initState(w, r.rating, true), day: r.day }); continue; }
    const t = Math.max(0, r.day - c.day), p = forgettingCurve(w, t, c.s, true);
    if (t > 0) out[i] = p;
    const n = nextState(w, c.s, c.d, t, r.rating, true, p);
    c.s = n.s; c.d = n.d; c.day = r.day;
  }
  return out;
}

// FSRS-6 weights fitted on the reviews up to `day` (default weights when there is too little to fit).
export function fitWeightsAt(rows, day) {
  const pre = rows.filter(r => r.day <= day);
  const cards = fsrsCardsFromRows(pre);
  if (!cards.length) return { w: clip6(DEFAULT_W), status: 'default' };
  let gen = fit({ cards, current: DEFAULT_W, defaults: DEFAULT_W, bounds: BOUNDS, config: { skipCheck: true } }), r;
  for (;;) { const s = gen.next(); if (s.done) { r = s.value; break; } }
  return { w: clip6(r.status === 'trained' ? r.fitted : DEFAULT_W), status: r.status };
}

// ---------- one learner ----------
// loaded: { id, rows, learner? } (loadLearner). ctx: { params, size, ablate, start, tune, fsrs, nullDraws, horizon, nextDays, epochDays, oracle, seed }
// -> one record (see the header of shadow.mjs for the fields).
export function shadowUser(loaded, ctx) {
  const t0 = performance.now(), o = { ...DEFAULTS, ...ctx }, start = parseStart(o.start);
  const allRows = loaded.rows, cutoff = start.kind === 'cutoff' ? cutoffOfRows(allRows) : NaN;
  const turnDay = startDay(allRows, start, cutoff);
  const base = { ok: true, user: String(loaded.id), start: o.start, tune: o.tune, fsrs: o.fsrs, oracle: !!o.oracle, reviews: allRows.length };
  if (turnDay === null) return { ...base, skipped: 'too few scored reviews to start', seconds: 0 };
  // nothing after horizon + nextDays is needed (the memory only looks back)
  const lastDay = turnDay + o.horizon + o.nextDays;
  const rows = allRows.filter(r => r.day <= lastDay);
  const events = eventsFromRows(rows);
  const histScored = rows.reduce((a, r, i) => a + (r.day <= turnDay && events[i].score && isLong(r) ? 1 : 0), 0);
  const epochOf = day => Math.floor((day - turnDay - 1) / o.epochDays);
  const epochs = [...new Set(rows.map(r => epochOf(r.day)).filter(k => k >= 0))].sort((a, b) => a - b);

  // Own: zero-shot over the replayed history, or tuned at each month boundary on what had happened by then
  const pOwn = new Float64Array(rows.length).fill(NaN), pFsrs = new Float64Array(rows.length).fill(NaN);
  const rowEpoch = rows.map(r => epochOf(r.day));
  const fill = (target, ps, k) => { for (let i = 0; i < rows.length; i++) if (rowEpoch[i] === k) target[i] = ps[i]; };
  const base0 = o.tune === 'monthly' ? null : predictAll(createOwnModel(ctx.params, ctx.size), events, new StateStore());
  const fz = frozenFor(ctx.size, ctx.ablate || []);
  const tuneInfo = [];
  const fitStatus = [];
  let wFixed = null;
  if (!o.oracle && o.fsrs === 'fitted-at-start') { const f = fitWeightsAt(allRows, turnDay); wFixed = f.w; fitStatus.push(f.status); }
  else if (!o.oracle && o.fsrs === 'default') wFixed = clip6(DEFAULT_W);
  const fixedFsrs = wFixed ? fsrsPredictions(rows, wFixed) : null;
  for (const k of epochs) {
    const boundary = turnDay + k * o.epochDays;
    if (base0) fill(pOwn, base0, k);
    else {
      const ft = finetuneParams({ params: ctx.params, size: ctx.size, events, rows, cutoff: boundary, frozen: fz, cfg: { ...FT_DEFAULTS } });
      tuneInfo.push(ft.skipped ? 'skipped' : 'tuned');
      fill(pOwn, predictAll(createOwnModel(ft.params, ctx.size), events, new StateStore()), k);
    }
    if (o.oracle) continue;
    if (fixedFsrs) fill(pFsrs, fixedFsrs, k);
    else { const f = fitWeightsAt(allRows, boundary); fill(pFsrs, fsrsPredictions(rows, f.w), k); fitStatus.push(f.status); }
  }
  if (o.oracle) {
    const byId = new Map(loaded.learner.logs.map((l, i) => [l.id, i]));
    const tp = loaded.learner.truth?.p;
    if (!tp) throw new Error('--oracle needs simulated learners (they know the true chance of remembering).');
    for (let i = 0; i < rows.length; i++) { const j = byId.get(rows[i].logId); if (j !== undefined) pFsrs[i] = tp[j]; }
  }

  // the live records: later-day scored reviews after the turn-on day
  const live = [];
  let n = 0, sOwn = 0, sFs = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.day <= turnDay || !events[i].score || !isLong(r) || !Number.isFinite(pOwn[i]) || !Number.isFinite(pFsrs[i])) continue;
    const rec = { day: r.day, cardId: r.cardKey, pOwn: pOwn[i], pFsrs: pFsrs[i], y: r.rating > 1 ? 1 : 0 };
    live.push(rec);
    if (r.day - turnDay <= o.horizon) { n++; sOwn += logLoss(rec.pOwn, rec.y); sFs += logLoss(rec.pFsrs, rec.y); }
  }
  const cards = new Set(live.map(r => r.cardId)).size;
  const variants = gridVariants();
  const res = {
    ...base, turnDay, histScored, liveRecords: live.length, liveInHorizon: n, cards, liveDays: new Set(live.map(r => r.day)).size,
    half: loaded.half || null, horizon: o.horizon, nextDays: o.nextDays,
    live: { n, llOwn: n ? sOwn / n : null, llFsrs: n ? sFs / n : null, meanDiff: n ? (sOwn - sFs) / n : null },
    fitStatus: summarizeList(fitStatus), tuned: o.tune === 'monthly' ? summarizeList(tuneInfo) : null,
    variants: runVariants(live, { turnDay, histScored, horizon: o.horizon, nextDays: o.nextDays, variants })
  };
  if (o.nullDraws > 0) {
    // the null: every draw flips the sign of each card's loss differences; any Better the rule gives there is a false Better
    const nul = {};
    for (const v of variants) nul[v.key] = { draws: o.nullDraws, better: 0, days: [] };
    for (let j = 0; j < o.nullDraws; j++) {
      const r = runVariants(signFlip(live, `${loaded.id}|${o.seed}|${j}`), { turnDay, histScored, horizon: o.horizon, nextDays: o.nextDays, variants, stopAtFirst: true, skipNext: true });
      for (const v of variants) if (r[v.key].firstBetter) { nul[v.key].better++; nul[v.key].days.push(r[v.key].firstBetter.daysAfter); }
    }
    res.null = nul;
  }
  res.seconds = Math.round(performance.now() - t0) / 1000;
  return res;
}
const summarizeList = xs => { const m = {}; for (const x of xs) m[x] = (m[x] || 0) + 1; return m; };

// ---------- the aggregate report ----------
const med = xs => { if (!xs.length) return NaN; const a = Float64Array.from(xs).sort(); return a[a.length >> 1]; };
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const num = (x, d = 4) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : 'n/a');

// How the false-Better rate is computed:
//   sign-flip null (--null signflip:D): for a variant, over every evaluated user and every draw, the share of (user, draw) pairs in which the rule
//   gave a first Better; users x draws is the denominator (a user who never reaches the checks counts as a draw without Better).
//   oracle control (--oracle): FSRS's side is the true chance; Own cannot beat it, so the share of evaluated users with a first Better is the rate.
// Returns to FSRS of one variant's record, by the reason the rule gave: 'rmse' (the rate limit on Own's calibration) or 'worse' (Own's loss got worse than FSRS's).
export function returnsByWhy(v) {
  const back = (v.switches || []).filter(x => x.to === 'fsrs');
  return { rmse: back.filter(x => x.why === 'rmse').length, worse: back.filter(x => x.why === 'worse').length, other: back.filter(x => x.why !== 'rmse' && x.why !== 'worse').length };
}
export function falseBetter(results, key) {
  const ev = results.filter(r => r.ok && !r.skipped && r.variants?.[key]);
  const out = { users: ev.length };
  const withNull = ev.filter(r => r.null?.[key]);
  if (withNull.length) {
    const draws = withNull.reduce((a, r) => a + r.null[key].draws, 0), better = withNull.reduce((a, r) => a + r.null[key].better, 0);
    out.nullDraws = draws; out.nullBetter = better; out.nullRate = draws ? better / draws : NaN;
    out.nullUsersAny = withNull.filter(r => r.null[key].better > 0).length; out.nullUsers = withNull.length;
    // the same rate among the users who reached the checks (enough live records; the draws change signs, not counts, so the real run's `reached` holds for them)
    const rch = withNull.filter(r => r.variants[key].reached);
    out.nullReachedUsers = rch.length;
    out.nullReachedDraws = rch.reduce((a, r) => a + r.null[key].draws, 0); out.nullReachedBetter = rch.reduce((a, r) => a + r.null[key].better, 0);
    out.nullReachedRate = out.nullReachedDraws ? out.nullReachedBetter / out.nullReachedDraws : NaN;
  }
  if (ev.some(r => r.oracle)) { const b = ev.filter(r => r.variants[key].firstBetter).length; out.oracleBetter = b; out.oracleRate = ev.length ? b / ev.length : NaN; }
  return out;
}

export function summarizeShadow(results, opts = {}) {
  const ok = results.filter(r => r.ok), skipped = ok.filter(r => r.skipped), ev = ok.filter(r => !r.skipped);
  const keys = ev.length ? Object.keys(ev[0].variants) : [];
  const lines = [];
  const data = { users: results.length, ok: ok.length, failed: results.length - ok.length, skipped: skipped.length, evaluated: ev.length, variants: {} };
  lines.push(`## Shadow run: ${opts.tag || ''}`);
  for (const h of opts.header || []) lines.push(h);
  lines.push('', `Users: ${results.length} run, ${data.failed} failed, ${skipped.length} never reached the start point, ${ev.length} evaluated.`);
  if (ev.length) {
    const l = ev.filter(r => r.live.n > 0);
    data.live = { users: l.length, records: l.reduce((a, r) => a + r.live.n, 0), meanDiffUser: mean(l.map(r => r.live.meanDiff)) };
    lines.push(`Live records per evaluated user: median ${Math.round(med(ev.map(r => r.liveInHorizon)))}; mean Own-minus-FSRS log loss per user ${num(data.live.meanDiffUser)} (below 0: Own better).`);
  }
  lines.push('', '### The rule on the live records (first Better, switches back, loss over the next days)', '',
    '| Setting | Reached the checks | First Better | Median days to it | Median records | Switched back later | Returns to FSRS: rate limit (mean per user) | Returns to FSRS: loss worse (mean per user) | Mean switches after the first | Next-period loss diff (users with a Better) | 95% CI | Own better in that period | False Better (null) | False Better (null, users who reached the checks) | False Better (oracle) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const key of keys) {
    const vs = ev.map(r => r.variants[key]), fb = vs.filter(v => v.firstBetter);
    const nx = fb.filter(v => v.next && v.next.n > 0).map(v => v.next.diff);
    const ci = nx.length ? bootstrapMeanCI(nx, { seed: fnv1a('shadow|' + key) }) : null;
    const f = falseBetter(ev, key);
    const row = {
      reached: vs.filter(v => v.reached).length, better: fb.length, medDays: med(fb.map(v => v.firstBetter.daysAfter)), medRecords: med(fb.map(v => v.firstBetter.records)),
      switchedBack: fb.filter(v => v.returns > 0).length, returnsRmse: mean(vs.map(v => returnsByWhy(v).rmse)), returnsWorse: mean(vs.map(v => returnsByWhy(v).worse)), meanFlips: mean(fb.map(v => v.flips)), nextDiff: ci ? ci.mean : NaN, lo: ci ? ci.lo : NaN, hi: ci ? ci.hi : NaN,
      nextOwnBetter: nx.filter(d => d < 0).length, nextUsers: nx.length, falseBetter: f
    };
    data.variants[key] = row;
    lines.push(`| ${key}${shippedKey(key) ? ' (shipped)' : ''} | ${pct(row.reached, ev.length)} | ${pct(row.better, ev.length)} | ${Number.isFinite(row.medDays) ? row.medDays : 'n/a'} | ${Number.isFinite(row.medRecords) ? row.medRecords : 'n/a'} | ${pct(row.switchedBack, row.better)} | ${f2(row.returnsRmse)} | ${f2(row.returnsWorse)} | ${Number.isFinite(row.meanFlips) ? row.meanFlips.toFixed(2) : 'n/a'} | ${num(row.nextDiff)} | [${num(row.lo)}, ${num(row.hi)}] | ${pct(row.nextOwnBetter, row.nextUsers)} | ${f.nullRate !== undefined ? `${(100 * f.nullRate).toFixed(1)}% (${f.nullBetter}/${f.nullDraws})` : 'n/a'} | ${f.nullReachedRate !== undefined && Number.isFinite(f.nullReachedRate) ? `${(100 * f.nullReachedRate).toFixed(1)}% (${f.nullReachedBetter}/${f.nullReachedDraws})` : 'n/a'} | ${f.oracleRate !== undefined ? `${(100 * f.oracleRate).toFixed(1)}% (${f.oracleBetter}/${f.users})` : 'n/a'} |`);
  }
  return { markdown: lines.join('\n') + '\n', data };
}
const shippedKey = key => key === variantKey(SHIPPED.nLive, SHIPPED.level, SHIPPED.consecutive);
