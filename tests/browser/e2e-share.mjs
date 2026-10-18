// Share a deck: the share sheet (stubbed), the saved-file fallback, the file importing back, and an .apkg shared to the app (Android's Share target).
import { chromium, deckMenu } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, acceptDownloads: true, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.stack));
// A fake share sheet: keeps what it was given. window.__canShare switches file sharing on and off.
await page.addInitScript(() => {
  window.__canShare = true; window.__shares = [];
  navigator.canShare = d => window.__canShare && !!d?.files?.length;
  navigator.share = async d => { const f = d.files[0]; window.__shares.push({ name: f.name, type: f.type, title: d.title, text: d.text, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) }); };
});
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'x', name: 'Bio / Unit 2', color: '#46A758', created: Date.now() }, [
    { id: 'x0', deckId: 'x', front: 'Mitochondria', back: 'Makes ATP', tags: ['cells'], created: 1 },
    { id: 'x1', deckId: 'x', front: 'The {{c1::nucleus}} holds DNA', back: '', tags: [], created: 2, noteId: 'n1', cloze: 1, noteText: 'The {{c1::nucleus}} holds DNA' },
    { id: 'x2', deckId: 'x', front: 'Osmosis', back: 'Water, across a membrane', tags: ['cells'], created: 3 }]);
});
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page);
const box = await page.locator('#shareDeck').boundingBox();
ok(box && box.height >= 44, 'Share is in the deck menu with a 44px target');
await page.click('#shareDeck'); await page.waitForSelector('#shGo');
ok((await page.textContent('body')).includes('Nothing is uploaded and nothing syncs'), 'says nothing is uploaded or synced');
ok((await page.locator('#shGo').boundingBox()).height >= 44 && (await page.locator('#shCsv').boundingBox()).height >= 44, 'both buttons are 44px tall');
await page.click('#shGo');
await page.waitForFunction(() => window.__shares.length === 1, null, { timeout: 30000 });
const sh = await page.evaluate(() => window.__shares[0]);
ok(sh.name === 'Bio - Unit 2.apkg' && sh.type === 'application/zip' && sh.title === 'Bio / Unit 2', 'shared a File named after the deck, type ' + sh.type);
ok(sh.bytes.length > 1000 && sh.bytes[0] === 0x50 && sh.bytes[1] === 0x4b, 'it is a zip file');
ok((await page.textContent('#toast')).includes('Shared'), 'toast after sharing');
// it imports back with the cards intact
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', { name: sh.name, mimeType: 'application/zip', buffer: Buffer.from(sh.bytes) });
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
const fronts = await page.$$eval('.prow textarea[data-side=front]', t => t.map(x => x.value));
ok(fronts.length === 3 && fronts.includes('Mitochondria') && fronts.includes('Osmosis') && fronts.some(f => f.includes('holds DNA')), 'it imports back with its cards: ' + fronts.join(' | '));
// spreadsheet choice
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shCsv');
await page.click('#shCsv');
await page.waitForFunction(() => window.__shares.length === 2);
const sc = await page.evaluate(() => window.__shares[1]);
ok(sc.name === 'Bio - Unit 2.csv' && sc.type === 'text/csv', 'the spreadsheet choice shares a .csv');
// where files can't be shared: the file is saved, with the plain note
await page.evaluate(() => { window.__canShare = false; });
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shGo');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#shGo')]);
ok(dl.suggestedFilename() === 'Bio - Unit 2.apkg', 'fallback downloads the file: ' + dl.suggestedFilename());
await page.waitForSelector('#shStatus:not([hidden])');
ok((await page.textContent('#shStatus')) === 'Saved the deck file. Send it to a friend; they open it in Study Sprint with Add cards → File.', 'fallback says what to do next');
ok((await page.evaluate(() => window.__shares.length)) === 2, 'nothing was shared in the fallback');
// a share sheet that wants a fresh tap
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(() => { window.__canShare = true; let first = true; const real = navigator.share; navigator.share = async d => { if (first) { first = false; throw new DOMException('no tap', 'NotAllowedError'); } return real(d); }; });
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shGo');
await page.click('#shGo'); await page.waitForSelector('#shNow:not([hidden])');
ok((await page.locator('#shNow').boundingBox()).height >= 44, 'a "Share now" button appears when the browser wants another tap');
await page.click('#shNow');
await page.waitForFunction(() => window.__shares.length === 3);
ok(true, 'Share now shares the ready file');
// desktop layout
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page);
ok(await page.isVisible('#shareDeck'), 'Share is in the menu on a wide screen too');

// Android: an .apkg shared to the app through the worker lands in the Anki import preview.
const apkg = Buffer.from(sh.bytes);
await page.setViewportSize({ width: 375, height: 740 });
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async () => { await navigator.serviceWorker.ready; });
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controls the page');
await page.evaluate(() => {
  const f = document.createElement('form');
  f.method = 'POST'; f.action = 'share-target'; f.enctype = 'multipart/form-data'; f.id = 'fakeShare';
  f.innerHTML = '<input type="file" name="files"><input name="title" value="Bio"><input name="text" value=""><input name="url" value="">';
  document.body.append(f);
});
await page.setInputFiles('#fakeShare input[type=file]', { name: 'Bio - Unit 2.apkg', mimeType: 'application/zip', buffer: apkg });
await page.evaluate(() => document.getElementById('fakeShare').submit());
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
const f2 = await page.$$eval('.prow textarea[data-side=front]', t => t.map(x => x.value));
ok(f2.length === 3 && f2.includes('Mitochondria'), 'a shared .apkg lands in the Anki import preview: ' + f2.join(' | '));
ok(page.url().endsWith('#/import/share') && (await page.textContent('#fileName')).includes('Bio - Unit 2.apkg'), 'on the File tab with its name');
ok((await page.evaluate(async () => (await (await caches.open('study-sprint-share')).keys()).length)) === 1, 'the shared file is kept until the cards are saved');
const man = await (await page.request.get('http://localhost:8123/manifest.webmanifest')).json();
const acc = man.share_target.params.files[0].accept;
ok(['application/zip', 'application/octet-stream', '.apkg'].every(a => acc.includes(a)), 'the manifest accepts .apkg shares');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' || ') : ''));
await browser.close();
