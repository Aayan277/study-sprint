// The numbers behind the Stats tab. Pure functions (no page, no database),
// tested by tests/stats.test.js. Days follow the app's study day, which starts at 4am.

import { dayStart, dayEnd, ROLLOVER_HOUR } from './days.js';

const NEW = 0, REVIEW = 2;

// A short name for a study day, e.g. "2026-10-07". Uses the study day's start, so 2am belongs to the day before.
// Names are worked out once per day: the day's number (counting days of wall-clock time, shifted by the 4am
// rollover) finds it again quickly, which matters when a log has tens of thousands of rows.
const names = new Map();
export function dayKey(time) {
  const n = Math.floor((time - new Date(time).getTimezoneOffset() * 60000 - ROLLOVER_HOUR * 3600000) / 86400000);
  let name = names.get(n);
  if (name === undefined) {
    const d = new Date(dayStart(time));
    name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    names.set(n, name);
  }
  return name;
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
//
// Streak freeze (worked out from the log, nothing is stored): a missed day is covered ("frozen") when
//   (a) no other day in its week (Monday 4am to Monday 4am) is frozen: one freeze a week, not banked. The freeze
//       stays on the EARLIEST coverable missed day of the week (owner decision, 14 Oct), so a later miss in the
//       same week ends the streak instead of taking the freeze away from the first one;
//   (b) the next newer day was studied, was a day off, or is today: two missed days in a row are never both covered;
//   (c) a studied day exists further back in the run (a freeze with nothing before it is dropped).
// A frozen day keeps the streak alive but does not add to the count. A day off adds 0 and never breaks it.
// A decision looks at newer days and at up to 6 older days of the same week (see `earliestCoverable`), so
// lazyStreak keeps a 7-day margin before it stops reading.
// Days are named by the device's current time zone (dayKey), so moving between zones can move a day.
export const EMPTY_SET = new Set();
const MAX_DAYS = 3650;

// The days off in the settings (`restDays: { 'YYYY-MM-DD': { on, at } }`) as a Set of day keys. Ignores junk.
export function restDaySet(settings) {
  const out = new Set();
  const flags = settings && settings.restDays;
  if (!flags || typeof flags !== 'object') return out;
  for (const [k, v] of Object.entries(flags)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || v.on !== true) continue;
    // A day off is planned before the day: one decided on or after the day itself (it can only arrive through sync,
    // a backup or devtools) is ignored, so it can't rescue a streak after the fact.
    const [y, m, d] = k.split('-').map(Number);
    if (Number.isFinite(v.at) && v.at >= new Date(y, m - 1, d, ROLLOVER_HOUR).getTime()) continue;
    out.add(k);
  }
  return out;
}

// The key of the Monday of a day's week, e.g. weekOf('2026-10-14') is '2026-10-12'.
// Built at noon so a daylight-saving change can't move it to another date.
export function weekOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// Walk back from today. `all` false stops at the first break (the current streak); true goes on through every
// older run too (for the calendar's best streak). Returns { first, span, runs, frozen }: `first` is the current
// run's length, `span` how many days back the walk got (the day it broke), `runs` every run's length and
// `frozen` the covered days that ended up counting (newest first).
function walk(days, rest, now, freezes, limit, all) {
  let n = 0, pending = [], okNewer = true, first = null, span = limit;
  const frozenWeeks = new Set(), frozen = [], runs = [];
  const close = i => {
    for (const p of pending) frozenWeeks.delete(p.week);     // a freeze with nothing studied before it is not used
    pending = [];
    runs.push(n);
    if (first === null) { first = n; span = i; }
    n = 0;
    okNewer = false;
  };
  const keyAt = i => dayKey(daysAgoStart(i, now));
  // Could a freeze cover day j (missed, the day before it studied / a day off / today, and a studied day further back)?
  const coverable = j => {
    const k = keyAt(j);
    if (days.has(k) || rest.has(k)) return false;
    if (j - 1 > 0 ? !(days.has(keyAt(j - 1)) || rest.has(keyAt(j - 1))) : false) return false;
    let b = j + 1;
    while (b < limit && rest.has(keyAt(b)) && !days.has(keyAt(b))) b++;
    return b < limit && days.has(keyAt(b));
  };
  // The earliest day of day i's week (looking up to 6 days back) that a freeze could cover.
  const earliestCoverable = (i, week) => {
    let best = -1;
    for (let j = i; j <= i + 6 && j < limit; j++) {
      if (j > i && weekOf(keyAt(j)) !== week) break;
      if (coverable(j)) best = j;
    }
    return best;
  };
  for (let i = 0; i < limit; i++) {
    const key = keyAt(i);
    if (days.has(key)) {
      n++;
      for (const p of pending) frozen.push(p.key);
      pending = [];
      okNewer = true;
    } else if (rest.has(key) || i === 0) {
      okNewer = true;                                      // a day off, or today (not over yet): nothing lost
    } else {
      const week = weekOf(key);
      if (freezes && okNewer && !frozenWeeks.has(week) && earliestCoverable(i, week) === i) {
        pending.push({ key, week });
        frozenWeeks.add(week);
        okNewer = false;
      } else {
        close(i);
        if (!all) return { first, span, runs, frozen };
      }
    }
  }
  close(limit);
  return { first, span, runs, frozen };
}

export function dayStreak(logs, now = Date.now(), opts) {
  return streakFromDays(new Set(logs.map(l => dayKey(l.timestamp))), now, opts);
}
// The same, from days already worked out: anything with .has(dayKey), e.g. a Set or the Map from answerDays().
//   rest     a Set of day keys that are days off      freezes  false = no streak freeze (the old rules)
// Returns { days, studiedToday, restToday, week: [{ time, on, today, frozen, rest }], frozen: [keys, newest first],
//   freeze: { ready (no freeze used this week), usedOn (key of the one used this week, or null) }, span }.
export function streakFromDays(days, now = Date.now(), { rest = EMPTY_SET, freezes = true } = {}) {
  const todayKey = dayKey(now);
  const studiedToday = days.has(todayKey);
  const w = walk(days, rest, now, freezes, MAX_DAYS, false);
  const frozen = new Set(w.frozen);
  const thisWeek = weekOf(todayKey);
  const usedOn = w.frozen.find(k => weekOf(k) === thisWeek) || null;
  // The 7-day dot row: oldest first, ending today.
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const t = daysAgoStart(i, now), k = dayKey(t);
    week.push({ time: t, on: days.has(k), today: i === 0, frozen: frozen.has(k), rest: rest.has(k) && !days.has(k) });
  }
  return { days: w.first, studiedToday, restToday: rest.has(todayKey) && !studiedToday, week, frozen: w.frozen,
    freeze: { ready: !usedOn, usedOn }, span: w.span };
}

// The wording for a streak (Today, the sidebar and the finish screen all use it): { line, sub }.
// `line` says what to do (first match wins); `sub` is the freeze note, or ''.
const WEEKDAY_NAME = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
export function streakText(streak, now = Date.now()) {
  const yesterday = dayKey(daysAgoStart(1, now));
  let line;
  if (streak.studiedToday) line = 'Kept for today';
  else if (streak.days && streak.restToday) line = 'Rest day · your streak is safe';
  else if (streak.days && streak.frozen[0] === yesterday) line = 'Freeze used yesterday · study today to keep it';
  else if (streak.days) line = 'Study today to keep it';
  else line = 'Study today to start one';
  let sub = '';
  if (streak.freeze.usedOn) sub = `Freeze used ${WEEKDAY_NAME.format(new Date(`${streak.freeze.usedOn}T12:00:00`))}`;
  else if (streak.days && streak.frozen[0] !== yesterday) sub = '1 freeze ready this week';   // (missing today would break it anyway after a freeze yesterday)
  return { line, sub };
}

// The same streak, without reading the whole log: asks readSince(time) for the answers since a time (an async
// function) and only looks further back while the streak runs right up to the oldest day read.
// `first` is what the first 60 days look like if the caller already has them. Today and the end of a Review
// session use this, so they always agree with Stats.
// readSince may return log rows or just their timestamps (numbers: cheaper to read, see db.getStudyDayTimes).
const LAZY_MARGIN = 8;                 // a freeze decision can look 6 days further back than the break itself
export async function lazyStreak(readSince, now = Date.now(), first = null, days = 60, opts) {
  let logs = first || await readSince(daysAgoStart(days, now));
  for (;;) {
    const times = logs.map(l => (typeof l === 'number' ? l : isAnswerLog(l) ? l.timestamp : NaN)).filter(t => t === t);
    const streak = streakFromDays(new Set(times.map(dayKey)), now, opts);
    if (streak.span < days - LAZY_MARGIN || days >= MAX_DAYS) return streak;      // it ended inside what was read
    days *= 2;
    logs = await readSince(daysAgoStart(days, now));
  }
}

// Every run of days over the whole history, with the same rules: which days were frozen, and the longest run.
// `perDay` is a Map of dayKey -> answers. Returns { frozen: Set of keys, longest }.
export function streakRuns(perDay, now = Date.now(), { rest = EMPTY_SET, freezes = true } = {}) {
  let oldest = null;
  for (const k of perDay.keys()) if (perDay.get(k) > 0 && (oldest === null || k < oldest)) oldest = k;
  if (oldest === null) return { frozen: new Set(), longest: 0 };
  const [y, m, d] = oldest.split('-').map(Number);
  const today = new Date(dayStart(now)); today.setHours(12);
  const back = Math.round((today - new Date(y, m - 1, d, 12)) / 86400000);
  const w = walk(perDay, rest, now, freezes, Math.max(1, back + 1), true);
  return { frozen: new Set(w.frozen), longest: Math.max(0, ...w.runs) };
}

// ---------- study calendar ----------
// A year of study days, like GitHub's contribution chart: one column per week (Monday at the top),
// the newest week on the right. Each day: { time, count (answers), level 0–4 (how dark), future }.
// Also: how many days you studied in that time, and your longest run of days in a row.
export function studyCalendar(logs, now = Date.now(), weeks = 53, opts) {
  const perDay = new Map();
  for (const l of logs) { const k = dayKey(l.timestamp); perDay.set(k, (perDay.get(k) || 0) + 1); }
  return calendarFromDays(perDay, now, weeks, opts);
}
// The same, from answers per day already counted (a Map of dayKey -> count, see answerDays()).
// opts as for streakFromDays: days off (`rest`) and whether freezes count. Each day also says whether a streak
// freeze covered it (`frozen`) or it was a day off (`rest`).
// opts.from (a time): start the grid at the week holding the 1st of that time's month, if that is later than `weeks`
// weeks ago, so a new account does not open on a year of empty squares.
export function calendarFromDays(perDay, now = Date.now(), weeks = 53, opts = {}) {
  const rest = opts.rest || EMPTY_SET;
  // Start on the Monday `weeks - 1` weeks before this week's Monday.
  const todayStart = daysAgoStart(0, now);
  const fromMonday = (new Date(todayStart).getDay() + 6) % 7;      // Mon = 0 … Sun = 6
  if (Number.isFinite(opts.from)) {
    const f = new Date(opts.from); f.setDate(1); f.setHours(12, 0, 0, 0);
    const t = new Date(todayStart); t.setHours(12, 0, 0, 0);
    const firstMonday = new Date(f); firstMonday.setDate(1 - ((f.getDay() + 6) % 7));
    const thisMonday = new Date(t); thisMonday.setDate(t.getDate() - fromMonday);
    const needed = Math.round((thisMonday - firstMonday) / 604800000) + 1;
    weeks = Math.max(1, Math.min(weeks, needed));
  }
  const first = fromMonday + (weeks - 1) * 7;
  const runs = streakRuns(perDay, now, opts);
  const days = [];
  for (let i = first; i >= first - (weeks * 7 - 1); i--) {
    const t = daysAgoStart(i, now), k = dayKey(t);
    const count = i < 0 ? 0 : perDay.get(k) || 0;
    days.push({ time: t, count, future: i < 0, frozen: runs.frozen.has(k), rest: !count && rest.has(k) });
  }
  const max = Math.max(0, ...days.map(d => d.count));
  for (const d of days) d.level = !d.count ? 0 : Math.min(4, Math.max(1, Math.ceil((d.count / max) * 4)));
  const cols = [];
  for (let w = 0; w < weeks; w++) cols.push(days.slice(w * 7, w * 7 + 7));
  const shown = days.filter(d => !d.future);
  return { weeks: cols, max, daysStudied: shown.filter(d => d.count).length, daysShown: shown.length,
    answers: shown.reduce((n, d) => n + d.count, 0), longest: runs.longest };
}

// An answer from Review, Play, or a review history imported from Anki.
export const isAnswerLog = l => l.source === 'review' || l.source === 'play' || l.source === 'anki';

// Answers per study day (a Map of dayKey -> count), counted in one pass over the log.
// `all` counts every deck (for the streak); `picked` only the cards in `cardIds` (the Stats deck filter).
// With no filter they are the same Map.
export function answerDays(logs, cardIds = null) {
  const all = new Map(), picked = cardIds ? new Map() : all;
  for (const l of logs) {
    if (!isAnswerLog(l)) continue;
    const k = dayKey(l.timestamp);
    all.set(k, (all.get(k) || 0) + 1);
    if (cardIds && cardIds.has(l.cardId)) picked.set(k, (picked.get(k) || 0) + 1);
  }
  return { all, picked };
}

// ---------- retention ----------
// Of the due reviews in the last 30 days where you had to recall the answer, how many did you remember?
// A "due review" is a card that had already graduated (Review state) and came due: from the Review
// tab, or a Play answer that counted as the card's review.
export function isDueReview(log) {
  if (log.state !== REVIEW) return false;
  if (log.source === 'review' || log.source === 'anki') return true;     // anki: imported with an Anki deck
  if (log.source === 'play') return log.reason ? log.reason === 'due' : !!log.applied;
  return false;
}
// Retention counts recall only: flipping a card and rating it, typing the answer (in Review or Play) and Anki
// history. A multiple choice answer in Play is left out: with four options you can guess right, so it would
// make you look better than you are.
export const isRecallReview = log => isDueReview(log) && !(log.source === 'play' && log.mode !== 'typing');
export function retention(logs, now = Date.now(), days = 30) {
  const since = daysAgoStart(days - 1, now);
  const due = logs.filter(l => l.timestamp >= since && isRecallReview(l));
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
  const out = [], ends = [];
  for (let i = 0; i < days; i++) { out.push({ time: daysAgoStart(-i, now), count: 0 }); ends.push(dayEnd(now, i)); }
  for (const s of states) {
    if (!s || s.state === NEW) continue;
    for (let i = 0; i < days; i++) {
      if (s.due <= ends[i]) { out[i].count++; break; }
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
// A clean top for a chart's axis, at or above the biggest value: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a
// power of ten (so 38 gets 40 and 111 gets 150, not 50 and 200, and the bars use the chart's height).
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export function niceMax(max) {
  if (max <= 0) return 5;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of NICE_STEPS) if (step * pow >= max) return Math.round(step * pow * 1e9) / 1e9;   // (rounding hides 0.1 * 3 = 0.30000000000000004)
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

// The time of the earliest day in an answers-per-day Map (dayKey -> count) that has answers, or null.
export function firstAnswerTime(perDay) {
  let best = null;
  for (const [k, n] of perDay) {
    if (!n) continue;
    const [y, m, d] = k.split('-').map(Number);
    const t = new Date(y, m - 1, d, 12).getTime();
    if (best === null || t < best) best = t;
  }
  return best;
}
