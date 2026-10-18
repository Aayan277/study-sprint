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

// ====== the review blockers (v4.22 merge): holds released under a sheet, the Play clock, Back skipping entries, late races ======
const deckPage = async p => {
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(() => (document.querySelector('[data-open]') || document.querySelector('a[href^="#/deck/"]')).click());
  await p.waitForSelector('#reviewBtn'); await p.waitForTimeout(300);
};
const startReview = async p => { await deckPage(p); await p.click('#reviewBtn'); await p.waitForSelector('#flash'); await p.waitForTimeout(400); };
const navApi = (p, code, arg) => p.evaluate(async ([c, a]) => { const n = await import('./js/nav.js'); return new Function('n', 'a', c)(n, a); }, [code, arg]);
const kind = p => p.evaluate(() => history.state?.k);
const startPlay = async (p, fmt, pace) => {
  await p.goto(URL + '#/play'); await p.waitForSelector('#startBtn'); await p.waitForTimeout(300);
  await p.evaluate(f => { const r = document.querySelector(`input[name=fmt][value=${f}]`); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }, fmt);
  await p.waitForTimeout(300);
  if (pace) await p.evaluate(v => { const e = document.getElementById('pace'); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } }, pace);
  await p.waitForTimeout(200);
  await p.click('#startBtn'); await p.waitForSelector('#pCard'); await p.waitForTimeout(300);
};
const secs = async p => { const t = await p.textContent('#hudClock'); const m = t.match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : parseFloat(t); };

{
  // Repro A: a hold released while a sheet is over it must not leave a dead Back press.
  const p = await open();
  await startPlay(p, 'lightning');
  await back(p);
  ok(await sheetOpen(p) && /Quit this round/.test(await sheetTitle(p)), 'blocker A: Back asks "Quit this round?"');
  await navApi(p, "n.releaseBack('session')");            // the round ends behind the question (the clock used to do this)
  await p.waitForTimeout(300);
  await p.click('#keepOn'); await p.waitForTimeout(700);
  ok(!(await sheetOpen(p)) && await kind(p) === 'page', 'blocker A: after Keep playing the entry underneath is the page, not a dead hold (' + await kind(p) + ')');
  await back(p);
  ok(left(p), 'blocker A: the first Back leaves the app (no dead press)');
  await p.close();
}
{
  // Repro B (desktop): Review, card panel, End, panel closed: the first Back is not dead.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto('about:blank');
  await startReview(p);
  await p.keyboard.press('i'); await p.waitForTimeout(800);
  const side = await p.evaluate(() => document.getElementById('sheet').open && document.getElementById('sheet').classList.contains('side'));
  ok(side, 'blocker B: the card panel opens at the side on a wide screen');
  await p.click('#endBtn'); await p.waitForTimeout(900);
  ok(/Session ended/.test(await p.textContent('#screen h1')) && !(await sheetOpen(p)), 'blocker B: ending the session closes the open panel');
  await back(p);
  ok(/^#\/deck\//.test(await hash(p)), 'blocker B: the first Back returns to the deck page: ' + await hash(p));
  await back(p);
  ok(await hash(p) === '#/decks', 'blocker B: then Decks');
  // the same with the panel closed by hand after the hold was let go (the order that used to leave a dead entry)
  await startReview(p);
  await p.keyboard.press('i'); await p.waitForTimeout(800);
  await navApi(p, "n.releaseBack('session')"); await p.waitForTimeout(300);
  await p.click('.sheet-x'); await p.waitForTimeout(900);
  ok(await kind(p) === 'page' && /^#\/review/.test(await hash(p)), 'blocker B: closing the panel after the hold was released lands on a real page entry (' + await kind(p) + ')');
  await back(p);
  ok(/^#\/deck\//.test(await hash(p)), 'blocker B: and one Back goes to the deck page');
  await ctx.close();
}
{
  // Back skipping several entries (history.go(-2), the long-press Back menu): the hold is let go and the move counts as leaving.
  const p = await open();
  await startReview(p);
  await p.evaluate(() => history.go(-2)); await p.waitForTimeout(1000);
  ok(/^#\/deck\//.test(await hash(p)) && !(await sheetOpen(p)), 'skipping: Back over two entries shows the deck page and no question: ' + await hash(p));
  ok(await navApi(p, 'return n.isHolding()') === false, 'skipping: the session no longer holds the back gesture');
  ok(await p.evaluate(() => !history.state || history.state.ss <= 1), 'skipping: no hold entry was pushed back at the wrong address');
  await back(p);
  ok(await hash(p) === '#/decks', 'skipping: Back goes to Decks');
  await back(p);
  ok(left(p), 'skipping: and then leaves the app');
  // a sheet over a hold, Back skipping both: nothing is left open
  await startReview(p);
  await back(p);
  ok(await sheetOpen(p), 'skipping: (setup) the question is open over the review');
  await p.evaluate(() => history.go(-3)); await p.waitForTimeout(1000);
  ok(!(await sheetOpen(p)) && await navApi(p, 'return n.isHolding()') === false, 'skipping: Back over the question and the session closes both');
  await p.close();
}
for (const [fmt, what] of [['lightning', 'Lightning'], ['survival', 'Survival'], ['classic', 'Classic']]) {
  // The Play clock waits while "Quit this round?" is up, and nothing is lost for the time it took.
  const p = await open();
  await startPlay(p, fmt, fmt === 'lightning' ? 0 : 3);
  const prompt0 = await p.textContent('#pPrompt');
  const t0 = fmt === 'lightning' ? await secs(p) : 0;
  const hud0 = await p.textContent('#hudA');
  await back(p);
  ok(await sheetOpen(p) && /Quit this round/.test(await sheetTitle(p)), `play clock (${what}): Back asks`);
  await p.waitForTimeout(fmt === 'lightning' ? 4000 : 4500);          // longer than a Survival / Classic question's 3 s
  const t1 = fmt === 'lightning' ? await secs(p) : 0;
  await p.click('#keepOn'); await p.waitForTimeout(500);
  const t2 = fmt === 'lightning' ? await secs(p) : 0;
  const still = await p.evaluate(() => ({ fb: document.getElementById('feedback')?.textContent || '', prompt: document.getElementById('pPrompt')?.textContent, hud: document.getElementById('hudA')?.textContent, over: !!document.querySelector('.fb.no') }));
  if (fmt === 'lightning') ok(t1 === t0 && t0 - t2 <= 1, `play clock (Lightning): the clock stood still while asking (${t0}s, ${t1}s while asking, ${t2}s after Keep playing)`);
  ok(still.fb === '' && still.prompt === prompt0 && still.hud === hud0, `play clock (${what}): same question, no answer, no life lost, the HUD is unchanged after Keep playing (${hud0} -> ${still.hud})`);
  await p.waitForTimeout(fmt === 'lightning' ? 1200 : 1800);
  if (fmt === 'lightning') ok(await secs(p) < t2, 'play clock (Lightning): and it runs again after Keep playing');
  else ok(await p.evaluate(() => { const t = document.getElementById('pTimer'); return !!t && getComputedStyle(t).transform !== 'none'; }), `play clock (${what}): the question timer runs again`);
  await p.close();
}
{
  // close-and-navigate in the same tick (the side panel's x, then a sidebar link)
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(URL + '#/today'); await p.waitForSelector('#screen .view'); await p.waitForTimeout(800);
  await p.evaluate(async () => (await import('./js/ui.js')).openSheet('<h2 id="sheetTitle">T</h2>', { side: true })); await p.waitForTimeout(300);
  ok(await sheetOpen(p), 'race: the side panel is open');
  await p.evaluate(() => { document.querySelector('.sheet-x').click(); document.querySelector('a.side-deck').click(); });
  await p.waitForTimeout(1200);
  const st = await p.evaluate(() => ({ h: location.hash, k: history.state?.k, ss: history.state?.ss, h1: document.querySelector('#screen h1')?.textContent }));
  ok(/^#\/deck\//.test(st.h) && st.k === 'page' && st.ss === 1, 'race: closing the panel and clicking a deck in one tick opens the deck, one page entry deep: ' + JSON.stringify(st));
  await back(p);
  ok(await hash(p) === '#/today', 'race: and Back returns to Today');
  await ctx.close();
}
{
  // The occlusion editor: Back asks "Discard your changes?" (like Esc), Back with nothing drawn just closes.
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  const openEd = async () => {
    await p.evaluate(async () => { const m = await import('./js/occlusion-editor.js'); window.__edResult = 'open'; m.openOcclusionEditor({ image: 'nav-test', w: 300, h: 200, masks: [] }).then(r => { window.__edResult = r === null ? 'null' : 'done'; }); });
    await p.waitForSelector('dialog.occ-ed[open]'); await p.waitForTimeout(300);
  };
  await openEd();
  await back(p);
  ok(await p.evaluate(() => !document.querySelector('dialog.occ-ed')) && await hash(p) === '#/decks', 'occlusion editor: Back with no changes closes it and stays on the page');
  await back(p);
  ok(left(p), 'occlusion editor: and the next Back leaves the app');
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  await openEd();
  const box = await p.locator('.occ-ed-stage').boundingBox();
  await p.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4); await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 }); await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 6 }); await p.mouse.up();
  await p.waitForTimeout(200);
  await back(p);
  ok(await p.locator('.occ-ed-confirm').isVisible() && (await p.textContent('#occEdCfT')) === 'Discard your changes?', 'occlusion editor: Back with changes asks "Discard your changes?"');
  await p.click('[data-act=keep]'); await p.waitForTimeout(300);
  await back(p);
  ok(await p.locator('.occ-ed-confirm').isVisible(), 'occlusion editor: and asks again after Keep editing');
  await p.click('[data-act=discard]'); await p.waitForFunction(() => !document.querySelector('dialog.occ-ed')); await p.waitForTimeout(500);
  await back(p);
  ok(left(p), 'occlusion editor: after Discard, one Back leaves the app (the hold left nothing behind)');
  await ctx.close();
}
{
  // The zoom viewer: Back closes it
  const p = await open();
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  await p.evaluate(async () => (await import('./js/occlusion-view.js')).openZoom('<figure class="occ" style="--ar:1.5"><img class="card-img" alt="Pic" data-media="nav-test"></figure>', 'Pic'));
  await p.waitForSelector('dialog.occ-view[open]'); await p.waitForTimeout(300);
  await back(p);
  ok(await p.evaluate(() => !document.querySelector('dialog.occ-view')) && await hash(p) === '#/decks', 'zoom viewer: Back closes it and stays on the page');
  await back(p);
  ok(left(p), 'zoom viewer: and the next Back leaves the app');
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  await p.evaluate(async () => (await import('./js/occlusion-view.js')).openZoom('<figure class="occ" style="--ar:1.5"><img class="card-img" alt="Pic" data-media="nav-test"></figure>', 'Pic'));
  await p.waitForSelector('dialog.occ-view[open]'); await p.waitForTimeout(300);
  await p.click('dialog.occ-view [data-close]'); await p.waitForTimeout(600);
  await back(p);
  ok(left(p), 'zoom viewer: after closing with its button, Back leaves the app');
  await p.close();
}
{
  // Import's back button: step back when there is somewhere in the app, else go to Decks
  const p = await open();
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck'); await p.waitForTimeout(300);
  await navApi(p, "n.go('#/import')"); await p.waitForSelector('#back'); await p.waitForTimeout(400);
  const L = await len(p);
  await p.click('#back'); await p.waitForSelector('.deck'); await p.waitForTimeout(500);
  ok(await hash(p) === '#/decks' && await len(p) === L, 'import: the back button returns to Decks without adding an entry');
  await back(p);
  ok(left(p), 'import: and Back then leaves the app');
  const q = await open();
  await q.goto(URL + '#/import'); await q.waitForSelector('#back'); await q.waitForTimeout(400);
  await q.click('#back'); await q.waitForSelector('.deck'); await q.waitForTimeout(500);
  ok(await hash(q) === '#/decks' && await q.evaluate(() => history.state?.ss) === 0, 'import: opened directly, its back button goes to Decks as the bottom entry');
  await q.close();
  await p.close();
}
{
  // go / up / back run in order with the other history changes: a Back button pressed in the same tick as a sheet closing
  const p = await open();
  await deckPage(p);
  await p.evaluate(async () => { const ui = await import('./js/ui.js'); ui.openSheet('<h2 id="sheetTitle">T</h2>'); });
  await p.waitForTimeout(300);
  await p.evaluate(async () => { const ui = await import('./js/ui.js'); ui.closeSheet(); document.getElementById('back').click(); });
  await p.waitForTimeout(1200);
  ok(await hash(p) === '#/decks' && !(await sheetOpen(p)), 'queue: closing a sheet and pressing the page\'s back button together lands on Decks: ' + await hash(p));
  await back(p);
  ok(left(p), 'queue: and Back then leaves the app');
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
