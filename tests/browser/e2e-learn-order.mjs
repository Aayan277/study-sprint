// Settings → Study → Learning cards: where same-day learning cards go in a Review session (before / mixed with / after the
// reviews). Seeds 3 reviews, 2 learning cards and 2 new cards, changes the setting in Settings, starts Review and reads the
// order the cards come in. Also: the default is the old order, the choice is kept after a reload, and a card pressed Again
// waits for the end of the session in "After reviews".
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const MIN = 60000, HOUR = 3600000, D = 86400000;

const open = async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.stack));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.deleteDeck('sample');
    const now = Date.now(), D = 86400000, M = 60000;
    await db.saveDeck({ id: 'D', name: 'Order', course: '', color: '#46A758', parentId: '', created: now - 9000 });
    const ids = ['r1', 'r2', 'r3', 'L1', 'L2', 'n1', 'n2'];
    await db.saveCards(ids.map((id, i) => ({ id, deckId: 'D', front: id, back: 'A ' + id, created: now - 100000 + i })));
    const rev = (id, ago) => ({ cardId: id, due: now - ago, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 9 * D, elapsedDays: 9, scheduledDays: 5, learningSteps: 0 });
    const learn = (id, state, ago) => ({ cardId: id, due: now - ago, stability: 1, difficulty: 5, reps: 1, lapses: 0, state, lastReview: now - ago - 10 * M, elapsedDays: 0, scheduledDays: 0, learningSteps: 1 });
    await db.putStates([rev('r1', 4 * D), rev('r2', 3 * D), rev('r3', 2 * D), learn('L1', 1, 5 * M), learn('L2', 3, 60 * M)]);
  });
  return { ctx, p };
};
const setOrder = async (p, label) => {
  await p.goto('about:blank'); await p.goto(APP + '#/settings'); await p.waitForSelector('#learnOrderChips');
  await p.locator('#learnOrderChips .chip', { hasText: label }).click();
  const want = label.split(' ')[0].toLowerCase();
  await p.waitForFunction(async w => (await (await import('./js/db.js')).getSettings()).learnOrder === w, want);
};
const start = async p => { await p.goto('about:blank'); await p.goto(APP + '#/today'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash'); };
const front = p => p.locator('#flash .rv-front .flash-front').first().textContent().then(t => t.trim());
// Answer every card Easy (so none comes back) and return the order they were shown in.
const runAll = async (p, rating = '4') => {
  const seen = [];
  while (await p.locator('#flash').count()) {
    const f = await front(p);
    seen.push(f);
    await p.keyboard.press('Space');
    await p.waitForSelector('#flash.flipped');
    await p.keyboard.press(rating);
    await p.waitForFunction(prev => !document.querySelector('#flash') || document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== prev, f);
    if (seen.length > 20) break;
  }
  return seen.join(' ');
};

// ---- the default: nothing changes (the order the app has always used) ----
{
  const { ctx, p } = await open();
  await p.goto(APP + '#/settings'); await p.waitForSelector('#learnOrderChips');
  ok(await p.locator('#learnOrderChips input[value=mixed]').isChecked(), 'Settings → Study → Learning cards starts on "Mixed with reviews"');
  ok((await p.locator('#learnOrderChips .chip').allTextContents()).join('|') === 'Before reviews|Mixed with reviews|After reviews', 'the three choices read Before / Mixed with / After reviews');
  ok(await p.locator('#learnOrderRow a.help-link[href="#/help/learn-order"]').getAttribute('aria-label') === 'About where learning cards go', 'the ? link goes to Help, and has a label');
  ok(!(await p.locator('#learnOrderRow').textContent()).match(/the order|because|so that/i), 'no helper text on the screen: only the label and the choices');
  await start(p);
  ok(await runAll(p) === 'r1 r2 r3 n1 L2 L1 n2', 'default order is by due time with new cards spread through: ' + 'r1 r2 r3 n1 L2 L1 n2');
  await ctx.close();
}

// ---- before ----
{
  const { ctx, p } = await open();
  await setOrder(p, 'Before reviews');
  await p.reload(); await p.waitForSelector('#learnOrderChips');
  ok(await p.locator('#learnOrderChips input[value=before]').isChecked(), 'the choice is still there after a reload');
  await start(p);
  const first = await front(p);
  ok(first === 'L2', 'Before reviews: the first card is a learning card: ' + first);
  ok(await p.locator('.c-learn.now').count() === 1, 'and the Learn count is the underlined one');
  ok(await runAll(p) === 'L2 L1 r1 r2 n1 r3 n2', 'Before reviews: learning cards, then reviews with new cards between them');
  await ctx.close();
}

// ---- after ----
{
  const { ctx, p } = await open();
  await setOrder(p, 'After reviews');
  await start(p);
  ok(await runAll(p) === 'r1 r2 n1 r3 n2 L2 L1', 'After reviews: reviews and new cards, then the learning cards');
  await ctx.close();
}

// ---- after: a card you press Again on waits for the end ----
{
  const { ctx, p } = await open();
  await setOrder(p, 'After reviews');
  await start(p);
  // r1: Again (1). It goes back to learning (10 minutes, but the clock is fixed so it is "due" only when nothing else is left).
  await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped'); await p.keyboard.press('1');
  await p.waitForFunction(() => document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== 'r1');
  const rest = [];
  while (await p.locator('#flash').count() && rest.length < 10) {
    const f = await front(p); rest.push(f);
    await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped'); await p.keyboard.press('4');
    await p.waitForFunction(prev => !document.querySelector('#flash') || document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== prev, f);
  }
  ok(rest.join(' ') === 'r2 n1 r3 n2 L2 L1 r1', 'After reviews: the card pressed Again comes back after everything else: ' + rest.join(' '));
  await ctx.close();
}

// ---- the setting is a synced one, saved like the others ----
{
  const { ctx, p } = await open();
  await setOrder(p, 'Before reviews');
  const saved = await p.evaluate(async () => {
    const db = await import('./js/db.js'), sd = await import('./js/sync-data.js');
    return { value: (await db.getSettings()).learnOrder, synced: sd.SYNCED_SETTINGS.includes('learnOrder') };
  });
  ok(saved.value === 'before' && saved.synced, 'the choice is saved and is one of the synced settings');
  await ctx.close();
}

// ---- Undo when the card you answered is the one on screen again (the only card left is a learning card) ----
{
  const { ctx, p } = await open();
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const keep = (await db.getAll('cards')).filter(c => c.id === 'L1');
    await db.deleteDeck('D');
    await db.saveDeck({ id: 'D', name: 'Order', course: '', color: '#46A758', parentId: '', created: Date.now() - 9000 });
    await db.saveCards(keep);
    const now = Date.now();
    await db.putStates([{ cardId: 'L1', due: now - 5 * 60000, stability: 1, difficulty: 5, reps: 1, lapses: 0, state: 1, lastReview: now - 900000, elapsedDays: 0, scheduledDays: 0, learningSteps: 1 }]);
  });
  await start(p);
  ok(await front(p) === 'L1', 'undo case: the only card is a learning card');
  await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped'); await p.keyboard.press('1');
  await p.waitForFunction(() => document.querySelector('#flash:not(.flipped)'));
  ok(await front(p) === 'L1', 'Again: it is shown again at once');
  await p.keyboard.press('z');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length === 0);
  await p.waitForFunction(() => document.querySelector('#flash:not(.flipped)'));
  const counts = await p.$$eval('.rv-counts span', e => e.map(x => +x.textContent));
  ok(counts.join('/') === '0/1/0', 'after Undo the Learn count is 1, not 2: ' + counts.join('/'));
  await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped'); await p.keyboard.press('4');
  await p.waitForFunction(() => !document.querySelector('#flash'), null, { timeout: 8000 });
  ok(await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length) === 1, 'one Easy ends the session: no second copy of the card, one log row');
  await ctx.close();
}

// ---- "After reviews" does not apply to Custom study (Study ahead keeps its own order) ----
{
  const { ctx, p } = await open();
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.deleteDeck('D');
    await db.saveDeck({ id: 'A', name: 'Ahead', course: '', color: '#46A758', parentId: '', created: Date.now() - 9000 });
    const now = Date.now(), D = 86400000;
    const ids = ['a1', 'a2', 'a3'];
    await db.saveCards(ids.map((id, i) => ({ id, deckId: 'A', front: id, back: 'A ' + id, created: now - 100000 + i })));
    await db.putStates(ids.map((id, i) => ({ cardId: id, due: now + D + i * 1000, stability: 6, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 9 * D, elapsedDays: 9, scheduledDays: 6, learningSteps: 0 })));
    await db.setSetting('learnOrder', 'after');
  });
  await p.goto('about:blank'); await p.goto(APP + '#/review/A'); await p.waitForSelector('#aheadBtn');
  await p.click('#aheadBtn'); await p.waitForSelector('#flash');
  const seen = [];
  const answerNow = async key => {
    const f = await front(p);
    seen.push(f);
    await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped'); await p.keyboard.press(key);
    await p.waitForFunction(prev => document.querySelector('#flash:not(.flipped)') && document.querySelector('#flash .rv-front .flash-front')?.textContent.trim() !== prev, f);
  };
  await answerNow('1');                                                 // a1: Again (relearning step 10 minutes)
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12, 30));          // half an hour later: a1 is due again
  await answerNow('4');                                                 // a2
  seen.push(await front(p));
  ok(seen.join(' ') === 'a1 a2 a1', 'Study ahead with "After reviews" on: the card you pressed Again on comes back as soon as it is due: ' + seen.join(' '));
  await ctx.close();
}

ok(errors.length === 0, 'no page errors: ' + errors.slice(0, 3).join(' | '));
await browser.close();
