import { chromium } from './pw.mjs';
const SP = process.argv[2];
const b = await chromium.launch();
let bad = 0;
for (const width of [320, 375]) for (const mode of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8123/'); await p.waitForSelector('.deck');
  await p.evaluate(async m => { const t = await import('./js/themes.js'); const db = await import('./js/db.js'); await db.setSetting('theme', t.applyTheme({ skin: 'ink', mode: m }));
    const cs = await db.getAll('cards'); const now = Date.now();
    await db.putMany('cardStates', cs.slice(0, 6).map((c, i) => ({ cardId: c.id, due: now + (i - 2) * 86400000, stability: 3 + i * 5, difficulty: 5, reps: 3, lapses: i % 3, state: 2 })));
    await db.putMany('reviewLog', cs.map((c, i) => ({ cardId: c.id, timestamp: now - (i % 5) * 86400000, source: i % 2 ? 'play' : 'review', correct: i % 4 !== 0, state: 2, applied: true, reason: 'due' }))); }, mode);
  // screens: [name, how to get there]
  const screens = [
    ['decks', async () => { await p.goto('http://localhost:8123/#/decks'); await p.reload(); await p.waitForSelector('.deck'); }],
    ['deck', async () => { await p.click('.deck-open'); await p.waitForSelector('.crow'); }],
    ['deck-edit', async () => { await p.click('#editDeck'); await p.waitForSelector('#deckName'); await p.click('#deckDelete'); }],
    ['import', async () => { await p.goto('http://localhost:8123/#/import'); await p.waitForSelector('#pasteBox'); await p.fill('#pasteBox', 'A fairly long term name here - with a definition that goes on for a while, longer than the box\nB - c\nD - e'); await p.waitForSelector('.prow'); }],
    ['review-setup', async () => { await p.goto('http://localhost:8123/#/review'); await p.waitForSelector('#startBtn'); }],
    ['review-card', async () => { await p.click('#startBtn'); await p.waitForSelector('#flash'); await p.click('#showBtn'); await p.waitForSelector('.rate'); }],
    ['play-setup', async () => { await p.goto('http://localhost:8123/#/play'); await p.waitForSelector('#startBtn'); }],
    ['play-hard', async () => { await p.click('input[name=diff][value=hard]', { force: true }); await p.click('input[name=fmt][value=survival]', { force: true }); await p.click('#startBtn'); await p.waitForSelector('.opt'); }],
    ['play-results', async () => { for (let i = 0; i < 3; i++) { await p.waitForSelector('.opt:not([disabled])'); await p.click('#skipBtn', { force: true }).catch(() => {}); const wrong = await p.evaluate(() => { const o = [...document.querySelectorAll('.opt')]; return o.length; }); await p.keyboard.press('1'); await p.waitForSelector('.fb'); if (await p.$('.fb.ok')) { await p.keyboard.press('Enter'); i--; continue; } await p.keyboard.press('Enter'); } await p.waitForSelector('.stamp'); }],
    ['stats', async () => { await p.goto('http://localhost:8123/#/stats'); await p.waitForSelector('.chart'); }],
    ['settings', async () => { await p.goto('http://localhost:8123/#/settings'); await p.waitForSelector('#exportBtn'); }]
  ];
  for (const [name, go] of screens) {
    try { await go(); } catch (e) { console.log(`ERROR ${width} ${mode} ${name}: ${e.message.split('\n')[0]}`); bad++; continue; }
    await p.waitForTimeout(150);
    const r = await p.evaluate(() => {
      const over = document.documentElement.scrollWidth - innerWidth;
      // anything poking out past the right edge of the screen
      const offenders = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('dialog:not([open])'); }).slice(0, 3).map(e => e.className || e.tagName);
      return { over, offenders };
    });
    const okk = r.over <= 0 && !r.offenders.length;
    if (!okk) { bad++; console.log(`FAIL ${width}px ${mode} ${name}: overflow ${r.over}px`, r.offenders.join(', ')); }
    if (width === 320 && mode === 'light') await p.screenshot({ path: `${SP}/sw-${name}.png` });
  }
  if (errs.length) { bad++; console.log(`ERRORS ${width} ${mode}:`, errs.join(' | ')); }
  await ctx.close();
}
console.log(bad ? `${bad} problems` : 'PASS every screen fits at 320px and 375px, light and dark, no errors');
await b.close();
