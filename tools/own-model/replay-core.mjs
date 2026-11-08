// The replay test, pure core (no files, no threads). Importable; tests/own-replay.test.js runs it on made-up learners.
//
// Question: if a learner's cards were scheduled by FSRS-6 or by the Own model, aiming at the same memory target, how many reviews would they
// need over the next days, and how much would they remember? Nobody can answer that from a log alone, so we simulate: both models are warmed up
// on the learner's real reviews up to their eval cutoff (nothing later is read), then a made-up learner answers day after day. What the learner
// "really" remembers is decided by a TRUTH model (Own or FSRS-6), the next due date by a SCHEDULER (FSRS-6 or Own).
//
//   warmUp(loaded, opts)      -> a warm state (cards, FSRS-6 weights and card memories, Own states and each card's curve)
//   simulate(warm, run, opts) -> { reviews, lapses, meanP, kEnd, kAvg, ... } for one truth x scheduler x target retention
//   replayUser(loaded, ctx)   -> the runs of one user (truth x sched x R) from the same warm state, as one record
//   summarizeReplay(records)  -> the aggregate report (tables and the matched-knowledge headline); no per-user numbers
//
// What is counted: the simulated cards are the ones last reviewed within `activeDays` days before the cutoff, whatever the scheduler (a card that
// has been dormant for a year is not a card the learner is studying). Everything the cards owe on day 1 is a backlog that depends on the
// scheduler, so the headline numbers start on day 2 (after the burn-in); day 1 is reported on its own. The mean p of the truth is taken over
// scheduled reviews only (the first review of a card on a day, after day 1); the repeats after a lapse are counted and averaged separately.
import { fit, splitHistories, clipWeights, forgettingCurve, initState, nextState, mulberry32 } from '../../js/fsrs-fit.js';
import { createOwnModel, StateStore } from '../../js/own-model.js';
import { OwnFeatures } from '../../js/own-features.js';
import { pAt, intervalDays, headFinite } from '../../js/own-curve.js';
import { fnv1a } from '../../js/rwkv-features.js';
import { ts, DEFAULT_W, BOUNDS, fsrsCardsFromRows } from './eval-core.mjs';
import { BOOT, mean, bootstrapMeanCI } from './eval-lib.mjs';

// Bump when a change to this file changes what a run computes: it is part of the resume key (replay.mjs), so old records are not reused. The app files the replay uses (js/own-model.js, js/own-curve.js, js/fsrs-fit.js) are covered by the hash in replay.mjs.
export const REPLAY_VERSION = 3;
export const FSRS_TARGETS = [0.80, 0.85, 0.90, 0.95];
export const OWN_TARGETS = [0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.92];
export const TRUTHS = ['own', 'fsrs'];
export const SCHEDS = ['fsrs', 'own'];
export const OWN_SCHEDS = ['head', 'fade'];   // head: the curve right after the answer; fade: note memory faded over the gap, other query features as of the answer
export const DEFAULTS = {
  days: 180, maxCards: 800, seed: 0, maxDays: 36500, snapshotEvery: 7, retryMinutes: 10, maxRetries: 3, activeDays: 90, ownSched: 'fade',
  ownTargets: OWN_TARGETS, fsrsTargets: FSRS_TARGETS
};
// the R values a scheduler is swept over (opts.targets, when given, is used for both)
export const gridOf = (o, sched) => o.targets || (sched === 'own' ? o.ownTargets : o.fsrsTargets);
export const runKey = (truth, sched, R) => `${truth}|${sched}|${R.toFixed(2)}`;

const DAY_MS = 86400000, DAY_START_MS = 9 * 3600000, MINUTE_MS = 60000, DEFAULT_ANSWER_MS = 8000;
const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const drive = gen => { for (;;) { const r = gen.next(); if (r.done) return r.value; } };

// ---------- common random numbers ----------
// u in [0, 1) for a review of a card: the same (seed, user, card, review number of that card) always gives the same u, whatever the scheduler.
// The review succeeds when u < p.
export function crnU(seed, user, cardKey, n) {
  return mulberry32(fnv1a(`replay-u|${seed}|${user}|${cardKey}|${n}`))();
}

// ---------- FSRS-6 pieces (all from the repo's code and ts-fsrs) ----------
const clip6 = w => clipWeights(w, 1, BOUNDS);
// FSRS-6's own interval: ts-fsrs's next_interval (interval modifier of the weights and target, rounded, at least 1, at most maxDays; no fuzz).
function fsrsIntervals(w, maxDays) {
  const algos = new Map();
  return (s, R) => {
    let a = algos.get(R);
    if (!a) algos.set(R, a = new ts.FSRSAlgorithm(ts.generatorParameters({ w: Array.from(w), request_retention: R, enable_fuzz: false, maximum_interval: maxDays })));
    return a.next_interval(s, 0);
  };
}
// Own's interval from the curve right after the answer ('head' mode): intervalDays, rounded to whole days, between 1 and maxDays.
const ownInterval = (head, R, maxDays) => clip(Math.round(intervalDays(head, R, maxDays)), 1, maxDays);

// ---------- Own: one learner's states, stepped one review at a time ----------
// The same recipe as Engine.review (js/own-engine.js) minus what the simulation does not need: begin() reads the states and decays them,
// p() draws the curve and reads it at the card's gap (the truth), commit() runs the update and (if asked) returns what the schedulers read:
// { next, fq } = the states right after the answer and the query features. 'head' mode reads the curve from them, 'fade' mode (model.fadedDays)
// fades the note memory over each candidate gap first.
export class OwnSim {
  constructor(model, store = new StateStore(), feats = new OwnFeatures()) { this.model = model; this.store = store; this.feats = feats; }
  clone() { return new OwnSim(this.model, this.store.clone(), OwnFeatures.fromJSON(this.feats.toJSON())); }
  begin(row) {
    const st = this.store;
    this.g = this.feats.gaps(row);
    this.fq = null;
    this.dec = this.model.decayAll({ card: st.cards.get(row.cardKey), note: st.notes.get(row.noteKey), deck: st.decks.get(row.deckKey), user: st.user || undefined },
      { note: this.g.note, deck: this.g.deck, user: this.g.user });
  }
  query(row) { return this.fq || (this.fq = this.feats.features(row, true)); }
  // chance of passing if the card is asked at this row's time (call after begin)
  p(row) {
    const head = this.model.headOf(this.dec, this.query(row));
    return pAt(head, this.g.card);
  }
  // the update; returns { next, fq } (see above) when wantAfter (call after begin)
  commit(row, wantAfter = false) {
    const next = this.model.advance(this.feats.features(row, false), this.dec), st = this.store;
    st.cards.set(row.cardKey, next.card); st.notes.set(row.noteKey, next.note); st.decks.set(row.deckKey, next.deck); st.user = next.user;
    const after = wantAfter ? { next, fq: this.query(row), head: undefined } : null;
    this.feats.commit(row);
    return after;
  }
}

// ---------- warm-up ----------
const median = xs => { if (!xs.length) return NaN; const a = Float64Array.from(xs).sort(); return a[a.length >> 1]; };

// The user's eval cutoff day: exactly eval's (the day by which 80% of the later-day scored reviews have happened).
export function cutoffOf(rows) { return splitHistories(fsrsCardsFromRows(rows), 0.8).cutoff; }

// loaded: { id, rows } (eval's loadLearner). opts: { params, size, seed, maxCards, activeDays, fitFsrs, weights (skips the fit), maxDays }
// -> the warm state. Only rows up to the cutoff day are read after the cutoff is found.
export function warmUp(loaded, opts) {
  const o = { ...DEFAULTS, fitFsrs: true, ...opts };
  const cutoff = cutoffOf(loaded.rows);
  const pre = [];
  for (const r of loaded.rows) if (r.day <= cutoff) pre.push(r);
  const warm = { user: String(loaded.id), seed: o.seed, maxDays: o.maxDays, cutoff, warmRows: pre.length };

  // FSRS-6: weights from the pre-cutoff reviews (the way eval's fsrs6_fitted does), then every card's memory replayed
  const preCards = fsrsCardsFromRows(pre);
  let w = DEFAULT_W;
  warm.fitStatus = 'given';
  if (o.weights) w = o.weights;
  else if (o.fitFsrs) {
    const t0 = performance.now();
    const r = drive(fit({ cards: preCards, current: DEFAULT_W, defaults: DEFAULT_W, bounds: BOUNDS, config: { skipCheck: true } }));
    warm.fitStatus = r.status;
    warm.fitSeconds = Math.round(performance.now() - t0) / 1000;
    if (r.status === 'trained') w = r.fitted;
  } else warm.fitStatus = 'default';
  warm.w = clip6(w);
  const fsrs = new Map();
  for (const c of preCards) {
    let s = 0, d = 0, day = c.day0;
    for (let i = 0; i < c.ratings.length; i++) {
      const g = c.ratings[i];
      if (i === 0) ({ s, d } = initState(warm.w, g, true));
      else { day += c.deltas[i]; ({ s, d } = nextState(warm.w, s, d, c.deltas[i], g, true)); }
    }
    fsrs.set(c.cardId, { s, d, lastDay: day });
  }

  // the cards to simulate: the ones with an FSRS memory (a scored life) whose last real review is within activeDays days before the cutoff
  // (chosen from the log alone, so every scheduler gets the same cards); a seeded subset of whole cards when there are many
  const lastIdx = new Map(), lastRow = new Map();
  pre.forEach((r, i) => { lastIdx.set(r.cardKey, i); lastRow.set(r.cardKey, r); });
  let keys = [...fsrs.keys()].sort(cmp);
  warm.cardsSeen = keys.length;
  keys = keys.filter(k => cutoff - lastRow.get(k).day <= o.activeDays);
  warm.cardsActive = keys.length;
  if (keys.length > o.maxCards) {
    const rng = mulberry32(fnv1a(`replay-cards|${o.seed}|${warm.user}`)), a = keys.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    keys = a.slice(0, o.maxCards).sort(cmp);
  }
  const kept = new Set(keys);
  warm.ms = median(pre.map(r => r.ms).filter(x => x > 0));
  if (!Number.isFinite(warm.ms)) warm.ms = DEFAULT_ANSWER_MS;

  // Own: all pre-cutoff rows, so the card, note, deck and user states are real; each kept card's curve right after its last real review
  const model = o.model || createOwnModel(o.params, o.size), own = new OwnSim(model), afters = new Map();
  pre.forEach((r, i) => {
    own.begin(r);
    const after = own.commit(r, kept.has(r.cardKey) && lastIdx.get(r.cardKey) === i);
    if (after) afters.set(r.cardKey, after);
  });
  warm.own = own;
  warm.cards = keys.map(key => {
    const lr = lastRow.get(key), f = fsrs.get(key);
    return { key, noteKey: lr.noteKey, deckKey: lr.deckKey, lastDay: f.lastDay, lastT: own.feats.cards.get(key).prevT, s: f.s, d: f.d, after: afters.get(key) };
  });
  warm.model = model;
  return warm;
}

// ---------- one run ----------
// run: { truth: 'own'|'fsrs', sched: 'fsrs'|'own', R }. opts: { days, seed, snapshotEvery, retryMinutes, maxRetries, ownSched, onReview(info) }.
// Starts from a clone of the warm state (the warm state is not changed). Days cutoff+1 .. cutoff+days.
// Headline counts (reviews, mean p, lapses) start on day cutoff+2; day 1 is reported as day1Reviews. totalReviews is everything.
// Returns { reviews, totalReviews, day1Reviews, scheduled, scheduledP, retries, retryP, meanP, lapses, kEnd, kAvg, perCard, cards,
//           ownIntervals, ownOneDay, ownFallbacks }.
export function simulate(warm, run, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, { truth, sched, R } = run, seed = opts.seed ?? warm.seed;
  if (!TRUTHS.includes(truth) || !SCHEDS.includes(sched)) throw new Error('truth and sched must be own or fsrs');
  if (!OWN_SCHEDS.includes(o.ownSched)) throw new Error('ownSched must be head or fade');
  const own = warm.own.clone(), w = warm.w, fsrsInterval = fsrsIntervals(w, warm.maxDays), ms = warm.ms, model = warm.model;
  const cards = warm.cards.map(c => ({ ...c, n: 0, due: 0, fails: 0 }));
  const owned = truth === 'own';
  let fallbacks = 0, ownIntervals = 0, ownOneDay = 0;
  // the next gap in whole days after a pass; `count` says whether to count it in the share of Own intervals at 1 day
  const intervalOf = (c, after, count) => {
    if (sched === 'own' && after) {
      let d = null;
      if (o.ownSched === 'fade') d = model.fadedDays(after.next, after.fq, R, warm.maxDays);
      else {
        if (after.head === undefined) after.head = model.headOf(after.next, after.fq);
        if (headFinite(after.head)) d = ownInterval(after.head, R, warm.maxDays);
      }
      if (d !== null) {
        d = clip(d, 1, warm.maxDays);
        if (count) { ownIntervals++; if (d === 1) ownOneDay++; }
        return d;
      }
    }
    if (sched === 'own') fallbacks++;       // a head that is not made of real numbers: leave the card to FSRS, like the app does
    return clip(fsrsInterval(c.s, R), 1, warm.maxDays);
  };
  for (const c of cards) c.due = Math.max(warm.cutoff + 1, c.lastDay + intervalOf(c, c.after, false));

  const pFsrs = (c, day, t) => { const td = day - c.lastDay; return forgettingCurve(w, td > 0 ? td : Math.max(0, (t - c.lastT) / DAY_MS), c.s, true); };
  const knowledge = day => {
    let sum = 0;
    const t = day * DAY_MS + DAY_START_MS;
    for (const c of cards) {
      if (owned) { const row = { cardKey: c.key, noteKey: c.noteKey, deckKey: c.deckKey, t, day, rating: 3, ms, gapSec: (t - c.lastT) / 1000 }; own.begin(row); sum += own.p(row); }
      else sum += pFsrs(c, day, t);
    }
    return sum / cards.length;
  };

  let day1 = 0, reviews = 0, lapses = 0, sumP = 0, scheduled = 0, schedP = 0, retries = 0, retryP = 0, k = 0;
  const snaps = [];
  const total = cards.length;
  for (k = 1; k <= o.days && total; k++) {
    const day = warm.cutoff + k;
    let now = day * DAY_MS + DAY_START_MS;
    const queue = cards.filter(c => c.due <= day).sort((a, b) => a.due - b.due || cmp(a.key, b.key));
    const wait = [];                       // failed cards waiting for their repeat, by time then key
    let qi = 0;
    const review = (c, retry) => {
      const row = { cardKey: c.key, noteKey: c.noteKey, deckKey: c.deckKey, t: now, day, rating: 3, ms, gapSec: Math.max(0, (now - c.lastT) / 1000) };
      own.begin(row);
      const p = owned ? own.p(row) : pFsrs(c, day, now);
      if (!(p >= 0 && p <= 1)) throw new Error(`truth gave p = ${p}`);
      const u = crnU(seed, warm.user, c.key, c.n), ok = u < p;
      row.rating = ok ? 3 : 1;
      const td = Math.max(0, day - c.lastDay);
      ({ s: c.s, d: c.d } = nextState(w, c.s, c.d, td, row.rating, true));
      c.lastDay = day;
      const after = own.commit(row, sched === 'own' && ok);
      o.onReview?.({ card: c.key, n: c.n, u, p, ok, day, t: now, retry });
      c.n++; c.lastT = now;
      if (k === 1) day1++;
      else {
        reviews++; sumP += p;
        if (retry) { retries++; retryP += p; } else { scheduled++; schedP += p; }
        if (!ok) lapses++;
      }
      if (ok) { c.due = day + intervalOf(c, after, k > 1); c.fails = 0; return; }
      c.fails++;
      if (c.fails > o.maxRetries) { c.due = day + 1; c.fails = 0; return; }
      const at = now + o.retryMinutes * MINUTE_MS;
      let j = wait.length;
      while (j > 0 && (wait[j - 1].at > at || (wait[j - 1].at === at && wait[j - 1].c.key > c.key))) j--;
      wait.splice(j, 0, { at, c });
      c.due = day;
    };
    while (qi < queue.length || wait.length) {
      let c, retry = false;
      if (wait.length && (qi >= queue.length || wait[0].at <= now)) { if (wait[0].at > now) now = wait[0].at; c = wait.shift().c; retry = true; }
      else { c = queue[qi++]; c.fails = 0; }
      review(c, retry);
      now += ms;
    }
    if (k % o.snapshotEvery === 0 || k === o.days) snaps.push(knowledge(day + 1));
  }
  return {
    reviews, totalReviews: reviews + day1, day1Reviews: day1, scheduled, scheduledP: scheduled ? schedP / scheduled : NaN, retries, retryP: retries ? retryP / retries : NaN,
    meanP: reviews ? sumP / reviews : NaN, lapses, kEnd: snaps.length ? snaps[snaps.length - 1] : NaN, kAvg: snaps.length ? mean(snaps) : NaN,
    perCard: total ? reviews / total : NaN, cards: total, ownIntervals, ownOneDay, ownFallbacks: fallbacks
  };
}

// ---------- one user, all runs ----------
// ctx: { params, size, model, seed, days, maxCards, activeDays, ownSched, fitFsrs, weights, targets | ownTargets + fsrsTargets }
export function replayUser(loaded, ctx = {}) {
  const t0 = performance.now(), o = { ...DEFAULTS, ...ctx };
  const warm = warmUp(loaded, o);
  const res = { user: String(loaded.id), ok: true, cutoff: warm.cutoff, warmRows: warm.warmRows, cardsSeen: warm.cardsSeen, cardsActive: warm.cardsActive, cards: warm.cards.length, fitStatus: warm.fitStatus, fitSeconds: warm.fitSeconds ?? null, medianMs: warm.ms, runs: {} };
  for (const truth of TRUTHS) for (const sched of SCHEDS) for (const R of gridOf(o, sched)) {
    const r = simulate(warm, { truth, sched, R }, o);
    for (const v of [r.reviews, r.kAvg, r.kEnd, r.reviews ? r.meanP : 0]) if (r.cards && !Number.isFinite(v)) { res.ok = false; res.error = `a run gave a value that is not a number (${truth} ${sched} ${R})`; }
    res.runs[runKey(truth, sched, R)] = r;
  }
  if (!warm.cards.length) { res.ok = false; res.error = 'no active card before the cutoff'; }
  res.seconds = Math.round(performance.now() - t0) / 1000;
  return res;
}

// ---------- the report ----------
// points: [{ x, y }] -> y at x by straight lines between the points (sorted by x); null when x is outside their range.
export function interpAt(points, x) {
  const p = points.filter(q => Number.isFinite(q.x) && Number.isFinite(q.y)).sort((a, b) => a.x - b.x);
  if (!p.length || x < p[0].x || x > p[p.length - 1].x) return null;
  for (let i = 0; i < p.length; i++) {
    if (p[i].x === x) return p[i].y;
    if (i + 1 < p.length && p[i].x < x && x <= p[i + 1].x) return p[i].y + (p[i + 1].y - p[i].y) * (x - p[i].x) / (p[i + 1].x - p[i].x);
  }
  return null;
}

const GRIDS = { own: OWN_TARGETS, fsrs: FSRS_TARGETS };
// One scheduler's knowledge curve for one user: the points (knowledge, reviews) in order of R, with knowledge made monotone by a running
// maximum (noise in a short simulation can make a higher R end up with a little less knowledge, which would zigzag the interpolation).
// -> [{ R, x: knowledge, y: reviews }]
export function curveOf(rec, truth, sched, grid) {
  const pts = grid.map(R => ({ R, r: rec.runs[runKey(truth, sched, R)] })).filter(q => q.r && Number.isFinite(q.r.kAvg) && Number.isFinite(q.r.reviews)).sort((a, b) => a.R - b.R);
  let top = -Infinity;
  return pts.map(q => ({ R: q.R, x: (top = Math.max(top, q.r.kAvg)), y: q.r.reviews }));
}

// Direction A. One user's % change in reviews, Own against FSRS, at the knowledge FSRS reaches with target R0: Own's reviews are read off Own's
// monotone curve at FSRS's knowledge. null when FSRS's knowledge is outside the range of Own's points. grids: { own, fsrs } (the R values swept).
export function matchedPct(rec, truth, R0, grids = GRIDS) {
  const f = rec.runs[runKey(truth, 'fsrs', R0)];
  if (!f || !(f.reviews > 0)) return null;
  const y = interpAt(curveOf(rec, truth, 'own', grids.own), f.kAvg);
  return y === null ? null : (y - f.reviews) / f.reviews * 100;
}

// Why matchedPct is null: 'below' when even Own's best knowledge is under FSRS's, 'above' when Own's lowest is over it.
export function matchedSide(rec, truth, R0, grids = GRIDS) {
  const f = rec.runs[runKey(truth, 'fsrs', R0)], xs = curveOf(rec, truth, 'own', grids.own).map(q => q.x);
  if (!f || !xs.length) return null;
  return f.kAvg > Math.max(...xs) ? 'below' : f.kAvg < Math.min(...xs) ? 'above' : null;
}

// Why matchedPctAtOwn is null: 'below' when Own's knowledge is under the lowest FSRS-6 point, 'above' when it is over the highest.
export function matchedSideAtOwn(rec, truth, Rown, grids = GRIDS) {
  const o = rec.runs[runKey(truth, 'own', Rown)], xs = curveOf(rec, truth, 'fsrs', grids.fsrs).map(q => q.x);
  if (!o || !Number.isFinite(o.kAvg) || !xs.length) return null;
  return o.kAvg < Math.min(...xs) ? 'below' : o.kAvg > Math.max(...xs) ? 'above' : null;
}

// Also null in direction B when FSRS-6's reviews at Own's knowledge are not above 0: true then (the user is left out for that reason).
export function zeroFsrsAtOwn(rec, truth, Rown, grids = GRIDS) {
  const o = rec.runs[runKey(truth, 'own', Rown)];
  if (!o || !Number.isFinite(o.kAvg) || !Number.isFinite(o.reviews)) return false;
  const y = interpAt(curveOf(rec, truth, 'fsrs', grids.fsrs), o.kAvg);
  return y !== null && !(y > 0);
}

// Direction B. One user's % change in reviews at the knowledge Own reaches with target Rown: Own's reviews against FSRS's reviews read off
// FSRS's monotone curve at Own's knowledge. null when Own's knowledge is outside the range of FSRS's points.
export function matchedPctAtOwn(rec, truth, Rown, grids = GRIDS) {
  const o = rec.runs[runKey(truth, 'own', Rown)];
  if (!o || !Number.isFinite(o.kAvg) || !Number.isFinite(o.reviews)) return null;
  const y = interpAt(curveOf(rec, truth, 'fsrs', grids.fsrs), o.kAvg);
  return y === null || !(y > 0) ? null : (o.reviews - y) / y * 100;
}

const median2 = xs => { const a = xs.slice().sort((x, y) => x - y), n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : NaN; };
// Seeded percentile bootstrap of the median over users (the mean uses the eval's bootstrapMeanCI).
export function bootstrapMedianCI(xs, { resamples = BOOT.resamples, seed = BOOT.seed, level = BOOT.level } = {}) {
  const n = xs.length;
  if (!n) return { median: NaN, lo: NaN, hi: NaN, n: 0 };
  const rng = mulberry32(seed >>> 0), meds = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) { const s = new Array(n); for (let i = 0; i < n; i++) s[i] = xs[Math.floor(rng() * n)]; meds[r] = median2(s); }
  meds.sort();
  const a = (1 - level) / 2, at = q => meds[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))];
  return { median: median2(xs), lo: at(a), hi: at(1 - a), n };
}

const f1 = x => (Number.isFinite(x) ? x.toFixed(1) : 'n/a'), f3 = x => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const pct = x => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)}%` : 'n/a');
const share = x => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/a');
const meanFinite = xs => mean(xs.filter(Number.isFinite));
const has = (grid, R) => grid.some(t => Math.abs(t - R) < 1e-9);

// records: the per-user records. meta: { tag, split, git, modelName, modelSha, cfg, ownTargets, fsrsTargets, ownSched, fitFsrs, failed }.
// meta.failed: this run's failed users' records ({ ok: false, error }) that are not in `records`. -> { markdown, data } with aggregates only.
export function summarizeReplay(records, meta = {}) {
  const grids = { own: meta.ownTargets || OWN_TARGETS, fsrs: meta.fsrsTargets || FSRS_TARGETS };
  const ownSched = meta.ownSched || DEFAULTS.ownSched;
  const ok = records.filter(r => r.ok), failedRecs = [...records.filter(r => !r.ok), ...(meta.failed || [])], failed = failedRecs.length;
  const lines = [`# Replay test: ${meta.tag || ''}`, ''];
  lines.push(`Code ${meta.git || 'unknown'}; replay version ${REPLAY_VERSION}; model ${meta.modelName || 'n/a'}${meta.modelSha ? ` (${meta.modelSha})` : ''}; split ${meta.split || 'n/a'}; ${meta.cfg || ''}.`);
  lines.push(`Own scheduler mode: ${ownSched} (${ownSched === 'fade'
    ? 'an interval is the longest whole gap at which the model\'s prediction still meets R with the note memory faded over the gap and the other query features as of the answer'
    : 'an interval is read from the curve right after the answer, without fading the note memory'}). Own R values: ${grids.own.map(x => x.toFixed(2)).join(' ')}; FSRS-6 R values: ${grids.fsrs.map(x => x.toFixed(2)).join(' ')}.`);
  lines.push(`FSRS-6 uses weights fitted per user on that user's own reviews before the cutoff${meta.fitFsrs === false ? ' (this run used the default weights instead)' : ''}; Own is zero-shot: one shared model, nothing fitted to the user. This favours FSRS-6.`);
  lines.push(`${ok.length} users${failed ? `, ${failed} failed and left out` : ''}. Per scheduler and target retention R, means over users. Simulated cards: those last reviewed within the active window before the cutoff, the same cards for both schedulers. Reviews, mean p and lapses start on day 2 (day 1 is the backlog due right after the cutoff and is listed apart; Total includes it). Mean p is over scheduled reviews only (first review of a card that day); repeats after a lapse are counted and averaged apart.`, '');
  const data = { users: ok.length, failed, ownSched, truths: {} };
  if (failed) {
    const why = new Map();
    for (const r of failedRecs) { const e = String(r.error || 'unknown').replace(/\d+/g, '#').slice(0, 120); why.set(e, (why.get(e) || 0) + 1); }
    data.failedReasons = Object.fromEntries(why);
    lines.push(`Failed users, by reason: ${[...why].map(([e, n]) => `${n} x ${e}`).join('; ')}.`, '');
  }
  const runsOf = (truth, sched, R) => ok.map(r => r.runs[runKey(truth, sched, R)]).filter(Boolean);
  const stat = (rs, f) => meanFinite(rs.map(f));
  for (const truth of TRUTHS) {
    lines.push(`## Truth: ${truth === 'own' ? 'Own model' : 'FSRS-6'}`, '', '| Scheduler | R | Reviews per user (day 2+) | Per card | Total (with day 1) | Day 1 | Mean p, scheduled | Retries | Mean p, retries | Own intervals at 1 day | Knowledge at the end | Knowledge, time-average | Lapses per user |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const T = data.truths[truth] = { table: {}, headline: {}, atOwn: {} };
    for (const sched of SCHEDS) for (const R of grids[sched]) {
      const rs = runsOf(truth, sched, R);
      const row = {
        users: rs.length, reviews: stat(rs, r => r.reviews), perCard: stat(rs, r => r.perCard), totalReviews: stat(rs, r => r.totalReviews), day1Reviews: stat(rs, r => r.day1Reviews),
        scheduledP: stat(rs, r => r.scheduledP), retries: stat(rs, r => r.retries), retryP: stat(rs, r => r.retryP), meanP: stat(rs, r => r.meanP),
        oneDay: sched === 'own' ? stat(rs, r => (r.ownIntervals ? r.ownOneDay / r.ownIntervals : NaN)) : NaN,
        kEnd: stat(rs, r => r.kEnd), kAvg: stat(rs, r => r.kAvg), lapses: stat(rs, r => r.lapses)
      };
      T.table[`${sched}|${R.toFixed(2)}`] = row;
      lines.push(`| ${sched === 'own' ? 'Own' : 'FSRS-6'} | ${R.toFixed(2)} | ${f1(row.reviews)} | ${f1(row.perCard)} | ${f1(row.totalReviews)} | ${f1(row.day1Reviews)} | ${f3(row.scheduledP)} | ${f1(row.retries)} | ${f3(row.retryP)} | ${sched === 'own' ? share(row.oneDay) : '-'} | ${f3(row.kEnd)} | ${f3(row.kAvg)} | ${f1(row.lapses)} |`);
    }
    lines.push('', `Headline, truth ${truth === 'own' ? 'Own' : 'FSRS-6'}: change in reviews for Own against FSRS-6 at matched knowledge, Own's reviews read at FSRS-6's knowledge. For each user, Own's ${grids.own.length} points (time-averaged knowledge, reviews) are made monotone in knowledge (sorted by R, running maximum) and joined by straight lines; reviews are read at the knowledge FSRS-6 reaches with the given R. Negative means Own needs fewer reviews. The headline covers only users inside the range: users whose Own points do not reach FSRS-6's knowledge are left out of that row (counted below), so the users shown can differ from all users.`, '',
      '| FSRS-6 at R | Users covered | Left out: Own stays below / above / FSRS-6 0 reviews | Mean change | 95% CI (bootstrap over users) | Median change | 95% CI |', '|---|---|---|---|---|---|---|');
    for (const R0 of [0.85, 0.90]) {
      if (!has(grids.fsrs, R0)) continue;
      const d = ok.map(r => matchedPct(r, truth, R0, grids)).filter(x => x !== null);
      const m = bootstrapMeanCI(d, { seed: fnv1a(`replay|${truth}|${R0}`) }), md = bootstrapMedianCI(d, { seed: fnv1a(`replay-median|${truth}|${R0}`) });
      const zeroF = r => { const f = r.runs[runKey(truth, 'fsrs', R0)]; return !!f && !(f.reviews > 0); };
      const zeroFsrs = ok.filter(zeroF).length;
      const below = ok.filter(r => !zeroF(r) && matchedSide(r, truth, R0, grids) === 'below').length, above = ok.filter(r => !zeroF(r) && matchedSide(r, truth, R0, grids) === 'above').length;
      T.headline[R0.toFixed(2)] = { users: d.length, leftOut: ok.length - d.length, below, above, zeroFsrs, mean: m.mean, meanLo: m.lo, meanHi: m.hi, median: md.median, medianLo: md.lo, medianHi: md.hi };
      lines.push(`| ${R0.toFixed(2)} | ${d.length} of ${ok.length} | ${ok.length - d.length}: ${below} / ${above} / ${zeroFsrs} | ${pct(m.mean)} | [${pct(m.lo)}, ${pct(m.hi)}] | ${pct(md.median)} | [${pct(md.lo)}, ${pct(md.hi)}] |`);
    }
    const mid = grids.own.slice().sort((a, b) => a - b).slice(1, -1);
    lines.push('', `The other direction, truth ${truth === 'own' ? 'Own' : 'FSRS-6'}: Own's middle points (the ${mid.length} Own R values that are neither the lowest nor the highest), with FSRS-6's reviews read off FSRS-6's monotone curve at Own's knowledge. This too covers only users whose Own knowledge lies inside FSRS-6's range.`, '',
      '| Own at R | Users covered | Left out: Own below / above FSRS-6\'s range / FSRS-6 0 reviews | Mean change | 95% CI (bootstrap over users) | Median change | 95% CI |', '|---|---|---|---|---|---|---|');
    for (const R of mid) {
      const d = ok.map(r => matchedPctAtOwn(r, truth, R, grids)).filter(x => x !== null);
      const m = bootstrapMeanCI(d, { seed: fnv1a(`replay-own|${truth}|${R}`) }), md = bootstrapMedianCI(d, { seed: fnv1a(`replay-own-median|${truth}|${R}`) });
      const below = ok.filter(r => matchedSideAtOwn(r, truth, R, grids) === 'below').length, above = ok.filter(r => matchedSideAtOwn(r, truth, R, grids) === 'above').length;
      const zeroFsrs = ok.filter(r => zeroFsrsAtOwn(r, truth, R, grids)).length;
      T.atOwn[R.toFixed(2)] = { users: d.length, leftOut: ok.length - d.length, below, above, zeroFsrs, mean: m.mean, meanLo: m.lo, meanHi: m.hi, median: md.median, medianLo: md.lo, medianHi: md.hi };
      lines.push(`| ${R.toFixed(2)} | ${d.length} of ${ok.length} | ${ok.length - d.length}: ${below} / ${above} / ${zeroFsrs} | ${pct(m.mean)} | [${pct(m.lo)}, ${pct(m.hi)}] | ${pct(md.median)} | [${pct(md.lo)}, ${pct(md.hi)}] |`);
    }
    lines.push('');
  }
  const fb = ok.reduce((a, r) => a + Object.values(r.runs).reduce((b, x) => b + (x.ownFallbacks || 0), 0), 0);
  if (fb) lines.push(`Own heads that were not real numbers (the card was left to FSRS-6): ${fb}.`, '');
  return { markdown: lines.join('\n'), data };
}
