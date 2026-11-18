// 4.67 WP-A: one button height on a computer (36 / 44), Start at the right of Today's top card (Original),
// Settings switches on the left on a computer (both styles) and on the right on a phone.
import { chromium } from './pw.mjs';
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];

async function open(w, h, ui, mode, touch = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.addInitScript(([u, m]) => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: u, skin: 'ocean', mode: m })); localStorage.setItem('study-sprint-rail', '0'); } catch { /* fine */ } }, [ui, mode]);
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
  await p.goto(URL); await p.waitForSelector('.today-hero');
  await p.evaluate(async ([u, m]) => {
    const db = await import('./js/db.js'), now = Date.now();
    await db.setSetting('theme', { ui: u, skin: 'ocean', mode: m, oled: false });   // the saved setting wins over localStorage, so Clinical needs it here
    await db.addDeckWithCards({ id: 'wpa', name: 'Wpa deck', color: '#3E63DD', created: now + 1 },
      Array.from({ length: 6 }, (_, i) => ({ id: 'wpa' + i, deckId: 'wpa', front: 'Q' + i, back: 'A' + i, tags: [], created: i })));
  }, [ui, mode]);
  await p.reload(); await p.waitForSelector('.today-hero');
  return { p, ctx };
}
const go = async (p, hash, sel) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(sel); await p.waitForTimeout(250); };
const heights = p => p.evaluate(() => [...document.querySelectorAll('.btn:not(.big):not(.cta):not(.wide)')]
  .filter(b => b.getClientRects().length && !b.closest('[hidden]') && getComputedStyle(b).visibility !== 'hidden')
  .map(b => ({ h: b.getBoundingClientRect().height, t: (b.id || b.className) + ':' + b.textContent.trim().slice(0, 16) }))
  .filter(x => x.h < 80));   // single-line buttons only

for (const ui of ['original', 'clinical']) for (const mode of ['light', 'dark']) {
  const tag = `${ui} ${mode} 1440`;
  const { p, ctx } = await open(1440, 900, ui, mode);
  const bad = [];
  const scan = async name => { for (const x of await heights(p)) if (Math.abs(x.h - 36) > .5 && Math.abs(x.h - 44) > .5) bad.push(`${name} ${x.t} ${x.h}`); };
  await scan('today');
  await go(p, '#/decks', '.deck'); await scan('decks');
  await go(p, '#/deck/wpa', 'main[data-route="deck"] .screen-head'); await scan('deck');
  const head = await p.$$eval('main[data-route="deck"] .screen-head .head-actions .btn', bs => bs.map(b => b.getBoundingClientRect().height));
  ok(head.length && head.every(h => Math.abs(h - 36) < .5), `${tag}: deck header buttons are 36px (${head.join(',')})`);
  await go(p, '#/browse', 'main[data-route="browse"]'); await scan('browse');
  await go(p, '#/settings', '#advanced'); await scan('settings');
  await go(p, '#/decks', '.deck');
  await p.evaluate(async () => { const m = await import('./js/decks.js'); m.openDeckEditor({ id: 'wpa', name: 'Wpa deck', color: '#3E63DD' }, () => {}); });
  await p.waitForSelector('.sheet-foot .btn'); await p.waitForTimeout(300);
  const foot = await p.$$eval('.sheet-foot .btn', bs => bs.filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect().height));
  ok(foot.length && foot.every(h => Math.abs(h - 44) < .5), `${tag}: sheet footer buttons are 44px (${foot.join(',')})`);
  ok(!bad.length, `${tag}: every normal button is 36 or 44px${bad.length ? ': ' + bad.slice(0, 8).join(' | ') : ''}`);
  await ctx.close();
}

// Start fills the rest of the top card's row after the ring and streak (Original), full width on a phone, a 220px button at the right of the row in Clinical
for (const [w, h] of [[1440, 900], [1024, 768]]) for (const mode of ['light', 'dark']) {
  const { p, ctx } = await open(w, h, 'original', mode);
  const r = await p.evaluate(() => { const hero = document.querySelector('.today-hero'), cs = getComputedStyle(hero), hb = hero.getBoundingClientRect(), b = document.getElementById('startBtn').getBoundingClientRect();
    const ring = hero.querySelector('.ring').getBoundingClientRect();
    return { right: hb.right - parseFloat(cs.paddingRight) - b.right, afterRing: b.left - ring.right, w: b.width }; });
  ok(Math.abs(r.right) <= 2 && r.afterRing > 0 && r.w >= 220, `original ${mode} ${w}: Start fills the row after the ring, up to the card's right padding (${r.right.toFixed(1)}px in, ${r.afterRing.toFixed(0)}px after the ring, ${r.w.toFixed(0)}px wide)`);
  await ctx.close();
}
{
  const { p, ctx } = await open(390, 844, 'original', 'light', true);
  const r = await p.evaluate(() => { const hb = document.querySelector('.today-hero').getBoundingClientRect(), b = document.getElementById('startBtn').getBoundingClientRect(); return b.width / hb.width; });
  ok(r > .8, `phone: Start is full width (${(r * 100).toFixed(0)}% of the card)`);
  await ctx.close();
}
{
  const { p, ctx } = await open(1440, 900, 'clinical', 'light');
  const r = await p.evaluate(() => { const hero = document.querySelector('.today-hero'), cs = getComputedStyle(hero), hb = hero.getBoundingClientRect(), b = document.getElementById('startBtn').getBoundingClientRect(); return { right: hb.right - parseFloat(cs.paddingRight) - b.right, w: b.width, top: b.top - hb.top, h: hb.height }; });
  ok(Math.abs(r.right) <= 2 && Math.abs(r.w - 220) <= 1 && r.top < r.h / 2, `clinical 1440: Start is a 220px button at the right end of the one-row card (${r.right.toFixed(1)}px in, ${r.w.toFixed(0)}px wide)`);
  await ctx.close();
}

// Settings switches: left of the label on a computer (both styles), right of it on a phone
const sw = p => p.evaluate(() => { for (const d of document.querySelectorAll('main details')) d.open = true;
  return [...document.querySelectorAll('main .switch-row')].filter(r => r.getClientRects().length && !r.closest('[hidden]')).map(r => {
    const s = r.querySelector('.switch').getBoundingClientRect(), rg = document.createRange(); rg.selectNodeContents(r.querySelector(':scope > span'));
    const t = [...rg.getClientRects()].filter(x => x.width); const l = Math.min(...t.map(x => x.left)), rt = Math.max(...t.map(x => x.right));
    return { sr: s.right, sl: s.left, tl: l, tr: rt, name: (r.textContent || '').trim().slice(0, 20) }; }); });
for (const ui of ['original', 'clinical']) for (const mode of ['light', 'dark']) {
  const { p, ctx } = await open(1440, 900, ui, mode);
  await go(p, '#/settings', '#advanced');
  const rows = await sw(p);
  const badL = rows.filter(r => !(r.sr <= r.tl + .5 && r.tl - r.sr <= 24));
  ok(rows.length >= 5 && !badL.length, `${ui} ${mode} 1440: ${rows.length} switches sit just left of their label${badL.length ? ': ' + badL.slice(0, 3).map(r => r.name).join(' | ') : ''}`);
  await ctx.close();
}
for (const ui of ['original', 'clinical']) {
  const { p, ctx } = await open(390, 844, ui, 'light', true);
  await go(p, '#/settings', '#advanced');
  const rows = await sw(p), bad = rows.filter(r => !(r.sl >= r.tr - .5));
  ok(rows.length >= 5 && !bad.length, `${ui} 390: ${rows.length} switches stay at the right${bad.length ? ': ' + bad.slice(0, 3).map(r => r.name).join(' | ') : ''}`);
  await ctx.close();
}

ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors[0] : ''));
await browser.close();
