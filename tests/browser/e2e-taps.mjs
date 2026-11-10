// Tap sizes on a phone (390x844, touch), both styles: the controls the owner measured under 44px are 44px now (box, or box plus its
// see-through tap area), the Settings "?" links are small round rings next to their label, and on Import the Add button never covers
// the "Preview" heading or the "Found…" line.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const APP = 'http://localhost:8123/';
// the box of an element plus its ::before tap area
const tapSize = (page, sel) => page.evaluate(sel => [...document.querySelectorAll(sel)].map(el => {
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect(), b = getComputedStyle(el, '::before');
  let w = r.width, h = r.height;
  if (b.content !== 'none' && b.position === 'absolute') {
    const l = parseFloat(b.left), t = parseFloat(b.top), bw = parseFloat(b.width), bh = parseFloat(b.height);
    if ([l, t, bw, bh].every(Number.isFinite)) { w = Math.max(r.right, r.x + l + bw) - Math.min(r.x, r.x + l); h = Math.max(r.bottom, r.y + t + bh) - Math.min(r.y, r.y + t); }
  }
  return [Math.round(w), Math.round(h)];
}), sel);
for (const clinical of [false, true]) {
  const name = clinical ? 'Clinical' : 'Original';
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  if (clinical) { await page.evaluate(async () => { await (await import('./js/db.js')).setSetting('theme', { ui: 'clinical', skin: 'ocean', mode: 'dark', oled: false }); }); await page.reload(); await page.waitForSelector('.deck'); await page.waitForFunction(() => document.documentElement.dataset.ui === 'clinical' && !!document.getElementById('clinicalCss')?.sheet); }
  const all44 = async (where, sel, what, { minW = 44 } = {}) => {
    const sizes = await tapSize(page, sel);
    ok(sizes.length > 0 && sizes.every(([w, h]) => w >= minW - 1 && h >= 43), `${name}: ${what} are 44px to tap (${sizes.length} measured, smallest ${Math.min(...sizes.map(s => s[0]))}x${Math.min(...sizes.map(s => s[1]))})`);
  };
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const sample = (await db.getDecks())[0];
    await db.saveDeck({ ...sample, examDate: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10) });
    for (let i = 0; i < 7; i++) await db.addDeckWithCards({ id: 'x' + i, name: 'Extra ' + i, color: '#46A758', created: Date.now() }, [{ id: 'xc' + i, deckId: 'x' + i, front: 'q' + i, back: 'a', tags: [], created: Date.now() }]);
  });
  await page.goto(APP + '#/today'); await page.waitForSelector('.exam-add .link');
  await all44('today', '.exam-add .link', '"N more in Decks" link', { minW: 40 });
  await page.goto(APP + '#/settings'); await page.waitForSelector('.help-link');
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await all44('settings', '.help-link', 'Settings "?" links', { minW: 44 });
  const ring = await page.evaluate(() => { const e = document.querySelector('.help-link'), c = getComputedStyle(e), r = e.getBoundingClientRect(), p = e.previousElementSibling; const pr = p?.getBoundingClientRect(); return { w: r.width, h: r.height, radius: c.borderRadius, border: c.borderTopWidth, sameLine: pr ? Math.abs((r.top + r.height / 2) - (pr.top + pr.height / 2)) < 8 : null, ml: c.marginLeft }; });
  ok(ring.w === 24 && ring.h === 24 && ring.radius === '50%' && ring.border === '1px' && ring.sameLine === true && ring.ml === '6px', `${name}: "?" is a 24px ring next to its label ` + JSON.stringify(ring));
  await all44('settings', '.steps-hint a', 'Settings "More" links', { minW: 20 });
  if (clinical) await all44('settings', '.chip span', 'option chips');
  await page.goto(APP + '#/deck/sample'); await page.waitForSelector('#prepBtn');
  await all44('deck', '#prepBtn, #mockBtn', 'Exam prep and mock exam buttons', { minW: 40 });
  ok(!(await page.$eval('#prepBtn', e => e.getAttribute('style'))), `${name}: Exam prep has no inline style any more`);
  await page.click('#testBtn'); await page.waitForSelector('#ptForm');
  await all44('practice', '.pt-form .chip span', 'practice test chips');
  await all44('practice', '.sheet-x', 'sheet close buttons');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.locator('.crow-btn').first().click(); await page.waitForSelector('.fmt-tools');
  if (clinical) await all44('panel', '.fmt-tools button', 'editor toolbar buttons');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.goto(APP + '#/import/sample'); await page.waitForSelector('#pasteBox');
  await page.fill('#pasteBox', Array.from({ length: 12 }, (_, i) => `Question ${i + 1}\tAnswer ${i + 1}`).join('\n'));
  await page.waitForSelector('#preview:not([hidden])'); await page.waitForTimeout(300);
  await all44('import', '.prow .icon-btn', 'import row delete buttons', { minW: 44 });
  ok((await page.$$eval('.prow textarea', t => t.every(x => x.getBoundingClientRect().height >= 43.5))), `${name}: import row text boxes are 44px tall`);
  for (const y of [0, 300, 600, 900]) {
    await page.evaluate(y => window.scrollTo(0, y), y); await page.waitForTimeout(150);
    const cover = await page.evaluate(() => { const b = document.getElementById('savebar').getBoundingClientRect(); return ['pvTitle', 'found'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > 0; }); });
    ok(!cover[0] && !cover[1], `${name}: scrolled to ${y}, the Add button covers neither "Preview" nor "Found…"`);
  }
  await page.goto(APP + '#/review/sample'); await page.waitForTimeout(600);
  if (await page.$('.rv-speak')) await all44('review', '.rv-speak', 'Read aloud button');
  ok(errors.length === 0, `${name}: no page errors ${errors.join('|')}`);
  await ctx.close();
}
await browser.close();
