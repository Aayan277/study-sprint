// v4.15: words on a Review card can be selected (QA v4.14, major 2): a double-click picks a word, a drag-select does not flip the card,
// and ⋯ → Add to glossary prefills the Term. On a phone a selection made by hand still reaches ⋯ (the pointerdown note), and the scratchpad still draws.
// Run with: node tests/browser/run.mjs selection
import { chromium } from './pw.mjs';
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

const open = async (w, h) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'T', name: 'Biology', color: '#5B48E8', created: Date.now() }, [
      { id: 'c1', deckId: 'T', front: 'What do the mitochondria make?', back: 'Mitochondria make adenosine triphosphate', tags: [], created: 1 },
      { id: 'c2', deckId: 'T', front: 'Second front', back: 'Second back', tags: [], created: 2 }]);
    await db.setSetting('reviewTyping', false);
  });
  await p.goto('about:blank'); await p.goto(URL + '#/review/T'); await p.waitForSelector('#flash');
  return p;
};
const sel = p => p.evaluate(() => String(getSelection()));

// ---------- desktop ----------
{
  const p = await open(1440, 900);
  // A drag-select on the front keeps the card unflipped.
  const f = await p.evaluate(() => {
    const n = document.createTreeWalker(document.querySelector('.rv-front .flash-front'), NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, n.textContent.length); const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await p.mouse.move(f.x + 2, f.y + f.h / 2); await p.mouse.down(); await p.mouse.move(f.x + f.w * 0.6, f.y + f.h / 2, { steps: 6 }); await p.mouse.up();
  ok((await sel(p)).trim().length > 2, 'desktop: text on the front can be selected by dragging');
  ok(!(await p.evaluate(() => document.getElementById('flash').classList.contains('flipped'))), 'desktop: a click that ends a selection does not flip the card');
  // A plain click still flips.
  await p.mouse.click(f.x + f.w / 2, f.y + f.h + 30);
  ok(await p.evaluate(() => document.getElementById('flash').classList.contains('flipped')), 'desktop: a plain click still flips the card');
  // Double-click a word on the back, then ⋯ → Add to glossary.
  const w = await p.evaluate(() => {
    const el = document.querySelector('.flash-back'); const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const n = walker.nextNode(); const i = n.textContent.indexOf('adenosine'); const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 4);
    const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await p.mouse.dblclick(w.x, w.y);
  ok((await sel(p)).trim() === 'adenosine', `desktop: double-click selects a word of the answer (${await sel(p)})`);
  ok(await p.evaluate(() => document.getElementById('flash').classList.contains('flipped')), 'desktop: still flipped, and nothing was rated by the double-click');
  await p.click('#moreBtn'); await p.waitForSelector('[data-go=glossary]');
  await p.click('[data-go=glossary]'); await p.waitForSelector('#glTerm');
  ok((await p.inputValue('#glTerm')) === 'adenosine', `desktop: ⋯ → Add to glossary prefills the Term (${await p.inputValue('#glTerm')})`);
  await p.close();
}

// ---------- scratchpad still draws ----------
{
  const p = await open(1440, 900);
  await p.click('#scratchBtn'); await p.waitForSelector('canvas.scratch');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.flash-front')).userSelect === 'none'), 'scratchpad on: card text is not selectable');
  const b = await p.$eval('#flash', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await p.mouse.move(b.x + b.w * 0.2, b.y + b.h * 0.4); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(b.x + b.w * (0.2 + 0.05 * i), b.y + b.h * (0.4 + (i % 2 ? 0.05 : 0)), { steps: 3 });
  await p.mouse.up();
  const ink = await p.evaluate(() => { const c = document.querySelector('canvas.scratch'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  ok(ink > 50, `scratchpad on: drawing still inks the canvas (${ink} px)`);
  ok(!(await p.evaluate(() => document.getElementById('flash').classList.contains('flipped'))), 'scratchpad on: drawing does not flip the card');
  await p.close();
}

// ---------- phone: a selection made by long-press still reaches ⋯ ----------
{
  const p = await open(375, 780);
  await p.tap('#flash');                       // flip
  await p.waitForSelector('.rv-back:not([inert])');
  await p.evaluate(() => {                     // what a long-press leaves: a selected word
    const el = document.querySelector('.flash-back'); const n = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const i = n.textContent.indexOf('triphosphate'); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 12);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  ok((await sel(p)) === 'triphosphate', 'phone: a selection on the answer exists');
  ok(await p.evaluate(() => document.getElementById('flash').classList.contains('flipped')), 'phone: the card stays flipped');
  await p.tap('#moreBtn'); await p.waitForSelector('[data-go=glossary]');
  await p.tap('[data-go=glossary]'); await p.waitForSelector('#glTerm');
  ok((await p.inputValue('#glTerm')) === 'triphosphate', `phone: ⋯ → Add to glossary prefills the Term (${await p.inputValue('#glTerm')})`);
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
