// Evening out the reviews, and easy days. Pure functions, tested by tests/balance.test.js.
//
// When a card's next gap is a few days or more, FSRS allows a small range around it ("Spread out due
// dates" in Settings): e.g. 10 days could be 9–11. Instead of picking at random within that range, the app
// picks the day with the fewest reviews already due, so busy days don't pile up. Easy days make chosen
// weekdays count as busier: Reduced days get about half the reviews, Minimum days as few as possible.
// The card's real gap never moves outside the range FSRS allows, so memory isn't affected.

import { dayStart } from './days.js';
import { dayKey } from './stats-calc.js';

const DAY = 86400000;
export const EASY_DAY_WEIGHT = { normal: 1, reduced: 0.5, minimum: 0.05 };
export const NORMAL_WEEK = ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal'];   // Sunday first

// The days FSRS allows around a gap (the same ranges as its own fuzz). Returns [shortest, longest] in days.
const FUZZ_RANGES = [{ start: 2.5, end: 7, factor: 0.15 }, { start: 7, end: 20, factor: 0.1 }, { start: 20, end: Infinity, factor: 0.05 }];
export function fuzzRange(days, maxDays = 36500) {
  let delta = 1;
  for (const r of FUZZ_RANGES) delta += r.factor * Math.max(Math.min(days, r.end) - r.start, 0);
  const hi = Math.min(Math.round(days + delta), maxDays);
  const lo = Math.min(Math.max(2, Math.round(days - delta)), hi);
  return [lo, hi];
}

// How many graduated cards are due on each study day: Map 'YYYY-MM-DD' → count.
export function loadByDay(states) {
  const load = new Map();
  for (const s of states) if (s && s.state === 2) { const k = dayKey(s.due); load.set(k, (load.get(k) || 0) + 1); }
  return load;
}

// The gap (in days) to use instead of `days`: the least busy day in the allowed range, where busy means
// (reviews already due + 1) ÷ the weekday's easy-day weight. A little randomness breaks ties.
//   load  Map from loadByDay()   easyDays  7 entries, Sunday first   now  ms
export function pickDay(days, { load = new Map(), easyDays = NORMAL_WEEK, maxDays = 36500, now = Date.now(), random = Math.random } = {}) {
  if (days < 2.5) return days;
  const [lo, hi] = fuzzRange(days, maxDays);
  let best = days, bestScore = Infinity;
  for (let d = lo; d <= hi; d++) {
    const t = now + d * DAY;
    const weight = EASY_DAY_WEIGHT[easyDays[new Date(dayStart(t)).getDay()]] ?? 1;
    const score = ((load.get(dayKey(t)) || 0) + 1) / weight * (1 + random() * 0.1);
    if (score < bestScore) { bestScore = score; best = d; }
  }
  return best;
}
