// Own model, fixes after the code review: an answer given before Own has finished starting up is still recorded; a plan frozen for a card is
// the one used for it even if Own stops scheduling meanwhile (label = saved gap); Settings does not say "Building memory…" after a reload;
// "Reset all data" removes the Own database; Today shows one card at a time (what's new first, Own's note on a later visit).
import { chromium, realChromium } from './pw.mjs';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const DAY = 86400000, errors = [], supa = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.message));
await ctx.route('**/*.supabase.co/**', r => { supa.push(r.request().url()); r.abort(); });
const dbAll = store => page.evaluate(async s => (await import('./js/db.js')).getAll(s), store);
const ownDbNames = () => page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => /own/.test(n)));
const ownAll = store => page.evaluate(async st => { const { openOwnDb } = await import('./js/own-db.js'); const h = await openOwnDb({ forbidCreate: true }); if (!h) return null; try { return await h.getAll(st); } finally { h.close(); } }, store);
const setOwnState = patch => page.evaluate(async p => {
  const { openOwnDb } = await import('./js/own-db.js'); const h = await openOwnDb({ forbidCreate: true });
  try { await h.put('meta', 'state', { ...(await h.get('meta', 'state')), ...p }); } finally { h.close(); }
}, patch);

await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
// a model, five Review cards with history, the switch on and the memory built
await page.evaluate(async () => {
  const { writeOwnFile } = await import('./js/own-file.js'); const { initParams } = await import('./js/own-model.js'); const { loadModelFile } = await import('./js/own-load.js');
  const bytes = writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 3)), trainedOn: [{ id: 'sim-v1', licence: 'ours' }], seed: 3, gitStamp: 'test', createdAt: '2026-11-06T00:00:00.000Z' });
  const r = await loadModelFile({ name: 'test.own', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
  if (!r.ok) throw new Error(r.message);
  const db = await import('./js/db.js');
  const cards = (await db.getAll('cards')).slice(2, 7), now = Date.now();
  for (const c of cards) {
    const mk = (days, state, rating) => ({ cardId: c.id, timestamp: now - days * 86400000, source: 'review', mode: 'flip', correct: rating > 1, ms: 4000, rating, state });
    await db.saveReview({ cardId: c.id, due: now - 4 * 86400000, stability: 3, difficulty: 5, elapsedDays: 5, scheduledDays: 5, learningSteps: 0, reps: 1, lapses: 0, state: 2, lastReview: now - 10 * 86400000 }, mk(10, 0, 3));
    await db.saveReview({ cardId: c.id, due: now - 3600000, stability: 6, difficulty: 5, elapsedDays: 5, scheduledDays: 5, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: now - 5 * 86400000 }, mk(5, 2, 3));
  }
  const s = await import('./js/own-shadow.js'); await s.ownSetOn(true); await s.begin();
});
await page.waitForFunction(async () => (await (await import('./js/own-shadow.js')).ownStatus()).memory === 'fresh', null, { timeout: 20000 });
ok(true, 'model loaded, switched on, memory built');

// ---- Settings after a reload: no "Building memory…" ----
await page.goto('http://localhost:8123/#/settings'); await page.reload(); await page.waitForSelector('#advanced');
await page.evaluate(() => { document.getElementById('advanced').open = true; });
await page.click('#ownSection > summary'); await page.waitForSelector('#ownSched');
await page.waitForTimeout(3500);
const label = await page.textContent('#ownSched');
ok(label.trim() === 'FSRS', 'after a reload the scheduling label is not stuck on "Building memory…": ' + label.trim());
const counts = await page.textContent('#ownVerdict');
ok(await page.locator('#ownVerdict .sr-only').count() >= 2 && /scored reviews/.test(counts) && /while watching/.test(counts), 'each progress count has a name for a screen reader: ' + counts.replace(/\s+/g, ' ').trim());

// ---- an answer given before Own has started up is not lost ----
await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
await page.evaluate(async () => {            // Own does its work but is only reported ready four seconds into the session
  const c = (await import('./js/own-shadow.js')).getOwn(), orig = c.begin.bind(c);
  c.begin = o => orig(o).then(async r => { await new Promise(x => setTimeout(x, 4000)); return r; });
});
await page.click('#startBtn');
let answered = null;
for (let i = 0; i < 25 && !answered; i++) {
  await page.waitForSelector('#flash'); await page.keyboard.press('Space'); await page.waitForSelector('.rate');
  const n = (await dbAll('reviewLog')).length;
  await page.keyboard.press('3');
  await page.waitForFunction(async n => (await (await import('./js/db.js')).getAll('reviewLog')).length > n, n);
  const log = (await dbAll('reviewLog')).at(-1);
  if (log.state === 2) answered = log;
}
ok(!!answered, 'answered a Review card while Own was still starting up');
let rec = null;
for (let i = 0; i < 40 && !rec; i++) { await page.waitForTimeout(500); rec = ((await ownAll('preds')) || []).find(r => r.logId === answered.id); }
ok(!!rec && rec.y === 1 && rec.pFsrs > 0 && rec.pOwn > 0, 'its record was made once Own was ready: ' + JSON.stringify(rec));

// ---- a frozen plan is used for its card even if Own stops scheduling meanwhile ----
await page.evaluate(() => { location.hash = '#/today'; }); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#flash');
await page.waitForFunction(() => import('./js/own-shadow.js').then(m => m.getOwn().ready), null, { timeout: 15000 });
await setOwnState({ scheduler: 'own', switches: [{ day: 1, to: 'own', why: 'better' }] });
await page.evaluate(async () => { const s = await import('./js/own-shadow.js'); await s.getOwn().call('open', {}); s.getOwn().scheduler = 'own'; });
// (the card on screen was drawn before the switch: answer it; the next Review card is planned by Own)
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await page.waitForFunction(() => !document.querySelector('.rate'));
let frozen = null;
for (let i = 0; i < 25 && !frozen; i++) {
  await page.waitForSelector('#flash');
  await page.keyboard.press('Space'); await page.waitForSelector('.rate');
  const labels = await page.$$eval('.rate', bs => bs.map(b => b.querySelector('span').textContent));
  const stateBefore = (await dbAll('cardStates')).length;
  const isReview = await page.evaluate(() => document.querySelector('.rate') && true);
  // Own stops scheduling now (the owner turned it off in another tab, say): the card on screen keeps its plan
  await setOwnState({ scheduler: 'fsrs' });
  await page.evaluate(async () => { (await import('./js/own-shadow.js')).getOwn().scheduler = 'fsrs'; });
  const n = (await dbAll('reviewLog')).length;
  await page.keyboard.press('3');
  await page.waitForFunction(async n => (await (await import('./js/db.js')).getAll('reviewLog')).length > n, n);
  const log = (await dbAll('reviewLog')).at(-1);
  if (log.state === 2) frozen = { log, labels };
  else { await setOwnState({ scheduler: 'own' }); await page.evaluate(async () => { (await import('./js/own-shadow.js')).getOwn().scheduler = 'own'; }); }
  void stateBefore; void isReview;
}
ok(!!frozen, 'answered a Review card after Own stopped scheduling');
if (frozen) {
  const st = (await dbAll('cardStates')).find(s => s.cardId === frozen.log.cardId);
  const gotDays = Math.round((st.due - frozen.log.timestamp) / DAY);
  ok(/^\d+d$/.test(frozen.labels[2]) && Number(frozen.labels[2].slice(0, -1)) === gotDays, `the Good label (${frozen.labels[2]}) is the gap that was saved (${gotDays} d)`);
}

// ---- Reset all data removes the Own database ----
ok((await ownDbNames()).join() === 'study-sprint-own', 'the Own database exists before the reset');
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#resetBtn', { state: 'attached' }); await page.click('#dangerZone > summary');
await page.click('#resetBtn'); await page.waitForSelector('#rsYes'); await page.click('#rsYes');
await page.waitForFunction(() => document.querySelector('.toast, [role=status]')?.textContent.includes('All data reset'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
ok((await ownDbNames()).length === 0, 'Reset all data removed the Own database: ' + (await ownDbNames()).join());
ok(supa.length === 0, 'no request to Supabase');
await browser.close();

// ---- Today: one card at a time ----
const b2 = await realChromium.launch();
const c2 = await b2.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
await c2.addInitScript(() => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } });
await c2.route('**/*.supabase.co/**', r => r.abort());
const p2 = await c2.newPage();
p2.on('pageerror', e => errors.push('pageerror ' + e.message));
await p2.goto('http://localhost:8123/#/today'); await p2.waitForSelector('.today-hero');
await p2.evaluate(async () => {
  const { writeOwnFile } = await import('./js/own-file.js'); const { initParams } = await import('./js/own-model.js'); const { loadModelFile } = await import('./js/own-load.js');
  const bytes = writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 3)), trainedOn: [{ id: 'sim-v1', licence: 'ours' }], seed: 3, gitStamp: 'test', createdAt: '2026-11-06T00:00:00.000Z' });
  await loadModelFile({ name: 'test.own', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
  const s = await import('./js/own-shadow.js'); await s.ownSetOn(true);
  const { openOwnDb } = await import('./js/own-db.js'); const h = await openOwnDb({ forbidCreate: true });
  try { await h.put('meta', 'state', { ...(await h.get('meta', 'state')), scheduler: 'own', switches: [{ day: 1, to: 'own', why: 'better' }], noticePending: 1 }); } finally { h.close(); }
  await (await import('./js/db.js')).setSetting('whatsNewSeen', '1.0');           // an old version: what's new is due
});
await p2.reload(); await p2.waitForSelector('.today-hero'); await p2.waitForTimeout(1200);
ok(await p2.locator('.wn').count() === 1 && await p2.locator('#ownNoticeTitle').count() === 0, 'a visit with what\'s new shows only that card');
const pending = () => p2.evaluate(async () => (await (await import('./js/own-shadow.js')).ownStatus()).noticePending);
ok(await pending() === 1, 'Own\'s note is not used up by that visit');
await p2.reload(); await p2.waitForSelector('.today-hero'); await p2.waitForTimeout(1200);
ok(await p2.locator('#ownNoticeTitle').count() === 1 && await p2.locator('.wn').count() === 1 && await p2.locator('#whatsNewSlot .wn').count() === 0, 'the next visit shows Own\'s note');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await b2.close();
