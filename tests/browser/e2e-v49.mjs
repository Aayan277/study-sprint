// v4.9: "the game is secondary, reviewing is the main feature".
//   1. (v4.10: replaced the daily goal) The Today ring is today's work: done / (due + new), never "0/0"; Today and the sidebar agree.
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

// ================= 1. The Today ring = today's work =================
// Finish n of today's new cards the way Review does: a review-log row (state 0 = it was new) and a schedule five days out.
const study = (p, n) => p.evaluate(async n => {
  const db = await import('./js/db.js'); const { loadAll } = await import('./js/study-data.js');
  const now = Date.now(); const data = await loadAll(); const cs = data.split.fresh.slice(0, n);
  await db.putMany('cardStates', cs.map(c => ({ cardId: c.id, due: now + 5 * 86400000, stability: 20, difficulty: 5, reps: 1, lapses: 0, state: 2, lastReview: now, scheduledDays: 5, elapsedDays: 0, learningSteps: 0 })));
  await db.putMany('reviewLog', cs.map((c, i) => ({ cardId: c.id, timestamp: now - 60000 * (i + 1), source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 0, applied: true })));
  return cs.length;
}, n);
let p = await open(375, 800, 'dark');
// Work left: N to go, and the ring reads done/total
let rt = await ringText(p);
const toGo = +(await p.textContent('.th-big')).match(/\d+/)?.[0];
ok(toGo > 3 && rt === `0/${toGo}`, `work left: "${toGo} to go", the ring reads 0/${toGo} (${rt})`);
ok((await p.textContent('.th-label')).trim() === 'TODAY' && !(await p.textContent('#screen')).includes('DAILY GOAL'), 'the ring label is TODAY, not DAILY GOAL');
ok(!(await p.textContent('#screen')).includes('All cards learned'), 'unseen new cards left: no "All cards learned" line');
await study(p, 3); await reload(p);
rt = await ringText(p);
ok(rt === `3/${toGo}` && await p.$eval('.today-hero .ring', e => !e.classList.contains('is-full')), `after 3 cards: 3/${toGo}, the total does not move (${rt})`);
await p.screenshot({ path: SP + '/v49-today-todo-375-dark.png' });
// Everything done: All done for today, a check, the learned line, Extra study (a normal secondary button)
await study(p, 999); await reload(p);
ok(await p.locator('.th-done').count() === 1 && await p.locator('#startBtn').count() === 0, 'all done: the done state shows');
ok((await p.textContent('.th-big')).trim() === 'All done for today', 'all done: "All done for today"');
ok(await p.locator('.ring-check').count() === 1 && await p.$eval('.today-hero .ring', e => e.classList.contains('is-full')), 'all done: the ring is complete (a check, green)');
ok((await p.textContent('.th-learned')).trim() === 'All cards learned · only reviews from now', 'no unseen new cards left: "All cards learned · only reviews from now"');
ok(!(await p.textContent('#screen')).includes('0/0'), 'the text "0/0" appears nowhere on Today');
const ex = p.locator('.th-done #customLink');
ok((await ex.textContent()).trim() === 'Extra study' && await ex.evaluate(e => e.classList.contains('btn') && e.classList.contains('ghost') && !e.classList.contains('primary')), 'a plain secondary "Extra study" button');
await noHScroll(p, 'today done 375'); await p.screenshot({ path: SP + '/v49-today-done-375-dark.png' });
ok(await ex.evaluate(e => { const s = getComputedStyle(e); return s.backgroundImage === 'none' && s.boxShadow === 'none'; }), 'Extra study has no gradient and no glow');
await ex.click(); await p.waitForSelector('#sheet .cs-opt');
ok((await p.textContent('#sheet h2')).trim() === 'Custom study', 'all done: Extra study opens the Custom study sheet');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
await p.context().close();

// Nothing due at all: a calm state, never 0/0
p = await open(375, 800, 'dark');
await nothingDue(p); await reload(p);
ok((await p.textContent('.th-big')).trim() === 'Nothing due today', 'nothing due: "Nothing due today"');
rt = await ringText(p);
ok(await p.locator('.ring-check').count() === 1 && await p.$eval('.today-hero .ring', e => e.classList.contains('is-full')) && !rt.includes('/'), `nothing due: the ring is full with a check, not 0/0 (${rt})`);
ok(!(await p.textContent('#screen')).includes('0/0') && /next card is due in/.test(await p.textContent('.th-done')), 'nothing due: no 0/0 and the next due time is shown');
ok((await p.textContent('.th-learned')).includes('All cards learned'), 'nothing due and no new cards left: the learned line too');
await noHScroll(p, 'today nothing due 375'); await p.screenshot({ path: SP + '/v49-today-nothing-375-dark.png' });

// Settings: no Daily goal stepper, a Play switch (off), synced
await go(p, '#/settings', '#playCounts');
ok(await p.locator('#dgIn, #dgMinus, #dgPlus').count() === 0 && !(await p.textContent('#screen')).includes('Daily goal'), 'Settings has no Daily goal stepper');
ok(await p.$eval('#playCounts', e => !e.checked), 'Settings: "Count Play answers as reviews" is off by default');
ok((await p.textContent('.switch-row:has(#playCounts)')).includes("Off: Play is practice only and doesn't change when cards are due, stats or streaks."), 'with its hint');
await p.click('#playCounts');
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).playCountsAsReviews) === true, 'switching it on saves the setting');
ok(await p.evaluate(async () => (await import('./js/sync-data.js')).SYNCED_SETTINGS.includes('playCountsAsReviews')), 'and it is a synced setting');
await p.click('#playCounts');
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).playCountsAsReviews) === false, 'and off again');
await p.evaluate(async () => (await import('./js/db.js')).setSetting('dailyGoal', 40));      // an old synced value
await noHScroll(p, 'settings 375'); await p.screenshot({ path: SP + '/v49-settings-375-dark.png' });
await go(p, '#/today', '.today-hero');
ok((await p.textContent('.th-big')).trim() === 'Nothing due today', 'a leftover dailyGoal changes nothing on Today');
await p.context().close();

// Desktop: Today's ring and the sidebar footer show the same numbers (1440, light and dark)
for (const scheme of ['light', 'dark']) {
  p = await open(1440, 900, scheme);
  const n0 = +(await p.textContent('.th-big')).match(/\d+/)?.[0];
  await study(p, 4); await reload(p);
  rt = await ringText(p);
  let side = (await p.textContent('#sideStreak')).replace(/\s+/g, ' ');
  ok(rt === `4/${n0}` && side.includes(`4 of ${n0} today`), `${scheme} 1440: Today ring ${rt} and the sidebar "${side.match(/\d+ of \d+ today/)?.[0]}" agree`);
  await go(p, '#/decks', '.deck');
  ok((await p.textContent('#sideStreak')).includes(`4 of ${n0} today`), `${scheme}: the sidebar keeps the same numbers on other screens`);
  await study(p, 999); await go(p, '#/today', '.th-done'); await theme(p);
  side = (await p.textContent('#sideStreak')).replace(/\s+/g, ' ');
  ok(side.includes(`${n0} of ${n0} today`), `${scheme} 1440: all done reads ${n0} of ${n0} in the sidebar`);
  await p.screenshot({ path: SP + `/v49-today-done-1440-${scheme}.png` });
  await p.context().close(); p = await open(1440, 900, scheme);
  await nothingDue(p); await reload(p);
  side = (await p.textContent('#sideStreak')).replace(/\s+/g, ' ');
  ok(side.includes('Nothing due today') && !side.includes('0 of 0'), `${scheme} 1440: nothing due reads "Nothing due today" in the sidebar`);
  await p.screenshot({ path: SP + `/v49-today-nothing-1440-${scheme}.png` });
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
ok((await p.textContent('.today-hero .th-big')).trim() === 'Nothing due today' && /next card is due in/.test(done) && (await p.textContent('.th-done #customLink')).trim() === 'Extra study', 'Nothing due: "Nothing due today", the next due time and an Extra study button: ' + done.slice(0, 90));
await p.click('#customLink'); await p.waitForSelector('#sheet .cs-opt');
ok((await p.textContent('#sheet h2')).trim() === 'Custom study', 'Extra study opens the Custom study sheet');
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
ok(v === 'S', 'without an exam it opens on the last used deck (' + v + ')');
await noHScroll(p, 'play 375'); await p.screenshot({ path: SP + '/v49-play-375-dark.png' });
await p.context().close();
// A round on a real deck, with "Drill missed" still on the results
p = await open(1440, 900, 'light');
await p.evaluate(async () => (await import('./js/db.js')).setSetting('playPrefs', { deckId: 'all', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20, qtypeByDeck: { all: 'typing' } }));
await go(p, '#/play', '#pDeck');
const sel = await p.$eval('#pDeck', s => s.value);
ok(!(await p.$$eval('#pDeck option', o => o.some(x => x.value === 'all'))) && sel !== 'all' && sel !== '', '1440 light: a saved "all" opens on a real deck (' + sel + ')');
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).playPrefs.deckId) === sel, '1440 light: and the migrated deck is saved');
await p.screenshot({ path: SP + '/v49-play-1440-light.png' });
await p.context().close();

ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
