// What Today and Review both need: today's cards for a set of decks, and how a study session is handed over.
// (Kept apart from review.js so Today can open at once, without waiting for the FSRS library review.js loads.)

import * as db from './db.js';
import { dayStart, dayEnd } from './days.js';
import { splitCards, queueFrom, rescueToday, rescueBacklog, rescueOffer, buildQueue, limitSiblings, answeredNotes, newLimits, newRoomFor, reviewLimits, extraNewToday, aheadQueue, forgottenQueue, pickedQueue, formatInterval, isPracticeSource, NEW, LEARNING, RELEARNING } from './queue.js';
import { isHidden } from './browse-logic.js';
import { chainMap, subtreeIds, treeOrder, effectiveDeck } from './deck-tree.js';
import { examInfo, examPrepQueue, examSchedule } from './exam.js';
import { personalW20 } from './sched-settings.js';
import { lazyStreakBack, daysAgoStart, restDaySet, idleDaySet, dayKey } from './stats-calc.js';
import { mergeIdleDays } from './sync-merge.js';
import { go as navGo } from './nav.js';

// How far back Today looks for the time estimate (and, if the last two weeks say too little, the catch-up banner).
const HISTORY_DAYS = 60;
const DAY = 86400000;
// Recent habits count most (see typicalCardMs): the last 2 weeks hold what the estimate and the banner use, when they hold enough.
const RECENT_DAYS = 14, MIN_GAPS = 5, MIN_RECENT_GAPS = 20;
// Two reviews further apart than this are not "one card after another" (see typicalCardMs).
const SAME_SESSION_MS = 45 * 1000;
const FAST_GAP_MS = 2000, MIN_CARD_MS = 4000;

// Is the review log of the last two weeks (plus a margin) all that Today's time estimate and the catch-up banner look at? True
// when it holds 20 gaps between answers (typicalCardMs then uses only the last 2 weeks) and 14 study days before today (rescueState
// then uses only the last 14 study days), so reading the other 46 of the 60 days would change neither.
export function recentHistoryEnough(rows, now = Date.now()) {
  if (cardGaps(rows, now).recent.length < MIN_RECENT_GAPS) return false;
  const today = dayStart(now), days = new Set();
  const from = recentHistoryFrom(now);
  // (A study day that began before the read started is only partly in `rows`, so it is not counted: it could be one of the 14 with more
  // answers than we have seen, or not one at all.)
  for (const l of rows) if (l.source === 'review' && l.timestamp < today && l.timestamp > 0 && dayStart(l.timestamp) >= from) days.add(dayStart(l.timestamp));
  return days.size >= RECENT_DAYS;
}
// Where the first read of the review log starts: two weeks back, with a margin so the gap across the edge is still there.
export const recentHistoryFrom = (now = Date.now()) => Math.min(daysAgoStart(RECENT_DAYS, now), now - RECENT_DAYS * DAY - 3600000);

// The cards in deck order, then in the order they were added, as copies the caller may change. The sorted order is kept
// (sortMemo) while the kept card rows are the same array of the same length and the decks are in the same order: db.js only ever patches
// cardStates in place (never cards), and any other save gives a new array.
let sortMemo = null;
export function sortedCopies(rows, order) {
  const key = [...order.keys()].join('\u0001') + '\u0002' + db.cardsGeneration();       // (the generation moves if the kept cards are ever patched in place)
  if (!(sortMemo && sortMemo.rows === rows && sortMemo.len === rows.length && sortMemo.key === key)) {
    const n = rows.length, rank = new Array(n);
    let known = true;
    for (let i = 0; i < n; i++) { const r = order.get(rows[i].deckId); if (r === undefined) { known = false; break; } rank[i] = r; }
    let perm;
    if (known) {
      perm = Array.from({ length: n }, (_, i) => i);
      perm.sort((a, b) => rank[a] - rank[b] || rows[a].created - rows[b].created);
    } else perm = null;       // a card of an unknown deck: keep the plain comparison below, whose result is not worth caching
    sortMemo = perm ? { rows, len: n, key, perm } : null;
    if (!perm) return rows.map(r => ({ ...r })).sort((a, b) => order.get(a.deckId) - order.get(b.deckId) || a.created - b.created);
  }
  const perm = sortMemo.perm, out = new Array(perm.length);
  for (let i = 0; i < perm.length; i++) out[i] = { ...rows[perm[i]] };
  return out;
}

// Load everything today's queue is built from.
//   history  also keep the review log of the last weeks (data.history), for Today's time estimate and the catch-up banner:
//            the last two weeks when they say enough (recentHistoryEnough), else the last 60 days
//   fullHistory  with `history`: always the last 60 days (Play's speed profile reads them all)
export async function loadAll({ history = false, fullHistory = false } = {}) {
  const [settings, decks, sharedCards, states, first] = await Promise.all([
    db.getSettings(), db.getDecks(), db.getAllCached('cards', { shared: true }), db.getAllCached('cardStates'), db.getLogsSince(history ? recentHistoryFrom() : dayStart())
  ]);
  let recent = first;
  if (history && (fullHistory || !recentHistoryEnough(first))) recent = (await db.getLogsBetween(daysAgoStart(HISTORY_DAYS), recentHistoryFrom())).concat(first);
  const logs = history ? recent.filter(l => l.timestamp >= dayStart()) : recent;
  decks.sort((a, b) => a.created - b.created);
  const tree = treeOrder(decks);
  decks.splice(0, decks.length, ...tree.map(x => x.deck));      // each deck followed by its subdecks
  // New cards come in deck order, then in the order they were added.
  const order = new Map(decks.map((d, i) => [d.id, i]));
  const cards = sortedCopies(sharedCards, order);
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
  const exam = examSchedule(decks, visible, statesById, now, null, null, settings.easyDays, personalW20(settings));
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

// Today's work, for the ring on Today and in the sidebar (they share this): what is done out of what today holds,
// i.e. reviews due today plus today's new cards up to the new-cards-per-day limit (`left` is what deckCounts says
// Review would show now, learning steps included, so the total follows the queue).
//   done      cards finished today in these decks (all decks when none are chosen): a Review answer, or a Play answer
//             that changed the schedule (Play with "Count Play answers as reviews" on). A card still in its learning
//             steps for today is in `left`, so it is not also counted as done.
//   left      cards still to go           total  done + left (0 = nothing was due today)
//   state     'todo' (work left), 'done' (finished today's work) or 'nothing' (nothing was due at all today)
//   frac      the ring's fill: done / total, and full (1) when there was nothing to do
//   n, of     the numbers the ring shows (n of 1 for 'nothing', so the ring is never 0/0)
//   allLearned true when none of these decks (and subdecks) has an unseen new card left, suspended ones included
export function todayRing(data, deckIds, counts, now = Date.now()) {
  const ids = deckIds.length ? withSubdecks(data, deckIds) : null;
  const end = dayEnd(now);
  const finished = new Set();
  const all = data.allCards || data.cards;
  let cardOf = null;       // (built only if a learning card due today needs it)
  for (const l of data.logs) {
    if (!(l.source === 'review' || (isPracticeSource(l.source) && l.applied))) continue;
    if (ids && !ids.has(data.deckOf.get(l.cardId))) continue;
    const st = data.statesById.get(l.cardId);
    // Still to come back today: part of `left`. But a card suspended or buried since is out of the queue (so not in
    // `left`): it stays done, so the total does not shrink.
    if (st && (st.state === LEARNING || st.state === RELEARNING) && st.due <= end && !isHidden((cardOf ||= new Map(all.map(c => [c.id, c]))).get(l.cardId) || {}, now)) continue;
    finished.add(l.cardId);
  }
  const done = finished.size, left = counts.total, total = done + left;
  const state = left > 0 ? 'todo' : done > 0 ? 'done' : 'nothing';
  // "All cards learned": none of these decks (and their subdecks) has an unseen new card. Suspended or buried unseen cards
  // count as not learned (they were never studied), which is why this reads every card, not the visible ones.
  const inScope = all.filter(c => !ids || ids.has(c.deckId));
  const allLearned = inScope.length > 0 && !inScope.some(c => { const st = data.statesById.get(c.id); return !st || st.state === NEW; });
  return { done, left, total, state, allLearned, frac: total ? done / total : 1, n: total ? done : 1, of: total || 1 };
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
//   opts (for 'ids')  includeSuspended: also cards that are suspended or buried (looked up in every deck, whatever the Options
//                     deck choice); spread: keep a note's cards apart; label: the session's name
export function customQueue(kind, data, cards, days = 3, ids = [], opts = {}) {
  if (kind === 'ahead') {
    const ahead = aheadQueue(cards, data.statesById, days, Date.now(), data.exam.caps);
    // A sibling that is still due today (it will be in today's Review) holds the others back, like one answered today.
    const held = new Map(data.answered);
    for (const x of [...data.split.reviews, ...data.split.waiting]) if (x.card.noteId && !held.has(x.card.noteId)) held.set(x.card.noteId, new Set());
    return { ...ahead, queue: limitSiblings(ahead.queue, c => c.noteId, held), label: 'Review ahead' };       // follows the one-sibling-a-day rule
  }
  // Suspended and buried cards are left out, so "Review these" never starts an empty or surprising session.
  // (Study by tag or question ID asks for them: those cards come from every deck and are studied now, buried ones too.)
  if (kind === 'ids') return { ...pickedQueue(opts.includeSuspended ? data.allCards : cards.filter(c => !isHidden(c)), data.statesById, ids, { spread: !!opts.spread }), label: opts.label || 'Review these' };
  if (kind === 'forgot') return { ...forgottenQueue(cards, data.statesById, data.logs), label: 'Forgotten today' };
  // Exam prep shows every sibling of a cloze note (the point is to see everything before the exam).
  // Exam prep covers decks with an exam coming up (subdecks use their parent's date unless they set one).
  const examOf = new Map(data.decks.map(d => [d.id, examInfo(effectiveDeck(data.decks, d.id))]));
  return { ...examPrepQueue(cards.filter(c => examOf.get(c.deckId)), data.statesById, undefined, undefined, personalW20(data.settings)), label: 'Exam prep' };
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
// Two reviews further apart than this (SAME_SESSION_MS above) are not "one card after another": the person looked away, took a break,
// or the log rows are not a real session (an import, or a different day). 45 s covers a slow, careful card.
// A gap under FAST_GAP_MS is a double-tap, a click-through or test data, not a card that was read and rated. The typical time
// per card never goes below MIN_CARD_MS, whatever the log says (nobody reads, recalls and rates a card in 1 second).
// The time between each review and the next in the same session over the last 60 days: all of them, and those in the last 2 weeks.
function cardGaps(logs, now) {
  const since = now - HISTORY_DAYS * DAY;
  const reviews = logs.filter(l => l.source === 'review' && l.timestamp >= since && l.timestamp <= now).sort((a, b) => a.timestamp - b.timestamp);
  const gaps = [];                                  // [when, how long] for each pair of reviews in one session
  for (let i = 1; i < reviews.length; i++) {
    const gap = reviews[i].timestamp - reviews[i - 1].timestamp;
    if (gap >= FAST_GAP_MS && gap <= SAME_SESSION_MS) gaps.push([reviews[i].timestamp, gap]);
  }
  return { gaps, recent: gaps.filter(g => g[0] >= now - RECENT_DAYS * DAY) };
}
// Your usual time per card: the median time between one review and the next in the same session, or 8 seconds
// until there are enough. The log's own `ms` is only the time to turn the card over, so it leaves out thinking
// about the rating and the next card; the gap between answers covers all of it.
// Only Review's own log rows are used: Play rounds are quicker, and imported Anki history has made-up times.
// (A gap of a minute or more used to count as "a minute a card", which turned 76 cards into a 76-minute estimate.)
export function typicalCardMs(logs, now = Date.now()) {
  const { gaps, recent } = cardGaps(logs, now);
  const times = (recent.length >= MIN_RECENT_GAPS ? recent : gaps).map(g => g[1]);
  if (times.length < MIN_GAPS) return DEFAULT_CARD_MS;
  times.sort((a, b) => a - b);
  const mid = times.length >> 1;
  return Math.max(MIN_CARD_MS, times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2);
}
// A learning step like "10m", "2h" or "1d": true when it comes back the same day (under a day).
export const sameDayStep = step => { const m = String(step).match(/^(\d+)([mhd])/i); return !!m && (m[2] !== 'd' && (m[2].toLowerCase() === 'm' ? +m[1] < 1440 : +m[1] < 24)); };
// How long a queue takes, in ms. A review is seen once; a new card is seen once per learning step plus once more
// (1m, 10m = shown, again after 1 min, again after 10 min = 3 times), so it costs (steps + 1) cards of time.
export function sessionMs(due, fresh, cardMs, learningSteps = 2) {
  const views = Math.max(0, Math.round(learningSteps)) + 1;
  return (Math.max(0, due) + Math.max(0, fresh) * views) * Math.max(MIN_CARD_MS, cardMs || 0);
}
// "~3 min", or "~1 h 20 min" from an hour up. `cards` is the whole queue; `fresh` of them are new.
export function minutesText(cards, cardMs, fresh = 0, learningSteps = 2) {
  const f = Math.min(Math.max(0, fresh), Math.max(0, cards));
  const min = Math.max(1, Math.round(sessionMs(cards - f, f, cardMs, learningSteps) / 60000));
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `~${h} h ${m} min` : `~${h} h`;
}

// ---------- handing a session from Today to Review ----------
// Today works out what to study, then goes to #/review, which starts it. The hand-over is kept here.
let launch = null;
export const setLaunch = l => { launch = l; };
// Go to Review and start a session there.
//   deckIds  the decks to study (empty = all)      deckId  set when it's one deck's own session
//   kind     a Custom study kind, or none            days    for 'ahead'
// One deck's own session (and Start with a single deck chosen) goes to #/review/<deck>, so reloading keeps the deck.
//   cardIds  for kind 'ids': the cards, in the order to study them
//   includeSuspended, spread, label  for kind 'ids' (see customQueue): Study by tag or question ID uses all three
export function launchStudy({ deckIds = [], deckId, kind = null, days = 3, cardIds = [], includeSuspended = false, spread = false, label = '' } = {}) {
  if (!deckId && !kind && deckIds.length === 1) deckId = deckIds[0];
  setLaunch({ deckIds, deckId, kind, days, cardIds, includeSuspended, spread, label });
  navGo(deckId ? `#/review/${encodeURIComponent(deckId)}` : '#/review');
}
// A short name for what a session covers (its decks and kind), to tell whether starting again means the same session.
// No decks means all of them. `days` is how far ahead a "review ahead" or exam-prep session looks.
export const scopeKey = (deckIds = [], kind = null, days = 3, cardIds = []) => `${kind || 'today'}:${[...deckIds].sort().join(',')}:${kind === 'ids' ? [...cardIds].join(',') : days}`;
export function takeLaunch() { const l = launch; launch = null; return l; }

// Review tells Today when a session is in progress (so Today can offer "Resume").
//   { left, deckId, day, version } or null
export const live = { resume: null };

// Which study days had an answer, asked about the database once per stretch of days and kept until the data changes (dataVersion) or
// the day or time zone does, so Today, the sidebar and a finished Review session share one reading of the log.
let studyDays = null;      // { version, day, zone, known, present }: the days 0 .. known - 1 back are read; `present` lists the ones with answers
const zoneNow = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
async function readStudyDays(from, to, now) {
  const version = db.dataVersion(), day = dayStart(now), zone = zoneNow();
  if (!studyDays || studyDays.version !== version || studyDays.day !== day || studyDays.zone !== zone) studyDays = { version, day, zone, known: 0, present: [] };
  const mine = studyDays;
  const out = mine.present.filter(n => n >= from && n < to);
  if (mine.known >= to) return out;
  const start = Math.max(from, mine.known), ranges = [];
  for (let n = start; n < to; n++) ranges.push([daysAgoStart(n, now), daysAgoStart(n - 1, now)]);       // day n back: its start up to the next day's start
  const has = await db.hasLogsIn(ranges);
  const found = [];
  has.forEach((yes, i) => { if (yes) found.push(start + i); });
  // Kept only if the data did not change while it was read and the days before it are kept too.
  if (studyDays === mine && db.dataVersion() === version && mine.known === start) { mine.present.push(...found); mine.known = to; }
  return out.concat(found);
}

// The day streak for Today and the end of a Review session. Asks the database which days had answers, walking back from today
// and stopping where the streak does (stats-calc.js lazyStreakBack).
// `history` (the log rows Today loaded) is not needed any more: asking about a day costs next to nothing, and Today now loads only
// two weeks of the log, which is not enough to find where a long streak ends.
// ctx = { settings } (for the days off, settings.restDays); without it no days off are counted.
// With the whole of loadAll()'s data (Today and the sidebar), today is noted when the ring says "Nothing due today" (idleDaysToMark): it never breaks the streak.
export async function loadStreak(history = null, ctx = null) {
  const settings = ctx?.settings;
  let idle = idleDaySet(settings);
  if (settings && ctx.split && ctx.statesById) {
    const fresh = idleDaysToMark(ctx);
    if (fresh.length) {
      idle = new Set([...idle, ...fresh]);
      const flags = mergeIdleDays(settings.idleDays, Object.fromEntries(fresh.map(k => [k, true])));       // (and prunes past 3650 days)
      settings.idleDays = flags;
      db.setSetting('idleDays', flags).catch(err => console.warn('idle days not saved:', err));      // (a synced setting, merged as a union: sync-merge.js)
    }
  }
  const now = Date.now();
  const streak = await lazyStreakBack((from, to) => readStudyDays(from, to, now), now, null, 60, { rest: restDaySet(settings), idle });
  // A day noted as quiet earlier today (cards were added since, or came due) no longer says "Nothing due today".
  if (streak.idleToday && settings && ctx.split && ctx.statesById && todayRing(ctx, [], countFor(ctx, ctx.decks.map(d => d.id))).state !== 'nothing') streak.idleToday = false;
  return streak;
}

// Today, as a day key in a list of one, when the ring genuinely says "Nothing due today" and it is not noted yet; otherwise []. Only the
// day itself is ever noted (never a past day, so hiding cards later cannot back-fill missed days: days the app was not opened are for
// streak freezes). Cards that are suspended or buried count here, so hiding the overdue cards cannot fake a quiet day: no card at all
// may be due by the end of today, and the ring must show no work and none done. Nor may an unseen card that today's new-card limit
// would let in, hidden or not (suspending the new cards must not fake a quiet day). A day can still be quiet for a legitimate reason
// the cards cannot tell apart: reviews postponed to later, or the new-card limit set to 0.
export function idleDaysToMark(data, now = Date.now()) {
  const all = data.allCards || data.cards || [];
  if (!all.length) return [];
  if (todayRing(data, [], countFor(data, data.decks.map(d => d.id)), now).state !== 'nothing') return [];
  const end = dayEnd(now), inLibrary = new Set(all.map(c => c.id));
  for (const st of data.statesById.values()) {
    if (st.state === NEW || !inLibrary.has(st.cardId)) continue;
    if (Math.min(st.due, data.exam?.caps?.get(st.cardId) ?? Infinity) <= end) return [];
  }
  const room = id => newRoomFor(data.newLeft, data.deckOf?.get(id) ?? all.find(c => c.id === id)?.deckId);
  for (const c of all) {
    const st = data.statesById.get(c.id);
    if ((!st || st.state === NEW) && room(c.id)) return [];
  }
  const key = dayKey(now);
  return idleDaySet(data.settings).has(key) ? [] : [key];
}
