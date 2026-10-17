// v4.10: Play is practice only by default (Settings > "Count Play answers as reviews" off).
// The hardest case for "changes nothing": an exam deck (where Play would start new cards), a new card, a due card,
// leechThreshold 1 (one miss would make a leech), typing mode, and Drill missed. Everything stored must be unchanged.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const iso = d => { const x = new Date(Date.now() + d * 86400000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async exam => {
  const db = await import('./js/db.js'); const day = 86400000;
  await db.addDeckWithCards({ id: 'px', name: 'Exam practice', color: '#E5484D', created: Date.now() + 5, examDate: exam },
    ['a', 'b', 'c', 'd', 'e'].map((f, i) => ({ id: 'px' + i, deckId: 'px', front: 'Q ' + f, back: 'answer ' + f, tags: [], created: i })));
  // px0 is due (a miss would be a lapse and, with threshold 1, a leech); px1..px4 are new cards in an exam deck
  await db.putStates([{ cardId: 'px0', due: Date.now() - day, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: Date.now() - 10 * day }]);
  await db.setSetting('leechThreshold', 1);
  await db.setSetting('newPerDay', 5);
  await db.setSetting('playPrefs', { deckId: 'px', fmt: 'classic', qtype: 'typing', hard: false, flash: 0, len: 10, qtypeByDeck: {} });
}, iso(5));

const snapshot = () => page.evaluate(async () => {
  const db = await import('./js/db.js'); const { loadAll } = await import('./js/study-data.js');
  const byId = rows => JSON.stringify(rows.sort((a, b) => String(a.id ?? a.cardId).localeCompare(String(b.id ?? b.cardId))));
  const d = await loadAll();
  return { states: byId(await db.getAll('cardStates')), cards: byId(await db.getAll('cards')), logs: (await db.getAll('reviewLog')).length,
    newLeft: d.newLeft.total, newLeftByDeck: JSON.stringify([...d.newLeft.byDeck]), settingOn: (await db.getSettings()).playCountsAsReviews };
});
const before = await snapshot();
ok(before.settingOn === false || before.settingOn === undefined, 'the setting is off');

// A round of wrong typed answers, then Drill missed, also all wrong
const wrongRound = async () => {
  for (let i = 0; i < 30; i++) {
    await page.waitForFunction(() => document.querySelector('.stamp') || (document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pInput')));
    if (await page.$('.stamp')) return;
    await page.fill('#pInput', 'definitely wrong'); await page.keyboard.press('Enter');
    await page.waitForSelector('.fb'); await page.keyboard.press('Enter');
  }
};
await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
ok(await page.inputValue('#pDeck') === 'px', 'Play opens on the exam deck');
await page.click('#startBtn'); await page.waitForSelector('#pInput');
await wrongRound();
await page.waitForSelector('.stamp');
ok((await page.textContent('.sched-note')).includes('Practice only'), 'the results say it was practice only');
ok(await page.locator('#drillBtn').count() === 1, 'Drill missed is offered');
await page.click('#drillBtn'); await page.waitForSelector('#pInput');
await wrongRound();
await page.waitForSelector('.stamp');
await page.waitForTimeout(500);

const after = await snapshot();
ok(after.states === before.states, 'cardStates are unchanged (no new card started, the due card not touched)');
ok(after.cards === before.cards, 'cards are unchanged (no leech tag, nothing suspended)');
ok(after.logs === before.logs, `reviewLog length is unchanged (${before.logs})`);
ok(after.newLeft === before.newLeft && after.newLeftByDeck === before.newLeftByDeck, `new cards left today are unchanged (${before.newLeft})`);
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
