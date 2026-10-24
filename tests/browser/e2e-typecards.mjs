// Typing cards: a card's own Answer by (typeIn), a deck's Type the answers, Review asking for the right cards, the editor field, the bulk
// Answer by… action, the Browse filter and badge, Anki import ({{type:…}}) and export, and the Today note.
// Run with: node tests/browser/run.mjs typecards
import fs from 'node:fs';
import { chromium, deckMenu, sheetSettled } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const ctx = await browser.newContext({ viewport: { width: 375, height: 760 }, serviceWorkers: 'block', isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.stack));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
const run = (fn, arg) => page.evaluate(fn, arg);
const noHScroll = async w => ok(await run(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const cardsIn = name => run(async n => {
  const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === n);
  return (await db.getCardsInDeck(d.id)).sort((a, b) => a.created - b.created);
}, name);
const card = id => run(async i => (await import('./js/db.js')).get('cards', i), id);
const closeSheet = async () => { await page.waitForTimeout(500); await page.evaluate(() => { const s = document.getElementById('sheet'); if (s?.open) s.close(); }); await sheetSettled(page); };      // (the sheet's history entry goes a moment later: wait, or it undoes the next navigation)
const toast = () => page.textContent('#toast');
const LONG60 = 'abcdefghij'.repeat(6);

// ---------- seed: one deck with every kind of card, and a picture ----------
await run(async LONG => {
  const db = await import('./js/db.js'), occ = await import('./js/occlusion.js'), cl = await import('./js/cloze.js'), media = await import('./js/media.js');
  const c = document.createElement('canvas'); c.width = 300; c.height = 200;
  const g = c.getContext('2d'); g.fillStyle = '#fda085'; g.fillRect(0, 0, 300, 200);
  const file = new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'heart.png', { type: 'image/png' });
  const info = await media.addImageInfo(file, { maxSide: media.OCCLUSION_SIDE });
  await db.saveDeck({ id: 'tc', name: 'Typing', color: '#8b5cf6', parentId: '', created: Date.now() });
  const basic = (id, front, back, extra, i) => ({ id, deckId: 'tc', front, back, tags: [], created: 1000 + i, ...extra });
  await db.saveCards([
    basic('b1', 'Short typed', 'Paris', { typeIn: true }, 1),
    basic('b2', 'Long typed', LONG, { typeIn: true }, 2),
    basic('b3', 'Unset short', 'Rome', {}, 3),
    basic('b4', 'Flip me', 'Madrid', { typeIn: false }, 4),
    basic('b5', 'Elements typed', 'Element 1: red\nElement 2: blue', { typeIn: true }, 5),
    basic('b6', 'Half', '$\\frac{1}{2}$', { typeIn: true }, 6),
    basic('b7', 'Colour', 'red / scarlet', { typeIn: true }, 7)]);
  const nid = db.newId();
  await db.saveNote(cl.planNoteSave([], 'The {{c1::heart}} pumps {{c1::blood}}'), { deckId: 'tc', noteId: nid, tags: [], typeIn: true });
  for (const [header, label] of [['Labelled pic', 'Aorta'], ['Unlabelled pic', '']]) {
    const masks = [{ id: 'm1', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.2, h: 0.1, ...(label ? { label } : {}) }];
    await db.saveNote(occ.planOcclusionSave([], { masks, header, w: info.width, h: info.height, image: info.id }), { deckId: 'tc', noteId: db.newId(), tags: [], typeIn: true });
  }
  await db.setSetting('reviewTyping', false);
}, LONG60);

// ---------- 1. Review ----------
await run(() => { location.hash = '#/review/tc'; });
await page.waitForSelector('#flash');
const seen = new Map();
const keyOf = async () => (await page.textContent('.rv-front .flash-front')).replace(/\s+/g, ' ');
for (let i = 0; i < 10; i++) {
  await page.waitForSelector('#flash:not([data-rated])');
  const key = await keyOf();
  const hasBox = await page.locator('#typeIn').count() === 1;
  const note = (await page.locator('#longNote').count()) ? await page.textContent('#longNote') : '';
  const name = ['Short typed', 'Long typed', 'Unset short', 'Flip me', 'Elements typed', 'Half', 'Colour', 'pumps', 'Labelled pic', 'Unlabelled pic'].find(n => key.includes(n) && !(n === 'Labelled pic' && key.includes('Unlabelled')));
  seen.set(name, { hasBox, note });
  let rating = '3';
  if (name === 'Short typed') {
    await page.fill('#typeIn', 'Parxx'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed.no');
    ok(await page.locator('.rv-typed mark.d-wrong, .rv-typed ins, .rv-typed del').count() >= 1, 'Review: a wrong typed answer shows letter marks after the reveal');
  } else if (name === 'Long typed') {
    await page.fill('#typeIn', LONG60.slice(0, 59) + 'x'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed.ok');
  } else if (name === 'Half') {
    await page.fill('#typeIn', '2'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed');
    seen.get('Half').wrongTwo = await page.locator('.rv-typed .typed.no').count() === 1;
  } else if (name === 'Colour') {
    await page.fill('#typeIn', 'scarlet'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed.ok');
  } else if (name === 'pumps') {
    await page.fill('#typeIn', 'heart, blood'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed.ok');
  } else if (name === 'Labelled pic') {
    await page.fill('#typeIn', 'aorta'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed.ok');
  } else await page.keyboard.press('Space');
  await page.evaluate(() => { document.getElementById('flash').dataset.rated = '1'; });
  await page.keyboard.press(rating);
  if (i < 9) await page.waitForSelector('#flash:not([data-rated])', { timeout: 8000 }).catch(() => {});
}
const want = { 'Short typed': [true, ''], 'Long typed': [true, ''], 'Unset short': [false, ''], 'Flip me': [false, ''], 'Elements typed': [false, ''], 'Half': [true, ''],
  'Colour': [true, ''], 'pumps': [true, ''], 'Labelled pic': [true, ''], 'Unlabelled pic': [false, ''] };      // (no flip note under the card any more)
for (const [n, [box, note]] of Object.entries(want)) {
  const s = seen.get(n);
  ok(!!s && s.hasBox === box && s.note.startsWith(note) && (note || !s.note), `Review (Today switch off): "${n}" ${box ? 'asks for a typed answer' : 'flips'}${note ? ' with the note "' + note + '"' : ' with no note'}${s ? '' : ' (never shown)'}`);
}
ok(seen.get('Half')?.wrongTwo === true, 'Review: typing just "2" for 1/2 is wrong (a / between digits does not split the answer)');
const log = await run(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.cardId === 'b1'));
ok(log.length === 1 && log[0].rating === 3 && log[0].mode === 'typing', 'Review: Good picked over the suggested Again is saved as rating 3 with mode typing: ' + JSON.stringify(log.map(l => [l.rating, l.mode])));
await run(() => { location.hash = '#/decks'; });
await page.waitForSelector('.deck');

// the Today switch only adds cards: a card set to Flipping the card still flips; an unset short card now types
await run(async () => {
  const db = await import('./js/db.js');
  await db.saveDeck({ id: 'tc2', name: 'Switch', color: '#8b5cf6', parentId: '', created: Date.now() });
  await db.saveCards([{ id: 's1', deckId: 'tc2', front: 'Unset one', back: 'Rome', tags: [], created: 1 }, { id: 's2', deckId: 'tc2', front: 'Flipped two', back: 'Madrid', typeIn: false, tags: [], created: 2 }]);
  await db.setSetting('reviewTyping', true);
});
await run(() => { location.hash = '#/review/tc2'; });
const sw = {};
for (let i = 0; i < 2; i++) {
  await page.waitForSelector('#flash:not([data-rated])');
  const k = await keyOf();
  sw[k.includes('Unset') ? 'unset' : 'flip'] = await page.locator('#typeIn').count() === 1;
  if (await page.locator('#typeIn').count()) { await page.fill('#typeIn', 'Rome'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed'); } else await page.keyboard.press('Space');
  await page.evaluate(() => { document.getElementById('flash').dataset.rated = '1'; });
  await page.keyboard.press('3');
  if (i === 0) await page.waitForSelector('#flash:not([data-rated])');
}
ok(sw.unset === true && sw.flip === false, 'Review (Today switch on): an unset short card types, a card set to Flipping still flips');
await run(async () => { await (await import('./js/db.js')).setSetting('reviewTyping', false); });

// ---------- 2. the deck's Type the answers ----------
await run(async LONG => {
  const db = await import('./js/db.js');
  await db.saveDeck({ id: 'par', name: 'Parent', color: '#8b5cf6', parentId: '', created: Date.now() });
  await db.saveDeck({ id: 'kid', name: 'Child', color: '#8b5cf6', parentId: 'par', created: Date.now() + 1 });
  await db.saveCards([{ id: 'k1', deckId: 'kid', front: 'Kid short', back: 'Oslo', tags: [], created: 1 }, { id: 'k2', deckId: 'kid', front: 'Kid long', back: LONG, tags: [], created: 2 }]);
}, LONG60);
await page.goto(APP + '#/deck/par'); await page.waitForSelector('#deckMore'); await deckMenu(page); await page.click('#editDeck'); await page.waitForSelector('#deckTypeIn');
ok(!(await page.isChecked('#deckTypeIn')) && (await page.textContent('#deckForm')).includes('Type the answers'), 'Deck editor: the Type the answers switch is there, and off');
await noHScroll('deck editor');
await page.screenshot({ path: SP + '/typecards-deck-375.png' });
await page.click('#deckTypeIn', { force: true });
await page.click('button[type=submit][form=deckForm]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Deck saved'));
let decks = await run(async () => { const db = await import('./js/db.js'); const dt = await import('./js/deck-tree.js'); const ds = await db.getDecks(); return { par: ds.find(d => d.id === 'par').typeAnswers, kid: ds.find(d => d.id === 'kid').typeAnswers ?? null, eff: dt.effectiveDeck(ds, 'kid').typeAnswers }; });
ok(decks.par === true && decks.eff === true, 'Deck editor: saving stores typeAnswers on the deck and the subdeck inherits it: ' + JSON.stringify(decks));
await closeSheet();
await page.goto(APP + '#/deck/kid'); await page.waitForSelector('#deckMore'); await deckMenu(page); await page.click('#editDeck'); await page.waitForSelector('#deckTypeIn');
ok(await page.isChecked('#deckTypeIn'), 'Deck editor: the subdeck shows the switch on (inherited)');
await closeSheet();
await run(() => { location.hash = '#/review/kid'; });
const kidSeen = {};
for (let i = 0; i < 2; i++) {
  await page.waitForSelector('#flash:not([data-rated])');
  const k = await keyOf();
  const n = k.includes('short') ? 'short' : 'long';
  kidSeen[n] = { box: await page.locator('#typeIn').count() === 1, note: (await page.locator('#longNote').count()) ? await page.textContent('#longNote') : '' };
  if (kidSeen[n].box) { await page.fill('#typeIn', 'Oslo'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed'); } else await page.keyboard.press('Space');
  await page.evaluate(() => { document.getElementById('flash').dataset.rated = '1'; });
  await page.keyboard.press('3');
  if (i === 0) await page.waitForSelector('#flash:not([data-rated])');
}
ok(kidSeen.short?.box === true, 'Deck default: an unset short card in the subdeck types');
ok(kidSeen.long?.box === false && kidSeen.long.note === '', 'Deck default: an unset long card flips, with no note under it');
// turning it off again
await page.goto(APP + '#/deck/par'); await deckMenu(page); await page.click('#editDeck'); await page.waitForSelector('#deckTypeIn');
await page.click('#deckTypeIn', { force: true }); await page.click('button[type=submit][form=deckForm]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Deck saved'));
decks = await run(async () => { const db = await import('./js/db.js'); const ds = await db.getDecks(); return ds.find(d => d.id === 'par').typeAnswers; });
ok(decks === null, 'Deck editor: switching it off again stores nothing (null)');
await closeSheet();

// ---------- 3. the card editor ----------
await run(async LONG => {
  const db = await import('./js/db.js'), cl = await import('./js/cloze.js');
  await db.saveDeck({ id: 'ed', name: 'Editing', color: '#8b5cf6', parentId: '', created: Date.now() });
  await db.saveCards([{ id: 'e1', deckId: 'ed', front: 'Edit one', back: 'Berlin', tags: [], created: 1 }, { id: 'e2', deckId: 'ed', front: 'Edit long', back: LONG, tags: [], created: 2 },
    { id: 'e3', deckId: 'ed', front: 'Edit steps', back: 'Step 1: add\nStep 2: divide', tags: [], created: 3 }]);
  await db.saveNote(cl.planNoteSave([], 'The {{c1::heart}} pumps {{c2::blood}}'), { deckId: 'ed', noteId: 'edn', tags: [] });
}, LONG60);
await page.goto(APP + '#/deck/ed'); await page.waitForSelector('.crow');
const open = async text => { await page.locator('.crow', { hasText: text }).first().click(); await page.waitForSelector('#ceForm'); };
await open('Edit one');
ok(await page.isVisible('#ceTypeIn') && (await page.locator('#ceTypeIn option').allTextContents()).join('|') === 'Same as the deck (flipping)|Typing the answer|Flipping the card', 'Edit form: Answer by with its three choices');
ok((await page.inputValue('#ceTypeIn')) === '' && !(await page.isVisible('#ceTypeNote')), 'Edit form: starts on "Same as the deck", no note');
await noHScroll('edit form');
await page.screenshot({ path: SP + '/typecards-edit-375.png' });
await page.selectOption('#ceTypeIn', '1'); await page.click('button[type=submit][form=ceForm]'); await page.waitForTimeout(700);
ok((await card('e1')).typeIn === true, 'Edit form: Typing the answer saves typeIn: true');
await page.waitForSelector('#ceForm'); await page.waitForTimeout(300);
ok((await page.inputValue('#ceTypeIn')) === '1', 'Edit form: and reopens on it');
await page.selectOption('#ceTypeIn', ''); await page.click('button[type=submit][form=ceForm]'); await page.waitForTimeout(700);
ok(!('typeIn' in (await card('e1'))), 'Edit form: back to Same as the deck removes the field');
await page.selectOption('#ceTypeIn', '0'); await page.click('button[type=submit][form=ceForm]'); await page.waitForTimeout(700);
ok((await card('e1')).typeIn === false, 'Edit form: Flipping the card saves typeIn: false');
await closeSheet();
await open('Edit long');
await page.selectOption('#ceTypeIn', '1');
ok((await page.textContent('#ceTypeNote')).includes("Long answer: you'll type all of it. Typing works best for a word or a short phrase."), 'Edit form: a 60-character answer gets the long-answer note');
await page.fill('#ceBack', 'x'.repeat(501));
ok((await page.textContent('#ceTypeNote')).includes('Too long to type: Review will flip this card.'), 'Edit form: over 500 characters, the note says Review will flip it');
await closeSheet(); await page.waitForTimeout(300);
await open('Edit steps');
ok(await page.isDisabled('#ceTypeIn') && (await page.textContent('#ceTypeNote')).includes('Step-by-step and elements cards are always flipped.'), 'Edit form: a steps card has the choice off, with the reason');
await closeSheet(); await page.waitForTimeout(300);
// cloze note: the whole note
await open('pumps');
ok((await page.textContent('#ceTypeNote')).includes('You type the hidden words'), 'Edit form: a cloze note explains what is typed');
await page.selectOption('#ceTypeIn', '1'); await page.click('button[type=submit][form=ceForm]'); await page.waitForTimeout(700);
let sibs = (await cardsIn('Editing')).filter(c => c.noteId === 'edn');
ok(sibs.length === 2 && sibs.every(c => c.typeIn === true), 'Edit form: a cloze note sets every one of its cards');
await page.waitForSelector('#ceForm'); await page.waitForTimeout(300);
await page.fill('#ceText', 'The {{c1::heart}} pumps {{c2::blood}} to the {{c3::body}}');
await page.click('button[type=submit][form=ceForm]');
await page.waitForFunction(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.noteId === 'edn').length === 3, null, { timeout: 8000 }).catch(() => {});
sibs = (await cardsIn('Editing')).filter(c => c.noteId === 'edn');
ok(sibs.length === 3 && sibs.every(c => c.typeIn === true), 'Edit form: a blank added later picks the note\'s setting up');
await closeSheet();

// ---------- 4. the Add form ----------
await run(async () => {
  const db = await import('./js/db.js');
  await db.saveDeck({ id: 'dd', name: 'Default on', color: '#8b5cf6', parentId: '', created: Date.now() + 5, typeAnswers: true });
  await db.saveDeck({ id: 'dn', name: 'Default off', color: '#8b5cf6', parentId: '', created: Date.now() + 6 });
  await db.saveCards([{ id: 'x1', deckId: 'dd', front: 'x', back: 'y', tags: [], created: 1 }, { id: 'x2', deckId: 'dn', front: 'x', back: 'y', tags: [], created: 1 }]);
});
await page.goto(APP + '#/browse'); await page.waitForSelector('.crow');
await page.click('#brAdd'); await page.waitForSelector('#acForm');
await page.selectOption('#acDeck', 'dd');
ok((await page.locator('#acTypeIn option').first().textContent()) === 'Same as the deck (typing)', 'Add form: the first option names the deck\'s way (typing)');
await page.selectOption('#acDeck', 'dn');
ok((await page.locator('#acTypeIn option').first().textContent()) === 'Same as the deck (flipping)', 'Add form: and follows the deck picker (flipping)');
await page.fill('#acFront', 'Pair front'); await page.fill('#acBack', 'Pair back');
await page.selectOption('#acTypeIn', '1');
await page.click('#acRevRow');
ok((await page.textContent('#acTypeNote')).includes('Applies to this direction only.'), 'Add form: with Both directions on, the note says it applies to this direction only');
await page.click('button[type=submit][form=acForm]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Added 2 cards'));
const pair = (await cardsIn('Default off')).filter(c => c.noteId);
ok(pair.length === 2 && pair.find(c => !c.reverse).typeIn === true && !('typeIn' in pair.find(c => c.reverse)), 'Add form: Typing + Both directions: the forward card types, the reverse card has no typeIn');
ok((await page.inputValue('#acTypeIn')) === '1', 'Add form: the choice stays for the next card');
await page.fill('#acFront', 'Plain typed'); await page.fill('#acBack', 'Plain answer'); await page.selectOption('#acTypeIn', '0');
await page.click('#acRevRow');
await page.click('button[type=submit][form=acForm]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Card added'));
ok((await cardsIn('Default off')).find(c => c.front === 'Plain typed')?.typeIn === false, 'Add form: Flipping the card is saved as typeIn: false');
await page.selectOption('#acTypeIn', '');
await page.fill('#acFront', 'Plain default'); await page.fill('#acBack', 'Another'); await page.click('button[type=submit][form=acForm]');
await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Card added'));
ok(!('typeIn' in (await cardsIn('Default off')).find(c => c.front === 'Plain default')), 'Add form: Same as the deck stores nothing');
await page.click('#acDone');

// ---------- 5. Browse: filter, badge and the bulk action ----------
const selectOnly = async texts => {
  if ((await page.textContent('#brSelect')).trim() === 'Cancel') await page.click('#brSelect');
  await page.click('#brSelect');
  for (const t of texts) await page.locator('.crow', { hasText: t }).first().click();
};
await page.goto(APP + '#/deck/ed'); await page.waitForSelector('.crow');
await page.selectOption('#brFilter', 'typing');
await page.waitForFunction(() => document.querySelectorAll('.crow').length === 3);
ok((await page.locator('.crow .type-mark').count()) === 3 && (await page.locator('#brFilter optgroup[label=Answer]').count()) === 1, 'Browse: the Typing cards filter lists the 3 cloze cards, each with the keyboard badge');
ok(((await page.locator('.crow .crow-btn').first().getAttribute('aria-label')) || '').includes('Typing card.'), 'Browse: the row\'s spoken name says Typing card');
await page.selectOption('#brFilter', 'all');
await page.waitForFunction(() => document.querySelectorAll('.crow').length === 6);
ok((await page.locator('.crow .type-mark').count()) === 3, 'Browse: only typing cards carry the badge');
await noHScroll('browse');
// bulk: two basic cards and one cloze card
await selectOnly(['Edit one', 'Edit long', 'heart']);
await page.click('#brActions'); await page.waitForSelector('[data-act=typing]');
await page.click('[data-act=typing]'); await page.waitForSelector('[data-type-in="1"]');
ok((await page.textContent('#ceConfirm')).includes('How should Review ask these 3 cards?'), 'Bulk: Answer by… asks how Review should ask these 3 cards');
await page.screenshot({ path: SP + '/typecards-bulk-375.png' });
await page.click('[data-type-in="1"]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('set to typing'));
const t1 = await toast();
const afterBulk = await cardsIn('Editing');
ok(t1.includes('set to typing') && afterBulk.filter(c => c.typeIn === true).length === 5 && afterBulk.find(c => c.id === 'e1').typeIn === true, 'Bulk: Typing the answer set the two basic cards (the cloze note was already typing): ' + t1);
await page.waitForSelector('.crow');
// flipping and "same as the deck", with a cloze card in the selection: all 3 siblings change
await selectOnly(['heart']);
await page.click('#brActions'); await page.click('[data-act=typing]'); await page.waitForSelector('[data-type-in="0"]');
await page.click('[data-type-in="0"]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('set to flipping'));
const t0 = await toast();
const flipped = (await cardsIn('Editing')).filter(c => c.noteId === 'edn');
ok(flipped.length === 3 && flipped.every(c => c.typeIn === false) && t0.startsWith('3 cards set to flipping'), 'Bulk: Flipping the card on one cloze card changes all 3 cards of its note: ' + t0);
await page.waitForSelector('.crow');
await selectOnly(['heart']);
await page.click('#brActions'); await page.click('[data-act=typing]'); await page.waitForSelector('[data-type-in=""]');
await page.click('[data-type-in=""]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('now follow their deck'));
ok((await cardsIn('Editing')).filter(c => c.noteId === 'edn').every(c => !('typeIn' in c)), 'Bulk: Same as the deck removes the field from the whole note: ' + await toast());
// a steps card is skipped when typing is set
await page.waitForSelector('.crow');
await selectOnly(['Edit steps', 'Edit one']);
await page.click('#brActions'); await page.click('[data-act=typing]'); await page.waitForSelector('[data-type-in="1"]');
await page.click('[data-type-in="1"]'); await page.waitForFunction(() => /always flipped|Nothing to change/.test(document.getElementById('toast')?.textContent || ''));
ok((await toast()).includes('1 step-by-step or elements card is always flipped') && !('typeIn' in (await card('e3'))), 'Bulk: typing skips a step-by-step card and says so: ' + await toast());

// ---------- 6. Today ----------
await page.goto(APP + '#/today'); await page.waitForSelector('.tdeck');
await page.click('#optBtn, [data-opts], button:has-text("Options")').catch(() => {});
await page.waitForSelector('#modeChips', { timeout: 5000 }).catch(() => {});
if (await page.locator('#modeChips').count()) {
  const t = await page.textContent('#sheet');
  ok(await page.locator('#modeChips [data-typing]').count() === 2 && !t.includes('40 characters or less'), 'Today: Answer by offers the two choices, with no note');
  await closeSheet();
} else ok(false, 'Today: could not open the options sheet');

// ---------- 7. importing Anki typing cards ----------
const load = async (file, timeout = 30000) => {
  await sheetSettled(page);      // (a sheet that just closed, like the export one, takes its history entry off a moment later)
  await page.goto(APP + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout });
  await page.waitForSelector('#preview[data-guids]'); if (await page.isVisible('#updRow')) await page.click('#updateOld');          // (the same notes are imported more than once on purpose: as new cards each time)
  await page.selectOption('#deckSel', '__new');
};
for (const [file, name] of [['anki-typein-new.apkg', 'Typein new'], ['anki-typein-legacy.apkg', 'Typein old']]) {
  await load(file, name === 'Typein new' ? 90000 : 30000);      // (the first Anki file also downloads sql.js from the CDN)
  await page.fill('#newName', name); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
  const cs = await cardsIn(name);
  const by = f => cs.filter(c => c.front === f);
  ok(by('Capital of France')[0]?.typeIn === true, `${file}: "Basic (type in the answer)" imports as a typing card`);
  const heart = cs.filter(c => c.cloze);
  ok(heart.length === 2 && heart.every(c => c.typeIn === true), `${file}: both cards of the cloze note with {{type:cloze:Text}} type`);
  const mf = by('Mitosis')[0], mr = by('Cell division')[0];
  ok(mf && mr && mr.reverse === true && !('typeIn' in mf) && mr.typeIn === true, `${file}: the reversed note's typed card 2 types, card 1 does not`);
  ok(!('typeIn' in by('Plain')[0]) && cs.length === 6, `${file}: a plain Basic note follows its deck (${cs.length} cards)`);
}

// ---------- 8. export, then import again ----------
const exportDeck = async (name, file) => {
  const id = await run(async n => (await (await import('./js/db.js')).getDecks()).find(d => d.name === n).id, name);
  await page.goto(APP + '#/deck/' + id); await page.waitForSelector('.crow');
  await deckMenu(page); await page.click('#exportDeck'); await page.waitForSelector('#exApkg');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exApkg')]);
  await dl.saveAs(SP + '/files/' + file);
};
await exportDeck('Typein new', 'typein-out.apkg');
await load('typein-out.apkg');
await page.fill('#newName', 'Typein round trip'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
{
  const cs = await cardsIn('Typein round trip');
  const by = f => cs.filter(c => c.front === f);
  ok(cs.length === 6 && by('Capital of France')[0]?.typeIn === true && cs.filter(c => c.cloze).every(c => c.typeIn === true), 'Export, then import: the typing card and the cloze note still type');
  ok(!('typeIn' in by('Mitosis')[0]) && by('Cell division')[0]?.typeIn === true && by('Cell division')[0]?.reverse === true, 'Export, then import: a pair keeps the typing on card 2 only');
  ok(!('typeIn' in by('Plain')[0]), 'Export, then import: an ordinary card stays ordinary');
}
// a deck default is written onto each short card, because Anki has no deck default
await run(async () => { const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === 'Typein new'); await db.saveDeck({ ...d, typeAnswers: true }); });
await exportDeck('Typein new', 'typein-out2.apkg');
await load('typein-out2.apkg');
await page.fill('#newName', 'Typein default'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
{
  const cs = await cardsIn('Typein default');
  ok(cs.find(c => c.front === 'Plain')?.typeIn === true && cs.find(c => c.front === 'Mitosis')?.typeIn === true, 'Export of a deck that types its answers: its short cards come back as typing cards');
}

// ---------- 9. the model is stored as it should be ----------
const shape = await run(async () => {
  const db = await import('./js/db.js'), t = await import('./js/type-in.js');
  const bad = { id: 'junk1', deckId: 'tc', front: 'j', back: 'k', tags: [], created: 5, typeIn: 'yes' };
  await db.saveCards([bad]);
  return t.cleanTypeIn(await db.get('cards', 'junk1')).typeIn ?? null;
});
ok(shape === null, 'a typeIn that is not a boolean is dropped by cleanTypeIn');

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
