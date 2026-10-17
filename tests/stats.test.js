// Tests for js/stats-calc.js (numbers on the Stats tab). Run with: node tests/stats.test.js

import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { dayKey, daysAgoStart, dayStreak, retention, isDueReview, reviewsPerDay, dueForecast, hardestCards, niceMax, studyCalendar, buttonCounts, hourly, difficultyBands, answerDays, streakFromDays, calendarFromDays, lazyStreak, streakRuns, streakText, weekOf, restDaySet } from '../js/stats-calc.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();   // 7 Oct 2026, 3pm
const HOUR = 3600000, DAY = 24 * HOUR;
const at = (daysAgo, hour = 12) => { const d = new Date(daysAgoStart(daysAgo, NOW)); d.setHours(hour); return d.getTime(); };
const log = (daysAgo, extra = {}) => ({ cardId: 'a', timestamp: at(daysAgo), source: 'review', correct: true, state: 2, ...extra });

test('day keys follow the 4am study day', () => {
  assert.equal(dayKey(NOW), '2026-10-07');
  assert.equal(dayKey(new Date(2026, 9, 8, 2).getTime()), '2026-10-07');   // 2am counts as the day before
  assert.equal(dayKey(new Date(2026, 9, 8, 5).getTime()), '2026-10-08');
  assert.equal(dayKey(daysAgoStart(1, NOW)), '2026-10-06');
  assert.equal(dayKey(daysAgoStart(-2, NOW)), '2026-10-09');
});

test('streak counts back from today', () => {
  const logs = [log(0), log(1), log(2), log(4)];
  // v4.1 (streak freeze): the missed Sunday (3 days ago) is covered by the week's freeze, so the run reaches Saturday
  // and the streak is 4, not 3. Without freezes it is the old 3.
  const s = dayStreak(logs, NOW);
  assert.equal(s.days, 4);
  assert.equal(dayStreak(logs, NOW, { freezes: false }).days, 3);
  assert.equal(s.studiedToday, true);
  assert.deepEqual(s.week.map(d => d.on), [false, false, true, false, true, true, true]);
  assert.equal(s.week[6].today, true);
});

test('streak still counts if you have not studied yet today', () => {
  assert.equal(dayStreak([log(1), log(2)], NOW).days, 2);
  assert.equal(dayStreak([log(1), log(2)], NOW).studiedToday, false);
  // v4.1: with only Monday studied, yesterday (Tuesday) is covered by a streak freeze, so the streak is 1, not 0.
  // Without freezes the old rule still gives 0. Nothing studied for two days is a real break.
  assert.equal(dayStreak([log(2)], NOW).days, 1);
  assert.equal(dayStreak([log(2)], NOW, { freezes: false }).days, 0);
  assert.equal(dayStreak([log(3)], NOW).days, 0);
  assert.equal(dayStreak([], NOW).days, 0);
});

test('Play answers count toward the streak', () => {
  assert.equal(dayStreak([log(0, { source: 'play' })], NOW).days, 1);
});

test('retention: due reviews in the last 30 days', () => {
  const logs = [
    log(1), log(2), log(3, { correct: false }),                          // 2 of 3 remembered
    log(1, { state: 0, correct: false }),                                // new card: not a due review
    log(1, { state: 1, correct: false }),                                // learning step: not counted
    log(40, { correct: false }),                                         // too old
    log(0, { source: 'play', mode: 'typing', reason: 'due', correct: true }),   // Play typing that was the card's review
    log(0, { source: 'play', mode: 'front', reason: 'due', correct: true }),    // Play multiple choice on a due card: guessable, not counted
    log(0, { source: 'play', reason: 'not-due', correct: true }),        // Play on a card not due: not counted
    log(0, { source: 'play', reason: 'again', correct: false })          // not due, missed: not a due review
  ];
  const r = retention(logs, NOW);
  assert.deepEqual([r.remembered, r.total], [3, 4]);
  assert.equal(r.rate, 0.75);
  assert.equal(retention([], NOW).rate, null);
});

test('older Play logs without a reason count when they changed the schedule', () => {
  assert.equal(isDueReview({ source: 'play', state: 2, applied: true }), true);
  assert.equal(isDueReview({ source: 'play', state: 2, applied: false }), false);
});

test('reviews per day, split by source', () => {
  const rows = reviewsPerDay([log(0), log(0, { source: 'play' }), log(2), log(31), log(0, { source: 'test' })], NOW);
  assert.equal(rows.length, 30);
  assert.deepEqual(rows[29], { time: daysAgoStart(0, NOW), review: 1, play: 1, total: 2 });
  assert.equal(rows[27].total, 1);
  assert.equal(rows.reduce((n, r) => n + r.total, 0), 3);
});

test('due forecast for the next 7 days', () => {
  const states = [
    { state: 2, due: NOW - 3 * DAY },     // overdue: today
    { state: 2, due: NOW + 2 * HOUR },    // later today
    { state: 1, due: NOW + 10 * 60000 },  // learning card: today
    { state: 2, due: NOW + 1 * DAY },     // tomorrow
    { state: 2, due: NOW + 6 * DAY },     // day 6
    { state: 2, due: NOW + 20 * DAY },    // beyond the week
    { state: 0, due: NOW }                // new: not counted
  ];
  assert.deepEqual(dueForecast(states, NOW).map(d => d.count), [3, 1, 0, 0, 0, 0, 1]);
  assert.equal(dayKey(dueForecast(states, NOW)[1].time), '2026-10-08');
});

test('hardest cards: most lapses, then most misses', () => {
  const cards = ['a', 'b', 'c', 'd'].map(id => ({ id, front: id }));
  const states = new Map([['a', { lapses: 1 }], ['b', { lapses: 4 }], ['c', { lapses: 0 }]]);
  const logs = [{ cardId: 'c', timestamp: at(1), source: 'play', correct: false }, { cardId: 'a', timestamp: at(1), source: 'review', correct: false }, { cardId: 'a', timestamp: at(2), source: 'review', correct: false }];
  const h = hardestCards(cards, states, logs, NOW);
  assert.deepEqual(h.map(x => x.card.id), ['b', 'a', 'c']);     // d has never been missed
  assert.deepEqual([h[1].lapses, h[1].misses], [1, 2]);
});

test('clean axis tops', () => {
  assert.deepEqual([0, 3, 7, 12, 48, 51, 180, 1000].map(niceMax), [5, 3, 8, 15, 50, 60, 200, 1000]);
  // finer steps: 38 gets 40 (not 50), 111 gets 150 (not 200), and a peak of 90 gets 100
  assert.deepEqual([1, 2, 2.2, 4, 7, 9, 10, 11, 38, 90, 111, 240, 260, 900].map(niceMax), [1, 2, 2.5, 4, 8, 10, 10, 15, 40, 100, 150, 250, 300, 1000]);
  // never below the biggest value, never more than 1.5x it (above 1), so a chart's tallest bar fills at least two thirds
  for (let v = 2; v <= 5000; v++) { const m = niceMax(v); assert.ok(m >= v && m <= v * 1.5, `${v} -> ${m}`); }
  // small fractions stay clean numbers
  assert.deepEqual([0.3, 0.07].map(niceMax), [0.3, 0.08]);
});

test('study calendar: weeks start on Monday, newest on the right, darker on busier days', () => {
  // 7 Oct 2026 is a Wednesday. Answers: 2 today, 1 yesterday, 1 three days ago, and 3 days in a row a while back.
  const logs = [log(0), log(0), log(1), log(3), log(8), log(9), log(10)];
  const cal = studyCalendar(logs, NOW, 3);
  assert.equal(cal.weeks.length, 3);
  assert.ok(cal.weeks.every(w => w.length === 7));
  assert.equal(new Date(cal.weeks[0][0].time).getDay(), 1);                     // a Monday
  assert.equal(new Date(cal.weeks[0][0].time).getDate(), 21);                   // 21 Sep
  const today = cal.weeks[2][2];                                                 // this week's Wednesday
  assert.equal(dayKey(today.time), dayKey(NOW));
  assert.deepEqual([today.count, today.level], [2, 4]);
  assert.deepEqual([cal.weeks[2][1].count, cal.weeks[2][1].level], [1, 2]);     // yesterday
  assert.ok(cal.weeks[2].slice(3).every(d => d.future && d.count === 0));         // Thu–Sun haven't happened yet
  assert.equal(cal.daysStudied, 6);
  assert.equal(cal.answers, 7);
  assert.equal(cal.daysShown, 17);
  assert.equal(cal.longest, 3);
});

test('study calendar with no answers', () => {
  const cal = studyCalendar([], NOW);
  assert.equal(cal.weeks.length, 53);
  assert.deepEqual([cal.max, cal.daysStudied, cal.longest], [0, 0, 0]);
});


test('answer buttons: learning vs review, last 30 days', () => {
  const logs = [log(0, { rating: 3, state: 2 }), log(1, { rating: 1, state: 2, correct: false }), log(2, { rating: 4, state: 2 }), log(3, { rating: 2, state: 0 }),
    log(40, { rating: 1, state: 2 }), log(1, { source: 'play', rating: 3, state: 2 }), log(1, { source: 'review', rating: 3, state: 1 })];
  const b = buttonCounts(logs, NOW);
  assert.deepEqual(b.review, [1, 0, 2, 1]);
  assert.deepEqual(b.learning, [0, 1, 1, 0]);
  assert.equal(b.reviewRight, 75);
  assert.equal(buttonCounts([], NOW).reviewRight, null);
});

test('time of day', () => {
  const at9 = d => { const t = new Date(daysAgoStart(d, NOW)); t.setHours(9, 30); return t.getTime(); };
  const h = hourly([{ ...log(0), timestamp: at9(0) }, { ...log(1), timestamp: at9(1), correct: false }, log(0)], NOW);
  assert.equal(h.length, 24);
  assert.deepEqual([h[9].total, h[9].right], [2, 1]);
  assert.equal(h[12].total, 1);
});

test('difficulty bands', () => {
  const b = difficultyBands([{ state: 2, difficulty: 1 }, { state: 2, difficulty: 5.5 }, { state: 3, difficulty: 10 }, { state: 0, difficulty: 5 }, null]);
  assert.deepEqual(b.filter(x => x.count).map(x => [x.band, x.count]), [[1, 1], [6, 1], [10, 1]]);
});

test('answerDays counts answers per day, once for every deck and once for the picked cards', () => {
  const logs = [log(0), log(0, { cardId: 'b' }), log(1, { cardId: 'b' }), log(2, { source: 'import' })];
  const { all, picked } = answerDays(logs, new Set(['b']));
  assert.equal(all.get(dayKey(NOW)), 2);
  assert.equal(all.size, 2);                       // the 'import' row is not an answer
  assert.equal(picked.get(dayKey(NOW)), 1);
  assert.equal(picked.get(dayKey(at(1))), 1);
  const same = answerDays(logs);
  assert.equal(same.picked, same.all);             // no filter: one Map
});

test('streak and calendar from counted days match the versions that take logs', () => {
  const logs = [log(0), log(1), log(2), log(2), log(5), log(40)];
  const { all } = answerDays(logs);
  assert.deepEqual(streakFromDays(all, NOW), dayStreak(logs, NOW));
  assert.deepEqual(calendarFromDays(all, NOW), studyCalendar(logs, NOW));
});

test('lazy streak reads further back only while the streak does, and matches the full one', async () => {
  const all = [];
  for (let d = 0; d < 200; d++) all.push(log(d));        // a 200-day streak
  all.push(log(205));
  const asked = [];
  const read = async since => { asked.push(since); return all.filter(l => l.timestamp >= since); };
  const s = await lazyStreak(read, NOW);
  assert.equal(s.days, 200);
  assert.deepEqual(s, dayStreak(all, NOW));
  assert.equal(asked.length, 3);                          // 60 days, 120, then 240 days: enough to see it end
  asked.length = 0;
  assert.equal((await lazyStreak(read, NOW, all.filter(l => l.timestamp >= daysAgoStart(60, NOW)).slice(0, 0).concat([log(0)]))).days, 1);
  assert.equal(asked.length, 0);                          // a short streak in the logs already loaded needs no more reading
});


// ---------- streak freeze and days off (v4.1) ----------
// NOW is Wed 7 Oct 2026; weeks run Monday to Sunday: days ago 0 = Wed, 1 = Tue, 2 = Mon (this week), 3 = Sun, 4 = Sat …
const key = (n, now = NOW) => dayKey(daysAgoStart(n, now));
const set = (...ns) => new Set(ns.map(n => key(n)));
const walkOf = (studied, rest = [], now = NOW, opts = {}) => streakFromDays(set(...studied), now, { rest: set(...rest), ...opts });

test('weekOf gives the Monday', () => {
  assert.equal(weekOf('2026-10-07'), '2026-10-05');
  assert.equal(weekOf('2026-10-05'), '2026-10-05');
  assert.equal(weekOf('2026-10-11'), '2026-10-05');       // Sunday belongs to the week that began on Monday
  assert.equal(weekOf('2026-10-04'), '2026-09-28');
  assert.equal(weekOf('2026-03-29'), '2026-03-23');       // a daylight-saving Sunday in much of Europe
});

test('freeze: a missed yesterday is covered and does not add to the count', () => {
  const s = walkOf([0, 2, 3, 4]);
  assert.equal(s.days, 4);                                 // 4 studied days; the covered Tuesday is not counted
  assert.deepEqual(s.frozen, [key(1)]);
  assert.deepEqual(s.week.map(d => d.frozen), [false, false, false, false, false, true, false]);
  assert.deepEqual(s.freeze, { ready: false, usedOn: key(1) });
  // not studied yet today: the same run, waiting for today
  const t = walkOf([2, 3, 4]);
  assert.equal(t.days, 3);
  assert.deepEqual(t.frozen, [key(1)]);
  assert.equal(t.studiedToday, false);
});

test('freeze: two missed days in a row break the streak', () => {
  const s = walkOf([0, 3, 4]);
  assert.equal(s.days, 1);
  assert.deepEqual(s.frozen, []);
  assert.equal(s.freeze.ready, true);                      // the dropped freeze is not "used"
});

test('freeze: only one a week, and it stays on the EARLIEST missed day (owner decision 14 Oct)', () => {
  const sat = new Date(2026, 9, 10, 12).getTime();         // Sat 10 Oct: this week is Mon 5 to Sun 11
  // studied Sat, Thu, Tue: Wed and Fri are both missed. The freeze belongs to Wed (the earlier one), so Fri
  // ends the streak. (Before v4.2.1 the freeze moved to the newest miss, Fri, and the streak was 2.)
  const s = streakFromDays(new Set([0, 2, 4].map(n => key(n, sat))), sat);
  assert.equal(s.days, 1);
  assert.deepEqual(s.frozen, []);
  assert.equal(s.span, 1);
});

test('freeze: misses in different weeks are both covered', () => {
  const s = walkOf([0, 2, 3, 4, 6, 7]);                    // Tue 6 Oct and Fri 2 Oct missed (two different weeks)
  assert.equal(s.days, 6);
  assert.deepEqual(s.frozen, [key(1), key(5)]);
});

test('freeze: a Sunday and Monday gap is two missed days, so it breaks', () => {
  const s = walkOf([0, 1, 4]);                             // Mon (2) and Sun (3) missed
  assert.equal(s.days, 2);
  assert.deepEqual(s.frozen, []);
});

test('freeze: with nothing studied before the miss, the streak is 0 and a freeze stays ready', () => {
  assert.equal(walkOf([]).days, 0);
  assert.deepEqual(walkOf([]).freeze, { ready: true, usedOn: null });
  const s = walkOf([0]);                                   // only today: yesterday cannot be covered by anything
  assert.equal(s.days, 1);
  assert.deepEqual(s.frozen, []);
});

test('freeze: {freezes:false} keeps the old rules', () => {
  assert.equal(walkOf([0, 2, 3, 4], [], NOW, { freezes: false }).days, 1);
  assert.equal(walkOf([0, 1, 2, 4], [], NOW, { freezes: false }).days, 3);
  assert.deepEqual(walkOf([0, 2], [], NOW, { freezes: false }).frozen, []);
});

test('freeze: the 4am rollover decides which day an answer is in', () => {
  const before4 = new Date(2026, 9, 7, 3, 59).getTime();    // belongs to Tue 6 Oct
  const after4 = new Date(2026, 9, 7, 4, 0).getTime();      // belongs to Wed 7 Oct
  const now = new Date(2026, 9, 7, 15).getTime();
  const a = dayStreak([{ timestamp: before4 }], now);
  assert.deepEqual([a.days, a.studiedToday], [1, false]);
  const b = dayStreak([{ timestamp: after4 }], now);
  assert.deepEqual([b.days, b.studiedToday], [1, true]);
  // at 2am on Thu the study day is still Wed: Wed's answer is "today", Tue is covered, Mon counts
  const late = new Date(2026, 9, 8, 2).getTime();
  const c = dayStreak([{ timestamp: before4 - 86400000 }, { timestamp: after4 }], late);   // Mon 5 and Wed 7
  assert.deepEqual([c.days, c.studiedToday, c.frozen], [2, true, [key(1, late)]]);
});

test('freeze: a daylight-saving week gives the same answer (run under TZ=Europe/London)', () => {
  // The check itself is in stats-dst.child.mjs. It runs in its own node with an explicit time zone, so this
  // passes (and means something) on any machine, not just one that happens to be in a zone with a change on 29 Mar.
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./stats-dst.child.mjs', import.meta.url))], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tz=Europe\/London/);
});

test('freeze: lazyStreak over 200 days matches the full walk, with a covered day inside', async () => {
  const all = [];
  for (let d = 0; d < 200; d++) if (d !== 100) all.push(log(d));     // day 100 is a covered miss
  all.push(log(205));
  const asked = [];
  const read = async since => { asked.push(since); return all.filter(l => l.timestamp >= since); };
  const s = await lazyStreak(read, NOW);
  assert.equal(s.days, 199);
  assert.deepEqual(s, dayStreak(all, NOW));
  assert.equal(s.frozen.length, 1);
  assert.equal(asked.length, 3);
  // and with days off passed through
  const withRest = await lazyStreak(read, NOW, null, 60, { rest: set(201, 202) });
  assert.deepEqual(withRest, dayStreak(all, NOW, { rest: set(201, 202) }));
});

test('days off: they bridge a gap, add nothing, and never break the streak', () => {
  // Today and yesterday studied, Mon and Sun off, Sat to Thu studied
  const s = walkOf([0, 1, 4, 5, 6], [2, 3]);
  assert.equal(s.days, 5);
  assert.deepEqual(s.frozen, []);
  assert.deepEqual(walkOf([0, 1], [2, 3, 4, 5, 6, 7]).days, 2);           // a long run of days off, nothing before it
  assert.equal(walkOf([0, 2], [1]).days, 2);                               // a day off between two studied days
  // not studied today but today is a day off: safe
  const r = walkOf([1, 2], [0]);
  assert.deepEqual([r.days, r.restToday, r.studiedToday], [2, true, false]);
  assert.deepEqual(r.week.map(d => d.rest), [false, false, false, false, false, false, true]);
  // a day off the person studied on counts as studied
  assert.equal(walkOf([0, 1], [0]).restToday, false);
});

test('days off: a day off followed by a missed day, which the freeze can still cover', () => {
  const s = walkOf([0, 1, 4], [2]);                        // Mon off, Sun missed, Sat studied
  assert.equal(s.days, 3);
  assert.deepEqual(s.frozen, [key(3)]);
  assert.equal(walkOf([0, 1, 5], [2]).days, 2);            // Sun and Sat both missed: not both covered
});

test('restDaySet reads the setting and ignores junk', () => {
  const found = restDaySet({ restDays: { '2026-10-08': { on: true, at: 1 }, '2026-10-09': { on: false, at: 2 }, nope: { on: true }, '2026-10-10': null, '2026-10-11': 'yes' } });
  assert.deepEqual([...found], ['2026-10-08']);
  for (const bad of [undefined, null, {}, { restDays: 5 }, { restDays: null }, { restDays: [] }]) assert.equal(restDaySet(bad).size, 0);
});

test('streakText: the line and the freeze note', () => {
  const text = s => streakText(s, NOW);
  assert.deepEqual(text(walkOf([0, 1, 2])), { line: 'Kept for today', sub: '1 freeze ready this week' });
  assert.equal(text(walkOf([1, 2])).line, 'Study today to keep it');
  assert.equal(text(walkOf([])).line, 'Study today to start one');
  assert.equal(text(walkOf([])).sub, '');
  assert.equal(text(walkOf([1, 2], [0])).line, 'Rest day · your streak is safe');
  const used = text(walkOf([2, 3, 4]));
  assert.equal(used.line, 'Freeze used yesterday · study today to keep it');
  assert.match(used.sub, /^Freeze used \w+/);
  assert.match(text(walkOf([0, 2, 3, 4])).sub, /^Freeze used /);
  assert.equal(text(walkOf([0, 2, 3, 4])).line, 'Kept for today');
});

test('calendar: the best streak includes covered days, and covered and rest days are flagged', () => {
  const perDay = new Map([...set(0, 2, 3, 4, 5, 12, 13)].map(k => [k, 1]));    // run of 5 (Tue covered), then a gap, then 2
  const cal = calendarFromDays(perDay, NOW, 4, { rest: set(7) });
  assert.equal(cal.longest, 5);
  assert.equal(calendarFromDays(perDay, NOW, 4, { freezes: false }).longest, 4);
  const cells = cal.weeks.flat();
  const at = n => cells.find(c => dayKey(c.time) === key(n));
  assert.equal(at(1).frozen, true);
  assert.equal(at(1).count, 0);
  assert.equal(at(7).rest, true);
  assert.equal(at(7).frozen, false);
  assert.equal(at(2).frozen, false);
  assert.deepEqual([...streakRuns(perDay, NOW).frozen], [key(1)]);
  // an older run counts too, with its own cover
  const old = new Map([...set(0, 10, 11, 13, 14, 15)].map(k => [k, 1]));     // 12 is covered
  assert.equal(streakRuns(old, NOW).longest, 5);
  assert.equal(streakRuns(new Map(), NOW).longest, 0);
});

test('calendar: the best streak matches a walk from today when the run is current', () => {
  const days = set(0, 1, 3, 4, 5, 6);                      // Wed 7 - Thu 1: Mon (2) is covered
  const cur = streakFromDays(days, NOW);
  const perDay = new Map([...days].map(k => [k, 1]));
  assert.equal(cur.days, 6);
  assert.equal(streakRuns(perDay, NOW).longest, cur.days);
  assert.deepEqual([...streakRuns(perDay, NOW).frozen], cur.frozen);
});


// ---------- v4.2.1 review fixes ----------
test('freeze stays on the EARLIEST missed day of the week (owner decision): a later miss ends the streak', () => {
  const FRI = new Date(2026, 9, 9, 12).getTime();           // Fri 9 Oct; this week is Mon 5 to Sun 11
  const run = [...Array(9).keys()].map(n => n + 1);          // 9 days back
  const k = (n) => key(n, FRI);
  // Tue 6 Oct (3 days back) missed and covered; Thu 8 (1 back) studied: the streak lives on
  const kept = streakFromDays(new Set(run.filter(n => n !== 3).map(k)), FRI);
  assert.deepEqual(kept.frozen, [k(3)]);
  assert.equal(kept.days, 8);
  // Thu missed as well: the freeze stays on Tue, so Thu (the newer miss) ends the streak
  const broken = streakFromDays(new Set(run.filter(n => n !== 3 && n !== 1).map(k)), FRI);
  assert.equal(broken.days, 0);
  assert.deepEqual(broken.frozen, []);
  assert.deepEqual(streakText(broken, FRI), { line: 'Study today to start one', sub: '' });
  // the best streak still sees Tue covered inside the older run
  const perDay = new Map(run.filter(n => n !== 3 && n !== 1).map(n => [k(n), 1]));
  assert.ok(streakRuns(perDay, FRI).frozen.has(k(3)));
  // an earlier miss that cannot be covered (nothing studied before it) does not take the freeze
  const late = streakFromDays(new Set([0, 2, 3].map(n => key(n, FRI))), FRI);       // Fri, Wed, Tue studied; Thu, Mon, Sun missed
  assert.equal(late.days, 3);                                                         // Mon can't be covered (nothing studied before it), so Thu takes the freeze
  assert.deepEqual(late.frozen, [key(1, FRI)]);
});

test('streakText: no "freeze ready" note when yesterday used last week\'s freeze', () => {
  const MON = new Date(2026, 9, 5, 12).getTime();           // Mon 5 Oct: yesterday (Sun 4) is in the previous week
  const keyM = n => key(n, MON);
  const s = streakFromDays(new Set([2, 3, 4].map(keyM)), MON);        // Sat, Fri, Thu studied; Sun covered
  assert.deepEqual(s.frozen, [keyM(1)]);
  const t = streakText(s, MON);
  assert.equal(t.line, 'Freeze used yesterday · study today to keep it');
  assert.equal(t.sub, '');                                             // missing today would break it, so no "1 freeze ready"
});

test('restDaySet ignores a day off decided on or after the day itself', () => {
  const start = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 4).getTime(); };
  const found = restDaySet({ restDays: {
    '2026-10-08': { on: true, at: start('2026-10-08') - 1 },       // planned before the day: counts
    '2026-10-09': { on: true, at: start('2026-10-09') },           // decided at the day's start: ignored
    '2026-10-10': { on: true, at: start('2026-10-10') + 5 * 3600000 },
    '2026-10-11': { on: true, at: 1 }
  } });
  assert.deepEqual([...found].sort(), ['2026-10-08', '2026-10-11']);
});

test('lazyStreak: timestamps work as well as rows, and match the full walk for random logs (with a freeze looking back)', async () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 40; round++) {
    const gap = 0.05 + rnd() * 0.15;
    const all = [];
    for (let d = 0; d < 160; d++) if (rnd() > gap) all.push(log(d));
    const times = all.map(l => l.timestamp);
    const readTimes = async since => times.filter(t => t >= since);
    const readLogs = async since => all.filter(l => l.timestamp >= since);
    const full = dayStreak(all, NOW);
    assert.deepEqual(await lazyStreak(readTimes, NOW), full, 'timestamps, round ' + round);
    assert.deepEqual(await lazyStreak(readLogs, NOW), full, 'rows, round ' + round);
  }
});

test('readiness note: an estimate with the standard model, then with your own', async () => {
  const { readyEstimateText } = await import('../js/stats-calc.js');
  const standard = readyEstimateText(undefined);
  assert.match(standard, /^It’s an estimate\. It uses the standard FSRS memory model, not one tuned to you yet, and assumes you stop reviewing now\. Treat it as a guide, not a promise\.$/);
  assert.equal(readyEstimateText(null), standard);
  assert.equal(readyEstimateText({}), standard);
  assert.equal(readyEstimateText({ w: 'nope' }), standard);
  const { cleanFsrsParams, FSRS_VERSION, FSRS_W_COUNT } = await import('../js/sched-settings.js');
  const at = new Date(2026, 9, 12, 12).getTime();
  const w = Array.from({ length: FSRS_W_COUNT }, (_, i) => 0.5 + i / 10);
  const tuned = readyEstimateText(cleanFsrsParams({ w, at, reviews: 4812, cards: 900, version: FSRS_VERSION }), 'en-GB');
  assert.equal(tuned, 'It’s an estimate from your own memory model (tuned on 12 Oct from 4,812 reviews), assuming you stop reviewing now.');
  assert.equal(readyEstimateText(cleanFsrsParams({ w, version: FSRS_VERSION })), 'It’s an estimate from your own memory model, assuming you stop reviewing now.');
  // reset to the standard weights (w: null) and junk both read as the standard model
  assert.equal(readyEstimateText(cleanFsrsParams({ w: null, at, version: FSRS_VERSION })), standard);
  assert.equal(readyEstimateText(cleanFsrsParams({ w: [1, 2], version: FSRS_VERSION })), standard);
});
