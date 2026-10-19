// Anki files: a zip bomb (a small file that unpacks huge) is refused with a clear message, in both the old and the new layout, and
// sql.js is only run when its fingerprint matches (a swapped file from the CDN is refused, js/anki-read.js loadSqlJs).
import zlib from 'node:zlib';
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];

// A zip file with one member (written by hand: the test machine has no zip tool). `data` is stored as given; `claim` is the unpacked size
// the zip says.
function zip(name, packed, method, size, crc) {
  const n = Buffer.from(name), u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }, u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0x21), u32(crc), u32(packed.length), u32(size), u16(n.length), u16(0), n, packed]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0x21), u32(crc), u32(packed.length), u32(size), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), n]);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, end]);
}
const big = Buffer.alloc(101 * 1024 * 1024);                      // 101 MB of nothing: tiny when packed
const old = zip('collection.anki2', zlib.deflateRawSync(big), 8, big.length, zlib.crc32(big));
const fresh = zip('collection.anki21b', zlib.zstdCompressSync(big), 0, big.length / 2, 0);     // (stored, and the zip claims only 50 MB: the zstd inside is the bomb)
console.log(`bomb sizes: old ${old.length} bytes, new ${fresh.length} bytes`);

const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.message));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
for (const [label, buffer] of [['deflate (old layout)', old], ['zstd (new layout)', fresh]]) {
  await page.goto('http://localhost:8123/#/decks'); await page.reload(); await page.waitForSelector('.deck');
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', { name: 'bomb.apkg', mimeType: 'application/zip', buffer });
  await page.waitForFunction(() => !document.querySelector('#loadErr').hidden && !document.querySelector('#fileName').textContent.includes('reading'), null, { timeout: 60000 });
  const msg = await page.textContent('#loadErr');
  ok(msg.includes('more than 100 MB') && msg.includes('Export a smaller deck'), `${label}: refused with a clear message: ${msg}`);
  ok((await page.textContent('#fileName')).trim() === 'bomb.apkg', `${label}: "reading…" is cleared`);
  ok(!(await page.textContent('#found')).includes('Found'), `${label}: nothing was read`);
}
// A normal deck still opens right after.
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', process.argv[2] + '/files/anki-new.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Found 7 cards'), null, { timeout: 30000 });
ok(true, 'a normal deck still opens after a refused one');
await ctx.close();

// sql.js with a swapped file: refused by the fingerprint, nothing from it runs.
const ctx2 = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
const p2 = await ctx2.newPage();
p2.on('pageerror', e => errors.push('pageerror ' + e.message));
await p2.addInitScript(() => { window.__evil = 0; });
await p2.route('**/sql.js@1.12.0/dist/sql-wasm.js', async route => {
  const res = await route.fetch();
  await route.fulfill({ response: res, body: (await res.text()) + '\nwindow.__evil = 1;' });
});
await p2.goto('http://localhost:8123/#/import'); await p2.waitForSelector('#tab-file'); await p2.click('#tab-file');
await p2.setInputFiles('#fileIn', process.argv[2] + '/files/anki-new.apkg');
await p2.waitForSelector('#loadErr:not([hidden])', { timeout: 30000 });
ok((await p2.textContent('#loadErr')).includes("Couldn't read anki-new.apkg"), 'a changed sql-wasm.js is refused');
ok(await p2.evaluate(() => window.__evil) === 0, 'and none of its code ran');
// the wasm too
const ctx3 = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
const p3 = await ctx3.newPage();
await p3.route('**/sql.js@1.12.0/dist/sql-wasm.wasm', async route => {
  const res = await route.fetch(); const b = Buffer.from(await res.body()); b[b.length - 1] ^= 1;
  await route.fulfill({ response: res, body: b });
});
await p3.goto('http://localhost:8123/#/import'); await p3.waitForSelector('#tab-file'); await p3.click('#tab-file');
await p3.setInputFiles('#fileIn', process.argv[2] + '/files/anki-new.apkg');
await p3.waitForSelector('#loadErr:not([hidden])', { timeout: 30000 });
ok((await p3.textContent('#loadErr')).includes("Couldn't read anki-new.apkg"), 'a changed sql-wasm.wasm is refused');

// Many big files in one batch: one getMany call unpacks at most 100 MB in all; the rest come back as "deferred" and are fetched by the next call.
import fs from 'node:fs';
const legacy = fs.readFileSync(process.argv[2] + '/files/anki-legacy.apkg').toString('base64');
const p4 = await browser.newPage();
await p4.goto('http://localhost:8123/#/decks'); await p4.waitForSelector('.deck');
const batch = await p4.evaluate(async b64 => {
  const { readAnkiFile, FFLATE_URL } = await import('./js/anki-read.js');
  const { unzipSync, zipSync } = await import(FFLATE_URL);
  const files = unzipSync(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  for (const k of Object.keys(files)) if (/^\d+$/.test(k)) delete files[k];
  const big = new Uint8Array(40 * 1024 * 1024);
  Object.assign(files, { 0: big, 1: big, 2: big, media: new TextEncoder().encode(JSON.stringify({ 0: 'a.mp3', 1: 'b.mp3', 2: 'c.mp3' })) });
  const res = await readAnkiFile(new File([zipSync(files)], 'many.apkg'));
  const first = await res.media.getMany(['a.mp3', 'b.mp3', 'c.mp3']);
  const second = await res.media.getMany(first.deferred);
  return { first: [...first.keys()], deferred: first.deferred, second: [...second.keys()], secondDeferred: second.deferred, size: first.get('a.mp3')?.data.length };
}, legacy);
ok(batch.first.length === 2 && batch.deferred.length === 1 && batch.size === 40 * 1024 * 1024, 'three 40 MB files in one call: two unpacked, one left for later ' + JSON.stringify({ first: batch.first, deferred: batch.deferred }));
ok(batch.second.length === 1 && batch.secondDeferred.length === 0 && batch.deferred[0] === batch.second[0], 'and the next call brings the rest');
await p4.close();

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
