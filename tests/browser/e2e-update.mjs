// Updates with a real service worker (js/update.js, sw.js): a new version installs in the background; the app restarts at once when nothing is
// open, but waits ("Update ready — tap to restart") while a card edit, a round or an Add cards draft is open. Serves a temporary copy of
// the app so the test can publish new versions of sw.js.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from './pw.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-upd-'));
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'privacy.html', 'terms.html']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(SITE, f));
for (const d of ['css', 'js', 'icons', 'fonts']) fs.cpSync(path.join(ROOT, d), path.join(SITE, d), { recursive: true });
let version = 2000;
const publish = () => { const f = path.join(SITE, 'sw.js'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/study-sprint-v\d+/, 'study-sprint-v' + (++version))); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const file = path.join(SITE, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const URL0 = `http://localhost:${server.address().port}/`;

const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let loads = 0;
page.on('load', () => { loads++; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cacheNames = () => page.evaluate(() => caches.keys());
// Start a page that this worker controls.
async function fresh(hash = '#/today') {
  await page.goto(URL0 + hash); await page.waitForSelector('.tdeck, .empty, .deck, h1');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  await sleep(300); loads = 0;
}
// A new version of sw.js appears and the browser is asked to look.
const newVersion = async () => { publish(); await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update())); };
const reloaded = async (ms = 12000) => { for (let t = Date.now(); loads < 1 && Date.now() - t < ms; ) await sleep(100); return loads >= 1; };
const waiting = () => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!r.waiting));
const bar = () => page.locator('#updateBar:not([hidden])');

await page.goto(URL0 + '#/today'); await page.waitForSelector('.tdeck, .empty');
await fresh();
const v0 = (await cacheNames())[0];

// 1. Nothing open: the update restarts the app at once (as before).
await newVersion();
ok(await reloaded(), 'idle: the app reloads by itself for a new version');
await page.waitForSelector('.tdeck, .empty'); await sleep(500);
ok(JSON.stringify(await cacheNames()) === `["study-sprint-v${version}"]` && v0 !== (await cacheNames())[0], 'and runs the new version: ' + (await cacheNames()));
ok(await bar().count() === 0, 'no "Update ready" bar when it just restarts');

// 2. A card edit with unsaved changes: no reload, the bar waits.
await fresh('#/stats');
await page.evaluate(async () => {
  const ui = await import('./js/ui.js');
  ui.openSheet('<h2 id="sheetTitle">Edit</h2><form id="f"><textarea id="t">unsaved words</textarea></form>');
  ui.guardSheet(() => true);      // the way the card editor says it holds unsaved changes
});
await newVersion();
await bar().waitFor({ timeout: 15000 });
ok(true, 'unsaved edit: "Update ready" appears');
ok((await bar().textContent()).trim() === 'Update ready — tap to restart', 'with the wording: ' + (await bar().textContent()));
ok(await waiting(), 'the new version is installed and waiting (not taking over)');
await sleep(2500);
ok(loads === 0, 'and the page did not reload');
ok(await page.evaluate(() => document.querySelector('#t')?.value) === 'unsaved words', 'the unsaved text is still there');
ok((await bar().boundingBox()).height >= 44, 'the bar is a 44px target');
// A route change to somewhere that is not Today or Decks does not restart it either, once nothing is dirty.
await page.evaluate(async () => { (await import('./js/ui.js')).closeSheet(); });
await sleep(2000);
const stay = [loads, await bar().count(), await page.evaluate(() => location.hash)];
ok(stay[0] === 0 && stay[1] === 1, 'edit closed on Stats (not a resting place): still waiting ' + stay);
// Back to Decks with nothing open: it restarts by itself.
await page.evaluate(() => { location.hash = '#/decks'; });
ok(await reloaded(), 'Decks with nothing open: the app restarts by itself');
await page.waitForSelector('.deck, .empty'); await sleep(500);
ok(JSON.stringify(await cacheNames()) === `["study-sprint-v${version}"]`, 'now on the new version');

// 3. Tapping the bar restarts at once, even with the edit open.
await fresh();
await page.evaluate(async () => {
  const ui = await import('./js/ui.js');
  ui.openSheet('<h2 id="sheetTitle">Edit</h2><form id="f"><textarea id="t">x</textarea></form>'); ui.guardSheet(() => true);
});
await newVersion();
await bar().waitFor({ timeout: 15000 });
await page.click('#updateBar');
ok(await reloaded(), 'tapping "Update ready" restarts');
await page.waitForSelector('.tdeck, .empty'); await sleep(300);
ok(JSON.stringify(await cacheNames()) === `["study-sprint-v${version}"]`, 'on the new version after the tap');

// 4. A round in progress (focus mode) and an Add cards draft wait too.
await fresh('#/stats');
await page.evaluate(async () => { (await import('./js/ui.js')).setFocusMode(true); });
await newVersion();
await bar().waitFor({ timeout: 15000 });
await sleep(1500);
ok(loads === 0, 'a round in progress: no reload, the bar is shown');
await page.evaluate(async () => { (await import('./js/ui.js')).setFocusMode(false); });
await page.evaluate(() => { location.hash = '#/today'; });
ok(await reloaded(), 'the round over, Today restarts it');

await fresh('#/import');
await page.waitForSelector('#pasteBox');
await page.fill('#pasteBox', 'Q1\tA1\nQ2\tA2');
await newVersion();
await bar().waitFor({ timeout: 15000 });
await sleep(1500);
ok(loads === 0 && await page.inputValue('#pasteBox') === 'Q1\tA1\nQ2\tA2', 'Add cards with typed text: no reload, text kept');
await page.evaluate(() => { location.hash = '#/decks'; });
ok(await reloaded(), 'and once Add cards is left (the text is kept for this tab), Decks restarts it');

// 5. A Practice test route counts as unsaved work too.
await fresh('#/decks');
await page.evaluate(() => { history.replaceState(null, '', '#/test/abc'); });
await newVersion();
await bar().waitFor({ timeout: 15000 });
await sleep(1500);
ok(loads === 0, 'a Practice test (#/test/...): no reload');
await page.evaluate(() => { location.hash = '#/decks'; });
ok(await reloaded(), 'leaving it for Decks restarts');


// 7. Two tabs: one idle, one in a round. The idle one must not switch the version under the busy one (the old files would go while it is still
// loading screens); both show the bar, and when the busy one is free the switch happens for both.
{
  await fresh('#/stats');
  const tabB = await ctx.newPage();
  let loadsB = 0;
  tabB.on('load', () => { loadsB++; });
  await tabB.goto(URL0 + '#/decks'); await tabB.waitForSelector('.deck, .empty');
  await tabB.evaluate(() => navigator.serviceWorker.ready);
  await sleep(500); loads = 0; loadsB = 0;
  const oldCache = (await cacheNames())[0];
  await page.evaluate(async () => { (await import('./js/ui.js')).setFocusMode(true); });      // tab A is mid-round
  await newVersion();
  await bar().waitFor({ timeout: 15000 });
  await tabB.locator('#updateBar:not([hidden])').waitFor({ timeout: 15000 });
  await sleep(1500);
  ok(loads === 0 && loadsB === 0, 'two tabs, one mid-round: neither reloads');
  ok(await waiting(), 'the new version is still waiting');
  ok((await cacheNames()).includes(oldCache), 'and the old files are still there for the busy tab');
  ok(await tabB.locator('#updateBar:not([hidden])').count() === 1, 'the idle tab shows "Update ready" too');
  // the busy tab finishes its round and lands on Today: after a short settle delay it switches both tabs by itself
  await page.evaluate(async () => { (await import('./js/ui.js')).setFocusMode(false); location.hash = '#/today'; });
  ok(await reloaded(), 'when the busy tab is free, the switch happens');
  for (let t = Date.now(); loadsB < 1 && Date.now() - t < 12000; ) await sleep(100);
  ok(loadsB >= 1, 'and the other tab restarts as well');
  await page.waitForSelector('.tdeck, .empty, .deck, h1'); await sleep(500);
  ok(JSON.stringify(await cacheNames()) === `["study-sprint-v${version}"]`, 'both on the new version');
  await tabB.close();
}

// 6. Looking for updates: when the app comes back to the front after an hour, and on a timer.
await fresh();
await page.evaluate(() => {
  window.__updates = 0;
  const real = ServiceWorkerRegistration.prototype.update;
  ServiceWorkerRegistration.prototype.update = function () { window.__updates++; return real.call(this); };
  window.__clock = Date.now();
  Date.now = () => window.__clock;
});
const show = async () => { await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }); await sleep(200); };
await show();
ok(await page.evaluate(() => window.__updates) === 0, 'coming back right away: no new check');
await page.evaluate(() => { window.__clock += 61 * 60 * 1000; });
await show();
ok(await page.evaluate(() => window.__updates) === 1, 'coming back after an hour: one check');
await show();
ok(await page.evaluate(() => window.__updates) === 1, 'and not again within the hour');

ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
await browser.close(); server.close(); fs.rmSync(SITE, { recursive: true, force: true });
