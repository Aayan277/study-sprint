// Screen changes for screen readers: the page title follows the screen, and focus moves to the main heading.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const focusInfo = () => page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent.trim(), scrollY }));
const go = async (hash, selector) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForSelector(selector); await page.waitForTimeout(100); };

await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('.today-hero');
ok(await page.title() === 'Today · Study Sprint', 'first load: title "Today · Study Sprint"');
ok((await focusInfo()).tag !== 'H1', 'first load: focus is left alone');

await go('#/decks', '.deck');
ok(await page.title() === 'Decks · Study Sprint', 'Decks: title');
ok(JSON.stringify(await focusInfo()).includes('"tag":"H1"') && (await focusInfo()).text === 'Decks', 'Decks: focus on the heading');
await go('#/stats', '.chart');
ok(await page.title() === 'Stats · Study Sprint' && (await focusInfo()).text === 'Stats', 'Stats: title and focus');
await go('#/settings', '#exportBtn');
ok(await page.title() === 'Settings · Study Sprint' && (await focusInfo()).text === 'Settings', 'Settings: title and focus');
await go('#/play', '#startBtn');
ok(await page.title() === 'Play · Study Sprint' && (await focusInfo()).text === 'Play', 'Play: title and focus');
await go('#/decks', '.deck-open');
await page.click('.deck-open'); await page.waitForSelector('.crow');
const deckName = await page.textContent('h1');
ok(await page.title() === `${deckName} · Study Sprint` && (await focusInfo()).text === deckName, 'a deck: its name is the title, and the heading has focus');
ok((await focusInfo()).scrollY === 0, 'focus moved without scrolling the page');

// During a Review round focus is managed by the round, not moved to a heading
await go('#/today', '#startBtn');
ok(await page.title() === 'Today · Study Sprint' && (await focusInfo()).text === 'Today', 'Today: title and focus');
await page.click('#startBtn'); await page.waitForSelector('#flash');
ok(await page.title() === 'Review · Study Sprint' && (await focusInfo()).tag !== 'H1', 'a Review round keeps its own focus');
ok(await page.evaluate(() => document.activeElement.id === 'showBtn'), 'focus is on the Show answer button');

ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
await browser.close();
