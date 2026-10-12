// Stats must not show stale numbers after the data changes: by sync (db.applyRemote) or by an answer saved here.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
const page = await ctx.newPage();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const streak = async () => {
  await page.click('.tab[data-tab=decks]'); await page.waitForSelector('.deck');
  await page.click('.tab[data-tab=stats]'); await page.waitForSelector('.pgrid');
  return parseInt(await page.textContent('.pgrid .big'));
};

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
ok((await streak()) === 0, 'no answers yet: streak 0');

// Changes arriving from the server, with no sync event at all.
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const [card] = await db.getAll('cards');
  const data = { cardId: card.id, timestamp: Date.now(), source: 'review', mode: 'flip', correct: true, ms: 1000, rating: 3, state: 2, uid: 'remote-1' };
  await db.applyRemote([{ store: 'reviewLog', id: 'remote-1', updated_at: Date.now(), deleted: false, data }]);
});
ok((await streak()) === 1, 'after applyRemote the streak is 1');

// An answer saved on this device yesterday.
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const [card] = await db.getAll('cards');
  await db.addLog({ cardId: card.id, timestamp: Date.now() - 86400000, source: 'review', mode: 'flip', correct: true, ms: 1000, rating: 3, state: 2 });
});
ok((await streak()) === 2, 'after a local answer the streak is 2');

await browser.close();
