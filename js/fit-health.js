// "Check how well it fits you": the numbers and the plain-words verdicts behind the health check sheet (js/health-sheet.js).
// Pure functions (no database, no page); healthFit() is a generator so it can run in the worker like the optimizer.
// Tested by tests/fit-health.test.js.
//
// Three checks:
//   1. Fit quality  - how well your CURRENT weights predicted your recent reviews, judged Good / OK / Poor.
//   2. Retention    - how often you really remembered cards in the last 30 days, young (gap under 21 days) and mature, against
//                     your target (retentionByAge and retentionVerdict in stats-calc.js, shared with Stats).
//   3. Hard button  - whether Hard is pressed far more than usual.
// Each check ends in one line of advice, and the lines never contradict each other (fitAdvice looks at the retention verdict).

import { evaluateMany, clipWeights } from './fsrs-fit.js';
import { retentionVerdict, RET_MIN_N } from './stats-calc.js';

export { retentionVerdict, RET_MIN_N };

// ---------- 1. fit quality ----------
// Three yardsticks; the verdict is the worst of the three. With fewer than HEALTH_MIN_N predictions there is no verdict;
// under HEALTH_SOFT_N the sheet says the result is rough.
//
//   a. Calibration: is the average predicted chance of remembering the same as what really happened?
//      Poor when they differ by more than 0.03 AND by more than chance allows (1.96 standard errors of the observed share).
//      This catches "the scheduler thinks you remember 90% but you remember 85%".
//   b. RMSE (bins), with the luck taken out: the 20 bins of predicted R, how far each bin's average prediction sits from what happened.
//      On a few hundred reviews luck alone makes this number large (even a perfect model scores about sqrt(sum over bins of p(1-p) / n),
//      called "noise" here), so it is taken out first: excess = sqrt(max(0, rmse^2 - 2 * noise^2)) (twice the expected luck, so a good
//      fit is not marked down for one unlucky draw).
//      Good: excess 0.02 or less.   OK: 0.04 or less.   Poor: above.
//      Where the numbers come from: simulated people whose true memory differs from the weights the scheduler uses, 12,000 predictions
//      each: matching weights 0.00 to 0.005; a mild mismatch (start stabilities x0.7) 0.01 to 0.02; a clear one (x0.5, or a wrong curve
//      shape w20 = 0.5) 0.03 to 0.04; a severe one (x0.3 and w20 0.4) 0.08. The benchmark's RMSE (0.059 to 0.065 for tuned FSRS, 0.091 for
//      untuned FSRS-7) is per user on few reviews, i.e. mostly luck, so it is NOT the yardstick (the first version used it and called a
//      clearly mismatched model Good).
//   c. Log loss against guessing your own average recall every time: skill = (guess loss - your loss) / guess loss.
//      A model no better than the constant guess has skill 0, so it cannot be Good.
//      Good: skill 0.003 or more.   OK: at least -0.02.   Poor: worse than that.
//      (Raw log loss depends on how often you remember: someone at 80% cannot go below 0.50, someone at 95% below 0.20.)
export const RMSE_GOOD = 0.02, RMSE_OK = 0.04;
export const SKILL_GOOD = 0.003, SKILL_OK = -0.02;
export const BIAS_LIMIT = 0.03;
export const HEALTH_MIN_N = 100;       // fewer predictions than this: no verdict
export const HEALTH_SOFT_N = 300;      // fewer than this: the verdict is rough
export const RECENT_DAYS = 90;         // "recent reviews" = the last 90 days, widened to the latest HEALTH_SOFT_N predictions if that is fewer

const RANK = { good: 0, ok: 1, poor: 2 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// Log loss of guessing the share p every time.
export const baseLoss = p => (p <= 0 || p >= 1 ? 0 : -(p * Math.log(p) + (1 - p) * Math.log(1 - p)));

// evaluate()'s numbers plus recall (the share remembered, 0 to 1): { logLoss, rmse, noise, meanPred, n, recall }
// → { grade: 'good' | 'ok' | 'poor' | 'unknown', rmseGrade, lossGrade, calibGrade, excess (RMSE with luck removed), skill, bias (predicted − observed), rough }
export function classifyFit({ logLoss, rmse, noise = 0, meanPred, n, recall }) {
  if (!(n >= HEALTH_MIN_N) || !Number.isFinite(logLoss) || !Number.isFinite(rmse)) {
    return { grade: 'unknown', rmseGrade: null, lossGrade: null, calibGrade: null, excess: null, skill: null, bias: null, rough: false };
  }
  const E = 1e-9;      // (so a value right on a limit is on the better side)
  const excess = Math.sqrt(Math.max(0, rmse * rmse - 2 * noise * noise));
  const rmseGrade = excess <= RMSE_GOOD + E ? 'good' : excess <= RMSE_OK + E ? 'ok' : 'poor';
  const guess = baseLoss(recall);
  const skill = guess > 0 ? (guess - logLoss) / guess : 0;
  const lossGrade = skill >= SKILL_GOOD - E ? 'good' : skill >= SKILL_OK - E ? 'ok' : 'poor';
  const bias = Number.isFinite(meanPred) ? meanPred - recall : 0;
  const se = Math.sqrt(Math.max(recall * (1 - recall), 0.01) / n);
  const calibGrade = Math.abs(bias) > BIAS_LIMIT && Math.abs(bias) > 1.96 * se ? 'poor' : 'good';
  return { grade: worse(worse(rmseGrade, lossGrade), calibGrade), rmseGrade, lossGrade, calibGrade, excess, skill, bias, rough: n < HEALTH_SOFT_N };
}

// Score the current weights on the recent reviews. A generator (like fit()): yields { phase, progress }, returns the result.
//   input.cards   histories (fsrs-data.js buildHistories().cards)       input.steps  relearning-step count of each card's deck
//   input.w       the weights in use now                               input.bounds ts-fsrs CLAMP_PARAMETERS (to clip them for each deck's steps)
//   input.today   today's UTC day number (days since 1970)
// Result: { status: 'ok', logLoss, rmse, noise, meanPred, n, recall, sinceDay } | { status: 'not-enough', n }
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
  return { status: 'ok', logLoss: e.logLoss, rmse: e.rmse, noise: e.noise, meanPred: e.meanPred, n: e.n, recall: e.recalled / e.n, sinceDay };
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

// ---------- the plain words ----------
const pts = x => Math.round(Math.abs(x) * 100);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// fit: classifyFit's result. retention: the verdict of the retention check ('under' | 'over' | 'on' | 'few').
// The two never contradict: when the fit is fine but you are off your target, it says the cause is how you study, not the settings.
export function fitAdvice(fit, { usingOwn = false, canOptimize = false, retention = 'few' } = {}) {
  const off = retention === 'under' || retention === 'over';
  switch (fit.grade) {
    case 'good': return off
      ? 'Your settings predict your reviews well, so the gap to your target comes from how you study, not from the settings.'
      : 'Your settings predict your reviews well.';
    case 'ok': return usingOwn
      ? 'This is acceptable. Run Optimize again in a few weeks as you add reviews.'
      : canOptimize ? 'The standard settings are acceptable for you, and Optimize may fit you better.' : 'The standard settings are acceptable for you. Optimize unlocks after 400 reviews.';
    case 'poor': return usingOwn
      ? 'Predictions are off even with your own settings. Run Optimize again; if your early history is messy, set “Ignore reviews before”.'
      : canOptimize ? 'The standard settings don’t match how you remember. Run Optimize to tune them to you.' : 'The standard settings don’t match how you remember. Optimize unlocks after 400 reviews.';
    default: return 'Keep reviewing; we need a few more recent reviews to say.';
  }
}
export const GRADE_WORDS = { good: 'Good', ok: 'OK', poor: 'Poor', unknown: 'Not enough yet' };

// A sentence on which way the average prediction is off, for the fit section (only when the calibration check failed).
export function biasLine(fit) {
  if (fit.calibGrade !== 'poor') return '';
  return fit.bias > 0
    ? `On average the settings expect you to remember ${pts(fit.bias)} points more often than you do.`
    : `On average the settings expect you to remember ${pts(fit.bias)} points less often than you do.`;
}

// One line about retention: the verdict for all reviews, and which kind of card is slipping.
export function retentionAdvice(all, young, mature, target, { canOptimize = false } = {}) {
  const a = retentionVerdict(all, target), y = retentionVerdict(young, target), m = retentionVerdict(mature, target);
  if (a.verdict === 'few') return 'Not enough reviews in the last 30 days to say. Keep going.';
  if (a.verdict === 'under') {
    if (m.verdict === 'under' && y.verdict !== 'under') return `Retention is ${plural(pts(a.gap), 'point')} under your target, and it is your mature cards (21 days or more) that slip. Their gaps are longer than your memory allows: run Optimize${canOptimize ? '' : ' when it unlocks'}, lower the maximum interval, or raise the target a little.`;
    if (y.verdict === 'under' && m.verdict !== 'under') return `Retention is ${plural(pts(a.gap), 'point')} under your target, and it is your newer cards that slip. Try fewer new cards per day so each gets more attention.`;
    return `Retention is ${plural(pts(a.gap), 'point')} under your target: consider fewer new cards${canOptimize ? ' or running Optimize.' : ', or a higher target to bring cards back sooner.'}`;
  }
  if (a.verdict === 'over') {
    return `Retention is ${plural(pts(a.gap), 'point')} above your target, so you review more than you need to. A lower target (try “Help me choose”) would save reviews.`;
  }
  if (m.verdict === 'under') return 'On target overall, but mature cards (21 days or more) are slipping. Review them as they come due and don’t skip days.';
  if (y.verdict === 'under') return 'On target overall, but newer cards are slipping. Try fewer new cards per day.';
  return 'You’re on target. Nothing to change.';
}

export function hardAdvice(h) {
  if (h.passes < HARD_MIN_N) return 'Not enough reviews to tell yet.';
  if (!h.overuse) return `Hard is ${Math.round(h.share * 100)}% of your remembered reviews, which is normal. Nothing to change.`;
  return `You press Hard on ${Math.round(h.share * 100)}% of remembered reviews, about twice the usual. Hard shortens the next gap, so cards come back sooner than they need to. If you got it right without real struggle, press Good.`;
}
