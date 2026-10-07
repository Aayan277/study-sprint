// Auto-grading: turning Play answers into review ratings, so games feed the spaced-repetition
// schedule without rating every card by hand. Pure functions, tested by tests/autograde.test.js.
//
// The rules (from PLAN.md):
//
//   Result                                      Typing   Multiple choice
//   Wrong or timed out                          Again    Again
//   Correct, slow (more than 70% of time used)  Hard     Hard
//   Correct, normal                             Good     Good
//   Correct, fast (less than 30% of time used)  Easy     Good  (recognising is easier than recalling)
//
// Rules so playing doesn't break the schedule:
//   - A card that is due (today or overdue) gets the rating applied normally.
//   - A card that isn't due yet only changes if the answer was wrong (Again).
//   - At most one schedule change per card per day from Play.
//   - New cards (never studied in Review) aren't scheduled from Play. They start in Review,
//     so Play can't sneak extra new cards past your daily limit.

import { dayEnd } from './days.js';
import { TYPING_TIME } from './game.js';

export const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;   // same numbers as ts-fsrs's Rating
const NEW = 0;

// Lightning has no per-question timer, so speed is measured against this many seconds instead.
export const LIGHTNING_REF_MS = 6000;

// The rating a Play answer earns.
//   ok      was it right?
//   ms      how long the answer took
//   limitMs the time allowed (Infinity in Lightning)
//   typing  typed answer (true) or multiple choice (false)
export function autoRating({ ok, ms, limitMs, typing }) {
  if (!ok) return AGAIN;
  const allowed = Number.isFinite(limitMs) ? limitMs : LIGHTNING_REF_MS * (typing ? TYPING_TIME : 1);
  const used = ms / allowed;
  if (used > 0.7) return HARD;
  if (used < 0.3) return typing ? EASY : GOOD;
  return GOOD;
}

// Should this answer change the card's schedule? Returns why or why not:
//   'due'      due today or overdue: apply the rating
//   'again'    not due yet, but answered wrong: apply Again
//   'not-due'  not due yet and answered right: log only
//   'new'      never studied in Review: log only
//   'already'  Play already changed this card today: log only
export function scheduleDecision({ state, rating, alreadyToday, now = Date.now() }) {
  if (!state || state.state === NEW) return 'new';
  if (alreadyToday) return 'already';
  if (state.due <= dayEnd(now)) return 'due';
  return rating === AGAIN ? 'again' : 'not-due';
}

export const applies = decision => decision === 'due' || decision === 'again';
