// The forced-update screen: the server's app_config() names a minimum version. Older than that, a signed-in app shows "needs an update to keep
// syncing safely" with Update now / Keep using offline; no answer, an error or no function means no minimum. Uses the fake server.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const HOME = 'http://localhost:8123/#/today';

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  return page;
}
const signIn = async page => {
  await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#syncEmail');
  await page.fill('#syncEmail', 'me@example.com'); await page.fill('#syncPw', 'secret123');
  await page.click('#syncCreate');
  await page.waitForFunction(() => /Synced|Signed in|Syncing/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
};
const reopen = async page => { await page.goto(HOME); await page.reload(); await page.waitForSelector('.tdeck, .empty'); };

// ---- not signed in: nothing is asked ----
fake.setAppConfig({ min_client: '99.0' });
let page = await device();
await page.goto(HOME); await page.waitForSelector('.tdeck, .empty'); await page.waitForTimeout(1200);
ok(fake.appConfigCalls() === 0, 'not signed in: app_config is not asked');
ok(await page.locator('#updateRequired').count() === 0, 'and there is no update screen');

// ---- signed in ----
await signIn(page);
fake.setAppConfig({ min_client: '4.0' });
const before = fake.appConfigCalls();
await reopen(page); await page.waitForTimeout(1200);
ok(fake.appConfigCalls() > before, 'signed in: app_config is asked after the first screen');
ok(await page.locator('#updateRequired').count() === 0, 'a minimum below this version: no screen');
ok(await page.evaluate(() => localStorage.getItem('study-sprint-min-client')) === '4.0', 'the minimum is remembered on the device');

fake.setAppConfig(undefined);                                    // the function is not installed (404)
await reopen(page); await page.waitForTimeout(1200);
ok(await page.locator('#updateRequired').count() === 0, 'no such function: no minimum, no screen');
fake.setAppConfig({ message: 'something else' });
await reopen(page); await page.waitForTimeout(1200);
ok(await page.locator('#updateRequired').count() === 0, 'an answer without min_client: no screen');

// ---- too old ----
fake.setAppConfig({ min_client: '99.0' });
await reopen(page);
await page.waitForSelector('#updateRequired', { timeout: 15000 });
const text = await page.textContent('#updateRequired');
ok(text.includes('Study Sprint needs an update to keep syncing safely.'), 'the friendly screen appears: ' + text.slice(0, 80));
ok((await page.locator('#urUpdate').textContent()).trim() === 'Update now' && (await page.locator('#urOffline').textContent()).trim() === 'Keep using offline', 'with both buttons');
ok((await page.locator('#urUpdate').boundingBox()).height >= 44 && (await page.locator('#urOffline').boundingBox()).height >= 44, 'both are 44px tall');
ok(await page.evaluate(() => document.querySelector('main').hasAttribute('inert')), 'the app behind it cannot be used');
ok(await page.evaluate(() => document.activeElement?.id) === 'urUpdate', 'focus is on Update now');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
await page.screenshot({ path: process.argv[2] + '/forced-update.png' });

// Keep using offline: study works, sync is off
await page.click('#urOffline');
ok(await page.locator('#updateRequired').count() === 0, 'Keep using offline closes the screen');
ok(!(await page.evaluate(() => document.querySelector('main').hasAttribute('inert'))), 'and the app works again');
ok(await page.evaluate(() => localStorage.getItem('study-sprint-sync-hold')) === '4.36', 'the choice is remembered for this version');
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'off', name: 'Offline deck', color: '#3E63DD', created: Date.now() }, [{ id: 'o0', deckId: 'off', front: 'Q', back: 'A', tags: [], created: 1 }]);
});
const rowsBefore = fake.userRows('me@example.com').length;
const status = await page.evaluate(async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
ok(/Update Study Sprint to keep syncing/.test(status.error || ''), 'sync says why it is off: ' + status.error);
await page.waitForTimeout(500);
ok(fake.userRows('me@example.com').length === rowsBefore, 'nothing new reached the server');
await page.goto('http://localhost:8123/#/review/off'); await page.waitForSelector('.flash, .rev, [data-rate], #showAns, .review', { timeout: 10000 }).catch(() => {});
ok((await page.textContent('body')).includes('Q'), 'studying a card still works');

// Next start: no screen again, sync still off
const asked = fake.appConfigCalls();
await reopen(page); await page.waitForTimeout(1000);
ok(await page.locator('#updateRequired').count() === 0, 'next start: the screen does not come back');
ok(fake.appConfigCalls() === asked, 'and the server is not asked again');
const status2 = await page.evaluate(async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
ok(/Update Study Sprint to keep syncing/.test(status2.error || ''), 'sync is still off after a restart');

// An update ends the hold: another version number means sync works again
await page.evaluate(() => localStorage.setItem('study-sprint-sync-hold', '4.35'));
fake.setAppConfig({ min_client: '4.0' });
await reopen(page); await page.waitForTimeout(1000);
const status3 = await page.evaluate(async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
ok(!/Update Study Sprint/.test(status3.error || '') && status3.state !== 'error', 'a hold from an older version is over: sync works again');

// Update now: the app restarts (no new version here, so the page just reloads)
fake.setAppConfig({ min_client: '99.0' });
await page.evaluate(() => localStorage.removeItem('study-sprint-sync-hold'));
await reopen(page);
await page.waitForSelector('#updateRequired', { timeout: 15000 });
await page.evaluate(() => { window.__before = performance.timeOrigin; });
const nav = page.waitForEvent('framenavigated', { timeout: 15000 });
await page.click('#urUpdate');
await nav;
await page.waitForSelector('#updateRequired', { timeout: 15000 });
ok(await page.evaluate(() => window.__before === undefined), 'Update now reloads the app (and, still too old, the screen is back)');

// the answer cannot be slow for ever / a down server is no minimum
fake.setDown(true);
fake.setAppConfig({ min_client: '99.0' });
await page.evaluate(() => localStorage.removeItem('study-sprint-min-client'));
await reopen(page); await page.waitForTimeout(1500);
ok(await page.locator('#updateRequired').count() === 0, 'server unreachable: no minimum, no screen');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
