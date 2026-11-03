// RWKV lab: turning the model's output numbers into probabilities and intervals. Pure maths.
import { EPS } from './rwkv-spec.js';

const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function softmax(v) {
  let m = -Infinity;
  for (const x of v) if (x > m) m = x;
  const e = Array.from(v, x => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / s);
}

// Chance of remembering after tSec seconds, from the three curve heads { w, s, d } (3 numbers each).
export function pCurve(heads, tSec) {
  const t = Math.max(tSec, EPS.minElapsedSeconds);
  const mix = softmax(heads.w);
  let R = 0;
  for (let i = 0; i < 3; i++) {
    const S = Math.exp(clip(heads.s[i], -EPS.powerClamp, EPS.powerClamp));
    const d = Math.exp(clip(heads.d[i], -EPS.powerClamp, EPS.powerClamp));
    R += mix[i] * Math.exp(-d * Math.log(1 + t / (EPS.sEps + S)));
  }
  return EPS.probClamp + (1 - 2 * EPS.probClamp) * R;
}

// [again, hard, good, easy] chances for a card asked now
export const pRating = heads => softmax(heads.p);
export const pImm = heads => clip(1 - pRating(heads)[0], EPS.probClamp, 1 - EPS.probClamp);

const MIN_SECONDS = 60;

// The first moment (in seconds, between a minute and maxSec) when the curve drops to `target`; maxSec if it never does.
export function intervalSeconds(heads, target, maxSec) {
  if (!(maxSec > MIN_SECONDS)) return maxSec;
  if (pCurve(heads, maxSec) > target) return maxSec;
  if (pCurve(heads, MIN_SECONDS) <= target) return MIN_SECONDS;
  let lo = Math.log(MIN_SECONDS), hi = Math.log(maxSec);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (pCurve(heads, Math.exp(mid)) > target) lo = mid; else hi = mid;
  }
  return Math.exp(hi);
}

// curves: { 1..4: heads } for what-if answers Again..Easy. -> { 2, 3, 4: whole days } for Hard, Good, Easy, never decreasing.
export function daysForButtons(curves, target, maxDays) {
  const out = {};
  for (const r of [2, 3, 4]) {
    const sec = intervalSeconds(curves[r], target, maxDays * 86400);
    out[r] = clip(Math.round(sec / 86400), 1, maxDays);
  }
  out[3] = Math.max(out[3], out[2]);
  out[4] = Math.max(out[4], out[3]);
  return out;
}

// Are all the model's output numbers real numbers? A broken weights file or a runaway state can make them NaN or infinite;
// nothing may be computed from such heads (the caller then falls back to FSRS).
export const headsFinite = h => ['w', 's', 'd', 'p'].every(k => !h[k] || Array.prototype.every.call(h[k], Number.isFinite));
