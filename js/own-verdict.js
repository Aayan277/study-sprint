// The "is Own better than FSRS?" rule, as plain functions.
// No screen, no database, no clock: the caller passes in the records, the day
// number and the counts, and gets answers back. That makes every rule testable.
//
// A "record" is one live review that was scored:
//   { cardId, pOwn, pFsrs, y }   y is 1 (remembered) or 0 (forgot).
// A "day" is a whole study-day number (the caller works it out from the clock).

// ---- the fixed limits (written down before any results were seen) ----
export const N_LIVE = 300;            // live records needed before a verdict
export const MIN_SCORED = 1000;       // scored reviews in total (history + live)
export const MIN_DAYS = 7;            // days of watching needed
export const DWELL_DAYS = 14;         // minimum days between two switches
export const DWELL_RECORDS = 200;     // minimum new live records between two switches
export const EXIT_WINDOW = 1000;      // how many recent records the "go back" check reads
export const MAX_AUTO_RETURNS = 2;    // after this many automatic returns to FSRS, lock
export const RMSE_LIMIT = 0.01;       // Own may be at most this much worse on RMSE
export const BOOTSTRAP_RESAMPLES = 1000;
export const BINS = 20;               // bins for the RMSE
export const ERROR_SHARE = 0.05;      // more than 5% of plans failing means error
export const ERROR_PAUSE_DAYS = 14;   // wait this long after an error return
export const CHECKS_IN_A_ROW = 2;
export const MAX_CHECK_GAP_DAYS = 7;  // the two Better checks may be up to this many days apart (people do not study every day)
export const MIN_PLANS_FOR_ERROR = 20; // the error pause needs at least this many plans in the day
export const DEFAULT_SEED = 20240611; // same records + same seed = same answer
const EPS = 1e-6;                     // keeps log() away from 0

// ---------- small helpers ----------

// A seeded random-number generator: the same seed always gives the same stream.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clip = p => Math.min(1 - EPS, Math.max(EPS, p));
const logLoss = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));

// Drop any record with a missing or broken number (safer than guessing).
function clean(records) {
  const out = [];
  for (const r of records || []) {
    if (!r || !Number.isFinite(r.pOwn) || !Number.isFinite(r.pFsrs)) continue;
    if (r.y !== 0 && r.y !== 1) continue;
    out.push(r);
  }
  return out;
}

// RMSE over 20 equal bins of the predicted recall: how far the average
// prediction in each bin is from how often you really remembered.
export function binnedRmse(preds, ys) {
  const n = preds.length;
  if (!n) return NaN;
  const cnt = new Array(BINS).fill(0), sp = new Array(BINS).fill(0), sy = new Array(BINS).fill(0);
  for (let i = 0; i < n; i++) {
    const p = Math.min(1, Math.max(0, preds[i]));
    const b = Math.min(BINS - 1, Math.floor(p * BINS));
    cnt[b]++; sp[b] += p; sy[b] += ys[i];
  }
  let tot = 0;
  for (let b = 0; b < BINS; b++) if (cnt[b]) tot += cnt[b] * (sp[b] / cnt[b] - sy[b] / cnt[b]) ** 2;
  return Math.sqrt(tot / n);
}

// Own minus FSRS, summed per card, so cards (not single reviews) are resampled.
function perCard(recs) {
  const m = new Map();
  for (const r of recs) {
    const k = String(r.cardId);
    let c = m.get(k);
    if (!c) m.set(k, c = { sum: 0, n: 0 });
    c.sum += logLoss(r.pOwn, r.y) - logLoss(r.pFsrs, r.y);
    c.n++;
  }
  // Sorted by card id so the answer does not depend on the order of the records.
  return [...m.keys()].sort().map(k => m.get(k));
}

// The 95% interval (or `level`) for the mean difference, by card-level bootstrap.
function bootstrap(cards, level, seed) {
  const k = cards.length, B = BOOTSTRAP_RESAMPLES;
  const sums = Float64Array.from(cards, c => c.sum), ns = Float64Array.from(cards, c => c.n);
  const rng = makeRng(seed);
  const means = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < k; i++) { const j = Math.floor(rng() * k); s += sums[j]; n += ns[j]; }
    means[b] = s / n;
  }
  means.sort();
  const tail = (1 - level) / 2;
  // Rounded the cautious way: the upper end is the higher value, the lower end the lower.
  const lo = means[Math.max(0, Math.floor(tail * B))];
  const hi = means[Math.min(B - 1, Math.floor((1 - tail) * B))];
  return { lo, hi };
}

// Mean difference and both RMSEs for a set of records.
function summarize(recs) {
  let ll = 0, lf = 0;
  const po = [], pf = [], ys = [];
  for (const r of recs) {
    ll += logLoss(r.pOwn, r.y); lf += logLoss(r.pFsrs, r.y);
    po.push(r.pOwn); pf.push(r.pFsrs); ys.push(r.y);
  }
  const n = recs.length;
  return {
    n, llOwn: ll / n, llFsrs: lf / n, meanDiff: (ll - lf) / n,
    rmseOwn: binnedRmse(po, ys), rmseFsrs: binnedRmse(pf, ys)
  };
}

// True when Own is more than the allowed amount worse on RMSE.
export function rmseBroken(rmseOwn, rmseFsrs) {
  return !(rmseOwn - rmseFsrs <= RMSE_LIMIT + 1e-12);
}

// ---------- the verdict ----------

// Is Own better than FSRS on the live records?
//   records: the live scored records
//   opts: { totalScored (history + live), daysWatching, nLive (live count; default records.length),
//           level (default 0.95), seed }
// Returns { status: 'few' | 'better' | 'not', meanDiff, lo, hi, rmseOwn, rmseFsrs,
//           llOwn, llFsrs, n, cards, need: { scored, live, days } }
// 'few' means not enough to judge. 'better' needs the whole interval below 0
// and the RMSE limit met. Everything else is 'not'.
// (lo/hi/rmse are null while status is 'few'.)
export function liveVerdict(records, opts = {}) {
  const recs = clean(records);
  const level = opts.level ?? 0.95;
  const seed = opts.seed ?? DEFAULT_SEED;
  const totalScored = opts.totalScored ?? recs.length;
  const daysWatching = opts.daysWatching ?? 0;
  const nLive = Math.min(opts.nLive ?? recs.length, recs.length);
  // The progress numbers the screen shows: have and need.
  const need = {
    scored: { have: totalScored, need: MIN_SCORED },
    live: { have: nLive, need: N_LIVE },
    days: { have: daysWatching, need: MIN_DAYS }
  };
  if (totalScored < MIN_SCORED || nLive < N_LIVE || daysWatching < MIN_DAYS) {
    return { status: 'few', meanDiff: null, lo: null, hi: null, rmseOwn: null, rmseFsrs: null,
      llOwn: null, llFsrs: null, n: recs.length, cards: new Set(recs.map(r => String(r.cardId))).size, need };
  }
  const s = summarize(recs);
  const cards = perCard(recs);
  const { lo, hi } = bootstrap(cards, level, seed);
  const better = hi < 0 && !rmseBroken(s.rmseOwn, s.rmseFsrs);
  return { status: better ? 'better' : 'not', meanDiff: s.meanDiff, lo, hi, rmseOwn: s.rmseOwn,
    rmseFsrs: s.rmseFsrs, llOwn: s.llOwn, llFsrs: s.llFsrs, n: s.n, cards: cards.length, need };
}

// The "should Own go back to FSRS?" check, used while Own is scheduling.
//   records: the live records, oldest first
//   recordsSinceSwitch: how many of the newest records came after Own took over
// Window: the records since the switch if there are at least 200 of them
// (never more than the last 1,000); otherwise the last 1,000 records.
// Returns { status: 'exit' | 'stay', meanDiff, rmseOwn, rmseFsrs, n, why }
// 'exit' when Own is no longer ahead (mean >= 0) or the RMSE limit is broken.
// With no usable records it says 'stay' (there is no evidence either way).
export function exitCheck(records, recordsSinceSwitch = 0) {
  const recs = clean(records);
  const since = Math.min(Math.max(0, recordsSinceSwitch | 0), recs.length);
  const take = since >= DWELL_RECORDS ? Math.min(since, EXIT_WINDOW) : EXIT_WINDOW;
  const win = recs.slice(Math.max(0, recs.length - take));
  if (!win.length) return { status: 'stay', meanDiff: null, rmseOwn: null, rmseFsrs: null, n: 0, why: null };
  const s = summarize(win);
  const worse = !(s.meanDiff < 0);
  const broken = rmseBroken(s.rmseOwn, s.rmseFsrs);
  return { status: worse || broken ? 'exit' : 'stay', meanDiff: s.meanDiff, rmseOwn: s.rmseOwn,
    rmseFsrs: s.rmseFsrs, n: s.n, why: worse ? 'worse' : broken ? 'rmse' : null };
}

// ---------- the switch rule ----------

// A fresh state, for when the owner first turns Own on (or off and on again).
export function newState(today) {
  return { scheduler: 'fsrs', sinceDay: today, switches: [], lastCheckDay: null,
    autoLocked: false, errorPauseUntil: null };
}

// Checks run once per study day: has today's check already been done?
export function checkDue(state, today) {
  return state.lastCheckDay !== today;
}

// Add today's check to the short list of recent checks (one per day, newest last).
// Keeps only the last few. Returns a new list.
export function recordCheck(verdicts, day, status) {
  const list = (verdicts || []).filter(v => v.day !== day);
  list.push({ day, status });
  list.sort((a, b) => a.day - b.day);
  return list.slice(-CHECKS_IN_A_ROW);
}

// True when the last 2 daily checks were both 'better', made on different days no more than 7 days apart.
// (The days need not be next to each other: someone who studies every other day must still be able to switch.
// Only the last two checks are kept, so a 'not' in between would be one of them and break the run.)
export function betterTwiceInARow(verdicts) {
  const v = verdicts || [];
  if (v.length < CHECKS_IN_A_ROW) return false;
  const [a, b] = v.slice(-CHECKS_IN_A_ROW);
  const gap = b.day - a.day;
  return a.status === 'better' && b.status === 'better' && gap >= 1 && gap <= MAX_CHECK_GAP_DAYS;
}

// True when more than 5% of the day's plans failed, and there were at least 20 plans that day.
export function planErrorsTooMany(plans) {
  const total = plans?.total ?? 0, failed = plans?.failed ?? 0;
  return total >= MIN_PLANS_FOR_ERROR && failed * 100 > total * (ERROR_SHARE * 100);
}

// How many automatic returns to FSRS have happened (turning Own off does not count).
export function autoReturns(switches) {
  return (switches || []).filter(s => s.to === 'fsrs' && s.why !== 'off').length;
}

// Decide who schedules now. Pure: returns the answer, changes nothing.
//   state: { scheduler: 'fsrs'|'own', switches: [{day, to, why}], autoLocked,
//            errorPauseUntil, ... } (see newState)
//   input: { on,                         the owner's switch
//            verdicts,                   recent daily checks [{day, status}] (see recordCheck)
//            exit,                       the exitCheck() result (needed while Own schedules)
//            recordsSinceSwitch,         live records since the last switch
//            plans: { total, failed } }  today's plans made by Own
//   today: the study-day number
// Returns { scheduler, switched: bool, why, state } with `state` the new state.
// `why` is one of 'better', 'worse', 'rmse', 'error', 'off' (or null if nothing changed).
export function nextScheduler(state, input, today) {
  const inp = input || {};
  const cur = state.scheduler === 'own' ? 'own' : 'fsrs';
  const switches = state.switches || [];
  const stay = () => ({ scheduler: cur, switched: false, why: null, state: { ...state, scheduler: cur } });
  const flip = (to, why) => {
    const sw = [...switches, { day: today, to, why }];
    const lock = state.autoLocked || (to === 'fsrs' && autoReturns(sw) >= MAX_AUTO_RETURNS);
    const pause = why === 'error' ? today + ERROR_PAUSE_DAYS : state.errorPauseUntil ?? null;
    return { scheduler: to, switched: true, why,
      state: { ...state, scheduler: to, sinceDay: today, switches: sw, autoLocked: lock, errorPauseUntil: pause } };
  };
  const last = switches.length ? switches[switches.length - 1].day : null;
  // Enough time and enough new records since the last switch?
  const spaced = last === null ||
    (today - last >= DWELL_DAYS && (inp.recordsSinceSwitch ?? 0) >= DWELL_RECORDS);

  if (cur === 'own') {
    if (inp.on === false) return flip('fsrs', 'off');                      // owner's switch beats everything
    if (planErrorsTooMany(inp.plans)) return flip('fsrs', 'error');       // errors: leave at once
    const ex = inp.exit;
    if (ex && ex.status === 'exit' && spaced) return flip('fsrs', ex.why === 'rmse' ? 'rmse' : 'worse');
    return stay();
  }
  // FSRS is scheduling: Own may take over only if every condition holds.
  if (inp.on !== true || state.autoLocked) return stay();
  if (state.errorPauseUntil != null && today < state.errorPauseUntil) return stay();
  if (!spaced) return stay();
  if (!betterTwiceInARow(inp.verdicts)) return stay();
  return flip('own', 'better');
}
