// Cards that work in both directions (item 5): adding and editing a pair, Review showing one a day, the card list and panel, deleting,
// the bulk action, Find and replace, importing from Anki (both layouts, with history) and CSV, exporting and importing again, and Play.
// Run with: node tests/browser/run.mjs reverse
import fs from 'node:fs';
import { chromium } from './pw.mjs';
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
const toastText = () => page.textContent('#toast');
const cardsIn = name => run(async n => {
  const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === n);
  const cards = await db.getCardsInDeck(d.id), logs = await db.getAll('reviewLog');
  return Promise.all(cards.map(async c => ({ ...c, state: (await db.get('cardStates', c.id)) || null, logs: logs.filter(l => l.cardId === c.id).sort((a, b) => a.timestamp - b.timestamp) })));
}, name);
const noHScroll = async w => ok(await run(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const deckId = name => run(async n => (await (await import('./js/db.js')).getDecks()).find(x => x.name === n)?.id, name);
const closeSheet = async () => { await page.waitForTimeout(500); await page.evaluate(() => { const s = document.getElementById('sheet'); if (s?.open) s.close(); }); };      // (a moment first: a saved card's panel opens again a moment after the toast)
const saveAddForm = () => page.click('button[type=submit][form=acForm]');

// A deck of its own, with one ordinary card so the list isn't the empty state.
await run(async () => {
  const db = await import('./js/db.js');
  await db.saveDeck({ id: 'pairs', name: 'Pairs', course: '', color: '#8b5cf6', parentId: '', created: Date.now() });
  await db.saveCards([{ id: 'plain1', deckId: 'pairs', front: 'Plain', back: 'one way', tags: [], created: Date.now() }]);
});

// ---------- 1. the Add card form ----------
await page.goto(APP + '#/deck/pairs'); await page.waitForSelector('.crow');
await page.click('#brAdd'); await page.waitForSelector('#acForm');
ok(await page.isVisible('#acRevRow') && !(await page.isChecked('#acRevOn')), 'Add card: the Both directions switch is there, and off');
ok((await page.textContent('#acRevRow')).includes('Both directions') && (await page.textContent('#acRevRow')).includes('Also asks the back and expects the front. Each direction has its own schedule; Review shows one of the two a day.'), 'the switch says what it does');
await page.click('#acModeSteps', { force: true });
ok(!(await page.isVisible('#acRevRow')) && (await page.textContent('#acRevNote')).includes("Step-by-step and elements cards can't be reversed."), 'with Answer in steps on, the switch gives way to a note');
await page.click('#acModeText', { force: true });
ok(await page.isVisible('#acRevRow') && !(await page.isVisible('#acRevNote')), 'and comes back when steps go off');
await page.fill('#acFront', 'Mitosis'); await page.fill('#acBack', 'Cell division'); await page.fill('#acTags', 'bio');
await page.click('#acRevRow');
ok(await page.isChecked('#acRevOn'), 'switched on');
await page.screenshot({ path: SP + '/rev-add-375.png' });
await saveAddForm(); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Added 2 cards'));
let pair = (await cardsIn('Pairs')).filter(c => c.noteId);
const fwd = pair.find(c => !c.reverse), rev = pair.find(c => c.reverse);
ok(pair.length === 2 && fwd && rev && fwd.noteId === rev.noteId, 'saving makes two cards that share a note');
ok(fwd.front === 'Mitosis' && fwd.back === 'Cell division' && rev.front === 'Cell division' && rev.back === 'Mitosis', 'the reverse card has the sides swapped');
ok(rev.reverse === true && !('reverse' in fwd) && fwd.tags[0] === 'bio' && rev.tags[0] === 'bio' && fwd.deckId === rev.deckId, 'it is marked reverse, and shares the tags and deck');
ok(typeof fwd.noteEditedAt === 'number' && fwd.noteEditedAt === rev.noteEditedAt && !fwd.state && !rev.state, 'both stamped with one note edit time, both new');
ok(!(await page.inputValue('#acFront')) && await page.isChecked('#acRevOn'), 'the form is cleared for the next card, and the switch stays on');
await page.click('#acDone');
// a plain card added with the switch off stays one card
await page.click('#brAdd'); await page.waitForSelector('#acForm');
await page.fill('#acFront', 'Meiosis'); await page.fill('#acBack', 'Gametes'); await saveAddForm();
await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Card added'));
ok((await cardsIn('Pairs')).filter(c => c.front === 'Meiosis').length === 1, 'with the switch off a card is just one card');
await page.click('#acDone');

// ---------- 2. the list and the panel ----------
await page.waitForSelector('.crow .rev-pill');
ok((await page.locator('.crow .rev-pill').count()) === 1 && (await page.textContent('.crow .rev-pill')) === 'Reverse', 'the card list marks the reverse card with a small Reverse label');
await page.screenshot({ path: SP + '/rev-list-375.png' });
await page.locator('.crow', { hasText: 'Reverse' }).click(); await page.waitForSelector('#ceForm');
ok((await page.textContent('.rev-line')).startsWith('Reverse card · ') && (await page.textContent('#revOpen')) === 'Open the other direction', 'the panel says it is a reverse card, with a link to the other direction');
ok(await page.isChecked('#ceRevOn'), 'and the switch is on');
await page.screenshot({ path: SP + '/rev-panel-375.png' });
await page.click('#revOpen'); await page.waitForFunction(() => document.getElementById('ceFront')?.value === 'Mitosis');
ok((await page.textContent('.rev-line')).startsWith('Has a reverse card · '), 'Open the other direction opens the forward card ("Has a reverse card")');

// ---------- 3. editing either card saves both ----------
await page.fill('#ceBack', 'Division of the nucleus'); await page.click('button[type=submit][form=ceForm]');
await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Saved'));
pair = (await cardsIn('Pairs')).filter(c => c.noteId);
ok(pair.find(c => !c.reverse).back === 'Division of the nucleus' && pair.find(c => c.reverse).front === 'Division of the nucleus', 'editing the forward card changes the reverse card');
await page.waitForSelector('#ceForm'); await page.waitForFunction(() => document.getElementById('ceFront')?.value === 'Mitosis');
await page.click('#revOpen'); await page.waitForFunction(() => document.getElementById('ceFront')?.value === 'Division of the nucleus');
await page.fill('#ceBack', 'Mitosis (M phase)'); await page.fill('#ceHook', 'M for mitosis'); await page.fill('#ceTags', 'bio, cells');
await page.click('button[type=submit][form=ceForm]');
await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Saved'));
pair = (await cardsIn('Pairs')).filter(c => c.noteId);
ok(pair.find(c => !c.reverse).front === 'Mitosis (M phase)', 'editing the reverse card changes the forward card (its back is the forward card\'s front)');
ok(pair.every(c => c.noteExtra === 'M for mitosis' && c.tags.join() === 'bio,cells'), 'the hook and tags are shared by both');
ok(new Set(pair.map(c => c.noteEditedAt)).size === 1, 'saved together, with one edit time');
await closeSheet();

// ---------- 4. Review shows one of the two a day ----------
await run(async () => { const db = await import('./js/db.js'); await db.saveCards((await db.getAll('cards')).filter(c => !c.noteId).map(c => ({ ...c, suspended: true }))); });   // leave only the pair, so the queue is easy to read
await page.goto(APP + '#/review/pairs'); await page.waitForSelector('#flash');
const seen = [];
for (let i = 0; i < 6 && await page.isVisible('#flash').catch(() => false); i++) {
  seen.push((await page.textContent('.rv-front .flash-front')).trim());
  await page.keyboard.press('Space'); await page.waitForSelector('.rv-back:not([inert])');
  await page.keyboard.press('4'); await page.waitForTimeout(250);          // Easy, so the card does not come back in a few minutes
}
ok(seen.length === 1 && seen[0] === 'Mitosis (M phase)', 'Review shows one card of the pair today (the forward one): ' + seen.join(' | '));
pair = (await cardsIn('Pairs')).filter(c => c.noteId);
ok(pair.find(c => !c.reverse).state?.reps === 1 && !pair.find(c => c.reverse).state, 'only that card got a schedule; the reverse card is still new');
// tomorrow (answered a day ago): the reverse card is the one that shows, with its own schedule
await run(async () => {
  const db = await import('./js/db.js'); const logs = await db.getAll('reviewLog');
  for (const l of logs.filter(x => x.source === 'review')) await db.putMany?.('reviewLog', [{ ...l, timestamp: l.timestamp - 864e5 }]);
});
const moved = await run(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'review').every(l => l.timestamp < Date.now() - 6e7));
if (moved) {
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.goto(APP + '#/review/pairs'); await page.waitForSelector('#flash', { timeout: 5000 }).catch(() => {});
  ok((await page.isVisible('#flash')) && (await page.textContent('.rv-front .flash-front')).trim() === 'Division of the nucleus', 'the next day the reverse card is the one that shows');
} else console.log('SKIP the next-day check (the log cannot be moved from here)');
await page.goto(APP + '#/deck/pairs'); await page.waitForSelector('.crow');

// ---------- 5. turning the switch off, and back on, from the editor ----------
await page.locator('.crow', { hasText: 'Reverse' }).click(); await page.waitForSelector('#ceForm');
await page.click('#ceRevRow');
await page.click('button[type=submit][form=ceForm]'); await page.waitForSelector('#ceFormConfirm .confirm');
ok((await page.textContent('#ceFormConfirm')).includes('Remove the reverse card? Its schedule and history go.') && (await page.textContent('#cfYes')) === 'Remove reverse card', 'switching it off asks first, in the page');
await page.click('#cfNo');
ok((await cardsIn('Pairs')).filter(c => c.noteId).length === 2, 'Cancel keeps both cards');
await page.click('button[type=submit][form=ceForm]'); await page.waitForSelector('#cfYes'); await page.click('#cfYes');
await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Saved'));
let mit = (await cardsIn('Pairs')).filter(c => /Mitosis|nucleus/.test(c.front + c.back));
ok(mit.length === 1 && !mit[0].noteId && !('reverse' in mit[0]) && mit[0].front === 'Mitosis (M phase)' && mit[0].state?.reps === 1, 'the reverse card is gone and the other is an ordinary card again, with its schedule');
ok(!(await run(async () => (await import('./js/db.js')).getAll('cards')).then(cs => cs.some(c => c.reverse))), 'no card is left marked reverse');
// and on again from the ordinary card's editor
await page.waitForSelector('.crow'); await page.waitForFunction(() => document.querySelector('#ceForm') || document.querySelector('.crow'));
if (!(await page.isVisible('#ceForm'))) await page.locator('.crow', { hasText: 'Mitosis (M phase)' }).click();
await page.waitForSelector('#ceForm');
ok(!(await page.isChecked('#ceRevOn')), 'an ordinary card\'s editor shows the switch off');
await page.click('#ceRevRow'); await page.click('button[type=submit][form=ceForm]');
await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Saved'));
pair = (await cardsIn('Pairs')).filter(c => c.noteId);
ok(pair.length === 2 && pair.find(c => c.reverse).front === 'Division of the nucleus' && pair.find(c => !c.reverse).state?.reps === 1 && !pair.find(c => c.reverse).state, 'switching it on makes a reverse card, new, and the card keeps its schedule');
await closeSheet();

// ---------- 6. deleting one card of a pair ----------
await page.locator('.crow', { hasText: 'Reverse' }).click(); await page.waitForSelector('#ceForm');
await page.click('[data-act=delete]'); await page.waitForSelector('#cfOnly');
ok((await page.textContent('#ceConfirm')).includes('This card has a reverse card.') && (await page.textContent('#cfBoth')) === 'Delete both' && (await page.textContent('#cfOnly')) === 'Only this one', 'deleting asks: Delete both or Only this one');
await page.click('#cfOnly'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Card deleted'));
mit = (await cardsIn('Pairs')).filter(c => /Mitosis|nucleus/.test(c.front + c.back));
ok(mit.length === 1 && !mit[0].noteId && mit[0].front === 'Mitosis (M phase)', '"Only this one": the other card is ordinary now');
// make it a pair again (through the data, as the editor already did above), then delete both
await run(async () => {
  const db = await import('./js/db.js'), { reverseOf } = await import('./js/reverse.js');
  const c = (await db.getAll('cards')).find(x => x.front === 'Mitosis (M phase)');
  const f = { ...c, noteId: db.newId(), noteEditedAt: Date.now() };
  await db.saveCards([f, { ...reverseOf(f, db.newId()), noteEditedAt: f.noteEditedAt }]);
});
await page.goto(APP + '#/decks'); await page.waitForSelector('.deck'); await page.goto(APP + '#/deck/pairs'); await page.waitForSelector('.crow .rev-pill');
await page.locator('.crow', { hasText: 'Mitosis (M phase)' }).first().click(); await page.waitForSelector('#ceForm');
await page.click('[data-act=delete]'); await page.waitForSelector('#cfBoth'); await page.click('#cfBoth');
await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Both cards deleted'));
ok(!(await cardsIn('Pairs')).some(c => /Mitosis|nucleus/.test(c.front + c.back)), '"Delete both" removes both cards');

// ---------- 7. the bulk action and Find and replace ----------
await run(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.saveDeck({ id: 'bulk', name: 'Bulk', course: '', color: '#46A758', parentId: '', created: now + 1 });
  await db.saveCards([
    ...['alpha', 'beta', 'gamma'].map((w, i) => ({ id: 'b' + i, deckId: 'bulk', front: w, back: w.toUpperCase(), tags: [], created: now + i })),
    { id: 'bz', deckId: 'bulk', noteId: 'CLZ', cloze: 1, noteText: 'The {{c1::heart}} pumps', front: 'The […] pumps', back: 'heart', tags: [], created: now + 4 },
    { id: 'bs', deckId: 'bulk', front: 'Make tea', back: 'Step 1: boil\nStep 2: pour', tags: [], created: now + 5 }
  ]);
});
await page.goto(APP + '#/deck/bulk'); await page.waitForSelector('.crow');
await page.click('#brSelect'); await page.click('#brAll'); await page.click('#brActions'); await page.waitForSelector('[data-act=reverse]');
await page.click('[data-act=reverse]'); await page.waitForSelector('#cfYes');
ok((await page.textContent('#ceConfirm')).includes("Add reverse cards to 3 cards? 2 can't be reversed (cloze, image-occlusion or step-by-step cards).") && (await page.textContent('#cfYes')) === 'Add 3 reverse cards', 'bulk: says how many get a reverse card and how many cannot');
await page.screenshot({ path: SP + '/rev-bulk-375.png' });
await page.click('#cfYes'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Added 3 reverse cards'));
let bulk = await cardsIn('Bulk');
ok(bulk.length === 8 && bulk.filter(c => c.reverse).length === 3 && bulk.filter(c => c.noteId && !c.reverse && !c.noteText).length === 3, 'bulk: 3 reverse cards were added');
ok(bulk.filter(c => c.reverse).every(r => { const f = bulk.find(c => c.noteId === r.noteId && !c.reverse); return f && f.front === r.back && f.back === r.front; }), 'bulk: each is its card swapped, sharing a note');
ok(!bulk.find(c => c.id === 'bz').reverse && bulk.filter(c => c.noteId === 'CLZ').length === 1 && !bulk.some(c => c.front === 'Step 1: boil'), 'bulk: the cloze and steps cards got none');
// Find and replace: select only the forward "alpha" card
await page.goto(APP + '#/decks'); await page.waitForSelector('.deck'); await page.goto(APP + '#/deck/bulk'); await page.waitForSelector('.crow');
await page.click('#brSelect'); await page.locator('.crow', { hasText: 'alpha' }).filter({ hasNotText: 'Reverse' }).first().click(); await page.click('#brActions');
await page.click('#frBox summary'); await page.click('label.chip:has(input[value=front])'); await page.fill('#frFind', 'alpha'); await page.fill('#frWith', 'omega');
await page.waitForFunction(() => document.getElementById('frCount').textContent.includes('Changes 2 cards'));
ok(true, 'Find and replace on a forward card counts its reverse card too');
await page.click('#frGo'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Replaced in 2 cards'));
bulk = await cardsIn('Bulk');
const om = bulk.find(c => c.front === 'omega' || c.back === 'omega');
ok(bulk.some(c => c.front === 'omega' && c.back === 'ALPHA' && !c.reverse) && bulk.some(c => c.front === 'ALPHA' && c.back === 'omega' && c.reverse) && om, 'Find and replace changed the reverse card to match');

// ---------- 8. importing from Anki: both layouts, with history ----------
const load = async file => {
  await page.goto(APP + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  await page.selectOption('#deckSel', '__new');          // a new deck, so earlier imports don't make these rows "Already in this deck"
};
for (const [file, name] of [['anki-reversed-new.apkg', 'Reversed new'], ['anki-reversed-legacy.apkg', 'Reversed old']]) {
  await load(file);
  const found = await page.textContent('#found');
  ok(found.includes('Found 7 cards'), `${file}: ${found.slice(0, 60)}`);
  ok(found.includes('3 notes work in both directions, so each makes 2 cards.'), `${file}: the preview says 3 notes work in both directions`);
  ok(found.includes('2 notes have more card types in Anki (like a listening card); only the first card of each comes in.'), `${file}: and 2 notes have a card type that does not come in`);
  ok(await page.isVisible('#revRow') && (await page.textContent('#revRow')).includes('Make the reverse cards too') && await page.isChecked('#makeReverse'), `${file}: the "Make the reverse cards too" switch is on`);
  const badges = await page.locator('.prow .badge', { hasText: 'Both directions: makes 2 cards' }).count();
  ok(badges === 3, `${file}: three rows say "Both directions: makes 2 cards" (${badges})`);
  ok(/\b10 cards\b/.test(await page.textContent('#saveBtn')), `${file}: the Add button counts both cards: ${await page.textContent('#saveBtn')}`);
  ok((await page.textContent('#progInfo')).startsWith('6 reviews on 3 cards'), `${file}: history of the reverse cards counts too: ${await page.textContent('#progInfo')}`);
  if (file.includes('new')) { await page.screenshot({ path: SP + '/rev-import-375.png', fullPage: true }); await noHScroll('import preview'); }
  await page.selectOption('#deckSel', '__new'); await page.fill('#newName', name); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
  const cs = await cardsIn(name);
  const by = f => cs.filter(c => c.front === f);
  ok(cs.length === 10, `${file}: 10 cards were made (${cs.length})`);
  const mf = by('Mitosis')[0], mr = by('Cell division')[0];
  ok(mf && mr && mf.noteId === mr.noteId && mr.reverse === true && !mf.reverse && mr.back === 'Mitosis', `${file}: Mitosis and its reverse card are a pair`);
  ok(mf.state?.reps === 3 && mf.logs.length === 3, `${file}: the forward card replays its own 3 reviews`);
  ok(mr.state?.reps === 2 && mr.logs.length === 2 && mr.logs.map(l => l.rating).join() === '3,1' && mr.logs.every(l => l.source === 'anki'), `${file}: the reverse card replays its own 2 reviews, the last an Again (reps ${mr.state?.reps}, ratings ${mr.logs.map(l => l.rating)})`);
  const nr = by('Holds DNA')[0];
  ok(nr?.reverse === true && nr.state?.reps === 1 && by('Nucleus')[0].state === null, `${file}: Nucleus (optional reversed, filled in) has a reverse card with its one review`);
  ok(by('Makes proteins').length === 0 && by('Ribosome').length === 1 && !by('Ribosome')[0].noteId, `${file}: Ribosome (optional reversed, left empty) is one card`);
  ok(by('Meiosis')[0].noteId && by('Gametes')[0].reverse && !by('Gametes')[0].state, `${file}: Meiosis and its reverse card are new`);
  ok(by('Neuron').length === 1 && by('Nerve cell').length === 0 && !by('Neuron')[0].noteId, `${file}: the three-card-type note brings only its first card`);
}
// the switch off: just the 7 notes' first cards
await load('anki-reversed-new.apkg');
await page.click('#revRow');
ok((await page.textContent('#found')).includes('Reverse cards are left out (Make the reverse cards too is off).') && (await page.textContent('#saveBtn')).startsWith('Add 7 cards') && (await page.locator('.prow .badge', { hasText: 'Both directions' }).count()) === 0, 'switch off: Add 7 cards, and the rows stop saying they make 2');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Reversed off'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
ok((await cardsIn('Reversed off')).length === 7 && (await cardsIn('Reversed off')).every(c => !c.noteId), 'switch off: 7 ordinary cards');

// ---------- 9. exporting and importing again ----------
const apkg = await run(async () => {
  const db = await import('./js/db.js'), { makeApkg } = await import('./js/export.js');
  const d = (await db.getDecks()).find(x => x.name === 'Reversed new');
  const blob = await makeApkg(d, await db.getCardsInDeck(d.id));
  const bytes = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
});
fs.mkdirSync(SP + '/exports', { recursive: true });
fs.writeFileSync(SP + '/files/reversed-out.apkg', Buffer.from(apkg, 'base64'));
await load('reversed-out.apkg');
ok((await page.textContent('#found')).includes('Found 7 cards') && (await page.textContent('#found')).includes('3 notes work in both directions'), 'export, then import: 10 cards are 7 notes, 3 of them in both directions');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Round trip'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
let rt = await cardsIn('Round trip');
ok(rt.length === 10 && rt.filter(c => c.reverse).length === 3 && rt.filter(c => c.reverse).every(r => rt.some(f => f.noteId === r.noteId && !f.reverse && f.front === r.back && f.back === r.front)), 'the pairs come back as pairs');
// CSV
const csv = await run(async () => {
  const db = await import('./js/db.js'), { toCSV } = await import('./js/export.js');
  const d = (await db.getDecks()).find(x => x.name === 'Reversed new');
  return toCSV(await db.getCardsInDeck(d.id));
});
ok(csv.startsWith('﻿Front,Back,Tags,Both directions') && (csv.match(/,yes\r?\n/g) || []).length === 3 && csv.split(/\r?\n/).length === 9, 'CSV: one row per pair, and a Both directions column');
await page.goto(APP + '#/import'); await page.waitForSelector('#pasteBox'); await page.fill('#pasteBox', csv);
await page.selectOption('#deckSel', '__new');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Found 7 cards'));
const csvBadges = await page.locator('.prow .badge', { hasText: 'Both directions: makes 2 cards' }).count();
ok(await page.isVisible('#revRow') && csvBadges === 3 && /\b10 cards\b/.test(await page.textContent('#saveBtn')), `CSV: importing it shows the pairs again (${csvBadges} rows, ${await page.textContent('#saveBtn')})`);
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'From CSV'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
rt = await cardsIn('From CSV');
ok(rt.length === 10 && rt.filter(c => c.reverse).length === 3, 'CSV: and saving makes the reverse cards');

// ---------- 10. Play: back → front grades the reverse card ----------
await run(async () => {
  const db = await import('./js/db.js'), { reverseOf } = await import('./js/reverse.js'); const now = Date.now();
  await db.saveDeck({ id: 'pp', name: 'Play pairs', course: '', color: '#3E63DD', parentId: '', created: now + 9 });
  const cards = [];
  [['Aorta', 'Largest artery'], ['Vena cava', 'Largest vein'], ['Capillary', 'Smallest vessel'], ['Atrium', 'Receiving chamber'], ['Ventricle', 'Pumping chamber']].forEach(([f, b], i) => {
    const c = { id: 'pp' + i, deckId: 'pp', noteId: 'PP' + i, front: f, back: b, tags: [], created: now + i, noteEditedAt: now };
    cards.push(c, { ...reverseOf(c, 'ppr' + i), noteEditedAt: now });
  });
  await db.saveCards(cards);
  // all of them in review and due, so a Play answer changes the schedule
  await db.putStates(cards.map(c => ({ cardId: c.id, due: now - 864e5, stability: 5, difficulty: 5, elapsedDays: 5, scheduledDays: 5, learningSteps: 0, reps: 3, lapses: 0, state: 2, lastReview: now - 6 * 864e5 })));
  await db.setSetting('playCountsAsReviews', true);
});
const playRound = async qtype => {
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
  await page.selectOption('#pDeck', 'pp');
  for (const s of ['input[name=fmt][value=classic]', `input[name=qtype][value=${qtype}]`, 'input[name=len][value="10"]']) await page.$eval(s, el => el.click());
  await page.click('#startBtn'); await page.waitForSelector('#pCard');
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
    const prompt = await page.textContent('#pPrompt');
    const want = await run(([p, q]) => ({ front: { 'Aorta': 'Largest artery', 'Vena cava': 'Largest vein', 'Capillary': 'Smallest vessel', 'Atrium': 'Receiving chamber', 'Ventricle': 'Pumping chamber' }[p],
      back: { 'Largest artery': 'Aorta', 'Largest vein': 'Vena cava', 'Smallest vessel': 'Capillary', 'Receiving chamber': 'Atrium', 'Pumping chamber': 'Ventricle' }[p] })[q], [prompt, qtype]);
    const idx = await run(v => [...document.querySelectorAll('#options .opt')].findIndex(b => b.querySelector('.lbl').textContent === v), want);
    if (idx < 0) { ok(false, `${qtype}: the right answer for "${prompt}" is among the options`); break; }
    await page.keyboard.press(String(idx + 1)); await page.waitForSelector('.fb'); await page.keyboard.press('Enter');
  }
  await page.waitForSelector('.stamp');
};
await playRound('front');
let plays = await run(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'play' && /^pp/.test(l.cardId)).map(l => l.cardId));
ok(plays.length === 10 && plays.every(id => /^pp\d$/.test(id)), 'Front → back: the answers go to the forward cards: ' + [...new Set(plays)].join());
await run(async () => { const db = await import('./js/db.js'); /* new round: forget today's play answers so "already played" does not hide the schedule */ });
await playRound('back');
plays = await run(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'play' && /^pp/.test(l.cardId)).map(l => l.cardId));
const backPlays = plays.filter(id => /^ppr/.test(id));
ok(backPlays.length === 10 && plays.length === 20, 'Back → front: the answers go to the reverse cards, not the forward ones: ' + [...new Set(backPlays)].join());
const reps = await run(async () => { const db = await import('./js/db.js'); const out = {}; for (const id of ['pp0', 'pp1', 'pp2', 'pp3', 'pp4', 'ppr0', 'ppr1', 'ppr2', 'ppr3', 'ppr4']) out[id] = (await db.get('cardStates', id)).reps; return out; });
ok(['ppr0', 'ppr1', 'ppr2', 'ppr3', 'ppr4'].some(id => reps[id] > 3) && ['pp0', 'pp1', 'pp2', 'pp3', 'pp4'].some(id => reps[id] > 3), 'with Count Play answers as reviews on, each direction graded its own card: ' + JSON.stringify(reps));

// ---------- 11. screens: a computer, light ----------
const wide = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })).newPage();
wide.on('pageerror', e => errors.push('wide pageerror ' + e.stack));
await wide.goto(APP + '#/decks'); await wide.waitForSelector('.deck');
await wide.evaluate(async () => {
  const db = await import('./js/db.js'), { reverseOf } = await import('./js/reverse.js'); const now = Date.now();
  await db.saveDeck({ id: 'pairs', name: 'Pairs', course: '', color: '#8b5cf6', parentId: '', created: now });
  const f = { id: 'f1', deckId: 'pairs', noteId: 'N1', front: 'Mitosis', back: 'Cell division', tags: ['bio'], created: now, noteEditedAt: now };
  await db.saveCards([f, { ...reverseOf(f, 'r1'), noteEditedAt: now }, { id: 'p1', deckId: 'pairs', front: 'Meiosis', back: 'Gametes', tags: [], created: now + 2 }]);
});
await wide.goto(APP + '#/deck/pairs'); await wide.waitForSelector('.crow .rev-pill');
await wide.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await wide.screenshot({ path: SP + '/rev-list-1440-light.png' });
await wide.locator('.crow', { hasText: 'Reverse' }).click(); await wide.waitForSelector('#ceForm'); await wide.waitForTimeout(300);
await wide.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await wide.screenshot({ path: SP + '/rev-panel-1440-light.png' });
await wide.evaluate(() => document.getElementById('sheet').close());
await wide.click('#brAdd'); await wide.waitForSelector('#acForm'); await wide.click('#acRevRow');
await wide.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await wide.screenshot({ path: SP + '/rev-add-1440-light.png' });

ok(errors.length === 0, 'no page errors: ' + errors.slice(0, 3).join(' || '));
await browser.close();
