// Postpone: push back the reviews due today (or overdue) that you will still remember best, for a busy few days.
// Pure functions (no page, no database), tested by tests/postpone.test.js.
//
// Nothing is logged and no new fields are saved: only a card's `due` and `scheduledDays` change (so the review
// history, and the data a personal FSRS fit learns from, stay clean).
//   Moved:      cards in the Review state, due by the end of today (or overdue), not suspended or buried.
//   Never:      learning and new cards, cards in a deck with an exam coming up (see `skip`), and cards an exam's final pass
//               has brought forward.
//   Order:      the cards that lose the least memory first (the most stable ones); cards that would drop under 80% last.

import { dayEnd } from './days.js';
import { isHidden } from './browse-logic.js';

const REVIEW = 2;
const DAY = 86400000;
export const KEEP_R = 0.8;            // the default count keeps every card that stays at 80% or better

// The cards that can be postponed by `days`, each as { card, state, before, after, damage }, best first.
//   days      how far to push them back (1, 2, 3 or 7)
//   recallAt  (state, when) → the chance of remembering at that time (exam.js recallAt; passed in so a change to the
//             forgetting curve applies here too)
//   skip      (card, state) → true for a card to leave alone (an exam coming up, or brought forward by one)
// before is the recall at the end of today (when the card would be reviewed), after at the end of the day it moves to.
export function postponeCandidates(cards, statesById, { days = 1, now = Date.now(), recallAt, skip = () => false } = {}) {
  const today = dayEnd(now), then = dayEnd(now, days);
  const out = [];
  for (const card of cards) {
    const state = statesById.get(card.id);
    if (!state || state.state !== REVIEW || !(state.due <= today) || isHidden(card, now) || skip(card, state)) continue;
    const before = recallAt(state, today), after = recallAt(state, then);
    out.push({ card, state, before, after, damage: before - after });
  }
  const tier = x => (x.after >= KEEP_R ? 0 : 1);
  return out.sort((a, b) => tier(a) - tier(b) || a.damage - b.damage || b.after - a.after);
}

// When a card postponed by `days` is next due: 6am on that day (2h past the rollover, like exam.js), so it is not due until then.
export const postponeDue = (days, now = Date.now()) => dayEnd(now, days - 1) + 2 * 3600000;

// How many to postpone by default: every candidate that stays at 80% or better after the delay.
export const defaultCount = list => list.filter(x => x.after >= KEEP_R).length;

// The new schedules for the first `count` of the list: due at 6am (2 hours past the 4am rollover, as exam.js puts its cards) of the day `days` ahead. Exactly 4am would still count as the day before (splitCards counts due <= dayEnd as today). With
// scheduledDays worked out again (the same sum Review ahead's pull-in uses).
export function postponeStates(list, days, now = Date.now()) {
  const due = postponeDue(days, now);
  return list.map(({ state }) => ({ ...state, due, scheduledDays: Math.max(1, Math.round((due - (state.lastReview || now)) / DAY)) }));
}

// "93%" for 0.93
export const pct = r => `${Math.round(r * 100)}%`;
// Average recall of the first `count` of the list, before and after: { before, after } (0 to 1), or null for none.
export function averages(list, count) {
  const part = list.slice(0, count);
  if (!part.length) return null;
  const avg = key => part.reduce((t, x) => t + x[key], 0) / part.length;
  return { before: avg('before'), after: avg('after') };
}
