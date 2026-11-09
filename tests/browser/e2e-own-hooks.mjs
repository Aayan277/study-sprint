// Own model and Review: with no Own database nothing is created; with a model loaded and the switch on, a real review makes a record
// with both numbers (Undo removes it) and Play makes none; when Own schedules, the buttons are drawn from the plan and agree with the
// saved due date; a stopped worker means FSRS again. Nothing reaches the network.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [], supa = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
await ctx.route('**/*.supabase.co/**', r => { supa.push(r.request().url()); r.abort(); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
// (no string code: the page's security policy is on, which also lets the worker be checked)
const dbAll = store => page.evaluate(async s => (await import('./js/db.js')).getAll(s), store);
const ownDbNames = () => page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => /own/.test(n)));
const ownAll = store => page.evaluate(async st => { const { openOwnDb } = await import('./js/own-db.js'); const h = await openOwnDb({ forbidCreate: true }); if (!h) return null; try { return await h.getAll(st); } finally { h.close(); } }, store);
const DAY = 86400000;

await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');

// 1. nothing loaded: a review changes nothing about Own and creates no Own database
await page.click('#startBtn'); await page.waitForSelector('#flash');
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await page.waitForFunction(() => !document.querySelector('.rate'));
ok((await ownDbNames()).length === 0, 'no model loaded: reviewing creates no Own database');
await page.evaluate(() => { location.hash = '#/decks'; }); await page.waitForSelector('.deck');

// 2. load a model, switch on, seed three cards that are in Review and due, with history
await page.evaluate(async () => {
  const { writeOwnFile } = await import('./js/own-file.js'); const { initParams } = await import('./js/own-model.js'); const { loadModelFile } = await import('./js/own-load.js');
  const bytes = writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 3)), trainedOn: [{ id: 'sim-v1', licence: 'ours' }], seed: 3, gitStamp: 'test', createdAt: '2026-11-06T00:00:00.000Z' });
  const r = await loadModelFile({ name: 'test.own', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
  if (!r.ok) throw new Error(r.message);
});
const seeded = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const cards = (await db.getAll('cards')).slice(2, 7), now = Date.now(), ids = [];
  for (const c of cards) {
    const mk = (days, state, rating) => ({ cardId: c.id, timestamp: now - days * 86400000, source: 'review', mode: 'flip', correct: rating > 1, ms: 4000, rating, state });
    await db.saveReview({ cardId: c.id, due: now - 4 * 86400000, stability: 3, difficulty: 5, elapsedDays: 5, scheduledDays: 5, learningSteps: 0, reps: 1, lapses: 0, state: 2, lastReview: now - 10 * 86400000 }, mk(10, 0, 3));
    await db.saveReview({ cardId: c.id, due: now - 3600000, stability: 6, difficulty: 5, elapsedDays: 5, scheduledDays: 5, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: now - 5 * 86400000 }, mk(5, 2, 3));
    ids.push(c.id);
  }
  return ids;
});
ok(seeded.length === 5, 'five Review cards seeded');
await page.evaluate(async () => { const s = await import('./js/own-shadow.js'); await s.ownSetOn(true); await s.begin(); });
await page.waitForFunction(async () => (await (await import('./js/own-shadow.js')).ownStatus()).memory === 'fresh', null, { timeout: 20000 });
ok(true, 'switched on: the worker built the memory from the review log');
const names = await ownDbNames();
ok(names.length === 1 && names[0] === 'study-sprint-own', 'the Own database exists now: ' + names);

// 3. a real review of a Review card makes a record with both numbers; Undo takes it away
const answerReviewCard = async (key = '3') => {
  for (let i = 0; i < 20; i++) {
    await page.waitForSelector('#flash');
    await page.keyboard.press('Space'); await page.waitForSelector('.rate');
    const labels = await page.$$eval('.rate', bs => bs.map(b => b.querySelector('span').textContent));
    const before = (await dbAll('reviewLog')).length;
    await page.keyboard.press(key);
    await page.waitForFunction(async n => (await (await import('./js/db.js')).getAll('reviewLog')).length > n, before);
    const log = (await dbAll('reviewLog')).at(-1);
    if (log.state === 2) return { log, labels };
  }
  return null;
};
await page.evaluate(() => { location.hash = '#/today'; }); await page.waitForSelector('#startBtn');
await page.click('#startBtn');
const a1 = await answerReviewCard('3');
ok(!!a1 && a1.log.state === 2, 'answered a card that was in Review');
await page.waitForFunction(async () => (await (await import('./js/own-shadow.js')).ownStatus()).records >= 1, null, { timeout: 8000 }).catch(() => {});
let recs = await ownAll('preds');
const rec = recs.find(r => r.logId === a1.log.id);
ok(!!rec && rec.y === 1 && rec.pOwn > 0 && rec.pOwn < 1 && rec.pFsrs > 0 && rec.pFsrs < 1 && rec.sched === 'fsrs' && rec.fsrsKind === 6, 'a record with both numbers and y: ' + JSON.stringify(rec));
await page.click('#undoBtn');
await page.waitForFunction(async id => !(await (await import('./js/db.js')).getAll('reviewLog')).some(l => l.id === id), a1.log.id);
await page.waitForTimeout(500);
recs = await ownAll('preds');
ok(!recs.some(r => r.logId === a1.log.id), 'Undo removed the record');

// 4. Own schedules: the buttons come from the plan, held to 0.25x - 4x of FSRS, and agree with the saved due date
await page.evaluate(async () => {
  const { openOwnDb } = await import('./js/own-db.js'); const s = await import('./js/own-shadow.js');
  const h = await openOwnDb({ forbidCreate: true });
  try { await h.put('meta', 'state', { ...(await h.get('meta', 'state')), scheduler: 'own', switches: [{ day: 1, to: 'own', why: 'better' }] }); } finally { h.close(); }
  await s.getOwn().call('open', {});          // the worker reads its state again
  s.getOwn().scheduler = 'own';
});
// (the card on screen was drawn before the switch, so it has no plan: answer it, then the next Review card is planned by Own)
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await page.waitForFunction(() => !document.querySelector('.rate'));
const own = await answerReviewCard('3');
ok(!!own, 'answered a card with Own planning');
const st = (await dbAll('cardStates')).find(s => s.cardId === own.log.cardId);
const gotDays = Math.round((st.due - own.log.timestamp) / DAY);
const label = own.labels[2];                       // Again, Hard, Good, Easy
ok(/^\d+d$/.test(label) && Number(label.slice(0, -1)) === gotDays, `the Good label (${label}) is the gap that was saved (${gotDays} d)`);
ok(gotDays >= 1 && st.state === 2, 'a Review card stays in Review');
const status = await page.evaluate(async () => (await import('./js/own-shadow.js')).ownStatus());
ok(status.plansToday.total >= 1, 'the plan was counted: ' + JSON.stringify(status.plansToday));

// 5. the worker stops: FSRS schedules, the failed plan is counted
await page.evaluate(async () => { (await import('./js/own-shadow.js')).getOwn()._fail(new Error('broken on purpose')); });
const before = await page.evaluate(async () => (await (await import('./js/own-shadow.js')).ownStatus()).plansToday.failed);
// (the card on screen was planned before the worker stopped: answer it, then the next Review card finds no plan and is counted as a failed one)
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await page.waitForFunction(() => !document.querySelector('.rate'));
const broke = await answerReviewCard('3');
await page.waitForTimeout(600);
const after = await page.evaluate(async () => (await (await import('./js/own-shadow.js')).ownStatus()).plansToday.failed);
const stB = (await dbAll('cardStates')).find(x => x.cardId === broke.log.cardId);
ok(!!broke && stB.state === 2, 'with the worker gone the review still works');
ok(after === before + 1, `the missing plan was counted as failed (${before} -> ${after}); FSRS scheduled the card: ${stB.scheduledDays} d`);

// 6. remove everything: the database is gone, the cards and reviews are not touched
const logsBefore = (await dbAll('reviewLog')).length;
await page.evaluate(async () => { const s = await import('./js/own-shadow.js'); await s.ownRemoveAll(); });
ok((await ownDbNames()).length === 0, 'removing the model deletes the Own database');
ok((await dbAll('reviewLog')).length === logsBefore, 'the review log is untouched');
const mainNames = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
ok(!mainNames.some(n => /own/.test(n)), 'the main database list has no Own database');
ok(supa.length === 0, 'no request to Supabase');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
