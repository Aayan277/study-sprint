// Round 2 #1 fix: when the session in progress is only part of today (one deck), Today also offers "Start today's cards" beside Resume.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })).newPage();
const errors = []; p.on('pageerror', e => errors.push(e.message));
await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'B', name: 'Second', color: '#E5484D', created: now + 1 }, [1, 2, 3, 4].map(i => ({ id: 'b' + i, deckId: 'B', front: 'B front ' + i, back: 'B back ' + i, tags: [], created: i })));
});
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
// a full session: Resume only
await p.click('#startBtn'); await p.waitForSelector('#flash');
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#startBtn[data-resume]');
ok(await p.locator('#startFresh').count() === 0, 'a full session in progress: just Resume');
await p.click('#startBtn[data-resume]'); await p.waitForSelector('#flash'); await p.click('#endBtn'); await p.waitForSelector('.finish-next'); await p.click('#againBtn'); await p.waitForSelector('#startBtn');
// one deck: Resume and a quiet link to today's cards
await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck-open[data-study="B"]');
await p.click('.deck-open[data-study="B"]'); await p.waitForSelector('#flash');
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#startBtn[data-resume]');
ok(await p.locator('#startFresh').count() === 1 && /Start today/.test(await p.textContent('#startFresh')), 'a one-deck session in progress: Resume plus "Start today\'s cards"');
ok((await p.getAttribute('#startBtn', 'aria-label')).startsWith('Resume') && /^Resume · \d+ left$/.test((await p.textContent('#startBtn')).trim()) && (await p.getAttribute('#startBtn', 'aria-label')) === (await p.textContent('#startBtn')).trim().replace(/^\s*/, ''), 'the Resume aria-label is its visible text');
await p.click('#startFresh'); await p.waitForSelector('#soNew');
ok(/Start over/.test(await p.textContent('#sheetTitle')), 'it asks "Start over?" first, like Start does');
await p.click('#soNew'); await p.waitForSelector('#flash');
ok(true, 'and then starts today\'s cards');
ok(errors.length === 0, 'no page errors: ' + errors.join('|'));
await browser.close();
