// L10: reloading during a deep-linked review. A review opened straight from an address (a bookmark, a shared link, a
// restored tab) has no app entry under it. The page's session hold adds one on top; a reload on that entry used to step
// "back off it" and so left the review (or the app) instead of staying on the card.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const open = async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.goto('about:blank');
  return p;
};
const hash = p => p.evaluate(() => location.hash);
const st = p => p.evaluate(() => JSON.stringify([history.state?.ss, history.state?.k, location.hash, history.length]));
const left = p => p.url() === 'about:blank';

// Find a review address the normal way first.
const p0 = await open();
await p0.goto(URL + '#/decks'); await p0.waitForSelector('.deck');
await p0.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
await p0.waitForSelector('#reviewBtn'); await p0.click('#reviewBtn'); await p0.waitForSelector('#flash'); await p0.waitForTimeout(400);
const rv = await hash(p0);
await p0.close();
ok(/^#\/review/.test(rv), 'found a review address: ' + rv);

const p = await open();
await p.goto(URL + rv); await p.waitForSelector('#flash'); await p.waitForTimeout(500);
console.log('deep link opened:', await st(p));
for (let i = 1; i <= 2; i++) {
  await p.reload(); await p.waitForTimeout(1500);
  console.log('after reload ' + i + ':', await st(p), 'url', p.url());
  ok(/^#\/review/.test(await hash(p)) && !!(await p.$('#flash')), `reload ${i}: still on the review card`);
}
await p.goBack(); await p.waitForTimeout(600);
console.log('after Back:', p.url());
const asked = await p.evaluate(() => document.getElementById('sheet')?.open);
ok(asked || left(p) || /^#\/(today|decks)/.test(await hash(p)), 'Back after the reload asks to end, or goes to Today/Decks, or leaves the app (not a stale entry)');
await p.close();
await browser.close();
