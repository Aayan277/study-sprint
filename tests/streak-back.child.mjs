// Run by tests/streak-back.test.js once for each time zone (TZ is set by the parent).
// lazyStreakBack (asks which days had answers, each stretch once) must give exactly the streak lazyStreak (reads everything since a
// time, again and again) gives, for many random histories: freezes, days off, nothing-due days, answers at the edges of the 4am
// rollover, answers in the future, and "today" on and around the daylight-saving changes of the zone.
import assert from 'node:assert/strict';
import { dayKey, daysAgoStart, lazyStreak, lazyStreakBack } from '../js/stats-calc.js';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
assert.equal(new Intl.DateTimeFormat('en', { timeZone: process.env.TZ }).resolvedOptions().timeZone, zone, 'the time zone was not set');       // (some zones are known by another name)
let seed = Number(process.env.SEED) || 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];

// A time `n` calendar days before the date of `base`, at hour h:m:s.ms of that day (wall-clock, so DST is respected).
const at = (base, n, h, m = 0, s = 0, ms = 0) => { const d = new Date(base); d.setDate(d.getDate() - n); d.setHours(h, m, s, ms); return d.getTime(); };
const TIMES = [[0, 0], [3, 59, 59, 999], [4, 0], [4, 0, 0, 1], [2, 30], [1, 30], [12, 0], [23, 59, 59, 999], [rnd() * 24 | 0, rnd() * 60 | 0]];
const LATE = [[4, 0], [4, 0, 0, 1], [9, 15], [12, 0], [18, 40], [23, 59, 59, 999]];       // inside the study day that starts on that date
// Dates near the clock changes of 2026 in the zones tested, plus any day of the year.
const NEAR = [[2026, 2, 8], [2026, 2, 29], [2026, 3, 5], [2026, 9, 4], [2026, 9, 25], [2026, 10, 1], [2026, 2, 15], [2026, 2, 28], [2026, 2, 30], [2026, 3, 1]];

let cases = 0, compared = 0, longest = 0, long = 0;
for (let round = 0; round < Number(process.env.ROUNDS || 300); round++) {
  const [y, m, d] = rnd() < 0.5 ? pick(NEAR) : [2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28)];
  const hour = pick([0, 1, 2, 3, 3, 4, 4, 5, 9, 14, 23]);
  const now = new Date(y, m, d, hour, Math.floor(rnd() * 60), Math.floor(rnd() * 60)).getTime();
  // History: runs of studied days with gaps (single missed days a freeze can cover, longer ones that break the streak), up to ~700 days back.
  const span0 = pick([20, 60, 61, 70, 130, 200, 400, 700]);
  const kind = pick(['dense', 'gappy', 'sparse', 'week-gaps', 'run', 'run', 'run-freezes']);
  const gap = kind === 'dense' ? 0.02 : kind === 'gappy' ? 0.12 : kind === 'sparse' ? 0.5 : kind === 'week-gaps' ? 0.25 : 0.4;
  // 'run': an unbroken (or, for 'run-freezes', one-miss-a-week) streak of some length, then a break of 1 to 4 days, then random days.
  const runLen = [30, 55, 59, 60, 61, 67, 68, 69, 100, 119, 120, 121, 127, 128, 129, 200, 239, 240, 247, 248, 300, 500][Math.floor(rnd() * 22)];
  const breakLen = 1 + Math.floor(rnd() * 4);
  const span = kind.startsWith('run') ? Math.max(span0, runLen + 40) : span0;
  const inRun = n => kind.startsWith('run') && n < runLen;
  const inBreak = n => kind.startsWith('run') && n >= runLen && n < runLen + breakLen;
  const times = [];
  for (let n = rnd() < 0.2 ? 1 : 0; n < span; n++) {
    if (kind === 'week-gaps' && n % 7 === 3 && rnd() < 0.7) continue;
    if (inBreak(n)) continue;
    if (kind === 'run-freezes' && inRun(n)) { if (n % 7 === 4 && n > 0) continue; }
    else if (!inRun(n) && rnd() < gap) continue;
    const k = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < k; i++) { const [h, mi, s, ms] = pick(rnd() < 0.7 ? LATE : TIMES); times.push(at(now, n, h, mi, s, ms)); }
  }
  if (rnd() < 0.15) times.push(now + (1 + Math.floor(rnd() * 5)) * 3600000);     // a clock that was ahead: an answer in the future
  if (rnd() < 0.1) times.push(at(now, -1 - Math.floor(rnd() * 3), 12));          // or on a later day
  times.sort((a, b) => a - b);
  // Days off (planned) and nothing-due days among the last 250 days.
  const rest = new Set(), idle = new Set();
  const extras = rnd() < 0.6 ? Math.floor(rnd() * 12) : 0;
  for (let i = 0; i < extras; i++) (rnd() < 0.5 ? rest : idle).add(dayKey(at(now, Math.floor(rnd() * 250), 12)));
  const opts = { rest, idle, ...(rnd() < 0.1 ? { freezes: false } : {}) };

  // The old way: every read is "all answers since a time" (as the times, or as rows).
  const asRows = rnd() < 0.5;
  const rowsOf = list => list.map(t => ({ timestamp: t, source: pick(['review', 'play', 'anki']) }));
  const readSince = async since => { const out = times.filter(t => t >= since); return asRows ? rowsOf(out) : out; };
  // The new way: which days (n back) had an answer.
  const asked = [];
  const readDays = async (from, to) => {
    asked.push([from, to]);
    const out = [];
    for (let n = from; n < to; n++) { const lo = daysAgoStart(n, now), hi = daysAgoStart(n - 1, now); if (times.some(t => t >= lo && t < hi)) out.push(n); }
    return out;
  };
  const first = rnd() < 0.5 ? null : await readSince(daysAgoStart(60, now));
  const want = await lazyStreak(readSince, now, first, 60, opts);
  const got = await lazyStreakBack(readDays, now, first, 60, opts);
  assert.deepEqual(got, want, `${zone} round ${round} (${kind}, span ${span}, now ${new Date(now).toString()})`);
  // Each stretch of days is asked for once, in order, with no day asked twice.
  let next = first ? 60 : 0;
  for (const [from, to] of asked) { assert.equal(from, next, `${zone} round ${round}: the stretches run on from each other`); assert.ok(to > from); next = to; }
  cases++; compared += asked.length; longest = Math.max(longest, want.days || 0); if (want.days > 60) long++;
}

// A short streak with no rows given asks about the first 60 days only, and a streak that ends in the first window asks for nothing more.
{
  const now = new Date(2026, 9, 7, 12).getTime();
  const times = [0, 1, 2].map(n => at(now, n, 10));
  const asked = [];
  const s = await lazyStreakBack(async (from, to) => { asked.push([from, to]); return [0, 1, 2].filter(n => n >= from && n < to); }, now);
  assert.equal(s.days, 3);
  assert.deepEqual(asked, [[0, 60]]);
  assert.equal(times.length, 3);
}
assert.ok(long >= 20 && longest > 120, `the histories should include long streaks (${long} over 60 days, longest ${longest})`);
console.log(`ok tz=${zone} cases=${cases} windows=${compared} streaks over 60 days=${long} longest=${longest}`);
