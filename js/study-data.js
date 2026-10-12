// What Today and Review both need: today's cards for a set of decks, and how a study session is handed over.
// (Kept apart from review.js so Today can open at once, without waiting for the FSRS library review.js loads.)

import * as db from './db.js';
import { dayStart } from './days.js';
import { buildQueue, newLimits, reviewLimits, extraNewToday, aheadQueue, forgottenQueue, formatInterval, NEW } from './queue.js';
import { isHidden } from './browse-logic.js';
import { chainMap, subtreeIds, treeOrder, effectiveDeck } from './deck-tree.js';
import { examInfo, examPrepQueue } from './exam.js';

// Load everything today's queue is built from.
export async function loadAll() {
  const [settings, decks, cards, states, logs] = await Promise.all([
    db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getLogsSince(dayStart())
  ]);
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
  return { settings, decks, depth: new Map(tree.map(x => [x.deck.id, x.depth])), cards: visible, hiddenCount, logs, extra, statesById: new Map(states.map(s => [s.cardId, s])), newLeft, reviewLeft };
}

// A set of decks and everything inside them.
export const withSubdecks = (data, deckIds) => new Set(deckIds.flatMap(id => [...subtreeIds(data.decks, id)]));

// How many cards a set of decks (and their subdecks) has for today.
export function countFor(data, deckIds) {
  const ids = withSubdecks(data, deckIds);
  const cards = data.cards.filter(c => ids.has(c.deckId));
  const { queue, waiting } = buildQueue(cards, data.statesById, data.newLeft, Date.now(), data.reviewLeft);
  const due = queue.filter(q => q.kind !== 'new').length + waiting.length;
  const fresh = queue.filter(q => q.kind === 'new').length;
  return { cards, due, fresh, total: due + fresh };
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
// Your usual time per card: the median answer time in the review log (last 60 days), or 8 seconds.
export function typicalCardMs(logs) {
  const since = Date.now() - 60 * 86400000;
  const times = logs.filter(l => l.source === 'review' && l.ms > 0 && l.timestamp >= since).map(l => Math.min(l.ms, 60000)).sort((a, b) => a - b);
  if (times.length < 5) return DEFAULT_CARD_MS;
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
