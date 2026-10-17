// The FSRS-7 memory model: a pure port of the algorithm in ts-fsrs 6.0.0-beta.14 (models/fsrs-7), which itself is ported
// from fsrs-rs (model_v7.rs). No imports, no database, no library: tests/fsrs7-parity.test.js checks every function here
// against the real library (a devDependency), and tests/fsrs7.test.js checks the maths on its own.
// Design and reasons: docs/design/fsrs7-plan.md.
//
// FSRS-7 keeps THREE numbers per card (FSRS-6 keeps two):
//   stability      S      slow memory trace (days)
//   stabilityFast  Sf     fast memory trace (days): fades within hours or days, and is what makes same-day repeats work
//   difficulty     D      1 to 10, as before
// The chance of remembering after t days (a fraction is fine: 0.5 = twelve hours) mixes the two traces:
//   R(t) = (a·fast(t) + b·slow(t)) / (a + b), squeezed slightly into (0, 1)
//   slow(t) = (1 + k·t)^-decay   decay = w24; k scales with 1/S and with difficulty, so slow = w26 when t = S at difficulty 5
//   fast(t) = (1 + k'·t)^-decay' decay' = w23·Sf^(w33-0.3), k' set so fast = w25 when t = Sf
//   a = w27·Sf^-w29,  b = w28·S^w30·e^((D-5)(w31-0.5))   (how much each trace counts; the slow one counts more as the card ages)
// Weights: 34 numbers. w0-w3 start S (Again, Hard, Good, Easy), w4/w5 start D, w6 D change, w7-w14 slow update, w15-w22 fast update,
// w23-w33 the curve. Intervals are fractional days: the scheduler (fsrs7-sched.js) decides what to do with that.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const roundTo = (v, n) => { const f = 10 ** n; return Math.round(v * f) / f; };

export const W7_COUNT = 34;
export const W7_DEFAULT = Object.freeze([
  0.1104, 2.2395, 3.9221, 11.7841, 6.1686, 0.6457, 3.6807, 1.9795, 0, 1.3826, 0.7024, 0.5999, 0.8146, 0.6398, 1, 1.3207, 0.6707,
  3.8668, 0.4416, 0.0934, 1.8631, 0.6162, 1.0869, 0.1567, 0.0801, 0.2421, 0.9464, 0.1433, 0.7145, 0, 0.5667, 0.3734, 0.5333, 0.3048
]);
export const BOUNDS7 = Object.freeze({ sMin: 1e-4, sMax: 36500, sfMin: 1e-4, sfMax: 36500, dMin: 1, dMax: 10 });
// Allowed range of each weight (the library's FSRS7ParameterBounds), in weight order. w1-w3 must also be at least the weight before,
// and w26 at least w25 (clipWeights7 enforces that).
export const W7_BOUNDS = Object.freeze([
  [1e-4, 50], [1e-4, 100], [1e-4, 100], [1e-4, 100], [1, 10], [0.001, 4], [0.1, 4], [0, 4], [0, 1.2], [0.3, 3], [0.01, 1.5], [0.1, 1],
  [0, 3.5], [0, 1], [1, 7], [0, 4], [0, 2], [0.5, 6], [0.001, 1.5], [0.001, 1], [0, 5], [0, 1], [1, 7], [0.01, 0.25], [0.01, 0.95],
  [0.2, 0.85], [0.5, 0.99], [0.01, 1], [0.1, 1], [0, 0.9], [0.1, 1.1], [0, 1], [0, 0.6], [0, 0.6]
]);

// Weights inside their allowed ranges (non-finite numbers become the lowest allowed value, as in the library).
export function clipWeights7(w) {
  const out = Array.from(w);
  if (out.length < W7_COUNT) return out;
  for (let i = 0; i < W7_COUNT; i++) {
    const [min, max] = W7_BOUNDS[i];
    const low = i > 0 && i < 4 ? Math.max(min, out[i - 1]) : i === 26 ? Math.max(min, out[25]) : min;
    out[i] = clamp(Number.isFinite(out[i]) ? out[i] : low, low, max);
  }
  return out;
}

// A list that can be used as the 34 weights.
export const validWeights7 = w => Array.isArray(w) && w.length === W7_COUNT && w.every(Number.isFinite);

// ---------- the forgetting curve ----------
function prepareFast(w, sf) {
  const decay = -clamp(w[23] * Math.pow(sf, w[33] - 0.3), 0.01, 0.95);
  return { decay, scale: (Math.exp(Math.min(Math.log(w[25]) / decay, 60)) - 1) / sf };
}
function fastPart(t, p) {
  const base = 1 + p.scale * t;
  return { recall: Math.pow(base, p.decay), derivative: p.decay * Math.pow(base, p.decay - 1) * p.scale };
}
// Everything about the curve that does not depend on t, worked out once per card state.
function prepareCurve(w, st) {
  const s = clamp(st.stability, BOUNDS7.sMin, BOUNDS7.sMax);
  const sf = clamp(st.stabilityFast, BOUNDS7.sfMin, BOUNDS7.sfMax);
  const d = clamp(st.difficulty, BOUNDS7.dMin, BOUNDS7.dMax);
  const fast = prepareFast(w, sf);
  const decay = -clamp(w[24], 0.01, 0.95);
  const scale = (Math.pow(w[26], 1 / decay) - 1) * Math.exp((d - 5) * (w[32] - 0.3)) / s;
  const weight1 = w[27] * Math.pow(sf, -w[29]);
  const weight2 = w[28] * Math.pow(s, w[30]) * Math.exp((d - 5) * (w[31] - 0.5));
  return { fast, decay, scale, weight1, weight2, total: weight1 + weight2 };
}
function evalCurve(t, p) {
  const days = Math.max(t, 0);
  const f = fastPart(days, p.fast);
  const base = 1 + p.scale * days;
  const slow = Math.pow(base, p.decay);
  const slowDerivative = p.decay * Math.pow(base, p.decay - 1) * p.scale;
  return {
    r: (p.weight1 * f.recall + p.weight2 * slow) / p.total * 0.99998 + 1e-5,
    dr: (p.weight1 * f.derivative + p.weight2 * slowDerivative) / p.total * 0.99998,
    fast: f.recall, slow, weight1: p.weight1, weight2: p.weight2
  };
}
// The curve and its slope at t days, with the two traces and their mixing weights: { r, dr, fast, slow, weight1, weight2 }.
export const curve7 = (w, st, t) => evalCurve(t, prepareCurve(w, st));
// The chance of remembering after t days (a fraction of a day is fine).
export const forgettingCurve7 = (w, st, t) => curve7(w, st, t).r;

// Days until the chance of remembering falls to `retention` (fractional; 0 when retention is 0.9999 or more). Newton's method on log t,
// then bisection if that has not settled (the library's way, so the numbers match).
export function nextInterval7(w, st, retention) {
  if (!Number.isFinite(retention) || retention <= 0 || retention >= 1) throw new RangeError('Desired retention must be between 0 and 1');
  const target = clamp(retention, 1e-4, 0.9999);
  if (target >= 0.9999) return 0;
  const { sMax } = BOUNDS7;
  const s = clamp(st.stability, BOUNDS7.sMin, sMax), sf = clamp(st.stabilityFast, BOUNDS7.sfMin, BOUNDS7.sfMax);
  const biggest = Math.max(s, sf);
  const p = prepareCurve(w, st);
  const MIN_T = 1 / 86400, LOG_MIN_T = Math.log(MIN_T), LOG_S_MAX = Math.log(sMax);
  let logT = Math.log(biggest);
  for (let i = 0; i < 7; i++) {
    logT = clamp(logT, LOG_MIN_T, LOG_S_MAX);
    const t = clamp(Math.exp(logT), MIN_T, sMax);
    const { r, dr } = evalCurve(t, p);
    logT -= clamp((r - target) / Math.min(dr * t, -1e-12), -4, 4);
    if (!Number.isFinite(logT)) break;
  }
  const interval = clamp(Math.exp(logT), 0, sMax);
  if (Math.abs(evalCurve(interval, p).r - target) <= 0.001) return interval;
  let low = 0, high = Math.min(Math.max(biggest, 1), sMax);
  while (evalCurve(high, p).r > target && high < sMax) high = Math.min(high * 2, sMax);
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2;
    if (evalCurve(mid, p).r > target) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

// ---------- updating the memory ----------
const initD = (w, g) => w[4] - Math.exp(w[5] * (g - 1)) + 1;

// The memory after the first answer to a new card (g = 1 Again, 2 Hard, 3 Good, 4 Easy).
export function initState7(w, g) {
  const s = clamp(w[g - 1], BOUNDS7.sMin, BOUNDS7.sMax);
  return {
    stability: clamp(roundTo(s, 8), BOUNDS7.sMin, BOUNDS7.sMax),
    stabilityFast: clamp(roundTo(s * 0.8, 8), BOUNDS7.sfMin, BOUNDS7.sfMax),
    difficulty: clamp(roundTo(initD(w, g), 8), BOUNDS7.dMin, BOUNDS7.dMax)
  };
}

// New stability of one trace after an answer. `start` is the first weight of that trace's block (7 for the slow one, 15 for the fast one).
function nextStability(w, s, d, r, g, start) {
  const fail = w[start + 3] * (Math.pow(s + 1, w[start + 4]) - 1) * Math.exp((1 - r) * w[start + 5]);
  const capped = Math.min(s, fail);                       // after a lapse a trace never grows
  if (g === 1) return capped;
  const hard = g === 2 ? w[start + 6] : 1, easy = g === 4 ? w[start + 7] : 1;
  const grow = Math.exp(w[start] - 1.5) * (11 - d) * Math.pow(s, -w[start + 1]) * (Math.exp((1 - r) * w[start + 2]) - 1) * hard * easy + 1;
  return Math.max(capped, s * grow);
}

// The memory after answering g, t days (fractional) after the last answer. `st` is the memory before ({ stability, stabilityFast, difficulty }),
// or null for a new card. `r` (optional) is the chance of remembering when answered, if the caller already has it.
export function nextState7(w, st, t, g, r) {
  if (!st) return initState7(w, g);
  const s = clamp(st.stability, BOUNDS7.sMin, BOUNDS7.sMax);
  const sf = clamp(st.stabilityFast, BOUNDS7.sfMin, BOUNDS7.sfMax);
  const d = clamp(st.difficulty, BOUNDS7.dMin, BOUNDS7.dMax);
  const recall = r ?? forgettingCurve7(w, { stability: s, stabilityFast: sf, difficulty: d }, t);
  const stability = nextStability(w, s, d, recall, g, 7);
  let fast = nextStability(w, sf, d, fastPart(t, prepareFast(w, sf)).recall, g, 15);
  if (g === 1) fast = Math.min(fast, stability * 0.8);
  let deltaD = -w[6] * (g - 3);
  if (g === 1) deltaD *= recall + 0.1;
  const difficulty = 0.01 * initD(w, 4) + 0.99 * (d + (10 - d) * deltaD / 9);
  return {
    stability: clamp(roundTo(stability, 8), BOUNDS7.sMin, BOUNDS7.sMax),
    stabilityFast: clamp(roundTo(fast, 8), BOUNDS7.sfMin, BOUNDS7.sfMax),
    difficulty: clamp(roundTo(difficulty, 8), BOUNDS7.dMin, BOUNDS7.dMax)
  };
}

// The memory after a whole history: steps = [{ t, g }] oldest first, t = days since the answer before (ignored for the first one).
// Returns null for an empty history.
export function replay7(w, steps) {
  let st = null;
  for (const { t, g } of steps) st = nextState7(w, st, t, g);
  return st;
}

// A usable { stability, stabilityFast, difficulty } (three positive finite numbers, difficulty in 1..10), or null.
export function cleanMemory7(m) {
  if (!m || typeof m !== 'object') return null;
  const { stability, stabilityFast, difficulty } = m;
  if (![stability, stabilityFast, difficulty].every(Number.isFinite) || stability <= 0 || stabilityFast <= 0 || difficulty < 1 || difficulty > 10) return null;
  return { stability, stabilityFast, difficulty };
}
