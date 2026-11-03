// Lab build: signing in or creating an account is refused with a clear message and nothing is sent to the server.
// Run with: npm run test:browser lab-sync
import { chromium } from './pw.mjs';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, serviceWorkers: 'block' });
let supabaseRequests = 0;
await ctx.route(/supabase\.co/, route => { supabaseRequests++; route.abort(); });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#syncEmail');
await page.fill('#syncEmail', 'lab@example.com'); await page.fill('#syncPw', 'secret123');
await page.click('#syncForm button[type=submit]');
await page.waitForFunction(() => /Sync is off in the lab build\./.test(document.body.textContent), null, { timeout: 10000 });
ok(true, 'signing in says "Sync is off in the lab build."');
await page.click('#syncCreate');
await page.waitForTimeout(500);
ok(/Sync is off in the lab build\./.test(await page.textContent('body')), 'creating an account says the same');
ok(await page.evaluate(async () => { const s = await (await import('./js/db.js')).getSettings(); return !s.syncAuth; }), 'no account was saved on the device');
ok(supabaseRequests === 0, 'no request went to the server (' + supabaseRequests + ')');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 375px');
ok(errors.length === 0, 'no page errors ' + errors.join('|'));

// An account that was signed in on this origin before (syncAuth is still in IndexedDB): the network layer itself must refuse.
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.setSetting('syncAuth', { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'old@example.com' } });
});
await page.goto('http://localhost:8123/#/today'); await page.reload(); await page.waitForSelector('.view');
await page.waitForTimeout(1500);                                     // start-up: automatic sync, the minimum-version check
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#syncNowBtn');
await page.click('#syncNowBtn'); await page.waitForTimeout(800);
await page.click('#signOutBtn'); await page.waitForSelector('#soKeep'); await page.waitForTimeout(500);
await page.click('#soKeep'); await page.waitForTimeout(1500);
ok(supabaseRequests === 0, 'with an old sign-in on the device: start-up, Sync now and Sign out sent no request (' + supabaseRequests + ')');
ok(await page.evaluate(() => !!document.querySelector('#screen, main')), 'the app is still standing');
ok(errors.length === 0, 'and no page errors ' + errors.join('|'));
await browser.close();
