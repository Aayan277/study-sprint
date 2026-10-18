// The FSRS-7 scheduler: given a card's memory and a rating, when does the card come back, and what state is it in?
// Pure (imports only the memory model). It reproduces what ts-fsrs 6.0.0-beta.14 does with its default FSRS-7 scheduler
// (DefaultScheduler: learning steps as a floor under the model's interval, fractional days, graduating interval 1 day,
// monotonic intervals, fuzz), checked card by card in tests/fsrs7-parity.test.js. Design: docs/design/fsrs7-plan.md.
//
// The big difference from FSRS-6 here: the model knows about short gaps, so the learning steps (1m 10m) are only a floor.
// A new card answered Good comes back when the model says so (about 5 days), not after 10 minutes. After a lapse the card
// comes back after the model's interval, between the relearning step and one day.

import { forgettingCurve7, nextState7, nextInterval7 } from './fsrs7-model.js';

const DAY = 86400000;
export const NEW = 0, LEARNING = 1, REVIEW = 2, RELEARNING = 3;
export const GRADUATING_DAYS = 1;                         // the library's default graduating interval

// ---------- learning steps (a copy of the library's calculateLearningSteps and getLearningStepInterval) ----------
const stepMinutes = s => { const m = /^(\d+(?:\.\d*)?)([mhd])$/.exec(s); return +m[1] * { m: 1, h: 60, d: 1440 }[m[2]]; };

function stepsFor(cfg, state, learningStep) {
  const steps = state === RELEARNING || state === REVIEW ? cfg.relearningSteps : cfg.learningSteps;
  const n = steps.length;
  if (n === 0 || learningStep >= n) return {};
  const unit = steps[Math.max(0, learningStep)];
  if (state === REVIEW) return { 1: { minutes: stepMinutes(unit), next: 0 } };
  const first = stepMinutes(steps[0]);
  const second = n > 1 ? stepMinutes(steps[1]) : undefined;
  const out = { 1: { minutes: first, next: 0 }, 2: { minutes: second === undefined ? first * 1.5 : (first + second) / 2, next: learningStep } };
  const nextUnit = steps[learningStep + 1];
  if (nextUnit) {
    const m = learningStep === 0 && second !== undefined ? second : stepMinutes(nextUnit);
    if (m > 0) out[3] = { minutes: m, next: learningStep + 1 };
  }
  return out;
}

// ---------- spreading long gaps (fuzz): the library's deterministic version ----------
const FUZZ = [{ start: 2.5, end: 7, factor: 0.15 }, { start: 7, end: 20, factor: 0.1 }, { start: 20, end: Infinity, factor: 0.05 }];
function fuzzRange(interval, elapsed, maxInterval) {
  let delta = 1;
  for (const r of FUZZ) delta += r.factor * Math.max(Math.min(interval, r.end) - r.start, 0);
  const capped = Math.min(interval, maxInterval);
  let min = Math.max(2, Math.round(capped - delta));
  const max = Math.min(Math.round(capped + delta), maxInterval);
  if (capped > elapsed) min = Math.max(min, elapsed + 1);
  return { min: Math.min(min, max), max };
}
function fnv1a32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    let t = a += 1831565813;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------- keeping the four buttons in order (the library's calculateScheduleDay) ----------
const toSeconds = days => Math.round(days * 86400);
function scheduleDay(candidates, maxInterval) {
  let day;
  let sub = candidates[0];
  for (let i = 0; i < candidates.length; i++) {
    const interval = candidates[i];
    if (interval >= 1) day = Math.min(day === undefined ? interval : Math.max(interval, day + 1), maxInterval);
    else if (day === undefined && i > 0) {
      const raised = Math.max(interval, sub);
      sub = sub > 0 && toSeconds(interval) >= toSeconds(candidates[i - 1]) && toSeconds(raised) === toSeconds(sub) ? sub + 1 / 86400 : raised;
    }
  }
  return day ?? sub;
}

// What a card needs to be scheduled:
//   card  { state, learningStep, reps, lapses, lastReview (ms or null), cardId, memory }  memory = { stability, stabilityFast, difficulty } or null for a new card
//   cfg   { w (34 weights), retention, learningSteps: ['1m','10m'], relearningSteps: ['10m'], maxInterval (days), fuzz }
// Returns outcome(rating) → { memory, state, learningStep, scheduledDays (fractional), due (ms), reps, lapses } for any of the four ratings.
export function plan7(card, cfg, now) {
  const { w, retention, maxInterval } = cfg;
  const isNew = !card.state || card.memory == null;
  const elapsed = isNew || !card.lastReview ? 0 : Math.max(0, (now - card.lastReview) / DAY);
  const r = isNew ? undefined : forgettingCurve7(w, card.memory, elapsed);
  const memoryAfter = g => nextState7(w, isNew ? null : card.memory, elapsed, g, r);
  const reps = card.reps ?? 0;
  const seed = `${card.cardId}${reps + 1}`;
  const modelInterval = mem => {
    const raw = nextInterval7(w, mem, retention);
    if (!cfg.fuzz || raw < 2.5) return raw;
    const { min, max } = fuzzRange(raw, elapsed, maxInterval);
    return Math.floor(mulberry32(fnv1a32(seed))() * (max - min + 1) + min);
  };

  const state = isNew ? NEW : card.state;
  const steps = stepsFor(cfg, state, card.learningStep ?? 0);
  const stepDays = {};
  for (const g of [1, 2, 3, 4]) if (steps[g]) { const m = Math.round(Math.max(0, steps[g].minutes) * 60) / 60; if (m > 0) stepDays[g] = m / 1440; }
  const hasSteps = (state === RELEARNING || state === REVIEW ? cfg.relearningSteps : cfg.learningSteps).length > 0;
  const overrides = {};
  // A grade's interval with the learning steps applied (the model may override them: allowModelOverride is on for FSRS-7).
  const withSteps = (g, mem) => {
    const step = stepDays[g];
    let interval;
    if (g === 1) interval = step === undefined ? modelInterval(mem) : Math.max(step, Math.min(modelInterval(mem), GRADUATING_DAYS));
    else if (step === undefined) interval = hasSteps ? Math.max(modelInterval(mem), GRADUATING_DAYS) : modelInterval(mem);
    else interval = Math.max(step, modelInterval(mem));
    overrides[g] = step !== undefined && interval !== step;
    return interval;
  };

  return function outcome(g) {
    const memory = memoryAfter(g);
    let days = withSteps(g, memory);
    // keep the four buttons in order
    const lower = [];
    for (let k = 1; k < g; k++) lower.push(withSteps(k, memoryAfter(k)));
    days = scheduleDay([...lower, days], maxInterval);
    days = Math.min(days, maxInterval);
    if (stepDays[g] !== undefined && !overrides[g]) days = stepDays[g];
    let newState = REVIEW, learningStep = 0;
    if ((g === 1 && overrides[g] === true) || days < GRADUATING_DAYS) {
      newState = state === NEW ? LEARNING : state === REVIEW ? RELEARNING : state;
      if (stepDays[g] !== undefined) learningStep = Math.max(0, steps[g].next);
    }
    days = Math.max(0, days);
    return {
      memory, state: newState, learningStep, scheduledDays: days, due: now + days * DAY,
      reps: reps + 1, lapses: (card.lapses ?? 0) + (g === 1 && state === REVIEW ? 1 : 0)
    };
  };
}
