// Own model: the forgetting curve and the interval solver. Pure maths, no DOM, no storage, no network.
// A head is { a, pi: [3], s: [3], beta: [3] }: the ceiling, the mix weights (sum 1), the stabilities in days and the shapes.
//   p(t) = a * sum_k pi_k * (1 + t / s_k) ^ (-beta_k)      (t in days)
// It always falls as t grows, so "the day the curve reaches the target" is well defined.
import { CURVE, K } from './own-spec.js';

const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const sigmoid = x => 1 / (1 + Math.exp(-x));
const softplus = x => (x > 20 ? x : Math.log1p(Math.exp(x)));

// The head network's 10 raw outputs -> a head. The training code mirrors these steps on its tape.
export function headFromRaw(raw) {
  const m = Math.max(raw[1], raw[2], raw[3]);
  const e = [Math.exp(raw[1] - m), Math.exp(raw[2] - m), Math.exp(raw[3] - m)];
  const sum = e[0] + e[1] + e[2];
  const head = { a: CURVE.aMin + CURVE.aSpan * sigmoid(raw[0]), pi: [], s: [], beta: [] };
  for (let k = 0; k < K; k++) {
    head.pi.push(e[k] / sum);
    head.s.push(Math.exp(clip(raw[4 + k], CURVE.rawLogStabilityMin, CURVE.rawLogStabilityMax)));
    head.beta.push(CURVE.betaMin + softplus(raw[7 + k]));
  }
  return head;
}

// Chance of remembering after tDays days (clamped away from 0 and 1).
export function pAt(head, tDays) {
  const t = tDays > 0 ? tDays : 0;
  let r = 0;
  for (let k = 0; k < K; k++) r += head.pi[k] * Math.pow(1 + t / head.s[k], -head.beta[k]);
  return clip(head.a * r, CURVE.pMin, CURVE.pMax);
}

// The first day (between 1 and maxDays) when the curve is at or below `target`; maxDays if it never gets there, 1 if the curve
// starts out at or below the target (this includes a ceiling under the target). Bisection on log(t), 50 rounds.
export function intervalDays(head, target, maxDays) {
  if (!(maxDays > 1)) return maxDays;
  if (head.a < target || pAt(head, 1) <= target) return 1;
  if (pAt(head, maxDays) > target) return maxDays;
  let lo = 0, hi = Math.log(maxDays);
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (pAt(head, Math.exp(mid)) > target) lo = mid; else hi = mid;
  }
  return Math.exp(hi);
}

// heads: { 2, 3, 4 } for what-if answers Hard, Good, Easy. -> { 2, 3, 4 } whole days, at least 1, at most maxDays, never decreasing.
export function daysForButtons(heads, target, maxDays) {
  const out = {};
  for (const r of [2, 3, 4]) out[r] = clip(Math.round(intervalDays(heads[r], target, maxDays)), 1, maxDays);
  out[3] = Math.max(out[3], out[2]);
  out[4] = Math.max(out[4], out[3]);
  return out;
}

// Are all of a head's numbers real numbers? A broken parameter set or a runaway state can make them NaN or infinite;
// nothing may be scheduled from such a head (the caller falls back to FSRS).
export const headFinite = h => !!h && Number.isFinite(h.a) && ['pi', 's', 'beta'].every(k => Array.isArray(h[k]) && h[k].length === K && h[k].every(Number.isFinite));
