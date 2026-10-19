// A new install follows the device's light or dark setting; a saved choice is kept.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const APP = 'http://localhost:8123/';
const theme = p => p.evaluate(() => document.documentElement.getAttribute('data-theme'));
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.goto(APP); await p.waitForSelector('#screen .view *');
  ok(await theme(p) === scheme, `fresh profile, device ${scheme}: the app is ${scheme} (${await theme(p)})`);
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lum = bg.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
  ok(scheme === 'light' ? lum > 200 : lum < 80, `and it looks ${scheme}: ${bg}`);
  const saved = await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).theme.mode);
  ok(saved === 'auto', 'the default mode is auto: ' + saved);
  // a saved choice wins over the device
  await p.evaluate(async () => { const t = await import('./js/themes.js'); const db = await import('./js/db.js'); const th = { ...(await db.getSettings()).theme, mode: 'dark' }; await db.setSetting('theme', th); t.applyTheme(th); });
  await p.reload(); await p.waitForSelector('#screen .view *');
  ok(await theme(p) === 'dark', `a saved Dark stays dark on a ${scheme} device`);
  await ctx.close();
}
await browser.close();
