// Re-importing an Anki deck updates the cards you already have (matched by the note's guid and the card's place in the note) instead of
// making a second set. Imports a made-up deck, reviews a card, imports a changed version of it, and checks: no duplicates, new content,
// progress and deck kept, new notes added, pictures stored once, an unchanged card left alone, and the switch off = a second set.
// Also takes the preview screenshots (light and dark, phone width) into <out>/guid-shots when GUID_SHOTS names a folder.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const SHOTS = process.env.GUID_SHOTS;

const everything = () => page.evaluate(async () => {
  const db = await import('./js/db.js');
  return { cards: (await db.getAll('cards')).filter(c => c.ankiGuid),   // (the app starts with a sample deck: only the imported cards are looked at)
    states: await db.getAll('cardStates'), logs: await db.getAll('reviewLog'), media: await db.mediaKeys(), decks: await db.getDecks() };
});
const openImport = async file => {
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
};

// ---- 1. the first import ----
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await openImport('anki-update-v1.apkg');
ok(!(await page.isVisible('#updRow')), 'a first import has nothing to update: no switch');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Update test'); await page.click('#saveBtn'); await page.waitForSelector('.crow');
let d = await everything();
const deck = d.decks.find(x => x.name === 'Update test');
ok(d.cards.length === 6 && d.cards.every(c => c.ankiGuid), `first import: 6 cards, all with their Anki guid (${d.cards.length})`);
ok(d.media.length === 1, 'the picture is stored once');

// ---- 2. review a card ----
await page.goto('http://localhost:8123/#/review/' + deck.id); await page.waitForSelector('#flash');
await page.click('#flash'); await page.waitForSelector('.rate[data-rate="3"]'); await page.click('.rate[data-rate="3"]');
await page.waitForFunction(async () => (await (await import('./js/db.js')).getAll('cardStates')).length > 0);
d = await everything();
const reviewed = d.cards.find(c => c.id === d.states[0].cardId);
const before = { id: reviewed.id, front: reviewed.front, state: d.states[0], logs: d.logs.filter(l => l.cardId === reviewed.id).length };
ok(before.logs === 1 && before.state.reps === 1, `reviewed one card once ("${before.front}")`);
const decksBefore = d.decks.length;
const betaBefore = d.cards.find(c => c.front === 'Beta');

// ---- 3. the changed deck: the preview ----
await openImport('anki-update-v2.apkg');
await page.selectOption('#deckSel', deck.id);
await page.waitForSelector('#updRow:not([hidden])');
const title = await page.textContent('#updTitle');
ok(title === 'Update 6 cards you already have (keeps your progress)', 'switch says how many: ' + title);
ok(await page.isChecked('#updateOld'), 'the switch is on by default');
ok((await page.textContent('#found')).includes('6 cards you already have will be updated'), 'the summary says so too');
ok((await page.locator('.prow .badge:not([hidden])', { hasText: 'Updates the card you already have' }).count()) === 5, 'five rows are marked as updates (Gamma\'s one row covers its two cards)');
ok(!(await page.locator('#dupBtn').isVisible()), 'rows being updated are not flagged as duplicates');
if (SHOTS) {
  await page.evaluate(async () => (await import('./js/ui.js')).dismissToast?.('Added 6 cards to Update test'));
  await page.evaluate(() => document.querySelector('#updRow').scrollIntoView({ block: 'center' }));
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(250);
  await page.screenshot({ path: SHOTS + '/import-preview-light.png' });
  await page.evaluate(() => document.querySelector('#updRow').scrollIntoView({ block: 'center' }));
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250);
  await page.screenshot({ path: SHOTS + '/import-preview-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
}
ok((await page.textContent('#saveBtn')) === 'Update 6, add 2 cards to “Update test”', 'the button says what will happen: ' + await page.textContent('#saveBtn'));
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
await page.click('#saveBtn'); await page.waitForSelector('.crow');
const toast = await page.textContent('#toast');
ok(toast.includes('Updated 5 cards') && toast.includes('progress kept') && toast.includes('already up to date') && toast.includes('added 2 cards'), 'toast: ' + toast);

// ---- 4. what changed ----
d = await everything();
const fronts = d.cards.map(c => c.front);
ok(d.cards.length === 8, `8 cards in all: the 6 updated, Epsilon and the new blank (${d.cards.length})`);
ok(new Set(d.cards.map(c => c.id)).size === 8 && d.decks.length === decksBefore, 'no second set, no extra deck');
const alpha = d.cards.find(c => c.front === 'Alpha (revised)');
ok(alpha && alpha.back.startsWith('first letter, updated'), 'Alpha has its new text');
ok(!fronts.includes('Alpha'), 'the old Alpha is gone (not duplicated)');
const kept = d.cards.find(c => c.id === before.id);
ok(kept && kept.deckId === deck.id, 'the reviewed card keeps its id and deck');
const st = d.states.find(s => s.cardId === before.id);
ok(st && st.reps === before.state.reps && st.due === before.state.due && st.stability === before.state.stability, 'its schedule is untouched');
ok(d.logs.filter(l => l.cardId === before.id).length === before.logs, 'its review history is untouched');
ok(d.states.length === 1 && d.logs.length === 1, 'no history was replayed onto other cards');
ok(alpha.updatedAt > betaBefore.updatedAt, 'an updated card is stamped for sync (updatedAt moved)');
const beta = d.cards.find(c => c.front === 'Beta');
ok(beta.id === betaBefore.id && beta.updatedAt === betaBefore.updatedAt, 'Beta (unchanged) was not rewritten');
const gamma = d.cards.filter(c => c.ankiGuid === 'gGamma');
const fwd = gamma.find(c => !c.reverse), rev = gamma.find(c => c.reverse);
ok(gamma.length === 2 && fwd.front === 'Gamma!' && rev.back === 'Gamma!' && rev.front === 'third letter' && fwd.noteId && fwd.noteId === rev.noteId, 'both cards of the reversed note updated and still a pair');
const heart = d.cards.filter(c => c.ankiGuid === 'gHeart').sort((a, b) => a.cloze - b.cloze);
ok(heart.length === 3 && heart.map(c => c.cloze).join() === '1,2,3' && new Set(heart.map(c => c.noteId)).size === 1 && heart.every(c => c.noteText.includes('lung')), 'cloze: three blanks, one note, new text');
ok(heart[2].front.includes('[…]') && heart[0].noteExtra === 'Organ', 'the new blank is made from the new text; the note extra is replaced');
ok(d.cards.some(c => c.front === 'Epsilon' && c.deckId === deck.id), 'the new note came in as a new card');
ok(d.media.length === 1 && alpha.backImage && d.cards.find(c => c.id === alpha.id).backImage === alpha.backImage, `the picture is still stored once (${d.media.length})`);

// ---- 5. the same file again: nothing to change ----
const stamp = Object.fromEntries(d.cards.map(c => [c.id, c.updatedAt]));
await openImport('anki-update-v2.apkg');
await page.selectOption('#deckSel', deck.id);
await page.waitForSelector('#updRow:not([hidden])');
ok((await page.textContent('#updTitle')).startsWith('Update 8 cards'), 'second time: all 8 match');
await page.click('#saveBtn'); await page.waitForSelector('.crow');
const toast2 = await page.textContent('#toast');
ok(toast2.includes('8 cards were already up to date') && !toast2.includes('Updated'), 'toast: ' + toast2);
d = await everything();
ok(d.cards.length === 8 && d.cards.every(c => c.updatedAt === stamp[c.id]) && d.media.length === 1, 'nothing was written again and no picture was added');

// ---- 6. switch off: as before ----
await openImport('anki-update-v2.apkg');
await page.selectOption('#deckSel', deck.id);
await page.waitForSelector('#updRow:not([hidden])');
await page.click('#updateOld');
ok(!(await page.isChecked('#updateOld')) && !(await page.textContent('#found')).includes('already have will be updated'), 'switch off: the summary stops promising updates');
await page.click('#saveBtn'); await page.waitForSelector('.crow');
d = await everything();
ok(d.cards.length === 16, `switch off: a second full set comes in (${d.cards.length})`);

// ---- 7. a deck saved the old way (before 4.54, only a multi-card note's first card, no templateOrd): the re-import relinks it ----
await openImport('anki-multicard-legacy.apkg');
await page.waitForSelector('#preview[data-guids]');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Multi'); await page.click('#saveBtn'); await page.waitForSelector('.crow');
const oldWay = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const inu = (await db.getAll('cards')).filter(c => c.front.startsWith('inu') || c.front === 'dog');
  const first = inu.find(c => c.templateOrd === 0), second = inu.find(c => c.templateOrd === 1);
  const { templateOrd, noteId, ...plain } = first;
  await db.put('cards', plain);               // as an older version saved it
  await db.deleteCards([second.id]);          // and it had no second card
  return { id: first.id, guid: first.ankiGuid, total: (await db.getAll('cards')).filter(c => c.ankiGuid && c.deckId === first.deckId).length };
});
ok(oldWay.total === 6, 'set up: the deck now looks like an old import (6 of its 7 cards, inu with only its plain first card)');
await openImport('anki-multicard-legacy.apkg');
await page.selectOption('#deckSel', await page.evaluate(async id => (await (await import('./js/db.js')).get('cards', id)).deckId, oldWay.id));
await page.waitForSelector('#updRow:not([hidden])');
ok((await page.textContent('#updTitle')).startsWith('Update 6 cards'), 'the plain first card matches its template-0 card: ' + await page.textContent('#updTitle'));
await page.click('#saveBtn'); await page.waitForSelector('.crow');
const relinked = await page.evaluate(async o => {
  const db = await import('./js/db.js');
  const all = await db.getAll('cards');
  const mine = all.filter(c => c.ankiGuid === o.guid);
  return { mine: mine.map(c => ({ id: c.id, ord: c.templateOrd, noteId: c.noteId })), deckCards: (await db.getAll('cards')).filter(c => c.deckId === (all.find(x => x.id === o.id)).deckId).length };
}, oldWay);
const kept0 = relinked.mine.find(c => c.id === oldWay.id);
ok(relinked.mine.length === 2 && kept0?.ord === 0 && relinked.mine.find(c => c.ord === 1) && kept0.noteId && relinked.mine.every(c => c.noteId === kept0.noteId), 'inu: the old card is now template 0 (same id) and sits in one note with the newly added template 1 card');
ok(relinked.deckCards === 7, 'the deck is back to 7 cards, no duplicates (' + relinked.deckCards + ')');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
