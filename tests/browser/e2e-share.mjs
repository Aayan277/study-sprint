// Share a deck: the share sheet (stubbed), the saved-file fallback, the file importing back, and an .apkg shared to the app (Android's Share target).
import { chromium, deckMenu, sheetSettled } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, acceptDownloads: true, isMobile: true, hasTouch: true, userAgent: SAFARI });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.stack));
// A fake share sheet: keeps what it was given. window.__canShare switches file sharing on and off.
await page.addInitScript(() => {
  window.__canShare = true; window.__shares = []; window.__active = true; window.__refuse = false;
  Object.defineProperty(navigator, 'userActivation', { get: () => ({ isActive: window.__active, hasBeenActive: true }) });
  navigator.canShare = d => window.__canShare && !!d?.files?.length;
  navigator.share = async d => { if (window.__refuse) throw new DOMException('type not allowed', 'NotAllowedError'); const f = d.files[0]; window.__shares.push({ name: f.name, type: f.type, title: d.title, text: d.text, keys: Object.keys(d), bytes: Array.from(new Uint8Array(await f.arrayBuffer())) }); };
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
ok((await page.textContent('#shStatus')) === 'Saved the deck file to your downloads. Send it to a friend from there; they open it in Study Sprint with Add cards → File.', 'fallback says what to do next');
ok((await page.evaluate(() => window.__shares.length)) === 2, 'nothing was shared in the fallback');
// no fresh tap yet (a slow build): "Share now" shares the ready file
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(() => { window.__canShare = true; window.__active = false; });
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shGo');
await page.click('#shGo'); await page.waitForSelector('#shNow:not([hidden])');
ok((await page.evaluate(() => window.__shares.length)) === 2, 'share() is not called without a fresh tap');
ok((await page.locator('#shNow').boundingBox()).height >= 44, 'a "Share now" button appears');
await page.evaluate(() => { window.__active = true; });
await page.click('#shNow');
await page.waitForFunction(() => window.__shares.length === 3);
const sn = await page.evaluate(() => window.__shares[2]);
ok(sn.name === 'Bio - Unit 2.apkg' && sn.type === 'application/zip', 'Share now shares the ready file: ' + sn.name);
ok(!sn.keys.includes('text'), 'on iOS only the title goes with the file (no stray text item)');
ok((await page.textContent('#toast')).includes('Shared a copy'), 'toast after Share now');
// the browser refuses the file even with a fresh tap: it is saved, never a silent button
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(() => { window.__refuse = true; });
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shGo');
const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#shGo')]);
ok(dl2.suggestedFilename() === 'Bio - Unit 2.apkg', 'canShare yes but share refused: the file is saved');
await page.waitForSelector('#shStatus:not([hidden])');
ok((await page.textContent('#shStatus')).startsWith('Saved the deck file'), 'and it says so');
// a closed share sheet: quiet, with a way to save
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(() => { window.__refuse = false; navigator.share = async () => { throw new DOMException('closed', 'AbortError'); }; });
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shGo');
await page.click('#shGo'); await page.waitForSelector('#shSave:not([hidden])');
ok((await page.locator('#shSave').boundingBox()).height >= 44 && await page.isHidden('#shErr'), 'cancelling shows a quiet save link and no error');
const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#shSave')]);
ok(dl3.suggestedFilename() === 'Bio - Unit 2.apkg', 'the link saves the file');
// pictures not on this device (and no account): says so, then "Share without them"
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async () => {
  window.__canShare = true; window.__active = true;
  navigator.share = async d => { const f = d.files[0]; window.__shares.push({ name: f.name, type: f.type, keys: Object.keys(d), bytes: [] }); };
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'm', name: 'Pics', color: '#46A758', created: Date.now() }, [{ id: 'm0', deckId: 'm', front: 'Heart', back: 'Pump', tags: [], created: 1, frontImage: 'nothere1' }]);
});
await page.goto('http://localhost:8123/#/deck/m'); await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shGo');
const n0 = await page.evaluate(() => window.__shares.length);
await page.click('#shGo'); await page.waitForSelector('#shErr:not([hidden])');
ok(/isn't on this device|in your account any more|aren't/.test(await page.textContent('#shErr')) && (await page.textContent('#shGo')).includes('Share without them') && (await page.evaluate(() => window.__shares.length)) === n0, 'missing pictures are explained first: ' + await page.textContent('#shErr'));
await page.click('#shGo');
await page.waitForFunction(n => window.__shares.length === n + 1, n0, { timeout: 30000 });
ok(true, 'a second tap shares the deck without them');
await sheetSettled(page);
// Clinical style
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/deck/x'); await page.evaluate(() => { document.documentElement.dataset.ui = 'clinical'; });
await deckMenu(page); await page.click('#shareDeck'); await page.waitForSelector('#shGo');
ok((await page.locator('#shGo').boundingBox()).height >= 44 && (await page.locator('#shCsv').boundingBox()).height >= 44, 'Clinical style: 44px buttons');
await page.screenshot({ path: SP + '/share-clinical.png' });
await page.evaluate(() => { delete document.documentElement.dataset.ui; });
// desktop layout
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
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
// Chromium refuses .apkg in its share sheet: the file is saved without calling share()
const ctx2 = await browser.newContext({ viewport: { width: 375, height: 740 }, acceptDownloads: true, isMobile: true, hasTouch: true });
const p2 = await ctx2.newPage(); p2.on('pageerror', e => errors.push(e.stack));
await p2.addInitScript(() => { window.__calls = 0; navigator.canShare = () => true; navigator.share = async () => { window.__calls++; }; });
await p2.goto('http://localhost:8123/#/decks'); await p2.waitForSelector('.deck');
await p2.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'c', name: 'Chrome deck', color: '#46A758', created: 1 }, [{ id: 'c0', deckId: 'c', front: 'A', back: 'B', tags: [], created: 1 }]); });
await p2.goto('http://localhost:8123/#/deck/c'); await deckMenu(p2); await p2.click('#shareDeck'); await p2.waitForSelector('#shGo');
const [dl4] = await Promise.all([p2.waitForEvent('download', { timeout: 30000 }), p2.click('#shGo')]);
ok(dl4.suggestedFilename() === 'Chrome deck.apkg' && (await p2.evaluate(() => window.__calls)) === 0, 'Chromium: the .apkg is saved and share() is not called');
await p2.waitForSelector('#shStatus:not([hidden])');
ok((await p2.textContent('#shStatus')).includes('Add cards → File'), 'with the instructions');
// Other files shared to the app are sorted: a random zip and a .bin are explained, not parsed as text
await page.setViewportSize({ width: 375, height: 740 });
for (const [name, mime, buf] of [['random.zip', 'application/zip', Buffer.from('PK\x03\x04 not really a deck')], ['thing.bin', 'application/octet-stream', Buffer.from([1, 2, 3, 4, 5, 250])]]) {
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(() => {
    document.getElementById('fakeShare')?.remove();
    const f = document.createElement('form');
    f.method = 'POST'; f.action = 'share-target'; f.enctype = 'multipart/form-data'; f.id = 'fakeShare';
    f.innerHTML = '<input type="file" name="files"><input name="title" value=""><input name="text" value=""><input name="url" value="">';
    document.body.append(f);
  });
  await page.setInputFiles('#fakeShare input[type=file]', { name, mimeType: mime, buffer: buf });
  await page.evaluate(() => document.getElementById('fakeShare').submit());
  await page.waitForSelector('#loadErr:not([hidden])', { timeout: 30000 });
  const msg = await page.textContent('#loadErr');
  ok(name === 'thing.bin' ? msg.includes("can't read that kind of file") : msg.startsWith("Couldn't read random.zip"), name + ' is explained, not turned into cards: ' + msg);
  ok(await page.isHidden('#preview'), name + ': no preview of junk cards');
}
// Another website posts to the share address (cross-site): nothing is taken and the Add cards screen is not filled in.
{
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async () => { const c = await caches.open('study-sprint-share'); for (const k of await c.keys()) await c.delete(k); });
  const evil = await ctx.newPage();
  await evil.route('http://evil.test/**', r => r.fulfill({ contentType: 'text/html', body: '<form id="f" method="POST" action="http://localhost:8123/share-target" enctype="multipart/form-data"><input name="title" value="Free cards"><input name="text" value="Q: hi\tA: planted by another site"><input name="url" value=""></form>' }));
  await evil.goto('http://evil.test/');
  await evil.evaluate(() => document.getElementById('f').submit());
  await evil.waitForURL(u => u.origin === 'http://localhost:8123', { timeout: 30000 });
  await evil.waitForTimeout(500);
  ok(!evil.url().includes('import/share'), 'a cross-site post is sent to the app, not the share screen: ' + evil.url());
  ok(await evil.evaluate(async () => (await (await caches.open('study-sprint-share')).keys()).length) === 0, 'and nothing from it is kept');
  ok(!(await evil.textContent('body')).includes('planted by another site'), 'and its text is not on the page');
  await evil.close();
  // The same form from the app itself (same-origin) is taken.
  await page.evaluate(() => {
    document.getElementById('fakeShare')?.remove();
    const f = document.createElement('form');
    f.method = 'POST'; f.action = 'share-target'; f.enctype = 'multipart/form-data'; f.id = 'fakeShare';
    f.innerHTML = '<input name="title" value="Mine"><input name="text" value="Cell - unit of life"><input name="url" value="">';
    document.body.append(f);
    f.submit();
  });
  await page.waitForFunction(() => location.hash === '#/import/share', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#pasteBox')?.value.includes('Cell - unit of life'), null, { timeout: 30000 });
  ok(true, 'a same-origin share is still taken and fills the screen');
}
// A saved share must never be served as a page: an HTML file in the share cache is not answered to a page load.
{
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async () => {
    const c = await caches.open('study-sprint-share');
    await c.put(new URL('share-target/file', document.baseURI), new Response('<script>document.title="XSS-RAN"</script><h1>hostile</h1>', { headers: { 'content-type': 'text/html', 'x-name': 'x.html', 'x-at': String(Date.now()) } }));
  });
  const x = await ctx.newPage();
  const resp = await x.goto('http://localhost:8123/share-target/file');
  const body = await x.content();
  ok(!((resp.headers()['content-type'] || '').includes('text/html') && body.includes('hostile')), 'share-target/file does not render a shared HTML file: ' + resp.headers()['content-type']);
  ok(!body.includes('hostile') && (await x.title()) !== 'XSS-RAN', 'and no script from it runs');
  await x.close();
  await page.evaluate(async () => { const c = await caches.open('study-sprint-share'); for (const k of await c.keys()) await c.delete(k); });
}
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' || ') : ''));
await browser.close();
