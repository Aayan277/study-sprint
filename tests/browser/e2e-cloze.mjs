// Cloze cards in a real browser: saving notes, siblings in Review and Today, the editor, Play, export and import,
// and the "Link cloze cards" tool. Run with: node tests/browser/run.mjs cloze
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');

// ---- 1. saving a note in the database ----
const T = 'The {{c1::mitochondria}} makes {{c2::ATP}} for the {{c3::cell}}';
let r = await page.evaluate(async T => {
  const db = await import('./js/db.js'), cz = await import('./js/cloze.js');
  const deck = (await db.getDecks())[0];
  const noteId = db.newId();
  const siblings = async () => (await db.getAll('cards')).filter(c => c.noteId === noteId).sort((a, b) => a.cloze - b.cloze);
  await db.saveNote(cz.planNoteSave([], T), { deckId: deck.id, noteId, tags: ['bio'] });
  let sibs = await siblings();
  const first = sibs.map(c => ({ cloze: c.cloze, front: c.front, back: c.back, tags: c.tags, at: c.updatedAt }));
  // give c2 and c3 a schedule and a history row, then edit the text: keep c1 and c2, drop c3, add c4
  for (const c of [sibs[1], sibs[2]]) {
    await db.saveReview({ cardId: c.id, due: Date.now() + 864e5, stability: 3, difficulty: 5, reps: 1, lapses: 0, state: 2 },
      { cardId: c.id, timestamp: Date.now(), source: 'review', correct: true, rating: 3, ms: 1, state: 0 });
  }
  const c2 = sibs[1].id, c3 = sibs[2].id;
  const T2 = 'The {{c1::mitochondria}} makes {{c2::ATP}} in the {{c4::cell}}';
  await db.saveNote(cz.planNoteSave(sibs, T2), { deckId: deck.id, noteId, tags: ['bio'], noteExtra: 'Powerhouse' });
  sibs = await siblings();
  const logs = await db.getAll('reviewLog');
  return { first, nums: sibs.map(c => c.cloze), same: new Set(sibs.map(c => c.updatedAt)).size, edited: new Set(sibs.map(c => c.noteEditedAt)).size === 1 && typeof sibs[0].noteEditedAt === 'number' && sibs[0].noteEditedAt >= first[0].at, extra: sibs.map(c => c.noteExtra),
    c2Kept: sibs[1].id === c2 && !!(await db.get('cardStates', c2)) && logs.some(l => l.cardId === c2),
    c3Gone: !(await db.get('cards', c3)) && !(await db.get('cardStates', c3)) && !logs.some(l => l.cardId === c3),
    tombstone: (await db.getAll('deleted')).some(d => d.store === 'cards' && d.id === c3) };
}, T);
ok(r.first.length === 3 && r.first[0].front === 'The […] makes ATP for the cell' && r.first[0].back === 'mitochondria' && r.first.every(c => c.tags[0] === 'bio'), 'saveNote makes one card per blank, with front and back');
ok(new Set(r.first.map(c => c.at)).size === 1, 'all siblings share one save time');
ok(r.nums.join() === '1,2,4' && r.same === 1 && r.extra.every(e => e === 'Powerhouse'), 'edit: c3 gone, c4 added, extra on every card');
ok(r.edited, 'edit: every sibling carries the same noteEditedAt');
ok(r.c2Kept, 'edit: c2 keeps its card, schedule and history');
ok(r.c3Gone && r.tombstone, 'edit: the removed blank deletes its card, schedule and history, leaving a deleted marker');

// ---- 2. the add form: Basic | Cloze ----
await page.click('.deck-open'); await page.waitForSelector('.crow');
const deckUrl = page.url();
const selectIn = (id, word) => page.evaluate(([id, word]) => { const t = document.getElementById(id); const i = t.value.indexOf(word); t.focus(); t.setSelectionRange(i, i + word.length); }, [id, word]);
await page.click('#brAdd'); await page.waitForSelector('#acForm');
ok(await page.isChecked('input[name=acKind][value=basic]') && await page.isVisible('#acFront') && !(await page.isVisible('#acText')), 'add form opens on Basic');
await page.locator('.kind-switch .chip', { hasText: 'Cloze' }).click();
ok(await page.isVisible('#acText') && !(await page.isVisible('#acFront')), 'Cloze shows the text box and hides front/back');
ok((await page.textContent('#acTextPrev')).includes('Select a word'), 'preview asks for a blank at first');
await page.fill('#acText', 'The mitochondria makes ATP for the cell');
await selectIn('acText', 'mitochondria'); await page.click('[data-cloze=new]');
ok((await page.inputValue('#acText')) === 'The {{c1::mitochondria}} makes ATP for the cell', 'New blank wraps the selection as c1');
await selectIn('acText', 'ATP'); await page.click('[data-cloze=new]');
await selectIn('acText', 'cell'); await page.click('[data-cloze=new]');
ok((await page.inputValue('#acText')) === 'The {{c1::mitochondria}} makes {{c2::ATP}} for the {{c3::cell}}', 'blanks are numbered c1, c2, c3');
ok((await page.textContent('#acTextPrev .cloze-makes')) === 'Makes 3 cards: c1 c2 c3', 'preview says: Makes 3 cards: c1 c2 c3');
ok((await page.locator('#acTextPrev mark.cloze-ans').count()) === 3, 'preview highlights the 3 blanks');
await page.fill('#acTags', 'bio');
await page.screenshot({ path: SP + '/cloze-editor-375.png' });
await page.click('button[type=submit][form=acForm]'); await page.waitForFunction(() => document.querySelectorAll('.crow .ckind').length >= 6);
let notes = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.noteText && c.noteText.startsWith('The {{c1::mito') && !c.noteExtra).sort((a, b) => a.cloze - b.cloze));
ok(notes.length === 3 && new Set(notes.map(c => c.noteId)).size === 1 && notes[2].front === 'The mitochondria makes ATP for the […]' && notes[0].tags[0] === 'bio', 'adding saves 3 sibling cards with one noteId');
ok(await page.isVisible('#acText') && (await page.inputValue('#acText')) === '', 'the form stays open on Cloze, cleared, for the next note');
await page.click('#acDone');

// ---- 3. editing a note: add c4, remove c2 with a confirmation ----
const noteCards = () => page.evaluate(async id => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.noteId === id).sort((a, b) => a.cloze - b.cloze), notes[0].noteId);
await page.locator('.crow', { hasText: 'The mitochondria makes ATP for the […]' }).click(); await page.waitForSelector('#ceText');
ok((await page.inputValue('#ceText')) === notes[0].noteText && !(await page.isVisible('input[name=ceKind]').catch(() => false)), 'editing a cloze card opens the whole note (no Basic | Cloze switch)');
await page.fill('#ceText', 'The {{c1::mitochondria}} makes ATP for {{c4::the}} {{c3::cell}}');
await page.click('button[type=submit][form=ceForm]'); await page.waitForSelector('#ceFormConfirm .confirm');
ok((await page.textContent('#ceFormConfirm')).includes('c2 was removed: its card and review history go too'), 'removing a blank asks first, in the page');
ok((await noteCards()).length === 3, 'nothing is deleted before the confirmation');
await page.click('#cfNo'); ok((await noteCards()).length === 3 && await page.isVisible('#ceText'), 'Cancel keeps the note and the editor open');
await page.click('button[type=submit][form=ceForm]'); await page.waitForSelector('#cfYes'); await page.click('#cfYes');
await page.waitForFunction(() => !document.getElementById('ceForm') || !document.querySelector('#ceFormConfirm .confirm'));
await page.waitForTimeout(300);
const after = await noteCards();
ok(after.map(c => c.cloze).join() === '1,3,4' && after.every(c => c.noteText === 'The {{c1::mitochondria}} makes ATP for {{c4::the}} {{c3::cell}}'), 'c2 is gone, c4 is added, every sibling has the new text');
ok(after.find(c => c.cloze === 4).front === 'The mitochondria makes ATP for […] cell' && after.find(c => c.cloze === 1).id === notes[0].id, 'c4 is a new card; c1 kept its own card');

// ---- 3b. the confirmation re-plans when it saves; a double-click saves once ----
if (!(await page.isVisible('#ceText'))) { await page.locator('.crow', { hasText: 'for […] cell' }).click(); await page.waitForSelector('#ceText'); }
await page.fill('#ceText', 'The {{c1::mitochondria}} makes ATP for {{c4::the}} cell');
await page.click('button[type=submit][form=ceForm]'); await page.waitForSelector('#cfYes');
ok((await page.textContent('#ceFormConfirm')).includes('c3 was removed'), 'the question names c3');
await page.fill('#ceText', 'The {{c1::mitochondria}} makes ATP for the cell');            // changed after the question
await page.click('#cfYes');
await page.waitForFunction(() => document.getElementById('ceFormConfirm').textContent.includes('were removed'), null, { timeout: 5000 }).catch(() => {});
ok((await page.textContent('#ceFormConfirm')).includes('c3 and c4 were removed') && (await noteCards()).length === 3, 'text changed since the question: it asks again and saves nothing');
await page.click('#cfNo');
await page.fill('#ceText', 'The {{c1::mitochondria}} makes ATP for {{c4::the}} {{c3::cell}} {{c5::x}}');
await page.evaluate(() => { const f = document.getElementById('ceForm'); f.requestSubmit(); f.requestSubmit(); });
await page.waitForTimeout(500);
ok((await noteCards()).filter(c => c.cloze === 5).length === 1, 'submitting twice adds the new blank once');

// ---- 4. a computer: the Word-style box, the shortcuts, and the short editor ----
{
  const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage();
  desk.on('pageerror', e => errors.push('desk pageerror ' + e.message));
  await desk.addInitScript(() => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } });
  await desk.goto(deckUrl); await desk.waitForSelector('.crow');
  await desk.click('#brAdd'); await desk.waitForSelector('#acForm');
  await desk.locator('.kind-switch .chip', { hasText: 'Cloze' }).click();
  ok(await desk.evaluate(() => !!document.getElementById('acText').dataset.rich), 'on a computer the cloze text is the Word-style box');
  await desk.click('#acText'); await desk.keyboard.type('The cell wall holds the cell');
  await desk.locator('#acText').evaluate(el => { const r = document.createRange(), t = el.firstChild, i = t.textContent.indexOf('wall'); r.setStart(t, i); r.setEnd(t, i + 4); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await desk.keyboard.press('Control+Shift+C');
  await desk.locator('#acText').evaluate(el => { const w = [...el.childNodes].filter(n => n.nodeType === 3).pop(), r = document.createRange(), i = w.textContent.lastIndexOf('cell'); r.setStart(w, i); r.setEnd(w, i + 4); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await desk.keyboard.press('Control+Alt+Shift+C');
  const txt = await desk.evaluate(async () => (await import('./js/card-editor.js')).readCardText('acText'));
  ok(txt === 'The cell {{c1::wall}} holds the {{c1::cell}}', 'Ctrl+Shift+C makes a new blank, Ctrl+Alt+Shift+C reuses the last number: ' + txt);
  ok((await desk.textContent('#acTextPrev .cloze-makes')) === 'Makes 1 card: c1', 'two blanks with one number make one card');
  // nothing selected: the word at the cursor is hidden (not an empty blank)
  await desk.locator('#acText').evaluate(el => { const w = [...el.childNodes].find(n => n.nodeType === 3 && n.textContent.includes('holds')), r = document.createRange(), i = w.textContent.indexOf('holds') + 2; r.setStart(w, i); r.setEnd(w, i); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await desk.click('[data-cloze=new]');
  const withCaret = await desk.evaluate(async () => (await import('./js/card-editor.js')).readCardText('acText'));
  ok(withCaret === 'The cell {{c1::wall}} {{c2::holds}} the {{c1::cell}}', 'New blank with only a cursor hides the word at the cursor: ' + withCaret);
  await desk.click('button[type=submit][form=acForm]'); await desk.waitForFunction(() => document.querySelector('.ckind'));
  await desk.click('#acDone'); await desk.waitForFunction(() => !document.getElementById('sheet').open);
  // the short editor (the one Review and Play open with E)
  await desk.evaluate(async () => { const db = await import('./js/db.js'), b = await import('./js/browse.js');
    const c = (await db.getAll('cards')).find(x => x.noteId && x.cloze === 1);
    b.openCardPanel(c, { decks: await db.getDecks(), statesById: new Map(), mode: 'edit', refresh: async () => {} }); });
  await desk.waitForSelector('#ceText');
  ok(!(await desk.isVisible('#ceFront').catch(() => false)) && (await desk.textContent('#ceTextPrev .cloze-makes')).startsWith('Makes'), 'the short editor opens a cloze card as a cloze note, with the preview');
  await desk.screenshot({ path: SP + '/cloze-editor-1440.png' });
  await desk.close();
}

// ---- 5. Review: one sibling a day, Today agrees, the faces, Exam prep shows all ----
const mk = (name, text, extra = '') => page.evaluate(async ([name, text, extra]) => {
  const db = await import('./js/db.js'), cz = await import('./js/cloze.js');
  const deck = { id: db.newId(), name, color: '#8F80FF', created: Date.now() + Math.random() };
  await db.saveDeck(deck);
  await db.saveNote(cz.planNoteSave([], text), { deckId: deck.id, noteId: db.newId(), tags: [], noteExtra: extra });
  return deck.id;
}, [name, text, extra]);
const bio = await mk('Cell biology', 'The {{c1::mitochondria}} makes {{c2::ATP}} for the {{c3::cell}}', 'Powerhouse of the **cell**');
await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('.tdeck');
const todayRow = async id => (await page.locator(`[data-start="${bio}"]`).textContent().catch(() => '')) || '';
ok(/\b0\s*due.*1\s*new/s.test(await todayRow()), 'Today counts the 3-blank note as 1 new card: ' + (await todayRow()).replace(/\s+/g, ' ').trim());
await page.locator(`[data-start="${bio}"]`).click(); await page.waitForSelector('#flash');
ok((await page.textContent('.rv-counts .c-new')) === '1', 'Review has the same 1 new card');
ok((await page.locator('.rv-front .cloze-blank').count()) === 1 && (await page.textContent('.rv-front .flash-front')).includes('The […] makes ATP for the cell'), 'front: the blank is […], the other answers are shown');
ok((await page.locator('.rv-front').getAttribute('aria-hidden')) === null && (await page.locator('.rv-back').getAttribute('aria-hidden')) === 'true' && await page.locator('.rv-back').evaluate(e => e.inert), 'front face is live, back face is hidden and inert');
await page.waitForFunction(() => document.getElementById('toast').hidden); await page.screenshot({ path: SP + '/cloze-review-front-375.png' });
await page.click('#flash');
ok((await page.textContent('.rv-back mark.cloze-ans')) === 'mitochondria' && (await page.textContent('.rv-back .flash-back')).includes('The mitochondria makes ATP for the cell'), 'back: the full sentence with the answer marked');
ok((await page.locator('.rv-back .flash-extra b').textContent()) === 'cell', 'back: the note\'s Extra is under it, formatted');
ok(await page.locator('.rv-front').evaluate(e => e.inert) && !(await page.locator('.rv-back').evaluate(e => e.inert)), 'after the flip the faces swap (front inert, back live)');
await page.waitForTimeout(700); await page.screenshot({ path: SP + '/cloze-review-back-375.png' });
await page.keyboard.press('4'); await page.waitForSelector('.stats4');
ok((await page.textContent('.stats4')).includes('1'), 'rating is instant; Easy graduates the card and the session ends after one card (the other 2 siblings wait for tomorrow)');
await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('.tdeck');
ok(/\b0\s*due\s*0\s*new/s.test(await todayRow()) || (await page.locator(`a[href="#/deck/${bio}"]`).count()) === 1, 'Today now shows nothing left for the note');
// Exam prep: every sibling that was not seen in the last 3 days
const d5 = new Date(Date.now() + 5 * 864e5), ymd = `${d5.getFullYear()}-${String(d5.getMonth() + 1).padStart(2, '0')}-${String(d5.getDate()).padStart(2, '0')}`;
await page.evaluate(async ([id, ymd]) => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDeck(id)), examDate: ymd }); }, [bio, ymd]);
await page.evaluate(async id => { const sd = await import('./js/study-data.js'); sd.launchStudy({ deckIds: [id], deckId: id, kind: 'prep' }); }, bio);
await page.waitForSelector('#flash');
ok((await page.textContent('.rv-counts .c-new')) === '2', 'Exam prep shows both siblings that were not seen today');
await page.evaluate(() => { location.hash = '#/today'; });

// ---- 6. typed answers, Play, and nothing can inject HTML ----
const geo = await mk('Geography', 'The capital of France is {{c1::Paris}}');
await page.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewTyping', true); });
await page.goto('http://localhost:8123/#/review/' + geo); await page.waitForSelector('#typeIn');
ok((await page.textContent('.rv-front .flash-front')).includes('The capital of France is […]'), 'typed answer: the sentence is the prompt');
await page.fill('#typeIn', 'paris'); await page.click('#typeForm button[type=submit]'); await page.waitForSelector('.typed.ok');
ok((await page.textContent('.rv-back .typed')).includes('Correct') && (await page.textContent('.rv-back mark.cloze-ans')) === 'Paris', 'typing the answer is checked against the hidden words');
await page.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewTyping', false); });
await page.goto('http://localhost:8123/#/play'); await page.waitForSelector('#pDeck');
await page.selectOption('#pDeck', geo); await page.click('#startBtn'); await page.waitForSelector('#pPrompt');
ok((await page.textContent('#pPrompt')).includes('The capital of France is […]'), 'Play asks the sentence with the blank as its prompt');
await page.click('#quitBtn');
const evil = await mk('Injection', 'Try {{c1::<script>window.__pwned=1</script>}} and <img src=x onerror="window.__pwned=2"> {{c2::<b>x</b>}}', '<script>window.__pwned=3</script>');
await page.goto('http://localhost:8123/#/review/' + evil); await page.waitForSelector('#flash');
await page.click('#flash');
const html = await page.innerHTML('#flash');
ok(!html.includes('<script') && !html.includes('<img') && await page.evaluate(() => window.__pwned === undefined), 'HTML in answers, text and Extra is shown as text, never run');
ok((await page.textContent('.rv-back mark.cloze-ans')).includes('<script>'), 'the answer shows the characters as written');

// ---- 7. importing: pasted lines, an Anki file, and an export of our own notes ----
const deckCards = name => page.evaluate(async name => { const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === name);
  return (await db.getAll('cards')).filter(c => c.deckId === d.id).sort((a, b) => a.created - b.created); }, name);
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#pasteBox');
await page.fill('#pasteBox', 'Mitosis - cell division\nMeiosis - division into 4 gametes');
await page.waitForSelector('#plist .prow');
ok(!(await page.isVisible('#clozeBtn')), 'no "Make cloze notes" button for ordinary pasted cards');
await page.fill('#pasteBox', 'The {{c1::cell}} has a {{c2::nucleus}} and {{c3::DNA}}\nPlain line without a blank\nWater is {{c1::H2O}}');
await page.waitForSelector('#clozeBtn:not([hidden])');
await page.click('#clozeBtn'); await page.waitForFunction(() => document.querySelector('#found').textContent.includes('2 cloze notes'));
ok((await page.textContent('#found')).includes('Found 4 cards') && (await page.textContent('#found')).includes('1 line without a blank was left out'), 'paste: Make cloze notes gives 4 cards from 2 notes: ' + (await page.textContent('#found')).slice(0, 120));
ok(await page.locator('.prow textarea[data-side=front]').first().evaluate(t => t.readOnly) && !(await page.isVisible('#swapBtn')), 'cloze rows are read-only and there is nothing to swap');
await page.screenshot({ path: SP + '/cloze-paste-375.png', fullPage: true });
await page.fill('#newName', 'Pasted cloze'); await page.click('#saveBtn'); await page.waitForSelector('.crow');
let pc = await deckCards('Pasted cloze');
ok(pc.length === 4 && new Set(pc.map(c => c.noteId)).size === 2 && pc[0].noteText === 'The {{c1::cell}} has a {{c2::nucleus}} and {{c3::DNA}}' && pc[1].front === 'The cell has a […] and DNA', 'pasted notes saved: 4 cards, 2 notes, text kept');

// an Anki file (a cloze note with two blanks, and ordinary cards)
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/files/anki-new.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
ok((await page.textContent('#found')).includes('1 cloze note make'), 'Anki import: says the cloze note makes the cards');
await page.fill('#newName', 'From Anki cloze'); await page.click('#saveBtn'); await page.waitForSelector('.crow');
const ac = (await page.evaluate(async () => { const db = await import('./js/db.js'); const ds = await db.getDecks(); return (await db.getAll('cards')).filter(c => ds.find(d => d.id === c.deckId)?.name === 'From Anki cloze' || ds.find(d => d.id === c.deckId)?.parentId === ds.find(x => x.name === 'From Anki cloze')?.id); }));
const ak = ac.filter(c => c.noteId).sort((a, b) => a.cloze - b.cloze);
ok(ak.length === 2 && ak[0].noteId === ak[1].noteId && ak.map(c => c.cloze).sort().join() === '1,2' && ak[0].front.includes('[…]') && ak[1].front.includes('[speech area]') && ak[0].noteText.includes('{{c1::'), 'Anki import: the 2-blank cloze note became 2 sibling cards with the note text');
ok(ac.length === 7 && ac.every(c => typeof c.ankiGuid === 'string' && c.ankiGuid), 'Anki import: every card keeps its Anki guid');

// export our own notes as an Anki file and bring them back
await page.goto('http://localhost:8123/#/deck/' + bio); await page.waitForSelector('#exportDeck');
await page.click('#exportDeck'); await page.waitForSelector('#exApkg');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exApkg')]);
await dl.saveAs(SP + '/exports/cloze.apkg');
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/exports/cloze.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
const fr = await page.$$eval('.prow textarea[data-side=front]', t => t.map(x => x.value));
ok(fr.join('|') === 'The […] makes ATP for the cell|The mitochondria makes […] for the cell|The mitochondria makes ATP for the […]', 'export round trip: the Anki file brings the 3 cards back: ' + fr.join('|'));
await page.fill('#newName', 'Round trip'); await page.click('#saveBtn'); await page.waitForSelector('.crow');
const rt = await deckCards('Round trip'), orig = await deckCards('Cell biology');
ok(rt.length === 3 && new Set(rt.map(c => c.noteId)).size === 1 && rt[0].noteText === orig[0].noteText && rt.every(c => c.noteExtra === orig[0].noteExtra), 'round trip: same text and Extra, one note with 3 sibling cards');
ok(rt.every(c => c.ankiGuid === rt[0].ankiGuid) && rt[0].ankiGuid.length === 10, 'round trip: the Anki guid is the note\'s (shared by its cards)');

// ---- 8. the "Link cloze cards" tool (Browse → Tools) ----
const old = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const deck = { id: db.newId(), name: 'Old cloze import', color: '#8F80FF', created: Date.now() + 99 };
  const mkc = (i, front, back) => ({ id: 'old' + i, deckId: deck.id, front, back, tags: [], created: Date.now() + i });
  await db.addDeckWithCards(deck, [
    mkc(1, 'The […] has a nucleus and DNA', 'cell'), mkc(2, 'The cell has a [organelle] and DNA', 'nucleus'), mkc(3, 'The cell has a nucleus and […]', 'DNA'),
    mkc(4, 'Capital of France?', 'Paris'), mkc(5, 'A […] b', 'x'), mkc(6, 'A [hint] b', 'x')]);
  await db.putStates([{ cardId: 'old2', due: Date.now() + 5 * 864e5, stability: 7, difficulty: 4, reps: 3, lapses: 0, state: 2, lastReview: Date.now() - 864e5 }]);
  await db.addLog({ cardId: 'old2', timestamp: Date.now() - 864e5, source: 'review', correct: true, rating: 3, ms: 100, state: 2 });
  return deck.id;
});
await page.goto('http://localhost:8123/#/deck/' + old); await page.waitForSelector('.crow');
await page.click('#brTags'); await page.waitForSelector('#linkFind');
ok((await page.textContent('#sheetTitle')) === 'Tools', 'Browse has a Tools sheet');
await page.click('#linkFind'); await page.waitForSelector('#linkGo');
const prev = await page.textContent('#linkOut');
ok(prev.includes('1 note') && prev.includes('3 cards') && prev.includes('1 group of cards looked unclear'), 'link tool preview: 1 note from 3 cards, 1 unclear group left alone');
ok((await page.locator('#linkOut mark.cloze-ans').count()) === 3, 'the preview shows the note with its 3 blanks');
await page.screenshot({ path: SP + '/cloze-link-375.png' });
ok((await deckCards('Old cloze import')).every(c => !c.noteId), 'nothing changes before you press Link');
await page.click('#linkNo'); await page.click('#linkFind'); await page.waitForSelector('#linkGo'); await page.click('#linkGo');
await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('Linked'));
const linked = await deckCards('Old cloze import');
const mem = linked.filter(c => c.noteId);
ok(mem.length === 3 && new Set(mem.map(c => c.noteId)).size === 1 && mem[0].noteText === 'The {{c1::cell}} has a {{c2::nucleus::organelle}} and {{c3::DNA}}', 'applying links the 3 cards into one note: ' + (mem[0] || {}).noteText);
ok(mem.map(c => c.id).join() === 'old1,old2,old3' && mem[1].front === 'The cell has a [organelle] and DNA' && mem[1].cloze === 2, 'the same cards, same fronts, with their blank numbers');
const kept = await page.evaluate(async () => { const db = await import('./js/db.js'); return { st: await db.get('cardStates', 'old2'), logs: (await db.getCardLogs('old2')).length }; });
ok(kept.st && kept.st.stability === 7 && kept.logs === 1, 'schedule and history are kept');
ok(linked.filter(c => !c.noteId).length === 3, 'the other cards (a plain card and the unclear pair) are untouched');

// ---- a cloze field that is text instead of a number (a hand-edited backup or sync row) can't inject markup ----
await page.evaluate(async deckId => {
  const db = await import('./js/db.js');
  await db.saveCards([{ id: 'xss1', deckId, front: 'xss front', back: 'xss back', noteId: 'X', noteText: 'x', cloze: '1" onmouseover="window.__xss=1" x="' }]);
}, old);
await page.reload(); await page.waitForSelector('.crow');
ok(await page.locator('.crow', { hasText: 'xss front' }).count() === 1 && await page.locator('[onmouseover]').count() === 0, 'a text cloze field does not reach the page as markup');

ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
await browser.close();
