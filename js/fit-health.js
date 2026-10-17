// "Check how well it fits you": the numbers and the plain-words verdicts behind the health check sheet (js/health-sheet.js).
// Pure functions (no database, no page); healthFit() is a generator so it can run in the worker like the optimizer.
// Tested by tests/fit-health.test.js.
//
// Three checks:
//   1. Fit quality  - how well your CURRENT weights predicted your recent reviews (log loss and RMSE, the same numbers the
//                     Optimize sheet shows), judged Good / OK / Poor.
//   2. Retention    - how often you really remembered cards in the last 30 days, young (gap under 21 days) and mature, against
//                     your target (retentionByAge in stats-calc.js does the counting).
//   3. Hard button  - whether Hard is pressed far more than usual.
// Each check ends in one line of advice.

import { evaluateMany, clipWeights } from './fsrs-fit.js';

// ---------- 1. fit quality ----------
// Where the thresholds come from (docs/design/fsrs-research.md, the benchmark table of about 10,000 Anki users):
//
//   RMSE (bins) is how far the predicted chances sit from what really happened, in bins of similar predictions. It does not
//   depend on how often you remember, so it is the main yardstick.
//     - tuned FSRS-6 / FSRS-7 average 0.059 to 0.065   - FSRS-7 with default weights 0.091   - FSRS-7 per-deck 0.072
//     Good: 0.07 or less    (as good as a tuned model's average, with a little room for one person's noise)
//     OK:   0.10 or less    (about what untuned default weights score; usable, not tuned to you)
//     Poor: above 0.10      (the predictions are off by more than ten points on average)
//
//   Log loss rewards confident, correct predictions, but it depends on how often you remember: someone who remembers 80% of
//   the time cannot go below 0.50, someone at 95% cannot go below 0.20. So it is judged against the log loss of just guessing your
//   own average every time ("excess" = log loss minus that). The benchmark's tuned FSRS-6 (0.346) sits at about the guess-your-average
//   level of a typical user (who remembers about 89%: 0.347); untuned FSRS-7 (0.362) and DASH (0.368) are 0.015 to 0.02 above it;
//   the crude models (ACT-R 0.403, HLR 0.469) are 0.06 to 0.12 above.
//     Good: excess 0.01 or less      OK: 0.04 or less      Poor: more
//
//   The verdict is the worse of the two. With fewer than HEALTH_MIN_N predictions there is no verdict. Under HEALTH_SOFT_N the
//   binned RMSE is noisy, so the sheet says the result is rough.
export const RMSE_GOOD = 0.07, RMSE_OK = 0.10;
export const EXCESS_GOOD = 0.01, EXCESS_OK = 0.04;
export const HEALTH_MIN_N = 100;       // fewer predictions than this: no verdict
export const HEALTH_SOFT_N = 300;      // fewer than this: the verdict is rough
export const RECENT_DAYS = 90;         // "recent reviews" = the last 90 days, widened to the latest HEALTH_SOFT_N predictions if that is fewer

const RANK = { good: 0, ok: 1, poor: 2 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// Log loss of guessing the share p every time.
export const baseLoss = p => (p <= 0 || p >= 1 ? 0 : -(p * Math.log(p) + (1 - p) * Math.log(1 - p)));

// { logLoss, rmse, n, recall (share remembered, 0 to 1) } → { grade: 'good' | 'ok' | 'poor' | 'unknown', rmseGrade, lossGrade, excess, rough }
export function classifyFit({ logLoss, rmse, n, recall }) {
  if (!(n >= HEALTH_MIN_N) || !Number.isFinite(logLoss) || !Number.isFinite(rmse)) return { grade: 'unknown', rmseGrade: null, lossGrade: null, excess: null, rough: false };
  const E = 1e-9;      // (so a value right on a limit is on the better side)
  const rmseGrade = rmse <= RMSE_GOOD + E ? 'good' : rmse <= RMSE_OK + E ? 'ok' : 'poor';
  const excess = logLoss - baseLoss(recall);
  const lossGrade = excess <= EXCESS_GOOD + E ? 'good' : excess <= EXCESS_OK + E ? 'ok' : 'poor';
  return { grade: worse(rmseGrade, lossGrade), rmseGrade, lossGrade, excess, rough: n < HEALTH_SOFT_N };
}

// Score the current weights on the recent reviews. A generator (like fit()): yields { phase, progress }, returns the result.
//   input.cards   histories (fsrs-data.js buildHistories().cards)       input.steps  relearning-step count of each card's deck
//   input.w       the weights in use now                               input.bounds ts-fsrs CLAMP_PARAMETERS (to clip them for each deck's steps)
//   input.today   today's UTC day number (days since 1970)
// Result: { status: 'ok', logLoss, rmse, n, recall, sinceDay } | { status: 'not-enough', n }
export function* healthFit(input) {
  const { cards, bounds, w } = input;
  const steps = input.steps || cards.map(() => 1);
  const today = input.today ?? Math.floor(Date.now() / 86400000);
  yield { phase: 'health', progress: 0 };
  // every prediction's day, to find where "recent" starts
  const days = [];
  for (const c of cards) {
    let day = c.day0 || 0;
    for (let i = 0; i < c.ratings.length; i++) { day += c.deltas[i]; if (c.scored[i] && i > 0 && c.deltas[i] > 0) days.push(day); }
  }
  days.sort((a, b) => a - b);
  if (days.length < HEALTH_MIN_N) return { status: 'not-enough', n: days.length };
  const sinceDay = Math.min(today - RECENT_DAYS + 1, days[Math.max(0, days.length - HEALTH_SOFT_N)]);
  yield { phase: 'health', progress: 0.3 };
  const groups = new Map();
  cards.forEach((c, i) => {
    let day = c.day0 || 0;
    const scored = c.scored.map((x, k) => { day += c.deltas[k]; return day >= sinceDay ? x : 0; });
    const n = steps[i] ?? 1;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push({ ...c, scored });
  });
  const parts = [...groups].map(([n, list]) => ({ cards: list, w: clipWeights(w, n, bounds) }));
  const e = evaluateMany(parts);
  yield { phase: 'health', progress: 1 };
  if (e.n < HEALTH_MIN_N) return { status: 'not-enough', n: e.n };
  return { status: 'ok', logLoss: e.logLoss, rmse: e.rmse, n: e.n, recall: e.recalled / e.n, sinceDay };
}

// ---------- 3. the Hard button ----------
// Of the reviews where you remembered a card that had already graduated, what share did you answer Hard?
// FSRS's own simulator starts from about 22% (DEFAULT_REVIEW_PROBS in retention-sim.js); about double that is flagged.
// Only answers you pressed yourself in Review count (game answers are graded by the app).
export const HARD_FLAG = 0.4, HARD_MIN_N = 50, HARD_DAYS = 90;
export function hardUse(rows, now = Date.now(), days = HARD_DAYS) {
  const since = now - days * 86400000;
  let hard = 0, passes = 0;
  for (const l of rows) {
    if (l.source !== 'review' || l.state !== 2 || !(l.rating >= 2 && l.rating <= 4) || l.timestamp < since) continue;
    passes++;
    if (l.rating === 2) hard++;
  }
  const share = passes ? hard / passes : null;
  return { hard, passes, share, overuse: passes >= HARD_MIN_N && share >= HARD_FLAG };
}

// ---------- 2. retention against the target ----------
// A bucket from retentionByAge: { n, ok } → { n, rate }.  `target` is the (mean) target of those reviews.
// "Under" or "over" needs the gap to be bigger than the noise: at least 3 points and at least 1.64 standard errors
// (a one-sided 95% test), so a handful of reviews cannot cry wolf.
export const RET_MIN_N = 30, RET_MARGIN = 0.03;
export function retentionVerdict(bucket, target) {
  if (!bucket || bucket.n < RET_MIN_N || !Number.isFinite(target)) return { verdict: 'few', gap: null };
  const rate = bucket.ok / bucket.n;
  const gap = rate - target;
  const margin = Math.max(RET_MARGIN, 1.64 * Math.sqrt(Math.max(rate * (1 - rate), 0.01) / bucket.n));
  return { verdict: gap < -margin ? 'under' : gap > margin ? 'over' : 'on', gap, rate };
}

// ---------- the plain words ----------
const pts = x => Math.round(Math.abs(x) * 100);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function fitAdvice(fit, { usingOwn, canOptimize }) {
  switch (fit.grade) {
    case 'good': return 'Your settings predict your reviews well. Nothing to change.';
    case 'ok': return usingOwn
      ? 'This is fine. Run Optimize again in a few weeks as you add reviews.'
      : canOptimize ? 'The standard settings work for you, and Optimize may fit you better.' : 'The standard settings work for you. Optimize unlocks after 400 reviews.';
    case 'poor': return usingOwn
      ? 'Predictions are off even with your own settings. Run Optimize again; if your early history is messy, set “Ignore reviews before”.'
      : canOptimize ? 'The standard settings don’t suit your memory. Run Optimize to tune them to you.' : 'The standard settings are off for you. Optimize unlocks after 400 reviews.';
    default: return 'Keep reviewing; we need a few more recent reviews to say.';
  }
}
export const GRADE_WORDS = {
  good: 'Good',
  ok: 'OK',
  poor: 'Poor',
  unknown: 'Not enough yet'
};

// One line about retention: the verdict for all reviews plus a word on young/mature when they differ.
export function retentionAdvice(all, young, mature, target, { canOptimize = false } = {}) {
  const a = retentionVerdict(all, target);
  if (a.verdict === 'few') return 'Not enough reviews in the last 30 days to say. Keep going.';
  if (a.verdict === 'under') {
    const n = pts(a.gap);
    const parts = [`Retention is ${plural(n, 'point')} under your target: consider fewer new cards`];
    parts.push(canOptimize ? ' or running Optimize.' : ', or a higher target to bring cards back sooner.');
    return parts.join('');
  }
  if (a.verdict === 'over') {
    return `Retention is ${plural(pts(a.gap), 'point')} above your target, so you review more than you need to. A lower target (try “Help me choose”) would save reviews.`;
  }
  const y = retentionVerdict(young, target), m = retentionVerdict(mature, target);
  if (m.verdict === 'under') return 'On target overall, but mature cards are slipping. Review them as they come due and don’t skip days.';
  if (y.verdict === 'under') return 'On target overall, but newer cards are slipping. Try fewer new cards per day.';
  return 'You’re on target. Nothing to change.';
}

export function hardAdvice(h) {
  if (h.passes < HARD_MIN_N) return 'Not enough reviews to tell yet.';
  if (!h.overuse) return `Hard is ${Math.round(h.share * 100)}% of your remembered reviews, which is normal. Nothing to change.`;
  return `You press Hard on ${Math.round(h.share * 100)}% of remembered reviews, about twice the usual. Hard shortens the next gap, so cards come back sooner than they need to. If you got it right without real struggle, press Good.`;
}
