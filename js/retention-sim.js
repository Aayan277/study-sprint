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
//   - For a deck with an exam date it also keeps the exam rules (js/exam.js): no card is left for after the exam, the target
//     rises to 95% over the last 14 days, and cards below 99% on exam day get a last review the day before. Readiness is then
//     the share of the deck's cards that you would remember at 90% or better on exam day (readiness() in exam.js).
//
// What it leaves out (so treat the numbers as a guide that compares targets, not a forecast):
//   - learning and relearning steps are not played step by step: a new card costs as many answers as you have learning steps
//     (at least 1) on its first day, a forgotten card costs one extra answer per relearning step;
//   - no due-date spreading (fuzz, easy days), no daily review limit (you do every review that is due), no leeches, no Play;
//   - your future self answers like your recent self. FSRS itself is the model of memory, so if it misjudges you, so does this.
//
// Fairness between targets: every card has its own random stream (seeded by the seed and the card's number), so the same card
// meets the same "dice" under every target. The differences you see between targets are then the effect of the target.
//
// Big collections: more than SIM_CAP cards (started plus the ones to be introduced) are sampled (a seeded, even sample) and the
// counts scaled back up.

import { forgettingCurve, nextState, initState, mulberry32 } from './fsrs-fit.js';
import { FINAL_R, READY_R, RAMP_DAYS, EXAM_RETENTION } from './exam.js';

export const HORIZONS = [30, 90, 365];
export const RETENTION_MIN = 75, RETENTION_MAX = 97;
export const RETENTIONS = Array.from({ length: RETENTION_MAX - RETENTION_MIN + 1 }, (_, i) => (RETENTION_MIN + i) / 100);
export const SIM_CAP = 1500;                       // cards simulated at most (the rest is a sample, scaled up)
export const TIME_BUDGET_MS = 3000;                // stop and show what is done when it has taken this long
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

// ---------- one run: one target retention ----------
// input:
//   w                 21 weights (yours or the standard ones)
//   existing          [{ s, d, last, due, grp }]  started cards: stability, difficulty, last review day and next due day
//                     (days from today; last <= 0; due >= 0, an overdue card is due on day 0), grp = index into `groups`
//   unseen            Int16Array/array of grp, one entry per card not started, in the order they would be introduced
//   groups            [{ exam: day or null }]   one per exam date (or null for no exam); `exam` = days from today to exam day (0 = today)
//   newPerDay, learnSteps, relearnSteps (how many), maxInterval
//   reviewProbs [hard, good, easy], firstProbs [again, hard, good, easy]
//   seed
// plan (from planSample): { f, existingIdx: indexes of the sampled started cards, unseenIdx: sampled unseen, days }
// Returns { horizons: { 30: {...}, 90: {...}, 365: {...} }, exams: [{ grp, day, ready, total }] } with counts already scaled by 1/f.
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
  const limitDue = (i, day, due) => {                  // an exam moves the last review to before exam day
    const g = grp[i];
    if (hasExam[g] && day < examDay(g) - 1) return Math.min(due, examDay(g) - 1);
    return due;
  };
  const targetFor = (i, day) => {                      // the target rises to 95% over the last two weeks before an exam
    const g = grp[i];
    if (!hasExam[g]) return retention;
    const left = examDay(g) - day;
    if (left <= 0 || left >= RAMP_DAYS || retention >= EXAM_RETENTION) return retention;
    const t = 1 - Math.max(0, left - 1) / (RAMP_DAYS - 1);
    return Math.round((retention + (EXAM_RETENTION - retention) * t) * 1000) / 1000;
  };

  let n = 0;
  for (const k of ex) {
    const c = input.existing[k], i = n++;
    S[i] = c.s; D[i] = c.d; last[i] = c.last; grp[i] = c.grp; rs[i] = cardSeed(k); started[i] = 1;
    let due = Math.max(0, c.due);
    if (hasExam[c.grp] && examDay(c.grp) >= 1) due = Math.min(due, Math.max(0, examDay(c.grp) - 1));
    schedule(i, due);
  }
  const firstUnseen = n;
  const exTotals = groups.map(() => 0);                 // sampled cards per exam group: started + all that would still be new
  for (let i = 0; i < ex.length; i++) exTotals[grp[i]]++;
  for (const k of un) exTotals[input.unseen[k]] += 1;
  for (let j = 0; j < un.length; j++) { const i = firstUnseen + j; grp[i] = input.unseen[un[j]]; rs[i] = cardSeed(1e6 + un[j]); }

  const recallNow = (i, day) => forgettingCurve(w, Math.max(0, day - last[i]), S[i]);
  const result = { horizons: {}, exams: [] };
  let reviews = 0, nextNew = firstUnseen, carry = 0, startedCount = ex.length;
  const learnCost = Math.max(1, learnSteps);
  const answer = (i, day, forced) => {                  // one review of a started card on `day`
    const t = Math.max(0, day - last[i]);
    const r = forgettingCurve(w, t, S[i]);
    let g = 1;
    if (rnd(i) < r) {
      const u = rnd(i);
      g = u < reviewProbs[0] ? 2 : u < reviewProbs[0] + reviewProbs[1] ? 3 : 4;
    } else rnd(i);                                      // (a forgotten card still uses its second draw, so streams stay aligned)
    const nx = nextState(w, S[i], D[i], t, g, true, r);
    S[i] = nx.s; D[i] = nx.d; last[i] = day;
    reviews += g === 1 ? 1 + relearnSteps : 1;
    return g;
  };
  const snapshot = day => {
    let known = 0;
    for (let i = 0; i < N; i++) if (started[i]) known += recallNow(i, day);
    const total = reviews / f;
    result.horizons[day] = {
      days: day, reviews: total, reviewsPerDay: total / day,
      started: startedCount / f, known: known / f, recall: startedCount ? known / startedCount : 0
    };
  };

  for (let day = 0; day < H; day++) {
    // exam day: how ready is each exam group, if you did no more reviews (before today's reviews, as readiness() does)
    for (let g = 0; g < groups.length; g++) {
      if (!hasExam[g] || examDay(g) !== day) continue;
      let ready = 0;
      for (let i = 0; i < N; i++) if (grp[i] === g && started[i] && recallNow(i, day) >= READY_R) ready++;
      result.exams.push({ grp: g, day, ready, total: exTotals[g], share: exTotals[g] ? ready / exTotals[g] : 0 });
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
      reviews += g === 1 ? learnCost + 1 : g === 4 ? 1 : learnCost;
      const gap = g === 1 ? 1 : intervalFor(w, S[i], targetFor(i, day), maxInterval);
      schedule(i, limitDue(i, day, day + gap));
    }
    // reviews due today
    const due = buckets[day];
    for (let b = 0; b < due.length; b++) {
      const i = due[b];
      answer(i, day);
      schedule(i, limitDue(i, day, day + intervalFor(w, S[i], targetFor(i, day), maxInterval)));
    }
    // the exam's last pass: on the day before, every card still below FINAL_R for exam day is reviewed once more
    for (let g = 0; g < groups.length; g++) {
      if (!hasExam[g] || examDay(g) - 1 !== day) continue;
      for (let i = 0; i < N; i++) {
        if (grp[i] !== g || !started[i] || last[i] === day) continue;
        if (forgettingCurve(w, examDay(g) - last[i], S[i]) < FINAL_R) answer(i, day);
      }
    }
    buckets[day] = null;
    if (HORIZONS.includes(day + 1)) snapshot(day + 1);
  }
  return result;
}

// ---------- all targets: a generator (the worker, Node and the page's fallback all step it the same way) ----------
// Yields { phase: 'sim', done, total, progress }. Returns { points, complete, f, sampled, stoppedAt, seed } where points = one entry
// per target: { retention, horizons, exams }.
export function* simulateAll(input, { retentions = RETENTIONS, now = () => Date.now(), budgetMs = TIME_BUDGET_MS } = {}) {
  const plan = planSample(input);
  const started = now();
  const points = [];
  let complete = true;
  for (let k = 0; k < retentions.length; k++) {
    yield { phase: 'sim', done: k, total: retentions.length, progress: k / retentions.length };
    if (k >= 2 && now() - started > budgetMs) { complete = false; break; }
    const r = simulateOne(input, retentions[k], plan);
    points.push({ retention: retentions[k], horizons: r.horizons, exams: r.exams });
  }
  yield { phase: 'sim', done: points.length, total: retentions.length, progress: 1 };
  return { points, complete, f: plan.f, sampled: plan.f < 1, stoppedAt: complete ? null : points[points.length - 1].retention };
}

// ---------- reading the results ----------
// Knowledge per review at a horizon: how many of your cards you would remember at the end, for each review it takes.
export const efficiency = (pt, horizon) => {
  const h = pt.horizons[horizon];
  return h && h.reviews > 0 ? h.known / h.reviews : 0;
};

export const SUGGEST_TOLERANCE = 0.02;      // "within 2% of the best knowledge per review"
export const SUGGEST_FLOOR = 0.80;          // never suggest a target below 80% (the lowest the app has always offered; below it, forgetting is frequent)

// The suggested target: among targets whose knowledge per review is within SUGGEST_TOLERANCE of the best, the one with the fewest
// reviews (the lowest retention). Looks only at targets from SUGGEST_FLOOR up. Returns a retention (0.8 … 0.97) or null.
export function suggestRetention(points, horizon, { tolerance = SUGGEST_TOLERANCE, floor = SUGGEST_FLOOR } = {}) {
  const pool = points.filter(p => p.retention >= floor - 1e-9 && p.horizons[horizon]);
  if (!pool.length) return null;
  const best = Math.max(...pool.map(p => efficiency(p, horizon)));
  const ok = pool.filter(p => efficiency(p, horizon) >= best * (1 - tolerance));
  ok.sort((a, b) => a.horizons[horizon].reviews - b.horizons[horizon].reviews || a.retention - b.retention);
  return ok[0].retention;
}

// The suggestion for a horizon. With an exam, readiness decides (the exam's own final pass makes most targets close).
export function suggestFor(points, horizon, examGroup) {
  if (examGroup === undefined || examGroup === null) return suggestRetention(points, horizon);
  const pool = points.filter(p => p.retention >= SUGGEST_FLOOR - 1e-9 && p.exams.some(e => e.grp === examGroup));
  if (!pool.length) return suggestRetention(points, horizon);
  const share = p => p.exams.find(e => e.grp === examGroup).share;
  const best = Math.max(...pool.map(share));
  const ok = pool.filter(p => share(p) >= best - 0.02);
  ok.sort((a, b) => a.horizons[horizon].reviews - b.horizons[horizon].reviews);
  return ok[0].retention;
}
