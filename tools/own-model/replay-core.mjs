// The replay test, pure core (no files, no threads). Importable; tests/own-replay.test.js runs it on made-up learners.
//
// Question: if a learner's cards were scheduled by FSRS-6 or by the Own model, aiming at the same memory target, how many reviews would they
// need over the next days, and how much would they remember? Nobody can answer that from a log alone, so we simulate: both models are warmed up
// on the learner's real reviews up to their eval cutoff (nothing later is read), then a made-up learner answers day after day. What the learner
// "really" remembers is decided by a TRUTH model (Own or FSRS-6), the next due date by a SCHEDULER (FSRS-6 or Own).
//
//   warmUp(loaded, opts)      -> a warm state (cards, FSRS-6 weights and card memories, Own states and each card's curve)
//   simulate(warm, run, opts) -> { reviews, lapses, meanP, kEnd, kAvg, ... } for one truth x scheduler x target retention
//   replayUser(loaded, ctx)   -> the 16 runs of one user (truth x sched x R) from the same warm state, as one record
//   summarizeReplay(records)  -> the aggregate report (tables and the matched-knowledge headline); no per-user numbers
import { fit, splitHistories, clipWeights, forgettingCurve, initState, nextState, mulberry32 } from '../../js/fsrs-fit.js';
import { createOwnModel, StateStore } from '../../js/own-model.js';
import { OwnFeatures } from '../../js/own-features.js';
import { pAt, intervalDays, headFinite } from '../../js/own-curve.js';
import { fnv1a } from '../../js/rwkv-features.js';
import { ts, DEFAULT_W, BOUNDS, fsrsCardsFromRows } from './eval-core.mjs';
import { BOOT, mean, bootstrapMeanCI } from './eval-lib.mjs';

export const TARGETS = [0.80, 0.85, 0.90, 0.95];
export const TRUTHS = ['own', 'fsrs'];
export const SCHEDS = ['fsrs', 'own'];
export const DEFAULTS = { days: 180, maxCards: 800, seed: 0, maxDays: 36500, snapshotEvery: 7, retryMinutes: 10, maxRetries: 3 };
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
// Own's interval, the call the app's engine makes (daysForButtons): intervalDays, rounded to whole days, between 1 and maxDays.
const ownInterval = (head, R, maxDays) => clip(Math.round(intervalDays(head, R, maxDays)), 1, maxDays);

// ---------- Own: one learner's states, stepped one review at a time ----------
// The same recipe as Engine.review (js/own-engine.js) minus what the simulation does not need: begin() reads the states and decays them,
// p() draws the curve and reads it at the card's gap (the truth), commit() runs the update and (if asked) reads the card's curve right after it.
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
  // the update; returns the card's curve right after it when wantHead (call after begin)
  commit(row, wantHead = false) {
    const next = this.model.advance(this.feats.features(row, false), this.dec), st = this.store;
    st.cards.set(row.cardKey, next.card); st.notes.set(row.noteKey, next.note); st.decks.set(row.deckKey, next.deck); st.user = next.user;
    const head = wantHead ? this.model.headOf(next, this.query(row)) : null;
    this.feats.commit(row);
    return head;
  }
}

// ---------- warm-up ----------
const median = xs => { if (!xs.length) return NaN; const a = Float64Array.from(xs).sort(); return a[a.length >> 1]; };

// The user's eval cutoff day: exactly eval's (the day by which 80% of the later-day scored reviews have happened).
export function cutoffOf(rows) { return splitHistories(fsrsCardsFromRows(rows), 0.8).cutoff; }

// loaded: { id, rows } (eval's loadLearner). opts: { params, size, seed, maxCards, fitFsrs, weights (skips the fit), maxDays }
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

  // the cards to simulate: the ones with an FSRS memory (a scored life), seen before the cutoff; a seeded subset of whole cards when there are many
  let keys = [...fsrs.keys()].sort(cmp);
  warm.cardsSeen = keys.length;
  if (keys.length > o.maxCards) {
    const rng = mulberry32(fnv1a(`replay-cards|${o.seed}|${warm.user}`)), a = keys.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    keys = a.slice(0, o.maxCards).sort(cmp);
  }
  const kept = new Set(keys), lastIdx = new Map(), lastRow = new Map();
  pre.forEach((r, i) => { if (kept.has(r.cardKey)) { lastIdx.set(r.cardKey, i); lastRow.set(r.cardKey, r); } });
  warm.ms = median(pre.map(r => r.ms).filter(x => x > 0));
  if (!Number.isFinite(warm.ms)) warm.ms = DEFAULT_ANSWER_MS;

  // Own: all pre-cutoff rows, so the card, note, deck and user states are real; each kept card's curve right after its last real review
  const model = o.model || createOwnModel(o.params, o.size), own = new OwnSim(model), heads = new Map();
  pre.forEach((r, i) => {
    own.begin(r);
    const head = own.commit(r, lastIdx.get(r.cardKey) === i);
    if (head) heads.set(r.cardKey, head);
  });
  warm.own = own;
  warm.cards = keys.map(key => {
    const lr = lastRow.get(key), f = fsrs.get(key);
    return { key, noteKey: lr.noteKey, deckKey: lr.deckKey, lastDay: f.lastDay, lastT: own.feats.cards.get(key).prevT, s: f.s, d: f.d, head: heads.get(key) };
  });
  warm.model = model;
  return warm;
}

// ---------- one run ----------
// run: { truth: 'own'|'fsrs', sched: 'fsrs'|'own', R }. opts: { days, seed, snapshotEvery, retryMinutes, maxRetries, onReview(info) }.
// Starts from a clone of the warm state (the warm state is not changed). Days cutoff+1 .. cutoff+days.
// Returns { reviews, lapses, meanP, kEnd, kAvg, perCard, cards, ownFallbacks }.
export function simulate(warm, run, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, { truth, sched, R } = run, seed = o.seed ?? warm.seed;
  if (!TRUTHS.includes(truth) || !SCHEDS.includes(sched)) throw new Error('truth and sched must be own or fsrs');
  const own = warm.own.clone(), w = warm.w, fsrsInterval = fsrsIntervals(w, warm.maxDays), ms = warm.ms;
  const cards = warm.cards.map(c => ({ ...c, n: 0, due: 0, fails: 0 }));
  const owned = truth === 'own';
  let fallbacks = 0;
  const intervalOf = (c, head) => {
    if (sched === 'own' && headFinite(head)) return ownInterval(head, R, warm.maxDays);
    if (sched === 'own') fallbacks++;       // a head that is not made of real numbers: leave the card to FSRS, like the app does
    return clip(fsrsInterval(c.s, R), 1, warm.maxDays);
  };
  for (const c of cards) c.due = Math.max(warm.cutoff + 1, c.lastDay + intervalOf(c, c.head));

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

  let reviews = 0, lapses = 0, sumP = 0;
  const snaps = [];
  const total = cards.length;
  for (let k = 1; k <= o.days && total; k++) {
    const day = warm.cutoff + k;
    let now = day * DAY_MS + DAY_START_MS;
    const queue = cards.filter(c => c.due <= day).sort((a, b) => a.due - b.due || cmp(a.key, b.key));
    const wait = [];                       // failed cards waiting for their repeat, by time then key
    let qi = 0;
    const review = c => {
      const row = { cardKey: c.key, noteKey: c.noteKey, deckKey: c.deckKey, t: now, day, rating: 3, ms, gapSec: Math.max(0, (now - c.lastT) / 1000) };
      own.begin(row);
      const p = owned ? own.p(row) : pFsrs(c, day, now);
      if (!(p >= 0 && p <= 1)) throw new Error(`truth gave p = ${p}`);
      const u = crnU(seed, warm.user, c.key, c.n), ok = u < p;
      row.rating = ok ? 3 : 1;
      const td = Math.max(0, day - c.lastDay);
      ({ s: c.s, d: c.d } = nextState(w, c.s, c.d, td, row.rating, true));
      c.lastDay = day;
      const head = own.commit(row, sched === 'own' && ok);
      o.onReview?.({ card: c.key, n: c.n, u, p, ok, day, t: now });
      c.n++; c.lastT = now; reviews++; sumP += p;
      if (ok) { c.due = day + intervalOf(c, head); c.fails = 0; return; }
      lapses++; c.fails++;
      if (c.fails > o.maxRetries) { c.due = day + 1; c.fails = 0; return; }
      const at = now + o.retryMinutes * MINUTE_MS;
      let j = wait.length;
      while (j > 0 && (wait[j - 1].at > at || (wait[j - 1].at === at && wait[j - 1].c.key > c.key))) j--;
      wait.splice(j, 0, { at, c });
      c.due = day;
    };
    while (qi < queue.length || wait.length) {
      let c;
      if (wait.length && (qi >= queue.length || wait[0].at <= now)) { if (wait[0].at > now) now = wait[0].at; c = wait.shift().c; }
      else { c = queue[qi++]; c.fails = 0; }
      review(c);
      now += ms;
    }
    if (k % o.snapshotEvery === 0 || k === o.days) snaps.push(knowledge(day + 1));
  }
  return {
    reviews, lapses, meanP: reviews ? sumP / reviews : NaN, kEnd: snaps.length ? snaps[snaps.length - 1] : NaN, kAvg: snaps.length ? mean(snaps) : NaN,
    perCard: total ? reviews / total : NaN, cards: total, ownFallbacks: fallbacks
  };
}

// ---------- one user, all 16 runs ----------
// ctx: { params, size, model, seed, days, maxCards, fitFsrs, weights, targets }
export function replayUser(loaded, ctx = {}) {
  const t0 = performance.now(), o = { ...DEFAULTS, ...ctx };
  const warm = warmUp(loaded, o);
  const res = { user: String(loaded.id), ok: true, cutoff: warm.cutoff, warmRows: warm.warmRows, cardsSeen: warm.cardsSeen, cards: warm.cards.length, fitStatus: warm.fitStatus, fitSeconds: warm.fitSeconds ?? null, medianMs: warm.ms, runs: {} };
  for (const truth of TRUTHS) for (const sched of SCHEDS) for (const R of o.targets || TARGETS) {
    const r = simulate(warm, { truth, sched, R }, o);
    for (const v of [r.reviews, r.meanP, r.kAvg, r.kEnd]) if (r.cards && !Number.isFinite(v)) { res.ok = false; res.error = `a run gave a value that is not a number (${truth} ${sched} ${R})`; }
    res.runs[runKey(truth, sched, R)] = r;
  }
  if (!warm.cards.length) { res.ok = false; res.error = 'no card was seen before the cutoff'; }
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

// One user's % change in reviews, Own against FSRS, at the knowledge FSRS reaches with target R0 (null when Own's four points do not reach it).
export function matchedPct(rec, truth, R0, targets = TARGETS) {
  const f = rec.runs[runKey(truth, 'fsrs', R0)];
  if (!f || !(f.reviews > 0)) return null;
  const pts = targets.map(R => rec.runs[runKey(truth, 'own', R)]).filter(Boolean).map(r => ({ x: r.kAvg, y: r.reviews }));
  const y = interpAt(pts, f.kAvg);
  return y === null ? null : (y - f.reviews) / f.reviews * 100;
}

// Why matchedPct is null: 'below' when even Own's best knowledge is under FSRS's, 'above' when Own's lowest is over it.
export function matchedSide(rec, truth, R0, targets = TARGETS) {
  const f = rec.runs[runKey(truth, 'fsrs', R0)], xs = targets.map(R => rec.runs[runKey(truth, 'own', R)]?.kAvg).filter(Number.isFinite);
  if (!f || !xs.length) return null;
  return f.kAvg > Math.max(...xs) ? 'below' : f.kAvg < Math.min(...xs) ? 'above' : null;
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

// records: the per-user records. meta: { tag, split, git, modelName, modelSha, cfg, targets }. -> { markdown, data } with aggregates only.
export function summarizeReplay(records, meta = {}) {
  const targets = meta.targets || TARGETS, ok = records.filter(r => r.ok), failed = records.length - ok.length;
  const lines = [`# Replay test: ${meta.tag || ''}`, ''];
  lines.push(`Code ${meta.git || 'unknown'}; model ${meta.modelName || 'n/a'}${meta.modelSha ? ` (${meta.modelSha})` : ''}; split ${meta.split || 'n/a'}; ${meta.cfg || ''}.`);
  lines.push(`${ok.length} users${failed ? `, ${failed} failed and left out` : ''}. Per scheduler and target retention R, means over users.`, '');
  const data = { users: ok.length, failed, truths: {} };
  const runsOf = (truth, sched, R) => ok.map(r => r.runs[runKey(truth, sched, R)]).filter(Boolean);
  for (const truth of TRUTHS) {
    lines.push(`## Truth: ${truth === 'own' ? 'Own model' : 'FSRS-6'}`, '', '| Scheduler | R | Reviews per user | Reviews per card | Mean p at review | Knowledge at the end | Knowledge, time-average | Lapses per user |', '|---|---|---|---|---|---|---|---|');
    const T = data.truths[truth] = { table: {}, headline: {} };
    for (const sched of SCHEDS) for (const R of targets) {
      const rs = runsOf(truth, sched, R);
      const row = { users: rs.length, reviews: mean(rs.map(r => r.reviews)), perCard: mean(rs.map(r => r.perCard)), meanP: mean(rs.map(r => r.meanP)), kEnd: mean(rs.map(r => r.kEnd)), kAvg: mean(rs.map(r => r.kAvg)), lapses: mean(rs.map(r => r.lapses)) };
      T.table[`${sched}|${R.toFixed(2)}`] = row;
      lines.push(`| ${sched === 'own' ? 'Own' : 'FSRS-6'} | ${R.toFixed(2)} | ${f1(row.reviews)} | ${f1(row.perCard)} | ${f3(row.meanP)} | ${f3(row.kEnd)} | ${f3(row.kAvg)} | ${f1(row.lapses)} |`);
    }
    lines.push('', `Headline, truth ${truth === 'own' ? 'Own' : 'FSRS-6'}: change in reviews for Own against FSRS-6 at matched knowledge. For each user, reviews are read off a straight line through that scheduler's ${targets.length} points (time-averaged knowledge, reviews) at the knowledge FSRS-6 reaches with the given R. Negative means Own needs fewer reviews. Users whose Own points do not reach that knowledge are left out of that row.`, '',
      '| FSRS-6 at R | Users | Left out: Own stays below / above | Mean change | 95% CI (paired bootstrap over users) | Median change | 95% CI |', '|---|---|---|---|---|---|---|');
    for (const R0 of [0.90, 0.85]) {
      if (!targets.some(t => Math.abs(t - R0) < 1e-9)) continue;
      const d = ok.map(r => matchedPct(r, truth, R0, targets)).filter(x => x !== null);
      const m = bootstrapMeanCI(d, { seed: fnv1a(`replay|${truth}|${R0}`) }), md = bootstrapMedianCI(d, { seed: fnv1a(`replay-median|${truth}|${R0}`) });
      const below = ok.filter(r => matchedSide(r, truth, R0, targets) === 'below').length, above = ok.filter(r => matchedSide(r, truth, R0, targets) === 'above').length;
      T.headline[R0.toFixed(2)] = { users: d.length, leftOut: ok.length - d.length, below, above, mean: m.mean, meanLo: m.lo, meanHi: m.hi, median: md.median, medianLo: md.lo, medianHi: md.hi };
      lines.push(`| ${R0.toFixed(2)} | ${d.length} | ${ok.length - d.length}: ${below} / ${above} | ${pct(m.mean)} | [${pct(m.lo)}, ${pct(m.hi)}] | ${pct(md.median)} | [${pct(md.lo)}, ${pct(md.hi)}] |`);
    }
    lines.push('');
  }
  const fb = ok.reduce((a, r) => a + Object.values(r.runs).reduce((b, x) => b + (x.ownFallbacks || 0), 0), 0);
  if (fb) lines.push(`Own heads that were not real numbers (the card was left to FSRS-6): ${fb}.`, '');
  return { markdown: lines.join('\n'), data };
}
