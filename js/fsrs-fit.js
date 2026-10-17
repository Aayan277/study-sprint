// Fit FSRS-6 weights to a person's own review history, in plain JavaScript (no imports, no network).
// Design and reasons: docs/design/fsrs-optimizer-plan.md (sections 2c and 4). Tested by tests/fsrs-fit.test.js and
// tests/fsrs-parity.test.js (which checks the forward model against ts-fsrs 5.4.2).
//
// The pieces:
//   forward model   nextState / forgettingCurve: the same maths as ts-fsrs 5.4.2 (FSRSAlgorithm), step by step through a card's history
//   gradients       lossAndGrad: the same maths again on "dual numbers" (a value plus its 17 derivatives), so the gradient is exact
//   pretraining     the four starting stabilities w0 to w3 from each first rating's next long-term review
//   Adam            mini-batches of cards, a seeded shuffle, every weight kept inside its bounds
//   recency         the fit counts newer reviews more (recencyWeight, as fsrs-rs does); the keep rule below does not
//   metrics         evaluate: log loss and RMSE (bins) for any set of weights; decide: keep the new ones only if better
//   fit             a generator: it yields progress as it goes, so it runs to the end in Node, in a Worker, or in slices on the main thread
//
// A history (built by fsrs-data.js) is { deltas: Int32Array, ratings: Uint8Array, scored: Uint8Array, day0? }, one entry per
// answer: deltas[i] = whole days since the answer before (0 for the first or the same day), ratings[i] = 1 to 4,
// scored[i] = 1 for a real review (checked against the prediction), 0 for a replayed one (only moves the memory state).

export const S_MIN = 0.001;
export const S_MAX = 36500;
export const N_WEIGHTS = 21;
export const FIRST_TRAINED = 4;                 // w0 to w3 come from pretraining; w4 to w20 are trained
const P = N_WEIGHTS - FIRST_TRAINED;            // 17 trained weights = 17 derivatives per number
const EPS = 1e-6;                               // predictions are kept this far from 0 and 1 in the loss
const BINS = 20;
const LN09 = Math.log(0.9);

export const FIT_DEFAULTS = {
  epochs: 5,            // passes over the data
  batchSize: 512,       // real reviews (with a prediction) per step, about
  lr: 0.04,             // Adam's step size at the start (it falls to a tenth by the end)
  gamma: 1000,          // strength of the pull towards the default weights, in "reviews" (see the loss above). Was 8; tuned on simulator seeds 31 to 60 (tests/sim/compare/report-optimizer.md)
  seed: 1,              // the shuffle: the same seed and data give the same weights
  minReviews: 400,      // fewer real reviews than this: no fit
  priorN: 6,            // pretraining blends with the default start stability as if it had this many samples
  recency: true,        // weight newer reviews more in the training loss (recencyWeight below). The keep rule always scores every review equally
};

// ---------- recency weighting ----------
// People change: a review from last week says more about how you remember now than one from two years ago. The training
// loss (not the keep rule, and not the numbers shown to the person) therefore counts each review with a weight that
// rises with its age, as fsrs-rs does with its "recency weighting". The curve:
//
//     weight(x) = floor + (1 - floor) * x^3
//     x = the review's place in time among all the reviews that get a prediction (0 = the oldest, 1 = the newest)
//
// fsrs-rs uses floor 0.25 (the oldest review counts a quarter as much as the newest). Ours is RECENCY_FLOOR = 0.5, milder, chosen
// on simulator seeds 31 to 60 (report-optimizer.md, "Recency weighting"): the simulator's students never change, so any recency
// can only cost them, and 0.25 cost 1.7 (x10^-3 log loss, summed over the three learners) against no recency, where 0.5 cost nothing.
// With floor 0.5: the oldest review counts 0.5, the middle one 0.56, three quarters of the way through 0.71, the newest 1; the
// average over a whole history is 0.625. The loss is divided by the sum of the weights (a weighted mean), so it keeps its scale.
// Reviews on the same day share a place (the rank of the day's first review).
// Needs `day0` on the histories; without it every review counts 1 (as in a hand-made test history).
export const RECENCY_FLOOR = 0.5;
export const recencyWeight = (x, floor = RECENCY_FLOOR) => floor + (1 - floor) * x * x * x;

// A copy of the histories with `wt` (Float64Array, one number per answer: the weight of a scored prediction, 1 elsewhere).
export function withRecency(cards, floor = RECENCY_FLOOR) {
  const days = [];
  for (const c of cards) {
    if (!Number.isFinite(c.day0)) return cards;
    let day = c.day0;
    for (let i = 0; i < c.ratings.length; i++) { day += c.deltas[i]; if (c.scored[i] && i > 0 && c.deltas[i] > 0) days.push(day); }
  }
  if (days.length < 2) return cards;
  days.sort((a, b) => a - b);
  const n = days.length;
  const first = new Map();                                    // day -> rank of the first prediction on it
  for (let i = 0; i < n; i++) if (!first.has(days[i])) first.set(days[i], i);
  return cards.map(c => {
    const wt = new Float64Array(c.ratings.length).fill(1);
    let day = c.day0;
    for (let i = 0; i < c.ratings.length; i++) {
      day += c.deltas[i];
      if (c.scored[i] && i > 0 && c.deltas[i] > 0) wt[i] = recencyWeight(first.get(day) / (n - 1), floor);
    }
    return { ...c, wt };
  });
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const r8 = x => Math.round(x * 1e8) / 1e8;      // ts-fsrs rounds to 8 decimals in many places

// ---------- random numbers ----------
// A small seeded generator (0 up to 1), so a fit can be repeated exactly.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the forward model (numbers) ----------
// round = true copies ts-fsrs exactly (it rounds to 8 decimals in places). round = false is the smooth version the gradients are for.

// The chance of remembering after t days with stability s: (1 + FACTOR · t / s) ^ -w20, FACTOR chosen so R = 90% at t = s.
export function forgettingCurve(w, t, s, round = true) {
  const decay = -w[20];
  let factor = Math.exp(Math.pow(decay, -1) * LN09) - 1;
  if (round) factor = r8(factor);
  const r = Math.pow(1 + factor * t / s, decay);
  return round ? r8(r) : r;
}

// The first answer on a new card.
export function initState(w, g, round = true) {
  const d = w[4] - Math.exp((g - 1) * w[5]) + 1;
  return { s: Math.max(w[g - 1], 0.1), d: clamp(round ? r8(d) : d, 1, 10) };
}

// The memory state after an answer: s = stability, d = difficulty, t = whole days since the last answer,
// g = rating 1 to 4, r (optional) = the chance of remembering that was predicted for this answer.
export function nextState(w, s, d, t, g, round = true, r) {
  const R = round ? r8 : x => x;
  if (r === undefined) r = forgettingCurve(w, t, s, round);
  let ns;
  if (t === 0) {                                                  // same day: the short-term formula
    const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
    ns = R(clamp(s * (g >= 2 ? Math.max(sinc, 1) : sinc), S_MIN, S_MAX));
  } else if (g === 1) {                                           // forgot
    const fail = R(clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX));
    ns = clamp(R(s / Math.exp(w[17] * w[18])), S_MIN, fail);
  } else {                                                        // remembered
    const hard = g === 2 ? w[15] : 1, easy = g === 4 ? w[16] : 1;
    ns = R(clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy), S_MIN, S_MAX));
  }
  const delta = -w[6] * (g - 3);
  const next = d + R(delta * (10 - d) / 9);
  const easyD = w[4] - Math.exp(3 * w[5]) + 1;
  const nd = clamp(R(w[7] * (round ? r8(easyD) : easyD) + (1 - w[7]) * next), 1, 10);
  return { s: ns, d: nd };
}

// ---------- metrics ----------
// Walk every history with weights w and compare each prediction (scored, on a later day than the answer before) with what happened.
//   logLoss  mean binary cross-entropy
//   rmse     the 20 equal bins of predicted R: sqrt of the count-weighted mean of (mean predicted − observed recall)²  ("RMSE (bins)")
//   n        how many predictions     recalled  how many of them were remembered (the share is the base rate for judging the log loss)
// (weighted: true uses the recency weights `wt` of the histories for the log loss; the sheet, the keep rule and the health check never do.)
export function evaluate(cards, w, opts) { return evaluateMany([{ cards, w }], opts); }

// The same, over several groups of cards that each use their own weights (the scheduler clips w17 and w18 differently
// for decks with different relearning steps): one log loss and one set of bins over everything.
//   parts  [{ cards, w }, …]
export function evaluateMany(parts, { round = true, weighted = false } = {}) {
  let n = 0, wn = 0, loss = 0, yes = 0;
  const cnt = new Float64Array(BINS), pred = new Float64Array(BINS), obs = new Float64Array(BINS);
  for (const { cards, w } of parts) for (const c of cards) {
    const { deltas, ratings, scored } = c;
    const wt = weighted ? c.wt : null;               // (weighted: the log loss is a recency-weighted mean; only the training uses this)
    let s = 0, d = 0;
    for (let i = 0; i < ratings.length; i++) {
      const g = ratings[i];
      if (i === 0) { ({ s, d } = initState(w, g, round)); continue; }
      const t = deltas[i];
      const r = forgettingCurve(w, t, s, round);
      if (scored[i] && t > 0) {
        const p = clamp(r, EPS, 1 - EPS), y = g > 1 ? 1 : 0;
        const q = wt ? wt[i] : 1;
        loss -= q * (y ? Math.log(p) : Math.log(1 - p));
        wn += q; yes += y;
        const b = Math.min(BINS - 1, Math.floor(p * BINS));
        cnt[b]++; pred[b] += p; obs[b] += y; n++;
      }
      ({ s, d } = nextState(w, s, d, t, g, round, r));
    }
  }
  let sq = 0;
  for (let b = 0; b < BINS; b++) if (cnt[b]) sq += cnt[b] * (pred[b] / cnt[b] - obs[b] / cnt[b]) ** 2;
  return { logLoss: n ? loss / wn : 0, rmse: n ? Math.sqrt(sq / n) : 0, n, wn, recalled: yes };
}

// The decision rule (owner decision Q2, softened after review): keep the new weights only if the log loss is lower AND the RMSE is not
// more than RMSE_SLACK (absolute, 1 percentage point) higher. The binned RMSE is noisy on a small held-out slice: with a few hundred
// predictions a strict "no higher" refused real gains about as often as it accepted them (see report-optimizer.md).
export const RMSE_SLACK = 0.01;
export const isBetter = (before, after) => after.logLoss < before.logLoss && after.rmse <= before.rmse + RMSE_SLACK;

// ---------- judging (the page and the simulator both use this) ----------
// Weights as the scheduler will use them: generatorParameters clips w17 and w18 to a ceiling that depends on the deck's number
// of relearning steps, so each group of cards is scored with the weights clipped for its own step count.
//   cards      histories (fsrs-data.js)       steps  relearning-step count of each card's deck (same order)
//   clip(w, n) ts-fsrs clipParameters(w, n, true)
// Returns { before, after, better } where before/after = { logLoss, rmse, n } for `current` and `fitted`.
export function judge(cards, steps, current, fitted, clip) {
  const groups = new Map();
  cards.forEach((c, i) => { const n = steps[i] ?? 1; if (!groups.has(n)) groups.set(n, []); groups.get(n).push(c); });
  const part = w => [...groups].map(([n, list]) => ({ cards: list, w: clip(w, n) }));
  const before = evaluateMany(part(current)), after = evaluateMany(part(fitted));
  return { before, after, better: isBetter(before, after) };
}

// ---------- gradients (dual numbers) ----------
// A dual number is { v: value, o: offset }: the value, and where its 17 derivatives (with respect to w4 to w20) sit in one big
// shared buffer G (o = -1: a constant, all zeros). Only the few operations the model needs are here.
// The buffer is a small arena: the weights sit at the start, then the memory state (s, d) carried from one answer to the next,
// then scratch space for one answer's arithmetic, which is handed back after each answer. So no array is made per operation.
const SLOT_S = 0, SLOT_D = P, SLOT_W = 2 * P;                 // the carried state, then the 17 trained weights
const ARENA = SLOT_W + P * P;                                  // scratch starts here
const G = new Float64Array(ARENA + 600 * P);
let top = ARENA;
const K = v => ({ v, o: -1 });
const D = x => (typeof x === 'number' ? { v: x, o: -1 } : x);
function lin(v, a, ca, b, cb) {                   // a number whose derivative is ca·a' + cb·b'
  const ao = a ? a.o : -1, bo = b ? b.o : -1;
  if (ao < 0 && bo < 0) return { v, o: -1 };
  const o = top;
  top += P;
  if (ao >= 0) for (let k = 0; k < P; k++) G[o + k] = ca * G[ao + k];
  else for (let k = 0; k < P; k++) G[o + k] = 0;
  if (bo >= 0) for (let k = 0; k < P; k++) G[o + k] += cb * G[bo + k];
  return { v, o };
}
const dadd = (a, b) => { a = D(a); b = D(b); return lin(a.v + b.v, a, 1, b, 1); };
const dsub = (a, b) => { a = D(a); b = D(b); return lin(a.v - b.v, a, 1, b, -1); };
const dmul = (a, b) => { a = D(a); b = D(b); return lin(a.v * b.v, a, b.v, b, a.v); };
const ddiv = (a, b) => { a = D(a); b = D(b); return lin(a.v / b.v, a, 1 / b.v, b, -a.v / (b.v * b.v)); };
const dneg = a => lin(-a.v, a, -1, null, 0);
const dexp = a => { const v = Math.exp(a.v); return lin(v, a, v, null, 0); };
const dpow = (a, b) => { a = D(a); b = D(b); const v = Math.pow(a.v, b.v); return lin(v, a, a.o >= 0 ? b.v * Math.pow(a.v, b.v - 1) : 0, b, b.o >= 0 ? Math.log(a.v) * v : 0); };
const dclamp = (a, lo, hi) => (a.v < lo ? K(lo) : a.v > hi ? K(hi) : a);
const dmin = (a, b) => (a.v > b.v ? b : a);     // the smaller of two (a tie keeps a)
// Keep a number past the end of the answer: copy its derivatives into a carried slot.
function keep(a, slot) {
  if (a.o < 0) return { v: a.v, o: -1 };
  G.copyWithin(slot, a.o, a.o + P);
  return { v: a.v, o: slot };
}

// Weights as dual numbers: w0 to w3 are constants, w4 to w20 each carry a derivative of 1 for themselves.
function dualWeights(w) {
  G.fill(0, SLOT_W, SLOT_W + P * P);
  return w.map((v, i) => {
    if (i < FIRST_TRAINED) return K(v);
    const o = SLOT_W + (i - FIRST_TRAINED) * P;
    G[o + i - FIRST_TRAINED] = 1;
    return { v, o };
  });
}

function dCurve(W, t, s) {
  const decay = dneg(W[20]);
  const factor = dsub(dexp(ddiv(LN09, decay)), 1);
  return dpow(dadd(1, dmul(factor, ddiv(t, s))), decay);
}

// The same update as nextState (round = false), on dual numbers. s and d are duals; r the dual prediction.
function dNext(W, s, d, t, g, r) {
  let ns;
  if (t === 0) {
    const sinc = dmul(dpow(s, dneg(W[19])), dexp(dmul(W[17], dadd(g - 3, W[18]))));
    ns = dclamp(dmul(s, g >= 2 && sinc.v < 1 ? K(1) : sinc), S_MIN, S_MAX);
  } else if (g === 1) {
    let fail = dmul(dmul(dmul(W[11], dpow(d, dneg(W[12]))), dsub(dpow(dadd(s, 1), W[13]), 1)), dexp(dmul(dsub(1, r), W[14])));
    fail = dclamp(fail, S_MIN, S_MAX);
    const floor = dclamp(ddiv(s, dexp(dmul(W[17], W[18]))), S_MIN, Infinity);
    ns = dmin(floor, fail);
  } else {
    let m = dmul(dmul(dexp(W[8]), dsub(11, d)), dpow(s, dneg(W[9])));
    m = dmul(m, dsub(dexp(dmul(dsub(1, r), W[10])), 1));
    if (g === 2) m = dmul(m, W[15]);
    if (g === 4) m = dmul(m, W[16]);
    ns = dclamp(dmul(s, dadd(1, m)), S_MIN, S_MAX);
  }
  const next = dadd(d, ddiv(dmul(dmul(W[6], -(g - 3)), dsub(10, d)), 9));
  const easyD = dadd(dsub(W[4], dexp(dmul(W[5], 3))), 1);
  const nd = dclamp(dadd(dmul(W[7], easyD), dmul(dsub(1, W[7]), next)), 1, 10);
  return { s: ns, d: nd };
}

// The log loss summed over some histories, and its gradient with respect to w4 to w20.
// Returns { loss (a sum, not a mean), count, wsum, grad: Float64Array(17) }. The forward values equal evaluate(..., { round: false }).
// A history with `wt` (withRecency) counts each prediction wt[i] times: loss and grad are weighted sums, wsum is the sum of the weights
// (count stays the plain number of predictions, wsum = count when there is no `wt`).
export function lossAndGrad(cards, w) {
  const W = dualWeights(w);
  const grad = new Float64Array(P);
  let loss = 0, count = 0, wsum = 0;
  for (const c of cards) {
    const { deltas, ratings, scored, wt } = c;
    let last = -1;
    for (let i = ratings.length - 1; i > 0; i--) if (scored[i] && deltas[i] > 0) { last = i; break; }
    if (last < 0) continue;
    let s, d;
    for (let i = 0; i <= last; i++) {
      const g = ratings[i];
      if (i === 0) {
        const o = initState(w, g, false);
        s = K(o.s);
        top = ARENA;
        d = keep(dclamp(dadd(dsub(W[4], dexp(dmul(W[5], g - 1))), 1), 1, 10), SLOT_D);
        continue;
      }
      const t = deltas[i];
      top = ARENA;                                  // hand back the scratch space of the answer before
      const r = dCurve(W, t, s);
      if (scored[i] && t > 0) {
        const p = r.v, y = g > 1, q = wt ? wt[i] : 1;
        if (p > EPS && p < 1 - EPS) {
          loss -= q * Math.log(y ? p : 1 - p);
          if (r.o >= 0) { const dl = q * (y ? -1 / p : 1 / (1 - p)); for (let k = 0; k < P; k++) grad[k] += dl * G[r.o + k]; }
        } else loss -= q * Math.log(clamp(y ? p : 1 - p, EPS, 1));
        count++; wsum += q;
      }
      const nx = dNext(W, s, d, t, g, r);
      if (top > G.length) throw new Error('fsrs-fit: the derivative buffer is too small');
      s = keep(nx.s, SLOT_S); d = keep(nx.d, SLOT_D);       // (both are copied out before either slot is read again)
    }
  }
  return { loss, count, wsum, grad };
}

// Put values in non-decreasing order by pooling neighbours that are the wrong way round (pool adjacent violators):
// a pooled block gets the weighted mean of its members. Works on log stabilities. Returns a new array.
export function poolAscending(values, weights = values.map(() => 1)) {
  const blocks = [];
  for (let g = 0; g < values.length; g++) {
    blocks.push({ v: values[g], w: weights[g], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop(), a = blocks.pop();
      blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.v);
  return out;
}

// ---------- pretraining w0 to w3 ----------
// The start stability for each first rating: the value that best predicts whether the card was remembered at its next
// long-term review. A golden-section search on log stability, blended with the default when there are few samples,
// then put in order (w0 ≤ w1 ≤ w2 ≤ w3) by pooling neighbours that are the wrong way round.
export function pretrainStarts(cards, defaults, bounds, decayW20, priorN = FIT_DEFAULTS.priorN) {
  const samples = [[], [], [], []];                          // per first rating: [days, remembered]
  for (const c of cards) {
    for (let i = 1; i < c.ratings.length; i++) {
      if (c.scored[i] && c.deltas[i] > 0) { samples[c.ratings[0] - 1].push([c.deltas[i], c.ratings[i] > 1 ? 1 : 0]); break; }
    }
  }
  const factor = Math.exp(Math.log(0.9) / -decayW20) - 1;
  const nll = (x, list) => {
    const s = Math.exp(x);
    let sum = 0;
    for (const [t, y] of list) {
      const p = clamp(Math.pow(1 + factor * t / s, -decayW20), EPS, 1 - EPS);
      sum -= y ? Math.log(p) : Math.log(1 - p);
    }
    return sum;
  };
  const gr = (Math.sqrt(5) - 1) / 2;
  const logs = [], weights = [];
  for (let g = 0; g < 4; g++) {
    const list = samples[g], n = list.length;
    const prior = Math.log(defaults[g]);
    let x = prior;
    if (n) {
      let lo = Math.log(bounds[g][0]), hi = Math.log(bounds[g][1]);
      let a = hi - gr * (hi - lo), b = lo + gr * (hi - lo), fa = nll(a, list), fb = nll(b, list);
      for (let it = 0; it < 50; it++) {
        if (fa < fb) { hi = b; b = a; fb = fa; a = hi - gr * (hi - lo); fa = nll(a, list); }
        else { lo = a; a = b; fa = fb; b = lo + gr * (hi - lo); fb = nll(b, list); }
      }
      x = (n * (lo + hi) / 2 + priorN * prior) / (n + priorN);
    }
    logs.push(x); weights.push(n + priorN);
  }
  const out = poolAscending(logs, weights);
  return out.map((x, g) => clamp(r8(Math.exp(x)), bounds[g][0], bounds[g][1]));
}

// ---------- the fit ----------
const round6 = x => Math.round(x * 1e6) / 1e6;

// How a fit goes, for the progress bar: pretraining 5%, training 80%, refining w0 to w3 7%, checking 8%.
const PROGRESS = { pretrain: [0, 0.05], train: [0.05, 0.85], refine: [0.85, 0.92], check: [0.92, 1] };
const at = (phase, frac) => PROGRESS[phase][0] + (PROGRESS[phase][1] - PROGRESS[phase][0]) * frac;

// Fit weights to the histories. A generator: each `yield` is { phase, done, total, progress } (progress 0 to 1, never going
// back), and the result is what `return` gives: use `yield*`, or step it with next() until done.
//
//   input.cards     the histories (fsrs-data.js buildHistories().cards)
//   input.current   the 21 weights in use now (the fit starts from them, and has to beat them)
//   input.defaults  ts-fsrs default_w (the pull of the prior, and the start for pretraining)
//   input.bounds    [[min, max], …] ×21 (ts-fsrs CLAMP_PARAMETERS)
//   input.config    overrides for FIT_DEFAULTS
//
// Result:
//   { status: 'not-enough', reviews, needed }
//   { status: 'better' | 'same', w, fitted, current, before, after, reviews, cards, longTerm }
//     w = the weights to use (the fitted ones if they predict better, else current); before/after = { logLoss, rmse, n } of current and fitted
export function* fit(input) {
  const cfg = { ...FIT_DEFAULTS, ...(input.config || {}) };
  const { defaults, bounds } = input;
  const current = (input.current || defaults).slice();
  const cards = input.cards;
  let reviews = 0, longTerm = 0, usable = 0;
  for (const c of cards) {
    let any = false;
    for (let i = 0; i < c.scored.length; i++) if (c.scored[i]) { reviews++; any = true; if (i > 0 && c.deltas[i] > 0) longTerm++; }
    if (any) usable++;
  }
  if (reviews < cfg.minReviews || longTerm === 0) return { status: 'not-enough', reviews, needed: cfg.minReviews };

  // 1. Pretraining
  yield { phase: 'pretrain', done: 0, total: 1, progress: at('pretrain', 0) };
  const starts = pretrainStarts(cards, defaults, bounds, current[20], cfg.priorN);
  yield { phase: 'pretrain', done: 1, total: 1, progress: at('pretrain', 1) };

  // 2. Adam on w4 to w20, from the current weights (w0 to w3 stay at their pretrained values)
  let train = cards.filter(c => { for (let i = 1; i < c.ratings.length; i++) if (c.scored[i] && c.deltas[i] > 0) return true; return false; });
  if (cfg.recency) train = withRecency(train, cfg.recencyFloor ?? RECENCY_FLOOR);                // newer reviews count more in the loss (the pick of weights, not the keep rule)
  const weight = train.map(c => { let n = 0; for (let i = 1; i < c.ratings.length; i++) if (c.scored[i] && c.deltas[i] > 0) n++; return n; });
  const total = weight.reduce((a, b) => a + b, 0);
  const batches = Math.max(1, Math.ceil(total / cfg.batchSize));
  const steps = cfg.epochs * batches;
  const w = current.map((v, i) => clamp(i < FIRST_TRAINED ? starts[i] : v, bounds[i][0], bounds[i][1]));
  const m = new Float64Array(P), v = new Float64Array(P);
  const rng = mulberry32(cfg.seed);
  const order = train.map((_, i) => i);
  let step = 0;
  for (let epoch = 0; epoch < cfg.epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let p = 0, seen = 0;
    for (let b = 0; b < batches; b++) {
      const batch = [];
      const upto = total * (b + 1) / batches;
      while (p < order.length && (seen < upto || b === batches - 1)) { batch.push(train[order[p]]); seen += weight[order[p]]; p++; }
      step++;
      if (batch.length) {
        const { wsum, grad } = lossAndGrad(batch, w);
        const lr = cfg.lr * (0.1 + 0.45 * (1 + Math.cos(Math.PI * (step - 1) / steps)));
        for (let k = 0; k < P; k++) {
          const i = k + FIRST_TRAINED;
          const range = Math.max(bounds[i][1] - bounds[i][0], 1e-9);          // (a pinned weight has no range)
          // (recency-weighted) mean log loss + gamma/N · Σ ((w − default) / range)²: a pull towards the defaults (gamma is the strength)
          const gk = grad[k] / wsum + cfg.gamma / total * 2 * (w[i] - defaults[i]) / (range * range);
          m[k] = 0.9 * m[k] + 0.1 * gk;
          v[k] = 0.999 * v[k] + 0.001 * gk * gk;
          const mh = m[k] / (1 - Math.pow(0.9, step)), vh = v[k] / (1 - Math.pow(0.999, step));
          w[i] = clamp(w[i] - lr * mh / (Math.sqrt(vh) + 1e-8), bounds[i][0], bounds[i][1]);
        }
      }
      yield { phase: 'train', done: step, total: steps, progress: at('train', step / steps) };
    }
  }

  // 3. Refine w0 to w3. Pretraining only sees each card's first long-term review, and it was done with the curve we started
  // from, so it is biased when the true curve is different. Now that w20 and the rest are fitted, put each start stability
  // where the whole history of the cards that began with that rating is predicted best (a golden-section search on log S,
  // with the same pull towards the defaults as above), then put them in order again.
  const byFirst = [[], [], [], []];
  for (const c of train) byFirst[c.ratings[0] - 1].push(c);
  const gr = (Math.sqrt(5) - 1) / 2;
  let totalW = 0;
  for (const c of train) for (let i = 1; i < c.ratings.length; i++) if (c.scored[i] && c.deltas[i] > 0) totalW += c.wt ? c.wt[i] : 1;
  for (let g = 0; g < 4; g++) {
    yield { phase: 'refine', done: g, total: 4, progress: at('refine', g / 4) };
    const list = byFirst[g];
    if (!list.length) continue;
    const range = Math.max(bounds[g][1] - bounds[g][0], 1e-9);
    const cost = x => {
      const t = w.slice();
      t[g] = Math.exp(x);
      const e = evaluateMany([{ cards: list, w: t }], { round: false, weighted: cfg.recency });
      return e.logLoss * e.wn / totalW + cfg.gamma / total * ((t[g] - defaults[g]) / range) ** 2;
    };
    let lo = Math.log(bounds[g][0]), hi = Math.log(bounds[g][1]);
    let a = hi - gr * (hi - lo), b = lo + gr * (hi - lo), fa = cost(a), fb = cost(b);
    for (let it = 0; it < 40; it++) {
      yield { phase: 'refine', done: g, total: 4, progress: at('refine', (g + it / 40) / 4) };       // each step scores a whole history: yield often
      if (fa < fb) { hi = b; b = a; fb = fa; a = hi - gr * (hi - lo); fa = cost(a); }
      else { lo = a; a = b; fa = fb; b = lo + gr * (hi - lo); fb = cost(b); }
    }
    w[g] = Math.exp((lo + hi) / 2);
  }
  const ordered = poolAscending(w.slice(0, 4).map(Math.log));          // w0 <= w1 <= w2 <= w3 again, as in pretraining
  for (let g = 0; g < 4; g++) w[g] = clamp(Math.exp(ordered[g]), bounds[g][0], bounds[g][1]);
  const fitted = w.map((x, i) => clamp(round6(x), bounds[i][0], bounds[i][1]));
  yield { phase: 'refine', done: 4, total: 4, progress: at('refine', 1) };

  // 4. Check: do the new weights predict the same history better than the ones in use?
  // (config.skipCheck: the caller judges them itself, on reviews this fit never saw, so this in-sample check is left out.)
  if (cfg.skipCheck) return { status: 'trained', w: fitted, fitted, current, reviews, cards: usable, longTerm };
  yield { phase: 'check', done: 0, total: 2, progress: at('check', 0) };
  const before = evaluate(cards, current);
  yield { phase: 'check', done: 1, total: 2, progress: at('check', 0.5) };
  const after = evaluate(cards, fitted);
  const better = isBetter(before, after);
  yield { phase: 'check', done: 2, total: 2, progress: 1 };
  return { status: better ? 'better' : 'same', w: better ? fitted : current, fitted, current, before, after, reviews, cards: usable, longTerm };
}

// Run a generator to the end (Node, tests). `onProgress` gets every yielded step.
export function runFit(input, onProgress) {
  const it = fit(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (onProgress) onProgress(r.value);
  }
}

// Split the histories by time: `head` = every answer up to the day by which `trainShare` of the real reviews have happened
// (cards with nothing in that part are left out), `test` = ALL the cards in their original order, with only the later reviews
// scored (the memory state is still replayed from the whole history, so a card keeps its place in `steps` arrays).
// Needs `day0` on each history. Only reviews that get a prediction (scored, not a card's first answer, on a later day than the one
// before) are counted to find the cutoff, so the held-out part really holds about 20% of the predictions. Returns { head, test, cutoff }.
export function splitHistories(cards, trainShare = 0.8) {
  const days = [];
  for (const c of cards) {
    let day = c.day0 || 0;
    for (let i = 0; i < c.ratings.length; i++) { day += c.deltas[i]; if (c.scored[i] && i > 0 && c.deltas[i] > 0) days.push(day); }     // only reviews that get a prediction
  }
  days.sort((a, b) => a - b);
  const cutoff = days.length ? days[Math.min(days.length - 1, Math.floor(days.length * trainShare))] : 0;
  const head = [], test = [];
  for (const c of cards) {
    let day = c.day0 || 0, keep = 0;
    const absolute = new Int32Array(c.ratings.length);
    for (let i = 0; i < c.ratings.length; i++) { day += c.deltas[i]; absolute[i] = day; if (day <= cutoff) keep = i + 1; }
    if (keep) head.push({ ...c, deltas: c.deltas.slice(0, keep), ratings: c.ratings.slice(0, keep), scored: c.scored.slice(0, keep) });
    test.push({ ...c, scored: c.scored.map((x, i) => (absolute[i] > cutoff ? x : 0)) });
  }
  return { head, test, cutoff };
}

// An honest out-of-sample check, for the simulator: fit on the first `trainShare` of the days, then score current and fitted
// weights on the answers after that. A generator like fit(). Result: { status: 'not-enough', … } or { cutoffDay, fitted, before, after, trainResult }.
export function* evaluateSplit(input, trainShare = 0.8) {
  const { head, test, cutoff } = splitHistories(input.cards, trainShare);
  const trained = yield* fit({ ...input, cards: head });
  if (trained.status === 'not-enough') return trained;
  const current = (input.current || input.defaults);
  return { status: 'split', cutoffDay: cutoff, fitted: trained.fitted, before: evaluate(test, current), after: evaluate(test, trained.fitted), trainResult: trained };
}

// ---------- the keep rule: judged on reviews the fit never saw ----------
// ts-fsrs's clipParameters(w, numRelearningSteps, true), written out (tests/fsrs-parity.test.js checks they agree): every weight
// inside its bounds, and with more than one relearning step w17 and w18 get a lower ceiling worked out from w11, w13 and w14.
export function clipWeights(w, numRelearningSteps, bounds) {
  const clip = bounds.map(b => b.slice());
  if (Math.max(0, numRelearningSteps) > 1) {
    const w11 = clamp(w[11] || 0, clip[11][0], clip[11][1]);
    const w13 = clamp(w[13] || 0, clip[13][0], clip[13][1]);
    const w14 = clamp(w[14] || 0, clip[14][0], clip[14][1]);
    const value = -(Math.log(w11) + Math.log(Math.pow(2, w13) - 1) + w14 * 0.3) / numRelearningSteps;
    const ceiling = clamp(r8(Math.sqrt(Math.max(value, 0))), 0.01, clip[17][1]);
    clip[17][1] = ceiling; clip[18][1] = ceiling;
  }
  return clip.map(([lo, hi], i) => clamp(w[i] || 0, lo, hi));
}

export const HOLDOUT_SHARE = 0.8;       // fit on the first 80% of the days, judge on the last 20%
export const HOLDOUT_MIN = 50;          // fewer than this many held-out predictions: no verdict, keep the current weights

// The whole decision, as the Optimize sheet makes it (a generator like fit(): runs in the worker, in Node, or in slices):
//   1. fit on the first 80% of the days
//   2. judge those weights against the current ones on the last 20% (judge(): log loss lower AND RMSE no higher, each deck scored
//      with its weights clipped for its relearning steps)
//   3. only if they win, fit again on everything and use that
// input = fit()'s input plus `steps`: the relearning-step count of each card's deck, in the order of input.cards (default 1).
// Result: { status: 'not-enough', reviews, needed }
//       | { status: 'same', reason, before, after, reviews, cards, longTerm }          the current weights stay
//       | { status: 'better', w, fitted, headFitted, current, before, after, tested, reviews, cards, longTerm }
//   before / after = log loss and RMSE of the current and the new weights on the held-out reviews (what the sheet shows);
//   headFitted = the weights from step 1 (the sheet scores them again if the saved setting changed while it worked).
export function* fitChecked(input) {
  const cfg = { ...FIT_DEFAULTS, ...(input.config || {}) };
  const { cards, bounds } = input;
  const current = (input.current || input.defaults).slice();
  const steps = input.steps || cards.map(() => 1);
  let reviews = 0, longTerm = 0, usable = 0;
  for (const c of cards) {
    let any = false;
    for (let i = 0; i < c.scored.length; i++) if (c.scored[i]) { reviews++; any = true; if (i > 0 && c.deltas[i] > 0) longTerm++; }
    if (any) usable++;
  }
  if (reviews < cfg.minReviews || longTerm === 0) return { status: 'not-enough', reviews, needed: cfg.minReviews };
  const totals = { reviews, cards: usable, longTerm };
  // Phases of the inner fits are all "finding"; the verdict is "check". Progress: 0 to 0.45 first fit, 0.45 to 0.5 judging, 0.5 to 1 second fit.
  const inner = function* (cardsIn, from, to, config) {
    const it = fit({ ...input, cards: cardsIn, current, config });
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
      yield { phase: 'finding', done: r.value.done, total: r.value.total, progress: from + (to - from) * r.value.progress };
    }
  };
  const { head, test } = splitHistories(cards, HOLDOUT_SHARE);
  const first = yield* inner(head, 0, 0.45, { ...input.config, minReviews: 1, skipCheck: true });
  yield { phase: 'check', done: 0, total: 1, progress: 0.47 };
  if (first.status === 'not-enough') return { status: 'same', reason: 'little', ...totals };
  const clip = (w, n) => clipWeights(w, n, bounds);
  const verdict = judge(test, steps, current, first.fitted, clip);
  yield { phase: 'check', done: 1, total: 1, progress: 0.5 };
  if (verdict.before.n < HOLDOUT_MIN) return { status: 'same', reason: 'little', before: verdict.before, after: verdict.after, ...totals };
  if (!verdict.better) return { status: 'same', reason: 'no-better', before: verdict.before, after: verdict.after, ...totals };
  const second = yield* inner(cards, 0.5, 1, { ...input.config, skipCheck: true });
  return { status: 'better', w: second.fitted, fitted: second.fitted, headFitted: first.fitted, current, before: verdict.before, after: verdict.after, tested: verdict.before.n, ...totals };
}
