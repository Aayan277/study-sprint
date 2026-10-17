// "Help me choose" a target retention: a small, seeded simulation of YOUR cards under each target retention from 75% to 97%.
// Pure functions (no database, no page), so it runs in the worker (job-worker pattern of js/fsrs-optimize-worker.js), in Node
// (tests/retention-sim.test.js), and the same seed always gives the same answer. The page side is js/retention-sheet.js.
//
// What it does, in plain words:
//   - It takes the cards you have started (their stability and difficulty now, and when each is next due) and the cards you
//     have not started yet (introduced at your "new cards per day").
//   - For each target retention it plays the next 365 days: on each day the cards that are due are reviewed. Whether you
//     remember a card is drawn from FSRS's forgetting curve with YOUR weights (or the standard ones); the button is drawn from
//     how often you press Hard / Good / Easy (or the usual shares); the card's memory then moves exactly as the scheduler moves
//     it (nextState in fsrs-fit.js, the same maths as ts-fsrs 5.4.2) and its next gap is the one that targets that retention.
//   - It counts the reviews per day and, at 30 / 90 / 365 days, how likely you are to remember a card you have started.
//   - For cards in a deck with an exam date it keeps the exam's rules exactly as js/exam.js applies them:
//       * a card is never held back for a review before the exam just because of the exam: only a card whose next review would
//         fall on or after exam day is touched (examClamp);
//       * of those, only the ones we expect you to remember at less than FINAL_R (99%) on exam day get a review, put on the
//         least busy of the last FINAL_DAYS (3) days before the exam, later days winning a tie (examClamp, planFinalPass);
//       * the target rises to 95% over the last RAMP_DAYS (14) days (examOptions).
//     It then reports, for each target: how ready you would be on exam day BEFORE that final pass (cards you would remember at 90%
//     or better, and the average chance), what the final pass costs ("the last 3 days: about N reviews a day"), and readiness on
//     exam day after it (readiness() in exam.js).
//
// What it leaves out (so treat the numbers as a guide that compares targets, not a forecast):
//   - learning and relearning steps are not played step by step: a new card costs as many answers as you have learning steps
//     (at least 1, one more when it is rated Again) on its first day, a forgotten card costs one extra answer per relearning step;
//   - no due-date spreading (fuzz, easy days), no daily review limit (you do every review that is due), no leeches, no Play;
//   - your future self answers like your recent self. FSRS itself is the model of memory, so if it misjudges you, so does this.
//
// Fairness between targets: every card has its own random stream (seeded by the seed and the card's number), so the same card
// meets the same "dice" under every target. The differences you see between targets are then the effect of the target.
//
// Big collections: more than SIM_CAP cards (started plus the ones to be introduced) are sampled (a seeded, even sample) and the
// counts scaled back up.

import { forgettingCurve, nextState, initState, mulberry32 } from './fsrs-fit.js';
import { FINAL_R, FINAL_DAYS, READY_R, RAMP_DAYS, EXAM_RETENTION } from './exam.js';

export const HORIZONS = [30, 90, 365];
export const RETENTION_MIN = 75, RETENTION_MAX = 97;
export const RETENTIONS = Array.from({ length: RETENTION_MAX - RETENTION_MIN + 1 }, (_, i) => (RETENTION_MIN + i) / 100);
export const SIM_CAP = 1500;                       // cards simulated at most (the rest is a sample, scaled up)
export const TIME_BUDGET_MS = 3000;                // stop filling in the gaps when it has taken this long
export const DEFAULT_REVIEW_PROBS = [0.224, 0.632, 0.144];        // Hard, Good, Easy among remembered reviews (the shares fsrs-rs's simulator starts from)
export const DEFAULT_FIRST_PROBS = [0.24, 0.094, 0.495, 0.171];   // Again, Hard, Good, Easy on a card's first answer (same source)
export const MIN_OWN_PROBS = 100, MIN_OWN_FIRST = 30;             // how many of your own answers before they replace the standard shares

// ---------- your own button habits ----------
// Review-log rows → { review: [hard, good, easy] shares, first: [again, hard, good, easy] shares, own: { review, first } }.
// Only answers you pressed yourself in Review (source 'review'); game answers are graded by the app and imported history is old.
// review = cards already in Review state that you remembered; first = a card's first answer (state 0).
export function ratingProbs(rows) {
  const rev = [0, 0, 0], first = [0, 0, 0, 0];
  for (const l of rows || []) {
    if (l.source !== 'review' || !(l.rating >= 1 && l.rating <= 4)) continue;
    if (l.state === 2 && l.rating >= 2) rev[l.rating - 2]++;
    else if (l.state === 0) first[l.rating - 1]++;
  }
  const norm = a => { const n = a.reduce((x, y) => x + y, 0); return a.map(x => x / n); };
  const nr = rev[0] + rev[1] + rev[2], nf = first.reduce((x, y) => x + y, 0);
  return {
    review: nr >= MIN_OWN_PROBS ? norm(rev) : DEFAULT_REVIEW_PROBS.slice(),
    first: nf >= MIN_OWN_FIRST ? norm(first) : DEFAULT_FIRST_PROBS.slice(),
    own: { review: nr >= MIN_OWN_PROBS, first: nf >= MIN_OWN_FIRST }
  };
}

// The gap in days that targets a retention (ts-fsrs nextInterval without fuzz): whole days, 1 to maxInterval.
export function intervalFor(w, s, retention, maxInterval) {
  const decay = -w[20];
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  const days = Math.round(s / factor * (Math.pow(retention, 1 / decay) - 1));
  return Math.min(Math.max(days, 1), maxInterval);
}

// ---------- sampling ----------
// plan: { f, days, existingIdx, unseenIdx }: f = the share of cards simulated (1 = all), and which ones.
export function planSample(input, days = Math.max(...HORIZONS)) {
  const ex = input.existing.length, un = input.unseen.length;
  const intro = Math.min(un, Math.ceil(input.newPerDay * days));
  const population = ex + intro;
  const f = population > SIM_CAP ? SIM_CAP / population : 1;
  // an even, seeded sample: take every card whose running share crosses a whole number
  const pick = (n, share) => {
    if (share >= 1) return Array.from({ length: n }, (_, i) => i);
    const out = [];
    const rng = mulberry32((input.seed >>> 0) ^ 0x9E3779B9 ^ n);
    let carry = rng();                                  // a seeded offset, so the sample is not always the first of each stride
    for (let i = 0; i < n; i++) { carry += share; if (carry >= 1) { carry -= 1; out.push(i); } }
    return out;
  };
  return { f, days, existingIdx: pick(ex, f), unseenIdx: pick(un, f) };
}

// ---------- one run: one target retention ----------
// input:
//   w                 21 weights (yours or the standard ones, clipped as the scheduler clips them)
//   existing          [{ s, d, last, due, grp }]  started cards: stability, difficulty, last review day and next due day
//                     (days from today; last <= 0; due >= 0, an overdue card is due on day 0), grp = index into `groups`
//   unseen            Int16Array/array of grp, one entry per card not started, in the order they would be introduced
//   groups            [{ exam: day or null }]   one per exam date (or null for no exam); `exam` = days from today to exam day (1 or more)
//   newPerDay, learnSteps, relearnSteps (how many), maxInterval
//   reviewProbs [hard, good, easy], firstProbs [again, hard, good, easy]
//   seed
// Returns { horizons: { 30: {...}, 90: {...}, 365: {...} }, exams: [...] } with counts already scaled by 1/f. Each exam:
//   { grp, day, total, ready, share (ready on exam day, after the last pass), preShare / preRecall (ready share and average chance on
//     exam day if nothing more were reviewed from the day the last pass starts), passLoad (reviews a day over the last FINAL_DAYS days) }
export function simulateOne(input, retention, plan = planSample(input)) {
  const { w, newPerDay, learnSteps = 2, relearnSteps = 1, maxInterval = 36500, reviewProbs, firstProbs, seed = 1, groups } = input;
  const H = plan.days, f = plan.f;
  const ex = plan.existingIdx, un = plan.unseenIdx;
  const N = ex.length + un.length;
  const S = new Float64Array(N), D = new Float64Array(N);
  const last = new Int32Array(N), grp = new Int16Array(N), rs = new Uint32Array(N), started = new Uint8Array(N);
  const buckets = Array.from({ length: H + 1 }, () => []);
  const examDay = g => groups[g].exam;                 // null = no exam
  const hasExam = groups.map(g => g.exam !== null);
  const rnd = i => {                                    // the card's own random stream (mulberry32, inlined)
    let a = (rs[i] + 0x6D2B79F5) >>> 0;
    rs[i] = a;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cardSeed = key => (Math.imul((seed >>> 0) + 1, 2654435761) ^ Math.imul(key + 1, 40503)) >>> 0;
  const schedule = (i, due) => { if (due < H) buckets[due].push(i); };
  const load = d => (d >= 0 && d < H && buckets[d] ? buckets[d].length : 0);
  // examClamp (exam.js): after a review on `day` that would put the next one on or after exam day, a card we do not expect you to remember
  // at 99% on exam day goes on the least busy of the last FINAL_DAYS days (tomorrow at the earliest; later days win a tie).
  const placeDue = (i, day, due) => {
    const g = grp[i];
    if (!hasExam[g]) return due;
    const daysLeft = examDay(g) - day;
    if (daysLeft <= 0 || due < examDay(g)) return due;
    if (forgettingCurve(w, daysLeft, S[i]) >= FINAL_R) return due;
    const first = Math.max(1, daysLeft - Math.min(FINAL_DAYS, daysLeft)), lastD = daysLeft - 1;
    if (first > lastD) return due;
    let best = lastD;
    for (let d = lastD - 1; d >= first; d--) if (load(day + d) < load(day + best)) best = d;
    return day + best;
  };
  const targetFor = (i, day) => {                      // examOptions: the target rises to 95% over the last two weeks before an exam
    const g = grp[i];
    if (!hasExam[g]) return retention;
    const left = examDay(g) - day;
    if (left <= 0 || left >= RAMP_DAYS || retention >= EXAM_RETENTION) return retention;
    const t = 1 - Math.max(0, left - 1) / (RAMP_DAYS - 1);
    return Math.round((retention + (EXAM_RETENTION - retention) * t) * 1000) / 1000;
  };

  const recallAtDay = (i, day) => forgettingCurve(w, Math.max(0, day - last[i]), S[i]);
  let n = 0;
  const late = [];                                      // started cards whose next review is on or after exam day (planFinalPass)
  for (const k of ex) {
    const c = input.existing[k], i = n++;
    S[i] = c.s; D[i] = c.d; last[i] = c.last; grp[i] = c.grp; rs[i] = cardSeed(k); started[i] = 1;
    const due = Math.max(0, c.due);
    const g = c.grp;
    if (hasExam[g] && due >= examDay(g) && forgettingCurve(w, examDay(g) - c.last, c.s) < FINAL_R) late.push(i);
    else schedule(i, due);
  }
  // planFinalPass: the strongest of those go on the earliest of the last days, the weakest nearest the exam, keeping the days level
  late.sort((a, b) => recallAt(b, examDay(grp[b])) - recallAt(a, examDay(grp[a])) || a - b);
  function recallAt(i, d) { return forgettingCurve(w, d - last[i], S[i]); }
  for (const i of late) {
    const e = examDay(grp[i]);
    const first = Math.max(0, e - FINAL_DAYS), lastD = e - 1;
    let best = first;
    for (let d = first + 1; d <= lastD; d++) if (load(d) < load(best)) best = d;
    schedule(i, best);
  }
  const firstUnseen = n;
  const exTotals = groups.map(() => 0);                 // sampled cards per exam group: started + all that would still be new
  for (let i = 0; i < ex.length; i++) exTotals[grp[i]]++;
  for (const k of un) exTotals[input.unseen[k]] += 1;
  for (let j = 0; j < un.length; j++) { const i = firstUnseen + j; grp[i] = input.unseen[un[j]]; rs[i] = cardSeed(1e6 + un[j]); }

  const result = { horizons: {}, exams: [] };
  const grpReviews = groups.map(() => 0);
  const pre = groups.map(() => null);                   // { share, recall, reviews } on the day the last pass starts
  let reviews = 0, nextNew = firstUnseen, carry = 0, startedCount = ex.length;
  const learnCost = Math.max(1, learnSteps);
  const answer = (i, day) => {                          // one review of a started card on `day`
    const t = Math.max(0, day - last[i]);
    const r = forgettingCurve(w, t, S[i]);
    let g = 1;
    if (rnd(i) < r) {
      const u = rnd(i);
      g = u < reviewProbs[0] ? 2 : u < reviewProbs[0] + reviewProbs[1] ? 3 : 4;
    } else rnd(i);                                      // (a forgotten card still uses its second draw, so streams stay aligned)
    const nx = nextState(w, S[i], D[i], t, g, true, r);
    S[i] = nx.s; D[i] = nx.d; last[i] = day;
    const cost = g === 1 ? 1 + relearnSteps : 1;
    reviews += cost; grpReviews[grp[i]] += cost;
    return g;
  };
  const snapshot = day => {
    let known = 0;
    for (let i = 0; i < N; i++) if (started[i]) known += recallAtDay(i, day);
    const total = reviews / f;
    result.horizons[day] = {
      days: day, reviews: total, reviewsPerDay: total / day,
      started: startedCount / f, known: known / f, recall: startedCount ? known / startedCount : 0
    };
  };

  for (let day = 0; day < H; day++) {
    for (let g = 0; g < groups.length; g++) {
      if (!hasExam[g]) continue;
      const e = examDay(g);
      // the day the last pass starts: how ready would you be on exam day if nothing more were reviewed?
      if (day === Math.max(0, e - FINAL_DAYS)) {
        let ready = 0, sum = 0, cnt = 0;
        for (let i = 0; i < N; i++) if (grp[i] === g && started[i]) { const r = forgettingCurve(w, e - last[i], S[i]); sum += r; cnt++; if (r >= READY_R) ready++; }
        pre[g] = { share: exTotals[g] ? ready / exTotals[g] : 0, recall: cnt ? sum / cnt : 0, reviews: grpReviews[g], ready, day };
      }
      // exam day: how ready is the group (before any review that day, as readiness() has it)
      if (day === e) {
        let ready = 0;
        for (let i = 0; i < N; i++) if (grp[i] === g && started[i] && recallAtDay(i, day) >= READY_R) ready++;
        const p = pre[g];
        result.exams.push({
          grp: g, day, ready, total: exTotals[g], share: exTotals[g] ? ready / exTotals[g] : 0,
          preShare: p.share, preRecall: p.recall, passLoad: (grpReviews[g] - p.reviews) / (e - p.day) / f
        });
      }
    }
    // new cards for today (a fraction of a card carries over when only a sample is simulated)
    carry += newPerDay * f;
    let todays = Math.floor(carry + 1e-9);
    carry -= todays;
    while (todays-- > 0 && nextNew < N) {
      const i = nextNew++;
      const u = rnd(i);
      const g = u < firstProbs[0] ? 1 : u < firstProbs[0] + firstProbs[1] ? 2 : u < firstProbs[0] + firstProbs[1] + firstProbs[2] ? 3 : 4;
      const st = initState(w, g);
      S[i] = st.s; D[i] = st.d; last[i] = day; started[i] = 1; startedCount++;
      const cost = g === 1 ? learnCost + 1 : g === 4 ? 1 : learnCost;
      reviews += cost; grpReviews[grp[i]] += cost;
      const gap = g === 1 ? 1 : intervalFor(w, S[i], targetFor(i, day), maxInterval);
      schedule(i, placeDue(i, day, day + gap));
    }
    // reviews due today
    const due = buckets[day];
    for (let b = 0; b < due.length; b++) {
      const i = due[b];
      answer(i, day);
      schedule(i, placeDue(i, day, day + intervalFor(w, S[i], targetFor(i, day), maxInterval)));
    }
    buckets[day] = null;
    if (HORIZONS.includes(day + 1)) snapshot(day + 1);
  }
  return result;
}

// ---------- all targets: a generator (the worker, Node and the page's fallback all step it the same way) ----------
// Order of work: your current target first, then every 5% (75, 80, ... 95 and 97), then the gaps, until the time budget is used up.
// The first two groups always finish; only the gap filling stops early. Yields { phase: 'sim', done, total, progress }.
// Returns { points, complete, missing, f, sampled } where points = one entry per target simulated, in order of retention:
// { retention, horizons, exams }.
export function priorityOrder(retentions, current) {
  const key = r => Math.round(r * 100);
  const order = [];
  const add = r => { if (!order.some(x => key(x) === key(r))) order.push(r); };
  const cur = Number.isFinite(current) ? retentions.find(r => key(r) === key(current)) : undefined;
  if (cur !== undefined) add(cur);
  for (const r of retentions) if (key(r) % 5 === 0 || r === retentions[retentions.length - 1]) add(r);
  const core = order.length;
  for (const r of retentions) add(r);
  return { order, core };
}

export function* simulateAll(input, { retentions = RETENTIONS, now = () => Date.now(), budgetMs = TIME_BUDGET_MS, current = input.current } = {}) {
  const plan = planSample(input);
  const started = now();
  const { order, core } = priorityOrder(retentions, current);
  const points = [];
  let complete = true;
  for (let k = 0; k < order.length; k++) {
    yield { phase: 'sim', done: k, total: order.length, progress: k / order.length };
    if (k >= core && now() - started > budgetMs) { complete = false; break; }
    const r = simulateOne(input, order[k], plan);
    points.push({ retention: order[k], horizons: r.horizons, exams: r.exams });
  }
  yield { phase: 'sim', done: points.length, total: order.length, progress: 1 };
  points.sort((a, b) => a.retention - b.retention);
  return { points, complete, missing: order.length - points.length, f: plan.f, sampled: plan.f < 1 };
}

// The simulated target nearest to `wanted` (a retention 0 to 1), so a pick is always one that was worked out. null with no points.
export function pickSelected(points, wanted) {
  let best = null;
  for (const p of points) if (best === null || Math.abs(p.retention - wanted) < Math.abs(best.retention - wanted) - 1e-12) best = p;
  return best ? best.retention : null;
}

// ---------- reading the results: the suggested target ----------
// The workload curve (reviews a day at a horizon against the target) is noisy, because it comes from one random draw per card.
// So it is smoothed before it is used: first made non-decreasing (pool adjacent violators), then replaced by its greatest convex
// minorant (the lower convex hull), which is what a workload that grows faster and faster with the target looks like without the noise.
// Both are computed over a FIXED range, KNEE_MIN to KNEE_MAX, so the answer does not move with the targets that were simulated.
export const KNEE_MIN = 0.80, KNEE_MAX = 0.97;

// → { retentions: [0.80 … 0.97], values: [reviews a day …] } or null when fewer than 3 targets in range were simulated.
export function smoothWorkload(points, horizon) {
  const raw = points.filter(p => p.retention >= KNEE_MIN - 1e-9 && p.retention <= KNEE_MAX + 1e-9 && p.horizons[horizon])
    .sort((a, b) => a.retention - b.retention).map(p => [p.retention, p.horizons[horizon].reviewsPerDay]);
  if (raw.length < 3) return null;
  // non-decreasing (pool adjacent violators)
  const blocks = [];
  for (const [x, y] of raw) {
    blocks.push({ x: [x], sum: y, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop(), a = blocks.pop();
      blocks.push({ x: a.x.concat(b.x), sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const mono = [];
  for (const b of blocks) for (const x of b.x) mono.push([x, b.sum / b.n]);
  // lower convex hull
  const hull = [];
  for (const p of mono) {
    while (hull.length >= 2) {
      const [x1, y1] = hull[hull.length - 2], [x2, y2] = hull[hull.length - 1];
      if ((y2 - y1) * (p[0] - x1) >= (p[1] - y1) * (x2 - x1)) hull.pop(); else break;      // the middle point lies on or above the chord: not convex
    }
    hull.push(p);
  }
  const at = x => {
    if (x <= hull[0][0]) return hull[0][1];
    for (let i = 1; i < hull.length; i++) if (x <= hull[i][0] + 1e-12) { const [x0, y0] = hull[i - 1], [x1, y1] = hull[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    return hull[hull.length - 1][1];
  };
  const retentions = [], values = [];
  for (let pct = Math.round(KNEE_MIN * 100); pct <= Math.round(KNEE_MAX * 100); pct++) { retentions.push(pct / 100); values.push(at(pct / 100)); }
  return { retentions, values };
}

// The knee of a smoothed curve: where it is farthest below the straight line from its first to its last point, on axes scaled 0 to 1
// (the "kneedle" idea). Above it, each extra point of target costs much more reviews than below it. Returns a retention.
export function kneeOf(curve) {
  const { retentions: xs, values: ys } = curve;
  const n = xs.length - 1, y0 = ys[0], span = ys[n] - y0;
  if (!(span > 1e-9)) return xs[0];                                   // a flat curve has no knee
  let best = 0, bestGap = -Infinity;
  for (let i = 0; i <= n; i++) {
    const gap = i / n - (ys[i] - y0) / span;
    if (gap > bestGap + 1e-12) { bestGap = gap; best = i; }
  }
  return xs[best];
}

// What one more point of target costs at a given target: { perDay (reviews a day), pct (as a share of the workload there) } or null.
export function marginalCost(curve, retention) {
  const i = Math.round(retention * 100) - Math.round(KNEE_MIN * 100);
  if (!curve || i < 0 || i >= curve.values.length - 1) return null;
  const here = curve.values[i], next = curve.values[i + 1];
  return { perDay: next - here, pct: here > 0 ? (next - here) / here : 0 };
}

// The highest target whose (smoothed) reviews a day fit within a limit. null when even KNEE_MIN does not fit.
export function highestWithin(curve, limit) {
  let best = null;
  curve.values.forEach((v, i) => { if (v <= limit + 1e-9) best = curve.retentions[i]; });
  return best;
}

// The simulated target nearest to `r`, or (below = true) the highest simulated one that is not above it. null when none qualifies.
// (A suggestion read off the smoothed curve is on a whole percent, but when the time budget cut the gap filling that percent may not
// have been simulated, and everything the sheet shows for a target comes from a simulated one.)
function snapTo(points, r, below = false) {
  let best = null;
  for (const p of points) {
    if (below ? p.retention > r + 1e-9 : false) continue;
    if (best === null || (below ? p.retention > best.retention : Math.abs(p.retention - r) < Math.abs(best.retention - r) - 1e-12)) best = p;
  }
  return best ? best.retention : null;
}

// Exam decks: the target to suggest, from what the final pass has to do. For each simulated target from KNEE_MIN up, the exam gives
//   preRecall   the average chance of remembering a card on exam day if nothing more were reviewed from the day the last pass starts
//   passLoad    reviews a day over the last FINAL_DAYS days (the pass and the normal reviews that fall there)
// The suggestion is the lowest target from which, all the way up, the recall before the pass is within EXAM_TOLERANCE of the best and
// the last days are within EXAM_LOAD_TOLERANCE of the lightest. (The recall after the pass is not used: the pass lifts every target
// to about the same, so it cannot tell them apart.) → { target, preRecall, passLoad } or null with no exam numbers.
export const EXAM_TOLERANCE = 0.03;          // recall before the final pass: within 3 points of the best
export const EXAM_LOAD_TOLERANCE = 0.15;     // the last days: within 15% (and half a review a day) of the lightest
export function examTarget(points, group) {
  const rows = points.filter(p => p.retention >= KNEE_MIN - 1e-9).map(p => ({ r: p.retention, e: p.exams.find(x => x.grp === group) }))
    .filter(x => x.e).sort((a, b) => a.r - b.r);
  if (!rows.length) return null;
  const bestRecall = Math.max(...rows.map(x => x.e.preRecall)), lightest = Math.min(...rows.map(x => x.e.passLoad));
  const fine = x => x.e.preRecall >= bestRecall - EXAM_TOLERANCE - 1e-9 && x.e.passLoad <= lightest * (1 + EXAM_LOAD_TOLERANCE) + 0.5;
  let top = rows.length - 1;
  while (top >= 0 && !fine(rows[top])) top--;
  if (top < 0) { const b = rows.reduce((m, x) => (x.e.preRecall > m.e.preRecall ? x : m)); return { target: b.r, preRecall: b.e.preRecall, passLoad: b.e.passLoad }; }
  let i = top;
  while (i > 0 && fine(rows[i - 1])) i--;
  return { target: rows[i].r, preRecall: rows[i].e.preRecall, passLoad: rows[i].e.passLoad };
}

// The suggestion for a horizon. Returns { target, kind, knee, curve, limit, limitFits, examGroup, exam } where kind is
//   'knee'    the knee of the smoothed workload curve (the default)
//   'limit'   you set a daily review limit: the highest target whose reviews a day fit it (an exam deck never goes above its own
//             suggestion, so for an exam this is only used when the limit is lower)
//   'exam'    a deck with an exam: see examTarget
//   'none'    not enough targets were worked out, or even KNEE_MIN does not fit your limit (target = null)
// target is always one that was simulated. exam = { preRecall, passLoad } of the exam group at the target, or null.
export function suggestion(points, horizon, { reviewLimit = null, examGroup = null } = {}) {
  const limit = Number.isFinite(reviewLimit) && reviewLimit > 0 ? reviewLimit : null;
  const curve = smoothWorkload(points, horizon);
  const hasExam = examGroup !== null && examGroup !== undefined;
  const none = { target: null, kind: 'none', knee: null, curve, limit, limitFits: !!curve, examGroup, exam: null, examTarget: null };
  if (!curve) return none;
  const knee = kneeOf(curve);
  let target = knee, kind = 'knee';
  const ex = hasExam ? examTarget(points, examGroup) : null;
  if (ex) { target = ex.target; kind = 'exam'; }
  if (limit !== null) {
    const fit = highestWithin(curve, limit);
    if (fit === null) return { ...none, knee, limitFits: false };
    if (kind !== 'exam' || fit < target - 1e-9) { target = fit; kind = 'limit'; }
  }
  target = snapTo(points, target, kind === 'limit');
  const at = target === null || !hasExam ? null : points.find(p => Math.abs(p.retention - target) < 1e-9)?.exams.find(x => x.grp === examGroup) || null;
  return {
    target, kind: target === null ? 'none' : kind, knee, curve, limit, limitFits: true, examGroup,
    exam: at ? { preRecall: at.preRecall, passLoad: at.passLoad } : null, examTarget: ex ? ex.target : null
  };
}
