// "Nothing due" days must not break the streak or use a freeze (QA v4.14, minor 4). Run with: node --test tests/idle-days.test.js

import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { dayKey, daysAgoStart, streakFromDays, streakText, idleDaySet, calendarFromDays, lazyStreak } from '../js/stats-calc.js';
import { idleDaysToMark, countFor } from '../js/study-data.js';
import { splitCards, newLimits, reviewLimits } from '../js/queue.js';
import { chainMap } from '../js/deck-tree.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();     // Wed 7 Oct 2026, 3pm
const DAY = 86400000;
const key = (n, now = NOW) => dayKey(daysAgoStart(n, now));
const set = (...ns) => new Set(ns.map(n => key(n)));
const walk = (studied, idle = [], now = NOW, opts = {}) => streakFromDays(set(...studied), now, { idle: set(...idle), ...opts });

test('a quiet day (nothing due) is bridged: it adds nothing and uses no freeze', () => {
  const s = walk([0, 2, 3], [1]);
  assert.equal(s.days, 3);
  assert.deepEqual(s.frozen, []);
  assert.equal(s.freeze.usedOn, null);
  // Without the note the same history spends the freeze on that day.
  assert.deepEqual(walk([0, 2, 3]).frozen, [key(1)]);
  // Two quiet days in a row are fine too (two missed days would break it).
  assert.equal(walk([0, 3, 4], [1, 2]).days, 3);
  assert.equal(walk([0, 3, 4]).days, 1);
});

test('a quiet day leaves the freeze for a day that was really missed', () => {
  const s = walk([0, 1, 3, 5, 6], [2, 4]);
  assert.deepEqual(s.frozen, []);
  assert.equal(s.days, 5);
  const t = walk([0, 1, 2, 4], [3]);             // day 3 quiet; nothing missed
  assert.deepEqual([t.days, t.frozen], [4, []]);
  const u = walk([0, 1, 2, 4, 5, 7], [3]);       // day 3 quiet; day 6 missed: the week's freeze covers it
  assert.equal(u.days, 6);
  assert.deepEqual(u.frozen, [key(6)]);
});

test('today: with nothing due and not studied the streak line says it is safe', () => {
  const s = walk([1, 2], [0]);
  assert.deepEqual([s.days, s.studiedToday, s.idleToday, s.restToday], [2, false, true, false]);
  assert.equal(streakText(s, NOW).line, 'Nothing due today: your streak is safe');
  assert.equal(walk([1, 2], []).idleToday, false);
  assert.equal(streakText(walk([1, 2]), NOW).line, 'Study today to keep it');
  // Studied after all: a normal day. A planned day off stays the reason when both apply.
  assert.equal(walk([0, 1], [0]).idleToday, false);
  assert.equal(streakText(walk([0, 1], [0]), NOW).line, 'Kept for today');
  const both = walk([1, 2], [0], NOW, { rest: set(0) });
  assert.deepEqual([both.restToday, both.idleToday], [true, false]);
  assert.equal(streakText(both, NOW).line, 'Rest day · your streak is safe');
});

test('the week dots mark a quiet day', () => {
  const s = walk([0, 2], [1]);
  assert.deepEqual(s.week.map(d => [d.rest, d.idle]), [[false, false], [false, false], [false, false], [false, false], [false, false], [true, true], [false, false]]);
});

test('idleDaySet reads the setting and ignores junk', () => {
  assert.deepEqual([...idleDaySet({ idleDays: { '2026-10-08': true, '2026-10-09': false, nope: true, '2026-10-10': 'yes', '2026-10-11': null } })], ['2026-10-08']);
  for (const bad of [undefined, null, {}, { idleDays: 5 }, { idleDays: null }, { idleDays: [] }]) assert.equal(idleDaySet(bad).size, 0);
});

test('the 4am rollover: at 2am the quiet day is still yesterday; at 5am it bridges the gap', () => {
  const late = new Date(2026, 9, 8, 2).getTime();                  // 2am Thu 8 Oct: the study day is still Wed 7
  const k = n => dayKey(daysAgoStart(n, late));
  const s = streakFromDays(new Set([k(1), k(2)]), late, { idle: new Set([k(0)]) });     // Tue and Mon studied; Wed (today) quiet
  assert.equal(dayKey(late), '2026-10-07' === k(0) ? k(0) : 'x');
  assert.equal(k(0), '2026-10-07');
  assert.deepEqual([s.days, s.idleToday], [2, true]);
  const early = new Date(2026, 9, 8, 5).getTime();                 // 5am Thu: Wed is over
  const e = n => dayKey(daysAgoStart(n, early));
  const t = streakFromDays(new Set([e(2), e(3)]), early, { idle: new Set([e(1)]) });
  assert.equal(e(1), '2026-10-07');
  assert.deepEqual([t.days, t.frozen], [2, []]);
});

test('across a daylight-saving change (TZ=Europe/London)', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./idle-dst.child.mjs', import.meta.url))], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tz=Europe\/London/);
});

test('lazyStreak and the calendar take the quiet days too', async () => {
  const logs = [0, 2, 3, 4].map(n => ({ timestamp: daysAgoStart(n, NOW) + 12 * 3600000, source: 'review' }));
  const idle = set(1);
  const s = await lazyStreak(async since => logs.filter(l => l.timestamp >= since), NOW, null, 60, { idle });
  assert.equal(s.days, 4);
  const perDay = new Map(logs.map(l => [dayKey(l.timestamp), 1]));
  const cal = calendarFromDays(perDay, NOW, 4, { rest: idle });
  assert.equal(cal.longest, 4);
});

// ---------- finding the quiet days (idleDaysToMark) ----------
// (These use the real clock: the queue code that counts what is due reads it.)
const T = Date.now();
const k = n => dayKey(daysAgoStart(n, T));
const decks = [{ id: 'a', name: 'A', created: 1 }];
function world({ states = [], newCards = 0, logs = [], settings = {} }) {
  const cards = [], statesById = new Map();
  states.forEach((st, i) => { cards.push({ id: 'c' + i, deckId: 'a', front: 'f', back: 'b', created: i }); statesById.set('c' + i, { cardId: 'c' + i, state: 2, ...st }); });
  for (let i = 0; i < newCards; i++) cards.push({ id: 'n' + i, deckId: 'a', front: 'f', back: 'b', created: 100 + i });
  const deckOf = new Map(cards.map(c => [c.id, c.deckId])), chains = chainMap(decks);
  const data = { decks, cards, allCards: cards, statesById, deckOf, logs: [], chains, settings, exam: { caps: new Map() },
    newLeft: newLimits({ perDay: 20, decks, logs: [], deckOf, chains }), reviewLeft: reviewLimits({ perDay: Infinity, decks, logs: [], deckOf, chains }) };
  data.split = splitCards(cards, statesById, T, data.exam); data.splitAt = T;
  return { data, history: logs };
}
const answerOn = n => ({ timestamp: daysAgoStart(n, T) + 10 * 3600000, source: 'review' });

test('idleDaysToMark: today is noted when the ring says "Nothing due today", and only today', () => {
  const { data } = world({ states: [{ due: T + 6 * DAY }, { due: T + 9 * DAY }] });
  assert.equal(countFor(data, ['a']).total, 0);
  assert.deepEqual(idleDaysToMark(data, T), [k(0)]);              // never the days before, however long ago the last answer was
});

test('idleDaysToMark: a card due today or overdue, or new cards on offer, mean today is not quiet', () => {
  assert.deepEqual(idleDaysToMark(world({ states: [{ due: daysAgoStart(1, T) + 9 * 3600000 }, { due: T + 9 * DAY }] }).data, T), []);
  assert.deepEqual(idleDaysToMark(world({ states: [{ due: T + 60000 }, { due: T + 9 * DAY }] }).data, T), []);        // due later today
  assert.deepEqual(idleDaysToMark(world({ states: [{ due: T + 6 * DAY }], newCards: 3 }).data, T), []);
});

test('idleDaysToMark: suspending or burying the overdue cards cannot fake a quiet day', () => {
  for (const hide of [{ suspended: true }, { buriedUntil: T + DAY }]) {
    const { data } = world({ states: [{ due: daysAgoStart(4, T) }, { due: T + 9 * DAY }] });
    data.allCards[0] = { ...data.allCards[0], ...hide };
    data.cards = data.allCards.filter(c => !c.suspended && !(c.buriedUntil > T));
    data.split = splitCards(data.cards, data.statesById, T, data.exam);
    assert.deepEqual(idleDaysToMark(data, T), [], JSON.stringify(hide));
  }
});

test('idleDaysToMark: nothing with no cards, and a day already noted is not repeated', () => {
  assert.deepEqual(idleDaysToMark(world({ states: [] }).data, T), []);
  assert.deepEqual(idleDaysToMark(world({ states: [{ due: T + 6 * DAY }], settings: { idleDays: { [k(0)]: true } } }).data, T), []);
});

test('idleDaysToMark: before 4am it is still the day before', () => {
  const early = daysAgoStart(0, T) + 2 * 3600000;       // 2am: still yesterday's study day
  const { data } = world({ states: [{ due: T + 6 * DAY }] });
  assert.deepEqual(idleDaysToMark(data, early), [dayKey(early)]);
});

test('a day that is noted keeps the streak; days the app was not opened are for freezes', () => {
  assert.equal(walk([1, 2], [0]).days, 2);
  assert.equal(walk([3, 4], []).days, 0);              // two missed days, no note: broken (only one freeze)
});

test('idleDaysToMark: suspending or burying the unseen new cards cannot fake a quiet day', () => {
  for (const hide of [{ suspended: true }, { buriedUntil: T + DAY }]) {
    const { data } = world({ states: [{ due: T + 9 * DAY }], newCards: 5 });
    data.allCards = data.allCards.map(c => (c.id.startsWith('n') ? { ...c, ...hide } : c));
    data.cards = data.allCards.filter(c => !c.suspended && !(c.buriedUntil > T));
    data.split = splitCards(data.cards, data.statesById, T, data.exam);
    assert.equal(countFor(data, ['a']).total, 0, 'the ring itself looks quiet: ' + JSON.stringify(hide));
    assert.deepEqual(idleDaysToMark(data, T), [], JSON.stringify(hide));
  }
});

test('idleDaysToMark: a new-card limit of 0 leaves a real quiet day (and so does a postponed review)', () => {
  const { data } = world({ states: [{ due: T + 9 * DAY }], newCards: 5 });
  data.newLeft = newLimits({ perDay: 0, decks, logs: [], deckOf: data.deckOf, chains: data.chains });
  data.split = splitCards(data.cards.filter(c => !c.id.startsWith('n')), data.statesById, T, data.exam);
  data.cards = data.cards.filter(c => !c.id.startsWith('n'));
  assert.deepEqual(idleDaysToMark(data, T), [k(0)]);
});

test('a long streak keeps its quiet days: the 3650-day prune does not cut it', async () => {
  const { mergeIdleDays } = await import('../js/sync-merge.js');
  const idleN = [150, 151, 210, 211];
  const studied = new Set();
  for (let i = 0; i <= 260; i++) if (!idleN.includes(i)) studied.add(k(i));
  const flags = Object.fromEntries(idleN.map(n => [k(n), true]));
  const pruned = mergeIdleDays(flags, { [k(0)]: true }, T);
  assert.equal(Object.keys(pruned).length, 5);
  assert.equal(streakFromDays(studied, T, { idle: idleDaySet({ idleDays: pruned }) }).days, 257);      // (261 days, 4 of them quiet and not counted)
});

test('the "Nothing due today" line needs the ring to still say nothing: loadStreak drops idleToday otherwise', () => {
  const s = streakFromDays(new Set([k(1), k(2)]), T, { idle: new Set([k(0)]) });
  assert.equal(streakText(s, T).line, 'Nothing due today: your streak is safe');
  assert.equal(streakText({ ...s, idleToday: false }, T).line, 'Study today to keep it');
});
