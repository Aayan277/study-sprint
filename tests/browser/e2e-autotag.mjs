// Suggest tags for a deck (deck ⋯ menu → Suggest tags, and Browse → Tools). A mixed biology deck is pasted as "front - back" lines; the sheet is
// reviewed (rename, untick a tag, untick one card), closed with "Discard changes?", then tags are added and checked in IndexedDB; Undo; the same
// by keyboard; a phone-sized screen; a deck with no clear topics; a browser without workers; nothing leaves the page.
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const fixture = n => JSON.parse(fs.readFileSync(new URL(`../fixtures/autotag/${n}.json`, import.meta.url), 'utf8'));
const BIO = fixture('biology-mixed').cards.filter(c => !c.cloze && !c.reverse);
const LINES = BIO.map(c => `${c.front} - ${c.back}`).join('\n');
const browser = await chromium.launch();
const errors = [], requests = [];
let workers = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const watch = p => {
  p.on('pageerror', e => errors.push('pageerror ' + e.message + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
  p.on('worker', () => { workers++; });
  p.on('request', r => { const u = r.url(); if (!/^(http:\/\/localhost:8123|data:|blob:|about:)/.test(u)) requests.push(u); });
};
const open = async ({ w = 1000, h = 800, init = null } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: w < 600, hasTouch: w < 600 });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  watch(p);
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
  return p;
};
const cardsInDb = p => p.evaluate(async () => (await import('./js/db.js')).getAll('cards'));
const tagsById = async p => Object.fromEntries((await cardsInDb(p)).map(c => [c.id, [...(c.tags || [])]]));
const pasteDeck = async (p, name, lines) => {
  await p.evaluate(() => sessionStorage.removeItem('study-sprint-import-draft'));
  await p.goto('http://localhost:8123/#/import'); await p.waitForSelector('#pasteBox');
  await p.fill('#pasteBox', lines);
  await p.waitForSelector('#preview:not([hidden])');
  await p.selectOption('#deckSel', '__new'); await p.fill('#newName', name);
  await p.click('#saveBtn'); await p.waitForSelector('.crow');
};
const openSuggest = async p => { await p.click('#deckMore'); await p.click('#autoTag'); await p.waitForSelector('.tag-sugs li', { timeout: 30000 }); };
const noHScroll = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && (() => { const s = document.getElementById('sheet'); return !s || s.scrollWidth <= s.clientWidth + 1; })()), 'no sideways scroll: ' + what);
const addLabel = p => p.textContent('#atAdd');

// ---- 1. the deck, and the menu item ----
let p = await open();
await pasteDeck(p, 'Biology', LINES);
const n0 = (await cardsInDb(p)).length;
ok(n0 >= BIO.length, `the pasted deck made ${BIO.length} cards (${n0} with the sample deck)`);
// some cards already have a tag
await p.evaluate(async () => { const db = await import('./js/db.js'); const all = await db.getAll('cards'); await db.saveCards(all.filter((_, i) => i % 6 === 0).map(c => ({ ...c, tags: ['week1'] }))); });
const week1 = Object.entries(await tagsById(p)).filter(([, t]) => t.includes('week1')).map(([id]) => id);
const original = await tagsById(p);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await p.click('.deck-open'); await p.waitForSelector('.crow');
await p.click('#deckMore');
ok(await p.isVisible('#autoTag') && (await p.textContent('#autoTag')).includes('Suggest tags') && await p.getAttribute('#autoTag', 'role') === 'menuitem', 'the ⋯ menu has Suggest tags');
await p.keyboard.press('Escape');

// ---- 2. the sheet ----
await p.click('#deckMore'); await p.click('#autoTag');
await p.waitForSelector('#atProg, .tag-sugs li');
await p.waitForSelector('.tag-sugs li', { timeout: 30000 });
const rows = p.locator('.tag-sugs li');
const nRows = await rows.count();
ok(nRows >= 3 && nRows <= 15, `${nRows} suggested tags`);
ok(workers >= 1, 'the reading ran in a worker (' + workers + ')');
const sureRows = await p.locator('.tag-sugs li[data-sure="1"]').count(), lessRows = await p.locator('.tag-sugs li[data-sure="0"]').count();
ok(sureRows >= 2 && lessRows >= 1, `${sureRows} sure tags and ${lessRows} less sure ones`);
ok(await p.locator('.tag-sugs li[data-sure="1"] .pick:checked').count() === sureRows && await p.locator('.tag-sugs li[data-sure="0"] .pick:checked').count() === 0, 'the sure ones are ticked and the less sure ones are not');
ok((await p.textContent('#atLess')) === 'Less sure' && await p.evaluate(() => { const h = document.getElementById('atLess'), l = document.querySelector('li[data-sure="1"]'); return !!(l.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'a "Less sure" heading comes after the sure ones');
const names = await p.$$eval('.tag-sugs .tag-name', i => i.map(x => x.value));
console.log('   tags:', names.join(', '));
ok(names.every(n => /^[\p{L}-]+$/u.test(n) && n.length >= 4), 'every name is a clean word or phrase');
ok((await p.textContent('#atBody')).includes("Topics found in this deck's cards.") && await p.isVisible('#tagFolder'), 'the intro and the folder box are there');
ok(/^Add \d+ tags? to \d+ cards?$/.test(await addLabel(p)), 'the button says what it will do: ' + await addLabel(p));
ok(await p.evaluate(() => (document.querySelector('#atLive').textContent || '').startsWith('Found ')), 'the result is announced once');
const countText = await rows.nth(0).locator('.ts-count').textContent();
ok(/^\d+ cards?$/.test(countText), 'each row shows its cards: ' + countText);
await p.screenshot({ path: SP + '/at-sheet.png', fullPage: true });

const lessRow = p.locator('.tag-sugs li[data-sure="0"]').first();
const label0 = await addLabel(p);
await lessRow.locator('.pick').check();
ok(await addLabel(p) !== label0, 'ticking a less sure tag changes the button: ' + label0 + ' → ' + await addLabel(p));
await lessRow.locator('.pick').uncheck();
ok(await addLabel(p) === label0, 'and unticking it puts it back');
const before = await addLabel(p);
// rename row 2, untick row 3, untick a card under row 1
const row2Was = names[1], row3Was = names[2], row1Was = names[0];
await rows.nth(1).locator('.tag-name').fill('Plant Biology Extra');
await rows.nth(1).locator('.tag-name').blur();
ok(await rows.nth(1).locator('.tag-name').inputValue() === 'plant-biology-extra', 'a renamed tag is tidied: spaces become "-" and capitals go');
await rows.nth(2).locator('.pick').uncheck();
const cardsBtn = rows.nth(0).locator('button[aria-controls]');
ok(await cardsBtn.getAttribute('aria-expanded') === 'false', 'Cards is closed to begin with');
await cardsBtn.click();
ok(await cardsBtn.getAttribute('aria-expanded') === 'true' && await rows.nth(0).locator('.ts-cards').isVisible(), 'Cards opens a list (aria-expanded true)');
const listed = await rows.nth(0).locator('.ts-cards input').count();
ok(listed >= 3 && listed <= 100, `${listed} cards listed under ${row1Was}`);
const unCardText = (await rows.nth(0).locator('.ts-cards label').first().textContent()).trim();
const unNote = await rows.nth(0).locator('.ts-cards input').first().getAttribute('data-note');
await rows.nth(0).locator('.ts-cards input').first().uncheck();
ok(/^Add \d+ tags? to \d+ cards?$/.test(await addLabel(p)) && await addLabel(p) !== before, 'the button updates live: ' + before + ' → ' + await addLabel(p));
ok((await rows.nth(0).locator('.ts-count').textContent()) !== countText, 'and so does the row\'s count');
// a duplicate name
await rows.nth(3).locator('.tag-name').fill('plant-biology-extra');
ok((await rows.nth(3).locator('.ts-err').textContent()).includes("they'll be one tag") && await rows.nth(1).locator('.ts-err').isVisible(), 'two rows with the same name: both say they will be one tag');
await rows.nth(3).locator('.tag-name').fill(names[3]);
ok(await rows.nth(3).locator('.ts-err').isHidden(), 'and the note goes when the name is changed');
// an empty name
await rows.nth(3).locator('.tag-name').fill('  ');
ok((await rows.nth(3).locator('.ts-err').textContent()).includes("can't be empty") && await p.isDisabled('#atAdd'), 'an empty name: "A tag can\'t be empty" and Add is off');
await rows.nth(3).locator('.tag-name').fill(names[3]);
ok(await p.isEnabled('#atAdd'), 'a good name turns Add back on');

// ---- 3. leaving with changes asks first ----
await p.keyboard.press('Escape');
await p.waitForSelector('#discardKeep');
ok(await p.isVisible('#discardKeep') && (await p.textContent('body')).includes('Discard changes?'), 'Esc with changes asks "Discard changes?"');
await p.click('#discardKeep');
ok(await p.isVisible('#atAdd') && await rows.nth(1).locator('.tag-name').inputValue() === 'plant-biology-extra', 'Keep editing leaves the sheet as it was');

// ---- 4. add, with a folder ----
await p.fill('#tagFolder', 'Bio Unit');
ok(await rows.nth(1).locator('.tag-name').inputValue() === 'plant-biology-extra', 'the name stays as typed (the folder is put in front when saving)');
const label = await addLabel(p);
const m = label.match(/^Add (\d+) tags? to (\d+) cards?$/);
await p.click('#atAdd');
await p.waitForFunction(() => /^Added \d+ tags? to \d+ cards?/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
const toastText = await p.textContent('#toast');
ok(toastText.includes('Undo'), 'the toast has Undo: ' + toastText.trim());
ok(await p.isHidden('#sheet') || !(await p.evaluate(() => document.getElementById('sheet').open)), 'the sheet closed');
const after = await cardsInDb(p);
const has = tag => after.filter(c => (c.tags || []).includes(tag));
ok(has('bio-unit::plant-biology-extra').length > 0, `the renamed tag was used, with its folder (${has('bio-unit::plant-biology-extra').length} cards)`);
ok(!after.some(c => (c.tags || []).some(t => t.endsWith('::' + row2Was) || t === row2Was)) || row2Was === 'plant-biology-extra', 'the old name of the renamed tag is not used');
ok(!after.some(c => (c.tags || []).some(t => t === 'bio-unit::' + row3Was)), 'the unticked tag was not added: ' + row3Was);
const tagged = after.filter(c => (c.tags || []).some(t => t.startsWith('bio-unit::')));
ok(tagged.length === +m[2] || Math.abs(tagged.length - +m[2]) === 0, `the button's number was right: ${tagged.length} of ${m[2]} cards`);
const unCard = after.find(c => (c.front || '').replace(/\s+/g, ' ').trim().startsWith(unCardText.slice(0, 40)));
ok(unCard && !(unCard.tags || []).includes('bio-unit::' + row1Was), 'the unticked card did not get the first tag');
ok(week1.every(id => (after.find(c => c.id === id).tags || []).includes('week1')), 'week1 is still on all ' + week1.length + ' cards that had it');
ok(after.length === n0, 'no card was added or lost');
await p.waitForSelector('#brTags');
await p.click('#brTags');
await p.waitForSelector('#tagTreeBox, .tag-list');
ok((await p.textContent('#sheet')).includes('bio-unit'), 'Browse → Tools shows the new folder of tags');
await p.keyboard.press('Escape');

// ---- 5. Undo ----
// (the toast may have timed out while the Tools sheet was open: then add again to test Undo)
if (!(await p.$('#toast .toast-link:visible'))) {
  await openSuggest(p);
  await p.click('#atAdd');
  await p.waitForSelector('#toast .toast-link');
}
await p.click('#toast .toast-link');
await p.waitForFunction(() => document.getElementById('toast').textContent.includes('Tags removed'));
const undone = await tagsById(p);
ok(JSON.stringify(Object.keys(undone).sort().map(k => [k, undone[k]])) === JSON.stringify(Object.keys(original).sort().map(k => [k, original[k]])), 'Undo puts every card\'s tags back exactly');
await p.screenshot({ path: SP + '/at-after-undo.png' });

// ---- 6. the keyboard path ----
await p.focus('#deckMore');
await p.keyboard.press('Enter');
await p.waitForSelector('#deckMenu:not([hidden])');
for (let i = 0; i < 8 && await p.evaluate(() => document.activeElement.id) !== 'autoTag'; i++) await p.keyboard.press('ArrowDown');
ok(await p.evaluate(() => document.activeElement.id) === 'autoTag', 'arrow keys reach Suggest tags');
await p.keyboard.press('Enter');
await p.waitForSelector('.tag-sugs li', { timeout: 30000 });
ok(await p.evaluate(() => !!document.activeElement.closest('#sheet')), 'focus is inside the sheet');
const tabTo = async (test, max = 400) => { for (let i = 0; i < max; i++) { await p.keyboard.press('Tab'); if (await p.evaluate(test)) return true; } return false; };
ok(await tabTo(() => document.activeElement.id === 'tagFolder'), 'Tab reaches the folder box');
await p.keyboard.type('kb');
ok(await tabTo(() => document.activeElement.matches('.tag-sugs .pick')), 'Tab reaches the first tick box');
await p.keyboard.press('Space');
ok(!(await rows.nth(0).locator('.pick').isChecked()), 'Space unticks it');
ok(await tabTo(() => document.activeElement.matches('.tag-sugs .tag-name')), 'Tab reaches the name');
await p.keyboard.type('x'); await p.keyboard.press('Backspace');
ok(await tabTo(() => document.activeElement.matches('.tag-sugs button[aria-controls]')), 'Tab reaches the Cards button');
await p.keyboard.press('Enter');
ok(await rows.nth(0).locator('button[aria-controls]').getAttribute('aria-expanded') === 'true', 'Enter opens the cards');
ok(await tabTo(() => document.activeElement.id === 'atAdd'), 'Tab reaches Add');
await p.keyboard.press('Enter');
await p.waitForFunction(() => /^Added /.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
const kb = await cardsInDb(p);
ok(kb.some(c => (c.tags || []).some(t => t.startsWith('kb::'))) && !kb.some(c => (c.tags || []).includes('kb::' + row1Was)), 'the keyboard flow added the tags and left the unticked one out');
await p.click('#toast .toast-link');
await p.waitForFunction(() => document.getElementById('toast').textContent.includes('Tags removed'));
ok(!(await cardsInDb(p)).some(c => (c.tags || []).some(t => t.startsWith('kb::'))), 'and Undo removed them');

// ---- 7. Browse → Tools opens the same sheet for the list ----
await p.click('#brTags');
await p.click('#toolAutoTag');
await p.waitForSelector('.tag-sugs li', { timeout: 30000 });
ok(await p.isVisible('#tagFolder'), 'Browse → Tools → Suggest tags opens the sheet');
await p.click('#atCancel');
ok(!(await p.evaluate(() => document.getElementById('sheet').open)), 'Cancel with nothing changed closes it without asking');

// ---- 8. a deck with no clear topics, and a small deck ----
await p.evaluate(async () => {
  const db = await import('./js/db.js');
  const pairs = 'la cocina|kitchen,el dormitorio|bedroom,el baño|bathroom,la sala|living room,el comedor|dining room,el jardín|garden,el garaje|garage,la puerta|door,la ventana|window,el techo|roof,la pared|wall,la escalera|stairs'.split(',');
  await db.addDeckWithCards({ id: 'es', name: 'Spanish', color: '#3E63DD', created: Date.now() + 5 }, pairs.map((x, i) => ({ id: 'es' + i, deckId: 'es', front: x.split('|')[0], back: x.split('|')[1], created: i + 1 })));
  await db.addDeckWithCards({ id: 'tiny', name: 'Tiny', color: '#3E63DD', created: Date.now() + 6 }, [1, 2, 3].map(i => ({ id: 't' + i, deckId: 'tiny', front: 'f' + i, back: 'b' + i, created: i })));
});
await p.goto('http://localhost:8123/#/deck/es'); await p.waitForSelector('.crow');
await p.click('#deckMore'); await p.click('#autoTag');
await p.waitForSelector('#atMsg', { timeout: 30000 });
ok((await p.textContent('#atMsg')).startsWith('No clear topics found in these cards.') && await p.isDisabled('#atAdd'), 'a vocabulary deck: "No clear topics found…" and nothing to add');
await p.keyboard.press('Escape');
// nothing sure, but some less sure tags: the message, and the list unticked
const GEO = fixture('geology').cards.map(c => ({ id: 'g' + c.id, deckId: 'geo', front: c.front, back: c.back, created: 1 }));
await p.evaluate(async cards => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'geo', name: 'Geology', color: '#3E63DD', created: Date.now() + 7 }, cards); }, GEO);
await p.goto('http://localhost:8123/#/deck/geo'); await p.waitForSelector('.crow');
await p.click('#deckMore'); await p.click('#autoTag');
await p.waitForSelector('.tag-sugs li', { timeout: 30000 });
ok((await p.textContent('#atBody')).startsWith('No clear topics found') && await p.isVisible('#atLess'), 'no sure tag: the "No clear topics" message, and the less sure ones below');
ok(await p.locator('.tag-sugs .pick:checked').count() === 0 && await p.isDisabled('#atAdd'), 'none is ticked, so Add is off');
await p.keyboard.press('Escape');
await p.goto('http://localhost:8123/#/deck/tiny'); await p.waitForSelector('.crow');
await p.click('#deckMore');
ok(await p.isHidden('#autoTag').catch(() => true) && !(await p.$('#autoTag')), 'a deck with fewer than 10 cards has no Suggest tags item');
await p.keyboard.press('Escape');

// ---- 9. a phone-sized screen ----
await p.context().close();
p = await open({ w: 320, h: 640 });
await pasteDeck(p, 'Biology', LINES);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck'); await p.click('.deck-open'); await p.waitForSelector('.crow');
await openSuggest(p);
await noHScroll(p, '320px, Suggest tags');
await p.locator('.tag-sugs li').first().locator('button[aria-controls]').click();
await noHScroll(p, '320px, with the cards open');
const boxes = await p.$$eval('.tag-sugs .pick-wrap, .tag-sugs .tag-name, .tag-sugs button[aria-controls]', l => l.map(x => { const r = x.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
ok(boxes.length > 8 && boxes.every(([w, h]) => w >= 44 && h >= 44), `tick boxes, names and Cards buttons are 44px tap targets (${boxes.length}, smallest ${Math.min(...boxes.map(b => b[0]))}x${Math.min(...boxes.map(b => b[1]))})`);
const li0 = await p.$eval('.tag-sugs li', li => { const a = li.querySelector('.tag-name').getBoundingClientRect(), b = li.querySelector('.ts-meta').getBoundingClientRect(); return b.top >= a.bottom - 1; });
ok(li0, 'the rows stack: the name on the first line, the count and Cards button on the second');
await p.screenshot({ path: SP + '/at-320.png', fullPage: true });
await p.context().close();

// ---- 10. no workers: the same, in small slices on the page ----
p = await open({ init: () => { delete window.Worker; } });
await pasteDeck(p, 'Biology', LINES);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck'); await p.click('.deck-open'); await p.waitForSelector('.crow');
await openSuggest(p);
ok((await p.locator('.tag-sugs li').count()) >= 3, 'with no Worker in the browser the tags are still found (' + await p.locator('.tag-sugs li').count() + ')');
await p.context().close();

// ---- 11. a long deck: progress, and Stop ----
p = await open();
await p.evaluate(async () => {
  const db = await import('./js/db.js');
  const words = 'alpha beta gamma delta kappa sigma omega theta lambda zeta'.split(' ');
  let seed = 3; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const syl = () => 'bcdfghklmnprstvz'[Math.floor(rnd() * 16)] + 'aeiou'[Math.floor(rnd() * 5)];
  const word = () => Array.from({ length: 4 }, syl).join('');
  const cards = Array.from({ length: 6000 }, (_, i) => ({ id: 'L' + i, deckId: 'long', front: 'What is ' + Array.from({ length: 8 }, word).join(' ') + '?', back: Array.from({ length: 14 }, word).join(' '), created: i + 1 }));
  await db.addDeckWithCards({ id: 'long', name: 'Long', color: '#3E63DD', created: Date.now() }, cards);
});
await p.goto('http://localhost:8123/#/deck/long'); await p.waitForSelector('.crow');
await p.click('#deckMore'); await p.click('#autoTag');
await p.waitForSelector('#atProg, #atMsg, .tag-sugs li');
const prog = await p.textContent('#atProg').catch(() => '');
ok(prog === '' || /^Reading 6,000 cards… \d+%$/.test(prog), 'while it reads: "' + prog + '"');
await p.waitForSelector('#atMsg, .tag-sugs li', { timeout: 60000 });
ok(await p.locator('.tag-sugs li').count() > 0 || (await p.textContent('#atMsg')).length > 0, 'the long deck finished with an answer');
await p.context().close();
p = await open();
await p.evaluate(async () => {
  const db = await import('./js/db.js');
  const word = i => 'zq' + i.toString(36) + 'xv';
  const cards = Array.from({ length: 30000 }, (_, i) => ({ id: 'M' + i, deckId: 'huge', front: 'What is ' + Array.from({ length: 10 }, (_, k) => word(i * 10 + k)).join(' ') + '?', back: Array.from({ length: 30 }, (_, k) => word(i * 7 + k * 13)).join(' '), created: i + 1 }));
  await db.addDeckWithCards({ id: 'huge', name: 'Huge', color: '#3E63DD', created: Date.now() }, cards);
});
await p.goto('http://localhost:8123/#/deck/huge'); await p.waitForSelector('.crow', { timeout: 60000 });
await p.click('#deckMore'); await p.click('#autoTag');
await p.waitForSelector('#atStop', { timeout: 10000 });
await p.click('#atStop');
await p.waitForSelector('#atMsg');
ok((await p.textContent('#atMsg')).startsWith('Stopped'), 'Stop ends the reading: ' + await p.textContent('#atMsg'));
ok(await p.evaluate(() => document.activeElement.id) === 'atMsg', 'and focus moves to the message');
await p.keyboard.press('Escape');
await p.context().close();

ok(requests.length === 0, 'nothing left the page' + (requests.length ? ': ' + requests.slice(0, 3).join(', ') : ''));
ok(errors.length === 0, 'no console errors or CSP violations' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
