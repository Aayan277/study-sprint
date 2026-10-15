// Round 2 (2B), B4: the Review scratchpad. A pen button (#scratchBtn, key D) draws over the card with a mouse, a pen or a
// finger. It is remembered per device, cleared on the next card, kept through a flip and destroyed when leaving Review.
// The flip click ignores the canvas and the tools; with it off the page scrolls by touch; a pen blocks the palm.
// Run with: node tests/browser/run.mjs scratchpad
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

const open = async (w, h, scheme = 'dark') => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async scheme => {
    const db = await import('./js/db.js');
    const now = Date.now();
    await db.addDeckWithCards({ id: 'S', name: 'Chemistry', color: '#5B48E8', created: now }, [1, 2, 3].map(i => ({ id: 's' + i, deckId: 'S', front: 'Balance H2 + O2 ' + i, back: 'Answer ' + i, tags: [], created: i })));
    const th = (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: scheme });
    await db.setSetting('theme', th);
  }, scheme);
  await p.goto('about:blank'); await p.goto(URL + '#/review/S'); await p.waitForSelector('#flash');
  return { p, ctx };
};
// How many pixels of the scratch canvas are drawn on.
const inked = p => p.evaluate(() => { const c = document.querySelector('canvas.scratch'); if (!c) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
const style = (p, prop) => p.$eval('canvas.scratch', (c, prop) => getComputedStyle(c)[prop], prop);
const cardBox = p => p.$eval('#flash', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const scribble = async (p, fx = 0.2, fy = 0.35) => {
  const b = await cardBox(p);
  await p.mouse.move(b.x + b.w * fx, b.y + b.h * fy);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(b.x + b.w * (fx + 0.05 * i), b.y + b.h * (fy + (i % 2 ? 0.06 : -0.02)), { steps: 3 });
  await p.mouse.up();
};
// A pointer event dispatched on the canvas by hand (to make a pen, which a mouse cannot be).
const pointer = (p, type, pointerType, id, fx, fy) => p.evaluate(([type, pointerType, id, fx, fy]) => {
  const c = document.querySelector('canvas.scratch'), r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType, isPrimary: true, bubbles: true, cancelable: true, pressure: pointerType === 'pen' ? 0.6 : 0.5, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
}, [type, pointerType, id, fx, fy]);
// A real one-finger drag up the card (the browser decides, from touch-action, whether it scrolls the page or goes to the canvas).
const touchDrag = async (ctx, p) => {
  const cdp = await ctx.newCDPSession(p);
  await p.evaluate(() => { document.querySelector('main').insertAdjacentHTML('beforeend', '<div id="spacer" style="height:2400px"></div>'); scrollTo(0, 0); });
  const b = await cardBox(p), x = Math.round(b.x + b.w / 2), y0 = Math.round(Math.min(b.y + b.h - 30, 640));
  const tp = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await tp('touchStart', y0);
  for (let y = y0; y > y0 - 240; y -= 20) { await tp('touchMove', y); await p.waitForTimeout(16); }
  await tp('touchEnd', y0 - 240);
  await p.waitForTimeout(400);
  const moved = await p.evaluate(() => scrollY);
  await p.evaluate(() => { document.getElementById('spacer')?.remove(); scrollTo(0, 0); });
  return moved;
};
const stroke = async (p, pointerType, id, y) => {
  await pointer(p, 'pointerdown', pointerType, id, 0.2, y);
  for (let i = 1; i <= 6; i++) await pointer(p, 'pointermove', pointerType, id, 0.2 + 0.1 * i, y + (i % 2 ? 0.04 : 0));
  await pointer(p, 'pointerup', pointerType, id, 0.8, y);
};

for (const [w, h, scheme] of [[375, 780, 'dark'], [1440, 900, 'light']]) {
  const tag = `${w} ${scheme}`;
  const { p, ctx } = await open(w, h, scheme);
  const btn = '#scratchBtn';

  // ---- the button, off by default, and scrolling works ----
  ok(await p.locator(btn).count() === 1 && (await p.getAttribute(btn, 'aria-label')) === 'Scratchpad (D)' && (await p.getAttribute(btn, 'aria-keyshortcuts')) === 'D', `${tag}: pen button #scratchBtn, "Scratchpad (D)"`);
  ok((await p.getAttribute(btn, 'aria-pressed')) === 'false', `${tag}: starts off`);
  ok((await style(p, 'pointerEvents')) === 'none' && (await style(p, 'touchAction')) === 'auto', `${tag}: off = pointer-events none, touch-action auto`);
  ok(await p.locator('.scratch-tools').evaluate(e => getComputedStyle(e).display) === 'none', `${tag}: no tools while off`);
  if (w < 800) {
    const moved = await touchDrag(ctx, p);
    ok(moved > 50, `${tag}: with the pad off, a touch scroll over the card moves the page (${Math.round(moved)}px)`);
  }

  // ---- on: D, state remembered, mouse drag draws and does not flip ----
  await p.keyboard.press('d');
  ok((await p.getAttribute(btn, 'aria-pressed')) === 'true' && (await style(p, 'pointerEvents')) === 'auto' && (await style(p, 'touchAction')) === 'none', `${tag}: D turns it on (pointer-events auto, touch-action none)`);
  ok(await p.evaluate(() => localStorage.getItem('study-sprint-scratch')) === '1', `${tag}: on is remembered on this device`);
  ok(await p.locator('.scratch-tool').count() === 4 && (await p.locator('.scratch-tool').allTextContents()).join() === 'Pen,Eraser,Clear,Close', `${tag}: tools Pen, Eraser, Clear, Close`);
  ok((await p.$$eval('.scratch-tool', bs => bs.every(b => b.getBoundingClientRect().height >= 36 && b.getBoundingClientRect().width >= 36))), `${tag}: tools are at least 36px (40 by design)`);
  if (w < 800) {
    const moved = await touchDrag(ctx, p);
    ok(moved < 5, `${tag}: with the pad on, a touch over the card does not scroll the page (${Math.round(moved)}px)`);
    await p.evaluate(() => { const c = document.querySelector('canvas.scratch'); c.getContext('2d').clearRect(0, 0, c.width, c.height); });
  }
  await scribble(p);
  const a1 = await inked(p);
  ok(a1 > 500, `${tag}: a mouse drag draws (${a1} px)`);
  ok(await p.$eval('#flash', e => !e.classList.contains('flipped')), `${tag}: finishing a stroke does not flip the card`);
  await p.screenshot({ path: `${SP}/scratch-front-${w}-${scheme}.png` });

  // ---- a flip keeps the drawing ----
  await p.keyboard.press('Space');
  await p.waitForSelector('.rate');
  ok(await p.$eval('#flash', e => e.classList.contains('flipped')), `${tag}: Space still flips`);
  ok((await inked(p)) === a1, `${tag}: the drawing survives the flip`);
  await p.screenshot({ path: `${SP}/scratch-back-${w}-${scheme}.png` });

  // ---- tools: eraser removes, Clear wipes, Pen draws again ----
  await p.click('.scratch-tool[data-tool=eraser]');
  ok((await p.getAttribute('.scratch-tool[data-tool=eraser]', 'aria-pressed')) === 'true' && (await p.getAttribute('.scratch-tool[data-tool=pen]', 'aria-pressed')) === 'false', `${tag}: Eraser is pressed, Pen is not`);
  ok(await p.$eval('#flash', e => e.classList.contains('flipped')), `${tag}: choosing a tool does not flip or rate`);
  await scribble(p);
  const a2 = await inked(p);
  ok(a2 < a1, `${tag}: the eraser takes ink away (${a1} → ${a2})`);
  await p.click('.scratch-tool[data-tool=pen]');
  await scribble(p, 0.2, 0.6);
  const a3 = await inked(p);
  ok(a3 > a2, `${tag}: the pen draws again (${a3})`);
  await p.click('.scratch-tool[data-tool=clear]');
  ok((await inked(p)) === 0, `${tag}: Clear wipes the drawing`);

  // ---- pen + palm rejection ----
  await stroke(p, 'pen', 5, 0.3);
  const pen1 = await inked(p);
  ok(pen1 > 200, `${tag}: a pen stroke draws (${pen1} px)`);
  await stroke(p, 'touch', 6, 0.6);                                    // a palm right after the pen
  ok((await inked(p)) === pen1, `${tag}: a touch within a second of the pen draws nothing`);
  await p.waitForTimeout(1150);
  await stroke(p, 'touch', 7, 0.6);
  ok((await inked(p)) > pen1, `${tag}: a touch a second after the pen draws again`);
  await p.click('.scratch-tool[data-tool=clear]');

  // ---- hidden while the zoom viewer is open ----
  await p.evaluate(() => { const d = document.createElement('dialog'); d.className = 'occ-view'; document.body.append(d); });
  await p.waitForFunction(() => getComputedStyle(document.querySelector('canvas.scratch')).visibility === 'hidden');
  ok((await p.$eval('.scratch-tools', e => getComputedStyle(e).visibility)) === 'hidden', `${tag}: pad and tools are hidden while the zoom viewer is open`);
  await p.evaluate(() => document.querySelector('dialog.occ-view').remove());
  await p.waitForFunction(() => getComputedStyle(document.querySelector('canvas.scratch')).visibility === 'visible');
  ok(true, `${tag}: and back when it closes`);

  // ---- the next card is clean; the pad stays on ----
  await scribble(p);
  ok((await inked(p)) > 500, `${tag}: drawn on the back before rating`);
  const before = await p.textContent('.rv-front .flash-front');
  await p.keyboard.press('3');
  await p.waitForFunction(b => document.querySelector('#flash:not(.flipped)') && document.querySelector('.rv-front .flash-front')?.textContent !== b, before);
  ok((await inked(p)) === 0, `${tag}: rating clears the drawing for the next card`);
  ok((await style(p, 'pointerEvents')) === 'auto' && (await p.getAttribute(btn, 'aria-pressed')) === 'true', `${tag}: the pad stays on for the next card`);

  // ---- Close = off, drawing stays visible, scroll back on ----
  await scribble(p);
  const a4 = await inked(p);
  await p.click('.scratch-tool[data-tool=close]');
  ok((await style(p, 'pointerEvents')) === 'none' && (await p.getAttribute(btn, 'aria-pressed')) === 'false' && (await inked(p)) === a4, `${tag}: Close turns it off and the drawing stays`);
  ok(await p.evaluate(() => localStorage.getItem('study-sprint-scratch')) === '0', `${tag}: off is remembered too`);
  // A click on the card flips it when the pad is off.
  const b = await cardBox(p);
  await p.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
  ok(await p.$eval('#flash', e => e.classList.contains('flipped')), `${tag}: with the pad off, a tap on the card flips it`);

  // ---- remembered after a reload ----
  await p.click(btn);
  await p.reload(); await p.waitForSelector('#flash');
  ok((await p.getAttribute(btn, 'aria-pressed')) === 'true' && (await style(p, 'pointerEvents')) === 'auto', `${tag}: after a reload the pad is on again`);
  ok(w > 800 || await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: no sideways scroll`);

  // ---- leaving destroys it ----
  await p.evaluate(() => { location.hash = '#/today'; });
  await p.waitForFunction(() => !location.hash.startsWith('#/review'));
  ok(await p.locator('canvas.scratch').count() === 0, `${tag}: leaving Review removes the canvas`);
  await p.close(); await ctx.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
