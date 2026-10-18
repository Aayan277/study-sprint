// Anki notes keep their field names (item A): the import preview and its switch, the folded sections on the back in Review (and
// whether they were left open), the card editor, exporting to Anki as <details> and reading it back, and backups.
// Run with: node tests/browser/run.mjs anki-fields
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const ctx = await browser.newContext({ viewport: { width: 375, height: 760 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.stack));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
const run = (fn, arg) => page.evaluate(fn, arg);
const cardsIn = name => run(async n => {
  const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === n);
  return (await db.getCardsInDeck(d.id)).sort((a, b) => a.created - b.created);
}, name);
const load = async file => {
  await page.goto(APP + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
};
const save = async name => { await page.selectOption('#deckSel', '__new'); await page.fill('#newName', name); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 }); };
const closeSheet = async () => { await page.waitForTimeout(500); await page.evaluate(() => { const s = document.getElementById('sheet'); if (s?.open) s.close(); }); await page.waitForTimeout(250); };      // (a moment first: a saved card's panel opens again a moment after the toast; a moment after: the sheet's history entry comes off, see js/nav.js)
const openDeck = async id => { await page.goto(APP + '#/decks'); await page.waitForSelector('.deck'); await page.goto(APP + '#/deck/' + id); await page.waitForSelector('.crow'); };
const until = async (fn, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };
const FA = { name: 'First Aid', text: 'p. 41' }, SK = { name: 'Sketchy', text: 'Video: Heart' };

// ---------- 1. the import preview, in both Anki layouts ----------
for (const [file, name] of [['anki-anking.apkg', 'AnKing new'], ['anki-anking-legacy.apkg', 'AnKing old']]) {
  await load(file);
  const found = await page.textContent('#found');
  ok(found.includes('Found 6 cards'), `${file}: 4 cloze notes make 6 cards: ${found.slice(0, 60)}`);
  ok(found.includes('Other fields come along as folded sections.'), `${file}: the summary says other fields come along as folded sections`);
  ok(found.includes('Pictures in other fields are left out (1).'), `${file}: and counts the field that held only a picture`);
  ok(await page.isVisible('#fieldsRow') && (await page.textContent('#fieldsRow')).includes('Keep the other fields') && (await page.textContent('#fieldsRow')).includes('Anki fields like First Aid or Sketchy stay under the answer, folded, with their names.') && await page.isChecked('#keepFields'), `${file}: the "Keep the other fields" switch is on`);
  if (file === 'anki-anking.apkg') { await page.screenshot({ path: SP + '/fields-import-375.png', fullPage: true }); }
  await save(name);
  const cs = await cardsIn(name);
  const aorta = cs.filter(c => c.noteText?.startsWith('{{c1::Aorta'));
  ok(cs.length === 6 && aorta.length === 2, `${file}: 6 cards, 2 of them the Aorta note`);
  ok(aorta.every(c => c.noteExtra === 'Pumps **oxygenated** blood' && JSON.stringify(c.noteFields) === JSON.stringify([FA, SK])), `${file}: Aorta: Extra stays the open extra; First Aid and Sketchy are named fields on every card of the note`);
  const insulin = cs.find(c => c.noteText?.startsWith('{{c1::Insulin'));
  ok(insulin.noteExtra === 'Made by beta cells' && JSON.stringify(insulin.noteFields) === JSON.stringify([{ name: 'Personal Notes', text: 'My mnemonic: I = in' }, { name: 'First Aid', text: 'p. 335' }]), `${file}: Insulin keeps its Personal Notes and First Aid, in the note type's order`);
  const ace = cs.filter(c => c.noteText?.startsWith('{{c1::ACE'));
  ok(ace.every(c => !c.noteExtra && JSON.stringify(c.noteFields) === JSON.stringify([{ name: 'Pathoma', text: 'Bradykinin builds up' }])), `${file}: ACE has no Extra, no picture-only field, and Pathoma`);
  ok(!cs.find(c => c.noteText?.startsWith('The {{c1::mitral')).noteFields, `${file}: a note with only an Extra has no other fields`);
  ok(aorta[0].tags.includes('#ak_step1_v12::#uworld::step::12345'), `${file}: the question-bank tags come along (lower case): ${aorta[0].tags.join(' ')}`);
}

// ---------- 2. the switch off: one extra block, as before ----------
await load('anki-anking.apkg');
await page.click('#fieldsRow');
ok(!(await page.textContent('#found')).includes('Other fields come along as folded sections.') && !(await page.isChecked('#keepFields')), 'switch off: the summary stops saying so');
await save('AnKing joined');
const joined = (await cardsIn('AnKing joined')).filter(c => c.noteText?.startsWith('{{c1::Aorta'));
ok(joined.every(c => c.noteExtra === 'Pumps **oxygenated** blood\np. 41\nVideo: Heart' && !c.noteFields), 'switch off: the other fields are joined into the extra and there are no named fields');

// ---------- 3. Review: folded sections, and whether they were left open ----------
const deck = await run(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'AnKing new').id);
await page.goto(APP + '#/review/' + deck); await page.waitForSelector('#flash');
const flip = async () => { await page.keyboard.press('Space'); await page.waitForSelector('.rv-back:not([inert])'); };
// find the Aorta card (the order is by when they were added)
for (let i = 0; i < 8 && !(await page.textContent('.rv-front .flash-front')).includes('left ventricle') && !(await page.textContent('.rv-front .flash-front')).includes('Aorta') && !(await page.textContent('.rv-front .flash-front')).includes('[…]'); i++) { await flip(); await page.keyboard.press('3'); await page.waitForTimeout(200); }
await flip();
ok((await page.locator('.rv-back .note-field').count()) >= 1, 'Review: the back shows the note fields as folded sections');
const names = await page.locator('.rv-back .note-field > summary').allTextContents();
ok(names.length >= 1 && (await page.locator('.rv-back .note-field[open]').count()) === 0, 'they start folded: ' + names.join(', '));
await page.screenshot({ path: SP + '/fields-review-folded-375.png' });
ok(await page.evaluate(() => { const e = document.querySelector('.rv-back .flash-extra'), f = document.querySelector('.rv-back .flash-fields'); return !e || !f || e.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING; }), 'and sit after the extra');
// open the first one with the keyboard: Space on the summary toggles it and does not rate the card
await page.focus('.rv-back .note-field > summary');
const before = await page.textContent('.rv-front .flash-front');
await page.keyboard.press('Space');
ok((await page.locator('.rv-back .note-field[open]').count()) === 1 && (await page.textContent('.rv-front .flash-front')) === before && await page.isVisible('.ratebar .rate'), 'Space on a section opens it, and the card is not rated');
await page.screenshot({ path: SP + '/fields-review-open-375.png' });
const openName = await page.locator('.rv-back .note-field[open] > summary').first().textContent();
ok(await page.evaluate(n => localStorage.getItem('study-sprint-fold-field:' + n.toLowerCase()) === '1', openName), `the open state is remembered for "${openName}" on this device`);
await page.reload(); await page.waitForSelector('#flash');
await flip();
const openAfter = await page.locator('.rv-back .note-field[open] > summary').allTextContents();
const closedAfter = await page.locator('.rv-back .note-field:not([open]) > summary').allTextContents();
ok(openAfter.includes(openName) && !closedAfter.includes(openName), `after a reload, "${openName}" is still open`);
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on the back');

// a step-by-step card: its fields wait for the last step, like the extra
await run(async () => {
  const db = await import('./js/db.js');
  await db.saveDeck({ id: 'stp', name: 'Steps', course: '', color: '#46A758', parentId: '', created: Date.now() + 5 });
  await db.saveCards([{ id: 'sc', deckId: 'stp', front: 'Make tea', back: 'Step 1: boil\nStep 2: pour', tags: [], created: Date.now(), noteFields: [{ name: 'First Aid', text: 'p. 1' }] }]);
});
await page.goto(APP + '#/review/stp'); await page.waitForSelector('#flash'); await flip();
ok(await page.evaluate(() => document.querySelector('.rv-back .flash-fields')?.hidden === true), 'a step-by-step card: the fields stay hidden until the last step');
await page.keyboard.press('a');
ok(await page.evaluate(() => document.querySelector('.rv-back .flash-fields')?.hidden === false) && await page.isVisible('.rv-back .note-field'), 'and show with it');

// ---------- 4. the card editor ----------
await page.goto(APP + '#/deck/' + deck); await page.waitForSelector('.crow');
await page.locator('.crow', { hasText: 'Aorta' }).first().click(); await page.waitForSelector('#ceForm');
ok((await page.textContent('#ceFields > summary')).replace(/\s+/g, ' ').trim() === 'Other fields (2)', 'the editor has a fold "Other fields (2)"');
await page.click('#ceFields > summary');
ok((await page.locator('#ceFields .nf-row').count()) === 2 && (await page.textContent('#ceFields .nf-row label')).trim() === 'First Aid' && (await page.inputValue('#ceFields .nf-row textarea')) === 'p. 41', 'one box for each field, labelled with its name');
await page.screenshot({ path: SP + '/fields-editor-375.png' });
await page.fill('#ceNf0', 'p. 41, 42');
await page.locator('#ceFields .nf-row', { hasText: 'Sketchy' }).locator('[data-nf-remove]').click();
ok((await page.textContent('#ceFields > summary')).replace(/\s+/g, ' ').trim() === 'Other fields (1)', 'Remove field takes a field out and the count follows');
await page.click('button[type=submit][form=ceForm]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Saved'));
let aorta = (await cardsIn('AnKing new')).filter(c => c.noteText?.startsWith('{{c1::Aorta'));
ok(aorta.length === 2 && aorta.every(c => JSON.stringify(c.noteFields) === JSON.stringify([{ name: 'First Aid', text: 'p. 41, 42' }])), 'saving a cloze note puts the changed fields on every sibling');
await page.waitForSelector('#ceFields'); await page.click('#ceFields > summary').catch(() => {});
await page.click('#ceFields [data-nf-remove]'); await page.click('button[type=submit][form=ceForm]');
await until(async () => (await cardsIn('AnKing new')).filter(c => c.noteText?.startsWith('{{c1::Aorta')).every(c => !('noteFields' in c)));
aorta = (await cardsIn('AnKing new')).filter(c => c.noteText?.startsWith('{{c1::Aorta'));
ok(aorta.every(c => !('noteFields' in c)) && aorta.every(c => c.noteExtra === 'Pumps **oxygenated** blood'), 'removing every field removes noteFields from every sibling, and the extra stays');
// a basic card with fields
await run(async () => { const db = await import('./js/db.js'); await db.saveCards([{ id: 'bf', deckId: (await db.getDecks()).find(d => d.name === 'AnKing new').id, front: 'Stapes', back: 'Smallest bone', tags: [], created: Date.now(), noteFields: [{ name: 'Source', text: 'Anatomy p. 9' }] }]); });
await openDeck(deck);
await page.locator('.crow', { hasText: 'Stapes' }).click(); await page.waitForSelector('#ceForm');
await page.click('#ceFields > summary'); await page.fill('#ceNf0', 'Anatomy p. 10'); await page.fill('#ceBack', 'Smallest bone in the body');
await page.click('button[type=submit][form=ceForm]'); await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Saved'));
const stapes = await run(async () => (await (await import('./js/db.js')).get('cards', 'bf')));
ok(stapes.back === 'Smallest bone in the body' && JSON.stringify(stapes.noteFields) === JSON.stringify([{ name: 'Source', text: 'Anatomy p. 10' }]), 'a basic card: its other fields are edited and saved too');
// search does not look inside the other fields
await closeSheet();
await openDeck(deck);
await page.fill('#brQuery', 'bradykinin'); await page.waitForTimeout(400);
ok((await page.locator('.crow').count()) === 0, 'Browse search does not look inside the other fields (it stays fast)');
await page.fill('#brQuery', ''); await page.waitForTimeout(300);          // (the search is remembered while the app is open)

// ---------- 5. Anki export and back ----------
const out = await run(async () => {
  const db = await import('./js/db.js'), { makeApkg } = await import('./js/export.js');
  const d = (await db.getDecks()).find(x => x.name === 'AnKing new');
  const blob = await makeApkg(d, await db.getCardsInDeck(d.id));
  const bytes = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
});
fs.writeFileSync(SP + '/files/anking-out.apkg', Buffer.from(out, 'base64'));
await load('anking-out.apkg');
ok((await page.textContent('#found')).includes('Other fields come along as folded sections.') && await page.isVisible('#fieldsRow'), 'export, then import: the sections come back as other fields');
await save('AnKing again');
const before2 = (await cardsIn('AnKing new')), after2 = (await cardsIn('AnKing again'));
const key = c => (c.noteText || c.front) + '|' + (c.noteExtra || '') + '|' + JSON.stringify(c.noteFields || null);
ok(before2.length === after2.length && before2.map(key).sort().join('\n') === after2.map(key).sort().join('\n'), 'and every card has the same text, extra and fields as before');
// backups
const bk = await run(async () => {
  const db = await import('./js/db.js'); const data = await db.exportAll();
  return { err: db.checkBackup(JSON.parse(JSON.stringify(data))), withFields: data.cards.filter(c => c.noteFields).length };
});
ok(bk.err === null && bk.withFields > 0, 'a backup with note fields checks out: ' + JSON.stringify(bk));

// ---------- 6. a computer, light ----------
const wide = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })).newPage();
wide.on('pageerror', e => errors.push('wide pageerror ' + e.stack));
await wide.goto(APP + '#/import'); await wide.waitForSelector('#tab-file'); await wide.click('#tab-file');
await wide.setInputFiles('#fileIn', SP + '/files/anki-anking.apkg');
await wide.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
await wide.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await wide.screenshot({ path: SP + '/fields-import-1440-light.png', fullPage: true });
await wide.selectOption('#deckSel', '__new'); await wide.fill('#newName', 'AnKing wide'); await wide.click('#saveBtn'); await wide.waitForSelector('.crow', { timeout: 30000 });
await wide.goto(APP + '#/review/' + wide.url().split('/deck/')[1]); await wide.waitForSelector('#flash');
for (let i = 0; i < 8; i++) { await wide.keyboard.press('Space'); await wide.waitForSelector('.rv-back:not([inert])'); if (await wide.locator('.rv-back .note-field').count()) break; await wide.keyboard.press('3'); await wide.waitForTimeout(250); }
await wide.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await wide.screenshot({ path: SP + '/fields-review-1440-light.png' });

ok(errors.length === 0, 'no page errors: ' + errors.slice(0, 3).join(' || '));
await browser.close();
