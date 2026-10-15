import { chromium, deckMenu } from './pw.mjs';
import { readFileSync } from 'node:fs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', acceptDownloads: true, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.stack));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'x', name: 'Bio / Unit 2', color: '#46A758', created: Date.now() }, [
    { id: 'x0', deckId: 'x', front: 'Mitochondria', back: 'Makes ATP, "the powerhouse"', tags: ['cells', 'exam 1'], created: 1 },
    { id: 'x1', deckId: 'x', front: 'Café & <tea>', back: 'Line one\nLine two', tags: [], created: 2 },
    { id: 'x2', deckId: 'x', front: 'Osmosis', back: 'Water, across a membrane', tags: ['cells'], created: 3 }]);
});
await page.goto('http://localhost:8123/#/deck/x'); await deckMenu(page); await page.click('#exportDeck'); await page.waitForSelector('#exCsv');
await page.screenshot({ path: SP + '/export-sheet.png' });
let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exCsv')]);
ok(dl.suggestedFilename() === 'Bio - Unit 2.csv', 'CSV named after the deck: ' + dl.suggestedFilename());
await dl.saveAs(SP + '/exports/deck.csv');
const csv = readFileSync(SP + '/exports/deck.csv', 'utf8');
ok(csv.startsWith('﻿Front,Back,Tags') && csv.includes('Mitochondria,"Makes ATP, ""the powerhouse""","cells, exam 1"'), 'CSV contents');
await deckMenu(page); await page.click('#exportDeck'); await page.waitForSelector('#exApkg');
[dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exApkg')]);
ok(dl.suggestedFilename() === 'Bio - Unit 2.apkg', 'Anki file named after the deck');
await dl.saveAs(SP + '/exports/deck.apkg');
ok((await page.textContent('#toast')).includes('as an Anki deck'), 'toast');
// round trip: import the Anki file back into Study Sprint
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/exports/deck.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
const fronts = await page.$$eval('.prow textarea[data-side=front]', t => t.map(x => x.value));
const backs = await page.$$eval('.prow textarea[data-side=back]', t => t.map(x => x.value));
ok(fronts.join('|') === 'Mitochondria|Café & <tea>|Osmosis' && backs[1] === 'Line one\nLine two' && backs[0] === 'Makes ATP, "the powerhouse"', 'the Anki file imports back into Study Sprint unchanged');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
