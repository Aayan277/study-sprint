import { chromium } from './pw.mjs';
import fs from 'node:fs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('InvalidCharacterError')) errors.push('console ' + m.text()); });   // the bad-picture restore test logs one on purpose
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const count = name => page.evaluate(async n => (await (await import('./js/db.js')).getAll(n)).length, name);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// Starter decks
ok(!(await page.locator('.starter').first().isVisible()), 'starter decks are tucked away by default');
await page.click('#startersBox > summary');
ok((await page.locator('.starter').count()) === 2, 'two starter decks offered');
await page.screenshot({ path: SP + '/m7-starters.png', fullPage: true });
await page.click('[data-starter="jlpt-n5"]');
await page.waitForFunction(() => document.querySelectorAll('.deck').length === 2);
ok((await page.locator('.starter').count()) === 1, 'added N5 deck is no longer offered');
ok((await page.locator('.deck-name').nth(1).textContent()) === 'JLPT N5 Kanji' && (await page.locator('.deck-counts').nth(1).textContent()).includes('102'), 'N5 deck has 102 cards');
await page.locator('.deck-open').nth(1).click(); await page.waitForSelector('.crow');
ok((await page.locator('.crow .f').first().textContent()) === '一' && (await page.locator('.crow .b').first().textContent()) === 'one; いち / ひと(つ)', 'first card is 一 → one; いち / ひと(つ)');
// some review history so the backup has everything
await page.evaluate(async () => { const db = await import('./js/db.js'); const c = (await db.getAll('cards'))[0];
  await db.saveReview({ cardId: c.id, due: Date.now() + 86400000, stability: 3, difficulty: 5, reps: 1, lapses: 0, state: 2 }, { cardId: c.id, timestamp: Date.now(), source: 'review', correct: true, rating: 3, state: 0 }); });
await page.evaluate(async () => { const t = await import('./js/themes.js'); const db = await import('./js/db.js'); await db.setSetting('theme', { skin: 'sage', mode: 'dark', oled: false }); });   // an old theme name, written straight in
const before = { decks: await count('decks'), cards: await count('cards'), states: await count('cardStates'), logs: await count('reviewLog') };

// Export
await page.click('#gearBtn'); await page.waitForSelector('#exportBtn');
ok((await page.textContent('#screen')).includes('No backup yet'), 'settings says no backup yet');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
const file = SP + '/backup.json'; await dl.saveAs(file);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(/^study-sprint-backup-\d{4}-\d\d-\d\d\.json$/.test(dl.suggestedFilename()), 'backup file name: ' + dl.suggestedFilename());
ok(data.format === 'study-sprint-backup' && data.cards.length === before.cards && data.reviewLog.length === before.logs && data.cardStates.length === before.states && data.settings.theme.skin === 'sage', 'backup holds everything: ' + JSON.stringify(before));
await page.waitForFunction(() => document.querySelector('#screen').textContent.includes('Last backup'));
ok(true, 'settings shows the last backup date');
await page.screenshot({ path: SP + '/m7-settings.png', fullPage: true });

// Wipe, then restore
await page.click('#dangerZone > summary'); await page.click('#resetBtn'); await page.click('#rsYes'); await page.waitForSelector('.deck');
ok((await count('cards')) === 12, 'reset leaves just the sample deck');
await page.click('#gearBtn'); await page.waitForSelector('#importIn');
fs.writeFileSync(SP + '/not-backup.json', '{"hello":1}');
await page.setInputFiles('#importIn', SP + '/not-backup.json');
await page.waitForSelector('#toast:not([hidden])');
ok((await page.textContent('#toast')).includes("isn't a Study Sprint backup"), 'wrong file is refused');
await page.setInputFiles('#importIn', file); await page.waitForSelector('#rbYes');
ok((await page.textContent('#sheet')).includes(`${before.cards} cards`), 'restore asks first, with counts');
await page.screenshot({ path: SP + '/m7-restore.png' });
await page.click('#rbYes'); await page.waitForSelector('.deck');
const after = { decks: await count('decks'), cards: await count('cards'), states: await count('cardStates'), logs: await count('reviewLog') };
ok(JSON.stringify(after) === JSON.stringify(before), 'restore brings everything back: ' + JSON.stringify(after));
ok(await page.evaluate(() => document.documentElement.dataset.skin === 'forest' && document.documentElement.dataset.theme === 'dark'), 'restore brings the theme back');

// Restoring something deleted since the backup: its old delete marker goes too (or syncing would delete it again)
const deckId = await page.evaluate(async () => { const db = await import('./js/db.js'); const d = (await db.getDecks())[0]; await db.deleteDeck(d.id); return d.id; });
ok(await page.evaluate(async id => !!(await (await import('./js/db.js')).get('deleted', 'decks:' + id)), deckId), 'deleting a deck leaves a delete marker');
await page.click('#gearBtn'); await page.waitForSelector('#importIn');
await page.setInputFiles('#importIn', file); await page.waitForSelector('#rbYes'); await page.click('#rbYes'); await page.waitForSelector('.deck');
ok(await page.evaluate(async id => { const db = await import('./js/db.js'); return !(await db.get('deleted', 'decks:' + id)) && !!(await db.get('decks', id)); }, deckId), 'restore brings the deck back and removes its delete marker');

// A bad backup is refused or fails safely: the data stays as it was
await page.click('#gearBtn'); await page.waitForSelector('#importIn');
fs.writeFileSync(SP + '/bad-card.json', JSON.stringify({ ...data, cards: [{ deckId: 'x', front: 'no id' }, ...data.cards] }));
await page.setInputFiles('#importIn', SP + '/bad-card.json');
await page.waitForSelector('#toast:not([hidden])');
ok((await page.textContent('#toast')).includes('damaged'), 'a backup with a card that has no id is refused');
// Passes the checks, but the picture's bytes can't be read: the save fails half way and must change nothing
fs.writeFileSync(SP + '/bad-pic.json', JSON.stringify({ ...data, media: [{ id: 'm1', type: 'image/png', data: '!!!not base64!!!' }] }));
await page.setInputFiles('#importIn', SP + '/bad-pic.json'); await page.waitForSelector('#rbYes');
await page.click('#rbYes');
await page.waitForFunction(() => document.querySelector('#toast').textContent.includes("Couldn't restore"));
const afterBad = { decks: await count('decks'), cards: await count('cards'), states: await count('cardStates'), logs: await count('reviewLog') };
ok(JSON.stringify(afterBad) === JSON.stringify(before), 'failed restore leaves the data untouched: ' + JSON.stringify(afterBad));

// Backup file dropped into Import
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#pasteBox');
await page.click('#tab-file'); await page.setInputFiles('#fileIn', file);
await page.waitForSelector('#loadErr:not([hidden])');
ok((await page.textContent('#loadErr')).includes('Restore it from Settings'), 'Import points backup files to Settings → Restore');

// Play with the kanji deck: typing a reading counts
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
