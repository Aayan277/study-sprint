// Spaced repetition with FSRS-6, using the ts-fsrs library (pinned to 5.4.2).
//
// FSRS keeps two numbers for every card:
//   stability   roughly how many days until you'd have a 90% chance of still remembering it
//   difficulty  how hard this card is for you (1 to 10)
// Each rating updates them, and the card is scheduled for the day your chance of remembering
// it drops to your target retention (90% by default).

import { fsrs, generatorParameters, createEmptyCard, Rating } from 'https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs';

export { Rating };

// The four buttons, in order. key = keyboard shortcut.
export const RATINGS = [
  { rating: Rating.Again, label: 'Again', key: '1' },
  { rating: Rating.Hard, label: 'Hard', key: '2' },
  { rating: Rating.Good, label: 'Good', key: '3' },
  { rating: Rating.Easy, label: 'Easy', key: '4' }
];

// One scheduler per target retention. enable_fuzz adds a little randomness to long intervals so
// cards added together don't all come due on the same day.
let cached = null;
function scheduler(retention) {
  if (!cached || cached.retention !== retention) {
    cached = { retention, f: fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true, enable_short_term: true })) };
  }
  return cached.f;
}

// Our saved state ↔ the library's card object. We save dates as numbers so the database can sort by them.
function toLibrary(state, now) {
  if (!state) return createEmptyCard(new Date(now));
  return {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsedDays ?? 0,
    scheduled_days: state.scheduledDays ?? 0,
    learning_steps: state.learningSteps ?? 0,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    last_review: state.lastReview ? new Date(state.lastReview) : undefined
  };
}
function fromLibrary(cardId, c) {
  return {
    cardId,
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.last_review ? c.last_review.getTime() : null
  };
}

// How long until the card comes back for each button: { 1: ms, 2: ms, 3: ms, 4: ms }.
// (With fuzz on, the real interval can differ by a day or so on long gaps.)
export function previewIntervals(state, retention, now = Date.now()) {
  const preview = scheduler(retention).repeat(toLibrary(state, now), new Date(now));
  const out = {};
  for (const { rating } of RATINGS) out[rating] = preview[rating].card.due.getTime() - now;
  return out;
}

// Apply a rating and return the card's new saved state.
export function rate(cardId, state, rating, retention, now = Date.now()) {
  const { card } = scheduler(retention).next(toLibrary(state, now), new Date(now), rating);
  return fromLibrary(cardId, card);
}
