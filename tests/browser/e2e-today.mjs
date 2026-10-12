// Today: the home screen. Counts, Start, per-deck start, Options, exam badge, done state, flip and focus mode.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const focusOn = () => page.evaluate(() => document.body.classList.contains('focus'));
const run = (fn, arg) => page.evaluate(fn, arg);

// Opening the app with no hash goes to Today
await page.goto('http://localhost:8123/'); await page.waitForSelector('.today-hero');
ok(page.url().endsWith('#/today'), 'app opens on Today');
ok((await page.textContent('.tab[aria-current=page]')).trim() === 'Today', 'Today tab is highlighted');
ok(JSON.stringify(await page.$$eval('.tab', t => t.map(x => x.textContent.trim()))) === '["Today","Decks","Play","Stats"]', 'tabs: Today, Decks, Play, Stats');
ok((await page.textContent('#startBtn')).includes('12 cards') && (await page.textContent('#startBtn')).includes('min'), 'Start shows 12 cards and a time estimate');
ok(+(await page.textContent('[data-count=new]')) === 12 && +(await page.textContent('[data-count=due]')) === 0, 'counts: 12 new, 0 due');
ok((await page.textContent('.streak')).includes('0') && (await page.textContent('.streak')).includes('Study today to start one'), 'no streak yet');
await noHScroll('today'); await page.screenshot({ path: SP + '/t-today.png', fullPage: true });

// More decks, an exam, and some history
await run(async () => {
  const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
  await db.addDeckWithCards({ id: 'B', name: 'Second', color: '#E5484D', created: now + 1, course: 'BIO 2' }, [1, 2, 3, 4].map(i => ({ id: 'b' + i, deckId: 'B', front: 'B front ' + i, back: 'B back ' + i, tags: [], created: i })));
  await db.putMany('cardStates', [1, 2].map(i => ({ cardId: 'b' + i, due: now - D, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 6 * D, elapsedDays: 6, scheduledDays: 5, learningSteps: 0 })));
  const x = new Date(now + 9 * D);
  await db.saveDeck({ ...(await db.getDeck('B')), examDate: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` });
});
await page.reload(); await page.waitForSelector('.tdeck');
ok(await page.locator('.tdeck').count() === 2, 'a row per deck');
const rowB = await page.locator('.tdeck', { hasText: 'Second' }).textContent();
ok(/2\s*due/.test(rowB) && /2\s*new/.test(rowB) && rowB.includes('Exam in'), 'deck row: due, new and exam badge: ' + rowB.replace(/\s+/g, ' ').trim());
ok((await page.textContent('.exams')).includes('Second') && (await page.textContent('.exams')).includes('Exam in'), 'upcoming exams lists the deck');
ok((await page.textContent('#startBtn')).includes('16 cards'), 'Start counts every deck: 16');

// One tap on a deck row starts just that deck
await page.click('.tdeck:has-text("Second")'); await page.waitForSelector('#flash');
ok((await page.textContent('.flash-deck')).includes('Second'), 'deck row starts that deck');
ok(await focusOn(), 'focus mode is on during a round');
// Both faces are in the page; Space then 3 straight away rates the card
ok(await page.locator('.rv-face').count() === 2, 'front and back are both in the page');
const front = await page.textContent('.flash-front');
await page.keyboard.press('Space'); await page.keyboard.press('3');
await page.waitForFunction(f => document.querySelector('.flash-front')?.textContent !== f, front, { timeout: 2000 });
ok((await page.textContent('.flash-front')) !== front && (await page.locator('.rv-card.flipped').count()) === 0, 'Space then 3 rates at once, without waiting for the flip: a new, unflipped card is showing');
await page.evaluate(() => { location.hash = '#/decks'; }); await page.waitForSelector('.deck');
ok(!(await focusOn()), 'focus mode is off after leaving a round');

// Resume banner, then old #/review link
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#resumeBtn');
ok(/\d+ cards? left/.test(await page.textContent('.resume')) && (await page.getAttribute('#resumeBtn', 'href')).startsWith('#/review/'), 'Today offers Resume with the cards left: ' + (await page.textContent('.resume')).replace(/\s+/g, ' ').trim());
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/review'); await page.reload(); await page.waitForSelector('.today-hero');   // (a reload: no session in memory)
ok(page.url().endsWith('#/today'), '#/review with nothing started goes to Today');

// Options: decks, answer by, custom study
await page.click('#optBtn'); await page.waitForSelector('#deckChips');
ok(await page.locator('#modeChips [data-typing]').count() === 2 && await page.locator('#customBtn').count() === 1 && await page.locator('#deckChips [data-deck]').count() === 2, 'Options has decks, answer by and Custom study');
await page.click('#deckChips [data-deck="B"]');
ok((await page.textContent('#startBtn')).includes('3 cards') && (await page.textContent('.filtered')).includes('1 of 2'), 'choosing a deck narrows Start to its cards: ' + await page.textContent('#startBtn') + ' | ' + await page.textContent('.filtered'));
await page.click('#optDone');
await page.click('#startBtn'); await page.waitForSelector('#flash');
ok((await page.textContent('.flash-deck')).includes('Second'), 'Start follows the chosen decks');
await page.click('#endBtn'); await page.waitForSelector('.finish-next');
ok((await page.textContent('.finish-next')).includes('day streak') && (await page.textContent('.finish-next')).includes('due tomorrow') && (await page.textContent('.finish-next')).includes('Play a round'), 'finish shows streak, tomorrow and a Play suggestion');
ok(!(await focusOn()), 'focus mode is off on the finish screen');
await page.screenshot({ path: SP + '/t-finish.png' });
await page.click('#againBtn'); await page.waitForSelector('.today-hero');
await page.click('#optBtn'); await page.click('[data-all]'); await page.click('#optDone');

// Done state
await run(async () => {
  const db = await import('./js/db.js'); const st = await db.getAll('cardStates');
  await db.putMany('cardStates', st.map(s => ({ ...s, due: Date.now() + 3 * 86400000 }))); await db.setSetting('newPerDay', 0);
});
await page.reload(); await page.waitForSelector('.th-done');
ok((await page.textContent('.th-done')).includes('All done for today') && (await page.textContent('.th-done')).includes('next card is due in'), 'done state shows when the next card is due');
ok(await page.locator('.th-done a[href="#/play"]').count() === 1 && await page.locator('#startBtn').count() === 0, 'done state suggests Play');
await page.screenshot({ path: SP + '/t-done.png', fullPage: true }); await noHScroll('done');

// Keyboard: Tab reaches Options, then the deck rows; focus ring is visible
await page.keyboard.press('Tab');
const order = [];
for (let i = 0; i < 8; i++) { order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className || document.activeElement.tagName)); await page.keyboard.press('Tab'); }
ok(order.includes('optBtn'), 'Tab reaches Options: ' + order.join(', '));
await page.focus('#optBtn'); await page.keyboard.press('Enter'); await page.waitForSelector('#deckChips');
ok(await page.locator('#sheet[open] #deckChips').count() === 1, 'Enter opens Options'); await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.getElementById('sheet').open);
ok(await page.evaluate(() => document.activeElement?.id) === 'optBtn', 'closing Options puts focus back on the Options button');

ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
