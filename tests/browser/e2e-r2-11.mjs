// Round 2 #11: Play uses the full page width on a computer (1024 / 1280 / 1440 / 1920), in both styles.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const errors = [];
for (const ui of ['original', 'clinical']) {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ui => { const t = await import('./js/themes.js'); t.applyTheme({ ui, mode: 'light' }); }, ui);
  await p.waitForTimeout(500);
  for (const w of [1024, 1280, 1440, 1920]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForTimeout(150);
    await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
    const r = await p.evaluate(() => {
      const box = s => { const e = document.querySelector(s).getBoundingClientRect(); return { l: e.left, r: e.right, w: e.width }; };
      const view = box('main > .view'), deck = box('#pDeck'), start = box('#startBtn');
      const modes = [...document.querySelectorAll('.modes .mode')].map(m => m.getBoundingClientRect());
      return { view, deck, start, modesL: Math.min(...modes.map(m => m.left)), modesR: Math.max(...modes.map(m => m.right)), n: modes.length, sideways: document.documentElement.scrollWidth > innerWidth };
    });
    const near = (a, b) => Math.abs(a - b) <= 2;
    ok(r.view.w > 650 && near(r.deck.w, r.view.w) && near(r.start.w, r.view.w) && r.n === 3 && near(r.modesL, r.view.l) && near(r.modesR, r.view.r) && !r.sideways, `${ui} ${w}: view ${Math.round(r.view.w)}px, deck field, three format tiles and Start fill it, no sideways scroll`);
  }
  // a running round stays a 760px reading column
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.click('#startBtn'); await p.waitForSelector('#pCard');
  const rw = await p.$eval('main > .view', e => Math.round(e.getBoundingClientRect().width));
  ok(rw <= 760 && rw > 500, `${ui}: a running round is at most 760px wide (${rw}px)`);
  await p.close();
}
ok(errors.length === 0, 'no page errors: ' + errors.join('|'));
await browser.close();
