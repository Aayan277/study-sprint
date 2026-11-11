// Undo after deleting cards, a deck, or saving an import (offline/signed-out, and with sync): everything comes back exactly
// (ids, tags, flags, schedules, review history, picture links, exam date, subdecks), and other devices get it back too.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
async function open(fake) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', hasTouch: true });
  if (fake) await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const strip = o => o && Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'updatedAt' && k !== 'syncedAt'));
const dump = (page, cardIds) => page.evaluate(async ids => {
  const db = await import('./js/db.js');
  const out = { cards: {}, states: {}, logs: [], decks: (await db.getDecks()).map(d => d).sort((a, b) => a.id < b.id ? -1 : 1) };
  for (const id of ids) { out.cards[id] = await db.get('cards', id); out.states[id] = await db.get('cardStates', id); out.logs.push(...await db.getCardLogs(id)); }
  out.logs.sort((a, b) => a.id - b.id);
  return out;
}, cardIds);
const same = (a, b) => JSON.stringify({ ...a, cards: Object.values(a.cards).map(strip), states: Object.values(a.states).map(strip), logs: a.logs.map(strip), decks: a.decks.map(strip) })
  === JSON.stringify({ ...b, cards: Object.values(b.cards).map(strip), states: Object.values(b.states).map(strip), logs: b.logs.map(strip), decks: b.decks.map(strip) });
const undoClick = async page => { await page.waitForSelector('#toast:not([hidden]) .toast-link'); await page.click('#toast .toast-link'); };

// ---------- signed out: a card (panel), several cards (Select), a deck, an import ----------
{
  const page = await open(null);
  const ids = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const cards = await db.getAll('cards');
    const ids = cards.slice(0, 3).map(c => c.id);
    await db.putMedia({ id: 'pic-1', type: 'image/png', data: new Uint8Array(40).buffer, size: 40, created: 1, uploaded: false });
    const c0 = await db.get('cards', ids[0]);
    await db.saveCards([{ ...c0, tags: ['alpha', 'beta'], flag: 3, image: 'pic-1' }]);
    for (const [i, id] of ids.entries()) {
      await db.saveReview({ cardId: id, due: Date.now() + 86400000 * (i + 2), stability: 3 + i, difficulty: 5, reps: 2, lapses: 0, state: 2, lastReview: Date.now() }, { cardId: id, timestamp: Date.now() - 1000, source: 'review', rating: 3, correct: true, state: 0 });
      await db.saveReview({ cardId: id, due: Date.now() + 86400000 * (i + 3), stability: 4 + i, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: Date.now() }, { cardId: id, timestamp: Date.now(), source: 'review', rating: 4, correct: true, state: 2 });
    }
    return ids;
  });
  await page.goto(APP + '#/deck/sample'); await page.waitForSelector('.crow');
  const before = await dump(page, ids);
  ok(before.logs.length === 6 && Object.values(before.states).every(Boolean), 'set up: 3 cards with schedules and 6 review rows');

  // one card, from its panel
  await page.locator(`.crow[data-id="${ids[0]}"] .crow-btn`).click(); await page.waitForSelector('#sheet [data-act="delete"]');
  await page.click('#sheet [data-act="delete"]'); await page.click('#cfYes');
  await page.waitForSelector('#toast:not([hidden]) .toast-link');
  ok((await page.textContent('#toast')).includes('Card deleted') && (await page.textContent('#toast .toast-link')) === 'Undo', 'single delete shows an Undo toast');
  const gone = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).length);
  ok(gone === 11 && !(await page.evaluate(async id => !!(await (await import('./js/db.js')).get('cards', id)), ids[0])), 'the card is deleted (11 left)');
  await page.click('#toast .toast-link');
  await page.waitForFunction(() => document.querySelectorAll('.crow').length === 12);
  ok(same(before, await dump(page, ids)), 'Undo: the card is back exactly (tags, flag, picture link, schedule and every review row)');
  ok(!(await page.evaluate(async () => (await (await import('./js/db.js')).getAll('deleted')).some(t => t.store === 'cards'))), 'and its delete markers are gone');

  // several, with Select
  await page.click('#brSelect');
  for (const id of ids) await page.locator(`.crow[data-id="${id}"]`).click();
  await page.click('#brActions'); await page.click('[data-act="delete"]'); await page.click('#cfYes');
  await page.waitForFunction(() => document.querySelectorAll('.crow').length === 9);
  ok((await page.textContent('#toast')).includes('Deleted 3 cards'), 'bulk delete shows an Undo toast');
  const stillThere = await dump(page, ids);
  ok(Object.values(stillThere.cards).every(c => !c) && stillThere.logs.length === 0, 'the 3 cards and their history are gone');
  await undoClick(page);
  await page.waitForFunction(() => document.querySelectorAll('.crow').length === 12);
  const after = await dump(page, ids);
  ok(same(before, after), 'Undo: all 3 cards are back exactly, with their 6 review rows and the same ids');

  // a deck with a subdeck, an exam date, cards and history
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'top', name: 'Top', color: '#46A758', created: Date.now(), examDate: '2031-05-04' }, [{ id: 't1', deckId: 'top', front: 'T1', back: 'b', tags: ['x'], created: 1 }]);
    await db.addDeckWithCards({ id: 'sub', name: 'Sub', color: '#46A758', created: Date.now(), parentId: 'top' }, [{ id: 's1', deckId: 'sub', front: 'S1', back: 'b', tags: [], flag: 2, created: 2 }, { id: 's2', deckId: 'sub', front: 'S2', back: 'b', tags: [], created: 3 }]);
    await db.saveReview({ cardId: 's1', due: Date.now() + 86400000 * 5, stability: 9, difficulty: 4, reps: 4, lapses: 1, state: 2, lastReview: Date.now() }, { cardId: 's1', timestamp: Date.now(), source: 'review', rating: 3, correct: true, state: 2 });
  });
  const deckBefore = await dump(page, ['t1', 's1', 's2']);
  const openDelete = async () => { await page.goto(APP + '#/deck/top'); await page.waitForSelector('#deckMore'); await page.click('#deckMore'); await page.click('#editDeck'); await page.waitForSelector('#deckDelete'); await page.click('#deckDelete'); await page.waitForSelector('#delYes'); };
  await openDelete();
  ok(!(await page.textContent('#delMsg')).includes('undone'), 'the deck confirm no longer says it can’t be undone');
  await page.click('#delYes'); await page.waitForSelector('.deck');
  const gone2 = await page.evaluate(async () => [(await (await import('./js/db.js')).getDecks()).filter(d => ['top', 'sub'].includes(d.id)).length, (await (await import('./js/db.js')).getAll('cards')).filter(c => ['t1', 's1', 's2'].includes(c.id)).length]);
  ok(gone2[0] === 0 && gone2[1] === 0, 'deck and subdeck deleted with their cards');
  await undoClick(page);
  await page.waitForFunction(() => /#\/deck\/top/.test(location.hash));
  const deckAfter = await dump(page, ['t1', 's1', 's2']);
  ok(same(deckBefore, deckAfter) && deckAfter.decks.some(d => d.id === 'top' && d.examDate === '2031-05-04') && deckAfter.decks.some(d => d.id === 'sub' && d.parentId === 'top'), 'Undo: deck, subdeck, exam date, cards, flags, schedule and history are all back');

  // "Delete, keep subdecks" then Undo: the subdeck goes back inside
  await openDelete(); await page.click('#delKeep'); await page.waitForSelector('.deck');
  ok(await page.evaluate(async () => (await (await import('./js/db.js')).getDeck('sub')).parentId === ''), 'keep-subdecks moved Sub to the top level');
  await undoClick(page);
  await page.waitForFunction(() => /#\/deck\/top/.test(location.hash));
  const keepAfter = await dump(page, ['t1', 's1', 's2']);
  ok(same(deckBefore, keepAfter), 'Undo of keep-subdecks: Sub is inside Top again, everything as before');

  // an import
  const n0 = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).length);
  await page.goto(APP + '#/deck/sample'); await page.waitForSelector('.crow');
  await page.click('#deckMore'); await page.click('#importHere'); await page.waitForSelector('#pasteBox');
  await page.fill('#pasteBox', 'Zebra - striped horse\nOkapi - forest giraffe');
  await page.waitForSelector('#preview:not([hidden])');
  await page.click('#saveBtn'); await page.waitForSelector('.crow');
  ok((await page.textContent('#toast')).includes('Added 2 cards'), 'import shows its toast');
  ok(await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).length) === n0 + 2, 'the import added 2 cards');
  await undoClick(page);
  await page.waitForFunction(() => /#\/decks/.test(location.hash));
  const n1 = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).length);
  ok(n1 === n0, 'Undo removed exactly the 2 imported cards');
  const fin = await dump(page, ids); ok(same({ ...before, decks: [] }, { ...fin, decks: [] }), 'and nothing else changed');
  await page.context().close();
}

// ---------- Undo of an import that updated cards: old field values and the old picture come back ----------
{
  const SP = process.argv[2];
  const page = await open(null);
  const importFile = async (file, deckSel, name) => {
    await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
    await page.goto(APP + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
    await page.setInputFiles('#fileIn', SP + '/files/' + file);
    await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
    await page.waitForSelector('#preview[data-guids]');
    await page.selectOption('#deckSel', deckSel);
    if (name) await page.fill('#newName', name); else await page.waitForSelector('#updRow:not([hidden])');
    return page;
  };
  const imported = () => page.evaluate(async () => {
    const db = await import('./js/db.js');
    return { cards: (await db.getAll('cards')).filter(c => c.ankiGuid).sort((a, b) => (a.id < b.id ? -1 : 1)), media: (await db.mediaKeys()).sort() };
  });
  await importFile('anki-update-v1.apkg', '__new', 'Undo update');
  await page.click('#saveBtn'); await page.waitForSelector('.crow');
  const deckId = await page.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Undo update').id);
  const first = await imported();
  const alpha = first.cards.find(c => c.front === 'Alpha');
  ok(first.cards.length === 6 && alpha.backImage && first.media.includes(alpha.backImage), 'update-undo: the first import has 6 cards and Alpha has its picture');
  // The old picture is old enough for the daily clean-up to remove it once nothing uses it.
  await page.evaluate(async id => { const db = await import('./js/db.js'); const m = await db.getMedia(id); await db.putMedia({ ...m, created: 1 }); }, alpha.backImage);

  await importFile('anki-update-v3.apkg', deckId);
  await page.click('#saveBtn'); await page.waitForFunction(() => /Updated/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  ok((await page.textContent('#toast')).includes('Updated'), 'update-undo: the second import updated cards');
  const mid = await imported();
  const alphaNew = mid.cards.find(c => c.id === alpha.id);
  ok(alphaNew.front === 'Alpha (revised)' && alphaNew.backImage && alphaNew.backImage !== alpha.backImage, 'update-undo: Alpha has new text and a different picture');
  const cleaned = await page.evaluate(async () => (await import('./js/db.js')).cleanMedia(Date.now() + 5 * 3600e3));
  ok(cleaned.length === 0 && (await imported()).media.includes(alpha.backImage), 'update-undo: while the Undo toast can be used, the clean-up keeps the old picture');
  await undoClick(page);
  await page.waitForFunction(() => /#\/decks/.test(location.hash));
  const back = await imported();
  const alphaBack = back.cards.find(c => c.id === alpha.id);
  ok(back.cards.length === 6 && alphaBack.front === 'Alpha' && alphaBack.backImage === alpha.backImage, 'update-undo: Undo brings back the old text and the old picture link, and the new notes are gone');
  ok(back.media.includes(alpha.backImage) && !!(await page.evaluate(async id => (await (await import('./js/db.js')).getMedia(id))?.data?.byteLength > 0, alpha.backImage)), 'update-undo: the old picture is still stored');
  ok(JSON.stringify(back.cards.map(strip)) === JSON.stringify(first.cards.map(strip)), 'update-undo: every imported card has exactly its old values again');
  await page.context().close();
}

// ---------- Undo of an import with "Bring over my Anki progress" on: the imported review history goes too ----------
{
  const SP = process.argv[2];
  const page = await open(null);
  const counts = () => page.evaluate(async () => {
    const db = await import('./js/db.js');
    const ids = new Set((await db.getAll('cards')).filter(c => c.ankiGuid).map(c => c.id));
    return { cards: ids.size, logs: (await db.getAll('reviewLog')).length, states: (await db.getAll('cardStates')).length,
      importedStates: (await db.getAll('cardStates')).filter(s => ids.has(s.cardId)).length };
  });
  const before = await counts();
  await page.goto(APP + '#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/anki-sched-new.apkg');
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  await page.waitForSelector('#preview[data-guids]');
  ok(await page.isVisible('#progRow') && await page.isChecked('#ankiProg'), 'progress-undo: "Bring over my Anki progress" is shown and on');
  await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Undo progress');
  await page.click('#saveBtn'); await page.waitForSelector('.crow');
  await page.waitForFunction(() => /with Anki progress/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 30000 });
  const after = await counts();
  ok(after.cards > before.cards && after.logs > before.logs && after.states > before.states && after.importedStates > 0, `progress-undo: the import added cards (${after.cards - before.cards}), review rows (${after.logs - before.logs}) and schedules (${after.states - before.states})`);
  await undoClick(page);
  await page.waitForFunction(() => /#\/decks/.test(location.hash));
  const back = await counts();
  ok(back.cards === before.cards && back.logs === before.logs && back.states === before.states && back.importedStates === before.importedStates, `progress-undo: Undo takes the review history and schedules back out (reviewLog ${before.logs} -> ${after.logs} -> ${back.logs}, cardStates ${before.states} -> ${after.states} -> ${back.states})`);
  await page.context().close();
}

// ---------- with sync: the delete has already been sent when Undo is pressed ----------
{
  const fake = fakeSupabase();
  const A = await open(fake), B = await open(fake);
  const sync = p => p.evaluate(async () => { await (await import('./js/sync.js')).syncNow(); });
  await A.goto(APP + '#/settings'); await A.waitForSelector('#syncEmail');
  await A.fill('#syncEmail', 'me@example.com'); await A.fill('#syncPw', 'secret123'); await A.click('#syncCreate');
  await A.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  const id = await A.evaluate(async () => {
    const db = await import('./js/db.js');
    const c = (await db.getAll('cards'))[0];
    await db.saveReview({ cardId: c.id, due: Date.now() + 86400000, stability: 3, difficulty: 5, reps: 2, lapses: 0, state: 2, lastReview: Date.now() }, { cardId: c.id, timestamp: Date.now(), source: 'review', rating: 3, correct: true, state: 0 });
    await (await import('./js/sync.js')).syncNow();
    return c.id;
  });
  const row = () => fake.userRows('me@example.com').find(r => r.store === 'cards' && r.id === id);
  ok(row() && !row().deleted, 'sync: the card is on the server');
  // delete through the app, let the delete reach the server, then Undo
  await A.evaluate(async cid => {
    const db = await import('./js/db.js');
    window.__snap = await db.deleteCards([cid]);
    await (await import('./js/sync.js')).syncNow();
  }, id);
  ok(row().deleted === true, 'sync: the delete reached the server');
  await A.waitForTimeout(20);
  await A.evaluate(async () => { await (await import('./js/db.js')).restoreSnapshot(window.__snap); await (await import('./js/sync.js')).syncNow(); });
  ok(row() && row().deleted === false && row().data?.front, 'sync: after Undo and a sync the server has the card again (not deleted)');
  ok(fake.userRows('me@example.com').some(r => r.store === 'cardStates' && r.id === id && !r.deleted) && fake.userRows('me@example.com').some(r => r.store === 'reviewLog' && !r.deleted && r.data.cardId === id), 'sync: its schedule and review history are back on the server too');
  // device B signs in and gets the card, including its history
  await B.goto(APP + '#/settings'); await B.waitForSelector('#syncEmail');
  await B.fill('#syncEmail', 'me@example.com'); await B.fill('#syncPw', 'secret123'); await B.click('#syncForm button[type=submit]');
  await B.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  ok(await B.evaluate(async cid => !!(await (await import('./js/db.js')).get('cards', cid)) && !!(await (await import('./js/db.js')).get('cardStates', cid)), id), 'sync: device B has the restored card and schedule');
  // B deletes, syncs; A undoes after B's delete arrived at A: A's restored card wins on B
  await B.evaluate(async cid => { const db = await import('./js/db.js'); window.__snap = await db.deleteCards([cid]); await (await import('./js/sync.js')).syncNow(); }, id);
  await sync(A);
  ok(await A.evaluate(async cid => !(await (await import('./js/db.js')).get('cards', cid)), id), 'sync: a delete made on B reaches A');
  await B.evaluate(async () => { await (await import('./js/db.js')).restoreSnapshot(window.__snap); await (await import('./js/sync.js')).syncNow(); });
  await sync(A);
  ok(await A.evaluate(async cid => !!(await (await import('./js/db.js')).get('cards', cid)), id), 'sync: B’s Undo brings the card back on A');
  await A.context().close(); await B.context().close();
}
// ---------- the leech coach (Review finish / Play results): Delete and "Split, delete the original" can be undone ----------
{
  const page = await open(null);
  const setup = () => page.evaluate(async () => {
    const db = await import('./js/db.js'); const now = Date.now();
    await db.addDeckWithCards({ id: 'lc', name: 'Coach', color: '#46A758', created: now }, [
      { id: 'LC1', deckId: 'lc', front: 'Primary colours', back: 'red; green; blue', tags: ['lc', 'leech'], suspended: true, created: now },
      { id: 'LC2', deckId: 'lc', front: 'Ribosome', back: 'Makes proteins', tags: ['lc', 'leech'], suspended: true, created: now }]);
    for (const id of ['LC1', 'LC2']) {
      await db.saveReview({ cardId: id, due: now + 86400000, stability: 4, difficulty: 5, reps: 3, lapses: 2, state: 2, lastReview: now }, { cardId: id, timestamp: now - 1000, source: 'review', rating: 1, correct: false, state: 2 });
      await db.saveReview({ cardId: id, due: now + 86400000 * 2, stability: 5, difficulty: 5, reps: 4, lapses: 2, state: 2, lastReview: now }, { cardId: id, timestamp: now, source: 'review', rating: 3, correct: true, state: 2 });
    }
    const m = await import('./js/leech-coach.js');
    const slot = document.createElement('div'); slot.id = 'coachSlot'; (document.querySelector('main') || document.body).prepend(slot);
    slot.innerHTML = await m.coachHTML(['LC1', 'LC2']); m.wireCoach(slot);
  });
  await setup();
  const before = await dump(page, ['LC1', 'LC2']);
  ok(before.logs.length === 4, 'coach set up: 2 cards, 4 review rows');
  // Delete, then Undo
  await page.click('.coach-row[data-id=LC2] [data-act=delete]'); await page.waitForSelector('.coach-confirm .confirm');
  ok(/You can undo this/.test(await page.textContent('.coach-row[data-id=LC2] .coach-confirm')), 'coach Delete says it can be undone, not that it can’t');
  await page.click('.coach-confirm [data-yes]');
  await page.waitForFunction(() => !document.querySelector('.coach-row[data-id=LC2]'));
  ok(await page.evaluate(async () => { const db = await import('./js/db.js'); return !(await db.get('cards', 'LC2')) && !(await db.get('cardStates', 'LC2')) && !(await db.getCardLogs('LC2')).length; }), 'coach Delete removes the card, its state and its log rows');
  ok(/Card deleted/.test(await page.textContent('#toast')), 'the toast says "Card deleted" with an Undo link');
  await undoClick(page);
  await page.waitForFunction(() => /Card restored/.test(document.querySelector('#toast')?.textContent || ''));
  const mid = await dump(page, ['LC1', 'LC2']);
  ok(same(before, mid), 'Undo brings the card, its schedule and both log rows back exactly');
  // Split, delete the original, then Undo
  await page.click('.coach-row[data-id=LC1] [data-act=split]'); await page.waitForSelector('#splitForm');
  await page.check('input[name=splitOrig][value=delete]');
  await page.click('#splitForm button[type=submit], #sheet button[form=splitForm]'); await page.waitForSelector('#cfYes');
  ok(/You can undo this/.test(await page.textContent('#splitConfirm')), 'the split sheet confirm says it can be undone');
  await page.click('#cfYes'); await page.waitForFunction(() => !document.querySelector('#sheet[open]'));
  ok(await page.evaluate(async () => { const db = await import('./js/db.js'); const all = await db.getAll('cards'); return !all.some(c => c.id === 'LC1') && all.filter(c => c.front === 'Primary colours').length === 3; }), 'Split and delete: the original is gone and 3 new cards exist');
  await undoClick(page);
  await page.waitForFunction(() => /Card restored/.test(document.querySelector('#toast')?.textContent || ''));
  const after = await dump(page, ['LC1', 'LC2']);
  ok(same(before, after), 'Undo restores the original with its schedule and history');
  ok(await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.front === 'Primary colours').length === 1), 'Undo removes the split parts: only the original is left');
  await page.context().close();
}
if (errors.length) { console.log('FAIL errors: ' + errors.join(' | ')); process.exitCode = 1; } else ok(true, 'no page errors');
await browser.close();
