// Small-screen and accessibility sweep for launch: 320 and 375px, light and dark, Original and Clinical.
// On every screen: no sideways scroll, nothing tappable under 24x24px, readable text contrast, no page errors.
// (sweep.mjs checks sideways scroll only and is left as it is.) Prints PASS or FAIL for each combination and screen.
import { realChromium, deckMenu } from './pw.mjs';
const SP = process.argv[2];
const APP = 'http://localhost:8123/';
const browser = await realChromium.launch();
let bad = 0;
const report = (good, msg) => { console.log((good ? 'PASS ' : 'FAIL ') + msg); if (!good) { bad++; process.exitCode = 1; } };

// Runs in the page: returns { over, small, contrast } for what is on screen now.
const CHECK = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  // Any CSS colour (rgb, hex, color(srgb ...), color-mix) → [r, g, b, a] by painting one pixel.
  const rgba = c => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, bottom) => { const a = top[3] + bottom[3] * (1 - top[3]); return a ? [0, 1, 2].map(i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a) : [0, 0, 0, 0]; };
  const lum = ([r, g2, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g2) + .0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const visible = e => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[hidden], dialog:not([open]), [inert]'); };
  const label = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '')) + ' "' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24) + '"';

  const overflow = document.documentElement.scrollWidth - innerWidth;
  const poking = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('dialog:not([open])') && !e.closest('.col, .set-nav, [data-scroll]') && !(e.closest('[style*="overflow"], .chips, .tabs') && false); }).slice(0, 3).map(label);

  const small = [];
  for (const e of document.querySelectorAll('button, a[href], input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), select, summary')) {
    if (!visible(e) || e.closest('.col, .switch, .sr-only') || e.matches('.switch, .sr-only, :disabled')) continue;
    const s = getComputedStyle(e);
    if (e.matches('a[href]') && s.display === 'inline' && e.closest('p, li, span, label')) continue;          // a link inside a sentence is exempt (WCAG 2.5.8)
    const r = e.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) small.push(label(e) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  const low = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const e = n.parentElement;
    if (!e || seen.has(e) || !n.nodeValue.trim() || !visible(e) || e.closest('svg, .sr-only, script, style, canvas, [aria-hidden=true]')) continue;
    seen.add(e);
    if (e.closest(':disabled, [aria-disabled=true]')) continue;
    // background: walk up to the first (nearly) opaque layer; give up on pictures, gradients and blur
    const layers = []; let skip = false;
    for (let a = e; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (Number(s.opacity) < 1 || s.backgroundImage !== 'none' || (s.backdropFilter && s.backdropFilter !== 'none')) { skip = true; break; }
      // (a label drawn outside its parent's box, like the number above a chart bar, is not on that parent's background)
      const ar = a.getBoundingClientRect(), er = e.getBoundingClientRect(), cx = er.left + er.width / 2, cy = er.top + er.height / 2;
      if (a !== e && (cx < ar.left || cx > ar.right || cy < ar.top || cy > ar.bottom)) continue;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= .9) break;
    }
    if (skip) continue;
    let bg = rgba(getComputedStyle(document.documentElement).backgroundColor); if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1]);
    if (getComputedStyle(document.body).backgroundColor && !layers.length) bg = over(rgba(getComputedStyle(document.body).backgroundColor), bg);
    for (const l of layers.reverse()) bg = over(l, bg);
    const s = getComputedStyle(e);
    const fg = over(rgba(s.color), bg);
    const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const rt = ratio(fg, bg);
    if (rt < need - 0.01) low.push(`${label(e)} ${rt.toFixed(2)}<${need}`);
  }
  return { over: overflow, poking, small: small.slice(0, 4), smallN: small.length, low: low.slice(0, 4), lowN: low.length };
};

for (const width of [320, 375]) for (const ui of ['original', 'clinical']) for (const mode of ['light', 'dark']) {
  const combo = `${width}px ${ui} ${mode}`;
  const ctx = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  const setup = async seen => {
    await p.evaluate(async ([ui, mode, seen]) => {
      const t = await import('./js/themes.js'); const db = await import('./js/db.js');
      await db.setSetting('theme', t.applyTheme({ ui, skin: 'violet', mode, oled: false }));
      await db.setSetting('whatsNewSeen', seen);
      const cs = await db.getAll('cards'); const now = Date.now();
      if (!(await db.getAll('cardStates')).length) {
        await db.putMany('cardStates', cs.slice(0, 6).map((c, i) => ({ cardId: c.id, due: now + (i - 2) * 86400000, stability: 3 + i * 5, difficulty: 5, reps: 3, lapses: i % 3, state: 2 })));
        await db.putMany('reviewLog', cs.map((c, i) => ({ cardId: c.id, timestamp: now - (i % 5) * 86400000, source: i % 2 ? 'play' : 'review', correct: i % 4 !== 0, state: 2, applied: true, reason: 'due' })));
      }
    }, [ui, mode, seen]);
  };
  await setup('999');
  const to = async (hash, sel) => { await p.goto(APP + hash); await p.reload(); await p.waitForSelector(sel); };
  const screens = [
    ['today', () => to('#/today', '.today-hero')],
    ['whats-new', async () => { await setup('4.36'); await to('#/today', '.wn'); }],
    ['today-options', async () => { await setup('999'); await to('#/today', '#optBtn'); await p.click('#optBtn'); await p.waitForSelector('#sheet[open]'); }],
    ['today-streak', async () => { await to('#/today', '#streakBtn'); await p.click('#streakBtn'); await p.waitForSelector('#sheet[open] h2'); }],
    ['decks', () => to('#/decks', '.deck')],
    ['deck', () => to('#/deck/sample', '.crow')],
    ['import', async () => { await to('#/import', '#pasteBox'); await p.fill('#pasteBox', 'A fairly long term name here - with a definition that goes on for a while, longer than the box\nB - c\nD - e'); await p.waitForTimeout(300); }],
    ['browse', () => to('#/browse', '.brow, .crow, h1')],
    ['play-setup', () => to('#/play', '#startBtn')],
    ['review-card', async () => { await to('#/review', '#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash'); await p.click('#showBtn'); await p.waitForSelector('.rate'); }],
    ['stats', () => to('#/stats', '.chart')],
    ['settings', () => to('#/settings', '#exportBtn')],
    ['settings-sync', () => to('#/settings/sync', '#syncEmail')],
    ['help', async () => { await to('#/help', 'details.help-q'); await p.$$eval('details.help-q', els => els.forEach(e => { e.open = true; })); }],
    ['welcome-pitch', () => to('#/welcome/again', '#wlNext')]
  ];
  for (const [name, go] of screens) {
    try { await go(); } catch (e) { report(false, `${combo} ${name}: could not open (${e.message.split('\n')[0]})`); continue; }
    await p.waitForTimeout(150);
    const r = await p.evaluate(CHECK);
    const problems = [];
    if (r.over > 0 || r.poking.length) problems.push(`sideways scroll ${r.over}px ${r.poking.join(', ')}`);
    if (r.smallN) problems.push(`${r.smallN} tap target(s) under 24px: ${r.small.join('; ')}`);
    if (r.lowN) problems.push(`${r.lowN} low-contrast text: ${r.low.join('; ')}`);
    report(!problems.length, `${combo} ${name}${problems.length ? ': ' + problems.join(' | ') : ''}`);
    if (SP && width === 320 && mode === 'light' && ui === 'original') await p.screenshot({ path: `${SP}/ls-${name}.png` }).catch(() => {});
  }
  report(!errs.length, `${combo}: no page errors${errs.length ? ' ' + errs.slice(0, 2).join(' | ') : ''}`);
  await ctx.close();
}
await browser.close();
