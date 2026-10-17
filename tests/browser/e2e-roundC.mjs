import { chromium, deckMenu } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true })).newPage();
p.on('pageerror', e => errors.push(e.stack));
const go = async (hash, sel) => { await p.goto('about:blank'); await p.goto('http://localhost:8123/' + hash); await p.waitForSelector(sel); };
const DB = (fn, arg) => p.evaluate(fn, arg);
await go('#/decks', '.deck');
const total = await DB(async () => (await (await import('./js/db.js')).getCardsInDeck('sample')).length);

// + Subdeck from the deck page
await go('#/deck/sample', '#deckMore'); await deckMenu(p); await p.click('#addSub'); await p.waitForSelector('#deckParent');
ok(await p.$eval('#deckParent', s => s.value) === 'sample', 'new subdeck starts inside the deck');
await p.fill('#deckName', 'Unit 1'); await p.click('button[type=submit][form=deckForm]');
await p.waitForFunction(() => document.querySelector('h1')?.textContent === 'Unit 1');
const u1 = await DB(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Unit 1'));
ok(u1.parentId === 'sample', 'saved with parentId');
ok((await p.textContent('.crumbs')).includes('Psych') || (await p.textContent('.crumbs')).length > 0, 'breadcrumb: ' + await p.textContent('.crumbs'));
ok((await p.textContent('#back')).trim() !== '‹ Decks', 'back goes to the parent: ' + (await p.textContent('#back')).trim());
// a sub-subdeck
await deckMenu(p); await p.click('#addSub'); await p.waitForSelector('#deckName'); await p.fill('#deckName', 'Lecture 3'); await p.click('button[type=submit][form=deckForm]');
await p.waitForFunction(() => document.querySelector('h1')?.textContent === 'Lecture 3');
const l3 = await DB(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Lecture 3'));
// move cards: 0-3 → Unit 1, 4-5 → Lecture 3
await DB(async ([u, l]) => {
  const db = await import('./js/db.js');
  const cs = (await db.getCardsInDeck('sample')).sort((a, b) => a.created - b.created);
  await db.saveCards(cs.slice(0, 4).map(c => ({ ...c, deckId: u })).concat(cs.slice(4, 6).map(c => ({ ...c, deckId: l }))));
}, [u1.id, l3.id]);

// library: parent counts include subdecks; subdeck rows
await go('#/decks', '.deck');
ok((await p.locator('article.deck').count()) === 1, 'subdecks are not separate tiles');
ok((await p.textContent('article.deck .deck-counts')).includes(`${total} cards`), 'parent tile counts everything inside');
const rows = await p.$$eval('.subdecks .subdeck .sd-name', r => r.map(x => x.textContent));
ok(rows.join('|') === 'Unit 1|Lecture 3', 'subdeck rows: ' + rows.join('|'));
ok((await p.textContent('.subdecks summary')).trim() === '1 subdeck · 2 in all', 'summary counts direct subdecks, and all of them');
ok(!(await p.$eval('.subdecks', d => d.open)), 'compact list: subdecks start folded under their course');
await p.click('.subdecks summary');           // (the rows below are read from the page, folded or not)
await p.screenshot({ path: SP + '/C-library.png', fullPage: true });
// the open fold is remembered on this device (folded is the default)
await p.waitForTimeout(100);
await go('#/decks', '.deck');
ok(await p.$eval('.subdecks', d => d.open), 'an opened fold is remembered');
await p.click('.subdeck >> text=Lecture 3'); await p.waitForFunction(() => document.querySelector('h1')?.textContent === 'Lecture 3');
ok((await p.locator('.crow').count()) === 2, 'subdeck page lists its own cards');

// parent page includes subdecks' cards, with their deck shown
await go('#/deck/sample', '.crow');
ok((await p.locator('.crow').count()) === total, `parent card list includes subdecks (${await p.locator('.crow').count()}/${total})`);
ok((await p.$$eval('.crow .d', d => d.map(x => x.textContent))).some(t => t === 'Unit 1 › Lecture 3') && (await p.locator('.crow .d').count()) === 6, 'rows in subdecks show the path below this deck');
ok(await p.isVisible('.subdecks-page'), 'Subdecks section on the parent page');
await p.screenshot({ path: SP + '/C-deck.png', fullPage: true });
// add card asks which deck
await p.click('#brAdd'); await p.waitForSelector('#acDeck');
const acOpts = await p.$$eval('#acDeck option', o => o.map(x => x.textContent));
ok(acOpts.length === 3 && acOpts[2].endsWith('Unit 1 › Lecture 3'), 'add card offers the subdecks: ' + acOpts.join('|'));
await p.click('#acDone');

// editor: can't go inside itself or its subdecks
await deckMenu(p); await p.click('#editDeck'); await p.waitForSelector('#deckParent', { state: 'attached' });
ok(await p.$eval('#deckParent', x => x.type) === 'hidden', 'the top deck has nowhere else to go, so no Inside choice');
await p.click('#deckCancel');
await go('#/deck/' + u1.id, '#deckMore'); await deckMenu(p); await p.click('#editDeck'); await p.waitForSelector('#deckParent');
const places = await p.$$eval('#deckParent option', o => o.map(x => x.value));
ok(places.includes('sample') && !places.includes(u1.id) && !places.includes(l3.id), 'Unit 1 can go top level or in the sample deck only');
ok((await p.$eval('#deckTts option', o => o.textContent)).startsWith('Same as'), "read aloud: 'Same as the deck it's inside'");
await p.click('#deckCancel');

// limits: parent's new-card limit caps its subdecks
await DB(async ([u]) => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDeck('sample')), newPerDay: 3 }); await db.saveDeck({ ...(await db.getDeck(u)), newPerDay: 1 }); }, [u1.id]);
await go('#/today', '#optBtn'); await p.click('#optBtn'); await p.waitForSelector('#deckChips');
const chips = await p.$$eval('#deckChips [data-deck]', b => b.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok(chips.length === 3 && chips[1].startsWith('Unit 1') && chips[2].startsWith('Lecture 3') && (await p.$$('#deckChips .sub-mark')).length === 2, 'chips in tree order, subdecks marked: ' + chips.join(' | '));
ok(+(await p.$eval('[data-count=new]', v => v.textContent)) === 3, "parent's limit of 3 caps the group");
await p.click(`[data-deck="${u1.id}"]`);
const u1new = +(await p.$eval('[data-count=new]', v => v.textContent));
ok(u1new === 1, `choosing Unit 1 (limit 1, includes Lecture 3): ${u1new} new`);
await p.click('[data-all]');

// inherited settings: the subdeck's cards use the parent's study options
const eff = await DB(async ([l]) => {
  const db = await import('./js/db.js'); const { effectiveDeck } = await import('./js/deck-tree.js');
  await db.saveDeck({ ...(await db.getDeck('sample')), options: { targetRetention: 0.95, learningSteps: '3m', relearningSteps: '10m', maxInterval: 100 }, ttsLang: 'fr-FR' });
  return effectiveDeck(await db.getDecks(), l);
}, [l3.id]);
ok(eff.options?.learningSteps === '3m' && eff.ttsLang === 'fr-FR', 'Lecture 3 inherits options and language');
await DB(async () => { const db = await import('./js/db.js'); await db.clearStates((await db.getAll('cards')).map(c => c.id)); });
await go('#/today', '#optBtn'); await p.click('#optBtn'); await p.waitForSelector('#deckChips'); await p.click(`[data-deck="${l3.id}"]`); await p.click('#optDone'); await p.click('#startBtn'); await p.waitForSelector('.flash');
ok((await p.textContent('.flash-deck')).includes('Unit 1 › Lecture 3'), 'review shows the subdeck path');
await p.keyboard.press(' '); await p.waitForSelector('.rate');
ok(await p.$eval('.rate.r1 span', s => s.textContent) === '3m' || console.log(await p.$$eval('.rate span', s => s.map(x => x.textContent))), "a subdeck card's Again follows the parent's steps (3m)");
await p.click('#endBtn').catch(() => {});

// stats and play include subdecks
await go('#/stats', '#sDeckBtn');
await p.click('#sDeckBtn'); await p.click('.pick-row[data-id="sample"]'); await p.waitForTimeout(200);
ok((await p.textContent('#mTitle + span, .mhead .small')).includes(`${total}`) || (await p.locator('.mtile').count()) === total, 'stats for the parent cover its subdecks');
await go('#/play', '#pDeck');
const pOpts = await p.$$eval('#pDeck option', o => o.map(x => x.textContent));
ok(pOpts.some(t => t.includes('Unit 1 › Lecture 3 (2)')) && pOpts.some(t => t.includes(`(${total})`) && !t.startsWith('All')), 'play deck list with paths and subtree counts: ' + pOpts.join('|'));

// export: CSV has a Deck column
await go('#/deck/sample', '#deckMore'); await deckMenu(p); await p.click('#exportDeck'); await p.waitForSelector('#exCsv');
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exCsv')]);
const csv = (await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
ok(csv.split('\r\n')[0].endsWith(',Deck') && csv.includes('::Unit 1::Lecture 3'), 'CSV has a Deck column with the subdeck path');

// delete the parent, keeping subdecks
await go('#/deck/sample', '#deckMore'); await deckMenu(p); await p.click('#editDeck'); await p.waitForSelector('#deckDelete'); await p.click('#deckDelete');
await p.waitForSelector('#delKeep');
ok((await p.textContent('#delMsg')).includes('2 subdecks') && (await p.textContent('#delMsg')).includes('moves its subdeck to the top level'), 'delete explains the choice: ' + await p.textContent('#delMsg'));
await p.click('#delKeep'); await p.waitForSelector('.deck');
const after = await DB(async () => { const db = await import('./js/db.js'); return { decks: (await db.getDecks()).map(d => [d.name, d.parentId]), cards: (await db.getAll('cards')).length }; });
ok(after.decks.some(([n, pid]) => n === 'Unit 1' && pid === '') && after.cards === 6, 'Unit 1 moved to top level with its 6 cards: ' + JSON.stringify(after));
// delete everything
const u = (await DB(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Unit 1'))).id;
await go('#/deck/' + u, '#deckMore'); await deckMenu(p); await p.click('#editDeck'); await p.waitForSelector('#deckDelete'); await p.click('#deckDelete'); await p.click('#delYes');
await p.waitForTimeout(400);
const left = await DB(async () => { const db = await import('./js/db.js'); return [(await db.getDecks()).length, (await db.getAll('cards')).length]; });
ok(left[0] === 0 && left[1] === 0, 'Delete everything removes the subdecks too: ' + left);

// Anki import keeps subdecks
await go('#/import', '#tab-file'); await p.click('#tab-file');
await p.setInputFiles('#fileIn', SP + '/files/anki-new.apkg');
await p.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
ok(await p.isVisible('#subRow') && (await p.textContent('#subInfo')).includes('Unit 2'), 'offers to keep subdecks: ' + await p.textContent('#subInfo'));
await p.screenshot({ path: SP + '/C-import.png', fullPage: true });
await p.selectOption('#deckSel', '__new'); await p.fill('#newName', 'Psych'); await p.click('#saveBtn'); await p.waitForSelector('.crow');
const imp = await DB(async () => { const db = await import('./js/db.js'); const ds = await db.getDecks(); const cs = await db.getAll('cards');
  return ds.map(d => `${d.name}<${ds.find(x => x.id === d.parentId)?.name || ''}>:${cs.filter(c => c.deckId === d.id).length}`).sort(); });
ok(imp.join() === 'Psych<>:2,Unit 2<Psych>:6', 'imported into Psych with its Unit 2 subdeck: ' + imp.join());
ok((await p.locator('.crow').count()) === 8, 'deck page shows all 8 (the reversed note brings both cards)');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
