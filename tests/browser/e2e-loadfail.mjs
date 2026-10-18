// When a screen's file can't be loaded, show a friendly message with a Reload button, not the raw error.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
let blocked = true;
await page.route('**/js/stats.js', route => blocked ? route.abort() : route.continue());
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.click('.tab[data-tab=stats]');
await page.waitForSelector('[data-reload]');
const text = (await page.innerText('#screen')).replace(/\s+/g, ' ');
ok(text.includes("Couldn't load this screen. Check your connection and reload."), 'friendly message: ' + text.replace(/\s+/g, ' ').trim());
ok(!/dynamically|Failed to fetch/i.test(text), 'no raw error text');
blocked = false;
await Promise.all([page.waitForEvent('load'), page.click('[data-reload]')]);
await page.waitForSelector('.pgrid');
ok(true, 'Reload brings the screen back');

// Back online (no Reload pressed): the screen loads by itself, from a fresh address because the browser remembers a failed import.
const ctx2 = await browser.newContext({ serviceWorkers: 'block' });
const p2 = await ctx2.newPage();
let down = true;
const asked = [];
await p2.route('**/js/stats.js**', route => { asked.push(route.request().url()); return down ? route.abort() : route.continue(); });
await p2.goto('http://localhost:8123/#/decks'); await p2.waitForSelector('.deck');
await p2.click('.tab[data-tab=stats]');
await p2.waitForSelector('[data-reload]');
down = false;
await p2.evaluate(() => dispatchEvent(new Event('online')));
await p2.waitForSelector('.pgrid', { timeout: 15000 });
ok(await p2.locator('[data-reload]').count() === 0, 'back online: the screen loaded without pressing Reload');
ok(asked.length === 2 && /stats\.js\?r=\d+/.test(asked[1]), 'the retry asked for a fresh address: ' + asked.map(u => u.replace(/^.*\/js\//, '')).join(', '));
await browser.close();
