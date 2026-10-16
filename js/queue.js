// Building the day's review queue, and other scheduling helpers that don't need the FSRS library.
// Pure functions, tested by tests/queue.test.js.

import { dayStart, dayEnd } from './days.js';

// FSRS card states (same numbers as the ts-fsrs library).
export const NEW = 0, LEARNING = 1, REVIEW = 2, RELEARNING = 3;
const isLearning = s => s === LEARNING || s === RELEARNING;

// A learning card due within this long is shown now rather than making you wait (Anki does the same).
export const LEARN_AHEAD = 20 * 60 * 1000;

// How many different new cards were studied for the first time today (counts toward the daily limit).
export function newStudiedToday(logs, now = Date.now()) {
  const start = dayStart(now);
  return new Set(logs.filter(l => l.timestamp >= start && l.state === NEW).map(l => l.cardId)).size;
}

// Work out today's cards.
//   cards      the cards in the chosen decks, in the order new cards should appear
//   statesById Map of cardId → saved FSRS state
//   newLimit   how many new cards are still allowed today: a number, or { total, byDeck } from newLimits()
// Returns { queue, waiting, newAvailable }:
//   queue    cards to show now: [{ card, kind: 'review' | 'learn' | 'new' }]
//   waiting  learning cards due later today, shown when their time comes: [{ card, kind, due }]
//   newAvailable  how many new cards exist in total (before the daily limit)
//   reviewLimit  optional: how many reviews (of graduated cards) are still allowed today, a number or
//                { total, byDeck } from reviewLimits(). Learning cards are never held back.
//   exam      optional, from examSchedule() in exam.js: the exam's final pass (see splitCards)
//   answered  optional: the cards of each cloze note answered today, from answeredNotes() (see limitSiblings)
//   rescue    optional: today's catch-up plan, from rescueToday() (see queueFrom)
export function buildQueue(cards, statesById, newLimit, now = Date.now(), reviewLimit = Infinity, exam = null, answered = undefined, rescue = null) {
  return queueFrom(splitCards(cards, statesById, now, exam), newLimit, reviewLimit, answered, rescue);
}

// Step 1 of buildQueue: sort the cards into reviews (due now), waiting (learning, due later today) and fresh (new).
// Kept apart so Today can do this once and then count any set of decks from the short lists.
// exam (optional) is the exam's final pass: { caps, gain } from examSchedule() in exam.js.
//   caps  a card planned for a review before its exam counts as due on that day, whatever its saved due date
//   gain  reviews for an exam come first, the ones that add most to the chance of remembering on exam day first
export function splitCards(cards, statesById, now = Date.now(), exam = null) {
  const end = dayEnd(now);
  const reviews = [], waiting = [], fresh = [];
  for (const card of cards) {
    const st = statesById.get(card.id);
    if (!st || st.state === NEW) { fresh.push(card); continue; }
    if (isLearning(st.state)) {
      if (st.due <= now + LEARN_AHEAD) reviews.push({ card, kind: 'learn', due: st.due });
      else if (st.due <= end) waiting.push({ card, kind: 'learn', due: st.due });
    } else {
      const due = Math.min(st.due, exam?.caps.get(card.id) ?? Infinity);
      if (due <= end) reviews.push({ card, kind: 'review', due });
    }
  }
  const gain = exam?.gain;
  if (gain?.size) {
    // Learning cards first (they're on a timer), then reviews for an exam by what a review adds, then the rest.
    const rank = x => (x.kind === 'learn' ? 0 : gain.has(x.card.id) ? 1 : 2);
    reviews.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? gain.get(b.card.id) - gain.get(a.card.id) : 0) || a.due - b.due);
  } else {
    reviews.sort((a, b) => a.due - b.due);          // most overdue first
  }
  waiting.sort((a, b) => a.due - b.due);
  return { reviews, waiting, fresh };
}
// Step 2: apply today's new-card and review limits.
// Cloze cards of one note are siblings: only one of them is shown a day (limitSiblings), before the limits are applied.
// rescue (optional) is today's catch-up plan from rescueToday(): after the sibling rule and before the review limit,
// only the first `allow` backlog cards stay (still most overdue first); other cards are never touched by the plan.
// With rescue.pauseNew, decks without an exam get no new cards while the plan runs.
export function queueFrom(split, newLimit, reviewLimit = Infinity, answered = new Map(), rescue = null) {
  let { reviews, waiting, fresh } = withoutSiblings(split, answered);
  const newAvailable = fresh.length;
  if (rescue) {
    let room = rescue.allow;
    reviews = reviews.filter(x => {
      if (!isBacklog(x, rescue)) return true;
      return room-- > 0;
    });
    if (rescue.pauseNew) fresh = fresh.filter(c => rescue.exempt?.has(c.deckId));
  }
  const news = pickNew(fresh, newLimit).map(card => ({ card, kind: 'new' }));
  return { queue: interleave(capReviews(reviews, reviewLimit), news), waiting, newAvailable };
}

// ---------- "back from a break" catch-up plan ----------
// A stateless plan kept in settings.rescue = { start, days: N, backlog, pauseNew, at }:
//   start    when the plan began (the study day start): cards due before this are the backlog
//   backlog  how many there were at the start; days  how many days to spread them over
// Day k of the plan allows max(0, remaining - floor(backlog * (N - k) / N)) backlog cards, so it corrects itself:
// a skipped day just means more the next day, and on day N everything left is allowed.
// Cards in decks with an exam (exemptDeckIds) are never part of the backlog.
const DAY_MS = 86400000;
const isBacklog = (x, r) => x.kind === 'review' && x.due < r.cutoff && !r.exempt?.has(x.card.deckId);
export const rescueBacklog = (cards, statesById, exemptDeckIds, cutoff) => cards.filter(c => {
  const st = statesById.get(c.id);
  return st && st.state === REVIEW && st.due < cutoff && !exemptDeckIds?.has(c.deckId);
}).length;

// Today's slice of the plan: null (no plan, over, or nothing left) or { cutoff, allow, k, days, remaining, pauseNew, exempt }.
//   cards  the visible cards (suspended and buried ones are left out by the caller)
export function rescueToday(rescue, cards, statesById, exemptDeckIds = new Set(), now = Date.now()) {
  if (!rescue || !(rescue.days >= 1) || !Number.isFinite(rescue.start)) return null;
  // Whole days between the two day starts. Rounding absorbs the 23/25-hour days around daylight saving.
  const k = Math.round((dayStart(now) - dayStart(rescue.start)) / DAY_MS) + 1;
  if (k < 1 || k > rescue.days) return null;
  const remaining = rescueBacklog(cards, statesById, exemptDeckIds, rescue.start);
  if (remaining === 0) return null;
  const backlog = Number.isFinite(rescue.backlog) ? rescue.backlog : remaining;
  // The even-pace share, but never less than an equal split of what is left over the days that remain: when a deck
  // becomes exempt mid-plan (an exam added) `remaining` drops while `backlog` stays fixed, which would starve the others.
  const allow = Math.max(0, remaining - Math.floor(backlog * (rescue.days - k) / rescue.days), Math.ceil(remaining / (rescue.days - k + 1)));
  return { cutoff: rescue.start, allow, k, days: rescue.days, remaining, pauseNew: rescue.pauseNew !== false, exempt: exemptDeckIds };
}

// Should Today offer a catch-up plan? Offers when the backlog is 30+ cards and at least twice a typical day,
// there is no plan yet and it wasn't dismissed today.
//   backlog        cards due before today          typicalDaily  median reviews of the last 14 study days (default 20)
//   lastStudyDay   timestamp of the last study day (only used to say how long you were away)
//   active         true when a plan already exists   dismissedDay  dayStart a dismissal was made (localStorage)
// Returns null, or { n, backlog, typical, perDay, awayDays } where n is the suggested number of days.
// The cap on N comes from the simulation (tests/sim/compare/report-rescue.md): N up to 5 keeps recall within 0.5 points
// except in 1 of 27 cells; 7 and 10 fail in several. Round 2 decided on 3 days (RESCUE_MAX_DAYS), so the offer is always 3.
export const RESCUE_MIN = 30, RESCUE_MAX_DAYS = 3;     // 3 (owner decision, round2-plan section 9): the largest N that passes every simulation cell
export function rescueOffer({ backlog, typicalDaily, lastStudyDay, now = Date.now(), active = false, dismissedDay = null } = {}) {
  const typical = Number.isFinite(typicalDaily) && typicalDaily > 0 ? typicalDaily : 20;
  if (active || !(backlog >= RESCUE_MIN) || backlog < 2 * typical) return null;
  if (dismissedDay != null && dismissedDay === dayStart(now)) return null;
  const n = Math.min(RESCUE_MAX_DAYS, Math.max(3, Math.ceil(backlog / Math.max(typical, 20))));
  const awayDays = Number.isFinite(lastStudyDay) ? Math.max(0, Math.round((dayStart(now) - dayStart(lastStudyDay)) / DAY_MS)) : null;
  return { n, backlog, typical, perDay: Math.ceil(backlog / n), awayDays };
}

// ---------- cloze siblings ----------
// The cards made from one cloze note share a noteId. Showing all of them on the same day gives the answer away
// (the other cards show it), so like Anki only one card per note is shown a day: a learning card first, then the
// most overdue review, then a new card. A note with a card answered today shows no other card until tomorrow.
// Nothing is saved: a card that sits out just stays due and comes up the next day.
//   items     [{ card, kind: 'learn' | 'review' | 'new', due }] in the order they would be shown
//   noteOf    card → its noteId (undefined for ordinary cards, which are never held back)
//   answered  Map noteId → Set of the card ids of that note answered today (answeredNotes)
// Returns the items that stay, in the same order.
export function limitSiblings(items, noteOf = c => c.noteId, answered = new Map()) {
  const rank = x => (x.kind === 'learn' ? 0 : x.kind === 'review' ? 1 : 2);
  const best = new Map();
  const learning = new Set();                                         // learning cards are never held back
  const kept = items.filter(x => {
    const note = noteOf(x.card);
    if (!note) return true;
    const today = answered.get(note);
    if (today && x.kind === 'learn') { learning.add(x); return true; }
    if (today && !today.has(x.card.id)) return false;                // a sibling was answered today
    const cur = best.get(note);
    if (!cur || rank(x) < rank(cur) || (rank(x) === rank(cur) && rank(x) < 2 && (x.due ?? 0) < (cur.due ?? 0))) best.set(note, x);
    return true;
  });
  return kept.filter(x => { const note = noteOf(x.card); return !note || learning.has(x) || best.get(note) === x; });
}
// The cards of each cloze note answered today, from today's review log: Map noteId → Set of card ids.
// (Play answers that were only logged, not applied to the schedule, don't count.)
export function answeredNotes(logs, cards, now = Date.now()) {
  const start = dayStart(now);
  const noteOf = new Map(cards.filter(c => c.noteId).map(c => [c.id, c.noteId]));
  const out = new Map();
  for (const l of logs) {
    if (l.timestamp < start || !(l.source === 'review' || (l.source === 'play' && l.applied))) continue;
    const note = noteOf.get(l.cardId);
    if (note) (out.get(note) || out.set(note, new Set()).get(note)).add(l.cardId);
  }
  return out;
}
// Apply limitSiblings to the three lists of a split.
function withoutSiblings({ reviews, waiting, fresh }, answered) {
  if (![...reviews, ...waiting, ...fresh.map(card => ({ card }))].some(x => x.card.noteId)) return { reviews, waiting, fresh };   // no cloze cards: nothing to do
  const asNew = fresh.map(card => ({ card, kind: 'new' }));
  const keep = new Set(limitSiblings([...reviews, ...waiting, ...asNew], c => c.noteId, answered));
  return { reviews: reviews.filter(x => keep.has(x)), waiting: waiting.filter(x => keep.has(x)), fresh: asNew.filter(x => keep.has(x)).map(x => x.card) };
}

// Keep reviews within today's review limit (overall and per deck), most overdue first.
function capReviews(items, limit) {
  const { total, byDeck, chains } = typeof limit === 'number' ? { total: limit, byDeck: new Map() } : limit;
  if (total === Infinity && !byDeck.size) return items;
  const left = new Map(byDeck);
  let n = 0;
  return items.filter(x => {
    if (x.kind !== 'review') return true;
    if (n >= total) return false;
    if (!takeFromChain(left, chains?.get(x.card.deckId) || [x.card.deckId])) return false;
    n++;
    return true;
  });
}

// How many reviews are still allowed today, overall and for each deck with its own limit. Like newLimits:
//   perDay  the overall limit (null = no limit)       decks  each deck's optional reviewPerDay
// Reviews of graduated cards done today (in Review, or Play answers that counted) use up the limits.
export function reviewLimits({ perDay, decks, logs, deckOf, now = Date.now(), chains }) {
  const start = dayStart(now);
  const done = new Map();
  let total = 0;
  for (const l of logs) {
    if (l.timestamp < start || l.state !== REVIEW || !(l.source === 'review' || (l.source === 'play' && l.applied))) continue;
    total++;
    const d = deckOf.get(l.cardId);
    if (d !== undefined) for (const a of chains?.get(d) || [d]) done.set(a, (done.get(a) || 0) + 1);
  }
  const byDeck = new Map();
  for (const d of decks) if (Number.isFinite(d.reviewPerDay)) byDeck.set(d.id, Math.max(0, d.reviewPerDay - (done.get(d.id) || 0)));
  return { total: Number.isFinite(perDay) ? Math.max(0, perDay - total) : Infinity, byDeck, chains };
}

// Today's new cards, in order, within the overall limit and each deck's own limit (if it has one).
// With subdecks, a card counts against its deck's limit and every parent deck's limit (chains).
export function pickNew(fresh, newLimit) {
  const { total, byDeck, chains } = typeof newLimit === 'number' ? { total: newLimit, byDeck: new Map() } : newLimit;
  const left = new Map(byDeck);
  const out = [];
  for (const card of fresh) {
    if (out.length >= total) break;
    if (!takeFromChain(left, chains?.get(card.deckId) || [card.deckId])) continue;
    out.push(card);
  }
  return out;
}
// Use one from the limit of each deck in the chain that has one; false (and nothing used) if any is used up.
function takeFromChain(left, chain) {
  const limited = chain.filter(id => left.has(id));
  if (limited.some(id => left.get(id) <= 0)) return false;
  limited.forEach(id => left.set(id, left.get(id) - 1));
  return true;
}
// How many per deck, counting each one in its deck and every deck it sits inside.
function countUpChains(ids, deckOf, chains) {
  const counts = new Map();
  for (const id of ids) {
    const d = deckOf.get(id);
    if (d === undefined) continue;
    for (const a of chains?.get(d) || [d]) counts.set(a, (counts.get(a) || 0) + 1);
  }
  return counts;
}

// How many new cards are still allowed today, overall and for each deck with its own limit.
//   perDay   the overall limit from Settings
//   decks    all decks; a deck's optional newPerDay is its own limit
//   logs     today's answers
//   deckOf   Map cardId → deckId
//   extra    extra new cards added for today with Custom study (raises every limit)
// Returns { total, byDeck: Map deckId → new cards left }.
//   chains   optional (subdecks): deck id → [it, its parent, …] from deck-tree.js chainMap(). A subdeck's
//            new cards count toward its parents' limits too.
export function newLimits({ perDay, decks, logs, deckOf, extra = 0, now = Date.now(), chains }) {
  const start = dayStart(now);
  // Play answers that were only logged (not applied) did not start a card, so they don't use up a new-card slot.
  logs = logs.filter(l => l.source !== 'play' || l.applied);
  const ids = new Set(logs.filter(l => l.timestamp >= start && l.state === NEW).map(l => l.cardId));   // new cards studied today
  const studied = countUpChains(ids, deckOf, chains);
  const byDeck = new Map();
  for (const d of decks) {
    if (Number.isFinite(d.newPerDay)) byDeck.set(d.id, Math.max(0, d.newPerDay + extra - (studied.get(d.id) || 0)));
  }
  return { total: Math.max(0, perDay + extra - newStudiedToday(logs, now)), byDeck, chains };
}

// Play in a deck with an exam starts new cards, within the same limits as Review (see autograde.js).
// newRoomFor: is there room for one more new card in this deck today? (overall limit, and the limit of the deck and
// each deck it sits inside). takeNewFor uses one up, so the next card in the same round sees the smaller number.
export function newRoomFor(limit, deckId) {
  const { total, byDeck, chains } = limit;
  return total > 0 && (chains?.get(deckId) || [deckId]).every(id => !byDeck.has(id) || byDeck.get(id) > 0);
}
export function takeNewFor(limit, deckId) {
  if (!newRoomFor(limit, deckId)) return false;
  takeFromChain(limit.byDeck, limit.chains?.get(deckId) || [deckId]);
  limit.total--;
  return true;
}

// Give a slot back (a 'first' answer that then couldn't be scheduled).
export function giveBackNewFor(limit, deckId) {
  for (const id of limit.chains?.get(deckId) || [deckId]) if (limit.byDeck.has(id)) limit.byDeck.set(id, limit.byDeck.get(id) + 1);
  limit.total++;
}

// Custom study: extra new cards added for today, or 0 if they were added on an earlier day.
export const extraNewToday = (extraNew, now = Date.now()) => (extraNew && extraNew.day === dayStart(now) ? extraNew.n : 0);

// Custom study: review ahead. Review cards that aren't due today but are due within the next `days` days,
// soonest first. (Learning cards are left out: they're due again soon anyway.)
export function aheadQueue(cards, statesById, days, now = Date.now(), caps = null) {
  const from = dayEnd(now), to = dayEnd(now, days);
  const queue = [];
  for (const card of cards) {
    const st = statesById.get(card.id);
    const due = st ? Math.min(st.due, caps?.get(card.id) ?? Infinity) : 0;      // an exam may have brought it forward
    if (st && st.state === REVIEW && due > from && due <= to) queue.push({ card, kind: 'review', due });
  }
  return { queue: queue.sort((a, b) => a.due - b.due), waiting: [] };
}

// Custom study: the cards you pressed Again on (or got wrong in Play) today, in the order you forgot them.
export function forgottenQueue(cards, statesById, logs, now = Date.now()) {
  const start = dayStart(now);
  const order = [...new Set(logs.filter(l => l.timestamp >= start && l.rating === 1).map(l => l.cardId))];
  const byId = new Map(cards.map(c => [c.id, c]));
  const queue = order.filter(id => byId.has(id)).map(id => {
    const st = statesById.get(id);
    return { card: byId.get(id), kind: st && isLearning(st.state) ? 'learn' : st && st.state !== NEW ? 'review' : 'new' };
  });
  return { queue, waiting: [] };
}

// Spread new cards evenly through the reviews, so a session isn't all hard reviews then all new cards.
export function interleave(reviews, news) {
  if (!reviews.length || !news.length) return [...reviews, ...news];
  const out = [];
  const every = (reviews.length + news.length) / news.length;
  let r = 0, n = 0;
  for (let i = 0; i < reviews.length + news.length; i++) {
    const wantNew = n < news.length && (r >= reviews.length || Math.floor((i + 1) / every) > n);
    out.push(wantNew ? news[n++] : reviews[r++]);
  }
  return out;
}

// Which card comes next? A waiting learning card whose time has come goes first, then the queue.
// When only waiting cards are left, show the soonest one early instead of making you wait.
// Takes the card off the list it came from.
export function takeNext(queue, waiting, now = Date.now()) {
  if (waiting.length && waiting[0].due <= now) return waiting.shift();
  if (queue.length) return queue.shift();
  if (waiting.length) return waiting.shift();
  return null;
}

// Put a learning card back in the waiting list, keeping the list in due order.
export function addWaiting(waiting, item) {
  const i = waiting.findIndex(w => w.due > item.due);
  if (i < 0) waiting.push(item); else waiting.splice(i, 0, item);
}

// "Good · 4d" style labels for the time until a card comes back.
export function formatInterval(ms) {
  const min = ms / 60000;
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  const trim = x => x.toFixed(1).replace(/\.0$/, '');
  if (d < 365) return `${trim(d / 30.4)}mo`;
  return `${trim(d / 365)}y`;
}
