import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
// the deck picker (a sheet with a searchable tree): '' is All decks
const pickDeck = async id => { await page.click('#sDeckBtn'); await page.click(`.pick-row[data-id="${id}"]`); };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// empty-ish state first: stats with no history
await page.click('.tab[data-tab=stats]'); await page.waitForSelector('.pgrid');
ok((await page.textContent('.pgrid')).includes('Review or play today'), 'no history: friendly streak message');
ok((await page.textContent('.pgrid')).includes('–'), 'no history: retention shows a dash');

// Seed: second deck, states at every level, 30 days of logs with a 5-day streak.
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const DAY = 86400000, now = Date.now();
  const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
  const st = (c, state, stability, dueIn, lapses) => ({ cardId: c.id, due: now + dueIn * DAY, stability, difficulty: 5, elapsedDays: 1, scheduledDays: 1, learningSteps: 0, reps: 4, lapses, state, lastReview: now - DAY });
  await db.putMany('cardStates', [
    st(cs[0], 2, 40, 12, 0), st(cs[1], 2, 30, 3, 1), st(cs[2], 2, 8, 1, 4), st(cs[3], 2, 5, 0, 2),
    st(cs[4], 3, 1, 0.01, 3), st(cs[5], 1, 1, 0.005, 0), st(cs[6], 2, 3, -2, 1), st(cs[7], 2, 25, 6, 0)
  ]);
  const logs = [];
  for (let d = 0; d < 30; d++) {
    if ((d >= 5 && d % 3 === 0) || d === 7) continue;     // gaps, but the last 5 days are all studied. Days 6 and 7 are both missed: a streak freeze covers one missed day, not two (v4.1), so the streak is still 6
    const n = 3 + ((d * 7) % 11);
    for (let i = 0; i < n; i++) {
      const c = cs[(d + i) % 8];
      logs.push({ cardId: c.id, timestamp: now - d * DAY - i * 60000, source: i % 4 === 0 ? 'play' : 'review', mode: 'flip', correct: (d + i) % 5 !== 0, ms: 4000, rating: 3, state: 2, applied: true, reason: 'due' });
    }
  }
  await db.putMany('reviewLog', logs);
  await db.addDeckWithCards({ id: 'chem', name: 'Chemistry', color: '#46A758', created: now + 1 },
    ['Atom', 'Ion', 'Isotope', 'Molecule', 'Acid'].map((f, i) => ({ id: 'chem' + i, deckId: 'chem', front: f, back: f + ' definition', tags: [], created: i })));
});
await page.click('.tab[data-tab=decks]'); await page.click('.tab[data-tab=stats]'); await page.waitForSelector('.chart');
ok((await page.textContent('.pgrid .big')).trim().startsWith('6'), 'streak of 6 days (days 0-5 studied): ' + (await page.textContent('.pgrid .big')).trim());
ok((await page.locator('.wd.on').count()) === 6 && (await page.locator('.wd.today.on').count()) === 1, '7-day dots: 6 of 7 on (day 6 skipped), today highlighted');
const retText = await page.locator('.pgrid .card').nth(1).textContent();
ok(/\d+%/.test(retText) && /remembered \d+ of \d+ due reviews/.test(retText), 'retention shown: ' + retText.replace(/\s+/g, ' ').trim());
// Retention counts recall only: the Play answers here are multiple choice (mode 'flip' is not typing), so they are left out.
const shownTotal = +/of (\d+) due reviews/.exec(retText)[1];
const reviewLogs = await page.evaluate(async () => { const { daysAgoStart } = await import('./js/stats-calc.js'); const since = daysAgoStart(29);
  return (await (await import('./js/db.js')).getLogsSince(since)).filter(l => l.source === 'review' && l.state === 2).length; });
ok(shownTotal === reviewLogs, `retention counts the ${reviewLogs} Review answers, not the Play multiple choice ones: ${shownTotal}`);
ok(/Multiple choice isn.t counted/.test(retText), 'the Retention card says multiple choice is not counted');
ok((await page.locator('#perDay .col').count()) === 30 && (await page.locator('#forecast .col').count()) === 7, '30-day and 7-day charts drawn');
ok((await page.locator('#perDay .cap').count()) === 1, 'only the peak column is labeled');
await noHScroll('stats');
await page.screenshot({ path: SP + '/s-top.png' });
// tooltip by tap
await page.locator('#forecast .col').first().tap();
ok(!(await page.isHidden('#forecast .chart-tip')) && (await page.textContent('#forecast .chart-tip')).includes('Scheduled for today'), 'tapping a column shows its tooltip: ' + await page.textContent('#forecast .chart-tip'));
await page.locator('#forecast').scrollIntoViewIfNeeded(); await page.screenshot({ path: SP + '/s-forecast.png' });
// table view
await page.locator('#perDay + .chart-table summary').click();
ok((await page.locator('#perDay + .chart-table tbody tr').count()) === 30, 'table view lists all 30 days');
// hardest cards + drill
ok((await page.locator('.hard-list li').count()) >= 5, 'hardest cards listed');
ok((await page.locator('.hard-list li .f').first().textContent()) === 'Negative reinforcement', 'most-forgotten card first (4 lapses)');
// "More stats": folded on a phone, with what's always shown above it
ok(await page.isVisible('#moreBtn') && await page.getAttribute('#moreBtn', 'aria-expanded') === 'false' && await page.isHidden('#moreBody'), 'phone: "More stats" starts folded');
ok(await page.isHidden('#btnTitle') && await page.isHidden('#hours') && await page.isHidden('#difficulty') && await page.isHidden('#mTitle'), 'folded away: answer buttons, time of day, difficulty, mastery');
ok(await page.isVisible('#calTitle') && await page.isVisible('#perDay') && await page.isVisible('#forecast') && await page.isVisible('#hardTitle') && await page.isVisible('.pgrid'), 'always shown: streak, retention, calendar, reviews per day, due in 7 days, hardest cards');
await noHScroll('stats folded'); await page.screenshot({ path: SP + '/s-folded.png', fullPage: true });
await page.click('#moreBtn');
ok(await page.getAttribute('#moreBtn', 'aria-expanded') === 'true' && await page.isVisible('#btnTitle') && await page.isVisible('#hours') && await page.isVisible('#difficulty') && await page.isVisible('#mTitle'), 'tapping More stats shows the four sections');
await noHScroll('stats expanded'); await page.screenshot({ path: SP + '/s-expanded.png', fullPage: true });
await page.reload(); await page.waitForSelector('.chart');
ok(await page.getAttribute('#moreBtn', 'aria-expanded') === 'true' && await page.isVisible('#mTitle'), 'the open fold is remembered after a reload');
await page.click('#moreBtn'); await page.reload(); await page.waitForSelector('.chart');
ok(await page.isHidden('#mTitle'), 'and so is closing it');
await page.click('#moreBtn');
// mastery
ok((await page.locator('.mtile').count()) === 17, 'mastery grid has every card (12 + 5)');
ok((await page.locator('.mdeck h3').count()) === 2, 'grid grouped by deck');
await page.locator('.mtile').nth(2).click(); await page.waitForSelector('#mDetail .hd');
ok((await page.textContent('#mDetail')).includes('Negative reinforcement') && (await page.locator('#mDetail .hd').count()) > 0, 'tapping a square shows the card and its last answers');
await page.locator('.mdeck').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: SP + '/s-mastery.png' });
// deck filter
await pickDeck('chem'); await page.waitForFunction(() => document.querySelectorAll('.mtile').length === 5);
ok((await page.textContent('.pgrid .card:nth-child(2)')).includes('–'), 'filter: Chemistry has no reviews yet');
ok((await page.locator('.mdeck h3').count()) === 0, 'filter: single deck has no deck heading');
await pickDeck(''); await page.waitForFunction(() => document.querySelectorAll('.mtile').length === 17);
// a huge deck: only the first squares are drawn, "Show more" adds the rest, and a pressed square stays one
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.putMany('cards', Array.from({ length: 1200 }, (_, i) => ({ id: 'big' + i, deckId: 'chem', front: 'Q' + i, back: 'A' + i, tags: [], created: 1e9 + i })));
});
await page.reload(); await page.waitForSelector('.mtile');
ok((await page.locator('.mtile').count()) === 500, 'big library: only the first 500 squares are drawn');
await page.locator('.mmore').first().click();
ok((await page.locator('.mtile').count()) > 500, 'Show more draws more squares');
await page.locator('.mtile').nth(3).click(); await page.locator('.mtile').nth(4).click();
ok((await page.locator('.mtile[aria-pressed="true"]').count()) === 1, 'only one square is pressed');
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.deleteCards(Array.from({ length: 1200 }, (_, i) => 'big' + i)); });
// leaving Stats while it is still drawing must not throw
await page.evaluate(() => { location.hash = '#/stats'; setTimeout(() => { location.hash = '#/decks'; }, 0); });
await page.waitForSelector('.deck'); await page.waitForTimeout(600);
ok(errors.length === 0, 'leaving Stats mid-draw throws nothing ' + errors.join(' | '));
await page.goto('http://localhost:8123/#/stats'); await page.reload(); await page.waitForSelector('.pgrid');
// full page in dark mode
await page.evaluate(async () => { const t = await import('./js/themes.js'); t.applyTheme({ skin: 'ink', mode: 'dark' }); });
await page.screenshot({ path: SP + '/s-dark.png', fullPage: true });
// v4.9: Hardest "Review these" opens a Review session of those cards (the game is only on the Play page)
const hardN = await page.locator('#hardList li').count();
ok((await page.textContent('#drillBtn')).trim() === 'Review these', 'Hardest button reads "Review these"');
await page.click('#drillBtn'); await page.waitForSelector('#flash');
ok(page.url().includes('#/review') && !(await page.locator('#pCard').count()), 'Review these starts a Review session, not Play');
let reviewed = 0;
while (!(await page.$('.finish-next'))) {
  await page.waitForSelector('#showBtn, .finish-next');
  if (await page.$('.finish-next')) break;
  await page.click('#showBtn'); await page.click('.rate.r4'); reviewed++;   // Easy: seen once
  await page.waitForFunction(() => !document.querySelector('.rate'));
}
ok(reviewed === hardN, `the session covers the ${hardN} hardest cards (${reviewed})`);
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
