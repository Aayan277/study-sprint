// What Today and Review both need: today's cards for a set of decks, and how a study session is handed over.
// (Kept apart from review.js so Today can open at once, without waiting for the FSRS library review.js loads.)

import * as db from './db.js';
import { dayStart } from './days.js';
import { splitCards, queueFrom, buildQueue, limitSiblings, answeredNotes, newLimits, reviewLimits, extraNewToday, aheadQueue, forgottenQueue, formatInterval, NEW } from './queue.js';
import { isHidden } from './browse-logic.js';
import { chainMap, subtreeIds, treeOrder, effectiveDeck } from './deck-tree.js';
import { examInfo, examPrepQueue, examSchedule } from './exam.js';
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
  // Decks with an exam: cards that need a review before it are brought forward (the final pass, see exam.js).
  const exam = examSchedule(decks, visible, statesById, now, null, null, settings.easyDays);
  // Cloze siblings: a note with a card answered today shows no other card (see limitSiblings in queue.js).
  const answered = answeredNotes(logs, visible, now);
  return { settings, decks, answered, depth: new Map(tree.map(x => [x.deck.id, x.depth])), cards: visible, hiddenCount, logs, history: history ? recent : null, deckOf, extra, statesById, newLeft, reviewLeft,
    exam, split: splitCards(visible, statesById, now, exam), splitAt: now };
}

// A set of decks and everything inside them.
export const withSubdecks = (data, deckIds) => new Set(deckIds.flatMap(id => [...subtreeIds(data.decks, id)]));

// How many cards a set of decks (and their subdecks) has for today.
// The cards were sorted into due / waiting / new once, in loadAll(), so counting a deck only looks at the short
// lists (not every card), however many decks are counted.
export function countFor(data, deckIds) {
  const ids = withSubdecks(data, deckIds);
  if (Date.now() - data.splitAt > 60000) { data.split = splitCards(data.cards, data.statesById, Date.now(), data.exam); data.splitAt = Date.now(); }   // a minute old: learning cards may have come due
  const { split } = data;
  const { queue, waiting } = queueFrom({
    reviews: split.reviews.filter(x => ids.has(x.card.deckId)),
    waiting: split.waiting.filter(x => ids.has(x.card.deckId)),
    fresh: split.fresh.filter(c => ids.has(c.deckId))
  }, data.newLeft, data.reviewLeft, data.answered);
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
  const next = Math.min(...[...data.statesById.values()].filter(s => ids.has(s.cardId) && s.state !== NEW).map(s => Math.min(s.due, data.exam.caps.get(s.cardId) ?? Infinity)));
  return Number.isFinite(next) ? `The next card is due in <b>${formatInterval(Math.max(0, next - Date.now()))}</b>.` : '';
}

// ---------- Custom study sessions ----------
// kind: 'ahead' (cards due in the next `days` days), 'prep' (exam prep) or 'forgot' (cards forgotten today).
// Returns { queue, waiting, label } like a normal session, from the cards of the chosen decks.
export function customQueue(kind, data, cards, days = 3) {
  if (kind === 'ahead') {
    const ahead = aheadQueue(cards, data.statesById, days, Date.now(), data.exam.caps);
    // A sibling that is still due today (it will be in today's Review) holds the others back, like one answered today.
    const held = new Map(data.answered);
    for (const x of [...data.split.reviews, ...data.split.waiting]) if (x.card.noteId && !held.has(x.card.noteId)) held.set(x.card.noteId, new Set());
    return { ...ahead, queue: limitSiblings(ahead.queue, c => c.noteId, held), label: 'Review ahead' };       // follows the one-sibling-a-day rule
  }
  if (kind === 'forgot') return { ...forgottenQueue(cards, data.statesById, data.logs), label: 'Forgotten today' };
  // Exam prep shows every sibling of a cloze note (the point is to see everything before the exam).
  // Exam prep covers decks with an exam coming up (subdecks use their parent's date unless they set one).
  const examOf = new Map(data.decks.map(d => [d.id, examInfo(effectiveDeck(data.decks, d.id))]));
  return { ...examPrepQueue(cards.filter(c => examOf.get(c.deckId)), data.statesById), label: 'Exam prep' };
}

// ---------- how long a session takes ----------
export const DEFAULT_CARD_MS = 8000;       // used until there are enough answers to go by
// Two reviews further apart than this are not "one card after another": the person looked away, took a break,
// or the log rows are not a real session (an import, or a different day). 45 s covers a slow, careful card.
const SAME_SESSION_MS = 45 * 1000;
// Recent habits count most: use the last 2 weeks when they hold enough gaps, else the whole history.
const RECENT_DAYS = 14, MIN_GAPS = 5, MIN_RECENT_GAPS = 20;
// Your usual time per card: the median time between one review and the next in the same session, or 8 seconds
// until there are enough. The log's own `ms` is only the time to turn the card over, so it leaves out thinking
// about the rating and the next card; the gap between answers covers all of it.
// Only Review's own log rows are used: Play rounds are quicker, and imported Anki history has made-up times.
// (A gap of a minute or more used to count as "a minute a card", which turned 76 cards into a 76-minute estimate.)
export function typicalCardMs(logs, now = Date.now()) {
  const since = now - HISTORY_DAYS * 86400000;
  const reviews = logs.filter(l => l.source === 'review' && l.timestamp >= since && l.timestamp <= now).sort((a, b) => a.timestamp - b.timestamp);
  const gaps = [];                                  // [when, how long] for each pair of reviews in one session
  for (let i = 1; i < reviews.length; i++) {
    const gap = reviews[i].timestamp - reviews[i - 1].timestamp;
    if (gap > 0 && gap <= SAME_SESSION_MS) gaps.push([reviews[i].timestamp, gap]);
  }
  const recent = gaps.filter(g => g[0] >= now - RECENT_DAYS * 86400000);
  const times = (recent.length >= MIN_RECENT_GAPS ? recent : gaps).map(g => g[1]);
  if (times.length < MIN_GAPS) return DEFAULT_CARD_MS;
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
// One deck's own session (and Start with a single deck chosen) goes to #/review/<deck>, so reloading keeps the deck.
export function launchStudy({ deckIds = [], deckId, kind = null, days = 3 } = {}) {
  if (!deckId && !kind && deckIds.length === 1) deckId = deckIds[0];
  setLaunch({ deckIds, deckId, kind, days });
  location.hash = deckId ? `#/review/${encodeURIComponent(deckId)}` : '#/review';
}
// A short name for what a session covers (its decks and kind), to tell whether starting again means the same session.
// No decks means all of them. `days` is how far ahead a "review ahead" or exam-prep session looks.
export const scopeKey = (deckIds = [], kind = null, days = 3) => `${kind || 'today'}:${[...deckIds].sort().join(',')}:${days}`;
export function takeLaunch() { const l = launch; launch = null; return l; }

// Review tells Today when a session is in progress (so Today can offer "Resume").
//   { left, deckId, day, version } or null
export const live = { resume: null };

// The day streak for Today and the end of a Review session. Uses the 60 days Today already loaded (`history`)
// if it has them, and reads further back only while the streak does.
export const loadStreak = (history = null) => lazyStreak(t => db.getLogsSince(t), Date.now(), history);
