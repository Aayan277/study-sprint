// Release 4.68 WP-C: the Decks search counts tag: searches with the real count, and the live region is always there.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.stack)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('body');
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  const mk = (deckId, n, pre) => Array.from({ length: n }, (_, i) => ({ id: `${deckId}${i}`, deckId, front: `${pre} front ${i}`, back: `${pre} back ${i}`, tags: [], created: i }));
  const a = mk('A', 3, 'alpha'); a[0].tags = ['bio']; a[1].tags = ['bio::cell'];
  await db.addDeckWithCards({ id: 'A', name: 'Cell Biology', color: '#46A758', created: now + 1 }, a);
  await db.addDeckWithCards({ id: 'B', name: 'Law', color: '#E5484D', created: now + 2 }, mk('B', 2, 'law'));
});
await p.reload(); await p.waitForSelector('#deckGrid .deck');
ok(!!await p.$('#cardHits [aria-live]'), 'live region exists before any typing');
await p.fill('#deckSearch', 'tag:bio'); await p.waitForSelector('#deckGrid[data-searched="tag:bio"]'); await p.waitForSelector('#showHits');
ok((await p.textContent('#showHits')).trim() === 'Show 2 matching cards', 'tag:bio reads "Show 2 matching cards"');
ok(await p.$eval('#deckNone', e => e.hidden), 'no-match message stays hidden');
ok((await p.$$('#deckGrid .deck')).length === 1, 'the deck tile shows');
await p.click('#showHits'); await p.waitForSelector('.crow');
ok(p.url().endsWith('#/browse') && (await p.$$('.crow')).length === 2, 'Show 2 opens Browse with 2 rows');
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('#deckGrid .deck');
await p.fill('#deckSearch', 'tag:nosuch'); await p.waitForSelector('#deckNone:not([hidden])');
ok((await p.textContent('#deckNone')).includes('No decks or cards match'), 'tag:nosuch says no decks or cards match');
ok(errors.length === 0, 'no console errors ' + errors.join('|'));
await browser.close();
