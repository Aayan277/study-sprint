// A new address that arrives while the app is moving through history itself (a sheet's entry being popped) must not be lost:
// js/nav.js reconcile() keeps it. The close and the address change happen in the same tick, so the race is not timing luck.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const URL = 'http://localhost:8123/';
const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const p = await ctx.newPage();
p.on('console', m => { if (/^(POP|REC|TOTAB|REPL)/.test(m.text())) console.log('  >', m.text()); });
p.on('pageerror', e => errors.push('pageerror ' + e.message));
await p.goto('about:blank');
await p.goto(URL + '#/today'); await p.waitForSelector('#screen .view');
await p.waitForTimeout(500);
const idle = () => p.evaluate(async () => (await import('http://localhost:8123/js/nav.js')).whenIdle());
const hash = () => p.evaluate(() => location.hash);
const left = () => p.url() === 'about:blank';
const SHEET = '<h2 id="sheetTitle">Test sheet</h2><p>Hello</p><div class="sheet-actions"><button class="btn primary" type="button">Done</button></div>';

const targets = ['#/stats', '#/decks', '#/play', '#/settings', '#/browse', 'nav'];       // 'nav': a stray address, then the app's own go('#/stats') in the same tick: the app's, made later, wins
let bad = 0, badBack = 0;
for (let i = 0; i < 12; i++) {
  const mode = targets[i % targets.length], want = mode === 'nav' ? '#/stats' : mode;
  await p.evaluate(async () => { (await import('http://localhost:8123/js/nav.js')).toTab('#/today'); });
  await idle(); await p.waitForTimeout(100);
  await p.evaluate(async html => { (await import('http://localhost:8123/js/ui.js')).openSheet(html); }, SHEET);
  await idle();
  // close the sheet and change the address in the same tick
  await p.evaluate(async m => { const ui = await import('http://localhost:8123/js/ui.js'), nav = await import('http://localhost:8123/js/nav.js'); ui.closeSheet(); location.hash = m === 'nav' ? '#/browse' : m; if (m === 'nav') nav.go('#/stats'); }, mode);
  await idle(); await p.waitForTimeout(400); await idle();
  const got = await hash();
  const shown = await p.evaluate(() => document.getElementById('screen').dataset.route);
  if (got !== want || shown !== want.slice(2)) { bad++; console.log(`  round ${i}: wanted ${want}, address ${got}, screen ${shown}`); }
  const sheetOpen = await p.evaluate(() => document.getElementById('sheet').open);
  if (sheetOpen) bad++;
  // Back leaves the fresh route's entry; it must not land on a dead entry (same address as before, nothing changes)
  await p.goBack(); await p.waitForTimeout(450);
  const after = left() ? 'about:blank' : await hash();
  if (after !== '#/today' && after !== 'about:blank') { badBack++; console.log(`  round ${i}: Back went to ${after}`); }
  if (after === '#/today' && !left()) { await p.goBack(); await p.waitForTimeout(450); if (!left()) { badBack++; console.log(`  round ${i}: second Back did not leave`); } }
  await p.goto(URL + '#/today'); await p.waitForSelector('#screen .view'); await p.waitForTimeout(200);
}
ok(bad === 0, `sheet closing + new address in one tick: the app ends on the new route (12 rounds, ${bad} bad)`);
ok(badBack === 0, `Back after that is sane (no orphan entries, ${badBack} bad)`);
// The user's address arrives during a tab switch's traversal, and the tab's screen redirects as it renders (an onboarded user's #/welcome -> #/today):
// the redirect is the app's own, made inside the render, so it must not erase the user's later address (nav.js `fresh`). Where the browser finally
// parks the history depends on the order it runs the traversals in, so a single round is not a fair test: count the rounds in which the app
// went to the user's address after the redirect (it never does when the redirect erases it).
let reached = 0;
for (let i = 0; i < 8; i++) {
  await p.evaluate(async () => { (await import('http://localhost:8123/js/nav.js')).toTab('#/today'); });
  await idle(); await p.waitForTimeout(100);
  await p.evaluate(async html => { (await import('http://localhost:8123/js/ui.js')).openSheet(html); }, SHEET);
  await idle();
  await p.evaluate(async () => {
    const nav = await import('http://localhost:8123/js/nav.js'), sc = document.getElementById('screen');
    window.sawBrowse = false;
    window.obs = new MutationObserver(() => { if (sc.dataset.route === 'browse') sawBrowse = true; });
    obs.observe(sc, { attributes: true, attributeFilter: ['data-route'] });
    nav.toTab('#/welcome'); location.hash = '#/browse';
  });
  await idle(); await p.waitForTimeout(400); await idle();
  if (await p.evaluate(() => { obs.disconnect(); return sawBrowse; })) reached++;
  await p.goto(URL + '#/today'); await p.waitForSelector('#screen .view'); await p.waitForTimeout(200);
}
ok(reached > 0, `a render-time redirect does not erase the user's address (8 rounds, the app reached it in ${reached})`);
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
