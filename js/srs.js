// Spaced repetition with FSRS-6, using the ts-fsrs library (pinned to 5.4.2).
//
// FSRS keeps two numbers for every card:
//   stability   roughly how many days until you'd have a 90% chance of still remembering it
//   difficulty  how hard this card is for you (1 to 10)
// Each rating updates them, and the card is scheduled for the day your chance of remembering
// it drops to your target retention (90% by default).

import { fsrs, generatorParameters, createEmptyCard, Rating, default_w, CLAMP_PARAMETERS, W17_W18_Ceiling, clipParameters } from 'https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs';
import { pickDay } from './balance.js';
import { dayStart, dayEnd } from './days.js';
import { dayKey } from './stats-calc.js';
import { examGainFrom, examClamp, recallAt, finalWindow } from './exam.js';
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
// Rebuilt only when the options change. Two are kept (the newest two sets of options), because one rating can use two
// (evening out the reviews runs without fuzz; FSRS-7 mode also steps the FSRS-6 memory without it) and they must not push each other out.
const cached = new Map();
function scheduler(opts) {
  const { maxDue, balance, fsrsVersion, w7, ownPlan, ...lib } = opts;      // maxDue, balance, the FSRS-7 settings and Own's plan are applied here, not by the library (and are never part of the cache key)
  const key = JSON.stringify(lib);
  let f = cached.get(key);
  if (f) { cached.delete(key); cached.set(key, f); return f; }        // (most recently used last)
  f = fsrs(generatorParameters({
    request_retention: lib.retention,
    learning_steps: lib.learningSteps,
    relearning_steps: lib.relearningSteps,
    maximum_interval: lib.maxInterval,
    enable_fuzz: lib.fuzz,
    enable_short_term: true,
    w: lib.w                       // undefined = the library's default weights
  }));
  cached.set(key, f);
  if (cached.size > 2) cached.delete(cached.keys().next().value);
  return f;
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

// A repeatable "random" for the day balancing picks (pickDay breaks ties with it). The same card, state and button always give
// the same numbers, so the label on a button and the day rate() really picks can't disagree, and labels don't change on a redraw.
function seededRandom(cardId, state, rating) {
  let h = 2166136261;
  for (const ch of `${cardId}|${state?.lastReview ?? ''}|${state?.reps ?? 0}|${state?.stability ?? ''}|${rating}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// How long until the card comes back for each button: { 1: ms, 2: ms, 3: ms, 4: ms }.
// It runs rate() itself (on a copy of the busy-days map, so nothing is counted), so the label is the gap the card really gets.
export function previewIntervals(state, opts, now = Date.now(), cardId = state?.cardId ?? '') {
  const out = {};
  for (const { rating } of RATINGS) {
    const load = opts.balance?.load;
    // With balancing, rate() picks the day (seeded, on a copy of the load). Without it, FSRS-6 fuzz is random, so it is turned off for the
    // label (the exact gap); FSRS-7's fuzz is deterministic, so it is left on and the label is the gap rate() really gives.
    const o = opts.balance ? { ...opts, balance: { ...opts.balance, load: load && new Map(load) } } : opts.fsrsVersion === 7 ? opts : { ...opts, fuzz: false };
    out[rating] = rate(cardId, state, rating, o, now).due - now;
  }
  return out;
}

// The four outcomes from FSRS-7, in the shape the library's repeat() gives: { 1: { card }, ... }
function seven(cardId, state, opts, now) {
  const cards = preview7(cardId, state, opts, now);
  return Object.fromEntries(Object.entries(cards).map(([g, card]) => [g, { card }]));
}

// Own model (opt-in): the rules for using its plan (js/own-plan.js) are handed over by Review when an Own session starts, so nobody who has
// not loaded a model file loads that file. Until then a plan is ignored (FSRS schedules). tools: { planFits, clampOwnDays, orderOwnDays }
let ownTools = null;
export const useOwnPlan = tools => { ownTools = tools; };

// Apply a rating and return the card's new saved state.
//   opts.balance (optional): { load, easyDays } to even out reviews instead of random fuzz (balance.js).
export function rate(cardId, state, rating, opts, now = Date.now()) {
  const balanced = !!(opts.balance && opts.fuzz);
  // Evening out needs the exact gap first (no random fuzz); it then picks a day within the fuzz range.
  const { card } = opts.fsrsVersion === 7
    ? { card: rate7(cardId, state, rating, balanced ? { ...opts, fuzz: false } : opts, now, sixAfter(state, opts, now)) }
    : scheduler(balanced ? { ...opts, fuzz: false } : opts).next(toLibrary(state, now), new Date(now), rating);
  // Own model (opt-in, js/own-shadow.js): a plan made for this very card and answer moment sets the gap after Hard, Good and Easy on a card
  // that was already in review. FSRS has just run, so the memory numbers, steps, reps and lapses stay FSRS's; Again and learning steps are
  // untouched. Own's gap is held between 0.25x and 4x of FSRS's gap and at most 3,650 days (own-plan.js). With fuzz on, FSRS's own fuzz
  // (the ratio of its fuzzed gap to its exact gap) is applied to Own's days too. The max interval, evening out and the exam limit still
  // apply below. Without a plan (the normal case) nothing here changes.
  const plan = opts.ownPlan;
  let planned = false;                          // Own's plan set the gap (evening out was already done for it)
  if (plan && ownTools && ownTools.planFits(plan, cardId, state, card.state, rating, now) && Number.isFinite(opts.maxInterval) && opts.maxInterval > 0) {
    const { clampOwnDays, orderOwnDays } = ownTools;
    // The final gap (clamped, then fuzzed or evened out) is worked out for Hard, Good and Easy the same way every time, and only then are the
    // three put in order (Hard < Good < Easy). So every rating works out the same three numbers: the buttons and the saved date agree.
    // Evening out only reads the load here (the card is added to it below, once, for the rating that was pressed).
    const fsrsCard = (r, o) => r === rating && o === opts ? card : opts.fsrsVersion === 7
      ? rate7(cardId, state, r, o, now, sixAfter(state, opts, now))
      : scheduler(o).next(toLibrary(state, now), new Date(now), r).card;
    const finalDays = {}, exactCards = {};
    // The exam limit (examClamp, which only reads the load) applied to a gap of d days, on a copy of the rating's own card.
    const examDay = (r, d) => examClamp({ ...exactCards[r], due: new Date(now + d * DAY), scheduled_days: d }, now, opts, opts.balance?.load).scheduled_days;
    let moved = false;                            // did the exam limit move any of the three?
    for (const r of [2, 3, 4]) {
      exactCards[r] = fsrsCard(r, { ...opts, fuzz: false });
      const exact = exactCards[r].scheduled_days;
      let d = clampOwnDays(plan.days[r], exact, opts.maxInterval);
      if (opts.fuzz && !balanced && exact > 0) d = clampOwnDays(d * (fsrsCard(r, opts).scheduled_days / exact), exact, opts.maxInterval);
      if (balanced && d >= 3) d = pickDay(d, { ...opts.balance, maxDays: opts.maxInterval, now, random: seededRandom(cardId, state, r) });
      const e = examDay(r, d);
      if (e !== d) { moved = true; d = e; }
      finalDays[r] = d;
    }
    // When the exam applies, all three are deliberately kept inside its window (before exam day); ties remain only if the window is too small.
    const win = opts.maxDue > now ? finalWindow(Math.round((opts.maxDue - dayStart(now)) / DAY), 1) : null;
    const order = () => orderOwnDays(finalDays, moved && win ? Math.min(opts.maxInterval, win.last) : opts.maxInterval);
    let ordered = order();
    // Ordering can bump a gap into a day the exam would move: then cap all three to the window, so the examClamp below is a no-op here.
    if (win && !moved && [2, 3, 4].some(r => examDay(r, ordered[r]) !== ordered[r])) { moved = true; ordered = order(); }
    const days = ordered[rating];
    // Two due-time rules: a gap the exam placed is due at 6am that day (as examClamp does); any other gap is due the same time of day.
    if (moved && win && days >= win.first && days <= win.last) { card.due = new Date(dayEnd(now, days - 1) + 2 * 3600000); card.scheduled_days = days; }
    else { card.scheduled_days = days; card.due = new Date(now + days * DAY); }
    planned = true;
  }
  capInterval(card, now, opts.maxInterval);
  const load = opts.balance?.load;
  let counted = false;                          // did balancing add this card to the load?
  if (balanced && card.state === 2 && card.scheduled_days >= 3) {
    const d = planned ? card.scheduled_days : pickDay(card.scheduled_days, { ...opts.balance, maxDays: opts.maxInterval, now, random: seededRandom(cardId, state, rating) });
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

// The chance of remembering the card right now, by the FSRS that schedules it (FSRS-6, or FSRS-7 when that is on), with the owner's own
// weights. null when there is no usable number. Used only by Own's shadow records (js/own-shadow.js). opts: the card's scheduler options.
export function recallNow(state, opts, now = Date.now()) {
  if (!state || !(state.stability > 0)) return null;
  const model = opts?.fsrsVersion === 7 ? { w20: opts.w?.[20], w7: opts.w7 ?? W7_DEFAULT } : opts?.w?.[20];
  const p = recallAt(state, now, model);
  return Number.isFinite(p) && p > 0 && p <= 1 ? p : null;
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
