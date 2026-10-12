// What Today and Review both need: today's cards for a set of decks, and how a study session is handed over.
// (Kept apart from review.js so Today can open at once, without waiting for the FSRS library review.js loads.)

import * as db from './db.js';
import { dayStart } from './days.js';
import { splitCards, queueFrom, buildQueue, newLimits, reviewLimits, extraNewToday, aheadQueue, forgottenQueue, formatInterval, NEW } from './queue.js';
import { isHidden } from './browse-logic.js';
import { chainMap, subtreeIds, treeOrder, effectiveDeck } from './deck-tree.js';
import { examInfo, examPrepQueue } from './exam.js';
import { lazyStreak, daysAgoStart } from './stats-calc.js';

// How far back Today looks for the time estimate and the streak.
const HISTORY_DAYS = 60;

// Load everything today's queue is built from.
//   history  also keep the last 60 days of the review log (data.history), for Today's time estimate and streak
export async function loadAll({ history = false } = {}) {
  const [settings, decks, cards, states, recent] = await Promise.all([
    db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getLogsSince(history ? daysAgoStart(HISTORY_DAYS) : dayStart())
  ]);
  const logs = history ? recent.filter(l => l.timestamp >= dayStart()) : recent;
  decks.sort((a, b) => a.created - b.created);
  const tree = treeOrder(decks);
  decks.splice(0, decks.length, ...tree.map(x => x.deck));      // each deck followed by its subdecks
  // New cards come in deck order, then in the order they were added.
  const order = new Map(decks.map((d, i) => [d.id, i]));
  cards.sort((a, b) => order.get(a.deckId) - order.get(b.deckId) || a.created - b.created);
  // Suspended cards, and cards buried until tomorrow, sit out of Review.
  const now = Date.now();
  const hiddenCount = cards.filter(c => isHidden(c, now)).length;
  const visible = cards.filter(c => !isHidden(c, now));
  // New cards left today: the overall limit, each deck's own limit, plus any extra added with Custom study.
  const extra = extraNewToday(settings.extraNew, now);
  const deckOf = new Map(cards.map(c => [c.id, c.deckId]));
  // A parent deck's limits cap its subdecks too (chains).
  const chains = chainMap(decks);
  const newLeft = newLimits({ perDay: settings.newPerDay, decks, logs, deckOf, extra, now, chains });
  // Reviews left today: the overall daily review limit and each deck's own (none by default).
  const reviewLeft = reviewLimits({ perDay: settings.reviewLimit, decks, logs, deckOf, now, chains });
  const statesById = new Map(states.map(s => [s.cardId, s]));
  return { settings, decks, depth: new Map(tree.map(x => [x.deck.id, x.depth])), cards: visible, hiddenCount, logs, history: history ? recent : null, deckOf, extra, statesById, newLeft, reviewLeft,
    split: splitCards(visible, statesById, now), splitAt: now };
}

// A set of decks and everything inside them.
export const withSubdecks = (data, deckIds) => new Set(deckIds.flatMap(id => [...subtreeIds(data.decks, id)]));

// How many cards a set of decks (and their subdecks) has for today.
// The cards were sorted into due / waiting / new once, in loadAll(), so counting a deck only looks at the short
// lists (not every card), however many decks are counted.
export function countFor(data, deckIds) {
  const ids = withSubdecks(data, deckIds);
  if (Date.now() - data.splitAt > 60000) { data.split = splitCards(data.cards, data.statesById); data.splitAt = Date.now(); }   // a minute old: learning cards may have come due
  const { split } = data;
  const { queue, waiting } = queueFrom({
    reviews: split.reviews.filter(x => ids.has(x.card.deckId)),
    waiting: split.waiting.filter(x => ids.has(x.card.deckId)),
    fresh: split.fresh.filter(c => ids.has(c.deckId))
  }, data.newLeft, data.reviewLeft);
  const fresh = queue.filter(q => q.kind === 'new').length;
  const due = queue.length - fresh + waiting.length;
  // `cards` (every card in these decks) is only worked out if someone asks for it.
  return { get cards() { return data.cards.filter(c => ids.has(c.deckId)); }, due, fresh, total: due + fresh };
}

// Answers given today in a set of decks (all decks when none are chosen): what the daily goal counts as done.
export function answeredToday(data, deckIds) {
  const ids = deckIds.length ? withSubdecks(data, deckIds) : null;
  return data.logs.filter(l => (l.source === 'review' || l.source === 'play') && (!ids || ids.has(data.deckOf.get(l.cardId)))).length;
}

// "The next card is due in 3h." (or '' when there's nothing scheduled), for cards that are all done today.
export function nextDueText(data, cards) {
  const ids = new Set(cards.map(x => x.id));
  const next = Math.min(...[...data.statesById.values()].filter(s => ids.has(s.cardId) && s.state !== NEW).map(s => s.due));
  return Number.isFinite(next) ? `The next card is due in <b>${formatInterval(Math.max(0, next - Date.now()))}</b>.` : '';
}

// ---------- Custom study sessions ----------
// kind: 'ahead' (cards due in the next `days` days), 'prep' (exam prep) or 'forgot' (cards forgotten today).
// Returns { queue, waiting, label } like a normal session, from the cards of the chosen decks.
export function customQueue(kind, data, cards, days = 3) {
  if (kind === 'ahead') return { ...aheadQueue(cards, data.statesById, days), label: 'Review ahead' };
  if (kind === 'forgot') return { ...forgottenQueue(cards, data.statesById, data.logs), label: 'Forgotten today' };
  // Exam prep covers decks with an exam coming up (subdecks use their parent's date unless they set one).
  const examOf = new Map(data.decks.map(d => [d.id, examInfo(effectiveDeck(data.decks, d.id))]));
  return { ...examPrepQueue(cards.filter(c => examOf.get(c.deckId)), data.statesById), label: 'Exam prep' };
}

// ---------- how long a session takes ----------
export const DEFAULT_CARD_MS = 8000;       // used until there are enough answers to go by
// A pause longer than this between two reviews is a break, not time spent on a card.
const BREAK_MS = 2 * 60 * 1000, MAX_CARD_MS = 60 * 1000;
// Your usual time per card: the median time between one review and the next in the same session
// (last 60 days), or 8 seconds until there are enough. The log's own `ms` is only the time to turn the card over,
// so it leaves out thinking about the rating and the next card; the gap between answers covers all of it.
export function typicalCardMs(logs, now = Date.now()) {
  const since = now - HISTORY_DAYS * 86400000;
  const reviews = logs.filter(l => l.source === 'review' && l.timestamp >= since).sort((a, b) => a.timestamp - b.timestamp);
  const times = [];
  for (let i = 1; i < reviews.length; i++) {
    const gap = reviews[i].timestamp - reviews[i - 1].timestamp;
    if (gap > 0 && gap <= BREAK_MS) times.push(Math.min(gap, MAX_CARD_MS));
  }
  if (times.length < 5) return DEFAULT_CARD_MS;
  times.sort((a, b) => a - b);
  const mid = times.length >> 1;
  return times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
}
// "~3 min" for a number of cards.
export const minutesText = (cards, cardMs) => `~${Math.max(1, Math.round(cards * cardMs / 60000))} min`;

// ---------- handing a session from Today to Review ----------
// Today works out what to study, then goes to #/review, which starts it. The hand-over is kept here.
let launch = null;
export const setLaunch = l => { launch = l; };
// Go to Review and start a session there.
//   deckIds  the decks to study (empty = all)      deckId  set when it's one deck's own session
//   kind     a Custom study kind, or none            days    for 'ahead'
export function launchStudy({ deckIds = [], deckId, kind = null, days = 3 } = {}) {
  setLaunch({ deckIds, deckId, kind, days });
  location.hash = '#/review';
}
export function takeLaunch() { const l = launch; launch = null; return l; }

// Review tells Today when a session is in progress (so Today can offer "Resume").
//   { left, deckId, day, version } or null
export const live = { resume: null };

// The day streak for Today and the end of a Review session. Uses the 60 days Today already loaded (`history`)
// if it has them, and reads further back only while the streak does.
export const loadStreak = (history = null) => lazyStreak(t => db.getLogsSince(t), Date.now(), history);
