import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.stack));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
for (const [file, deckName] of [['anki-media-new.apkg', 'Anatomy new'], ['anki-media-legacy.apkg', 'Anatomy old']]) {
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  const found = await page.textContent('#found');
  ok(found.includes('Found 4 cards') && found.includes('have pictures, which come along too (the first one on each side)'), `${file}: ${found}`);
  await page.fill('#newName', deckName); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
  const cards = await page.evaluate(async n => {
    const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === n);
    const cs = await db.getCardsInDeck(d.id);
    return Promise.all(cs.map(async c => ({ front: c.front, back: c.back, fi: c.frontImage ? (await db.getMedia(c.frontImage))?.type : null, bi: c.backImage ? (await db.getMedia(c.backImage))?.type : null })));
  }, deckName);
  const by = f => cards.find(c => c.front === f);
  console.log('   ', JSON.stringify(cards));
  ok(by('Heart')?.fi === 'image/jpeg', `${file}: "Heart" got its picture (name with a space)`);
  ok(by('')?.fi === 'image/jpeg' && by('')?.back === 'Lungs', `${file}: picture-only front kept`);
  ok(by('Brain') && !by('Brain').fi && !by('Brain').bi, `${file}: no picture where there was none`);
}
// export a deck with a picture and check it with real Anki (next step)
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const deckId = await page.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Anatomy new').id);
await page.goto('http://localhost:8123/#/deck/' + deckId); await page.waitForSelector('#exportDeck');
await page.click('#exportDeck'); await page.waitForSelector('#exApkg');
ok((await page.textContent('#sheet')).includes('Pictures go in the Anki deck'), 'export explains where pictures go');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exApkg')]);
await dl.saveAs(SP + '/exports/with-pics.apkg');
ok(true, 'exported a deck with pictures');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
