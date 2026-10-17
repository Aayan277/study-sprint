import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('failing on purpose')) errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// open the sample deck, go to import from there
await page.click('.deck-open'); await page.waitForSelector('.crow');
await page.click('a[href^="#/import/"]'); await page.waitForSelector('#pasteBox');
ok((await page.$eval('#deckSel', s => s.selectedOptions[0].textContent)).includes('Psychology'), 'deck preselected from deck page');
await noHScroll('import empty');

// paste messy notes
await page.fill('#pasteBox', '1. Placebo effect – improvement from belief alone\r\n\r\n2. Synapse – gap between neurons: signals cross it\r\n3. Mirror neuron – fires when watching an action\r\n3. Mirror neuron – fires when watching an action');
await page.waitForSelector('#preview:not([hidden])');
const found = await page.textContent('#found');
console.log('   found line:', found);
ok(found.includes('Found 4 cards') && found.includes("'–'"), 'found line shows count and separator');
ok(found.includes('2 possible duplicates'), 'duplicates flagged (1 in deck + 1 in import)');
ok((await page.locator('.prow.dup').count()) === 2, 'two rows marked');
await page.screenshot({ path: SP + '/i1-paste.png', fullPage: true });
await noHScroll('preview');

// remove duplicates, edit a cell, delete a row, swap
await page.click('#dupBtn');
ok((await page.locator('.prow').count()) === 2, 'remove duplicates leaves 2');
await page.locator('.prow textarea[data-side=back]').first().fill('belief');
await page.click('#swapBtn');
ok((await page.locator('.prow textarea[data-side=front]').first().inputValue()) === 'belief', 'edit kept and swap works');
await page.click('#swapBtn');
await page.locator('.prow [data-del]').nth(1).click();
ok((await page.locator('.prow').count()) === 1, 'delete row');
ok((await page.textContent('#saveBtn')).startsWith('Add 1 card to'), 'save button text: ' + await page.textContent('#saveBtn'));
await page.click('#saveBtn'); await page.waitForSelector('.crow');
ok((await page.locator('.crow').count()) === 13, 'saved into sample deck (12 + 1)');
ok((await page.locator('.crow .b').last().textContent()) === 'belief', 'edited back saved');

// Claude button
await page.click('a[href^="#/import/"]'); await page.waitForSelector('#pasteBox');
await page.fill('#pasteBox', 'Notes about the brain');
await page.click('#claudeBtn');
const clip = await page.evaluate(() => navigator.clipboard.readText());
ok(clip.startsWith('Turn the study material below') && clip.endsWith('Material:\nNotes about the brain'), 'Claude prompt copied with notes');
ok(await page.isVisible('#claudeNote'), 'Claude instructions shown');
await page.click('#clearBtn'); ok(await page.isHidden('#preview'), 'clear hides preview');

// file: Quizlet txt into a new deck (opened from Decks, so Back has somewhere real to go)
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#pasteBox');
ok((await page.inputValue('#deckSel')) === '__new', 'library import (not from a deck page) starts on a new deck, not the deck the last import went into');
await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/files/quizlet.txt');
await page.waitForSelector('#preview:not([hidden])');
ok((await page.textContent('#found')).includes('Found 2 cards, separated by tabs'), 'Quizlet file detected');
ok((await page.inputValue('#newName')) === 'quizlet', 'deck name suggested from file name');

// Excel with a header, 3 columns and 2 sheets
await page.setInputFiles('#fileIn', SP + '/files/chem.xlsx');
await page.waitForFunction(() => document.querySelector('#found').textContent.includes('spreadsheet'), null, { timeout: 20000 });
ok((await page.textContent('#found')).includes('Found 3 cards, from the spreadsheet'), 'xlsx parsed: ' + await page.textContent('#found'));
ok(await page.isVisible('#cols'), 'column pickers shown for 3 columns');
ok(await page.isVisible('#sheetPickRow'), 'sheet picker shown for 2 sheets');
await page.selectOption('#backCol', '2');
ok((await page.locator('.prow textarea[data-side=back]').first().inputValue()) === '3', 'choose column 3 as back');
await page.selectOption('#backCol', '1');
await page.screenshot({ path: SP + '/i2-xlsx.png', fullPage: true });
await page.selectOption('#sheetPick', 'Chapter 2');
ok((await page.textContent('#found')).includes('Found 2 cards'), 'switch sheet');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Chemistry');
await page.click('#saveBtn'); await page.waitForSelector('.crow');
ok((await page.locator('h1').textContent()) === 'Chemistry' && (await page.locator('.crow').count()) === 2, 'new deck created with cards');
await page.goBack(); await page.waitForSelector('.deck, #pasteBox');
ok(!(await page.$('#pasteBox')), 'back from new deck does not reopen the finished import');

// Google Sheets bad link
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#pasteBox');
await page.click('#tab-sheet'); await page.fill('#sheetUrl', 'https://example.com/x'); await page.click('#sheetForm button');
ok(await page.isVisible('#loadErr'), 'bad sheets link shows error');
// a real public Google sheet (Google's own sample)
await page.fill('#sheetUrl', 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0');
await page.click('#sheetForm button');
await page.waitForFunction(() => document.querySelector('#found').textContent.includes('Found') || !document.querySelector('#loadErr').hidden, null, { timeout: 20000 });
console.log('   sheets:', await page.textContent('#found') || await page.textContent('#loadErr'));
await page.screenshot({ path: SP + '/i3-sheet.png' });

// save is blocked without a new deck name
await page.click('#tab-paste'); await page.fill('#pasteBox', 'a - b'); await page.waitForSelector('#preview:not([hidden])');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', ''); await page.click('#saveBtn');
ok(page.url().includes('#/import'), 'needs a deck name before saving');
await noHScroll('import with preview');
// a save that fails half way: toast, nothing saved (no empty deck), button usable again, and a retry works
const decksBefore = await page.evaluate(async () => (await (await import('./js/db.js')).getDecks()).length);
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Doomed');
await page.evaluate(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...a) { if (this.name === 'cards') throw new Error('failing on purpose'); return window.__put.apply(this, a); }; });
await page.click('#saveBtn');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes("Couldn't add the cards"));
const decksAfter = await page.evaluate(async () => (await (await import('./js/db.js')).getDecks()).length);
ok(decksAfter === decksBefore && !(await page.isDisabled('#saveBtn')) && page.url().includes('#/import'), 'failed import saves nothing (no empty deck), keeps the screen and re-enables the button');
await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
await page.click('#saveBtn'); await page.waitForSelector('.crow');
ok((await page.evaluate(async () => (await (await import('./js/db.js')).getDecks()).length)) === decksBefore + 1, 'retry saves one deck');
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
