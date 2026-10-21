// Polish pass 5: the streak sheet has no sideways scroll with long exam names, the deck-name error sits under the name,
// toasts stay clear of the header, the Settings jump bar marks the current section, and the retention axis does not collide.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const open = async (w, h) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.stack)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, p };
};
const go = async (p, hash, sel) => { await p.evaluate(async h => { await (await import('./js/nav.js')).whenIdle(); location.hash = h; }, hash); await p.waitForSelector(sel); await p.waitForTimeout(300); };
const seed = p => p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
  const iso = n => { const d = new Date(now + n * D); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const cards = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `${id} q ${i}`, back: `${id} a ${i}`, tags: [], created: i }));
  await db.addDeckWithCards({ id: 'a', name: 'Pharmacology and Therapeutics for Clinical Practice Midterm', color: '#46A758', created: now + 1, examDate: iso(5) }, cards('a', 3));
  await db.addDeckWithCards({ id: 'b', name: 'Supercalifragilisticexpialidocious_Anatomy_Deck_Name', color: '#3E63DD', created: now + 2, examDate: iso(5) }, cards('b', 3));
});

for (const [w, h] of [[375, 812], [1440, 900]]) {
  const { ctx, p } = await open(w, h);
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('main');
  await seed(p); await p.reload(); await p.waitForSelector('.deck');

  // Streak sheet: no sideways overflow, even with long exam names
  await go(p, '#/today', '#streakBtn');
  await p.click('#streakBtn'); await p.waitForSelector('#sheet[open] .ys-exams'); await p.waitForTimeout(400);
  const o = await p.$eval('#sheet', s => [s.scrollWidth, s.clientWidth]);
  ok(o[0] <= o[1], `${w}px: the streak sheet does not scroll sideways (${o[0]} <= ${o[1]})`);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);

  // Deck edit: the empty-name error is right under the name box
  await go(p, '#/deck/a', '.crow');
  await p.click('#deckMore'); await p.click('#editDeck'); await p.waitForSelector('#deckName');
  await p.fill('#deckName', ''); await p.locator('#sheet .btn.primary:visible', { hasText: 'Save' }).first().click(); await p.waitForTimeout(200);
  const e = await p.evaluate(() => { const n = document.getElementById('deckName').getBoundingClientRect(), r = document.getElementById('deckErr').getBoundingClientRect(); return { gap: r.top - n.bottom, vis: !document.getElementById('deckErr').hidden, desc: document.getElementById('deckName').getAttribute('aria-describedby') }; });
  ok(e.vis && e.gap >= 0 && e.gap < 60 && /deckErr/.test(e.desc || ''), `${w}px: the deck-name error sits under the box and is linked (${Math.round(e.gap)}px, ${e.desc})`);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);

  // Toast: below the header, not covering it
  await go(p, '#/import', '#pasteBox');
  await p.evaluate(async () => (await import('./js/ui.js')).toast('Hello there', { link: { href: '#/decks', label: 'Undo' } }));
  const t = await p.evaluate(() => { const r = document.getElementById('toast').getBoundingClientRect(); const h = document.querySelector('.back, .screen-head')?.getBoundingClientRect(); return { top: r.top, headBottom: h ? h.bottom : 0, link: document.querySelector('.toast-link').getBoundingClientRect().height }; });
  ok(t.top > t.headBottom + 20, `${w}px: the toast is clear of the header (toast top ${Math.round(t.top)}, header bottom ${Math.round(t.headBottom)})`);
  ok(t.link >= 24, `${w}px: the Undo link is at least 24px tall (${Math.round(t.link)})`);

  // Settings: the jump bar marks the section that was tapped
  await go(p, '#/settings', '#setNav');
  for (const sec of ['appearTitle', 'studyTitle', 'syncTitle', 'dataTitle', 'appearTitle']) {
    await p.click(`#setNav a[data-sec=${sec}]`); await p.waitForTimeout(1300);
    const cur = await p.$eval('#setNav', n => [...n.querySelectorAll('a[aria-current]')].map(a => a.dataset.sec));
    ok(cur.length === 1 && cur[0] === sec, `${w}px: tapping the ${sec} chip marks that very chip current (${cur})`);
  }
  await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(400);
  const endCur = await p.$eval('#setNav', n => [...n.querySelectorAll('a[aria-current]')].map(a => a.dataset.sec));
  ok(endCur.join() === 'dataTitle', `${w}px: at the end of the page the last section is current (${endCur})`);
  await go(p, '#/decks', '.deck');
  const leak = await p.evaluate(() => document.getElementById('setNav') === null);
  ok(leak, `${w}px: the jump bar is gone after leaving Settings`);

  // Browse: maths stays left-to-right and the row picks the card text's direction (Arabic rows read right-to-left)
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'r', name: 'RTL', color: '#46A758', created: Date.now() + 9 }, [
      { id: 'r0', deckId: 'r', front: 'ما هو $x^2+1$ في المعادلة', back: 'الجواب $\\frac{a}{b}$', tags: [], created: 1 },
      { id: 'r1', deckId: 'r', front: 'ما هي {{c1::الميتوكوندريا}} في الخلية', back: 'مصنع الطاقة', cloze: 1, tags: [], created: 2 },
      { id: 'r2', deckId: 'r', front: 'Energy $E=mc^2$', back: 'physics', tags: [], created: 3 },
    ]);
  });
  await go(p, '#/deck/r', '.crow'); await p.waitForSelector('.crow .katex');
  const rows = await p.$$eval('.crow', rs => rs.map(r => ({ f: getComputedStyle(r.querySelector('.f')).direction, k: [...r.querySelectorAll('.katex')].map(k => getComputedStyle(k).direction), ckind: !!r.querySelector('.ckind') })));
  ok(rows.length === 3 && rows.filter(r => r.f === 'rtl').length === 2 && rows.filter(r => r.f === 'ltr').length === 1, `${w}px: two Arabic rows are RTL, the English one LTR (${rows.map(r => r.f)})`);
  ok(rows.every(r => r.k.every(d => d === 'ltr')), `${w}px: KaTeX is left-to-right in every row`);
  ok(rows.some(r => r.ckind && r.f === 'rtl'), `${w}px: the cloze Arabic row is RTL despite its c1 badge`);
  await p.locator('.crow').first().scrollIntoViewIfNeeded();
  await p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/rtl-math-${w}.png` : undefined });

  // Toast: clear of the tab bar, the select bar and the save bar on phones
  if (w < 800) {
    await p.click('#brSelect'); await p.waitForSelector('#brBulk:not([hidden])'); await p.waitForTimeout(200);
    await p.evaluate(async () => (await import('./js/ui.js')).toast('Hello there'));
    const hit = await p.evaluate(() => {
      const t = document.getElementById('toast').getBoundingClientRect();
      return ['.tabs', '.bulkbar', '.savebar'].map(sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent || getComputedStyle(e).position === 'fixed').map(e => e.getBoundingClientRect()).filter(r => r.width && r.height).some(r => t.left < r.right && t.right > r.left && t.top < r.bottom && t.bottom > r.top));
    });
    ok(!hit.some(Boolean), `${w}px: the toast does not overlap the tab bar or other bars (${hit})`);

  }
  // Toast with the Browse side panel open (desktop): centred in the space the panel leaves
  if (w >= 800) {
    await p.locator('.crow-btn').first().click(); await p.waitForSelector('body.has-side'); await p.waitForTimeout(400);
    await p.evaluate(async () => (await import('./js/ui.js')).toast('Hello there'));
    const g = await p.evaluate(() => { const t = document.getElementById('toast').getBoundingClientRect(), sp = document.querySelector('dialog.sheet.side')?.getBoundingClientRect(); return { right: t.right, panelLeft: sp ? sp.left : 1e9 }; });
    ok(g.right <= g.panelLeft, `${w}px: the toast stays left of the open side panel (${Math.round(g.right)} <= ${Math.round(g.panelLeft)})`);
  }

  // Stats: the "Pick a day" box shows a focus ring
  await go(p, '#/stats', '#calPick');
  for (let i = 0; i < 40 && await p.evaluate(() => document.activeElement?.id !== 'calPick'); i++) await p.keyboard.press('Tab');
  const ring = await p.$eval('#calPick', e => { const s = getComputedStyle(e); return s.outlineStyle + ' ' + s.outlineWidth + ' ' + e.matches(':focus-visible'); });
  ok(/^(solid|auto) [1-9]/.test(ring) && /true$/.test(ring), `${w}px: #calPick has a visible focus ring (${ring})`);
  await ctx.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
