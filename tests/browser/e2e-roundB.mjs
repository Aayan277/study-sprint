import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true })).newPage();
p.on('pageerror', e => errors.push(e.stack));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
// 6 review cards due today
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const D = 86400000, now = Date.now();
  await db.putStates(Array.from({ length: 6 }, (_, i) => ({ cardId: `sample-${i}`, due: now - (i + 1) * D, stability: 8, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 9 * D, elapsedDays: 9, scheduledDays: 8, learningSteps: 0 })));
});
const dueCount = async () => { await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck'); await p.goto('http://localhost:8123/#/today'); await p.waitForSelector('[data-count=due]'); return +(await p.textContent('[data-count=due]')); };
ok(await dueCount() === 6, 'no review limit by default: 6 due');
// overall limit
await p.goto('http://localhost:8123/#/settings'); await p.waitForSelector('#rpd');
await p.fill('#rpd', '4'); await p.dispatchEvent('#rpd', 'change');
ok((await p.evaluate(async () => (await import('./js/db.js')).getSettings())).reviewLimit === 4, 'reviews per day saved');
ok(await dueCount() === 4, 'overall limit: 4 due');
// deck limit + own settings
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('#editDeck'); await p.click('#editDeck'); await p.waitForSelector('#deckOpts');
await p.click('#deckOpts summary');
await p.fill('#deckRev', '2');
await p.click('#deckOwnOff');
await p.waitForFunction(() => document.querySelector('#deckLs').value === '1m 10m');
ok(!(await p.isHidden('#deckOwn')), 'turning off "Use my overall settings" shows the deck\'s own, starting from the current ones');
await p.screenshot({ path: SP + '/B-deck.png', fullPage: true });
await p.fill('#deckLs', '2m 20m'); await p.fill('#deckRet', '95'); await p.dispatchEvent('#deckRet', 'input');
await p.fill('#deckRs', 'banana');
await p.click('#deckForm button[type=submit]');
ok((await p.textContent('#deckErr')).startsWith('Relearning steps:'), 'bad steps explained');
await p.fill('#deckRs', '15m'); await p.click('#deckForm button[type=submit]'); await p.waitForTimeout(300);
const deck = await p.evaluate(async () => (await import('./js/db.js')).getDeck('sample'));
ok(deck.reviewPerDay === 2 && deck.options?.learningSteps === '2m 20m' && deck.options.relearningSteps === '15m' && deck.options.targetRetention === 0.95, 'deck saves its own limit and settings: ' + JSON.stringify(deck.options));
ok(await dueCount() === 2, 'deck limit: 2 due');
// the deck's steps are used in Review: a new card's Again = 2m
await p.evaluate(async () => (await import('./js/db.js')).clearStates(['sample-6', 'sample-7']));
await p.goto('http://localhost:8123/#/review'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('.flash');
let sawNew = false;
for (let i = 0; i < 6 && !sawNew; i++) {
  await p.keyboard.press(' '); await p.waitForSelector('.rate');
  const again = await p.$eval('.rate.r1 span', s => s.textContent);
  if (again === '2m') sawNew = true;
  await p.keyboard.press('3'); await p.waitForTimeout(150);
}
ok(sawNew, "a new card's Again button follows the deck's own first step (2m)");
await p.click('#endBtn').catch(() => {});

// ---- easy days and evening out, with the real scheduler ----
const spread = await p.evaluate(async () => {
  const { rate } = await import('./js/srs.js'); const { schedulerOptions } = await import('./js/sched-settings.js');
  const { loadByDay } = await import('./js/balance.js'); const { dayStart } = await import('./js/days.js');
  const D = 86400000, now = Date.now();
  const st = i => ({ cardId: 'x' + i, due: now, stability: 10, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 10 * D, elapsedDays: 10, scheduledDays: 10, learningSteps: 0 });
  const run = easyDays => {
    const balance = { load: new Map(), easyDays };
    const days = [];
    for (let i = 0; i < 40; i++) days.push(rate('x' + i, st(i), 3, { ...schedulerOptions({}), balance }, now));
    return days.map(s => ({ day: Math.round((dayStart(s.due) - dayStart(now)) / D), weekday: new Date(dayStart(s.due)).getDay() }));
  };
  const normal = run(['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal']);
  const weekend = run(['minimum', 'normal', 'normal', 'normal', 'normal', 'normal', 'minimum']);
  return { normalDays: [...new Set(normal.map(x => x.day))].length, normalMax: Math.max(...Object.values(normal.reduce((m, x) => ({ ...m, [x.day]: (m[x.day] || 0) + 1 }), {}))),
    weekendOnWeekend: weekend.filter(x => x.weekday === 0 || x.weekday === 6).length, spanOk: normal.every(x => x.day >= 5 && x.day <= 60) };
});
ok(spread.normalDays >= 4 && spread.normalMax <= 12 && spread.spanOk, `40 cards with the same gap are spread over ${spread.normalDays} days (at most ${spread.normalMax} on one day)`);
ok(spread.weekendOnWeekend <= 2, `with weekends set to Minimum, ${spread.weekendOnWeekend} of 40 land on a weekend`);
// easy days setting UI
await p.goto('http://localhost:8123/#/settings'); await p.waitForSelector('[data-easy="6"]', { state: 'attached' });
if (!(await p.evaluate(() => document.getElementById('advanced').open))) await p.click('#advanced summary'); await p.selectOption('[data-easy="6"]', 'minimum'); await p.selectOption('[data-easy="0"]', 'reduced');
const ed = (await p.evaluate(async () => (await import('./js/db.js')).getSettings())).easyDays;
ok(ed[6] === 'minimum' && ed[0] === 'reduced' && ed[1] === 'normal', 'easy days saved: ' + ed.join(','));
await p.locator('.easy-days').scrollIntoViewIfNeeded(); await p.screenshot({ path: SP + '/B-easy.png' });
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
