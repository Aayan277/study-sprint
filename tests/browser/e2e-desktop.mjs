import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const open = async (viewport, extra = {}) => {
  const p = await (await browser.newContext({ viewport, serviceWorkers: 'block', ...extra })).newPage();
  p.on('pageerror', e => errors.push(e.stack));
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
  return p;
};
const box = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

// ---- computer ----
let p = await open({ width: 1440, height: 900 });
let nav = await box(p, '.tabs');
ok(nav.x === 0 && nav.w === 248 && nav.h > 700, 'sidebar on the left (248px from 1280px wide)');
ok((await box(p, 'main')).x >= 248, 'page sits next to the sidebar');
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceForm');
const panel = await box(p, '#sheet');
ok(panel.x > 900 && panel.h > 800 && await p.evaluate(() => document.body.classList.contains('has-side')), 'card panel opens down the right-hand side');
ok(await p.evaluate(() => !document.querySelector('#sheet').matches(':modal')), 'the list stays usable next to it (not a pop-up)');
const first = await p.textContent('#ceFront');
await p.locator('.crow').nth(1).click(); await p.waitForFunction(f => document.querySelector('#ceFront')?.textContent !== f, first);
ok(await p.locator('.crow.sel').count() === 1 && (await p.locator('.crow.sel').getAttribute('data-id')) === (await p.locator('.crow').nth(1).getAttribute('data-id')), 'clicking another card switches the panel and highlights it');
await p.keyboard.press('Escape');
ok(!(await p.evaluate(() => document.querySelector('#sheet').open)) && !(await p.evaluate(() => document.body.classList.contains('has-side'))) && !(await p.locator('.crow.sel').count()), 'Escape closes it');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceForm');
await p.click('.tab[data-tab=stats]'); await p.waitForSelector('main[data-route=stats] .card');
ok(!(await p.evaluate(() => document.querySelector('#sheet').open)), 'changing screens closes the panel');
ok((await p.$eval('main', m => m.dataset.route)) === 'stats', 'screen name set for the layout');
// a confirmation is still a centered pop-up
await p.goto('http://localhost:8123/#/settings'); await p.waitForSelector('#resetBtn', { state: 'attached' }); await p.click('#dangerZone > summary'); await p.click('#resetBtn'); await p.waitForSelector('#rsYes');
ok(await p.evaluate(() => document.querySelector('#sheet').matches(':modal') && !document.querySelector('#sheet').classList.contains('side')), 'confirmations stay as pop-ups');
await p.click('#rsNo');
// review: keyboard hints visible with a mouse
await p.goto('http://localhost:8123/#/review'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#showBtn');
ok(await p.isVisible('#showBtn .key-hint'), 'Space hint shown on a computer');
// the side panel from Review's ⋯ sits beside the card
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
ok((await box(p, '#sheet')).x > 900 && (await box(p, '.flash')).x + (await box(p, '.flash')).w <= (await box(p, '#sheet')).x, 'Review ⋯ panel sits beside the card');
await p.screenshot({ path: SP + '/desk/review-panel.png' });

// ---- in between: sidebar, but cards open as a pop-up ----
p = await open({ width: 1100, height: 800 });
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceForm');
ok((await box(p, '.tabs')).w === 232 && await p.evaluate(() => document.querySelector('#sheet').matches(':modal')), '1100px: sidebar, and the card opens as a pop-up');

// ---- phone: unchanged ----
p = await open({ width: 375, height: 740 }, { isMobile: true, hasTouch: true });
nav = await box(p, '.tabs');
ok(nav.y > 650 && nav.w === 375, 'phone: tabs still along the bottom');
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceForm');
ok(await p.evaluate(() => document.querySelector('#sheet').matches(':modal') && !document.body.classList.contains('has-side')), 'phone: card opens as the usual sheet');
await p.goto('http://localhost:8123/#/review'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#showBtn');
ok(!(await p.isVisible('#showBtn .key-hint')), 'phone: no keyboard hints');

// ---- dark mode on a computer ----
p = await open({ width: 1440, height: 900 }, { colorScheme: 'dark' });
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceForm');
await p.screenshot({ path: SP + '/desk/dark.png' });
ok(true, 'dark mode screenshot taken');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
