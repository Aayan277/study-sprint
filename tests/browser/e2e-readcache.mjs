// The kept reads of the cards and schedules (db.getAllCached) must never be older than the data: after every way of saving,
// from another tab too. Also: the quick day lookups behind the streak and Stats (hasLogsIn, getDayCounts, getLogsForCards,
// getLogsBetween) give what counting the log by hand gives, loadStreak gives the streak the old reading gave, and the
// start-up tidy of unused pictures runs once a day and not at all with no pictures.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
const page = await ctx.newPage();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');

// ---------- the kept reads follow every way of saving ----------
const paths = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const out = [];
  const same = async label => {
    for (const name of ['cards', 'cardStates']) {
      const kept = await db.getAllCached(name), fresh = await db.getAll(name);
      if (JSON.stringify(kept) !== JSON.stringify(fresh)) out.push(`${label}: ${name} differ (${kept.length} kept, ${fresh.length} stored)`);
    }
    out.push(`ok ${label}`);
  };
  // Count the real reads of each store.
  const reads = { cards: 0, cardStates: 0 };
  const orig = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...a) { if (this.name in reads) reads[this.name]++; return orig.apply(this, a); };
  const readsAfter = async (name, fn) => { await db.getAllCached(name); const before = reads[name]; await fn(); await db.getAllCached(name); return reads[name] - before; };

  const now = Date.now();
  const deck = (await db.getDecks())[0];
  await same('start');
  const cards = await db.getAllCached('cards');
  const first = cards[0];

  // A kept read is a copy: sorting or changing it does not touch the next one.
  const a = await db.getAllCached('cards');
  a.reverse(); a[0].front = 'CHANGED'; a.length = 1;
  const b = await db.getAllCached('cards');
  out.push(b.length === cards.length && b.every(c => c.front !== 'CHANGED') ? 'ok copies' : 'copies are shared');

  // Saves that change cards: the read is made again.
  out.push((await readsAfter('cards', () => db.put('cards', { ...first, front: 'edited' }))) === 1 ? 'ok put reads cards again' : 'put kept stale cards');
  await same('put');
  await db.saveCards([{ ...first, front: 'edited again', suspended: true }]); await same('saveCards');
  await db.addDeckWithCards({ id: 'rc-deck', name: 'RC', created: now }, [{ id: 'rc-1', deckId: 'rc-deck', front: 'q', back: 'a', created: now }, { id: 'rc-2', deckId: 'rc-deck', front: 'q2', back: 'a2', created: now }]); await same('addDeckWithCards');
  await db.addImport({ decks: [], cards: [{ id: 'rc-3', deckId: 'rc-deck', front: 'q3', back: 'a3', created: now }], reviewLog: [], cardStates: [{ cardId: 'rc-3', due: now, state: 2, stability: 3, difficulty: 5, reps: 1, lapses: 0 }] }); await same('addImport');
  await db.putStates([{ cardId: 'rc-1', due: now + 1000, state: 2, stability: 2, difficulty: 5, reps: 1, lapses: 0 }]); await same('putStates');
  await db.clearStates(['rc-3']); await same('clearStates');
  await db.saveNote({ update: [], add: [{ front: 'n1', back: 'n2', cloze: 1 }], remove: [] }, { deckId: 'rc-deck', noteId: 'rc-note' }); await same('saveNote');
  await db.deleteCards(['rc-2']); await same('deleteCards');
  await db.applyRemote([{ store: 'cards', id: 'rc-remote', updated_at: now + 5000, deleted: false, data: { id: 'rc-remote', deckId: 'rc-deck', front: 'from server', back: 'x', created: now } },
    { store: 'cardStates', id: 'rc-remote', updated_at: now + 5000, deleted: false, data: { cardId: 'rc-remote', due: now, state: 2, stability: 4, difficulty: 4, reps: 2, lapses: 0 } }]); await same('applyRemote');
  await db.applyRemote([{ store: 'cards', id: 'rc-remote', updated_at: now + 9000, deleted: true, data: null }]); await same('applyRemote delete');
  await db.forgetSyncedMarks(); await same('forgetSyncedMarks');

  // Answers: the kept schedules are changed in step instead of being read again (and still equal the stored ones).
  const st1 = { cardId: 'rc-1', due: now + 86400000, state: 2, stability: 9, difficulty: 4, reps: 2, lapses: 0, fsrs7: { s: [1, 2] } };
  const log = { cardId: 'rc-1', timestamp: now, source: 'review', mode: 'flip', correct: true, ms: 900, rating: 3, state: 2 };
  let id;
  out.push((await readsAfter('cardStates', async () => { id = await db.saveReview(st1, log); })) === 0 ? 'ok saveReview keeps the schedules' : 'saveReview read the schedules again');
  out.push((await readsAfter('cards', async () => { await db.addLog({ ...log, timestamp: now + 1 }); })) === 0 ? 'ok addLog keeps the cards' : 'addLog read the cards again');
  await same('saveReview');
  // a first answer on a card with no schedule yet, and its undo
  const fresh = { cardId: 'rc-new-state', due: now, state: 1, stability: 1, difficulty: 5, reps: 1, lapses: 0 };
  await db.put('cards', { id: 'rc-new-state', deckId: 'rc-deck', front: 'x', back: 'y', created: now });
  const id2 = await db.saveReview(fresh, { ...log, cardId: 'rc-new-state' }); await same('saveReview, a new schedule');
  await db.undoReview('rc-new-state', null, id2); await same('undo to new');
  const id3 = await db.saveReview(st1, log); await db.undoReview('rc-1', { ...st1, reps: 1 }, id3); await same('undo to the old schedule');
  await db.deleteLogRow(id); await same('deleteLogRow');
  // the kept read is not the object that was passed in
  const kept = (await db.getAllCached('cardStates')).find(s => s.cardId === 'rc-1');
  out.push(kept && kept !== st1 && kept.fsrs7 !== st1.fsrs7 ? 'ok saved rows are copied into the kept read' : 'the caller owns a kept row');
  await db.deleteDeck('rc-deck'); await same('deleteDeck');

  // A backup restored, everything deleted, everything reset.
  const backup = await db.exportAll({ sounds: false });
  await db.importAll(backup); await same('importAll');
  await db.deleteEverything(); await same('deleteEverything');
  out.push((await db.getAllCached('cards')).length === 0 ? 'ok empty after deleteEverything' : 'not empty');
  await db.importAll(backup); await same('importAll again');
  await db.resetAll(); await same('resetAll');
  IDBObjectStore.prototype.getAll = orig;
  return out;
});
for (const line of paths) ok(line.startsWith('ok'), line);

// ---------- another tab ----------
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'tab-deck', name: 'Tab', created: Date.now() }, [{ id: 'tab-1', deckId: 'tab-deck', front: 'one', back: '1', created: Date.now() }]); await db.getAllCached('cards'); });
const other = await ctx.newPage();
await other.goto('http://localhost:8123/#/decks'); await other.waitForSelector('.deck');
await other.evaluate(async () => { const db = await import('./js/db.js'); await db.put('cards', { id: 'tab-1', deckId: 'tab-deck', front: 'edited in another tab', back: '1', created: Date.now() }); await db.putStates?.([{ cardId: 'tab-1', due: Date.now(), state: 2, stability: 2, difficulty: 5, reps: 1, lapses: 0 }]); });
await page.waitForTimeout(400);
const seen = await page.evaluate(async () => { const db = await import('./js/db.js'); return { front: (await db.getAllCached('cards')).find(c => c.id === 'tab-1')?.front, state: !!(await db.getAllCached('cardStates')).find(s => s.cardId === 'tab-1') }; });
ok(seen.front === 'edited in another tab' && seen.state, 'a change saved in another tab shows in the kept reads here');
await other.close();

// ---------- the quick day lookups ----------
const days = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const { dayStart, dayEnd } = await import('./js/days.js');
  const { daysAgoStart } = await import('./js/stats-calc.js');
  await db.resetAll();
  const DAY = 86400000, now = Date.now();
  const logs = [];
  for (const d of [0, 1, 2, 9, 10, 100, 369, 370, 371, 372, 400, 1200]) for (let i = 0; i <= d % 4; i++) {
    logs.push({ cardId: d % 2 ? 'x' : 'y', timestamp: daysAgoStart(d, now) + 3600000 * (5 + i), source: 'review', mode: 'flip', correct: true, ms: 1, rating: 3, state: 2 });
  }
  logs.push({ cardId: 'x', timestamp: daysAgoStart(3, now) + 3600000 * 4, source: 'play', mode: 'flip', correct: true, ms: 1, rating: 3, state: 2 });       // exactly at the rollover
  logs.push({ cardId: 'x', timestamp: daysAgoStart(3, now) + 3600000 * 4 - 1, source: 'play', mode: 'flip', correct: true, ms: 1, rating: 3, state: 2 });   // a millisecond earlier: the day before
  await db.putMany('reviewLog', logs);
  const all = await db.getAll('reviewLog');
  const expected = new Map();
  for (const l of all) expected.set(dayStart(l.timestamp), (expected.get(dayStart(l.timestamp)) || 0) + 1);
  const want = [...expected].sort((a, b) => a[0] - b[0]);
  const exactSince = daysAgoStart(371, now);
  const got = await db.getDayCounts({ exactSince });
  const wantPartial = want.map(([t, n]) => [t, t >= exactSince ? n : 1]);
  // hasLogsIn: one answer in each of these days
  const ranges = [0, 1, 2, 3, 4, 5, 9, 10, 11, 100, 400].map(n => [daysAgoStart(n, now), daysAgoStart(n - 1, now)]);
  const has = await db.hasLogsIn(ranges);
  const wantHas = ranges.map(([from, to]) => all.some(l => l.timestamp >= from && l.timestamp < to));
  const forX = await db.getLogsForCards(['x', 'nobody']);
  const between = await db.getLogsBetween(daysAgoStart(10, now), daysAgoStart(2, now));
  return {
    exact: JSON.stringify(await db.getDayCounts()) === JSON.stringify(want), nWant: want.length,
    partial: JSON.stringify(got) === JSON.stringify(wantPartial), partialSample: JSON.stringify(got.slice(0, 4)), wantSample: JSON.stringify(wantPartial.slice(0, 4)),
    has: JSON.stringify(has) === JSON.stringify(wantHas), hasList: has, none: (await db.hasLogsIn([])).length === 0,
    forX: forX.length === all.filter(l => l.cardId === 'x').length && forX.every(l => l.cardId === 'x'),
    between: between.length === all.filter(l => l.timestamp >= daysAgoStart(10, now) && l.timestamp < daysAgoStart(2, now)).length,
    emptyFor: (await db.getLogsForCards([])).length === 0
  };
});
ok(days.exact && days.nWant >= 12, 'getDayCounts() counts every day exactly: ' + days.nWant + ' days');
ok(days.partial, 'getDayCounts({ exactSince }): real counts from then on, "has answers" before ' + (days.partial ? '' : days.partialSample + ' vs ' + days.wantSample));
ok(days.has && days.hasList.includes(true) && days.hasList.includes(false), 'hasLogsIn says which days have answers ' + days.hasList);
ok(days.none, 'hasLogsIn with nothing to ask');
ok(days.forX && days.emptyFor, "getLogsForCards gives just those cards' answers");
ok(days.between, 'getLogsBetween: from up to, not including, to');

// ---------- loadStreak gives the streak the old reading gave ----------
const streaks = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const sd = await import('./js/study-data.js');
  const sc = await import('./js/stats-calc.js');
  const { daysAgoStart } = sc;
  const now = Date.now();
  const out = [];
  // the old reading: every answer's time since a moment, one key cursor per day
  const readSince = async since => (await db.getLogsSince(since)).map(l => l.timestamp);
  const cases = {
    'a 200-day streak': [...Array(200).keys()].map(d => d), 'with a freeze 70 days back': [...Array(130).keys()].filter(d => d !== 70), 'nothing today': [...Array(90).keys()].map(d => d + 1),
    'two misses': [...Array(100).keys()].filter(d => d !== 40 && d !== 41), 'one old answer': [300], 'none': [], 'today only': [0]
  };
  for (const [label, list] of Object.entries(cases)) {
    await db.resetAll();
    await db.putMany('reviewLog', list.map(d => ({ cardId: 'x', timestamp: daysAgoStart(d, now) + 8 * 3600000, source: 'review', mode: 'flip', correct: true, ms: 1, rating: 3, state: 2 })));
    const settings = { restDays: {}, idleDays: {} };
    const want = await sc.lazyStreak(readSince, Date.now(), null, 60, { rest: sc.restDaySet(settings), idle: sc.idleDaySet(settings) });
    const got = await sd.loadStreak(null, { settings });
    const again = await sd.loadStreak(null, { settings });         // from the kept days
    out.push([label, JSON.stringify(got) === JSON.stringify(want) && JSON.stringify(again) === JSON.stringify(want), got.days]);
  }
  // kept until the data changes: one more answer today changes the streak
  await db.resetAll();
  await db.putMany('reviewLog', [1, 2, 3].map(d => ({ cardId: 'x', timestamp: daysAgoStart(d, now) + 8 * 3600000, source: 'review', mode: 'flip', correct: true, ms: 1, rating: 3, state: 2 })));
  const before = (await sd.loadStreak(null, { settings: {} })).days;
  await db.addLog({ cardId: 'x', timestamp: Date.now(), source: 'review', mode: 'flip', correct: true, ms: 1, rating: 3, state: 2 });
  const after = (await sd.loadStreak(null, { settings: {} })).days;
  out.push(['a new answer is seen', before === 3 && after === 4, `${before} → ${after}`]);
  return out;
});
for (const [label, good, n] of streaks) ok(good, `loadStreak: ${label} (${n})`);

// ---------- tidying unused pictures at start-up ----------
const media = (age, id) => page.evaluate(async ([age, id]) => {
  const db = await import('./js/db.js');
  await db.putMedia({ id, type: 'image/png', data: new Uint8Array([1, 2, 3, 4]).buffer, size: 4, created: Date.now() - age, uploaded: false });
}, [age, id]);
const state = () => page.evaluate(async () => { const db = await import('./js/db.js'); return { ids: await db.mediaKeys(), at: (await db.getSettings()).mediaCleanedAt ?? null }; });
const reload = async () => { await page.reload(); await page.waitForSelector('.tab'); await page.waitForTimeout(2500); };
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.resetAll(); await db.setSetting('seeded', true); await db.setSetting('onboarded', true); });
await reload();
let s = await state();
ok(s.at === null, 'no pictures: the tidy does nothing and notes nothing');
await media(2 * 3600000, 'old-unused'); await media(60000, 'new-unused');
await reload(); s = await state();
ok(!s.ids.includes('old-unused') && s.ids.includes('new-unused'), 'an unused picture is removed at start-up, a new one (under an hour) is kept');
ok(Number.isFinite(s.at) && Date.now() - s.at < 60000, 'and the time is noted');
await media(2 * 3600000, 'old-unused-2');
await reload(); s = await state();
ok(s.ids.includes('old-unused-2'), 'a second start the same day does not tidy again');
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('mediaCleanedAt', Date.now() - 25 * 3600000); });
await reload(); s = await state();
ok(!s.ids.includes('old-unused-2'), 'a day later it does');
const backup = await page.evaluate(async () => { const db = await import('./js/db.js'); return Object.keys((await db.exportAll()).settings); });
ok(!backup.includes('mediaCleanedAt'), 'the time of the last tidy stays out of backups');

await browser.close();
