// Review: a long multiple-choice card (question + blank line + five options) must stay readable on desktop and phone, in both looks.
// Unflipped, the options sit above "Show answer" with no vertical overflow. Flipped, the question's recap is near the top of the back
// (no big empty gap above it) and the end of the answer can be scrolled above the rating bar.
// Run with: node tests/browser/run.mjs flip-long      Screenshots go to $SHOTS if it is set.
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const Q = 'A 6-month-old infant is seen for a routine visit. The parents report that the child has begun to roll over and to reach for objects, and they ask which of the following best explains why the infant cannot yet walk independently?';
const FRONT = Q + '\n\nA. The cerebellum has not formed\nB. Muscle fibres are not yet present\nC. Peripheral nerves lack myelin entirely\nD. Vestibular input is absent in infancy\nE. Cortical motor pathways are still maturing';
const BACK = 'E. cannot be reached faster than brain maturation allows\n\nCorticospinal myelination and cortical motor pathways mature over the first year, so independent walking waits for them.';
const THEMES = { original: { ui: 'original', skin: 'indigo', mode: 'dark', oled: false }, clinical: { ui: 'clinical', skin: 'ocean', mode: 'dark', oled: false } };
const SIZES = [['desktop1280', { width: 1280, height: 800 }, false], ['desktop1780', { width: 1780, height: 1000 }, false], ['phone', { width: 390, height: 844 }, true]];

for (const [themeName, theme] of Object.entries(THEMES)) for (const [tag, viewport, mobile] of SIZES) {
  const T = `${tag}/${themeName}`;
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.stack));
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ({ theme, FRONT, BACK }) => {
    const db = await import('./js/db.js');
    await db.setSetting('theme', theme);
    await db.addDeckWithCards({ id: 'd-mc', name: 'Deck mc', color: '#3E63DD', created: 1 }, [{ id: 'mc', deckId: 'd-mc', front: FRONT, back: BACK, tags: [], created: 1 }]);
  }, { theme, FRONT, BACK });
  await p.reload(); await p.waitForSelector('.deck');
  await p.goto(APP + '#/review/d-mc'); await p.waitForSelector('#flash'); await p.waitForTimeout(450);
  // ---- front: the options are visible and nothing overflows (checked at 1280x800, where the card must fit) ----
  const f = await p.evaluate(() => {
    const fr = document.querySelector('.rv-front .flash-front'), b = document.querySelector('#showBtn, #ratebar .btn');
    const r = fr.getBoundingClientRect(), br = b ? b.getBoundingClientRect() : null;
    return { bottom: r.bottom, btnTop: br ? br.top : null, scrollH: fr.scrollHeight, clientH: fr.clientHeight, px: parseFloat(getComputedStyle(fr).fontSize) };
  });
  if (viewport.width === 1280) ok(f.scrollH <= f.clientH + 1 && (f.btnTop === null || f.bottom <= f.btnTop + 1), `${T}: the whole front is visible above "Show answer" (front bottom ${Math.round(f.bottom)}, button top ${Math.round(f.btnTop)})`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/flip-front-${tag}-${themeName}.png` });
  // ---- back ----
  await p.keyboard.press('Space'); await p.waitForSelector('.rv-back:not([inert])'); await p.waitForTimeout(500);
  const g = await p.evaluate(() => {
    const back = document.querySelector('.rv-back').getBoundingClientRect(), recap = document.querySelector('.rv-back .flash-recap').getBoundingClientRect();
    return { gap: recap.top - back.top, backH: back.height };
  });
  ok(g.gap <= 200, `${T}: the recap starts near the top of the back (${Math.round(g.gap)}px below it, back is ${Math.round(g.backH)}px tall)`);
  await p.evaluate(() => document.querySelector('.rv-back .flash-back').scrollIntoView({ block: 'end' }));
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await p.waitForTimeout(150);
  const e = await p.evaluate(() => {
    const fb = document.querySelector('.rv-back .flash-back').getBoundingClientRect(), rb = document.getElementById('ratebar').getBoundingClientRect();
    return { fbBottom: fb.bottom, rbTop: rb.top, ph: innerHeight };
  });
  ok(e.fbBottom <= e.rbTop + 1, `${T}: the end of the answer can be scrolled above the rating bar (answer bottom ${Math.round(e.fbBottom)}, bar top ${Math.round(e.rbTop)})`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/flip-back-${tag}-${themeName}.png` });
  await ctx.close();
}
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
