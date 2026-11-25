// Round 2 #2 fixes: the ... menu on a deck tile is never clipped (the last deck too) and sits under its button, in all four looks; the tile keeps
// its counts for screen readers; the sidebar has a keyboard path to the deck page (also collapsed).
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const errors = [];
for (const ui of ['original', 'clinical']) for (const mode of ['light', 'dark']) for (const [w, h] of [[1280, 800], [390, 700]]) {
  const tag = `${ui} ${mode} ${w}`;
  const p = await (await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' })).newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ([ui, mode]) => {
    const db = await import('./js/db.js'); const now = Date.now();
    for (const [i, n] of ['Alpha', 'Beta', 'Gamma', 'Delta'].entries()) await db.addDeckWithCards({ id: 'd' + i, name: n, color: '#3E63DD', created: now + i + 1 }, [1, 2, 3].map(k => ({ id: `d${i}c${k}`, deckId: 'd' + i, front: 'f' + k, back: 'b', tags: [], created: k })));
    (await import('./js/themes.js')).applyTheme({ ui, mode });
  }, [ui, mode]);
  await p.reload(); await p.waitForSelector('.deck'); await p.waitForTimeout(400);
  // the tile keeps its counts for screen readers
  const dd = await p.$eval('.deck-open[data-study="d0"]', e => ({ ids: e.getAttribute('aria-describedby'), text: e.getAttribute('aria-describedby').split(' ').map(i => document.getElementById(i)?.textContent.replace(/\s+/g, ' ').trim()).join(' | ') }));
  ok(/cards/.test(dd.text) && /due/.test(dd.text), `${tag}: the tile's counts are its accessible description (${dd.text})`);
  // the last deck's menu
  const last = (await p.$$('article.deck')).length - 1;
  await p.evaluate(i => document.querySelectorAll('article.deck')[i].scrollIntoView({ block: 'end' }), last);
  await p.locator('article.deck').nth(last).locator('[data-more]').click();
  const r = await p.evaluate(i => {
    const a = document.querySelectorAll('article.deck')[i], m = a.querySelector('.deck-menu'), b = a.querySelector('[data-more]');
    const mr = m.getBoundingClientRect(), br = b.getBoundingClientRect(), edit = m.querySelector('[data-edit]').getBoundingClientRect();
    const at = document.elementFromPoint(edit.left + edit.width / 2, edit.top + edit.height / 2);
    return { below: mr.top >= br.bottom - 1, visible: !m.hidden && mr.height > 20, hit: !!at?.closest('.deck-menu'), inView: edit.bottom <= innerHeight + 1 };
  }, last);
  ok(r.visible && r.below && r.hit && r.inView, `${tag}: the last deck's menu is open, under its button, not clipped (${JSON.stringify(r)})`);
  await p.locator('article.deck').nth(last).locator('[data-edit]').click();
  await p.waitForSelector('#deckForm');
  ok(await p.$eval('#deckName', e => e.value.length > 0), `${tag}: Edit deck on the last deck opens its editor`);
  await p.close();
}
// the sidebar's keyboard path (and the collapsed sidebar)
for (const rail of [false, true]) {
  const tag = `sidebar${rail ? ' (collapsed)' : ''}`;
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'k', name: 'Kappa', color: '#3E63DD', created: Date.now() }, [1, 2].map(k => ({ id: 'k' + k, deckId: 'k', front: 'f' + k, back: 'b', tags: [], created: k }))); });
  if (rail) await p.evaluate(() => localStorage.setItem('study-sprint-rail', '1'));
  await p.reload(); await p.waitForSelector('.side-deck[data-key="k"]');
  const label = await p.getAttribute('.side-deck[data-key="k"]', 'aria-label');
  ok(/^Study Kappa, 2 cards: \d+ due, \d+ new/.test(label), `${tag}: the label says what a tap starts (${label})`);
  await p.focus('.side-deck[data-key="k"]'); await p.keyboard.press('Shift+Enter');
  await p.waitForFunction(() => location.hash === '#/deck/k');
  ok(true, `${tag}: Shift+Enter on a deck row opens its page`);
  await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck');
  await p.focus('.side-deck[data-key="k"]'); await p.keyboard.press('Enter'); await p.waitForSelector('#flash');
  ok(true, `${tag}: Enter starts studying`);
  await p.close();
}
ok(errors.length === 0, 'no page errors: ' + errors.join('|'));
await browser.close();
