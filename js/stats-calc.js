// The numbers behind the Stats tab. Pure functions (no page, no database),
// tested by tests/stats.test.js. Days follow the app's study day, which starts at 4am.

import { dayStart, dayEnd } from './days.js';

const NEW = 0, REVIEW = 2;

// A short name for a study day, e.g. "2026-10-07". Uses the study day's start, so 2am belongs to the day before.
export function dayKey(time) {
  const d = new Date(dayStart(time));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The start of the study day `n` days before the one containing `now` (n = 0 is today).
// Steps back through the calendar, so daylight-saving changes don't shift it.
export function daysAgoStart(n, now = Date.now()) {
  const d = new Date(dayStart(now));
  d.setDate(d.getDate() - n);
  return d.getTime();
}

// ---------- day streak ----------
// Any review or Play answer counts as studying that day.
// The streak counts back from today, or from yesterday if you haven't studied yet today.
export function dayStreak(logs, now = Date.now()) {
  const days = new Set(logs.map(l => dayKey(l.timestamp)));
  const today = days.has(dayKey(now));
  let n = 0;
  for (let i = today ? 0 : 1; days.has(dayKey(daysAgoStart(i, now))); i++) n++;
  // The 7-day dot row: oldest first, ending today.
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const t = daysAgoStart(i, now);
    week.push({ time: t, on: days.has(dayKey(t)), today: i === 0 });
  }
  return { days: n, studiedToday: today, week };
}

// An answer from Review, Play, or a review history imported from Anki.
export const isAnswerLog = l => l.source === 'review' || l.source === 'play' || l.source === 'anki';

// ---------- retention ----------
// Of the due reviews in the last 30 days, how many did you remember?
// A "due review" is a card that had already graduated (Review state) and came due: from the Review
// tab, or a Play answer that counted as the card's review.
export function isDueReview(log) {
  if (log.state !== REVIEW) return false;
  if (log.source === 'review' || log.source === 'anki') return true;     // anki: imported with an Anki deck
  if (log.source === 'play') return log.reason ? log.reason === 'due' : !!log.applied;
  return false;
}
export function retention(logs, now = Date.now(), days = 30) {
  const since = daysAgoStart(days - 1, now);
  const due = logs.filter(l => l.timestamp >= since && isDueReview(l));
  const remembered = due.filter(l => l.correct).length;
  return { total: due.length, remembered, rate: due.length ? remembered / due.length : null };
}

// ---------- reviews per day ----------
// One entry per study day for the last `days` days (oldest first), split by where the answer came from.
export function reviewsPerDay(logs, now = Date.now(), days = 30) {
  const out = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const t = daysAgoStart(i, now);
    const row = { time: t, review: 0, play: 0, total: 0 };
    index.set(dayKey(t), row);
    out.push(row);
  }
  for (const l of logs) {
    const row = index.get(dayKey(l.timestamp));
    const src = l.source === 'anki' ? 'review' : l.source;    // reviews done in Anki count as reviews
    if (!row || (src !== 'review' && src !== 'play')) continue;
    row[src]++;
    row.total++;
  }
  return out;
}

// ---------- due forecast ----------
// How many cards come due on each of the next `days` days. Today includes anything overdue.
export function dueForecast(states, now = Date.now(), days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) out.push({ time: daysAgoStart(-i, now), count: 0 });
  for (const s of states) {
    if (!s || s.state === NEW) continue;
    for (let i = 0; i < days; i++) {
      if (s.due <= dayEnd(now, i)) { out[i].count++; break; }
    }
  }
  return out;
}

// ---------- hardest cards ----------
// Cards you forget most: most lapses first, then most "Again"s / wrong answers in the last 30 days.
export function hardestCards(cards, statesById, logs, now = Date.now(), limit = 10) {
  const since = daysAgoStart(29, now);
  const misses = new Map();
  for (const l of logs) {
    if (l.timestamp >= since && !l.correct && isAnswerLog(l)) {
      misses.set(l.cardId, (misses.get(l.cardId) || 0) + 1);
    }
  }
  return cards
    .map(c => ({ card: c, lapses: statesById.get(c.id)?.lapses || 0, misses: misses.get(c.id) || 0 }))
    .filter(x => x.lapses > 0 || x.misses > 0)
    .sort((a, b) => b.lapses - a.lapses || b.misses - a.misses)
    .slice(0, limit);
}

// ---------- chart scale ----------
// A clean top for a chart's axis: 0, 5, 10, 20, 50, 100, 200, 500 ... at or above the biggest value.
export function niceMax(max) {
  if (max <= 0) return 5;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}

