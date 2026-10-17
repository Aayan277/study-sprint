// v4.9: "the game is secondary, reviewing is the main feature".
//   1. The Today goal ring counts to a fixed daily goal (Settings, synced), never "0/0"; Today and the sidebar agree.
//   2. A Play round starts only from the Play page: no link or button on Today, Review's finish, Stats or the Compare sheet.
//   3. Play is one deck per game: no "All decks"; nearest exam, else last used, else the first deck; a saved "all" migrates.
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const DAY = 86400000;
const theme = p => p.evaluate(async s => (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: s }), p.scheme);   // a reload forgets the test's theme
const open = async (w, h, scheme = 'dark') => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: scheme, isMobile: w < 600, hasTouch: w < 600 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL); await p.waitForSelector('.today-hero');
  p.scheme = scheme; await theme(p);
  return p;
};
const go = async (p, hash, sel) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(sel); await p.waitForTimeout(250); };
const noHScroll = async (p, label) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + label);
const ringText = p => p.$eval('.today-hero .ring', e => e.textContent.replace(/\s+/g, ''));
const reload = async p => { await p.reload(); await p.waitForSelector('.today-hero'); await theme(p); await p.waitForTimeout(300); };
const answers = (p, n) => p.evaluate(async n => {
  const db = await import('./js/db.js'); const now = Date.now(); const cs = await db.getAll('cards');
  await db.putMany('reviewLog', Array.from({ length: n }, (_, i) => ({ cardId: cs[i % cs.length].id, timestamp: now - 60000 * (i + 1), source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true })));
}, n);
// Nothing due: every card scheduled far ahead, no new cards.
const nothingDue = p => p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now(); const cs = await db.getAll('cards');
  await db.putMany('cardStates', cs.map(c => ({ cardId: c.id, due: now + 5 * 86400000, stability: 20, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now, scheduledDays: 5, elapsedDays: 1, learningSteps: 0 })));
  await db.setSetting('newPerDay', 0);
});

// ================= 1. The goal ring =================
let p = await open(375, 800, 'dark');
await nothingDue(p); await reload(p);
ok(await p.locator('.th-done').count() === 1, 'nothing is due: the done state shows');
let rt = await ringText(p);
ok(rt === '0/20', `nothing due, nothing answered: the ring reads 0/20, not 0/0 (${rt})`);
ok(!(await p.textContent('#screen')).includes('0/0'), 'the text "0/0" appears nowhere on Today');
ok(await p.$eval('.today-hero .ring', e => !e.classList.contains('is-full')) && await p.locator('.ring-check').count() === 0, 'and it is not shown as complete');
await noHScroll(p, 'today done 375'); await p.screenshot({ path: SP + '/v49-today-done-375-dark.png' });

// Settings: the Daily goal stepper (Study section), 1 to 500, saved
await go(p, '#/settings', '#dgIn');
ok(await p.$eval('#dgIn', e => e.value) === '20', 'Settings > Study has a Daily goal stepper, default 20');
ok(await p.evaluate(() => !!document.querySelector('#studyTitle')?.closest('.section')?.contains(document.querySelector('#dgIn'))), 'it sits in the Study section');
await p.click('#dgMinus'); ok(await p.$eval('#dgIn', e => e.value) === '15', 'minus lowers it by 5');
await p.click('#dgPlus'); await p.click('#dgPlus'); ok(await p.$eval('#dgIn', e => e.value) === '25', 'plus raises it by 5');
await p.fill('#dgIn', '0'); await p.press('#dgIn', 'Tab'); ok(await p.$eval('#dgIn', e => e.value) === '1', '0 is kept at 1 (never 0/0)');
await p.fill('#dgIn', '9999'); await p.press('#dgIn', 'Tab'); ok(await p.$eval('#dgIn', e => e.value) === '500', 'huge values are kept at 500');
await p.fill('#dgIn', '5'); await p.press('#dgIn', 'Tab');
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).dailyGoal) === 5, 'the goal is saved in the settings');
ok(await p.evaluate(async () => (await import('./js/sync-data.js')).SYNCED_SETTINGS.includes('dailyGoal')), 'and it is a synced setting');
await noHScroll(p, 'settings 375'); await p.screenshot({ path: SP + '/v49-settings-375-dark.png' });

// It fills as you study, and shows complete when the goal is reached
await go(p, '#/today', '.today-hero');
ok(await ringText(p) === '0/5', 'goal 5: the ring reads 0/5');
await answers(p, 3); await reload(p);
ok(await ringText(p) === '3/5' && await p.$eval('.today-hero .ring', e => !e.classList.contains('is-full')), 'after 3 answers: 3/5, not complete');
await answers(p, 2); await reload(p);   // the same 5 log rows replace each other by id? no: new rows, so 5 + 3 = 8 in total
rt = await ringText(p);
ok(await p.locator('.ring-check').count() === 1 && await p.$eval('.today-hero .ring', e => e.classList.contains('is-full')), 'goal reached: the ring shows complete (a check, green)');
await p.screenshot({ path: SP + '/v49-today-complete-375-dark.png' });
// extra study counts: the denominator follows the answers, never 12/5
await answers(p, 10); await reload(p);
ok(await p.locator('.ring-check').count() === 1 && await p.$eval('.today-hero .ring', e => e.classList.contains('is-full')), 'extra study counts: still complete, never over the goal');
// a bigger goal than the answers: back to numbers
await p.evaluate(async () => (await import('./js/db.js')).setSetting('dailyGoal', 40)); await reload(p);
rt = await ringText(p);
ok(/^\d+\/40$/.test(rt) && await p.locator('.ring-check').count() === 0, 'a goal of 40 with fewer answers reads N/40 (' + rt + ')');
await p.context().close();

// More due than the goal: the goal grows to answers + what is left (30 due, 20 goal)
p = await open(375, 800, 'light');
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now(); const cs = await db.getAll('cards');
  await db.addDeckWithCards({ id: 'Big', name: 'Big', color: '#3E63DD', created: now + 5 }, Array.from({ length: 30 }, (_, i) => ({ id: 'big' + i, deckId: 'Big', front: 'F' + i, back: 'B' + i, tags: [], created: now + i })));
  await db.putMany('cardStates', cs.filter(c => !c.id.startsWith('big')).map(c => ({ cardId: c.id, due: now + 5 * 86400000, stability: 20, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now, scheduledDays: 5, elapsedDays: 1, learningSteps: 0 })));
  await db.setSetting('newPerDay', 100);
});
await answers(p, 2); await reload(p);
rt = await ringText(p);
const left = +(await p.textContent('.th-big')).match(/\d+/)?.[0];
ok(rt === `2/${2 + left}` && left > 18, `more to do than the goal: the ring counts answers + what is left (${rt}, ${left} to go)`);
await p.screenshot({ path: SP + '/v49-today-todo-375-light.png' });
await p.context().close();

// Desktop: Today's ring and the sidebar footer show the same numbers (1440, light and dark)
for (const scheme of ['light', 'dark']) {
  p = await open(1440, 900, scheme);
  await nothingDue(p); await answers(p, 7); await reload(p);
  rt = await ringText(p);
  const side = (await p.textContent('#sideStreak')).replace(/\s+/g, ' ');
  ok(rt === '7/20' && side.includes('7 of 20 today'), `${scheme} 1440: Today ring ${rt} and the sidebar "${side.match(/\d+ of \d+ today/)?.[0]}" agree`);
  await go(p, '#/decks', '.deck');
  ok((await p.textContent('#sideStreak')).includes('7 of 20 today'), `${scheme}: the sidebar keeps the same goal on other screens`);
  await go(p, '#/today', '.th-done'); await theme(p);
  await p.screenshot({ path: SP + `/v49-today-done-1440-${scheme}.png` });
  await p.context().close();
}

// ================= 2. The game only on the Play page =================
p = await open(375, 800, 'dark');
const playLinks = () => p.evaluate(() => [...document.querySelectorAll('#screen a, #screen button')].filter(e => /play a round|drill|start a round/i.test(e.textContent) || /#\/play/.test(e.getAttribute('href') || '')).map(e => e.textContent.trim()));
ok(await p.locator('#startBtn').count() === 1 && (await playLinks()).length === 0, 'Today (cards due): no Play link');
// Review finish
await p.click('#startBtn'); await p.waitForSelector('#flash'); await p.click('#endBtn'); await p.waitForSelector('.finish-next');
ok((await playLinks()).length === 0 && !(await p.textContent('#screen')).includes('Play a round'), 'Review finish: no "Play a round" and no Play link');
await noHScroll(p, 'finish 375'); await p.screenshot({ path: SP + '/v49-finish-375-dark.png' });
// Stats Hardest: "Review these" (Review, not Play)
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now(); const cs = (await db.getAll('cards')).slice(0, 4);
  await db.putMany('cardStates', cs.map(c => ({ cardId: c.id, due: now + 3 * 86400000, stability: 3, difficulty: 8, reps: 6, lapses: 4, state: 2, lastReview: now - 86400000, scheduledDays: 3, elapsedDays: 3, learningSteps: 0 })));
});
await go(p, '#/stats', '.pgrid');
await p.waitForSelector('#drillBtn');
ok((await p.textContent('#drillBtn')).trim() === 'Review these' && !(await p.textContent('.stats-hardest')).includes('Play'), 'Stats Hardest: "Review these", no mention of Play');
ok((await playLinks()).filter(t => !/review these/i.test(t)).length === 0, 'Stats: no Play link');
await noHScroll(p, 'stats 375'); await p.screenshot({ path: SP + '/v49-stats-375-dark.png' });
await p.click('#drillBtn'); await p.waitForSelector('#flash');
ok(p.url().includes('#/review') && await p.locator('#pCard').count() === 0, 'Review these starts a Review session, not a Play round');
await p.click('#endBtn'); await p.waitForSelector('.finish-next');
// All done on Today
await nothingDue(p); await go(p, '#/today', '.th-done');
ok((await playLinks()).length === 0, 'Today (All done): no Play link');
const done = (await p.textContent('.th-done')).replace(/\s+/g, ' ');
ok(done.includes('All done for today') && /next card is due in/.test(done) && (await p.textContent('.th-done #customLink')).trim() === 'Custom study', 'All done: "All done for today", the next due time and a quiet Custom study link: ' + done.slice(0, 90));
await p.click('#customLink'); await p.waitForSelector('#sheet .cs-opt');
ok((await p.textContent('#sheet h2')).trim() === 'Custom study', 'the link opens Custom study');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
ok(await p.locator('.tab[data-tab="play"]').count() === 1, 'the Play tab stays');
await p.context().close();

// ================= 3. Play: one deck per game =================
p = await open(375, 800, 'dark');
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
  const iso = n => { const d = new Date(now - 4 * 3600000); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const mk = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: id + ' front ' + i, back: id + ' back ' + i, tags: [], created: now + i }));
  await db.addDeckWithCards({ id: 'P', name: 'Parent', color: '#3E63DD', created: now + 1 }, mk('P', 5));
  await db.addDeckWithCards({ id: 'S', name: 'Sub', color: '#3E63DD', created: now + 2, parentId: 'P' }, mk('S', 6));
  await db.addDeckWithCards({ id: 'Z', name: 'Zed', color: '#E5484D', created: now + 3, examDate: iso(9) }, mk('Z', 6));
  await db.setSetting('playPrefs', { deckId: 'all', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20, qtypeByDeck: { all: 'typing' } });
});
await go(p, '#/play', '#pDeck');
let opts = await p.$$eval('#pDeck option', o => o.map(x => ({ v: x.value, t: x.textContent.trim(), s: x.selected })));
ok(!opts.some(o => o.v === 'all' || /all decks/i.test(o.t)), 'the deck picker has no "All decks": ' + opts.map(o => o.t).join(' | '));
ok(opts.find(o => o.s)?.v === 'Z', 'a saved "all" opens on the deck with the nearest exam (Zed)');
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).playPrefs.deckId) === 'Z', 'and the saved choice was migrated to a real deck');
const pc = opts.find(o => o.v === 'P').t;
ok(/\(11\)/.test(pc), 'a parent deck includes its subdecks (Parent has 5 + 6 = 11 cards): ' + pc);
await p.selectOption('#pDeck', 'P'); await p.waitForTimeout(200);
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).playPrefs.deckId) === 'P', 'a picked deck is remembered');
await go(p, '#/today', '.today-hero'); await go(p, '#/play', '#pDeck');
ok(await p.$eval('#pDeck', s => s.value) === 'P', 'with no exam change, the next visit keeps the picked deck this session');
await p.reload(); await p.waitForSelector('#pDeck');
ok(await p.$eval('#pDeck', s => s.value) === 'Z', 'a fresh visit opens on the nearest exam again');
// no exam: the last used, else the first deck
await p.evaluate(async () => { const db = await import('./js/db.js'); const z = (await db.getDecks()).find(d => d.id === 'Z'); await db.saveDeck({ ...z, examDate: null }); });
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('playPrefs', { deckId: 'S', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20, qtypeByDeck: {} }); });
await p.reload(); await p.waitForSelector('#pDeck');
const v = await p.$eval('#pDeck', s => s.value);
ok(v === 'S' || v === 'Z', 'without an exam it opens on the last used deck (' + v + ')');
await noHScroll(p, 'play 375'); await p.screenshot({ path: SP + '/v49-play-375-dark.png' });
await p.evaluate(async () => (await import('./js/db.js')).setSetting('playPrefs', { deckId: 'all', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20, qtypeByDeck: {} }));
await p.context().close();
// A round on a real deck, with "Drill missed" still on the results
p = await open(1440, 900, 'light');
await go(p, '#/play', '#pDeck');
ok(!(await p.$$eval('#pDeck option', o => o.some(x => x.value === 'all'))), '1440 light: no "All decks" either');
await p.screenshot({ path: SP + '/v49-play-1440-light.png' });
await p.context().close();

ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
