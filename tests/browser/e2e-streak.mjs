// Streak freeze and days off (v4.1). The clock is fixed (page.clock.setFixedTime) at noon on Wed 14 Oct 2026, so the
// week (Mon 12 to Sun 18 Oct) and the missed day are the same on every run and in every time zone.
//   Seeded: answers on days 2 to 6 back (Mon 12 to Thu 8 Oct), nothing yesterday (Tue 13) and nothing yet today.
//   Expect: a 5 day streak, Tuesday covered by the week's freeze ("Freeze used yesterday"), then 6 after one review.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const URL = 'http://localhost:8123/';
const WED = new Date(2026, 9, 14, 12);

const open = async (w, h, { touch = false, at = WED } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
  await ctx.clock.setFixedTime(at);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  p.ctx = ctx;
  return p;
};
const noHScroll = async (p, w) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const go = async (p, hash, sel) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(sel); await p.waitForTimeout(150); };
const norm = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
const theme = (p, mode, oled = false) => p.evaluate(([m, o]) => {
  const h = document.documentElement;
  if (m === 'light') h.setAttribute('data-theme', 'light'); else h.removeAttribute('data-theme');
  if (o) h.setAttribute('data-oled', 'on'); else h.removeAttribute('data-oled');
}, [mode, oled]);

// Studied days (days back from the page's "today"), one course with a few cards due now, and optional days off.
async function seed(p, studied, { rest = [] } = {}) {
  await p.evaluate(async ([studied, rest]) => {
    const db = await import('./js/db.js');
    const { daysAgoStart, dayKey } = await import('./js/stats-calc.js');
    const now = Date.now(), D = 86400000;
    const cards = Array.from({ length: 4 }, (_, i) => ({ id: 'c' + i, deckId: 'bio', front: `Question ${i}`, back: `Answer ${i}`, tags: [], created: i }));
    await db.addDeckWithCards({ id: 'bio', name: 'Cell Biology', color: '#46A758', created: now + 1 }, cards);
    await db.putMany('cardStates', cards.map(c => ({ cardId: c.id, due: now - D, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D, scheduledDays: 3, elapsedDays: 3, learningSteps: 0 })));
    await db.putMany('reviewLog', studied.flatMap(d => [0, 1].map(i => ({ cardId: 'c' + i, timestamp: daysAgoStart(d, now) + 12 * 3600000 + i * 60000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true }))));
    if (rest.length) await db.setSetting('restDays', Object.fromEntries(rest.map(n => [dayKey(daysAgoStart(-n, now)), { on: true, at: now }])));
  }, [studied, rest]);
}
const tomorrowPlus = (p, n) => p.evaluate(async n => { const { daysAgoStart, dayKey } = await import('./js/stats-calc.js'); return dayKey(daysAgoStart(-n)); }, n);

// ============================ 375 x 740: Today ============================
let p = await open(375, 740, { touch: true });
await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
ok(await p.evaluate(() => new Date().getDate() === 14 && new Date().getHours() === 12), 'the clock is fixed at noon on 14 Oct');
await seed(p, [2, 3, 4, 5, 6]);
await p.reload(); await p.waitForSelector('#startBtn'); await p.waitForSelector('.frz-pill');

const streakText = await norm(p, '.streak');
ok(/^5\s*day streak/.test(streakText), 'Today shows a 5 day streak: ' + streakText);
ok(streakText.includes('Freeze used yesterday'), 'and says the freeze was used yesterday');
ok(/Freeze used (Tue|\w+)/.test(await norm(p, '.frz-pill')), 'the pill names the day: ' + await norm(p, '.frz-pill'));
ok(await p.locator('.streak .frz-pill svg').count() === 1, 'the pill has a snowflake');
ok(await p.locator('button.streak-btn#streakBtn').count() === 1 && !(await p.$eval('.streak', e => e.classList.contains('kept'))), 'the streak is a button, not "kept" yet');
await noHScroll(p, 'Today at 375');
await p.screenshot({ path: SP + '/streak-today-375-dark.png' });

// ----- the sheet -----
await p.click('#streakBtn'); await p.waitForSelector('#sheet[open] .ys');
ok((await norm(p, '#sheetTitle')) === 'Your streak', 'the sheet is titled "Your streak"');
ok(await p.locator('#sheet .wd.frz').count() === 1 && await p.locator('#sheet .wd.on').count() === 5, 'the 7-day row: 5 studied, 1 covered');
ok(/streak freeze used/.test(await p.getAttribute('#sheet .wd.frz', 'title')), 'the covered day is named in its title: ' + await p.getAttribute('#sheet .wd.frz', 'title'));
ok((await norm(p, '#sheet')).includes('One missed day a week is covered'), 'the sheet explains the freeze');
await noHScroll(p, 'the sheet at 375');
ok(await p.evaluate(() => { const s = document.querySelector('#sheet'); return s.scrollWidth <= s.clientWidth + 1; }), 'the sheet itself does not scroll sideways');
await p.screenshot({ path: SP + '/streak-sheet-375-dark.png' });
const dateIn = await p.getAttribute('#ysDate', 'min'), dateMax = await p.getAttribute('#ysDate', 'max');
ok(dateIn === await tomorrowPlus(p, 1) && dateMax === await tomorrowPlus(p, 60), `the date box runs from tomorrow (${dateIn}) to 60 days ahead (${dateMax})`);

// today is rejected; so is 61 days ahead
const errText = async () => (await p.isVisible('#ysErr')) ? norm(p, '#ysErr') : '';
await p.fill('#ysDate', await tomorrowPlus(p, 0)); await p.click('#ysForm button[type=submit]');
ok((await errText()).includes('start tomorrow') && await p.locator('.ys-list li').count() === 0, 'a day off today is rejected: ' + await errText());
await p.fill('#ysDate', await tomorrowPlus(p, 61)); await p.click('#ysForm button[type=submit]');
ok((await errText()).includes('within the next 60 days'), 'a day off 61 days ahead is rejected: ' + await errText());
await p.fill('#ysDate', ''); await p.click('#ysForm button[type=submit]');
ok((await errText()) === 'Pick a date.', 'an empty date asks for one');
// add two, then remove one
const d1 = await tomorrowPlus(p, 1), d2 = await tomorrowPlus(p, 2);
await p.fill('#ysDate', d1); await p.click('#ysForm button[type=submit]'); await p.waitForSelector('.ys-list li');
await p.fill('#ysDate', d2); await p.click('#ysForm button[type=submit]'); await p.waitForFunction(() => document.querySelectorAll('.ys-list li').length === 2);
ok(await p.locator('.ys-list li').count() === 2 && !(await p.isVisible('#ysErr')), 'two days off are listed');
await p.fill('#ysDate', d1); await p.click('#ysForm button[type=submit]');
ok((await errText()).includes('already a day off'), 'adding the same day twice is refused: ' + await errText());
await p.screenshot({ path: SP + '/streak-sheet-days-375-dark.png' });
await p.click(`[data-rm="${d2}"]`); await p.waitForFunction(() => document.querySelectorAll('.ys-list li').length === 1);
const stored = await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).restDays);
ok(stored[d1].on === true && stored[d2].on === false && stored[d2].at >= stored[d1].at, 'the setting keeps the removal as on:false with a newer time (so it syncs)');
// at most 14 days ahead
for (let n = 3; n <= 16; n++) {
  await p.fill('#ysDate', await tomorrowPlus(p, n)); await p.click('#ysForm button[type=submit]');
  await p.waitForTimeout(40);
}
ok(await p.locator('.ys-list li').count() === 14, 'at most 14 days off can be planned: ' + await p.locator('.ys-list li').count());
ok((await errText()).includes('up to 14'), 'the 15th is refused with a reason: ' + await errText());
await p.click('#ysDone'); await p.waitForFunction(() => !document.querySelector('#sheet[open]'));
await p.waitForFunction(() => document.activeElement?.id === 'streakBtn', null, { timeout: 3000 }).catch(() => {});
ok(await p.evaluate(() => document.activeElement?.id === 'streakBtn'), 'closing the sheet returns focus to the streak button');

// ============================ Stats at 375 ============================
await go(p, '#/stats', '.pgrid');
ok(/^5/.test(await norm(p, '.pgrid .big')), 'Stats: the same 5 day streak');
ok(await p.locator('.pgrid .wd.frz').count() === 1 && await p.locator('.pgrid .wd.frz svg').count() === 1, 'Stats: the covered day is a .frz dot with a snowflake');
ok(/streak freeze used/.test(await p.getAttribute('.pgrid .wd.frz', 'title')), 'with a title: ' + await p.getAttribute('.pgrid .wd.frz', 'title'));
ok((await norm(p, '.frz-note')).includes('One freeze a week covers a missed day. It doesn’t add to the count.'), 'the streak card explains the freeze');
await p.waitForSelector('.cal-grid i.frz');
ok(await p.locator('.cal-grid i.frz').count() === 1 && /streak freeze/.test(await p.getAttribute('.cal-grid i.frz', 'title')), 'the calendar has one hatched cell titled "streak freeze": ' + await p.getAttribute('.cal-grid i.frz', 'title'));
ok(await p.locator('.cal-grid i.rest').count() === 0, 'days off still to come are not drawn in the calendar (it ends today)');
// a day off that has passed (here set directly: the sheet only plans ahead) is a dotted cell
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const { dayKey, daysAgoStart } = await import('./js/stats-calc.js');
  const cur = (await db.getSettings()).restDays;
  await db.setSetting('restDays', { ...cur, [dayKey(daysAgoStart(9))]: { on: true, at: 1 } });
});
await go(p, '#/today', '#streakBtn'); await go(p, '#/stats', '.pgrid'); await p.waitForSelector('.cal-grid i.rest');
ok(await p.locator('.cal-grid i.rest').count() === 1 && /day off/.test(await p.getAttribute('.cal-grid i.rest', 'title')), 'a past day off is a dotted cell titled "day off": ' + await p.getAttribute('.cal-grid i.rest', 'title'));
ok((await norm(p, '.cal-card')).includes('Streak freeze') && (await norm(p, '.cal-card')).includes('Day off'), 'the calendar legend lists Streak freeze and Day off');
ok(/best streak 5 days/.test(await norm(p, '.cal-card .mhead')), 'the best streak counts the covered day: ' + await norm(p, '.cal-card .mhead'));
await noHScroll(p, 'Stats at 375');
await p.evaluate(() => document.querySelector('.pgrid').scrollIntoView());
await p.screenshot({ path: SP + '/streak-stats-375-dark.png' });
await p.evaluate(() => document.querySelector('.cal-card').scrollIntoView());
await p.screenshot({ path: SP + '/streak-stats-cal-375-dark.png' });
// "Plan a day off" opens the same sheet
await p.evaluate(() => document.querySelector('#planRest').scrollIntoView({ block: 'center' }));
await p.click('#planRest'); await p.waitForSelector('#sheet[open] .ys');
ok(await p.locator('.ys-list li').count() === 14, 'Plan a day off opens the sheet with the days already planned');
await p.click('#ysDone');
ok(await p.evaluate(() => document.activeElement?.id === 'planRest'), 'and gives focus back to the link');
// themes
await go(p, '#/today', '#streakBtn');
await theme(p, 'light'); await p.screenshot({ path: SP + '/streak-today-375-light.png' });
await p.click('#streakBtn'); await p.waitForSelector('#sheet[open] .ys'); await p.screenshot({ path: SP + '/streak-sheet-375-light.png' }); await p.click('#ysDone');
await theme(p, 'dark', true); await p.screenshot({ path: SP + '/streak-today-375-oled.png' });
await p.click('#streakBtn'); await p.waitForSelector('#sheet[open] .ys'); await p.screenshot({ path: SP + '/streak-sheet-375-oled.png' }); await p.click('#ysDone');
await go(p, '#/stats', '.pgrid'); await p.waitForSelector('.cal-grid i.frz');
await p.evaluate(() => document.querySelector('.pgrid').scrollIntoView());
await p.screenshot({ path: SP + '/streak-stats-375-oled.png' });
await theme(p, 'light'); await p.screenshot({ path: SP + '/streak-stats-375-light.png' });
await p.evaluate(() => document.querySelector('.cal-card').scrollIntoView());
await p.screenshot({ path: SP + '/streak-stats-cal-375-light.png' });
await theme(p, 'dark');

// ============================ one review: 6 days, kept for today ============================
await go(p, '#/today', '#startBtn');
await p.click('#startBtn'); await p.waitForSelector('#flash');
await p.keyboard.press('Space'); await p.keyboard.press('3');
await p.click('#endBtn'); await p.waitForSelector('.finish-next .streak');
const fin = await norm(p, '.finish-next .streak');
ok(/^6\s*day streak/.test(fin) && fin.includes('Kept for today'), 'after one review: 6 day streak, Kept for today: ' + fin);
ok(fin.includes('Freeze used'), 'the finish screen shows the freeze note too');
await noHScroll(p, 'the finish screen at 375');
await p.screenshot({ path: SP + '/streak-finish-375-dark.png' });
await p.click('#againBtn'); await p.waitForSelector('.today-hero');
const kept = await norm(p, '.streak');
ok(/^6\s*day streak/.test(kept) && kept.includes('Kept for today') && await p.$eval('.streak', e => e.classList.contains('kept')), 'Today agrees: ' + kept);

// ============================ 1440 x 900: sidebar, sheet, themes ============================
const d = await open(1440, 900, { touch: false });
// (a fresh database: seed it the same way, after the review above happened in the other window)
await d.goto(URL + '#/today'); await d.waitForSelector('.today-hero');
await seed(d, [2, 3, 4, 5, 6]);
await d.reload(); await d.waitForSelector('#startBtn'); await d.waitForSelector('.side-deck');
await d.waitForSelector('#sideStreak .side-snow');
const aria = await d.getAttribute('#sideStreak', 'aria-label');
ok(/^5-day streak, freeze used \w+\./.test(aria) && aria.includes('freeze'), 'sidebar aria-label mentions the freeze: ' + aria);
ok((await d.getAttribute('#sideStreak', 'data-tip')).includes('freeze used'), 'and so does its tooltip: ' + await d.getAttribute('#sideStreak', 'data-tip'));
ok(await d.locator('#sideStreak .side-snow').count() === 1 && await d.$eval('#sideStreak .side-snow', e => e.getBoundingClientRect().width) <= 13, 'a 12px snowflake shows while a freeze was used in the last 7 days');
ok((await d.textContent('#sideStreak')).includes('5-day streak'), 'the sidebar text is still "5-day streak"');
await noHScroll(d, 'Today at 1440');
await d.screenshot({ path: SP + '/streak-today-1440-dark.png' });
await d.click('#streakBtn'); await d.waitForSelector('#sheet[open] .ys');
await d.screenshot({ path: SP + '/streak-sheet-1440-dark.png' });
await d.click('#ysDone');
await theme(d, 'light'); await d.screenshot({ path: SP + '/streak-today-1440-light.png' });
await d.click('#streakBtn'); await d.waitForSelector('#sheet[open] .ys'); await d.screenshot({ path: SP + '/streak-sheet-1440-light.png' }); await d.click('#ysDone');
await theme(d, 'dark', true); await d.screenshot({ path: SP + '/streak-today-1440-oled.png' });
await d.click('#streakBtn'); await d.waitForSelector('#sheet[open] .ys'); await d.screenshot({ path: SP + '/streak-sheet-1440-oled.png' }); await d.click('#ysDone');
await go(d, '#/stats', '.pgrid'); await d.waitForSelector('.cal-grid i.frz');
await d.screenshot({ path: SP + '/streak-stats-1440-oled.png' });
await theme(d, 'light'); await d.screenshot({ path: SP + '/streak-stats-1440-light.png' });
await theme(d, 'dark');
await d.screenshot({ path: SP + '/streak-stats-1440-dark.png' });
// the collapsed rail: no text, the tooltip carries the freeze
await d.click('#sideCollapse'); await d.waitForTimeout(250);
ok((await d.getAttribute('#sideStreak', 'data-tip')).includes('freeze used'), 'in the icon rail the tooltip still says the freeze was used');
await d.click('#sideCollapse');

// ============================ exam day chips, and a day off with an exam ============================
const e = await open(375, 740, { touch: true });
await e.goto(URL + '#/today'); await e.waitForSelector('.today-hero');
await seed(e, [2, 3, 4, 5, 6]);
const examDay = await tomorrowPlus(e, 37);        // Fri 20 Nov 2026
await e.evaluate(async d => { const db = await import('./js/db.js'); const decks = await db.getDecks(); await db.saveDeck({ ...decks.find(x => x.id === 'bio'), examDate: d }); }, examDay);
await e.reload(); await e.waitForSelector('#streakBtn');
await e.click('#streakBtn'); await e.waitForSelector('#sheet[open] .ys-exams');
const chip = await norm(e, '.ys-exams .tchip');
ok(chip.startsWith('Day off on exam day (') && chip.includes('Cell Biology'), 'an exam chip: ' + chip);
await e.screenshot({ path: SP + '/streak-sheet-exam-375-dark.png' });
await e.click('.ys-exams .tchip'); await e.waitForSelector('.ys-list li');
// v4.2.1: once added, the chip is a plain "Day off planned" label (no aria-pressed, no disabled button)
ok(await e.locator('.ys-list li').count() === 1 && await e.locator('.ys-exams button').count() === 0 && (await norm(e, '.ys-exams .tchip')).startsWith('Day off planned'), 'one tap adds the exam day as a day off, and the chip is then a "Day off planned" label');
const exStored = await e.evaluate(async () => (await (await import('./js/db.js')).getSettings()).restDays);
ok(exStored[examDay]?.on === true, 'saved as a normal day off for ' + examDay);

// ============================ moving the clock forward keeps the streak ============================
const f = await open(375, 740, { touch: true });
await f.goto(URL + '#/today'); await f.waitForSelector('.today-hero');
// Studied 1 to 5 days back from Wed 14 Oct (Fri 9 to Tue 13). Days off: Thu 15 and Fri 16.
await seed(f, [1, 2, 3, 4, 5], { rest: [1, 2] });
await f.ctx.clock.setFixedTime(new Date(2026, 9, 17, 12));    // now Sat 17 Oct: Wed 14 was missed, Thu and Fri were days off
await f.reload(); await f.waitForSelector('#streakBtn');
const moved = await norm(f, '.streak');
ok(/^5\s*day streak/.test(moved) && moved.includes('Study today to keep it'), 'two days later, with two days off in between, the streak is still 5: ' + moved);
ok(await f.locator('.streak .frz-pill').count() === 1, 'and Wednesday was covered by the freeze: ' + await norm(f, '.frz-pill'));
// without the days off the same gap breaks it
await f.evaluate(async () => { await (await import('./js/db.js')).setSetting('restDays', {}); });
await f.reload(); await f.waitForSelector('#streakBtn');
ok(/^0\s*day streak/.test(await norm(f, '.streak')), 'without the days off the streak is 0: ' + await norm(f, '.streak'));
// a day off today
await f.ctx.clock.setFixedTime(new Date(2026, 9, 15, 12));    // Thu 15: yesterday (Wed 14) missed and covered, today a day off
await f.evaluate(async () => { await (await import('./js/db.js')).setSetting('restDays', { '2026-10-15': { on: true, at: 1 } }); });
await f.reload(); await f.waitForSelector('#streakBtn');
const restToday = await norm(f, '.streak');
ok(/^5\s*day streak/.test(restToday) && restToday.includes('Rest day · your streak is safe'), 'on a day off the streak line says so: ' + restToday);
await f.screenshot({ path: SP + '/streak-restday-375-dark.png' });

// ============================ a second miss in the same week breaks the older run ============================
const g = await open(375, 740, { touch: true, at: new Date(2026, 9, 16, 12) });     // Fri 16 Oct
await g.goto(URL + '#/today'); await g.waitForSelector('.today-hero');
await seed(g, [2, 4, 7]);                                                           // Wed 14, Mon 12 and Fri 9; Thu 15 and Tue 13 missed
await g.reload(); await g.waitForSelector('#streakBtn');
const second = await norm(g, '.streak');
// v4.2.1 (owner decision): the week's freeze stays on the EARLIEST missed day (Tue 13), so the newer miss (Thu 15) ends
// the streak at once. Before, the freeze moved to Thu and the streak was 1 ("Freeze used yesterday").
ok(/^0\s*day streak/.test(second) && second.includes('Study today to start one') && !second.includes('Freeze used') && !second.includes('freeze ready'),
  'a second miss in the same week ends the streak, the freeze stays on the first miss: ' + second);

// ============================ backup and sync keep the days off ============================
const h = await open(375, 740, { touch: true });
await h.goto(URL + '#/today'); await h.waitForSelector('.today-hero');
const days = await h.evaluate(async () => {
  const db = await import('./js/db.js');
  const { dayKey, daysAgoStart } = await import('./js/stats-calc.js');
  const a = dayKey(daysAgoStart(-3)), b = dayKey(daysAgoStart(-4)), c = dayKey(daysAgoStart(-5));
  await db.setSetting('restDays', { [a]: { on: true, at: 1000 } });
  // a backup round trip
  const backup = JSON.parse(JSON.stringify(await db.exportAll()));
  await db.setSetting('restDays', {});
  await db.importAll(backup);
  const restored = (await db.getSettings()).restDays;
  // another device added day b (and removed a, later); this device adds c meanwhile
  await db.setSetting('restDays', { [a]: { on: true, at: 1000 }, [c]: { on: true, at: 3000 } });
  const since = Date.now() - 1000;
  const applied = await db.applyRemote([{ store: 'settings', id: 'restDays', data: { value: { [b]: { on: true, at: 2000 }, [a]: { on: false, at: 2500 } } }, deleted: false, updated_at: Date.now() - 50000 }]);
  const merged = (await db.getSettings()).restDays;
  const pushed = (await db.localChangesSince(since)).settings.find(s => s.key === 'restDays');
  // the same row again changes nothing
  const again = await db.applyRemote([{ store: 'settings', id: 'restDays', data: { value: { [b]: { on: true, at: 2000 }, [a]: { on: false, at: 2500 } } }, deleted: false, updated_at: Date.now() - 50000 }]);
  return { a, b, c, restored, applied, merged, pushed: pushed?.value, again };
});
ok(days.restored[days.a]?.on === true, 'a backup round trip keeps restDays');
ok(days.applied === 1 && days.merged[days.b]?.on === true && days.merged[days.c]?.on === true && days.merged[days.a]?.on === false, 'a day off from another device is merged with this one (both days kept, the newer decision wins per day)');
ok(days.pushed && Object.keys(days.pushed).length === 3, 'the union is queued to be sent back once');
ok(days.again === 0, 'applying the same row again changes nothing');

ok(errors.length === 0, 'no page errors or console errors' + (errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''));
await browser.close();
