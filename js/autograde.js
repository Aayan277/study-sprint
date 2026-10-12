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
//   - A card that isn't due yet only changes if the answer was wrong (Again): that brings it back. But the miss
//     doesn't count toward the leech limit (see isNewLeechCounted in browse-logic.js): a wrong tap in a quick game
//     says little about whether you've forgotten the card.
//   - A Survival question that ran out of time with less than 3 seconds on the clock is only logged. Survival's
//     timer shrinks to 2 seconds, which is too short to say much about your memory.
//   - At most one schedule change per card per day from Play.
//   - New cards (never studied) aren't scheduled from Play, so Play can't sneak extra new cards past your
//     daily limit... except in a deck with an exam coming up (its own, or the deck it's inside). There an
//     answer on a new card counts as its first review: its rating as above (a miss is Again), as long as
//     the deck's new-cards-per-day limit (overall, per deck and parent decks) has room. Over the limit, or
//     in decks without an exam, the new card is only logged and starts in Review.

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
//   'first'    a new card in a deck with an exam: this answer is its first review, apply the rating
//   'new'      never studied, and not in a deck with an exam: log only
//   'new-limit' new card in a deck with an exam, but today's new-card limit is used up: log only
//   'already'  Play already changed this card today: log only
//   'short-time'  Survival ran out of time with under 3 seconds allowed: log only
//   examDeck   does the card's deck (or one it's inside) have an exam coming up?
//   newRoom    is there room left in today's new-card limits?
//   timedOut   did the question run out of time? limitMs, fmt: the time allowed (ms) and the format ('survival', …)
export const SHORT_TIMER_MS = 3000;
export function scheduleDecision({ state, rating, alreadyToday, now = Date.now(), examDeck = false, newRoom = true, timedOut = false, limitMs = Infinity, fmt = '' }) {
  if (timedOut && fmt === 'survival' && limitMs < SHORT_TIMER_MS) return 'short-time';
  if (!state || state.state === NEW) {
    if (!examDeck) return 'new';
    if (alreadyToday) return 'already';
    return newRoom ? 'first' : 'new-limit';
  }
  if (alreadyToday) return 'already';
  if (state.due <= dayEnd(now)) return 'due';
  return rating === AGAIN ? 'again' : 'not-due';
}

export const applies = decision => decision === 'due' || decision === 'again' || decision === 'first';
