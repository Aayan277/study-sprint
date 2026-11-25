// Round 2 #12: every drop-down (.select) is the app's own control, not the browser's: no native arrows, the same edge, height and corners as a
// text box, and the chevron picture, in all four looks.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const errors = [];
for (const ui of ['original', 'clinical']) for (const mode of ['light', 'dark']) {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })).newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ([ui, mode]) => { const t = await import('./js/themes.js'); t.applyTheme({ ui, mode }); }, [ui, mode]);
  await p.waitForTimeout(500);
  const tag = `${ui} ${mode}`;
  // Play's Deck dropdown
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  const s = await p.$eval('#pDeck', e => { const c = getComputedStyle(e); return { app: c.appearance, wapp: c.webkitAppearance, img: c.backgroundImage.startsWith('url('), bw: c.borderTopWidth, br: c.borderTopLeftRadius, h: e.getBoundingClientRect().height }; });
  ok(s.app === 'none' && s.img, `${tag}: Play's Deck dropdown has appearance none and the app's chevron (${s.app}, ${s.img})`);
  // the same box as a text field: the deck editor has a name box and a parent-deck select in one form
  await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck');
  await p.click('#newDeck'); await p.waitForSelector('#deckName'); await p.waitForSelector('#deckParent');
  const m = await p.evaluate(() => { document.activeElement?.blur(); const f = e => { const c = getComputedStyle(e); return { bw: c.borderTopWidth, br: c.borderTopLeftRadius, bc: c.borderTopColor, h: Math.round(e.getBoundingClientRect().height * 10) / 10 }; }; return { input: f(document.getElementById('deckName')), select: f(document.getElementById('deckParent')) }; });
  ok(m.input.bw === m.select.bw && m.input.br === m.select.br && m.input.bc === m.select.bc, `${tag}: the dropdown has the text box's border and corners (${JSON.stringify(m.select)} vs ${JSON.stringify(m.input)})`);
  ok(Math.abs(m.input.h - m.select.h) <= 1, `${tag}: and the same height (${m.select.h} vs ${m.input.h})`);
  const all = await p.evaluate(() => [...document.querySelectorAll('.select')].every(e => getComputedStyle(e).appearance === 'none'));
  ok(all, `${tag}: every .select on this screen is appearance none`);
  // the Browse selects and the Settings Easy-days selects keep room for the chevron (the text must not run under it)
  for (const [hash, sel, what] of [['#/browse', '.br-controls select', 'Browse'], ['#/settings', '.easy-day select', 'Settings Easy days']]) {
    await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(sel, { state: 'attached' });
    const r = await p.$$eval(sel, es => es.map(e => { const c = getComputedStyle(e); return { app: c.appearance, img: c.backgroundImage.startsWith('url('), pr: parseFloat(c.paddingRight), bs: parseFloat(c.backgroundSize), pos: c.backgroundPositionX }; }));
    ok(r.length > 0 && r.every(x => x.app === 'none' && x.img && x.pr >= x.bs + 12), `${tag}: ${what} selects have the chevron and room for it (${JSON.stringify(r[0])})`);
  }
  await p.screenshot({ path: process.argv[2] + `/select-${ui}-${mode}.png` });
  await p.close();
}
ok(errors.length === 0, 'no page errors: ' + errors.join('|'));
await browser.close();
