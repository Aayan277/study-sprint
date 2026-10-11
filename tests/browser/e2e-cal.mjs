import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
for (const [w, h, name, extra] of [[375, 740, 'phone', { isMobile: true, hasTouch: true }], [1440, 900, 'desktop', {}], [375, 740, 'phone-dark', { isMobile: true, hasTouch: true, colorScheme: 'dark' }]]) {
  const p = await (await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', ...extra })).newPage();
  p.on('pageerror', e => errors.push(e.stack));
  await p.goto('http://localhost:8123/'); await p.waitForSelector('.deck');
  await p.evaluate(async () => {     // ~4 months of patchy studying
    const db = await import('./js/db.js'); const cs = await db.getAll('cards'); const D = 86400000, now = Date.now();
    const logs = [];
    for (let d = 0; d < 120; d++) { if ((d * 7) % 5 === 1) continue; const n = (d * 13) % 9; for (let k = 0; k < n; k++) logs.push({ cardId: cs[k % cs.length].id, timestamp: now - d * D - k * 60000, source: k % 3 ? 'review' : 'play', rating: 3, correct: true, state: 2 }); }
    await db.putMany('reviewLog', logs);
  });
  await p.goto('http://localhost:8123/#/stats'); await p.waitForSelector('#calGrid');
  const r = await p.evaluate(() => ({
    cells: document.querySelectorAll('#calGrid i').length, studied: document.querySelectorAll('#calGrid i[class*="lv"]:not(.lv0)').length,
    atEnd: (() => { const b = document.querySelector('#calScroll'); return b.scrollLeft + b.clientWidth >= b.scrollWidth - 2; })(),
    pageScroll: document.documentElement.scrollWidth > innerWidth, months: [...document.querySelectorAll('.cal-m')].filter(m => m.textContent).length
  }));
  ok(r.cells === 53 * 7 && r.studied > 50 && r.months >= 12, `${name}: a year of days, ${r.studied} studied, ${r.months} month labels`);
  ok(r.atEnd && !r.pageScroll, `${name}: scrolled to the newest week, no sideways page scroll`);
  await p.locator('#calGrid i.today').click();
  ok(/: \d+ answers?|: no studying/.test(await p.textContent('#calInfo')), `${name}: tapping a day explains it: ` + await p.textContent('#calInfo'));
  await p.locator('.cal-card').screenshot({ path: `${SP}/cal-${name}.png` });
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
