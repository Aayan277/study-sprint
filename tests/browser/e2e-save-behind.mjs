// Review draws the next card without waiting for the database to confirm the last answer (the save is already sent; the next answer,
// Undo and End wait for it). Checks that nothing is lost or reordered by that:
//   - 20 quick answers in a row: every card's schedule and every log row is saved, once, in order
//   - Undo straight after an answer restores that card and removes its log row
//   - a save the database refuses puts the card back with a message, and nothing was saved
//   - a page reload straight after an answer keeps the answer
//   - the last card still waits for its save before the finish screen
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';

const open = async (n = 25) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.stack));
  p.on('console', m => { if (m.type() === 'error' && !/couldn.t be saved|QuotaExceeded|injected/.test(m.text())) errors.push('console ' + m.text()); });
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async n => {
    const db = await import('./js/db.js');
    await db.deleteDeck('sample');
    const now = Date.now(), D = 86400000;
    await db.saveDeck({ id: 'D', name: 'Quick', course: '', color: '#46A758', parentId: '', created: now - 9000 });
    const ids = Array.from({ length: n }, (_, i) => 'c' + String(i).padStart(2, '0'));
    await db.saveCards(ids.map((id, i) => ({ id, deckId: 'D', front: id, back: 'A ' + id, created: now - 100000 + i })));
    await db.putStates(ids.map((id, i) => ({ cardId: id, due: now - (n - i) * 3600000, stability: 6, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 9 * D, elapsedDays: 9, scheduledDays: 6, learningSteps: 0 })));
  }, n);
  return { ctx, p };
};
const start = async p => { await p.goto('about:blank'); await p.goto(APP + '#/today'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash'); };
const front = p => p.locator('#flash .rv-front .flash-front').first().textContent().then(t => t.trim());
const rows = p => p.evaluate(async () => {
  const db = await import('./js/db.js');
  const logs = await db.getAll('reviewLog'), states = await db.getAll('cardStates');
  return { logs: logs.map(l => l.cardId), reviewed: states.filter(s => s.reps > 3).map(s => s.cardId).sort() };
});
const answerShown = async (p, key) => {
  const f = await front(p);
  await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped');
  await p.keyboard.press(key);
  return f;
};

// ---- quick answers in a row ----
{
  const { ctx, p } = await open(25);
  await start(p);
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const f = await front(p);
    seen.push(f);
    await p.keyboard.press('Space');
    await p.waitForFunction(() => document.querySelector('#flash.flipped'));
    await p.keyboard.press('3');
    await p.waitForFunction(prev => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== prev, f);
  }
  const r = await rows(p);
  ok(seen.join() === Array.from({ length: 20 }, (_, i) => 'c' + String(i).padStart(2, '0')).join(), 'the cards came in due order, one after the other');
  ok(r.logs.length === 20 && new Set(r.logs).size === 20 && r.logs.join() === seen.join(), 'one log row per answer, in order: ' + r.logs.length);
  ok(r.reviewed.length === 20, 'every answered card has its new schedule: ' + r.reviewed.length);
  await ctx.close();
}

// ---- Undo straight after an answer ----
{
  const { ctx, p } = await open(5);
  await start(p);
  const first = await answerShown(p, '3');
  await p.waitForFunction(prev => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== prev, first);
  await p.keyboard.press('z');        // at once: the save may still be running
  await p.waitForFunction(prev => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() === prev, first);
  ok(await front(p) === first, 'Undo right after an answer brings the card back: ' + first);
  const r = await rows(p);
  ok(r.logs.length === 0 && r.reviewed.length === 0, 'and its log row and new schedule are gone');
  const counts = await p.$$eval('.rv-counts span', s => s.map(x => +x.textContent));
  ok(counts[2] === 5, 'the Due count is back to 5: ' + counts.join('/'));
  // and the same card can be answered again
  await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped'); await p.keyboard.press('4');
  await p.waitForFunction(prev => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== prev, first);
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length === 1);
  ok(true, 'answering it again saves one row');
  await ctx.close();
}

// ---- the database refuses a save ----
{
  const { ctx, p } = await open(5);
  await start(p);
  await p.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (window.__failNext && this.name === 'cardStates') { window.__failNext = false; throw new DOMException('injected', 'QuotaExceededError'); }
      return put.apply(this, a);
    };
    window.__failNext = true;
  });
  const first = await answerShown(p, '3');
  await p.waitForSelector('.toast, #toast', { state: 'attached' }).catch(() => {});
  await p.waitForFunction(prev => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() === prev && document.querySelector('#toastLive')?.textContent.includes("couldn't be saved"), first, { timeout: 8000 });
  ok(await front(p) === first, 'a refused save puts the same card back on screen');
  ok((await p.textContent('#toastLive')).includes("couldn't be saved"), 'with a message: ' + (await p.textContent('#toastLive')).trim());
  const r = await rows(p);
  ok(r.logs.length === 0 && r.reviewed.length === 0, 'nothing was saved');
  const counts = await p.$$eval('.rv-counts span', s => s.map(x => +x.textContent));
  ok(counts[2] === 5, 'the counts are back to 5 due: ' + counts.join('/'));
  await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped'); await p.keyboard.press('3');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length === 1);
  ok((await rows(p)).reviewed.length === 1, 'answering it again works and saves');
  await ctx.close();
}

// ---- reload straight after an answer ----
{
  let lost = 0;
  for (let round = 0; round < 6; round++) {
    const { ctx, p } = await open(5);
    await start(p);
    const first = await answerShown(p, '3');
    await p.waitForFunction(prev => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== prev, first);
    await p.reload({ waitUntil: 'commit' });      // as soon as the next card shows
    await p.waitForSelector('.deck, .today-hero, #startBtn');
    const r = await rows(p);
    if (r.logs.length !== 1 || r.reviewed.length !== 1) lost++;
    await ctx.close();
  }
  ok(lost === 0, `reloading right after an answer lost nothing in 6 tries (lost ${lost})`);
}

// ---- the last card ----
{
  const { ctx, p } = await open(2);
  await start(p);
  await answerShown(p, '3');
  await p.waitForFunction(() => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() === 'c01');
  await answerShown(p, '3');
  await p.waitForSelector('.fin-links, #againBtn, .finish', { timeout: 8000 }).catch(() => {});
  const r = await rows(p);
  ok(r.logs.length === 2 && r.reviewed.length === 2, 'two answers, both saved by the time the finish screen shows');
  await ctx.close();
}

ok(errors.length === 0, 'no page errors: ' + errors.slice(0, 3).join(' | '));
await browser.close();
