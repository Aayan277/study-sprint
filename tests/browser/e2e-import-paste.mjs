// 4.66 WP-B: the Import buttons (one primary, Clear last), "Paste Claude's answer", and the first-run paste-only view.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const open = async (vp, scheme = 'light') => {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.width < 700, isMobile: vp.width < 700, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto('http://localhost:8123/#/import'); await p.waitForSelector('#pasteBox');
  return p;
};
const visPrimary = p => p.evaluate(() => [...document.querySelectorAll('#pane-paste .pane-actions .btn, #claudeNote .btn')].filter(b => b.offsetParent && b.classList.contains('primary')).map(b => b.id));
const stubClip = (p, mode, text = '', delay = 0) => p.evaluate(([m, t, d]) => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => new Promise((res, rej) => setTimeout(() => m === 'ok' ? res(t) : rej(new Error('denied')), d)), writeText: async () => {} } });
}, [mode, text, delay]);

for (const [name, vp, scheme] of [['phone', { width: 375, height: 740 }, 'dark'], ['desktop', { width: 1100, height: 800 }, 'dark']]) {
  const p = await open(vp, scheme);
  ok((await visPrimary(p)).join() === 'suggestBtn', name + ': exactly one primary in the paste row (Suggest cards)');
  const order = await p.evaluate(() => [...document.querySelectorAll('#pane-paste .pane-actions .btn')].map(b => b.id));
  ok(order[order.length - 1] === 'clearBtn', name + ': Clear is last');
  const r = await p.evaluate(() => { const c = document.getElementById('clearBtn').getBoundingClientRect(), a = document.querySelector('#pane-paste .pane-actions').getBoundingClientRect(); return a.right - c.right; });
  ok(r < 4, name + ': Clear sits at the right end');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': no sideways scroll');
  await p.fill('#pasteBox', 'Mitosis - cell division');
  await stubClip(p, 'ok', 'x');
  await p.click('#claudeBtn');
  await p.waitForSelector('#pasteAnsBtn');
  ok((await visPrimary(p)).join() === 'pasteAnsBtn', name + ': with the Claude note showing, Paste Claude\'s answer is the only primary');
  await p.context().close();
}

// clipboard answer
let p = await open({ width: 375, height: 740 });
await p.fill('#pasteBox', 'my notes'); await stubClip(p, 'ok', 'Front one\tBack one\nFront two\tBack two'); await p.click('#claudeBtn');
await p.click('#pasteAnsBtn'); await p.waitForSelector('#preview:not([hidden])');
ok((await p.inputValue('#pasteBox')).startsWith('Front one') && await p.isVisible('#aiNote') && await p.isHidden('#claudeNote'), 'clipboard answer fills the box and shows the ai-made note');
ok((await p.textContent('#found')).includes('2'), 'and the preview shows the 2 cards');
await p.context().close();

// denied clipboard
p = await open({ width: 375, height: 740 });
await p.fill('#pasteBox', 'my notes'); await stubClip(p, 'fail'); await p.click('#claudeBtn');
await p.click('#pasteAnsBtn');
await p.waitForFunction(() => document.activeElement?.id === 'pasteBox');
ok(true, 'denied: pasteBox is focused');
ok((await p.inputValue('#pasteBox')) === 'my notes', 'denied: the notes stay');
await p.context().close();

// leaving during a slow clipboard read changes nothing
p = await open({ width: 375, height: 740 });
await p.fill('#pasteBox', 'my notes'); await stubClip(p, 'ok', 'A\tB\nC\tD', 600); await p.click('#claudeBtn');
await p.click('#pasteAnsBtn');
await p.evaluate(() => { location.hash = '#/decks'; });
await p.waitForSelector('.deck');
await p.waitForTimeout(900);
ok(await p.evaluate(() => !document.getElementById('preview') && !document.getElementById('pasteBox')), 'leaving during a slow read: nothing is drawn afterwards');
ok(errors.length === 0, 'no page errors ' + errors.join('; '));
await p.context().close();

// first run: paste-only
p = await open({ width: 375, height: 740 });
await p.goto('http://localhost:8123/#/import/__new/paste'); await p.waitForSelector('#pasteBox');
const vis = await p.evaluate(() => ['tab-paste', 'tab-file', 'tab-sheet', 'deckSel', 'suggestBtn', 'claudeBtn', 'clearBtn'].filter(i => document.getElementById(i).offsetParent));
ok(vis.length === 0 && await p.isVisible('#pasteBox') && await p.isVisible('#moreWays'), 'paste-only: only the box and More ways to add show');
await p.fill('#pasteBox', 'Mitosis - cell division\nMeiosis - four gametes');
await p.waitForSelector('#preview:not([hidden])'); ok(await p.isVisible('#saveBtn'), 'paste-only: preview and Add cards still show');
await p.click('#moreWays');
ok(await p.isVisible('#tab-file') && await p.isVisible('#deckSel') && await p.isVisible('#claudeBtn'), 'More ways to add brings everything back');
await p.context().close();
await browser.close();
