// Spaced repetition with FSRS-6, using the ts-fsrs library (pinned to 5.4.2).
//
// FSRS keeps two numbers for every card:
//   stability   roughly how many days until you'd have a 90% chance of still remembering it
//   difficulty  how hard this card is for you (1 to 10)
// Each rating updates them, and the card is scheduled for the day your chance of remembering
// it drops to your target retention (90% by default).

import { fsrs, generatorParameters, createEmptyCard, Rating, default_w, CLAMP_PARAMETERS, W17_W18_Ceiling, clipParameters } from 'https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs';
import { pickDay } from './balance.js';
import { dayKey } from './stats-calc.js';
import { examGainFrom, examClamp } from './exam.js';
import { W7_DEFAULT } from './fsrs7-model.js';
import { rate7, preview7, prepare7 } from './srs7.js';     // FSRS-7 (setting fsrsVersion 7): our own port, no library to load; see srs7.js

// With FSRS-7 on, cards must have their FSRS-7 memory ready before they are rated or previewed (rebuilt from the review log, asynchronous).
export { prepare7 };

export { Rating };
// What the optimizer needs from the library (js/optimize-sheet.js): the standard weights, their allowed ranges, and the per-deck clipping.
export { default_w, CLAMP_PARAMETERS, W17_W18_Ceiling, clipParameters };

// The four buttons, in order. key = keyboard shortcut.
export const RATINGS = [
  { rating: Rating.Again, label: 'Again', key: '1' },
  { rating: Rating.Hard, label: 'Hard', key: '2' },
  { rating: Rating.Good, label: 'Good', key: '3' },
  { rating: Rating.Easy, label: 'Easy', key: '4' }
];

// The scheduler for a set of options (from schedulerOptions() in sched-settings.js):
//   retention        target chance of remembering a card when it comes back (0.9 = 90%)
//   learningSteps    e.g. ['1m', '10m']: short gaps for new cards
//   relearningSteps  e.g. ['10m']: short gaps after forgetting
//   maxInterval      longest gap in days
//   fuzz             spread long gaps a little so cards added together don't all come due together
//   w                optional: your own 21 FSRS weights (the standard ones when missing)
// Rebuilt only when the options change.
let cached = null;
function scheduler(opts) {
  const { maxDue, balance, fsrsVersion, w7, ...lib } = opts;      // maxDue, balance and the FSRS-7 settings are applied here, not by the library
  const key = JSON.stringify(lib);
  if (!cached || cached.key !== key) {
    cached = {
      key,
      f: fsrs(generatorParameters({
        request_retention: lib.retention,
        learning_steps: lib.learningSteps,
        relearning_steps: lib.relearningSteps,
        maximum_interval: lib.maxInterval,
        enable_fuzz: lib.fuzz,
        enable_short_term: true,
        w: lib.w                       // undefined = the library's default weights
      }))
    };
  }
  return cached.f;
}

const DAY = 86400000;
// The library keeps Easy at least a day longer than Good (and Good longer than Hard), which can push
// a gap a day or two past the maximum. Pull it back so the maximum is a real limit.
function capInterval(card, now, maxDays) {
  if (card.scheduled_days > maxDays) {
    card.scheduled_days = maxDays;
    card.due = new Date(now + maxDays * DAY);
  }
  return card;
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
    lastReview: c.last_review ? c.last_review.getTime() : null,
    ...(c.fsrs7 ? { fsrs7: c.fsrs7 } : {})        // the FSRS-7 memory, when FSRS-7 scheduled this review (srs7.js); FSRS-6 reviews leave it out
  };
}

// FSRS-7 on: the FSRS-6 memory after a rating, so the FSRS-6 fields stay current and switching back to FSRS-6 is lossless.
const sixAfter = (state, opts, now) => rating => {
  try {
    const c = scheduler({ ...opts, fuzz: false, fsrsVersion: undefined }).next(toLibrary(state, now), new Date(now), rating).card;
    return { stability: c.stability, difficulty: c.difficulty };
  } catch (err) { console.error(err); return null; }
};

// How long until the card comes back for each button: { 1: ms, 2: ms, 3: ms, 4: ms }.
// (With fuzz on, the real interval can differ by a day or so on long gaps.)
export function previewIntervals(state, opts, now = Date.now()) {
  const preview = opts.fsrsVersion === 7 ? seven(state, opts, now) : scheduler(opts).repeat(toLibrary(state, now), new Date(now));
  const out = {};
  for (const { rating } of RATINGS) out[rating] = examClamp(capInterval(preview[rating].card, now, opts.maxInterval), now, opts, opts.balance?.load).due.getTime() - now;
  return out;
}

// The four outcomes from FSRS-7, in the shape the library's repeat() gives: { 1: { card }, ... }
function seven(state, opts, now) {
  const cards = preview7(state?.cardId, state, opts, now);
  return Object.fromEntries(Object.entries(cards).map(([g, card]) => [g, { card }]));
}

// Apply a rating and return the card's new saved state.
//   opts.balance (optional): { load, easyDays } to even out reviews instead of random fuzz (balance.js).
export function rate(cardId, state, rating, opts, now = Date.now()) {
  const balanced = !!(opts.balance && opts.fuzz);
  // Evening out needs the exact gap first (no random fuzz); it then picks a day within the fuzz range.
  const { card } = opts.fsrsVersion === 7
    ? { card: rate7(cardId, state, rating, balanced ? { ...opts, fuzz: false } : opts, now, sixAfter(state, opts, now)) }
    : scheduler(balanced ? { ...opts, fuzz: false } : opts).next(toLibrary(state, now), new Date(now), rating);
  capInterval(card, now, opts.maxInterval);
  const load = opts.balance?.load;
  let counted = false;                          // did balancing add this card to the load?
  if (balanced && card.state === 2 && card.scheduled_days >= 3) {
    const d = pickDay(card.scheduled_days, { ...opts.balance, maxDays: opts.maxInterval, now });
    card.due = new Date(card.due.getTime() + (d - card.scheduled_days) * DAY);
    card.scheduled_days = d;
    load?.set(dayKey(card.due.getTime()), (load.get(dayKey(card.due.getTime())) || 0) + 1);
    counted = true;
  }
  // The exam can move the card to another day: take it off the day balancing chose, and put it on the new one.
  const chosen = card.due.getTime();
  examClamp(card, now, opts, load);
  if (load && card.due.getTime() !== chosen) {
    const was = dayKey(chosen);
    if (counted && load.get(was) > 0) load.set(was, load.get(was) - 1);
    load.set(dayKey(card.due.getTime()), (load.get(dayKey(card.due.getTime())) || 0) + 1);
  }
  return fromLibrary(cardId, card);
}

// How much a review now would add to the chance of remembering the card on exam day (see examGainFrom in exam.js).
// opts: the card's scheduler options. Used to put the cards that gain most first.
export function examGain(state, examStart, now, opts) {
  if (opts.fsrsVersion === 7) {          // FSRS-7: the memory after a Good and after an Again (two traces, so not a single stability)
    const p = preview7(state?.cardId, state, opts, now);
    return examGainFrom(state, p[Rating.Good].fsrs7, p[Rating.Again].fsrs7, examStart, now, { w20: opts.w?.[20], w7: opts.w7 ?? W7_DEFAULT });
  }
  const preview = scheduler(opts).repeat(toLibrary(state, now), new Date(now));
  return examGainFrom(state, preview[Rating.Good].card.stability, preview[Rating.Again].card.stability, examStart, now, opts.w?.[20]);
}
