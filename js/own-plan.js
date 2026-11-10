// Own model: the rules for using Own's planned gaps inside the scheduler. Pure functions; no DOM, no storage, no network.
// srs.js applies them in rate(); they are kept here so they can be tested on their own.

export const OWN_BAND_LOW = 0.25;        // Own's gap is never shorter than this times FSRS's gap
export const OWN_BAND_HIGH = 4;          // ... and never longer than this times FSRS's gap
export const OWN_MAX_DAYS = 3650;        // ... and never longer than 10 years
export const PLAN_MAX_AGE_MS = 3600000;  // a plan older than an hour is not used
export const PLAN_MS = 300;              // how long the buttons wait for a plan (review.js); after that FSRS schedules the card

// Is this plan usable for this very answer? plan: { cardId, lastReview, at, days: { 2, 3, 4 } }
//   state: the card's saved state before the answer; next: the state FSRS has just worked out (state numbers: 2 = Review)
export function planFits(plan, cardId, state, nextState, rating, now) {
  return !!plan && plan.cardId === cardId && plan.lastReview === (state?.lastReview ?? null)
    && Math.abs(now - plan.at) < PLAN_MAX_AGE_MS
    && state?.state === 2 && nextState === 2
    && [2, 3, 4].includes(rating) && [2, 3, 4].every(r => Number.isFinite(plan.days?.[r]) && plan.days[r] > 0);
}

// Own's days, held between 0.25x and 4x of FSRS's days, and at most 3,650 days (or maxInterval when that is lower).
// Returns a whole number of days, at least 1.
export function clampOwnDays(ownDays, fsrsDays, maxInterval) {
  const cap = Math.min(OWN_MAX_DAYS, Number.isFinite(maxInterval) && maxInterval > 0 ? maxInterval : OWN_MAX_DAYS);
  const hi = Math.min(cap, OWN_BAND_HIGH * fsrsDays);
  const lo = Math.min(hi, OWN_BAND_LOW * fsrsDays);
  const d = Math.max(lo, Math.min(hi, ownDays));
  return Math.max(1, Math.round(d));
}

// The three clamped day counts { 2: Hard, 3: Good, 4: Easy } put in order like FSRS: Hard < Good < Easy. A gap that is not above the one before
// is bumped up by 1 day; if that would pass the cap (3,650 or maxInterval), the earlier ones are lowered instead, never below 1.
// (With a cap under 3 days there is no room for three different gaps, so ties remain.)
export function orderOwnDays(days, maxInterval) {
  const cap = Math.floor(Math.min(OWN_MAX_DAYS, Number.isFinite(maxInterval) && maxInterval > 0 ? maxInterval : OWN_MAX_DAYS));
  const good = Math.max(days[3], days[2] + 1);
  const easy = Math.min(cap, Math.max(days[4], good + 1));
  const g = Math.min(good, easy - 1);
  return { 2: Math.max(1, Math.min(days[2], g - 1)), 3: Math.max(1, g), 4: Math.max(1, easy) };
}

// Waits for a plan, but at most `ms` (300 ms). `prep` is the promise from the plan request; `settled` is what the caller does with the
// outcome (it counts a missing plan as a failed plan, and passes back the plan to use, or null). Never rejects: an error is a missing plan.
// -> a promise of the frozen plan, or null (FSRS schedules the card)
export function freezePlan(prep, settled, ms = PLAN_MS) {
  let timer;
  const late = new Promise(r => { timer = setTimeout(() => r(null), ms); });
  return Promise.race([Promise.resolve(prep).catch(() => null), late])
    .finally(() => clearTimeout(timer))
    .then(plan => { try { return settled(plan) || null; } catch { return null; } });
}
