import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 320, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noH = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const total = () => page.$$eval('.rv-counts span', s => s.reduce((n, x) => n + +x.textContent, 0));
const chip = name => page.locator('[data-deck]', { hasText: name }).locator('small').textContent();

await page.goto('http://localhost:8123/'); await page.waitForSelector('.deck');
const ids = await page.evaluate(async () => {
  const db = await import('./js/db.js'); const D = 86400000, now = Date.now();
  const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
  await db.addDeckWithCards({ id: 'B', name: 'Second', course: '', color: '#3E63DD', created: now }, ['b1', 'b2', 'b3'].map((f, i) => ({ id: 'B' + i, deckId: 'B', front: f, back: f + '!', tags: [], created: now + i })));
  const st = (id, due) => ({ cardId: id, due, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, scheduled_days: 5, elapsed_days: 0, learning_steps: 0, last_review: new Date(now - D) });
  await db.putMany('cardStates', [st(cs[0].id, now + 2 * D), st(cs[1].id, now + 6 * D), st(cs[2].id, now + 30 * D)]);
  await db.addLog({ cardId: cs[2].id, timestamp: now - 60000, source: 'review', correct: false, rating: 1, ms: 3000, state: 2 });
  return cs.slice(0, 3).map(c => c.front);
});

// per-deck limit
await page.goto('http://localhost:8123/#/deck/B'); await page.waitForSelector('#editDeck');
await page.click('#editDeck'); await page.waitForSelector('#deckOpts'); await page.click('#deckOpts summary'); await page.waitForSelector('#deckNew');
ok(await page.inputValue('#deckNew') === '', 'deck limit blank by default');
await page.screenshot({ path: SP + '/p3-deck.png', fullPage: true });
await page.fill('#deckNew', '1'); await page.click('#deckForm button[type=submit]'); await page.waitForTimeout(300);
ok((await page.evaluate(async () => (await import('./js/db.js')).getDeck('B'))).newPerDay === 1, 'deck limit saved');

await page.goto('http://localhost:8123/#/review'); await page.waitForSelector('#customBtn');
ok(await chip('Second') === '0·1', 'Second deck limited to 1 new card: ' + await chip('Second'));
ok(await chip('Intro') === '0·9', 'sample deck: 9 new: ' + await chip('Intro'));

// custom study sheet
await page.click('#customBtn'); await page.waitForSelector('#csAheadBtn');
ok(await page.textContent('#csAheadBtn') === 'Review 1 card', '3 days ahead: 1 card');
await page.click('[data-days="7"]');
ok(await page.textContent('#csAheadBtn') === 'Review 2 cards', '1 week ahead: 2 cards');
ok(await page.textContent('#csForgotBtn') === 'Review 1 card', 'forgotten today: 1 card');
await noH('custom study'); await page.screenshot({ path: SP + '/p3-custom.png', fullPage: true });
await page.fill('#csNew', '5'); await page.dispatchEvent('#csNew', 'change'); await page.click('#csNewBtn');
await page.waitForFunction(() => document.querySelector('.note')?.textContent.includes('+ 5 extra'));
ok(await chip('Second') === '0·3' && await chip('Intro') === '0·9', 'extra new raises limits: ' + await chip('Second'));
const s = await page.evaluate(async () => (await import('./js/db.js')).getSettings());
ok(s.extraNew.n === 5, 'extra saved for today');

// review ahead session
await page.click('#customBtn'); await page.waitForSelector('#csAheadBtn'); await page.click('[data-days="7"]'); await page.click('#csAheadBtn');
await page.waitForSelector('.flash');
ok((await page.textContent('.flash-deck')).includes('Review ahead') && await total() === 2, 'review ahead session has 2 cards');
ok(await page.textContent('.flash-front') === ids[0], 'soonest first');
for (let i = 0; i < 2; i++) { await page.keyboard.press(' '); await page.waitForSelector('.rate'); await page.keyboard.press('3'); await page.waitForTimeout(250); }
await page.waitForSelector('#againBtn');
const due = await page.evaluate(async f => { const db = await import('./js/db.js'); const c = (await db.getAll('cards')).find(c => c.front === f); return (await db.get('cardStates', c.id)).due; }, ids[0]);
ok(due > Date.now() + 2 * 86400000, 'reviewed-ahead card rescheduled');
// back to setup: normal day not affected
await page.click('#againBtn'); await page.waitForSelector('#customBtn');
await page.click('#customBtn'); await page.waitForSelector('#csForgotBtn'); await page.click('#csForgotBtn');
await page.waitForSelector('.flash');
ok((await page.textContent('.flash-deck')).includes('Forgotten today') && await page.textContent('.flash-front') === ids[2], 'forgotten today session');
await noH('session');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
