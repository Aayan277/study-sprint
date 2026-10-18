// Pure helpers for scoring FSRS models on real Anki review logs (see README.md). No file access and no ts-fsrs here, so the
// unit test (tests/realdata.test.js) can run them on tiny made-up users.

import { initState, nextState, forgettingCurve } from '../../js/fsrs-fit.js';
import { initState7, nextState7, forgettingCurve7 } from '../../js/fsrs7-model.js';

const EPS = 1e-6;          // same clamp and bins as evaluateMany in js/fsrs-fit.js, so the numbers can be compared one to one
const BINS = 20;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------- dataset columns -> histories ----------
// user = { card_id[], day_offset[], rating[], state[], elapsed_days[], elapsed_seconds[] } (rows in time order).
// The same rules as buildHistories (js/fsrs-data.js): ratings 1 to 4 only, a state-0 row after earlier rows is a reset (keep
// from the last one), the history must start at state 0 or the card is skipped. Plus tFrac: the gap to the previous kept row
// in fractional days (what the app's FSRS-7 sees), taken from elapsed_seconds. Rows dropped for a bad rating still count towards
// the gap. Where elapsed_seconds is unusable we fall back to the whole-day gap.
export function toHistories(user) {
  const byCard = new Map();
  const n = user.card_id.length;
  for (let r = 0; r < n; r++) {
    let list = byCard.get(user.card_id[r]);
    if (!list) byCard.set(user.card_id[r], list = []);
    list.push(r);
  }
  const cards = [];
  let skipped = 0;
  for (const [cardId, rows] of byCard) {
    let kept = [], acc = 0;                          // acc: seconds since the last kept row, over dropped rows (NaN = unknown)
    rows.forEach((r, k) => {
      const es = user.elapsed_seconds?.[r];
      const ok = Number.isInteger(user.rating[r]) && user.rating[r] >= 1 && user.rating[r] <= 4;
      if (!ok) { if (es >= 0) acc += es; else if (k > 0) acc = NaN; return; }
      kept.push({ r, sec: es >= 0 ? acc + es : NaN });
      acc = 0;
    });
    for (let i = kept.length - 1; i > 0; i--) if (user.state[kept[i].r] === 0) { kept = kept.slice(i); break; }
    if (!kept.length) continue;
    if (user.state[kept[0].r] !== 0) { skipped++; continue; }
    const m = kept.length;
    const deltas = new Int32Array(m), ratings = new Uint8Array(m), scored = new Uint8Array(m).fill(1), tFrac = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      ratings[i] = user.rating[kept[i].r];
      if (i === 0) continue;
      deltas[i] = Math.max(0, user.day_offset[kept[i].r] - user.day_offset[kept[i - 1].r]);
      tFrac[i] = Number.isFinite(kept[i].sec) ? kept[i].sec / 86400 : deltas[i];
    }
    cards.push({ cardId, day0: user.day_offset[kept[0].r], deltas, ratings, scored, tFrac });
  }
  return { cards, skipped };
}

// Keep only the reviews up to the day on which the nReviews-th review (over all cards) happened; cards left empty are dropped.
// (We only know days, so the whole of that last day stays: a few more than nReviews rows is normal.)
export function truncate(cards, nReviews) {
  const days = [];
  for (const c of cards) { let d = c.day0; for (let i = 0; i < c.ratings.length; i++) { d += c.deltas[i]; days.push(d); } }
  if (days.length <= nReviews) return cards;
  days.sort((a, b) => a - b);
  const last = days[nReviews - 1];
  const out = [];
  for (const c of cards) {
    let d = c.day0, keep = 0;
    for (let i = 0; i < c.ratings.length; i++) { d += c.deltas[i]; if (d <= last) keep = i + 1; }
    if (keep) out.push({ ...c, deltas: c.deltas.slice(0, keep), ratings: c.ratings.slice(0, keep), scored: c.scored.slice(0, keep), tFrac: c.tFrac?.slice(0, keep) });
  }
  return out;
}

// ---------- metrics ----------
// Collects (predicted p, outcome y) pairs. result(): log loss and RMSE (bins) exactly as evaluateMany computes them, plus AUC.
export class Metrics {
  constructor() { this.cnt = new Float64Array(BINS); this.pred = new Float64Array(BINS); this.obs = new Float64Array(BINS); this.loss = 0; this.n = 0; this.yes = 0; this.ps = []; this.ys = []; }
  add(p, y) {
    const q = clamp(p, EPS, 1 - EPS);
    this.loss -= y ? Math.log(q) : Math.log(1 - q);
    const b = Math.min(BINS - 1, Math.floor(q * BINS));
    this.cnt[b]++; this.pred[b] += q; this.obs[b] += y;
    this.n++; this.yes += y;
    this.ps.push(p); this.ys.push(y);
  }
  result() {
    const { n } = this;
    let sq = 0;
    for (let b = 0; b < BINS; b++) if (this.cnt[b]) sq += this.cnt[b] * (this.pred[b] / this.cnt[b] - this.obs[b] / this.cnt[b]) ** 2;
    return { logLoss: n ? this.loss / n : 0, rmse: n ? Math.sqrt(sq / n) : 0, auc: auc(this.ps, this.ys), n, recalled: this.yes };
  }
}

// Area under the ROC curve = the chance that a remembered review got a higher prediction than a forgotten one (ties count half).
// Rank-based (Mann-Whitney), tied predictions share their average rank. null when only one outcome occurs.
export function auc(ps, ys) {
  const n = ps.length;
  let pos = 0;
  for (let i = 0; i < n; i++) pos += ys[i] ? 1 : 0;
  const neg = n - pos;
  if (!pos || !neg) return null;
  const idx = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => ps[a] - ps[b]);
  let rankSum = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && ps[idx[j + 1]] === ps[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;                      // ranks are 1-based
    for (let k = i; k <= j; k++) if (ys[idx[k]]) rankSum += avg;
    i = j + 1;
  }
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg);
}

// ---------- walking the models ----------
// `long`: later-day reviews (deltas > 0), the ones the app predicts. `same`: repeats on the same Anki day (deltas = 0).
// Only reviews with scored = 1 and i > 0 count, so the test half of splitHistories (earlier rows replayed, not scored) works.

// FSRS-6 exactly as evaluate() in js/fsrs-fit.js walks it (whole-day gaps, round = true), so the memory state matches the app.
// `same` rows are predicted with the fractional gap tFrac. The app never makes such a prediction (FSRS-6 has no same-day
// forgetting curve), so that column is generous to FSRS-6: it gets a free guess it would not make in real use.
export function eval6(cards, w) {
  const long = new Metrics(), same = new Metrics();
  for (const c of cards) {
    let s = 0, d = 0;
    for (let i = 0; i < c.ratings.length; i++) {
      const g = c.ratings[i];
      if (i === 0) { ({ s, d } = initState(w, g, true)); continue; }
      const t = c.deltas[i];
      const r = forgettingCurve(w, t, s, true);
      if (c.scored[i]) {
        if (t > 0) long.add(r, g > 1 ? 1 : 0);
        else same.add(forgettingCurve(w, c.tFrac[i], s, true), g > 1 ? 1 : 0);
      }
      ({ s, d } = nextState(w, s, d, t, g, true, r));
    }
  }
  return { long: long.result(), same: same.result() };
}

// FSRS-7 as the app uses it (js/srs7.js replayRows): fractional gaps between the review times, predict before each update.
export function eval7(cards, w) {
  const long = new Metrics(), same = new Metrics();
  for (const c of cards) {
    let st = null;
    for (let i = 0; i < c.ratings.length; i++) {
      const g = c.ratings[i];
      if (i === 0) { st = initState7(w, g); continue; }
      const t = c.tFrac[i];
      const r = forgettingCurve7(w, st, t);
      if (c.scored[i]) (c.deltas[i] > 0 ? long : same).add(r, g > 1 ? 1 : 0);
      st = nextState7(w, st, t, g, r);
    }
  }
  return { long: long.result(), same: same.result() };
}
