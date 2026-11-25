// Round 2 #4: the finish screen says how many cards were rated Again in this session and offers "Go over these" for just those.
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
  await db.setSetting('reviewDecks', ['B']);
});
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
const rate = async n => { await p.click('#showBtn'); await p.click(`.rate.r${n}`); await p.waitForTimeout(250); };
await p.click('#startBtn'); await p.waitForSelector('#flash');
await rate(4);                              // Easy: not missed
await p.click('#endBtn'); await p.waitForSelector('.fin-missed');
ok((await p.textContent('.fin-missed')).trim() === '0 missed' && await p.locator('#missedBtn').count() === 0, 'nothing rated Again: "0 missed" and no button');
await p.click('#againBtn'); await p.waitForSelector('#startBtn');
await p.click('#startBtn'); await p.waitForSelector('#flash');
await rate(1); await rate(4);               // one Again, one Easy
await p.click('#endBtn'); await p.waitForSelector('.fin-missed');
ok(/^1 missed/.test((await p.textContent('.fin-missed')).trim()) && await p.locator('#missedBtn').count() === 1, 'one card rated Again: "1 missed" and "Go over these"');
ok((await p.textContent('#missedBtn')).trim() === 'Go over these', 'the button says Go over these');
await p.click('#missedBtn'); await p.waitForSelector('#flash');
const left = (await p.textContent('.rv-counts')).replace(/\D+/g, ' ').trim().split(' ').map(Number).reduce((a, b) => a + b, 0);
ok(left === 1, 'it starts a session of just that card: ' + left + ' card to go');
ok(/Missed cards/.test(await p.textContent('.flash-deck')), 'the session is named "Missed cards": ' + (await p.textContent('.flash-deck')).trim());
ok(errors.length === 0, 'no page errors: ' + errors.join('|'));
await browser.close();
