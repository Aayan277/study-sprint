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
//   newLimit   how many new cards are still allowed today
// Returns { queue, waiting, newAvailable }:
//   queue    cards to show now: [{ card, kind: 'review' | 'learn' | 'new' }]
//   waiting  learning cards due later today, shown when their time comes: [{ card, kind, due }]
//   newAvailable  how many new cards exist in total (before the daily limit)
export function buildQueue(cards, statesById, newLimit, now = Date.now()) {
  const end = dayEnd(now);
  const reviews = [], waiting = [], fresh = [];
  for (const card of cards) {
    const st = statesById.get(card.id);
    if (!st || st.state === NEW) { fresh.push(card); continue; }
    if (isLearning(st.state)) {
      if (st.due <= now + LEARN_AHEAD) reviews.push({ card, kind: 'learn', due: st.due });
      else if (st.due <= end) waiting.push({ card, kind: 'learn', due: st.due });
    } else if (st.due <= end) {
      reviews.push({ card, kind: 'review', due: st.due });
    }
  }
  reviews.sort((a, b) => a.due - b.due);          // most overdue first
  waiting.sort((a, b) => a.due - b.due);
  const news = fresh.slice(0, Math.max(0, newLimit)).map(card => ({ card, kind: 'new' }));
  return { queue: interleave(reviews, news), waiting, newAvailable: fresh.length };
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
