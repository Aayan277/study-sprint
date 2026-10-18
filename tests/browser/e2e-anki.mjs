import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('not-anki')) errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const fronts = () => page.$$eval('.prow textarea[data-side=front]', t => t.map(x => x.value));

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
for (const [file, label] of [['anki-new.apkg', 'new format'], ['anki-legacy.apkg', 'old format']]) {
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file');
  await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  const found = await page.textContent('#found');
  // 6 notes: 4 basic (one reversed type) + 1 cloze with 2 numbers + 1 with sound = 7 rows
  ok(found.includes('Found 7 cards, from the Anki deck'), `${label}: ${found}`);
  ok(found.includes('1 note has pictures, which come along too'), `${label}: picture note mentioned`);
  const f = await fronts();
  ok(f.includes('Classical conditioning') && f.includes('Neuron') && f.includes('The […] handles planning and Broca is for speech.') && f.includes('The frontal lobe handles planning and [speech area] is for speech.'), `${label}: fronts incl. cloze and sound stripped ` + JSON.stringify(f));
  const backs = await page.$$eval('.prow textarea[data-side=back]', t => t.map(x => x.value));
  ok(backs.includes('Learning by **association** (Pavlov)') && backs.includes('Learning from consequences\ne.g. rewards & punishments') && backs.includes('frontal lobe'), `${label}: backs cleaned`);
  ok(await page.isVisible('#sheetPickRow') && (await page.textContent('#sheetPickLbl')) === 'Anki deck', `${label}: deck picker shown`);
  const opts = await page.$$eval('#sheetPick option', o => o.map(x => x.textContent));
  ok(opts.join('|') === 'All decks (7)|Psychology (7)|Psychology › Unit 2 (5)', `${label}: decks ${opts.join('|')}`);
  await page.selectOption('#sheetPick', 'Psychology::Unit 2');
  ok((await page.textContent('#found')).includes('Found 5 cards'), `${label}: pick subdeck`);
  await page.selectOption('#sheetPick', '');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no sideways scroll`);
  if (file === 'anki-new.apkg') await page.screenshot({ path: SP + '/anki-preview.png', fullPage: true });
}
// save the last one into a new deck, with tags
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'From Anki');
await page.click('#saveBtn'); await page.waitForSelector('.crow');
const cards = await page.evaluate(async () => { const db = await import('./js/db.js'); const { subtreeIds } = await import('./js/deck-tree.js'); const ds = await db.getDecks(); const ids = subtreeIds(ds, ds.find(d => d.name === 'From Anki').id); return (await db.getAll('cards')).filter(c => ids.has(c.deckId)).filter(c => c.front === 'Classical conditioning' || c.front === 'Neuron'); });
ok(cards.length === 2 && cards.find(c => c.front === 'Classical conditioning').tags.join() === 'exam1,learning', 'saved with Anki tags');
ok((await page.locator('.crow').count()) === 8, 'deck has 8 cards (the reversed note brings both)');

// broken file
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/files/broken.apkg');
await page.waitForSelector('#loadErr:not([hidden])');
ok((await page.textContent('#loadErr')).includes('Anki Deck Package'), 'broken file explained: ' + await page.textContent('#loadErr'));
ok((await page.textContent('#fileName')).trim() === 'broken.apkg', 'the broken file clears "reading…": ' + await page.textContent('#fileName'));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
