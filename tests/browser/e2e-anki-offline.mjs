// 4.68 WP-A: Anki files open offline once the reader libraries are saved by the service worker (saveAnkiLibraries in js/anki-read.js).
// Serves a temporary copy of the app (like e2e-sw.mjs) so the page has a real service worker.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from './pw.mjs';

const SP = process.argv[2];
const ROOT = path.resolve(import.meta.dirname, '../..');
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ankioff-'));
for (const f of ['index.html', 'privacy.html', 'terms.html', 'sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(ROOT, f), path.join(SITE, f));
for (const d of ['css', 'js', 'icons', 'fonts']) fs.cpSync(path.join(ROOT, d), path.join(SITE, d), { recursive: true });
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
const LIBS = ['https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js', 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/esm/index.mjs',
  'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.js', 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.wasm'];
const saved = page => page.evaluate(async libs => Promise.all(libs.map(async u => !!(await caches.match(u)))), LIBS);
const ready = async page => {
  await page.goto(URL0 + '#/today'); await page.waitForSelector('.tdeck, .empty');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
};
const pick = async (page, file) => {
  await page.goto(URL0 + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await ready(page);
ok((await saved(page)).every(v => !v), 'before the warm-up none of the four libraries is saved');

const tried = await page.evaluate(async () => (await import('./js/anki-read.js')).saveAnkiLibraries());
ok(tried === 4, 'the warm-up loaded 4 files (' + tried + ')');
await page.waitForFunction(async libs => (await Promise.all(libs.map(async u => !!(await caches.match(u))))).every(Boolean), LIBS, { timeout: 30000 }).catch(() => {});
ok((await saved(page)).every(Boolean), 'all four libraries are in the cache: ' + await saved(page));
ok(await page.evaluate(async () => (await (await import('./js/anki-read.js')).saveAnkiLibraries())) === 0, 'a second warm-up has nothing left to load');

await ctx.setOffline(true);
await page.reload(); await page.waitForSelector('.tdeck, .empty');
for (const [file, label] of [['anki-new.apkg', 'new format (needs fzstd)'], ['anki-legacy.apkg', 'old format']]) {
  await pick(page, file);
  await page.waitForFunction(() => /Found \d+ card/.test(document.querySelector('#found')?.textContent || ''), null, { timeout: 30000 });
  ok((await page.textContent('#found')).includes('from the Anki deck'), `offline, ${label}: the preview shows`);
}
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Offline Anki');
await page.click('#saveBtn'); await page.waitForSelector('.crow');
ok(await page.locator('.crow').count() > 0, 'offline: Add cards saved the deck');
await ctx.setOffline(false);
ok(errors.length === 0, 'no page errors ' + errors.join(' | '));

// A fresh browser window, offline, never warmed: the honest message.
const ctx2 = await browser.newContext({ viewport: { width: 375, height: 740 } });
// (headless Chromium is slow to flip navigator.onLine after setOffline, so the second window is told it is offline from the start of every page)
await ctx2.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false, configurable: true }); });
const p2 = await ctx2.newPage();
await ready(p2);
await ctx2.setOffline(true);
await p2.reload(); await p2.waitForSelector('.tdeck, .empty');
await pick(p2, 'anki-new.apkg');
await p2.waitForSelector('#loadErr:not([hidden])', { timeout: 30000 });
const msg = await p2.textContent('#loadErr');
ok(msg.includes("Couldn't read anki-new.apkg.") && msg.includes('internet connection the first time'), 'not warmed, offline: ' + msg);
await browser.close(); server.close(); fs.rmSync(SITE, { recursive: true, force: true });
