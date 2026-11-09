// Round 5: Settings no longer says "Appearance" twice at the top (the highlighted jump chip and then an "Appearance" heading).
// The first section's heading stays in the page for screen readers (it names its section) but takes no room; every other heading stays visible.
// Checked in both styles (Original, and Clinical with css/clinical.css loaded) on a phone (390x844) and a computer (1440x900).
// Run with: node tests/browser/run.mjs ui-r5
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const PC = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const STYLES = ['original', 'clinical'];

for (const ui of STYLES) for (const [label, viewport, touch] of [['PC 1440x900', PC, false], ['phone 390x844', PHONE, true]]) {
  const tag = `${ui} ${label}`;
  console.log('--- ' + tag);
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', colorScheme: 'dark', isMobile: touch, hasTouch: touch });
  await ctx.addInitScript(u => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: u, skin: 'ocean', mode: 'dark' })); } catch { /* fine */ } }, ui);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
  await p.evaluate(async u => { const db = await import('./js/db.js'); await db.setSetting('theme', { ui: u, skin: 'ocean', mode: 'dark', oled: false }); }, ui);
  await p.goto(URL + '#/settings'); await p.reload(); await p.waitForSelector('#setNav'); await p.waitForTimeout(600);

  // the style really is the one under test (Clinical's stylesheet is loaded on demand)
  ok(await p.evaluate(u => document.documentElement.dataset.ui === u && (u !== 'clinical' || !!document.getElementById('clinicalCss')?.sheet), ui), `${tag}: running in ${ui}${ui === 'clinical' ? ' with clinical.css loaded' : ''}`);

  // no visible h2 repeats the highlighted jump chip
  const info = await p.evaluate(() => {
    const cur = document.querySelector('#setNav a[aria-current]');
    const shown = h => { const r = h.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const h2s = [...document.querySelectorAll('main[data-route="settings"] section > h2')];
    return { cur: cur?.textContent.trim(), visible: h2s.filter(shown).map(h => h.textContent.trim()), all: h2s.map(h => h.textContent.trim()) };
  });
  ok(info.cur === 'Appearance', `${tag}: the Appearance chip is highlighted at the top`);
  ok(!info.visible.includes(info.cur), `${tag}: no visible h2 repeats the active chip "${info.cur}" (visible: ${info.visible.join(', ')})`);
  ok(info.visible.join() === 'Study,Sync,Your data,About' && info.all.length === 5, `${tag}: every other section title stays visible`);
  ok(await p.locator('main h1').count() === 1 && await p.textContent('main h1') === 'Settings', `${tag}: the page h1 stays`);

  // the hidden heading still names its section
  ok(await p.evaluate(() => {
    const h = document.getElementById('appearTitle'); const s = h.closest('section');
    return h.tagName === 'H2' && h.textContent.trim() === 'Appearance' && s.getAttribute('aria-labelledby') === 'appearTitle';
  }), `${tag}: the Appearance section is still named "Appearance" (aria-labelledby on its hidden h2)`);
  ok(await p.evaluate(() => [...document.querySelectorAll('main[data-route="settings"] section.section')].every(s => { const t = document.getElementById(s.getAttribute('aria-labelledby')); return t && t.textContent.trim(); })), `${tag}: every section has an accessible name`);

  // no empty gap: the first thing in the section starts where the section starts, and sits right under the jump bar (phone) or beside the side menu (PC Clinical)
  const gap = await p.evaluate(() => {
    const s = document.getElementById('appearTitle').closest('section');
    const first = [...s.children].find(c => c.id !== 'appearTitle');
    const nav = document.getElementById('setNav').getBoundingClientRect();
    const fr = first.getBoundingClientRect(), sr = s.getBoundingClientRect();
    return { inside: Math.round(fr.top - sr.top), firstBelow: Math.round(fr.top - nav.bottom), side: nav.right <= sr.left + 1 };
  });
  ok(gap.inside <= 2, `${tag}: nothing is left above the section's first line (${gap.inside}px)`);
  ok(gap.side || (gap.firstBelow >= 0 && gap.firstBelow <= 32), `${tag}: the first line is ${gap.side ? 'beside the side menu' : gap.firstBelow + 'px under the jump bar'}`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: no sideways scroll`);

  // jump links and the highlight still work, including back up to Appearance
  const cur = () => p.$eval('#setNav', n => [...n.querySelectorAll('a[aria-current]')].map(a => a.dataset.sec).join());
  for (const sec of ['syncTitle', 'appearTitle']) {
    await p.click(`#setNav a[data-sec=${sec}]`); await p.waitForTimeout(1300);
    ok(await cur() === sec, `${tag}: tapping ${sec} highlights it (${await cur()})`);
  }
  const top = await p.evaluate(() => ({ y: Math.round(scrollY), sec: Math.round(document.getElementById('appearTitle').closest('section').getBoundingClientRect().top), nav: Math.round(document.getElementById('setNav').getBoundingClientRect().bottom) }));
  ok(top.y <= 120 && top.sec >= -2 && top.sec <= top.nav + 80, `${tag}: Appearance returns to the top of its section (page scroll ${top.y}, section top ${top.sec}, bar bottom ${top.nav})`);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(400);
  ok(await cur() === 'appearTitle', `${tag}: Appearance is highlighted at the very top`);
  await ctx.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
