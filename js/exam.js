// Exam date mode: get a whole deck ready for an exam. Pure functions, tested by tests/exam.test.js.
//
// A deck can have an exam date (deck.examDate, e.g. '2026-11-20'). Until that day:
//   1. The final pass. A card that we expect you to remember at 99% or better on exam day is left alone,
//      even if its next review falls after the exam. Every other card that would wait until after the exam is
//      reviewed in the last few days before it instead: spread over the last 3 days (fewer if the exam is
//      closer), the weakest closest to the exam (examSchedule, pullIn). This is worked out whenever the
//      day's queue is built, so cards that arrive later (an import, a move, a new subdeck) are covered too.
//      In those same last days the reviews that add most to exam-day recall come first; further out, the order is normal.
//   2. In the last 14 days, the target retention rises step by step to 95%, so reviews get stricter.
//   3. "Exam prep" (examPrepQueue) goes over every card you haven't seen in the last few days.
// After the exam day, nothing changes any more: the deck goes back to normal by itself.

import { dayStart, dayEnd } from './days.js';
import { effectiveDeck, subtreeIds, treeOrder } from './deck-tree.js';
import { dayKey } from './stats-calc.js';
import { EASY_DAY_WEIGHT, NORMAL_WEEK } from './balance.js';

const DAY = 86400000;
export const RAMP_DAYS = 14;          // how long before the exam retention starts rising
export const EXAM_RETENTION = 0.95;   // retention on the day before the exam
const REVIEW = 2;
export const FINAL_DAYS = 3;          // the final pass is spread over at most this many days before the exam
// A card skips its last review before the exam only if it's predicted at least this likely to be remembered on
// exam day. Higher than EXAM_RETENTION on purpose: the predictions are a little optimistic for many students, and
// simulations with real forgetting showed 95% lost 1-2 points on exam day against reviewing everything the evening
// before, while 99% kept within 0.2 points (and still spreads the load).
export const FINAL_R = 0.99;

// ---------- how likely you are to remember a card ----------
// FSRS's forgetting curve: R = (1 + FACTOR · days / stability) ^ -w20. R is the chance of remembering.
// w20 is the decay: FSRS-6's default (ts-fsrs 5.4.2) unless you pass your own (personalW20 in sched-settings.js, or opts.w[20]
// of the scheduler options). FACTOR makes R = 90% when the days equal the stability.
export const DEFAULT_W20 = 0.1542;
export const recall = (stability, days, w20 = DEFAULT_W20) => {
  const decay = -Math.min(0.8, Math.max(0.1, w20));         // kept in the range the scheduler allows
  return stability > 0 ? (1 + (0.9 ** (1 / decay) - 1) * Math.max(0, days) / stability) ** decay : 0;
};

// When the card was last seen (a card from older data may not have lastReview: use its due date minus its gap).
const lastSeen = st => st.lastReview || st.due - (st.scheduledDays || 0) * DAY;
// The chance of remembering the card at a given time, with no review before it.
export const recallAt = (st, when, w20) => recall(st.stability, (when - lastSeen(st)) / DAY, w20);

// '2026-11-20' → the start of that study day (4am local time), or null.
export function examStart(examDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate || '');
  if (!m) return null;
  return dayStart(new Date(+m[1], +m[2] - 1, +m[3], 12).getTime());
}

// { start, daysLeft } for a deck's exam that hasn't happened yet (daysLeft 0 = today), or null.
export function examInfo(deck, now = Date.now()) {
  const start = examStart(deck?.examDate);
  if (start === null) return null;
  const today = dayStart(now);
  const daysLeft = Math.round((start - today) / DAY);
  return daysLeft >= 0 ? { start, daysLeft } : null;
}

// The class for an exam countdown badge: amber, and red only in the last 3 days.
export const badgeClass = info => (info && info.daysLeft <= 3 ? 'exam-badge soon' : 'exam-badge');

export function countdown(info) {
  if (!info) return '';
  return info.daysLeft === 0 ? 'Exam today' : info.daysLeft === 1 ? 'Exam tomorrow' : `Exam in ${info.daysLeft} days`;
}

// The scheduling options for a card in this deck: the normal ones, plus the exam's limits.
//   maxDue     the latest a card may come back: the start of exam day, i.e. by the evening before
//   retention  rises over the last RAMP_DAYS days (never lowered)
export function examOptions(opts, deck, now = Date.now()) {
  const info = examInfo(deck, now);
  if (!info) return opts;
  const out = { ...opts };
  if (info.start > now) out.maxDue = info.start;
  if (info.daysLeft < RAMP_DAYS && opts.retention < EXAM_RETENTION) {
    const t = 1 - Math.max(0, info.daysLeft - 1) / (RAMP_DAYS - 1);     // 0 two weeks out … 1 the day before
    out.retention = Math.round((opts.retention + (EXAM_RETENTION - opts.retention) * t) * 1000) / 1000;
  }
  return out;
}

// ---------- the final pass ----------
// The days (0 = today) on which cards may be put for a last review: the last `FINAL_DAYS` before exam day, but
// not before `from`. { first, last }; nothing fits when first > last.
export const finalWindow = (daysLeft, from = 0) => ({ first: Math.max(from, daysLeft - Math.min(FINAL_DAYS, daysLeft)), last: daysLeft - 1 });

// Which day (0 = today) a time falls on, and when a day starts.
const dayIndex = (time, now) => Math.round((dayStart(time) - dayStart(now)) / DAY);
const startOfDay = (index, now) => (index <= 0 ? dayStart(now) : dayEnd(now, index - 1));
// How much a day may carry compared to a normal one: less on an easy day (the same weights as balance.js pickDay).
const dayWeight = (index, now, easyDays) => EASY_DAY_WEIGHT[easyDays[new Date(startOfDay(index, now)).getDay()]] ?? 1;

// Plan the final pass for one exam: which day each card that needs a review before the exam gets.
//   states   cards' saved schedules (only Review cards count)
//   info     the exam, from examInfo()
//   from     the first day that may be planned: 0 = today, 1 = tomorrow
// A card needs a review when it would wait until after the exam and we expect you'd remember it less than
// EXAM_RETENTION on exam day. The weakest (lowest chance on exam day) go on the last days. The days stay level:
// cards already due on a day count toward it, and an easy day (easyDays, Sunday first, as in Settings) takes less.
// Returns Map card id → day.
export function planFinalPass(states, info, now = Date.now(), from = 0, easyDays = NORMAL_WEEK, w20) {
  const { first, last } = finalWindow(info.daysLeft, from);
  const plan = new Map();
  if (first > last) return plan;
  const load = new Array(last + 1).fill(0);
  const late = [];
  const today = dayStart(now);
  for (const st of states) {
    if (!st || st.state !== REVIEW) continue;
    // Answered today: already part of today's share, even though its next review moved to a later day.
    // (Without this, every queue build would find today emptier and pull more cards in.)
    if (first === 0 && st.lastReview >= today) load[0]++;
    const day = dayIndex(st.due, now);
    if (day >= info.daysLeft) {
      const r = recallAt(st, info.start, w20);
      if (r < FINAL_R) late.push({ id: st.cardId, r, stability: st.stability });
    } else if (day >= first) load[day]++;
    else if (day < 0 && first === 0) load[0]++;               // overdue: you'll do it today
  }
  if (!late.length) return plan;
  // Strongest first, so they get the earliest days and the weakest end up closest to the exam.
  late.sort((a, b) => b.r - a.r || b.stability - a.stability || (a.id < b.id ? -1 : 1));
  // Each day's share of all the reviews in the window, by its weight (equal shares when no day is easy).
  const total = load.slice(first).reduce((a, b) => a + b, 0) + late.length;
  const weight = load.map((_, d) => dayWeight(d, now, easyDays));
  const weights = weight.slice(first).reduce((a, b) => a + b, 0);
  const target = d => Math.ceil(total * weight[d] / weights);
  let day = first;
  for (const c of late) {
    while (load[day] >= target(day) && day < last) day++;
    load[day]++;
    plan.set(c.id, day);
  }
  return plan;
}

// Used by srs.js after every rating. opts.maxDue is the start of exam day. A card that would come back on or after
// it only needs a review before then if we expect you'd remember it less than 99% on exam day. Then it goes
// on one of the last days before the exam, the least busy one (later days win a tie, as the weakest cards
// belong closest to the exam). load (optional) is the Map of reviews per day from balance.js (rate() updates it).
export function examClamp(card, now, opts, load) {
  if (!(opts.maxDue > now) || card.due.getTime() < opts.maxDue) return card;
  if (recall(card.stability, (opts.maxDue - now) / DAY, opts.w?.[20]) >= FINAL_R) return card;     // fine as it is
  const daysLeft = Math.round((opts.maxDue - dayStart(now)) / DAY);
  const { first, last } = finalWindow(daysLeft, 1);                  // tomorrow at the earliest
  if (first > last) return card;                                        // no day left to put it on
  // Busy = (reviews already due + 1) ÷ the day's weight, so an easy day looks busier (as in balance.js).
  const busy = d => ((load?.get(dayKey(dayEnd(now, d - 1))) || 0) + 1) / dayWeight(d, now, opts.balance?.easyDays || NORMAL_WEEK);
  let day = last;
  for (let d = last - 1; d >= first; d--) if (busy(d) < busy(day)) day = d;
  card.due = new Date(dayEnd(now, day - 1) + 2 * 3600000);              // 6am that day
  card.scheduled_days = day;
  return card;
}

// The exam's part of building today's queue (study-data.js and review.js hand this to splitCards):
//   caps   Map card id → the time its review is brought forward to (6am on the planned day; the start of the day for today).
//          Cards whose review is no sooner than the exam and don't need one aren't in it.
//   gain   Map card id → how much a review now adds to the chance of remembering the card on exam day
//          (only when gainOf is given: it needs the FSRS library, and only once the final pass has started,
//          i.e. in the last FINAL_DAYS days). The queue puts the biggest gains first.
// Only the last days before an exam change anything, so it costs little to call. Cards that sit in a deck
// (or a deck inside one) with an exam; exam day itself and later change nothing.
//   gainOf(card, state, examStart) → number
//   planned (optional) the caps already worked out for the whole exam group (loadAll). A session over only some of
//   the decks passes them, so it plans no different from Today, and only adds the gain.
//   easyDays (Sunday first, as in Settings): easy weekdays get fewer of the planned reviews.
export function examSchedule(decks, cards, statesById, now = Date.now(), gainOf = null, planned = null, easyDays = NORMAL_WEEK, w20) {
  const caps = planned || new Map(), gain = new Map();
  const infoOf = new Map();                     // deck id → its exam (decks are few, cards many)
  const groups = new Map();                     // exam day → { info, cards }
  for (const card of cards) {
    if (!infoOf.has(card.deckId)) infoOf.set(card.deckId, examInfo(effectiveDeck(decks, card.deckId), now));
    const info = infoOf.get(card.deckId);
    if (!info || info.daysLeft < 1) continue;
    if (!groups.has(info.start)) groups.set(info.start, { info, cards: [] });
    groups.get(info.start).cards.push(card);
  }
  const end = dayEnd(now);
  for (const { info, cards: inExam } of groups.values()) {
    const states = inExam.map(c => statesById.get(c.id)).filter(Boolean);
    const started = finalWindow(info.daysLeft).first === 0;     // the final pass has started
    if (!planned && started) {
      for (const [id, day] of planFinalPass(states, info, now, 0, easyDays, w20)) caps.set(id, day === 0 ? dayStart(now) : startOfDay(day, now) + 2 * 3600000);
    }
    if (gainOf && started) {          // further out, exam cards wait their turn like any other
      for (const card of inExam) {
        const st = statesById.get(card.id);
        if (st && st.state === REVIEW && Math.min(st.due, caps.get(card.id) ?? Infinity) <= end) gain.set(card.id, gainOf(card, st, info.start));
      }
    }
  }
  return { caps, gain };
}

// How much a review now adds to the chance of remembering a card on exam day.
//   p = the chance of remembering it now. After a review, the card is as stable as the "Good" (if remembered)
//   or "Again" (if not) stability. Gain = what we'd expect on exam day with the review, minus without it.
export function examGainFrom(st, goodStability, againStability, examStart, now, w20) {
  const p = recallAt(st, now, w20);
  const left = (examStart - now) / DAY;
  return p * recall(goodStability, left, w20) + (1 - p) * recall(againStability, left, w20) - recallAt(st, examStart, w20);
}

// Cards brought forward when an exam date is set: the final pass (planFinalPass) from tomorrow on, as saved
// schedules (6am on the planned day). Returns the changed schedules only. Cards you'd remember at 99%
// or better on exam day are left alone. Nothing changes if the exam is today or past.
export function pullIn(states, deck, now = Date.now(), easyDays = NORMAL_WEEK, w20) {
  const info = examInfo(deck, now);
  if (!info || info.start <= dayEnd(now)) return [];
  const plan = planFinalPass(states, info, now, 1, easyDays, w20);
  return states.filter(s => s && plan.has(s.cardId)).map(s => {
    const due = startOfDay(plan.get(s.cardId), now) + 2 * 3600000;         // 6am that day
    return { ...s, due, scheduledDays: Math.max(1, Math.round((due - (s.lastReview || now)) / DAY)) };
  }).sort((a, b) => a.due - b.due);
}

// Exam prep: every card in the decks not reviewed in the last `recentDays` days, the least likely to be
// remembered right now first (not simply the lowest stability: a stable card left alone for months can be
// weaker than a shaky one seen yesterday), then the ones never studied (in deck order). Returns { queue, waiting } like the other study sessions.
export function examPrepQueue(cards, statesById, now = Date.now(), recentDays = 3, w20) {
  const since = now - recentDays * DAY;
  const studied = [], fresh = [];
  for (const card of cards) {
    const st = statesById.get(card.id);
    if (!st || st.state === 0) fresh.push(card);
    else if ((st.lastReview || 0) < since) studied.push({ card, st });
  }
  studied.sort((a, b) => recallAt(a.st, now, w20) - recallAt(b.st, now, w20));
  return {
    queue: [...studied.map(({ card, st }) => ({ card, kind: st.state === REVIEW ? 'review' : 'learn' })), ...fresh.map(card => ({ card, kind: 'new' }))],
    waiting: []
  };
}

// "N new a day to finish by the exam": how many new cards a day finish every card you haven't started, leaving
// the last LEAD_DAYS days free so each card is seen about three times before the exam (the first review comes
// about a day after learning it). N = ⌈unstarted ÷ max(1, days left − 4)⌉; 0 when nothing is left to start.
export const LEAD_DAYS = 4;
export const newPerDayToFinish = (unstarted, daysLeft) => (unstarted > 0 ? Math.ceil(unstarted / Math.max(1, daysLeft - LEAD_DAYS)) : 0);

// The deck with the nearest upcoming exam that has cards (a subdeck counts the exam of the deck it's inside),
// or null when no deck has one. A parent comes before its subdecks, so it wins a tie. Play opens on this deck.
export function nearestExamDeck(decks, cards, now = Date.now()) {
  let best = null;
  for (const { deck } of treeOrder(decks)) {
    const info = examInfo(effectiveDeck(decks, deck.id), now);
    if (!info || (best && info.daysLeft >= best.daysLeft)) continue;
    const inside = subtreeIds(decks, deck.id);
    if (cards.some(c => inside.has(c.deckId))) best = { id: deck.id, daysLeft: info.daysLeft };
  }
  return best?.id ?? null;
}

// The deck Play opens on (one deck per game, never "all"): the nearest exam, else the saved deck if it still exists,
// else the first deck in tree order that has cards, else the first deck. `chosen`: the person already picked one this visit,
// so a valid saved deck wins over the exam. Returns '' when there are no decks.
export function pickPlayDeck(decks, cards, saved, { chosen = false, now = Date.now() } = {}) {
  const valid = !!saved && decks.some(d => d.id === saved);
  if (chosen && valid) return saved;
  const exam = nearestExamDeck(decks, cards, now);
  if (exam) return exam;
  if (valid) return saved;
  const first = treeOrder(decks).find(({ deck }) => { const inside = subtreeIds(decks, deck.id); return cards.some(c => inside.has(c.deckId)); });
  return first?.deck.id ?? treeOrder(decks)[0]?.deck.id ?? '';
}

// How ready a set of cards is: the share you are predicted to remember (READY_R or better) at a given time (the exam
// day, or now), if you did no more reviews before then. A card never studied counts as not ready.
// `when` is a time in ms. Returns { ready, total, share } (share 0 to 1).
export const READY_R = 0.9;
export function readiness(cards, statesById, when, w20) {
  let ready = 0;
  cards = cards.filter(c => !c.suspended);        // suspended cards are not being studied: they count neither as ready nor in the total
  for (const c of cards) {
    const st = statesById.get(c.id);
    if (st && st.state !== 0 && recallAt(st, when, w20) >= READY_R) ready++;
  }
  return { ready, total: cards.length, share: cards.length ? ready / cards.length : 0 };
}
