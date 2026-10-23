// Review: a front (or back) of several short lines, like a template card "見る / to see / Plain negative / ~ない", shows its first line at the
// card's full size and the other lines smaller and quieter; a single line, a paragraph and long lines look as they always did.
// Run with: node tests/browser/run.mjs front-style      Screenshots go to $SHOTS if it is set.
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const PARA = 'The hippocampus turns short-term memories into long-term ones, and it is one of the first brain regions to be damaged in Alzheimer disease. Patients first forget recent events.';
const CARDS = [
  { id: 'multi', front: '｜見《み》る\nto see\nPlain negative\n~ない · doesn\'t ~', back: '見ない\nみない\nる-verb (ichidan): drop る, add the ending\nる-verb (ichidan)' },
  { id: 'single', front: 'Hippocampus', back: 'Memory' },
  { id: 'para', front: PARA, back: PARA },
  { id: 'longlines', front: 'Word\nA line that is far too long to count as a short line in a list of lines\nthird', back: 'one\ntwo\nthree' },
  { id: 'two', front: 'Word\nmeaning', back: 'one\ntwo' },
  { id: 'rtl', front: 'كتب\nto write\nالماضي', back: 'كَتَبَ\nkataba\nفعل ماض' }
];
const THEMES = { original: { ui: 'original', skin: 'indigo', mode: 'dark', oled: false }, clinical: { ui: 'clinical', skin: 'ocean', mode: 'dark', oled: false } };

const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);

async function open(viewport, mobile, theme, mode) {
  const ctx = await browser.newContext({ viewport, colorScheme: mode, serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.stack));
  page.on('console', m => { if (m.type() === 'error' && !/katex|jsdelivr|Failed to load resource|net::ERR/i.test(m.text())) errors.push('console ' + m.text()); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async ({ CARDS, theme, mode }) => {
    const db = await import('./js/db.js');
    await db.setSetting('theme', { ...theme, mode });
    for (const c of CARDS) await db.addDeckWithCards({ id: 'd-' + c.id, name: 'Deck ' + c.id, color: '#3E63DD', created: 1 }, [{ id: c.id, deckId: 'd-' + c.id, front: c.front, back: c.back, tags: [], created: 1 }]);
  }, { CARDS, theme, mode });
  await page.reload(); await page.waitForSelector('.deck');
  return page;
}
const sizeOf = (p, sel) => p.locator(sel).first().evaluate(el => { const s = getComputedStyle(el); return { px: parseFloat(s.fontSize), weight: +s.fontWeight, color: s.color, cls: el.className, anim: s.animationName + '/' + s.transitionDuration }; });
const show = async (p, id) => { await p.goto(APP + '#/review/d-' + id); await p.waitForSelector('#flash'); await p.waitForTimeout(450); };
const flip = async p => { await p.keyboard.press('Space'); await p.waitForSelector('.rv-back:not([inert])'); await p.waitForTimeout(450); };
const plain = (p, sel) => p.locator(sel).first().evaluate(el => { const c = el.cloneNode(true); c.querySelectorAll('rt').forEach(r => r.remove()); c.querySelectorAll('br').forEach(b => b.replaceWith('\n')); return c.textContent.split('\n').map(l => l.trim()).filter(Boolean).join('|'); });

async function run(tag, viewport, mobile, themeName, mode) {
  const p = await open(viewport, mobile, THEMES[themeName], mode);
  const T = `${tag}/${themeName}/${mode}`;
  // ---- front ----
  await show(p, 'single');
  const one = await sizeOf(p, '.rv-front .flash-front');
  ok(one.cls === 'flash-front' && await p.locator('.rv-front .lead, .rv-front .rest').count() === 0, `${T}: a single line is as before (no lead, no rest, class "${one.cls}")`);
  await show(p, 'multi');
  const fcls = await p.locator('.rv-front .flash-front').getAttribute('class');
  const lead = await sizeOf(p, '.rv-front .flash-front .lead'), rest = await sizeOf(p, '.rv-front .flash-front .rest');
  ok(fcls === 'flash-front multi', `${T}: a short multi-line front is "multi", not "long" (${fcls})`);
  ok(Math.abs(lead.px - one.px) < .5 && lead.weight >= 600, `${T}: the first line is at the full size of a one-line front (${lead.px}px vs ${one.px}px, weight ${lead.weight})`);
  ok(rest.px <= lead.px * .7 && rest.px >= 15, `${T}: the other lines are smaller (${rest.px}px) but not tiny`);
  const bg = rgb(await p.locator('.rv-front').evaluate(el => getComputedStyle(el).backgroundColor));
  ok(contrast(rgb(rest.color), bg) >= 4.5, `${T}: the quiet lines keep 4.5:1 (${contrast(rgb(rest.color), bg).toFixed(2)})`);
  ok(lead.anim === 'none/0s' && rest.anim === 'none/0s', `${T}: no animation or transition on the lines`);
  ok(await plain(p, '.rv-front .flash-front') === '見る|to see|Plain negative|~ない · doesn\'t ~', `${T}: the text and its order are unchanged for a screen reader`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${T}: no sideways scroll`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/front-${tag}-${themeName}-${mode}.png` });
  // ---- back ----
  await flip(p);
  const bl = await sizeOf(p, '.rv-back .flash-back .lead'), br = await sizeOf(p, '.rv-back .flash-back .rest'), rl = await sizeOf(p, '.rv-back .flash-recap .lead'), rr = await sizeOf(p, '.rv-back .flash-recap .rest');
  ok(bl.px > br.px * 1.4 && bl.weight >= 600, `${T}: on the back the first answer line is prominent (${bl.px}px / weight ${bl.weight}) and the rest secondary (${br.px}px)`);
  ok(rr.px < rl.px, `${T}: the recap of the front has the same hierarchy (${rl.px}px, ${rr.px}px)`);
  const bbg = rgb(await p.locator('.rv-back').evaluate(el => getComputedStyle(el).backgroundColor));
  ok(contrast(rgb(br.color), bbg) >= 4.5 && contrast(rgb(rr.color), bbg) >= 4.5, `${T}: the quiet lines on the back keep 4.5:1`);
  ok(await plain(p, '.rv-back .flash-back') === '見ない|みない|る-verb (ichidan): drop る, add the ending|る-verb (ichidan)', `${T}: back text and order unchanged`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${T}: back has no sideways scroll`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/back-${tag}-${themeName}-${mode}.png` });
  // ---- cards that must look as before ----
  await show(p, 'para');
  const pc = await p.locator('.rv-front .flash-front').getAttribute('class');
  ok(/\b(long|xlong)\b/.test(pc) && !/multi/.test(pc) && await p.locator('.rv-front .lead').count() === 0, `${T}: a paragraph keeps its long size (${pc})`);
  const para = await sizeOf(p, '.rv-front .flash-front');
  ok(para.px <= one.px, `${T}: and is never larger than a one-line front (${para.px}px, ${one.px}px)`);
  await flip(p);
  ok(await p.locator('.rv-back .lead, .rv-back .rest').count() === 0, `${T}: a paragraph's back has no lead and rest`);
  for (const id of ['longlines', 'two']) {
    await show(p, id);
    ok(!/multi/.test(await p.locator('.rv-front .flash-front').getAttribute('class')) && await p.locator('.rv-front .lead').count() === 0, `${T}: "${id}" (long lines, or only two lines) is left as it was`);
  }
  // ---- right to left ----
  await show(p, 'rtl');
  ok(await p.locator('.rv-front .flash-front .lead').count() === 1 && await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${T}: Arabic lines get a lead too, with no sideways scroll`);
  ok(await plain(p, '.rv-front .flash-front') === 'كتب|to write|الماضي', `${T}: Arabic text order unchanged`);
  if (SHOTS && themeName === 'original' && mode === 'dark') await p.screenshot({ path: `${SHOTS}/front-rtl-${tag}.png` });
  await p.context().close();
}
for (const themeName of ['original', 'clinical']) for (const mode of ['dark', 'light']) {
  await run('phone', { width: 375, height: 760 }, true, themeName, mode);
  await run('desktop', { width: 1280, height: 800 }, false, themeName, mode);
}
ok(errors.length === 0, 'no errors in the console' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
