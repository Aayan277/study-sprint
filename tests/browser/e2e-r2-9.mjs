// Round 2 #9: the Review bar shows one "N left" count; the New / Learn / Due split is in the tooltip and the aria-label.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
const errors = []; p.on('pageerror', e => errors.push(e.message));
await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'B', name: 'Second', color: '#E5484D', created: now + 1 }, [1, 2, 3, 4, 5, 6].map(i => ({ id: 'b' + i, deckId: 'B', front: 'B front ' + i, back: 'B back ' + i, tags: [], created: i })));
});
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
await p.evaluate(() => { location.hash = '#/decks'; });
await p.waitForSelector('.deck-open[data-study="B"]'); await p.click('.deck-open[data-study="B"]'); await p.waitForSelector('#flash');
const shown = await p.$eval('.rv-counts', e => getComputedStyle(e, '::before').content);
ok(shown === '"6 left"', 'the bar shows one count: ' + shown);
ok(await p.$$eval('.rv-counts span', s => s.every(x => getComputedStyle(x).display === 'none')), 'the New / Learn / Due counters are not drawn');
ok((await p.getAttribute('.rv-counts', 'aria-label')) === '6 left: 6 new, 0 learning, 0 due', 'the aria-label has the split: ' + await p.getAttribute('.rv-counts', 'aria-label'));
await p.hover('.rv-counts'); await p.waitForSelector('.ui-tip:not([hidden])');
ok(/New 6 · Learn 0 · Due 0 · This card: New/.test(await p.textContent('.ui-tip')), 'the tooltip has the split and the current card\'s kind: ' + await p.textContent('.ui-tip'));
await p.mouse.move(5, 5);
await p.click('#showBtn'); await p.click('.rate.r1'); await p.waitForTimeout(300);
ok((await p.getAttribute('.rv-counts', 'data-left')) === '6 left' && /1 learning/.test(await p.getAttribute('.rv-counts', 'aria-label')), 'after Again the card is in Learning and still counted once: ' + await p.getAttribute('.rv-counts', 'aria-label'));
ok(errors.length === 0, 'no page errors: ' + errors.join('|'));
await browser.close();
