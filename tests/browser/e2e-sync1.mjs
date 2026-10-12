import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const newPage = async () => { const p = await (await browser.newContext({ viewport: { width: 375, height: 740 } })).newPage(); p.on('pageerror', e => errors.push(e.message)); return p; };

// ---- 1. upgrading a version 1 database ----
let page = await newPage();
await page.goto('http://localhost:8123/README.md');
await page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('study-sprint', 1);
  req.onupgradeneeded = () => {           // the version 1 layout, exactly as the old app made it
    const db = req.result;
    db.createObjectStore('decks', { keyPath: 'id' });
    db.createObjectStore('cards', { keyPath: 'id' }).createIndex('deckId', 'deckId');
    db.createObjectStore('cardStates', { keyPath: 'cardId' }).createIndex('due', 'due');
    const log = db.createObjectStore('reviewLog', { keyPath: 'id', autoIncrement: true });
    log.createIndex('cardId', 'cardId'); log.createIndex('timestamp', 'timestamp');
    db.createObjectStore('settings');
  };
  req.onsuccess = () => {
    const db = req.result, tx = db.transaction(['decks', 'cards', 'cardStates', 'reviewLog', 'settings'], 'readwrite');
    tx.objectStore('decks').put({ id: 'old-deck', name: 'Old deck', color: '#E5484D', created: 1000, course: '' });
    tx.objectStore('cards').put({ id: 'c1', deckId: 'old-deck', front: 'Old front', back: 'Old back', tags: [], created: 1001 });
    tx.objectStore('cards').put({ id: 'c2', deckId: 'old-deck', front: 'Second', back: 'Two', tags: [], created: 1002 });
    tx.objectStore('cardStates').put({ cardId: 'c1', due: Date.now() + 86400000, stability: 3, difficulty: 5, reps: 2, lapses: 0, state: 2, lastReview: 5000 });
    tx.objectStore('reviewLog').put({ cardId: 'c1', timestamp: 4000, source: 'review', correct: true, rating: 3, ms: 2000, state: 0 });
    tx.objectStore('reviewLog').put({ cardId: 'c1', timestamp: 5000, source: 'review', correct: true, rating: 3, ms: 2000, state: 1 });
    tx.objectStore('settings').put(true, 'seeded');
    tx.objectStore('settings').put(15, 'newPerDay');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
}));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
let r = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const d = await db.openDB();
  return { version: d.version, stores: [...d.objectStoreNames], uidIndex: [...d.transaction('reviewLog').objectStore('reviewLog').indexNames],
    deck: await db.get('decks', 'old-deck'), cards: await db.getAll('cards'), state: await db.get('cardStates', 'c1'),
    logs: await db.getAll('reviewLog'), settings: await db.getSettings() };
});
ok(r.version === 3 && r.stores.includes('deleted') && r.stores.includes('media') && r.uidIndex.includes('uid'), 'database upgraded (to version 3) with the deleted and media stores');
ok(r.deck.name === 'Old deck' && r.deck.updatedAt === 1000, 'deck kept, updatedAt from when it was made');
ok(r.cards.length === 2 && r.cards.every(c => c.updatedAt === c.created && c.front), 'cards kept with updatedAt');
ok(r.state.stability === 3 && r.state.updatedAt === 5000, 'schedule kept, updatedAt = last review');
ok(r.logs.length === 2 && r.logs.every(l => l.uid && l.updatedAt === l.timestamp) && r.logs[0].uid !== r.logs[1].uid && r.logs[0].id === 1, 'review history kept, each with its own uid');
ok(r.settings.newPerDay === 15 && r.settings.seeded === true, 'settings kept');
ok((await page.textContent('.deck')).includes('Old deck') && !(await page.textContent('#screen')).includes('Intro to Psychology'), 'app shows the old deck, no sample added');

// ---- 2. every save is stamped, every delete leaves a marker ----
r = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const t0 = Date.now();
  const card = await db.get('cards', 'c2');
  await db.saveCards([{ ...card, front: 'Edited' }]);
  const edited = await db.get('cards', 'c2');
  const logId = await db.saveReview({ cardId: 'c2', due: t0, state: 1, stability: 1, difficulty: 5, reps: 1, lapses: 0 }, { cardId: 'c2', timestamp: t0, source: 'review', rating: 3, correct: true, state: 0 });
  const newLog = (await db.getCardLogs('c2'))[0];
  await db.undoReview('c2', null, logId);
  const afterUndo = { state: await db.get('cardStates', 'c2'), logs: await db.getCardLogs('c2') };
  await db.clearStates(['c1']);
  await db.setSetting('newPerDay', 25);
  await db.setSetting('theme', { skin: 'sage', mode: 'dark' });
  const settings = await db.getSettings();
  const c1logs = (await db.getCardLogs('c1')).map(l => l.uid);
  await db.deleteDeck('old-deck');
  const deleted = await db.getAll('deleted');
  return { t0, edited, newLog, afterUndo, settings, c1logs, deleted, left: { decks: await db.getAll('decks'), cards: await db.getAll('cards'), logs: await db.getAll('reviewLog') } };
});
const has = (store, id) => r.deleted.some(x => x.store === store && x.id === id && x.deletedAt >= r.t0);
ok(r.edited.front === 'Edited' && r.edited.updatedAt >= r.t0, 'edited card stamped with the time');
ok(r.newLog.uid && r.newLog.updatedAt >= r.t0, 'new review gets a uid');
ok(!r.afterUndo.state && !r.afterUndo.logs.length && has('cardStates', 'c2') && has('reviewLog', r.newLog.uid), 'undo leaves markers for the schedule and the review');
ok(has('cardStates', 'c1'), 'reset to new leaves a marker');
ok(r.settings._times?.newPerDay >= r.t0 && !('theme' in (r.settings._times || {})), 'study settings note when they changed; theme does not');
ok(has('decks', 'old-deck') && has('cards', 'c1') && has('cards', 'c2') && r.c1logs.every(u => has('reviewLog', u)), 'deleting a deck leaves markers for it, its cards and reviews');
ok(!r.left.decks.length && !r.left.cards.length && !r.left.logs.length, 'deck really deleted');
ok(!r.deleted.some(x => x.store === 'cardStates' && x.id === 'c2' && x.deletedAt > r.deleted.find(y => y.id === 'c2' && y.store === 'cardStates').deletedAt), 'no duplicate markers');

// ---- 3. a fresh install: fixed sample ids ----
page = await newPage();
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
r = await page.evaluate(async () => { const db = await import('./js/db.js'); return { decks: await db.getAll('decks'), cards: await db.getAll('cards') }; });
ok(r.decks[0].id === 'sample' && r.decks[0].updatedAt > 0 && r.cards.every(c => /^sample-\d+$/.test(c.id)), 'sample deck has fixed ids');
await page.click('#startersBox > summary'); await page.click('[data-starter]'); await page.waitForFunction(() => document.querySelectorAll('.deck').length === 2);
r = await page.evaluate(async () => (await (await import('./js/db.js')).getDecks()).map(d => d.id));
ok(r.some(id => id.startsWith('starter-')), 'starter deck has a fixed id: ' + r.join(', '));

// ---- 4. restoring an old backup fills in uids ----
r = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.importAll({ format: 'study-sprint-backup', version: 1, decks: [{ id: 'b', name: 'B', created: 10 }], cards: [{ id: 'bc', deckId: 'b', front: 'f', back: 'b', created: 11 }], cardStates: [], reviewLog: [{ id: 7, cardId: 'bc', timestamp: 12, source: 'review', rating: 3 }], settings: { seeded: true } });
  return { deck: await db.get('decks', 'b'), log: (await db.getAll('reviewLog'))[0] };
});
ok(r.deck.updatedAt === 10 && r.log.uid && r.log.id === 7, 'old backup restored and upgraded');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
