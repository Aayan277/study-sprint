// Round 2 B1 "Back from a break" (docs/design/round2-plan.md): the catch-up plan, capped at 3 days.
//   - 150 cards overdue 10 days + 10 due today: Today offers "Spread them over 2 or 3 days?" with the per-day load
//   - starting a 3-day plan: Start = the day's share (50) + 10 due, matching the sidebar and Review; new cards are paused
//   - the next day (50 done): the share is 50 again; a skipped day: more; after day 3 the plan clears itself
//   - dismissing the banner lasts for the day; exam decks are never capped; "Show everything now" cancels the plan
//   - a warning when the review limit is lower than the plan needs; a backup carries the plan
//   - screenshots at 375 and 1440, dark and light
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const day = n => new Date(2026, 9, 14 + n, 12);            // noon, n days after the first day
const open = async (width, height, scheme = 'dark') => {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', colorScheme: scheme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.clock.setFixedTime(day(0));
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.stack));
  return { ctx, p };
};
const go = async (p, hash, sel = '.today-hero') => { await p.goto('about:blank'); await p.goto('http://localhost:8123/' + hash); await p.waitForSelector(sel); await p.waitForTimeout(150); };
const num = async (p, sel) => +(await p.locator(sel).first().textContent()).trim();
const startCount = async p => +(/Start · (\d+) card/.exec(await p.textContent('#startBtn'))?.[1]);
const sideCount = async p => +((await p.textContent('#sideBadge')).match(/\d+/)?.[0] || 0);
const noHScroll = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + what);
const lineText = async p => (await p.textContent('.rescue-line')).replace(/\s+/g, ' ').trim();

// Main: 150 reviews overdue ~10 days (c0 the most overdue), 10 due today, 20 new. Optional Exam deck with 40 overdue.
const seed = (p, { exam = false } = {}) => p.evaluate(async exam => {
  const db = await import('./js/db.js');
  await db.deleteDeck('sample');
  const D = 86400000, now = Date.now();
  await db.saveDeck({ id: 'Main', name: 'Anatomy', course: '', color: '#46A758', parentId: '', created: now - 9000 });
  if (exam) {
    const d = new Date(now + 30 * D);
    await db.saveDeck({ id: 'Ex', name: 'Chemistry', course: '', color: '#3E63DD', parentId: '', created: now - 8000, examDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
  }
  const cards = [], states = [];
  let n = 0;
  const add = (deckId, due) => {
    const id = `c${n++}`;
    cards.push({ id, deckId, front: `Q ${id}`, back: `A ${id}`, created: now - 100000 + n });
    if (due !== null) states.push({ cardId: id, due, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: due - 5 * D, elapsedDays: 5, scheduledDays: 5, learningSteps: 0 });
  };
  for (let i = 0; i < 150; i++) add('Main', now - 11 * D + i * 60000);
  for (let i = 0; i < 10; i++) add('Main', now - 3600000 - i * 1000);
  for (let i = 0; i < 20; i++) add('Main', null);
  if (exam) for (let i = 0; i < 40; i++) add('Ex', now - 10 * D + i * 60000);
  await db.saveCards(cards); await db.putStates(states);
}, exam);
const plan = p => p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).rescue);
// Pretend the `n` most overdue cards were studied: they come due in 5 days.
const studyOverdue = (p, n) => p.evaluate(async n => {
  const db = await import('./js/db.js');
  const states = (await db.getAll('cardStates')).filter(s => /^c\d+$/.test(s.cardId) && +s.cardId.slice(1) < n);
  await db.putStates(states.map(s => ({ ...s, due: Date.now() + 5 * 86400000, lastReview: Date.now() })));
}, n);

// ======================= 1440 dark: the offer, the sheet, the plan =======================
let { ctx, p } = await open(1440, 900);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await seed(p);
await go(p, '#/today');
ok(await p.isVisible('.rescue-banner'), 'with 150 overdue cards the banner shows');
const title = (await p.textContent('.rb-title')).replace(/\s+/g, ' ').trim();
ok(/^150 overdue cards piled up\. Spread them over\s*2 days\s*3 days\s*\?$/.test(title), 'it reads in plain words: ' + title);
ok(!/backlog/i.test(await p.textContent('.rescue-banner')), 'no jargon ("backlog") in the banner');
ok(await p.locator('[data-rdays]').count() === 2, 'only 2 and 3 days are offered (the plan is capped at 3)');
ok(await p.getAttribute('[data-rdays="3"]', 'aria-pressed') === 'true', '3 days is picked at first');
ok(/About 50 overdue \+ 20 of your usual cards a day/.test(await p.textContent('#rbPre')), 'the preview for 3 days: ' + await p.textContent('#rbPre'));
await p.click('[data-rdays="2"]');
ok(/About 75 overdue/.test(await p.textContent('#rbPre')) && await p.getAttribute('[data-rdays="2"]', 'aria-pressed') === 'true', 'choosing 2 days updates the preview to 75');
ok(await startCount(p) === 180, 'before a plan Start shows everything: 150 + 10 due + 20 new = ' + await startCount(p));
await p.screenshot({ path: SP + '/rescue-banner-1440-dark.png' });
await p.click('[data-rdays="3"]');

// A review limit lower than the plan needs: a warning in the sheet
await p.evaluate(async () => (await import('./js/db.js')).setSetting('reviewLimit', 60));
await go(p, '#/today', '.rescue-banner');
await p.click('#rescueGo'); await p.waitForSelector('#rsStart');
ok(await p.isVisible('#rsWarn') && /limit of 60 reviews a day is lower than the 70/.test(await p.textContent('#rsWarn')), 'a review limit of 60 < 50 + 20 warns: ' + (await p.textContent('#rsWarn')).trim().slice(0, 60));
await p.screenshot({ path: SP + '/rescue-sheet-warn-1440-dark.png' });
await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#sheet')?.open);
await p.evaluate(async () => (await import('./js/db.js')).setSetting('reviewLimit', null));
await go(p, '#/today', '.rescue-banner');
await p.click('#rescueGo'); await p.waitForSelector('#rsStart');
ok(!(await p.isVisible('#rsWarn')), 'no warning without a limit');
ok(await p.isChecked('#rsPause'), '"Pause new cards until caught up" is on by default');
ok(/about 50 overdue/.test(await p.textContent('#sheet')) && /150 overdue cards/.test(await p.textContent('#sheet')), 'the sheet says what the plan does');
await p.screenshot({ path: SP + '/rescue-sheet-1440-dark.png' });
await p.click('#rsStart'); await p.waitForSelector('.rescue-line');
ok(/Catch-up plan: day 1 of 3 · 150 left/.test(await lineText(p)), 'the plan line: ' + await lineText(p));
ok(!(await p.isVisible('.rescue-banner')), 'the banner is gone once the plan runs');
let pl = await plan(p);
ok(pl && pl.days === 3 && pl.backlog === 150 && pl.pauseNew === true, 'saved as a 3-day plan of 150: ' + JSON.stringify(pl));
ok(await startCount(p) === 60, 'day 1: Start = 50 + 10 due = ' + await startCount(p));
ok(await sideCount(p) === 60, 'the sidebar says 60 too');
ok(await num(p, '[data-count=new]') === 0, 'new cards are paused');
await p.screenshot({ path: SP + '/rescue-line-1440-dark.png' });
await noHScroll(p, '1440');
// Review has the same 60 (it must use the plan too)
await p.click('#startBtn'); await p.waitForSelector('.rv-counts');
const rv = await p.$$eval('.rv-counts span', s => s.map(x => +x.textContent));
ok(rv.reduce((a, b) => a + b, 0) === 60, 'Review starts with 60 cards: ' + rv.join('+'));
// Pausing off brings the 20 new cards back; on again hides them
await go(p, '#/today', '.rescue-line');
await p.click('#rescueManage'); await p.waitForSelector('#rsPause');
ok(/Day 1 of 3/.test(await p.textContent('#sheet')) && /150 overdue cards left/.test(await p.textContent('#sheet')), 'Details shows day 1 of 3 and 150 left');
await p.uncheck('#rsPause'); await p.waitForFunction(() => document.querySelector('#startBtn')?.textContent.includes('80'));
ok((await plan(p)).pauseNew === false && await startCount(p) === 80, 'pause off: 20 new cards join, Start = 80');
await p.check('#rsPause'); await p.waitForFunction(() => document.querySelector('#startBtn')?.textContent.includes('60'));
ok((await plan(p)).pauseNew === true, 'pause on again: back to 60');
await p.keyboard.press('Escape');

// ======================= the next day, a skipped day, the end =======================
await studyOverdue(p, 50);                                  // day 1: 50 of the most overdue were done
await ctx.clock.setFixedTime(day(1));
await go(p, '#/today');
ok(/day 2 of 3 · 100 left/.test(await lineText(p)), 'day 2: "day 2 of 3 · 100 left"');
ok(await startCount(p) === 60 && await sideCount(p) === 60, 'day 2: another 50 + the 10 due = ' + await startCount(p) + ' (sidebar ' + await sideCount(p) + ')');
await ctx.clock.setFixedTime(day(2));                       // day 2 skipped
await go(p, '#/today');
ok(/day 3 of 3 · 100 left/.test(await lineText(p)), 'a skipped day 2: day 3 of 3, still 100 left');
ok(await startCount(p) === 110, 'the last day allows everything left: 100 + 10 = ' + await startCount(p));
await ctx.clock.setFixedTime(day(3));                       // day 4: the plan is over
await go(p, '#/today');
ok(await p.locator('.rescue-line').count() === 0, 'after day 3 the plan line is gone');
await p.waitForTimeout(200);
ok(await plan(p) === null, 'Today cleared the finished plan');
ok(await startCount(p) === 130, 'and everything is back: 100 overdue + 10 + 20 new = ' + await startCount(p));
// ... 110 overdue cards are still piled up, so the offer returns; "Not today" hides it until tomorrow
ok(await p.isVisible('.rescue-banner') && /^110 overdue cards/.test((await p.textContent('.rb-title')).trim()), 'with 110 still overdue the offer comes back (the 100 and the 10 that were due on day 1)');
await p.click('#rescueNo');
ok(!(await p.isVisible('.rescue-banner')), '"Not today" hides it');
await go(p, '#/today');
ok(await p.locator('.rescue-banner').count() === 0, 'it stays hidden after a reload the same day');
await ctx.clock.setFixedTime(day(4));
await go(p, '#/today');
ok(await p.locator('.rescue-banner').count() === 1, 'the next day it is offered again');
await ctx.close();

// ======================= an exam deck is never capped; backup; Show everything now =======================
({ ctx, p } = await open(1440, 900));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await seed(p, { exam: true });
await go(p, '#/today');
ok(/^150 overdue cards/.test((await p.textContent('.rb-title')).trim()), 'the offer counts 150: the 40 overdue cards of the exam deck are left out');
await p.click('#rescueGo'); await p.click('#rsStart'); await p.waitForSelector('.rescue-line');
const exRow = await num(p, '.tdeck[data-start="Ex"] .due b');
ok(exRow === 40, 'the exam deck keeps all 40 overdue cards: ' + exRow);
ok(await startCount(p) === 100 && await sideCount(p) === 100, 'Start = 50 + 10 + 40 exam = ' + await startCount(p) + ' (sidebar ' + await sideCount(p) + ')');
// Backup round trip: the plan comes back after Restore
const backup = await p.evaluate(async () => (await import('./js/db.js')).exportAll());
ok(backup.settings.rescue && backup.settings.rescue.days === 3 && backup.settings.rescue.backlog === 150, 'the backup holds the plan');
ok(await p.evaluate(async b => (await import('./js/db.js')).checkBackup(b), backup) === null, 'and passes the backup check');
const bad = r => p.evaluate(async ([b, r]) => (await import('./js/db.js')).checkBackup({ ...b, settings: { ...b.settings, rescue: r } }), [backup, r]);
ok(/catch-up plan/.test(await bad({ start: 'x', days: 3, backlog: 5 })) && /catch-up plan/.test(await bad({ start: 1, days: 99, backlog: 5 })) && /catch-up plan/.test(await bad('<img>')), 'a damaged plan in a backup is refused');
ok(await bad(null) === null, 'a backup with no plan is fine');
await p.evaluate(async () => (await import('./js/db.js')).setSetting('rescue', null));
await go(p, '#/today');
ok(await p.locator('.rescue-line').count() === 0, '(plan removed)');
await p.evaluate(async b => { const db = await import('./js/db.js'); await db.importAll(b); }, backup);
await go(p, '#/today', '.rescue-line');
ok(/day 1 of 3 · 150 left/.test(await lineText(p)) && await startCount(p) === 100, 'after Restore the same plan runs: Start ' + await startCount(p));
// v4.8.1: the deck page says the plan pauses new cards
await go(p, '#/deck/Main', '.deck-summary');
ok(/New cards paused\s*\(catch-up plan\)/.test(await p.textContent('.deck-summary')), 'the deck summary says new cards are paused by the catch-up plan');
await go(p, '#/today', '.rescue-line');
// Show everything now
await p.click('#rescueManage'); await p.waitForSelector('#rsAll');
await p.click('#rsAll'); await p.waitForFunction(() => !document.querySelector('.rescue-line'));
ok(await plan(p) === null, '"Show everything now" clears the plan');
// v4.8.1: ... and the banner must not come straight back (150 are overdue again), now or after a reload the same day
ok(await p.locator('.rescue-banner').count() === 0, '"Show everything now" does not bring the offer banner straight back');
await go(p, '#/today');
ok(await p.locator('.rescue-banner').count() === 0, 'it stays hidden after a reload the same day');
ok(await p.evaluate(async () => localStorage.getItem('study-sprint-rescue-dismissed') === String((await import('./js/days.js')).dayStart())), 'it is remembered as dismissed for today');
// v4.8.1: Reset this device forgets the dismissals
await p.evaluate(() => localStorage.setItem('study-sprint-mix-dismissed', '{}'));
await p.evaluate(async () => { const s = await import('./js/study-data.js'); s.clearDismissals(); });
ok(await p.evaluate(() => localStorage.getItem('study-sprint-rescue-dismissed') === null && localStorage.getItem('study-sprint-mix-dismissed') === null), 'clearDismissals forgets both keys');
await go(p, '#/today');
const all = await startCount(p);
ok(all === 150 + 10 + 40 + 20 && await sideCount(p) === all, 'Start shows everything again: ' + all);
await ctx.close();

// ======================= polish: 375 and 1440, dark and light =======================
for (const [w, h, scheme] of [[375, 740, 'dark'], [375, 740, 'light'], [1440, 900, 'light']]) {
  ({ ctx, p } = await open(w, h, scheme));
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
  await seed(p);
  if (scheme === 'light') await p.evaluate(async () => { const th = (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: 'light' }); await (await import('./js/db.js')).setSetting('theme', th); });
  await go(p, '#/today', '.rescue-banner');
  await noHScroll(p, `${w} ${scheme} banner`);
  await p.screenshot({ path: `${SP}/rescue-banner-${w}-${scheme}.png`, fullPage: w < 600 });
  await p.click('#rescueGo'); await p.waitForSelector('#rsStart');
  await p.screenshot({ path: `${SP}/rescue-sheet-${w}-${scheme}.png` });
  await p.click('#rsStart'); await p.waitForSelector('.rescue-line');
  await noHScroll(p, `${w} ${scheme} plan line`);
  await p.screenshot({ path: `${SP}/rescue-line-${w}-${scheme}.png`, fullPage: w < 600 });
  await p.click('#rescueManage'); await p.waitForSelector('#rsAll');
  await p.screenshot({ path: `${SP}/rescue-manage-${w}-${scheme}.png` });
  await ctx.close();
}


// ======================= v4.8.1: a finished plan is cleared with the plan's own time (two-device race) =======================
({ ctx, p } = await open(1440, 900));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
const times = () => p.evaluate(() => new Promise(res => { const r = indexedDB.open('study-sprint'); r.onsuccess = () => { const g = r.result.transaction('settings').objectStore('settings').get('_times'); g.onsuccess = () => { r.result.close(); res(g.result || {}); }; }; }));
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('rescue', { start: 1, days: 3, backlog: 10, pauseNew: true, at: 4242 }); await db.setSetting('rescue', null, { at: 4242 }); });
ok((await times()).rescue === 4242, 'clearing a plan with { at } records the plan\'s own time, not now');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('rescue', null); });
ok((await times()).rescue > 1_700_000_000_000, 'without { at } a setting is still stamped with now');
// A finished plan on Today is cleared with its own time: another device's newer plan (a later time) would win
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('rescue', { start: new Date(2020, 0, 1).getTime(), days: 3, backlog: 10, pauseNew: true, at: 777 }); });
await go(p, '#/today');
await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).rescue === null);
ok((await times()).rescue === 777, 'Today cleared the old plan stamped with the plan\'s own time (' + (await times()).rescue + ')');
await ctx.close();

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors[0] : ''));
await browser.close();
