import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const card = front => page.evaluate(async f => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === f), front);
const front = () => page.textContent('.flash-front');
const total = () => page.$$eval('.rv-counts span', s => s.reduce((n, x) => n + +x.textContent, 0));

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// one card is a due review card (lapses 0), so Again makes it lapse
const target = await page.evaluate(async () => { const db = await import('./js/db.js'); const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
  await db.putMany('cardStates', [{ cardId: cs[5].id, due: Date.now() - 86400000, stability: 3, difficulty: 5, reps: 3, lapses: 0, state: 2, scheduled_days: 3, elapsed_days: 3, learning_steps: 0, last_review: new Date(Date.now() - 4 * 86400000) }]);
  return cs[5].front; });

// settings: leech after 1, tag + suspend
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#leech');
ok(await page.inputValue('#leech') === '8', 'leech threshold defaults to 8');
await page.click('#leechMinus'); ok(await page.inputValue('#leech') === '7', 'minus works');
await page.fill('#leech', '1'); await page.dispatchEvent('#leech', 'change');
await page.click('[data-leech=tag]'); await page.click('[data-leech=suspend]');
let s = await page.evaluate(async () => (await import('./js/db.js')).getSettings());
ok(s.leechThreshold === 1 && s.leechAction === 'suspend', 'leech settings saved');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'settings: no sideways scroll');
ok(await page.textContent('#appVersion').catch(() => '') !== null, 'settings rendered');

// review: ⋯ menu edit
await page.goto('http://localhost:8123/#/review'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('.flash');
// leech: rate the target card Again
let caught = false;
for (let i = 0; i < 20 && !caught; i++) {
  const f = await front();
  await page.keyboard.press(' '); await page.waitForSelector('.rate');
  if (f === target) { await page.keyboard.press('1'); caught = true; } else await page.keyboard.press('3');
  await page.waitForTimeout(250);
}
const lc = await card(target);
ok(caught && lc.suspended && lc.tags.includes('leech'), 'leech: tagged and suspended at the threshold');
ok((await page.textContent('#toast')).includes('Leech'), 'leech toast');
await page.click('#undoBtn'); await page.waitForTimeout(400);
const uc = await card(target);
ok(!uc.suspended && !uc.tags.includes('leech') && await front() === target, 'undo takes back the leech');

const n0 = await total();
const f1 = await front();
await page.click('#moreBtn'); await page.waitForSelector('#ceForm');
await page.fill('#ceFront', f1 + ' (edited)'); await page.click('#ceForm button[type=submit]'); await page.waitForTimeout(400);
ok(await page.isVisible('#ceForm'), 'panel stays open after edit');
await page.click('#ceClose');
ok(await front() === f1 + ' (edited)', 'edit shows on the review card');
await page.screenshot({ path: SP + '/p2-review.png' });
// keyboard: I opens info
await page.keyboard.press('i'); await page.waitForSelector('#ceForm');
ok(await page.evaluate(() => document.querySelector('.card-info').open), 'I opens card info');
await page.click('#ceClose');
// - buries
await page.keyboard.press('-'); await page.waitForTimeout(300);
ok((await card(f1 + ' (edited)')).buriedUntil > Date.now() && await front() !== f1 + ' (edited)' && await total() === n0 - 1, '- buries and moves on');
// @ suspends
const f2 = await front();
await page.keyboard.press('@'); await page.waitForTimeout(300);
ok((await card(f2)).suspended === true && await total() === n0 - 2, '@ suspends and moves on');
// ⋯ suspend closes the panel
const f3 = await front();
await page.click('#moreBtn'); await page.waitForSelector('#ceForm'); await page.click('[data-act=suspend]'); await page.waitForTimeout(400);
ok(!(await page.isVisible('#ceForm')) && (await card(f3)).suspended && await front() !== f3 && await total() === n0 - 3, '⋯ Suspend closes the panel and skips the card');
// flag stays
const f4 = await front();
await page.click('#moreBtn'); await page.waitForSelector('#ceForm'); await page.click('[data-flag="2"]'); await page.waitForTimeout(400); await page.click('#ceClose');
ok((await card(f4)).flag === 2 && await front() === f4, 'flag keeps the card on screen');

// play: Card ⋯ after answering
await page.goto('http://localhost:8123/#/play'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#pCard');
await page.waitForTimeout(300);
const pf = await page.textContent('#pPrompt');
await page.keyboard.press('1');
await page.waitForSelector('#cardBtn');
await page.screenshot({ path: SP + '/p2-play.png' });
await page.click('#cardBtn'); await page.waitForSelector('#ceForm');
await page.waitForTimeout(1200);
ok(await page.isVisible('#ceForm'), 'auto Next paused while the panel is open');
await page.click('[data-act=bury]'); await page.waitForTimeout(400);
ok(!(await page.isVisible('#ceForm')), 'bury closes the panel');
const buried = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.buriedUntil > Date.now()).length);
ok(buried === 2, 'card buried from Play');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'play: no sideways scroll');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
