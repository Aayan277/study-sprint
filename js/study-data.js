// What Today and Review both need: today's cards for a set of decks, and how a study session is handed over.
// (Kept apart from review.js so Today can open at once, without waiting for the FSRS library review.js loads.)

import * as db from './db.js';
import { dayStart } from './days.js';
import { splitCards, queueFrom, rescueToday, rescueBacklog, rescueOffer, buildQueue, limitSiblings, answeredNotes, newLimits, reviewLimits, extraNewToday, aheadQueue, forgottenQueue, pickedQueue, formatInterval, NEW } from './queue.js';
import { isHidden } from './browse-logic.js';
import { chainMap, subtreeIds, treeOrder, effectiveDeck } from './deck-tree.js';
import { examInfo, examPrepQueue, examSchedule } from './exam.js';
import { lazyStreak, daysAgoStart, restDaySet } from './stats-calc.js';

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
  const answered = answeredNotes(logs, cards, now);       // every card, so a buried or suspended sibling answered today still counts
  // Catch-up plan ("back from a break", settings.rescue): decks with an exam are exempt (also through their parent).
  const exempt = new Set(decks.filter(d => examInfo(effectiveDeck(decks, d.id), now)).map(d => d.id));
  const rescue = rescueToday(settings.rescue, visible, statesById, exempt, now);
  return { settings, decks, allCards: cards, answered, rescue, exempt, depth: new Map(tree.map(x => [x.deck.id, x.depth])), cards: visible, hiddenCount, logs, history: history ? recent : null, deckOf, extra, statesById, newLeft, reviewLeft,
    exam, split: splitCards(visible, statesById, now, exam), splitAt: now };
}

// Is any review limit set (overall or on a deck)? Without one, subdecks' due counts can't add up to more than their parent's.
export const hasReviewLimit = data => Number.isFinite(data.settings.reviewLimit) || data.decks.some(d => Number.isFinite(d.reviewPerDay)) || !!data.rescue;      // (a catch-up plan gives every deck row up to `allow`)

// A set of decks and everything inside them.
export const withSubdecks = (data, deckIds) => new Set(deckIds.flatMap(id => [...subtreeIds(data.decks, id)]));

// How many cards a set of decks (and their subdecks) has for today: what Review will show if you start them now.
//   due     already-studied cards Review will show (daily limits, one card per cloze note a day and exam pull-ins applied)
//   fresh   new cards it will introduce        total  due + fresh
//   scheduled      the raw count: reviews and learning cards due today, before limits and the sibling rule
//   heldBySiblings scheduled cards that wait until tomorrow because a sibling of the same note is shown
//   heldByLimit    cards that wait until tomorrow because of a daily review limit
//   heldByRescue   cards the catch-up plan holds back (0 when data.rescue is empty)
//   heldNewByRescue new cards the plan's "pause new cards" switch holds back
// The cards were sorted into due / waiting / new once, in loadAll(), so counting a deck only looks at the short
// lists (not every card), however many decks are counted. The two "held" numbers are worked out only when read.
export function deckCounts(data, deckIds) {
  const ids = withSubdecks(data, deckIds);
  if (Date.now() - data.splitAt > 60000) { data.split = splitCards(data.cards, data.statesById, Date.now(), data.exam); data.splitAt = Date.now(); }   // a minute old: learning cards may have come due
  const { split } = data;
  const lists = {
    reviews: split.reviews.filter(x => ids.has(x.card.deckId)),
    waiting: split.waiting.filter(x => ids.has(x.card.deckId)),
    fresh: split.fresh.filter(c => ids.has(c.deckId))
  };
  const { queue, waiting } = queueFrom(lists, data.newLeft, data.reviewLeft, data.answered, data.rescue);
  const fresh = queue.filter(q => q.kind === 'new').length;
  const due = queue.length - fresh + waiting.length;
  const scheduled = lists.reviews.length + lists.waiting.length;
  // What Review would show with no review limit (and no catch-up plan): the difference to `due` is the limit's doing.
  let free = null, plain = null;
  const noLimit = () => {
    if (free === null) {
      const q = queueFrom(lists, 0, { total: Infinity, byDeck: new Map() }, data.answered, null);
      free = q.queue.length + q.waiting.length;
    }
    return free;
  };
  // What Review would show with the limits but without the catch-up plan: the difference to `due` is the plan's doing.
  const noRescue = () => {
    if (plain === null) {
      if (!data.rescue) return (plain = due);
      const q = queueFrom(lists, data.newLeft, data.reviewLeft, data.answered, null);
      plain = q.queue.filter(x => x.kind !== 'new').length + q.waiting.length;
    }
    return plain;
  };
  return {
    due, fresh, total: due + fresh, scheduled,
    get heldByLimit() { return noLimit() - noRescue(); },
    get heldByRescue() { return noRescue() - due; },       // cards the catch-up plan (data.rescue) holds back for later days
    get heldBySiblings() { return scheduled - noLimit(); },
    get heldNewByRescue() {
      if (!data.rescue?.pauseNew) return 0;
      const q = queueFrom(lists, data.newLeft, data.reviewLeft, data.answered, null);
      return q.queue.filter(x => x.kind === 'new').length - fresh;
    }
  };
}
// deckCounts plus `cards` (every card in these decks), which is only worked out if someone asks for it.
export function countFor(data, deckIds) {
  const c = deckCounts(data, deckIds);
  const ids = withSubdecks(data, deckIds);
  Object.defineProperty(c, 'cards', { get: () => data.cards.filter(x => ids.has(x.deckId)), enumerable: true });
  return c;
}

// Answers given today in a set of decks (all decks when none are chosen): what the daily goal counts as done.
export function answeredToday(data, deckIds) {
  const ids = deckIds.length ? withSubdecks(data, deckIds) : null;
  return data.logs.filter(l => (l.source === 'review' || l.source === 'play') && (!ids || ids.has(data.deckOf.get(l.cardId)))).length;
}

// The goal ring's denominator (Today and the sidebar share it): your daily goal from Settings, or more when today
// already has more to do (answers so far plus what is still due), so extra study never reads 25/20 and it is never 0/0.
export const GOAL_DEFAULT = 20, GOAL_MAX = 500;
export function goalFor(settings, answered, left) {
  const g = Number(settings?.dailyGoal);
  const base = Number.isFinite(g) ? Math.max(1, Math.min(GOAL_MAX, Math.round(g))) : GOAL_DEFAULT;
  return Math.max(base, answered + left);
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
export function customQueue(kind, data, cards, days = 3, ids = []) {
  if (kind === 'ahead') {
    const ahead = aheadQueue(cards, data.statesById, days, Date.now(), data.exam.caps);
    // A sibling that is still due today (it will be in today's Review) holds the others back, like one answered today.
    const held = new Map(data.answered);
    for (const x of [...data.split.reviews, ...data.split.waiting]) if (x.card.noteId && !held.has(x.card.noteId)) held.set(x.card.noteId, new Set());
    return { ...ahead, queue: limitSiblings(ahead.queue, c => c.noteId, held), label: 'Review ahead' };       // follows the one-sibling-a-day rule
  }
  if (kind === 'ids') return { ...pickedQueue(cards, data.statesById, ids), label: 'Review these' };
  if (kind === 'forgot') return { ...forgottenQueue(cards, data.statesById, data.logs), label: 'Forgotten today' };
  // Exam prep shows every sibling of a cloze note (the point is to see everything before the exam).
  // Exam prep covers decks with an exam coming up (subdecks use their parent's date unless they set one).
  const examOf = new Map(data.decks.map(d => [d.id, examInfo(effectiveDeck(data.decks, d.id))]));
  return { ...examPrepQueue(cards.filter(c => examOf.get(c.deckId)), data.statesById), label: 'Exam prep' };
}

// ---------- the catch-up plan on Today ----------
// What Today needs to know about "back from a break" (queue.js has the arithmetic):
//   active    a plan is saved and still running (or not started yet)
//   finished  a plan is saved but over (its days are up, or nothing overdue is left): Today clears it
//   offer     null, or { n, backlog, typical, perDay, awayDays } to show the banner (rescueOffer)
//   backlog   overdue cards right now (exam decks left out)      typical  your usual reviews a day
// "Not today" for the catch-up banner: remembered on this device for the study day (localStorage).
export const RESCUE_DISMISS = 'study-sprint-rescue-dismissed';
export const dismissRescueToday = (now = Date.now()) => { try { localStorage.setItem(RESCUE_DISMISS, String(dayStart(now))); } catch { /* the banner just comes back on a reload */ } };
// "Reset this device": forget what this device remembered being dismissed (mix-up pairs and the catch-up banner).
// (The mix-up key is confusion.js DISMISS_KEY; it is repeated here so Today does not load Play's modules at start: a test checks they match.)
export const MIX_DISMISS = 'study-sprint-mix-dismissed';
export function clearDismissals(storage = globalThis.localStorage) {
  for (const k of [MIX_DISMISS, RESCUE_DISMISS]) { try { storage.removeItem(k); } catch { /* no storage: nothing to clear */ } }
}
// The time a finished plan is cleared with: the plan's own, so a newer plan from another device always wins (sync keeps the newest).
export const rescueClearAt = saved => (Number.isFinite(saved?.at) ? saved.at : 0);
// `data` must come from loadAll({ history: true }). dismissedDay is the dayStart of a dismissal made today.
export function rescueState(data, now = Date.now(), dismissedDay = null) {
  const saved = data.settings.rescue;
  const today = dayStart(now);
  let finished = false;
  if (saved) {
    const k = Number.isFinite(saved.start) ? Math.round((today - dayStart(saved.start)) / 86400000) + 1 : Infinity;
    finished = !(saved.days >= 1) || k > saved.days || (k >= 1 && !data.rescue);
  }
  const active = !!saved && !finished;
  const backlog = rescueBacklog(data.cards, data.statesById, data.exempt, today);
  const days = new Map();                            // study day → reviews that day (not today: it is only part done)
  for (const l of data.history || []) {
    if (l.source !== 'review' || l.timestamp >= today || !(l.timestamp > 0)) continue;
    const d = dayStart(l.timestamp);
    days.set(d, (days.get(d) || 0) + 1);
  }
  const recent = [...days.entries()].sort((a, b) => b[0] - a[0]).slice(0, 14);      // the last 14 study days
  const counts = recent.map(x => x[1]).sort((a, b) => a - b);
  const mid = counts.length >> 1;
  const typical = counts.length < 3 ? null : (counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2);
  const offer = rescueOffer({ backlog, typicalDaily: typical, lastStudyDay: recent[0]?.[0], now, active, dismissedDay });
  return { active, finished, offer, backlog, typical: offer?.typical ?? (typical || 20) };
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
export function launchStudy({ deckIds = [], deckId, kind = null, days = 3, cardIds = [] } = {}) {
  if (!deckId && !kind && deckIds.length === 1) deckId = deckIds[0];
  setLaunch({ deckIds, deckId, kind, days, cardIds });
  location.hash = deckId ? `#/review/${encodeURIComponent(deckId)}` : '#/review';
}
// A short name for what a session covers (its decks and kind), to tell whether starting again means the same session.
// No decks means all of them. `days` is how far ahead a "review ahead" or exam-prep session looks.
export const scopeKey = (deckIds = [], kind = null, days = 3, cardIds = []) => `${kind || 'today'}:${[...deckIds].sort().join(',')}:${kind === 'ids' ? [...cardIds].join(',') : days}`;
export function takeLaunch() { const l = launch; launch = null; return l; }

// Review tells Today when a session is in progress (so Today can offer "Resume").
//   { left, deckId, day, version } or null
export const live = { resume: null };

// The day streak for Today and the end of a Review session. Uses the 60 days Today already loaded (`history`)
// if it has them, and reads further back only while the streak does.
// ctx = { settings } (for the days off, settings.restDays); without it no days off are counted.
export const loadStreak = (history = null, ctx = null) => lazyStreak(t => db.getStudyDayTimes(t), Date.now(), history, 60, { rest: restDaySet(ctx?.settings) });
