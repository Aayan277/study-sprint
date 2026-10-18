// The service worker: app files come from this version's saved copy (never refreshed file by file),
// a new version of sw.js installs a fresh copy and reloads once, and the app opens offline.
// It serves a temporary copy of the app (on any free port) so the test can change files between visits.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from './pw.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sw-'));
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(ROOT, f), path.join(SITE, f));
for (const d of ['css', 'js', 'icons']) fs.cpSync(path.join(ROOT, d), path.join(SITE, d), { recursive: true });
const probe = v => fs.appendFileSync(path.join(SITE, 'js/sample.js'), `\nexport const PROBE = '${v}';\n`);
const setProbe = v => { const f = path.join(SITE, 'js/sample.js'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/export const PROBE = '.*';/, `export const PROBE = '${v}';`)); };
probe('A');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
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
const probeNow = () => page.evaluate(async () => (await import('./js/sample.js')).PROBE);
const cacheNames = () => page.evaluate(() => caches.keys());
const settle = ms => page.waitForTimeout(ms);

// 1. First visit: the worker installs and saves every app file.
await page.goto(URL0 + '#/today'); await page.waitForSelector('.tdeck, .empty');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
ok((await cacheNames()).length === 1, 'first visit: one cache of app files ' + (await cacheNames()));
const first = (await cacheNames())[0];
ok(await page.evaluate(async c => !!(await (await caches.open(c)).match('js/today.js')), first), 'js/today.js is saved');
ok(await probeNow() === 'A', 'first visit runs the files as served');

// 2. Same version of the worker, a changed file: every visit keeps using this version's saved copy, so a new file can
// never be mixed with old ones. The change arrives with the next worker version (step 3).
setProbe('B');
await page.reload(); await page.waitForSelector('.tdeck, .empty');
ok(await probeNow() === 'A', 'a visit is answered from the saved copy');
await settle(800);
await page.reload(); await page.waitForSelector('.tdeck, .empty');
ok(await probeNow() === 'A', 'and files are not refreshed one by one in the background (no mixed versions)');

// 2b. CDN libraries (v4.2.2): save a good copy, an opaque one (no-cors) and one of a version the app no longer pins.
const JSD = 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/';
const CSS = JSD + 'katex.min.css', FONT = JSD + 'fonts/KaTeX_Main-Regular.woff2', OLD = 'https://cdn.jsdelivr.net/npm/katex@0.15.0/dist/katex.min.css';
await page.evaluate(async ([css, font, old]) => { await fetch(css); await fetch(font, { mode: 'no-cors' }); await fetch(old); }, [CSS, FONT, OLD]);
await settle(800);
const inCache = (cache, url) => page.evaluate(async ([c, u]) => { const r = await (await caches.open(c)).match(u); return r ? r.type : null; }, [cache, url]);
ok(await inCache(first, CSS) === 'cors' && await inCache(first, FONT) === 'opaque' && await inCache(first, OLD) === 'cors', 'the worker saved a good, an opaque and an unpinned library copy');

// 3. A new version of sw.js: a fresh copy of everything is installed, the old one removed, the app reloads once.
setProbe('C');
fs.writeFileSync(path.join(SITE, 'sw.js'), fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8').replace(/study-sprint-v\d+/, 'study-sprint-v999'));
let loads = 0;
page.on('load', () => { loads++; });
await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
// The update reloads the page by itself: wait for that reload in node (an evaluate running across it would fail with
// "Execution context was destroyed"), then for the new cache, then let things settle.
for (let t = Date.now(); loads < 1 && Date.now() - t < 15000; ) await new Promise(r => setTimeout(r, 100));
await page.waitForLoadState('load');
await page.waitForFunction(() => caches.keys().then(k => k.length === 1 && k[0] === 'study-sprint-v999'), null, { timeout: 15000 }).catch(() => {});
for (let i = 0; i < 150 && !loads; i++) await settle(100);      // wait for the reload itself (how long the install takes depends on how busy the computer is)
await settle(300);
ok(JSON.stringify(await cacheNames()) === '["study-sprint-v999"]', 'new worker: only the new cache is left ' + (await cacheNames()));
ok(loads === 1, 'the app reloaded once to pick up the update (' + loads + ')');
await page.waitForSelector('.tdeck, .empty');
ok(await probeNow() === 'C', 'after the reload the new files run straight away, not the old ones');

// 3b. Only the good copy of a library that this release still pins came over to the new cache.
ok(await inCache('study-sprint-v999', CSS) === 'cors', 'a pinned library copy is carried to the new cache');
ok(await inCache('study-sprint-v999', FONT) === null, 'an opaque copy is left behind');
ok(await inCache('study-sprint-v999', OLD) === null, 'a copy of a version that is no longer pinned is left behind');

// 4. Offline: the app still opens.
await ctx.setOffline(true);
await page.reload(); await page.waitForSelector('.tdeck, .empty');
ok(await probeNow() === 'C', 'offline: the app opens from the saved files');
ok((await page.locator('h1').first().textContent()) === 'Today', 'offline: Today shows');
await page.evaluate(() => { location.hash = '#/stats'; }); await page.waitForSelector('.pgrid, .empty');
ok((await page.locator('h1').first().textContent()) === 'Stats', 'offline: another screen (loaded on demand) opens too');
ok(await page.evaluate(async css => { try { return (await fetch(css + '?again=2')).ok; } catch { return false; } }, CSS), 'offline: a jsdelivr address with a ?search is answered by the saved file');
await ctx.setOffline(false);
ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
await browser.close(); server.close(); fs.rmSync(SITE, { recursive: true, force: true });
