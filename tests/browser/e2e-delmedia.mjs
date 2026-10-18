// Delete account / Delete my synced data must not leave pictures behind (audit: storage delete errors were swallowed, so an account
// could be deleted with its files still on the server). The folder is emptied through the Storage API, listed again to check, and if
// anything is left the deletion stops before anything irreversible, with a plain message.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const MSG = 'Couldn’t remove your pictures from the server. Nothing was deleted. Try again.';

async function setup() {
  const fake = fakeSupabase();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`pageerror ${e.stack}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422|429|404)|Sync failed|Failed to load resource|Could not remove/.test(m.text())) errors.push(`console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *');
  await page.fill('#syncEmail', 'me@example.com'); await page.fill('#syncPw', 'secret123'); await page.click('#syncCreate');
  await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    for (let i = 0; i < 3; i++) await db.putMedia({ id: 'pic-' + i, type: 'image/jpeg', data: new Uint8Array(500 + i).buffer, size: 500 + i, created: Date.now(), uploaded: false });
    (await import('./js/sync.js')).timing.mediaRetry = 5;
    await (await import('./js/sync.js')).syncNow();
  });
  return { fake, page };
}
const attempt = (page, fn) => page.evaluate(async fn => {
  const sync = await import('./js/sync.js');
  try { await sync[fn](); return { done: true }; } catch (e) { return { code: e.code, message: e.message }; }
}, fn);
const signedIn = page => page.evaluate(async () => !!(await (await import('./js/db.js')).getSettings()).syncAuth);

// ================= the normal case: every file is removed, then the account =================
{
  const { fake, page } = await setup();
  ok(fake.files.size === 3, 'three pictures are on the server');
  const r = await attempt(page, 'deleteAccount');
  ok(r.done && fake.files.size === 0 && fake.deleted.includes('me@example.com'), 'Delete account: files removed through the Storage API, then the account');
  ok(!(await signedIn(page)), 'and this device is signed out');
  await page.context().close();
}
{
  const { fake, page } = await setup();
  const r = await attempt(page, 'deleteServerData');
  ok(r.done && fake.files.size === 0 && fake.userRows('me@example.com').length === 0, 'Delete my synced data: files and rows are gone');
  await page.context().close();
}

// ================= the server will not remove the files =================
{
  const { fake, page } = await setup();
  fake.setMediaStuck(true);
  const rowsBefore = fake.userRows('me@example.com').length;
  const t0 = Date.now();
  const r = await attempt(page, 'deleteAccount');
  ok(r.message === MSG && r.code === 'server_media_left', 'Delete account: stops with "' + r.message + '"');
  ok(fake.users.has('me@example.com') && fake.userRows('me@example.com').length === rowsBefore && fake.files.size === 3 && await signedIn(page), 'nothing was deleted: account, rows and files are there and this device is still signed in');
  ok(!fake.log.some(l => l.includes('delete_my_account')), 'the irreversible call was never made');
  ok(fake.log.filter(l => l.startsWith('DELETE /storage/v1/object/media')).length >= 2 && Date.now() - t0 < 10000, 'it tried again briefly first');
  // it works once the server lets go
  fake.setMediaStuck(false);
  const r2 = await attempt(page, 'deleteAccount');
  ok(r2.done && fake.files.size === 0 && fake.deleted.includes('me@example.com'), 'Try again: it goes through');
  await page.context().close();
}
{
  const { fake, page } = await setup();
  fake.setMediaStuck(true);
  const r = await attempt(page, 'deleteServerData');
  ok(r.message === MSG && fake.userRows('me@example.com').length > 0 && await signedIn(page), 'Delete my synced data: stops before the rows are deleted');
  await page.context().close();
}

// ================= the server function says "media_left" =================
{
  const { fake, page } = await setup();
  fake.setListBlind(true);                      // the app's own listing shows nothing, but files remain: only the server's check catches it
  const r = await attempt(page, 'deleteAccount');
  ok(r.message === MSG && r.code === 'server_media_left' && fake.users.has('me@example.com'), 'media_left from the server gets the same message, and the account is kept: ' + r.message);
  await page.context().close();
}

// ================= a server that lists and removes only 100 at a time =================
{
  const { fake, page } = await setup();
  const uid = fake.users.get('me@example.com').id;
  for (let i = 0; i < 250; i++) fake.files.set(`${uid}/bulk-${String(i).padStart(3, '0')}`, { type: 'image/jpeg', data: Buffer.from('x') });
  fake.setListCap(100);
  const r = await attempt(page, 'deleteAccount');
  ok(r.done && fake.files.size === 0 && fake.deleted.includes('me@example.com'), 'a page cap of 100 is handled: all 253 files are removed, then the account');
  await page.context().close();
}

// ================= a failure after the files are gone says so =================
{
  const { fake, page } = await setup();
  fake.setRowsDeleteFails(true);
  const r = await attempt(page, 'deleteServerData');
  ok(r.message === 'Your pictures and sounds were removed from the server, but the rest wasn’t. Try again.' && r.code === 'partly_deleted', 'the message is specific, not "Nothing was deleted": ' + r.message);
  ok(fake.files.size === 0 && fake.userRows('me@example.com').length > 0 && await signedIn(page), 'the files are gone, the rows are not, and the person is still signed in to try again');
  fake.setRowsDeleteFails(false);
  const r2 = await attempt(page, 'deleteServerData');
  ok(r2.done && fake.userRows('me@example.com').length === 0, 'Try again: it finishes');
  await page.context().close();
}

// ================= the sheet in Settings shows it =================
{
  const { fake, page } = await setup();
  fake.setMediaStuck(true);
  await page.goto(APP + '#/settings'); await page.waitForSelector('#delAcctBtn');
  await page.click('#delAcctBtn'); await page.fill('#daText', 'DELETE'); await page.click('#daYes');
  await page.waitForSelector('#daErr:not([hidden])', { timeout: 15000 });
  ok((await page.textContent('#daErr')).trim() === MSG, 'the sheet says: ' + (await page.textContent('#daErr')).trim());
  ok(fake.users.has('me@example.com'), 'and the account is still there');
  await page.context().close();
}

ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
await browser.close();
