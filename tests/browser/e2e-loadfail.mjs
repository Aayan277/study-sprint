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
await browser.close();
