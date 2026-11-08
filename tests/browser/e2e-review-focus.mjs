// Review "Focus" layout: on a computer the sidebar steps away while a round is open and comes back when it closes;
// the End button still leaves the round; nothing hidden can take keyboard focus; Clinical, Play and phones are not changed by it.
// Run with: node tests/browser/run.mjs review-focus
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const DESK = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const open = async (vp, ui = 'original') => {
  const ctx = await browser.newContext({ ...vp, colorScheme: 'dark', serviceWorkers: 'block', reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ui => {
    const t = await import('./js/themes.js'); const db = await import('./js/db.js');
    await db.setSetting('theme', t.applyTheme({ ui, skin: 'violet', mode: 'dark', oled: false })); await db.setSetting('whatsNewSeen', '999');
  }, ui);
  if (ui === 'clinical') await p.waitForFunction(() => document.documentElement.getAttribute('data-ui') === 'clinical' && document.getElementById('clinicalCss')?.sheet);
  await p.goto(URL + '#/review'); await p.reload(); await p.waitForSelector('#startBtn');
  return p;
};
const shown = (p, sel) => p.$eval(sel, e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).catch(() => false);

// Computer, Original style
{
  const p = await open(DESK);
  ok(await shown(p, '.tabs') && await shown(p, '.top'), 'desktop: the sidebar is there before the round starts');
  await p.click('#startBtn'); await p.waitForSelector('#showBtn');
  ok(!(await shown(p, '.tabs')) && !(await shown(p, '.top')), 'desktop: the sidebar is hidden while a round is open');
  const left = await p.$eval('main', m => m.getBoundingClientRect().left);
  ok(left < 100, `desktop: the card area uses the freed width (main starts at ${left}px)`);
  const hiddenFocusable = await p.evaluate(() => [...document.querySelectorAll('.tabs a, .tabs button, .top a, .top button')].filter(e => e.offsetParent !== null).length);
  ok(hiddenFocusable === 0, 'desktop: nothing in the hidden sidebar can take keyboard focus');
  for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
  const inSidebar = await p.evaluate(() => !!document.activeElement?.closest('.tabs,.top'));
  ok(!inSidebar, 'desktop: Tab never lands in the hidden sidebar');
  const endName = await p.$eval('#endBtn', b => b.textContent.trim()).catch(() => null);
  ok(endName === 'End', 'desktop: the End button is in the round header');
  await p.click('#endBtn');
  await p.waitForFunction(() => !document.body.classList.contains('focus') || document.querySelector('.modal,dialog[open]') || location.hash !== '#/review');
  const dlg = await p.$('dialog[open] .btn.primary, dialog[open] .btn.danger');
  if (dlg) { await dlg.click().catch(() => {}); }
  await p.waitForFunction(() => !document.body.classList.contains('focus'), null, { timeout: 5000 }).catch(() => {});
  ok(await shown(p, '.tabs') && await shown(p, '.top'), 'desktop: the sidebar is back once the round has ended');
}
// Computer, Clinical keeps its sidebar during a round
{
  const p = await open(DESK, 'clinical');
  await p.click('#startBtn'); await p.waitForSelector('#showBtn');
  ok(await shown(p, '.tabs'), 'Clinical desktop: the sidebar stays during a round');
}
// Phone: the tab bar is hidden during a round as before, and the cards are not smaller
{
  const p = await open(PHONE);
  await p.click('#startBtn'); await p.waitForSelector('#showBtn');
  ok(!(await shown(p, '.tabs')), 'phone: the tab bar is hidden during a round');
  const h = await p.$eval('#showBtn', b => b.getBoundingClientRect().height);
  ok(h >= 64, `phone: Show answer is at least 64px tall (${h})`);
}
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
