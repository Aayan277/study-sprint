// Recently deleted (Settings → Your data → More settings): every delete is kept on this device for 30 days and can be restored
// exactly (ids, schedules, review rows), by hand and through sync; Undo removes the entry; purge, wipes, accounts and big decks.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const DAY = 86400000;
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
const entries = page => page.evaluate(async () => (await (await import('./js/trash.js')).list()).map(e => ({ id: e.id, kind: e.kind, title: e.title, counts: e.counts, parts: e.parts, userId: e.userId })));
const allEntries = page => page.evaluate(async () => (await (await import('./js/trash-db.js')).listEntries()));
const openSheet = async page => { await page.goto(APP + '#/settings'); await page.waitForSelector('#trashRow'); await page.evaluate(async () => (await import('./js/trash-sheet.js')).openTrashSheet()); await page.waitForSelector('#trList'); };
const rows = page => page.locator('#trList .tr-row');
const review = (page, id, n = 2) => page.evaluate(async ([cid, k]) => {
  const db = await import('./js/db.js');
  for (let i = 0; i < k; i++) await db.saveReview({ cardId: cid, due: Date.now() + 86400000 * (i + 2), stability: 3 + i, difficulty: 5, reps: i + 1, lapses: 0, state: 2, lastReview: Date.now() }, { cardId: cid, timestamp: Date.now() - 1000 * (k - i), source: 'review', rating: 3, correct: true, state: i ? 2 : 0 });
}, [id, n]);

// ---------- signed out ----------
{
  const page = await open(null);
  ok(await page.evaluate(() => new Promise(r => { const q = indexedDB.open('study-sprint-trash'); q.onsuccess = () => { q.result.close(); r(true); }; q.onerror = () => r(false); })) === true, 'sanity: the browser can open the trash database');
  await page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('study-sprint-trash'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  const mainVersion = await page.evaluate(() => new Promise(r => { const q = indexedDB.open('study-sprint'); q.onsuccess = () => { const v = q.result.version; q.result.close(); r(v); }; }));
  ok(mainVersion === 3, 'the main database is still version 3');

  const ids = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const cards = await db.getAll('cards');
    const ids = cards.slice(0, 3).map(c => c.id);
    await db.putMedia({ id: 'pic-1', type: 'image/png', data: new Uint8Array(40).buffer, size: 40, created: 1, uploaded: false });
    const c0 = await db.get('cards', ids[0]);
    await db.saveCards([{ ...c0, tags: ['alpha', 'beta'], flag: 3, frontImage: 'pic-1' }]);
    return ids;
  });
  for (const id of ids) await review(page, id);
  await page.goto(APP + '#/deck/sample'); await page.waitForSelector('.crow');
  const before = await dump(page, ids);
  ok(before.logs.length === 6, 'set up: 3 cards with schedules and 6 review rows');
  ok(await page.evaluate(() => !document.body.textContent.includes('Recently deleted')), 'nothing on the Browse screen mentions Recently deleted');
  ok((await entries(page)).length === 0 && await page.evaluate(() => indexedDB.databases ? indexedDB.databases().then(l => !l.some(d => d.name === 'study-sprint-trash')) : true), 'before any delete there is no list and no trash database is made');

  // --- one card: delete (the toast does not advertise the list), Undo takes the entry out ---
  await page.locator(`.crow[data-id="${ids[0]}"] .crow-btn`).click(); await page.waitForSelector('#sheet [data-act="delete"]');
  await page.click('#sheet [data-act="delete"]');
  ok(!/Recently deleted|30 days/.test(await page.textContent('#ceConfirm')), 'the delete confirm does not mention Recently deleted (placement decision)');
  await page.click('#cfYes');
  await page.waitForSelector('#toast:not([hidden]) .toast-link');
  ok(!/Recently deleted|30 days/.test(await page.textContent('#toast')), 'the delete toast does not mention Recently deleted');
  let list = await entries(page);
  ok(list.length === 1 && list[0].kind === 'cards' && list[0].counts.cards === 1 && list[0].counts.reviews === 2, 'a card delete makes one entry (1 card, 2 reviews)');
  await page.click('#toast .toast-link');
  await page.waitForFunction(() => document.querySelectorAll('.crow').length === 12);
  ok((await entries(page)).length === 0, 'Undo removes the entry: nothing shows twice');
  ok(same(before, await dump(page, ids)), 'and Undo still brings the card back exactly');

  // --- one card, then restore it from the list ---
  await page.locator(`.crow[data-id="${ids[0]}"] .crow-btn`).click(); await page.waitForSelector('#sheet [data-act="delete"]');
  await page.click('#sheet [data-act="delete"]'); await page.click('#cfYes');
  await page.waitForFunction(() => document.querySelectorAll('.crow').length === 11);
  await page.waitForSelector('#toast:not([hidden]) .toast-link');
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await page.goto(APP + '#/settings'); await page.waitForSelector('#trashRow');
  ok(await page.evaluate(() => !!document.querySelector('#moreData #trashRow') && document.querySelector('#trashRow').textContent.includes('Recently deleted')), 'Settings → Your data → More settings has the Recently deleted row');
  ok(await page.evaluate(() => { const r = document.querySelector('#trashRow'); return !/\d/.test(r.textContent.replace('Recently deleted', '')) && !r.querySelector('.badge'); }), 'the row shows no count and no size');
  ok(await page.getAttribute('#trashRow .help-link', 'aria-label') === 'About Recently deleted', 'the "?" next to it has an aria-label');
  await page.click('#trashBtn'); await page.waitForSelector('#trList .tr-row');
  ok(await rows(page).count() === 1, 'the sheet lists the deleted card');
  const txt = await rows(page).first().textContent();
  ok(/1 card/.test(txt) && /2 reviews/.test(txt) && /Deleted today/.test(txt), 'the row shows its count line and "Deleted today"');
  ok(await page.getAttribute('#sheet .sheet-x', 'aria-label') === 'Close', 'icon-only controls have an aria-label (the sheet close button)');
  await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/sample/.test(location.hash) && document.querySelectorAll('.crow').length === 12);
  ok(/Restored/.test(await page.textContent('#toast')), 'Restore shows a "Restored" toast and goes to the deck');
  ok(same(before, await dump(page, ids)), 'Restore: the card is back exactly (ids, tags, flag, picture link, schedule, both review rows)');
  ok((await entries(page)).length === 0, 'the restored entry is gone from the list');
  ok(!(await page.evaluate(async id => (await (await import('./js/db.js')).getAll('deleted')).some(t => t.store === 'cards' && t.id === id), ids[0])), 'its delete markers are gone');

  // --- bulk delete (Select), then restore ---
  await page.click('#brSelect');
  for (const id of ids) await page.locator(`.crow[data-id="${id}"]`).click();
  await page.click('#brActions'); await page.click('[data-act="delete"]'); await page.click('#cfYes');
  await page.waitForFunction(() => document.querySelectorAll('.crow').length === 9);
  list = await entries(page);
  ok(list.length === 1 && list[0].counts.cards === 3 && list[0].counts.reviews === 6 && /3 cards/.test(list[0].title), 'a bulk delete makes one entry (3 cards, 6 reviews)');
  await openSheet(page);
  await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => document.querySelectorAll('.crow').length === 12);
  ok(same(before, await dump(page, ids)), 'bulk Restore: all 3 cards are back exactly, with their 6 review rows and the same ids');

  // --- a deck with a subdeck, an exam date, cards and history ---
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'top', name: 'Top', color: '#46A758', created: Date.now(), examDate: '2031-05-04' }, [{ id: 't1', deckId: 'top', front: 'T1', back: 'b', tags: ['x'], created: 1 }]);
    await db.addDeckWithCards({ id: 'sub', name: 'Sub', color: '#46A758', created: Date.now(), parentId: 'top' }, [{ id: 's1', deckId: 'sub', front: 'S1', back: 'b', tags: [], flag: 2, created: 2 }, { id: 's2', deckId: 'sub', front: 'S2', back: 'b', tags: [], created: 3 }]);
  });
  await review(page, 's1', 3);
  const deckBefore = await dump(page, ['t1', 's1', 's2']);
  const openDelete = async () => { await page.goto(APP + '#/deck/top'); await page.waitForSelector('#deckMore'); await page.click('#deckMore'); await page.click('#editDeck'); await page.waitForSelector('#deckDelete'); await page.click('#deckDelete'); await page.waitForSelector('#delYes'); };
  await openDelete();
  ok(/You can undo this for a few seconds/.test(await page.textContent('#delMsg')), 'the deck confirm keeps its existing Undo wording');
  await page.click('#delYes'); await page.waitForSelector('.deck');
  list = await entries(page);
  ok(list.length === 1 && list[0].kind === 'deck' && list[0].title === 'Top' && list[0].counts.cards === 3 && list[0].counts.reviews === 3, 'deleting a deck with a subdeck makes ONE deck entry (3 cards, 3 reviews)');
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await openSheet(page);
  ok(/Top/.test(await rows(page).first().textContent()), 'the sheet shows the deck by name');
  await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/top/.test(location.hash));
  const deckAfter = await dump(page, ['t1', 's1', 's2']);
  ok(same(deckBefore, deckAfter) && deckAfter.decks.some(d => d.id === 'top' && d.examDate === '2031-05-04') && deckAfter.decks.some(d => d.id === 'sub' && d.parentId === 'top'), 'deck Restore: deck, subdeck, exam date, cards, flags, schedules and history are all back exactly');

  // --- Delete, keep subdecks, then restore: the subdeck goes back inside ---
  await openDelete(); await page.click('#delKeep'); await page.waitForSelector('.deck');
  ok(await page.evaluate(async () => (await (await import('./js/db.js')).getDeck('sub')).parentId === ''), 'keep-subdecks moved Sub to the top level');
  list = await entries(page);
  ok(list.length === 1 && list[0].counts.cards === 1, 'keep-subdecks: the entry holds only the deck\'s own card');
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/top/.test(location.hash));
  ok(same(deckBefore, await dump(page, ['t1', 's1', 's2'])), 'keep-subdecks Restore: Sub is inside Top again, everything as before');
  // ... but if Sub was moved on by hand since, Restore leaves it where it is
  await openDelete(); await page.click('#delKeep'); await page.waitForSelector('.deck');
  await page.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDeck('sub')), name: 'Sub renamed' }); });
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/top/.test(location.hash));
  const subNow = await page.evaluate(async () => (await import('./js/db.js')).getDeck('sub'));
  ok(subNow.name === 'Sub renamed' && subNow.parentId === '', 'a subdeck that changed since the delete is left as it is (rule 4)');
  ok(/changed on another device/.test(await page.textContent('#toast')), 'and the toast says one change was left as it is');
  await page.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDeck('sub')), name: 'Sub', parentId: 'top' }); });

  // --- the leech coach delete ---
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const now = Date.now();
    await db.addDeckWithCards({ id: 'lc', name: 'Coach', color: '#46A758', created: now }, [
      { id: 'LC1', deckId: 'lc', front: 'Primary colours', back: 'red; green; blue', tags: ['lc', 'leech'], suspended: true, created: now }]);
    const m = await import('./js/leech-coach.js');
    const slot = document.createElement('div'); slot.id = 'coachSlot'; (document.querySelector('main') || document.body).prepend(slot);
    slot.innerHTML = await m.coachHTML(['LC1']); m.wireCoach(slot);
  });
  await review(page, 'LC1', 2);
  const lcBefore = await dump(page, ['LC1']);
  await page.click('.coach-row[data-id=LC1] [data-act=delete]'); await page.waitForSelector('.coach-confirm .confirm');
  await page.click('.coach-confirm [data-yes]');
  await page.waitForFunction(() => !document.querySelector('.coach-row[data-id=LC1]'));
  list = await entries(page);
  ok(list.length === 1 && list[0].counts.cards === 1, 'the leech coach Delete makes an entry');
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/lc/.test(location.hash));
  ok(same(lcBefore, await dump(page, ['LC1'])), 'leech Restore: the card is back with its schedule and history');

  // --- a pair: delete only one card, then restore: the pair is whole again ---
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const now = Date.now();
    await db.addDeckWithCards({ id: 'pp', name: 'Pairs', color: '#46A758', created: now }, [
      { id: 'P1', deckId: 'pp', front: 'cat', back: 'gato', tags: [], created: now, noteId: 'N1', reverse: false, noteEditedAt: now },
      { id: 'P2', deckId: 'pp', front: 'gato', back: 'cat', tags: [], created: now, noteId: 'N1', reverse: true, noteEditedAt: now }]);
  });
  const pairBefore = await dump(page, ['P1', 'P2']);
  await page.evaluate(async () => {   // what "Only this one" does: delete P1, turn P2 into an ordinary card
    const db = await import('./js/db.js'); const { unpaired } = await import('./js/reverse.js'); const t = await import('./js/trash-lazy.js');
    const partner = await db.get('cards', 'P2');
    const snap = await db.deleteCards(['P1']); snap.cards.push(partner); await db.saveCards([unpaired(partner)]);
    await t.keepDeleted(snap, { before: { cards: [partner] } });
  });
  ok(await page.evaluate(async () => !(await (await import('./js/db.js')).get('cards', 'P2')).noteId), 'set up: the partner became an ordinary card');
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/pp/.test(location.hash));
  ok(same(pairBefore, await dump(page, ['P1', 'P2'])), 'pair Restore: the card AND its partner are paired again, exactly as before');
  // the same, but the partner was edited since: the newer partner stays, and the restored card comes back as an ordinary card
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const { unpaired } = await import('./js/reverse.js'); const t = await import('./js/trash-lazy.js');
    const partner = await db.get('cards', 'P2');
    const snap = await db.deleteCards(['P1']); snap.cards.push(partner); await db.saveCards([unpaired(partner)]);
    await t.keepDeleted(snap, { before: { cards: [partner] } });
    await db.saveCards([{ ...(await db.get('cards', 'P2')), back: 'cat (edited later)' }]);
  });
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/pp/.test(location.hash));
  const pr = await page.evaluate(async () => { const db = await import('./js/db.js'); return [await db.get('cards', 'P1'), await db.get('cards', 'P2')]; });
  ok(pr[0] && !pr[0].noteId && pr[1].back === 'cat (edited later)' && !pr[1].noteId, 'pair whose partner changed later: the partner stays as edited, and the restored card is an ordinary card (not half a pair)');

  // --- Delete now and Empty ---
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    for (const id of ['LC1', 'P1']) { const snap = await db.deleteCards([id]); await t.keepDeleted(snap); }
  });
  await openSheet(page);
  ok(await rows(page).count() === 2, 'two entries are listed');
  await page.locator('#trList [data-act="drop"]').first().click();
  ok(/for good/.test(await page.textContent('#trList')) && /can't be undone/.test(await page.textContent('#trList')), 'Delete now asks first: "Delete for good? This can\'t be undone."');
  await page.click('#trList .confirm button:has-text("Cancel")');
  ok(await rows(page).count() === 2, 'Cancel keeps both');
  await page.locator('#trList [data-act="drop"]').first().click();
  await page.click('#trList .confirm button:has-text("Delete for good")');
  await page.waitForFunction(() => document.querySelectorAll('#trList .tr-row').length === 1);
  ok((await entries(page)).length === 1, 'Delete now removes one entry for good');
  await page.click('#trEmpty');
  ok(/for good/.test(await page.textContent('#trBox')), 'Empty asks first');
  await page.click('#trBox .confirm button:has-text("Empty")');
  await page.waitForFunction(() => document.querySelectorAll('#trList .tr-row').length === 0);
  ok((await entries(page)).length === 0 && await page.isHidden('#trEmpty') && (await page.textContent('#trList')).includes('Nothing here'), 'Empty clears the list and shows the empty state');
  await page.keyboard.press('Escape');

  // --- a card whose deck is also in Recently deleted ---
  const mk = () => page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    await db.addDeckWithCards({ id: 'dx', name: 'Doomed', color: '#46A758', created: Date.now() }, [{ id: 'x1', deckId: 'dx', front: 'X1', back: 'b', tags: [], created: 1 }, { id: 'x2', deckId: 'dx', front: 'X2', back: 'b', tags: [], created: 2 }]);
    const s1 = await db.deleteCards(['x1']); await t.keepDeleted(s1);
    const s2 = await db.deleteDeck('dx'); await t.keepDeleted(s2, { kind: 'deck', title: 'Doomed', deckId: 'dx' });
  });
  await mk();
  await review(page, 'x2', 1).catch(() => {});
  await openSheet(page);
  ok(await rows(page).count() === 2, 'the single card and the deck are two entries');
  await page.locator('#trList .tr-row', { hasText: 'X1' }).locator('[data-act="restore"]').click();
  await page.waitForSelector('#trList .confirm');
  ok(/Its deck “Doomed” was deleted too\./.test(await page.textContent('#trList .confirm')), 'a card whose deck is in Recently deleted asks about it');
  await page.click('#trList .confirm button:has-text("Restore “Doomed” too")');
  await page.waitForFunction(() => /#\/deck\/dx/.test(location.hash));
  ok(await page.evaluate(async () => !!(await (await import('./js/db.js')).getDeck('dx')) && !!(await (await import('./js/db.js')).get('cards', 'x1')) && !!(await (await import('./js/db.js')).get('cards', 'x2'))), 'Restore “Doomed” too: the deck first, then both cards are back');
  ok((await entries(page)).length === 0, 'both entries are gone from the list');

  // ... the deck is gone for good: Choose a deck
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    const s1 = await db.deleteCards(['x1']); await t.keepDeleted(s1);
    const s2 = await db.deleteDeck('dx'); await t.keepDeleted(s2, { kind: 'deck', title: 'Doomed', deckId: 'dx' });
    const tr = await import('./js/trash.js'); for (const e of await tr.list()) if (e.kind === 'deck') await tr.deleteNow(e);
  });
  await openSheet(page);
  await page.locator('#trList [data-act="restore"]').click();
  await page.waitForSelector('#trList .confirm');
  ok(/Its deck “Doomed” is gone\./.test(await page.textContent('#trList .confirm')) && await page.locator('#trList .confirm button:has-text("Restore “Doomed” too")').count() === 0, 'a card whose deck is gone for good goes straight to "Choose a deck"');
  await page.click('#trList .confirm button:has-text("Choose a deck")');
  await page.waitForSelector('#pickList .pick-row');
  await page.click('#pickList .pick-row[data-id="sample"]');
  await page.waitForFunction(() => /#\/deck\/sample/.test(location.hash));
  ok(await page.evaluate(async () => (await (await import('./js/db.js')).get('cards', 'x1'))?.deckId === 'sample'), 'the card is restored into the deck that was chosen');

  // --- a subdeck whose parent is gone for good ---
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    await db.addDeckWithCards({ id: 'gp', name: 'Grand', color: '#46A758', created: Date.now() }, []);
    await db.addDeckWithCards({ id: 'kid', name: 'Kid', color: '#46A758', created: Date.now(), parentId: 'gp' }, [{ id: 'k1', deckId: 'kid', front: 'K1', back: 'b', tags: [], created: 1 }]);
    await t.keepDeleted(await db.deleteDeck('kid'), { kind: 'deck', title: 'Kid', deckId: 'kid' });
    await t.keepDeleted(await db.deleteDeck('gp'), { kind: 'deck', title: 'Grand', deckId: 'gp' });
    const tr = await import('./js/trash.js'); for (const e of await tr.list()) if (e.title === 'Grand') await tr.deleteNow(e);
  });
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/kid/.test(location.hash));
  ok(await page.evaluate(async () => (await (await import('./js/db.js')).getDeck('kid'))?.parentId === ''), 'a subdeck whose parent is gone for good comes back at the top level (parentId cleared)');
  // parent in Recently deleted: the link is kept
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    await db.addDeckWithCards({ id: 'gp2', name: 'Grand2', color: '#46A758', created: Date.now() }, []);
    await db.addDeckWithCards({ id: 'kid2', name: 'Kid2', color: '#46A758', created: Date.now(), parentId: 'gp2' }, []);
    await t.keepDeleted(await db.deleteDeck('kid2'), { kind: 'deck', title: 'Kid2', deckId: 'kid2' });
    await t.keepDeleted(await db.deleteDeck('gp2'), { kind: 'deck', title: 'Grand2', deckId: 'gp2' });
  });
  await openSheet(page); await page.locator('#trList .tr-row', { hasText: 'Kid2' }).locator('[data-act="restore"]').click();
  await page.waitForFunction(() => /#\/deck\/kid2/.test(location.hash));
  ok(await page.evaluate(async () => (await (await import('./js/db.js')).getDeck('kid2'))?.parentId === 'gp2'), 'a subdeck whose parent is in Recently deleted keeps its parent link');
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\/gp2/.test(location.hash));
  ok(await page.evaluate(async () => !!(await (await import('./js/db.js')).getDeck('gp2'))), 'restoring the parent later puts the tree back together');

  // --- rules 1 and 2 on a real restore: a row that exists, a row deleted again later ---
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    await db.addDeckWithCards({ id: 'rr', name: 'Rules', color: '#46A758', created: Date.now() }, [{ id: 'r1', deckId: 'rr', front: 'R1', back: 'b', tags: [], created: 1 }, { id: 'r2', deckId: 'rr', front: 'R2', back: 'b', tags: [], created: 2 }]);
    await t.keepDeleted(await db.deleteCards(['r1', 'r2']));
    // r1 "came back another way": same id, newer content. r2: another device deleted it again later (a newer delete marker).
    await db.saveCards([{ id: 'r1', deckId: 'rr', front: 'R1 live', back: 'b', tags: [], created: 1 }]);
    await db.saveCards([{ id: 'r2', deckId: 'rr', front: 'R2', back: 'b', tags: [], created: 2 }]);
    await db.deleteCards(['r2']);
  });
  await openSheet(page); await page.click('#trList [data-act="restore"]');
  await page.waitForFunction(() => /#\/deck\//.test(location.hash) && document.getElementById('toast') && !document.getElementById('toast').hidden);
  const rr = await page.evaluate(async () => { const db = await import('./js/db.js'); return [await db.get('cards', 'r1'), await db.get('cards', 'r2')]; });
  ok(rr[0].front === 'R1 live' && !rr[1], 'rule 1 and 2: a card that exists is left alone, a card deleted again later stays deleted');

  await page.context().close();
}

// ---------- after 30 days: purged, and its picture is cleaned only then (a fresh page: a delete holds the clean-up for 2 minutes) ----------
{
  const page = await open(null);
  // --- after 30 days: purged, and its picture is cleaned only then ---
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    await db.putMedia({ id: 'pic-trash', type: 'image/png', data: new Uint8Array(40).buffer, size: 40, created: 1, uploaded: false });
    await db.addDeckWithCards({ id: 'pd', name: 'Pics', color: '#46A758', created: Date.now() }, [{ id: 'pc', deckId: 'pd', front: 'with picture', back: 'b', tags: [], created: 1, frontImage: 'pic-trash' }]);
    await t.keepDeleted(await db.deleteCards(['pc']));
  });
  const mediaKept = await page.evaluate(async () => {
    const db = await import('./js/db.js'); const tr = await import('./js/trash.js');
    await new Promise(r => setTimeout(r, 0));
    const keep = await tr.protectedMedia();
    await db.cleanMedia(Date.now() + 3 * 86400000, { keep });
    return [keep.has('pic-trash'), !!(await db.getMedia('pic-trash'))];
  });
  ok(mediaKept[0] && mediaKept[1], 'a trashed card\'s picture is kept by the clean-up while the entry is in the list');
  const afterPurge = await page.evaluate(async d => {
    const db = await import('./js/db.js'); const tr = await import('./js/trash.js');
    const in29 = (await tr.list({ now: Date.now() + 29 * d })).length;
    const gone = await db.cleanMedia(Date.now() + 29 * d, { keep: await tr.protectedMedia() });
    const pic29 = !!(await db.getMedia('pic-trash'));
    const in31 = (await tr.list({ now: Date.now() + 31 * d })).length;          // opening the sheet purges
    await db.cleanMedia(Date.now() + 31 * d, { keep: await tr.protectedMedia() });
    return { in29, pic29, in31, pic31: !!(await db.getMedia('pic-trash')), left: (await (await import('./js/trash-db.js')).listEntries()).length };
  }, DAY);
  ok(afterPurge.in29 === 1 && afterPurge.pic29, 'day 29: still listed, picture still there');
  ok(afterPurge.in31 === 0 && afterPurge.left === 0 && !afterPurge.pic31, 'day 31: purged (entry and pieces), and now the clean-up removes the picture');
  ok(await page.evaluate(async () => { const tr = await import('./js/trash.js'); return (await tr.purgeDaily({ now: Date.now() + 40 * 86400000, force: true })) === 0; }), 'purgeDaily with nothing old does nothing');

  await page.context().close();
}

// ---------- big deck: 3,000 cards, pieces, progress ----------
{
  const page = await open(null);
  const res = await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js'); const tr = await import('./js/trash.js');
    const cards = Array.from({ length: 3000 }, (_, i) => ({ id: 'big' + i, deckId: 'bigd', front: 'Q' + i, back: 'A' + i, tags: [], created: i }));
    await db.addDeckWithCards({ id: 'bigd', name: 'Big', color: '#46A758', created: Date.now() }, cards);
    await db.putMany('cardStates', cards.map(c => ({ cardId: c.id, due: Date.now() + 86400000, stability: 3, difficulty: 5, reps: 1, lapses: 0, state: 2, lastReview: Date.now() })));
    await db.putMany('reviewLog', cards.map(c => ({ cardId: c.id, timestamp: Date.now(), source: 'review', rating: 3, correct: true, state: 2 })));
    const n0 = (await db.getAll('reviewLog')).length;
    await t.keepDeleted(await db.deleteDeck('bigd'), { kind: 'deck', title: 'Big', deckId: 'bigd' });
    const e = (await tr.list())[0];
    const calls = [];
    const out = await tr.restoreEntry(e.id, { onProgress: p => calls.push(p) });
    return { parts: e.parts, calls, out, cards: (await db.getCardsInDeck('bigd')).length, states: (await db.getAll('cardStates')).filter(s => s.cardId.startsWith('big')).length, logs: (await db.getAll('reviewLog')).length - n0 + 3000, left: (await tr.list()).length };
  });
  ok(res.parts >= 5 && res.calls.length === res.parts && res.calls.at(-1).done === res.calls.at(-1).total, `a 3,000-card deck is kept in ${res.parts} pieces and restores piece by piece with progress (${res.calls.length} updates)`);
  ok(res.cards === 3000 && res.states === 3000 && res.logs === 3000 && res.out.cards === 3000 && res.left === 0, 'all 3,000 cards, schedules and reviews are back, and the entry is gone');
  // running the same restore twice is safe: nothing doubles (an interrupted restore can be run again)
  const twice = await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js'); const tr = await import('./js/trash.js'); const tdb = await import('./js/trash-db.js');
    await t.keepDeleted(await db.deleteCards(['big1', 'big2']));
    const e = (await tr.list())[0], part = await tdb.getPart(e.id, 0);
    await db.restoreDeleted(part, e);
    const again = await db.restoreDeleted(part, e);
    const logsFor = (await db.getCardLogs('big1')).length;
    return { again, logsFor };
  });
  ok(twice.again.cards === 0 && twice.again.states === 0 && twice.again.reviews === 0 && twice.logsFor === 1, 'running a restore twice is safe: the second run puts nothing back and nothing doubles');
  await page.context().close();
}

// ---------- accounts and wipes ----------
{
  const fake = fakeSupabase();
  const page = await open(fake);
  await page.goto(APP + '#/settings'); await page.waitForSelector('#syncEmail');
  await page.fill('#syncEmail', 'me@example.com'); await page.fill('#syncPw', 'secret123'); await page.click('#syncCreate');
  await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  const uid = await page.evaluate(async () => (await (await import('./js/sync-state.js')).account()).id);
  await page.evaluate(async uid => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js'); const tdb = await import('./js/trash-db.js');
    const c = (await db.getAll('cards')).slice(0, 2);
    await t.keepDeleted(await db.deleteCards([c[0].id]));
    // an entry made under a different account (written straight into the list)
    await tdb.addEntry({ id: 'other', kind: 'cards', title: 'Someone else\'s card', deletedAt: Date.now(), settledAt: Date.now(), userId: 'not-' + uid, parts: 1, counts: { cards: 1, reviews: 0 }, deckIds: [], mediaIds: [] }, [{ gone: { decks: [], cards: [{ id: 'zzz', deckId: 'sample', front: 'secret', back: 'b' }], cardStates: [], reviewLog: [] }, before: { decks: [], cards: [] } }]);
  }, uid);
  const mine = await entries(page);
  ok(mine.length === 1 && mine[0].userId === uid, 'while signed in, the list shows this account\'s entries and hides another account\'s');
  ok((await allEntries(page)).length === 2, 'the other account\'s entry is still stored (hidden, not deleted)');
  const res = await page.evaluate(async () => (await import('./js/trash.js')).restoreEntry('other'));
  ok(res.missing === true && await page.evaluate(async () => !(await (await import('./js/db.js')).get('cards', 'zzz'))), 'an entry from another account can not be restored: nothing is pushed into this account');
  // signing out with "Remove" empties the list
  await page.evaluate(async () => { await (await import('./js/trash-db.js')).clearTrash(); });
  await page.context().close();
}
{
  const page = await open(null);
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js'); const tdb = await import('./js/trash-db.js');
    await t.keepDeleted(await db.deleteCards([(await db.getAll('cards'))[0].id]));
    await tdb.addEntry({ id: 'acct', kind: 'cards', title: 'x', deletedAt: Date.now(), settledAt: Date.now(), userId: 'someone', parts: 1, counts: { cards: 1, reviews: 0 }, deckIds: [], mediaIds: [] }, [{ gone: { decks: [], cards: [], cardStates: [], reviewLog: [] }, before: { decks: [], cards: [] } }]);
  });
  ok((await allEntries(page)).length === 2 && (await entries(page)).length === 1, 'signed out: entries made while signed out show; one made in an account is hidden');
  await page.goto(APP + '#/settings'); await page.waitForSelector('#resetBtn', { state: 'attached' });
  await page.click('#dangerZone > summary');
  await page.click('#resetBtn'); await page.click('#rsYes');
  await page.waitForFunction(() => /All data reset/.test(document.getElementById('toast')?.textContent || ''));
  ok((await allEntries(page)).length === 0, 'Reset all data empties the whole list, hidden entries too');
  // Restore backup also empties it
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    await t.keepDeleted(await db.deleteCards([(await db.getAll('cards'))[0].id]));
  });
  ok((await allEntries(page)).length === 1, 'set up: one entry again');
  await page.evaluate(async () => { const db = await import('./js/db.js'); const data = await db.exportAll(); await db.importAll(data); await (await import('./js/trash.js')).emptyAll(); });
  ok((await allEntries(page)).length === 0, 'emptyAll (used by Restore backup and Delete everywhere) empties it');
  await page.context().close();
}

// ---------- two devices, with sync ----------
{
  const fake = fakeSupabase();
  const A = await open(fake), B = await open(fake);
  const sync = p => p.evaluate(async () => { await (await import('./js/sync.js')).syncNow(); });
  const get = (p, id) => p.evaluate(async id => { const db = await import('./js/db.js'); return { card: await db.get('cards', id), state: await db.get('cardStates', id), logs: (await db.getCardLogs(id)).length }; }, id);
  await A.goto(APP + '#/settings'); await A.waitForSelector('#syncEmail');
  await A.fill('#syncEmail', 'me@example.com'); await A.fill('#syncPw', 'secret123'); await A.click('#syncCreate');
  await A.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  const [c1, c2] = await A.evaluate(async () => { const db = await import('./js/db.js'); return (await db.getAll('cards')).slice(0, 2).map(c => c.id); });
  await review(A, c1, 2); await review(A, c2, 2);
  await sync(A);
  await B.goto(APP + '#/settings'); await B.waitForSelector('#syncEmail');
  await B.fill('#syncEmail', 'me@example.com'); await B.fill('#syncPw', 'secret123'); await B.click('#syncForm button[type=submit]');
  await B.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
  await sync(B);
  ok((await get(B, c1)).card && (await get(B, c1)).state && (await get(B, c1)).logs === 2, 'set up: device B has the card, its schedule and 2 reviews');
  const aBefore = await get(A, c1);

  // A deletes, B syncs: gone on B
  await A.evaluate(async id => { const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js'); await t.keepDeleted(await db.deleteCards([id])); await (await import('./js/sync.js')).syncNow(); }, c1);
  await sync(B);
  const bGone = await get(B, c1);
  ok(!bGone.card && !bGone.state && bGone.logs === 0, 'A deletes, B syncs: the card, schedule and reviews are gone on B');
  ok((await entries(B)).length === 0, 'nothing new syncs: B has no Recently deleted entry (it is per device)');
  // A restores, syncs; B syncs: back with its schedule and history
  const out = await A.evaluate(async () => { const tr = await import('./js/trash.js'); const e = (await tr.list())[0]; const r = await tr.restoreEntry(e.id); await (await import('./js/sync.js')).syncNow(); return r; });
  ok(out.ok && out.cards === 1, 'A restores from its list');
  await sync(B);
  const bBack = await get(B, c1);
  ok(!!bBack.card && !!bBack.state && bBack.logs === 2 && bBack.state.stability === aBefore.state.stability && bBack.card.front === aBefore.card.front, 'B syncs: the card is back with its schedule and both review rows');
  ok(fake.userRows('me@example.com').some(r => r.store === 'cards' && r.id === c1 && !r.deleted), 'the server has the card again (not deleted)');

  // B edits the card before the delete reaches it; A's restore must leave B's version
  await A.evaluate(async id => { const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js'); await t.keepDeleted(await db.deleteCards([id])); await (await import('./js/sync.js')).syncNow(); }, c2);
  await B.evaluate(async id => { const db = await import('./js/db.js'); await db.saveCards([{ ...(await db.get('cards', id)), front: 'edited on B' }]); await (await import('./js/sync.js')).syncNow(); }, c2);
  await sync(A);
  ok((await get(A, c2)).card?.front === 'edited on B', 'B edited after A deleted: the card came back to A by sync, with B\'s edit');
  const r2 = await A.evaluate(async () => { const tr = await import('./js/trash.js'); const e = (await tr.list())[0]; const r = await tr.restoreEntry(e.id); await (await import('./js/sync.js')).syncNow(); return r; });
  const a2 = await get(A, c2);
  ok(a2.card.front === 'edited on B' && r2.ok, 'A restores: B\'s newer edit is left as it is (not overwritten)');
  ok(!!a2.state && a2.logs === 2, 'and the schedule and history that did not come with the sync come back (rule 3)');
  await sync(B);
  ok((await get(B, c2)).card.front === 'edited on B', 'B still has its own edit');
  await A.context().close(); await B.context().close();
}

// ---------- the sheet at phone and desktop width, in both styles: nothing overflows ----------
for (const [w, h, ui] of [[390, 844, 'original'], [1440, 900, 'clinical']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async ui => { await (await import('./js/db.js')).setSetting('theme', { ui, skin: 'violet', mode: 'light', oled: false }); }, ui);
  await page.reload(); await page.waitForSelector('.deck');
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const t = await import('./js/trash-lazy.js');
    await db.addDeckWithCards({ id: 'long', name: 'A deck with quite a long name to see how the row wraps on a narrow screen', color: '#46A758', created: Date.now() }, [{ id: 'l1', deckId: 'long', front: 'L', back: 'b', tags: [], created: 1 }]);
    await t.keepDeleted(await db.deleteDeck('long'), { kind: 'deck', title: 'A deck with quite a long name to see how the row wraps on a narrow screen', deckId: 'long' });
  });
  await openSheet(page);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.getElementById('sheet').scrollWidth <= document.getElementById('sheet').clientWidth + 1), `the sheet does not overflow sideways at ${w}px (${ui})`);
  await ctx.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
