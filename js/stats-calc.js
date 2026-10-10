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

// ---------- study calendar ----------
// A year of study days, like GitHub's contribution chart: one column per week (Monday at the top),
// the newest week on the right. Each day: { time, count (answers), level 0–4 (how dark), future }.
// Also: how many days you studied in that time, and your longest run of days in a row.
export function studyCalendar(logs, now = Date.now(), weeks = 53) {
  const perDay = new Map();
  for (const l of logs) { const k = dayKey(l.timestamp); perDay.set(k, (perDay.get(k) || 0) + 1); }
  // Start on the Monday `weeks - 1` weeks before this week's Monday.
  const todayStart = daysAgoStart(0, now);
  const fromMonday = (new Date(todayStart).getDay() + 6) % 7;      // Mon = 0 … Sun = 6
  const first = fromMonday + (weeks - 1) * 7;
  const days = [];
  for (let i = first; i >= first - (weeks * 7 - 1); i--) {
    const t = daysAgoStart(i, now);
    days.push({ time: t, count: i < 0 ? 0 : perDay.get(dayKey(t)) || 0, future: i < 0 });
  }
  const max = Math.max(0, ...days.map(d => d.count));
  for (const d of days) d.level = !d.count ? 0 : Math.min(4, Math.max(1, Math.ceil((d.count / max) * 4)));
  const cols = [];
  for (let w = 0; w < weeks; w++) cols.push(days.slice(w * 7, w * 7 + 7));
  // Longest run of study days in a row, over all time.
  const keys = [...perDay.keys()].sort();
  let longest = 0, run = 0, prev = null;
  for (const k of keys) {
    const t = new Date(`${k}T12:00:00`).getTime();
    run = prev !== null && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  const shown = days.filter(d => !d.future);
  return { weeks: cols, max, daysStudied: shown.filter(d => d.count).length, daysShown: shown.length,
    answers: shown.reduce((n, d) => n + d.count, 0), longest };
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

// ---------- answer buttons ----------
// How often you pressed Again / Hard / Good / Easy in the last `days` days, for cards you were still
// learning and for normal reviews. { learning: [again, hard, good, easy], review: [...] } plus the share of
// reviews you got right (anything but Again).
export function buttonCounts(logs, now = Date.now(), days = 30) {
  const since = daysAgoStart(days - 1, now);
  const out = { learning: [0, 0, 0, 0], review: [0, 0, 0, 0] };
  for (const l of logs) {
    if (l.timestamp < since || !(l.rating >= 1 && l.rating <= 4) || !isAnswerLog(l)) continue;
    out[l.state === REVIEW ? 'review' : 'learning'][l.rating - 1]++;
  }
  const pct = list => { const n = list.reduce((a, b) => a + b, 0); return n ? Math.round(((n - list[0]) / n) * 100) : null; };
  return { ...out, learningRight: pct(out.learning), reviewRight: pct(out.review) };
}

// ---------- time of day ----------
// Answers in each hour of the day (0–23) over the last `days` days, and how many were right.
export function hourly(logs, now = Date.now(), days = 30) {
  const since = daysAgoStart(days - 1, now);
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0, right: 0 }));
  for (const l of logs) {
    if (l.timestamp < since || !isAnswerLog(l)) continue;
    const h = hours[new Date(l.timestamp).getHours()];
    h.total++;
    if (l.correct) h.right++;
  }
  return hours;
}

// ---------- difficulty ----------
// How many studied cards sit at each FSRS difficulty, in 10 bands from 1 (easiest) to 10 (hardest).
export function difficultyBands(states) {
  const bands = Array.from({ length: 10 }, (_, i) => ({ band: i + 1, count: 0 }));
  for (const s of states) {
    if (!s || s.state === NEW || !(s.difficulty > 0)) continue;
    bands[Math.min(9, Math.max(0, Math.ceil(s.difficulty) - 1))].count++;
  }
  return bands;
}
