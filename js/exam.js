// Exam date mode: get a whole deck ready for an exam. Pure functions, tested by tests/exam.test.js.
//
// A deck can have an exam date (deck.examDate, e.g. '2026-11-20'). Until that day:
//   1. No card in the deck is scheduled past the exam: at the latest it comes back the day before
//      (see examOptions → maxDue, which srs.js respects). Cards already scheduled later are pulled in
//      when you set the date (pullIn).
//   2. In the last 14 days, the target retention rises step by step to 95%, so reviews get stricter.
//   3. "Exam prep" (examPrepQueue) goes over every card you haven't seen in the last few days.
// After the exam day, nothing changes any more: the deck goes back to normal by itself.

import { dayStart, dayEnd } from './days.js';

const DAY = 86400000;
export const RAMP_DAYS = 14;          // how long before the exam retention starts rising
export const EXAM_RETENTION = 0.95;   // retention on the day before the exam
const REVIEW = 2;

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

// Cards scheduled after the exam, brought forward: spread over the days left, weakest (lowest stability)
// first. Returns the changed schedules only. Nothing changes if the exam is today or past.
export function pullIn(states, deck, now = Date.now()) {
  const info = examInfo(deck, now);
  if (!info || info.start <= dayEnd(now)) return [];
  const late = states.filter(s => s && s.state === REVIEW && s.due > info.start).sort((a, b) => a.stability - b.stability);
  const days = Math.max(1, Math.round((info.start - dayEnd(now)) / DAY));       // study days before exam day
  return late.map((s, i) => {
    const day = Math.min(days - 1, Math.floor((i * days) / late.length));   // 0 = tomorrow
    const due = dayEnd(now, day) + 2 * 3600000;                              // 6am that day
    return { ...s, due, scheduledDays: Math.max(1, Math.round((due - (s.lastReview || now)) / DAY)) };
  });
}

// Exam prep: every card in the decks not reviewed in the last `recentDays` days, weakest first, then the
// ones never studied (in deck order). Returns { queue, waiting } like the other study sessions.
export function examPrepQueue(cards, statesById, now = Date.now(), recentDays = 3) {
  const since = now - recentDays * DAY;
  const studied = [], fresh = [];
  for (const card of cards) {
    const st = statesById.get(card.id);
    if (!st || st.state === 0) fresh.push(card);
    else if ((st.lastReview || 0) < since) studied.push({ card, st });
  }
  studied.sort((a, b) => a.st.stability - b.st.stability);
  return {
    queue: [...studied.map(({ card, st }) => ({ card, kind: st.state === REVIEW ? 'review' : 'learn' })), ...fresh.map(card => ({ card, kind: 'new' }))],
    waiting: []
  };
}
