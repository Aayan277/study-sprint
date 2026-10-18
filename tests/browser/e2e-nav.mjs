// Navigation feels like an app (v4.18, js/nav.js, docs/design/navigation.md): a back swipe / back button must not step through
// tabs, closes a sheet instead of leaving the page, and asks before leaving a running Review or Play round.
// page.goBack() is the browser's Back (the Android button and gesture, the iOS edge swipe, the desktop button).
// The test page starts from about:blank, so "went back to about:blank" means Back left the app.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const URL = 'http://localhost:8123/';

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto('about:blank');
  return p;
}
const hash = p => p.evaluate(() => location.hash);
const len = p => p.evaluate(() => history.length);
const left = p => p.url() === 'about:blank';
const back = async p => { await p.goBack(); await p.waitForTimeout(450); };
const tab = async (p, name) => { await p.click(`.tab[data-tab=${name}]`); await p.waitForTimeout(350); };
const sheetOpen = p => p.evaluate(() => document.getElementById('sheet').open);
const sheetTitle = p => p.evaluate(() => document.getElementById('sheetTitle')?.textContent || '');
const openTestSheet = p => p.evaluate(async () => (await import('./js/ui.js')).openSheet('<h2 id="sheetTitle">Test sheet</h2><p>Hello</p><div class="sheet-actions"><button class="btn primary" type="button" id="shDone">Done</button></div>'));

for (const style of ['original', 'clinical']) {
  const tag = `[${style}] `;
  const p = await open();
  await p.goto(URL + '#/today'); await p.waitForSelector('#screen .view h1, #screen .view');
  if (style === 'clinical') await p.evaluate(() => { document.documentElement.dataset.ui = 'clinical'; });
  await p.waitForTimeout(500);
  const L0 = await len(p);

  // ---- 1. tabs replace history ----
  await tab(p, 'decks'); await p.waitForSelector('.deck');
  await tab(p, 'stats'); await p.waitForSelector('#screen[data-route=stats]');
  await tab(p, 'play'); await p.waitForSelector('#startBtn');
  await tab(p, 'today');
  ok(await hash(p) === '#/today', tag + 'tabs: ended on Today');
  ok(await len(p) === L0, tag + `tabs: switching tabs adds no history entries (${L0} -> ${await len(p)})`);
  await tab(p, 'stats');
  await back(p);
  ok(left(p), tag + 'tabs: Back from Stats leaves the app, it does not step through Today/Decks/Play');

  // ---- 2. deck drill-down ----
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#reviewBtn, .deck-page, #back'); await p.waitForTimeout(300);
  const deckHash = await hash(p);
  ok(/^#\/deck\//.test(deckHash), tag + 'drill-down: a deck page opened (' + deckHash + ')');
  await back(p);
  ok(await hash(p) === '#/decks', tag + 'drill-down: Back from a deck returns to Decks');
  await p.waitForSelector('.deck');
  await back(p);
  ok(left(p), tag + 'drill-down: and Back again leaves the app');

  // deck's own back button, then Back
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#back'); await p.click('#back'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  ok(await hash(p) === '#/decks', tag + 'drill-down: the deck page back button returns to Decks');
  await back(p);
  ok(left(p), tag + 'drill-down: after that button, Back leaves the app (no stale deck entry)');

  // a tab from inside a drill-down drops the drill-down
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#back'); await tab(p, 'stats'); await p.waitForSelector('#screen[data-route=stats]');
  ok(await hash(p) === '#/stats', tag + 'tab from a deck page: Stats shows');
  await back(p);
  ok(left(p), tag + 'tab from a deck page: Back leaves the app (does not return to the deck or Decks)');

  // ---- 3. sheets ----
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  const L1 = await len(p);
  await openTestSheet(p); await p.waitForTimeout(200);
  ok(await sheetOpen(p), tag + 'sheet: opened');
  await back(p);
  ok(!(await sheetOpen(p)) && await hash(p) === '#/decks', tag + 'sheet: Back closes it and stays on the page');
  await back(p);
  ok(left(p), tag + 'sheet: the next Back leaves the app (the sheet left nothing behind)');
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  await openTestSheet(p); await p.waitForTimeout(200);
  await p.click('.sheet-x'); await p.waitForTimeout(450);
  ok(!(await sheetOpen(p)), tag + 'sheet: the x closes it');
  await back(p);
  ok(left(p), tag + 'sheet: after closing with the x, Back leaves the app (no leftover entry)');
  // a sheet closed by its own button, then another opened in the same tick
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  await openTestSheet(p);
  await p.evaluate(async () => { const ui = await import('./js/ui.js'); ui.closeSheet(); ui.openSheet('<h2 id="sheetTitle">Second</h2><p>2</p>'); });
  await p.waitForTimeout(450);
  ok(await sheetOpen(p) && await sheetTitle(p) === 'Second', tag + 'sheet: closing and opening another at once keeps the new one open');
  await back(p);
  ok(!(await sheetOpen(p)), tag + 'sheet: and Back closes that one');
  await back(p);
  ok(left(p), tag + 'sheet: and then leaves the app');

  // ---- 4. Review asks before leaving ----
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#reviewBtn'); await p.click('#reviewBtn'); await p.waitForSelector('#flash'); await p.waitForTimeout(400);
  const rvHash = await hash(p);
  await back(p);
  ok(await sheetOpen(p) && /End this session/.test(await sheetTitle(p)) && await hash(p) === rvHash, tag + 'review: Back asks "End this session?" and stays on the card');
  await back(p);
  ok(!(await sheetOpen(p)) && !!(await p.$('#flash')), tag + 'review: Back again closes the question, still reviewing');
  await back(p);
  ok(await sheetOpen(p), tag + 'review: and asks again');
  await p.click('#keepOn'); await p.waitForTimeout(450);
  ok(!(await sheetOpen(p)) && !!(await p.$('#flash')) && await hash(p) === rvHash, tag + 'review: Keep going stays in the session');
  await back(p);
  ok(await sheetOpen(p), tag + 'review: the gesture still asks after Keep going');
  await p.click('#endNow'); await p.waitForTimeout(600);
  ok(/Session ended/.test(await p.textContent('#screen h1')), tag + 'review: End session ends it (summary shown)');
  await back(p);
  ok(/^#\/deck\//.test(await hash(p)), tag + 'review: Back from the summary returns to the deck page (no dead press)');
  await back(p);
  ok(await hash(p) === '#/decks', tag + 'review: and then Decks');

  // End button (no back gesture) leaves no stale entry either
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#reviewBtn'); await p.click('#reviewBtn'); await p.waitForSelector('#flash'); await p.waitForTimeout(400);
  await p.click('#endBtn'); await p.waitForTimeout(600);
  await back(p);
  ok(/^#\/deck\//.test(await hash(p)), tag + 'review: after the End button, one Back returns to the deck page');

  // Start from Today (the Start button), the usual way in
  {
    const r = await open();
    await r.goto(URL + '#/today'); await r.waitForSelector('#startBtn'); await r.waitForTimeout(300);
    await r.click('#startBtn'); await r.waitForSelector('#flash'); await r.waitForTimeout(400);
    ok(/^#\/review/.test(await hash(r)), tag + 'review from Today: the Start button opens the session');
    await back(r);
    ok(await sheetOpen(r) && /End this session/.test(await sheetTitle(r)), tag + 'review from Today: Back asks too');
    await r.click('#endNow'); await r.waitForTimeout(600);
    await r.click('#againBtn'); await r.waitForSelector('#startBtn'); await r.waitForTimeout(400);
    ok(await hash(r) === '#/today', tag + 'review from Today: "Back to Today" shows Today');
    await back(r);
    ok(left(r), tag + 'review from Today: and Back then leaves the app (the session left nothing behind)');
    await r.close();
  }

  // ---- 5. Play asks before leaving ----
  await tab(p, 'play'); await p.waitForSelector('#startBtn');
  await p.click('#startBtn'); await p.waitForSelector('#pCard'); await p.waitForTimeout(300);
  await back(p);
  ok(await sheetOpen(p) && /Quit this round/.test(await sheetTitle(p)) && !!(await p.$('#pCard')), tag + 'play: Back asks "Quit this round?" and the round stays');
  await p.click('#keepOn'); await p.waitForTimeout(450);
  ok(!!(await p.$('#pCard')) && !(await sheetOpen(p)), tag + 'play: Keep playing stays in the round');
  await back(p);
  await p.click('#quitNow'); await p.waitForSelector('#startBtn'); await p.waitForTimeout(400);
  ok(await hash(p) === '#/play', tag + 'play: Quit round returns to Play setup');
  await back(p);
  ok(left(p), tag + 'play: after quitting, Back leaves the app (Play was a tab)');

  // ---- 6. Settings gear ----
  await p.goto(URL + '#/today'); await p.waitForSelector('#screen .view'); await p.waitForTimeout(500);
  const L2 = await len(p);
  await p.click('#gearBtn'); await p.waitForTimeout(400);
  ok(await hash(p) === '#/settings', tag + 'settings: the gear opens Settings');
  await p.click('#gearBtn'); await p.waitForTimeout(400);
  ok(await hash(p) === '#/today' && await len(p) === L2, tag + 'settings: the gear again closes it, no extra history');
  await back(p);
  ok(left(p), tag + 'settings: Back leaves the app');

  // ---- 7. a raw hash change to a tab (address bar, another app's link): kept as the browser made it ----
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#back'); await p.waitForTimeout(300);
  await p.evaluate(() => { location.hash = '#/stats'; });
  await p.waitForSelector('#screen[data-route=stats]'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => history.state?.ss) === 2, tag + 'raw hash change: tagged one level deeper');
  await tab(p, 'today');
  ok(await hash(p) === '#/today' && await p.evaluate(() => history.state?.ss) === 0, tag + 'raw hash change: a tab tap afterwards still goes back to the root');
  await back(p);
  ok(left(p), tag + 'raw hash change: and Back then leaves the app');

  // ---- 8. reload and deep links ----
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#back'); const dh = await hash(p);
  await p.reload(); await p.waitForSelector('#back'); await p.waitForTimeout(400);
  ok(await hash(p) === dh, tag + 'reload: stays on the deck page');
  await back(p);
  ok(await hash(p) === '#/decks', tag + 'reload: Back still returns to Decks (the history survived the reload)');
  const q = await open();
  await q.goto(URL + dh); await q.waitForSelector('#back'); await q.waitForTimeout(300);
  ok(await hash(q) === dh, tag + 'deep link: a deck page opens directly');
  await q.click('#back'); await q.waitForSelector('.deck'); await q.waitForTimeout(300);
  ok(await hash(q) === '#/decks', tag + 'deep link: its back button still goes to Decks');
  await q.close();
  const r = await open();
  await r.goto(URL); await r.waitForSelector('#screen .view'); await r.waitForTimeout(400);
  ok(await hash(r) === '#/today', tag + 'deep link: the bare address opens Today');
  await r.close();
  ok(await p.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorX) === 'none', tag + 'css: horizontal overscroll is off on the page');
  await p.close();
}

// Android: the hardware back button from Today must exit, not loop. (Today is the first and only entry.)
{
  const p = await open();
  await p.goto(URL); await p.waitForSelector('#screen .view'); await p.waitForTimeout(500);
  const depth = await p.evaluate(() => history.state?.ss);
  ok(depth === 0, 'root: Today is the bottom entry (depth 0)');
  ok(await p.evaluate(() => history.length) <= 3, 'root: opening the app does not stack extra entries');
  await back(p);
  ok(left(p), 'root: Back from Today leaves instead of looping');
  await p.close();
}

ok(errors.length === 0, 'no page errors: ' + errors.slice(0, 3).join(' | '));
await browser.close();
