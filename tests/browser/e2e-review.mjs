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
const dbq = fn => page.evaluate(async src => { const db = await import('./js/db.js'); return (new Function('db', 'return (' + src + ')(db)'))(db); }, fn.toString());
const counts = async () => (await page.textContent('.rv-counts')).trim().split(/\s+/).map(Number);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
ok((await page.getAttribute('#screen', 'aria-live')) === null && (await page.getAttribute('#toast', 'role')) === 'status', 'the whole screen is not a live region; the toast still announces');
// gear toggle: deck page -> settings -> gear -> back to deck page
await page.click('.deck-open'); await page.waitForSelector('.crow'); const deckUrl = page.url();
await page.click('#gearBtn'); await page.waitForSelector('#npd');
ok((await page.getAttribute('#gearBtn', 'aria-label')) === 'Close settings', 'gear becomes a close button');
await page.click('#gearBtn'); await page.waitForSelector('.crow');
ok(page.url() === deckUrl, 'gear closes settings and returns to the deck page');
// opened straight onto settings -> gear goes to decks
{ const p2 = await ctx.newPage(); await p2.goto('http://localhost:8123/#/settings'); await p2.waitForSelector('#npd');
  await p2.click('#gearBtn'); await p2.waitForSelector('.deck');
  ok(p2.url().endsWith('#/decks'), 'gear from a direct settings link goes to decks'); await p2.close(); }
await page.click('.tab[data-tab=decks]'); await page.waitForSelector('.deck');

// review setup
await page.click('.tab[data-tab=review]'); await page.waitForSelector('#startBtn');
ok((await page.textContent('#startBtn')).includes('12 cards'), 'setup: 12 new cards from the sample deck');
await page.screenshot({ path: SP + '/r-setup.png', fullPage: true }); await noHScroll('review setup');
await page.click('#startBtn'); await page.waitForSelector('#flash');
const focusOn = () => page.evaluate(() => document.body.classList.contains('focus'));
ok(await focusOn(), 'focus mode is on during a Review round');
ok(JSON.stringify(await counts()) === '[12,0,0]', 'counts start at 12 new');
const front1 = await page.textContent('.flash-front');
await page.screenshot({ path: SP + '/r-front.png' });
await page.keyboard.press('Space'); await page.waitForSelector('.rate');
const labels = await page.$$eval('.rate', bs => bs.map(b => b.querySelector('b').textContent + ' ' + b.querySelector('span').textContent));
console.log('   buttons:', labels.join(' | '));
ok(labels[0] === 'Again 1m' && labels[2] === 'Good 10m', 'new-card intervals shown on buttons');
await page.screenshot({ path: SP + '/r-back.png' }); await noHScroll('review card');
await page.keyboard.press('3');   // Good
await page.waitForFunction(f => document.querySelector('.flash-front')?.textContent !== f, front1);
ok(JSON.stringify(await counts()) === '[11,1,0]', 'Good on a new card: it moves to learning (comes back in 10m)');
let st = await dbq(db => db.getAll('cardStates'));
let logs = await dbq(db => db.getAll('reviewLog'));
ok(st.length === 1 && st[0].state === 1 && logs.length === 1 && logs[0].rating === 3 && logs[0].source === 'review' && logs[0].state === 0 && logs[0].ms > 0, 'state and log saved: ' + JSON.stringify(logs[0]));
// undo
await page.click('#undoBtn');
ok(await page.waitForFunction(f => document.querySelector('.flash-front')?.textContent === f, front1, { timeout: 3000 }).then(() => true, () => false), 'undo shows the same card again');
st = await dbq(db => db.getAll('cardStates')); logs = await dbq(db => db.getAll('reviewLog'));
ok(st.length === 0 && logs.length === 0, 'undo removed the saved state and log');
ok(JSON.stringify(await counts()) === '[12,0,0]', 'undo restored counts');
// Enter on the focused card flips it; Enter on a focused rating button presses that button (Again), not the suggested Good
await page.focus('#flash'); await page.keyboard.press('Enter'); await page.waitForSelector('.rate');
await page.focus('.rate.r1'); await page.keyboard.press('Enter');
await page.waitForFunction(() => !document.querySelector('.rate'));
logs = await dbq(db => db.getAll('reviewLog'));
ok(logs.length === 1 && logs[0].rating === 1, 'Enter on the Again button rates Again: ' + JSON.stringify(logs.map(l => l.rating)));
await page.click('#undoBtn'); await page.waitForFunction(() => document.querySelector('.rv-counts')?.textContent.trim().split(/\s+/)[0] === '12');
// tap card to flip, Again via button
await page.click('#flash'); await page.click('.rate.r1');
await page.waitForFunction(() => !document.querySelector('.rate'));
ok(JSON.stringify(await counts()) === '[11,1,0]', 'Again: card comes back this session');
// Easy on next new card -> review state, not requeued
await page.click('#showBtn'); await page.click('.rate.r4'); await page.waitForFunction(() => !document.querySelector('.rate'));
ok(JSON.stringify(await counts()) === '[10,1,0]', 'Easy: card graduates, not shown again today');
st = await dbq(db => db.getAll('cardStates'));
const easy = st.find(s => s.state === 2);
ok(easy && easy.due - Date.now() > 3 * 86400000, 'Easy card scheduled days ahead');
// leave the tab and come back: session resumes
await page.evaluate(() => { location.hash = '#/decks'; }); await page.waitForSelector('.deck');   // the tab bar is hidden during a round on phones
const dueText = await page.textContent('.deck-counts .due');
ok(dueText.includes('1'), 'deck list shows the learning card as due today: ' + dueText);
await page.click('.tab[data-tab=review]'); await page.waitForSelector('#flash');
ok(JSON.stringify(await counts()) === '[10,1,0]', 'session resumes after visiting another tab');
// end
await page.click('#endBtn'); await page.waitForSelector('.stats4');
const stats = await page.$$eval('.stats4 .v', vs => vs.map(v => v.textContent));
console.log('   finish:', stats.join(' | '));
ok(stats[0] === '2' && stats[1] === '50%', 'finish screen: 2 reviewed, 50% accuracy');
ok(!(await focusOn()), 'focus mode is off on the finish screen');
await page.screenshot({ path: SP + '/r-finish.png' });

// typing mode
await page.click('#againBtn'); await page.waitForSelector('#startBtn');
await page.click('[data-typing="1"]'); await page.click('#startBtn'); await page.waitForSelector('#flash');
const card = await page.evaluate(async () => {
  const db = await import('./js/db.js'); const f = document.querySelector('.flash-front').textContent;
  return (await db.getAll('cards')).find(c => c.front === f);
});
const short = card.back.length <= 40;
console.log('   current card:', card.front, '| back length', card.back.length);
if (!short) ok(await page.isVisible('.note.center'), 'long answer: told to flip instead');
// Sample backs are long, so add a short card and review it with typing.
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const d = await db.getDecks();
  await db.putMany('cards', [{ id: 'short1', deckId: d[0].id, front: 'Powerhouse of the cell', back: 'Mitochondria / mitochondrion', tags: [], created: 1 }]);
});
await page.click('#endBtn'); await page.waitForSelector('#againBtn'); await page.click('#againBtn'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#flash');
// skip cards until the short one shows (it's first by created order among new cards, but reviews/learning may be first)
for (let i = 0; i < 15 && (await page.textContent('.flash-front')) !== 'Powerhouse of the cell'; i++) {
  await page.click('#showBtn'); await page.click('.rate.r3'); await page.waitForTimeout(150);
}
ok((await page.textContent('.flash-front')) === 'Powerhouse of the cell', 'short card reached');
ok(await page.isVisible('#typeIn'), 'typing box shown for a short answer');
await page.fill('#typeIn', 'the mitocondria'); await page.keyboard.press('Enter');
await page.waitForSelector('.typed');
ok((await page.textContent('.typed')).includes('small typo'), 'typo forgiven: ' + await page.textContent('.typed'));
ok(await page.isVisible('.rate.r3.suggested'), 'Good is suggested');
await page.screenshot({ path: SP + '/r-typed.png' });
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.flash-front')?.textContent !== 'Powerhouse of the cell' || !document.querySelector('#flash'));
logs = await dbq(db => db.getAll('reviewLog'));
const tl = logs.find(l => l.cardId === 'short1');
ok(tl && tl.mode === 'typing' && tl.rating === 3, 'typed review logged as typing + Good');

// settings: new cards per day and retention
await page.evaluate(() => { location.hash = '#/settings'; }); await page.waitForSelector('#npd');   // the header is hidden during a round on phones
await page.click('#npdMinus'); ok((await page.inputValue('#npd')) === '15', 'new per day stepper');
await page.$eval('#ret', r => { r.value = 85; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
ok((await page.textContent('#retOut')) === '85%', 'retention slider label');
const s = await dbq(db => db.getSettings());
ok(s.newPerDay === 15 && s.targetRetention === 0.85, 'study settings saved');
await page.screenshot({ path: SP + '/r-settings.png', fullPage: true }); await noHScroll('settings');
// deck page review button
await page.click('#gearBtn'); await page.evaluate(() => { location.hash = '#/decks'; }); await page.waitForSelector('.deck');   // gear returns to the round, where the tab bar is hidden
await page.click('.deck-open'); await page.waitForSelector('a[href^="#/review/"]');
await page.click('a[href^="#/review/"]'); await page.waitForSelector('#flash, #startBtn');
ok(true, 'deck Review button opens review');
// offline: the app shell + FSRS library work offline
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload(); await page.waitForSelector('.deck');
await ctx.setOffline(true);
await page.goto('http://localhost:8123/#/review'); await page.waitForSelector('#startBtn, .empty', { timeout: 8000 });
ok(true, 'review screen loads offline');
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
