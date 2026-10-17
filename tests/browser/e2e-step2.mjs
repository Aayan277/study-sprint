// Today and Review follow-ups: Today's count matches the queue it starts, typing mode, the flip and its focus,
// exam prep, starting while a session is going, a failed Review load, and the small consistency fixes.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console ' + m.text()); });
page.on('dialog', d => { errors.push('browser dialog: ' + d.message()); d.dismiss(); });     // the app has its own confirm sheets
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const run = (fn, arg) => page.evaluate(fn, arg);
const counts = () => page.$$eval('.rv-counts span', s => s.reduce((n, x) => n + (+x.textContent || 0), 0));
const goToday = async () => { await page.evaluate(() => { location.hash = '#/today'; }); await page.waitForSelector('.today-hero'); };

await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('.tdeck');

// ---- Today's number is the size of the queue Start builds ----
const shown = +(await page.textContent('#startBtn')).match(/(\d+) cards?/)[1];
await page.click('#startBtn'); await page.waitForSelector('#flash');
ok(shown === 12 && (await counts()) === shown, `Today says ${shown} cards and the session has ${await counts()}`);
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');

// ---- Typing mode is saved and used ----
await run(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'T', name: 'Short answers', color: '#46A758', created: now + 5 }, [1, 2, 3].map(i => ({ id: 't' + i, deckId: 'T', front: 'Short ' + i, back: 'ans' + i, tags: [], created: i })));
});
await page.reload(); await page.waitForSelector('.tdeck');
await page.click('#optBtn'); await page.waitForSelector('#modeChips');
await page.click('#modeChips [data-typing="1"]');
await page.click('#deckChips [data-deck="T"]'); await page.click('#optDone');
ok(await run(async () => (await (await import('./js/db.js')).getSettings()).reviewTyping) === true, 'typing mode is saved in the settings');
await page.reload(); await page.waitForSelector('.tdeck');
await page.click('#startBtn'); await page.waitForSelector('#flash');
ok(await page.locator('#typeForm #typeIn').count() === 1, 'a session with typing on shows the answer box');
ok(await page.evaluate(() => document.activeElement?.id) === 'typeIn', 'and the box has focus');
await page.fill('#typeIn', 'ans1'); await page.keyboard.press('Enter');
await page.waitForSelector('.rv-card.flipped');
ok((await page.textContent('.rv-typed')).includes('Correct'), 'typed answer is checked: ' + (await page.textContent('.rv-typed')).trim());
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');
await page.click('#optBtn'); await page.click('#modeChips [data-typing="0"]'); await page.click('#deckChips [data-all]'); await page.click('#optDone');

// ---- Flip: what screen readers and the keyboard see ----
await page.click('#startBtn'); await page.waitForSelector('#flash');
const face = sel => page.$eval(sel, f => ({ hidden: f.getAttribute('aria-hidden'), inert: f.inert }));
const before = { front: await face('.rv-front'), back: await face('.rv-back') };
ok(await page.locator('.key-line').count() === 1 && await page.isHidden('.key-line'), 'phones do not see the keyboard hint');
ok(before.back.hidden === 'true' && before.back.inert && !before.front.inert && before.front.hidden === null, 'before the flip the back is hidden and inert, the front is not');
ok(await page.evaluate(() => { const b = document.querySelector('.rv-back'); b.focus(); return document.activeElement === b; }) === false, 'the back cannot be focused before the flip');
await page.focus('#flash'); await page.keyboard.press('Space');
await page.waitForSelector('.rv-card.flipped');
const after = { front: await face('.rv-front'), back: await face('.rv-back') };
ok(after.front.hidden === 'true' && after.front.inert && !after.back.inert && after.back.hidden === null, 'after the flip the front is hidden and inert, the back is not');
ok(await page.evaluate(() => document.activeElement?.classList.contains('rv-back')), 'focus moves to the answer, not to the page');
await page.keyboard.press('3');
await page.waitForFunction(() => !document.querySelector('.rv-card.flipped'));
ok(await page.evaluate(() => document.activeElement?.id) === 'flash', 'after rating, focus is on the next card (' + await page.evaluate(() => document.activeElement?.tagName + '#' + document.activeElement?.id) + ')');
// the same with the Show answer button
await page.click('#showBtn');
ok(await page.evaluate(() => document.activeElement?.classList.contains('rv-back')), 'Show answer also moves focus to the answer');
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');

// ---- A long answer does not stretch the front ----
await run(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'L', name: 'Long answers', color: '#E5484D', created: Date.now() + 9 }, [{ id: 'l1', deckId: 'L', front: 'Short question', back: 'A long answer that goes on and on. '.repeat(120), tags: [], created: 1 }]);
});
await page.reload(); await page.waitForSelector('.tdeck');
await page.click('.tdeck:has-text("Long answers")'); await page.waitForSelector('#flash');
const frontH = await page.$eval('.rv-front', f => f.offsetHeight);
await page.click('#showBtn'); await page.waitForSelector('.rv-card.flipped');
const backH = await page.$eval('.rv-back', f => f.offsetHeight);
ok(frontH < backH * 0.5, `front is not stretched to a long answer (${frontH}px, the answer card is ${backH}px)`);
ok(await page.isVisible('.rate'), 'and the rating buttons are there after the flip');
await page.screenshot({ path: SP + '/s2-long.png' });
ok((await page.url()).endsWith('#/review/L'), 'one deck\'s session has its deck in the address: ' + page.url());
await page.reload(); await page.waitForSelector('#flash');
ok((await page.textContent('.flash-deck')).includes('Long answers'), 'reloading keeps the deck');
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');

// ---- A session in progress: Start resumes the same decks, asks for different ones ----
await page.click('#startBtn'); await page.waitForSelector('#flash');
const firstFront = await page.textContent('.flash-front');
await page.click('#showBtn'); await page.click('[data-rate="3"]'); await page.waitForFunction(() => document.querySelector('#undoBtn') && !document.querySelector('#undoBtn').disabled);
const left = await counts();
await goToday();
ok(await page.locator('.resume').count() === 1, 'Today shows the session in progress');
await page.click('#startBtn');
await page.waitForSelector('#flash');
ok(await page.locator('#soNew').count() === 0 && (await counts()) === left && !(await page.$eval('#undoBtn', b => b.disabled)), 'Start with the same decks carries on with that session (undo still there)');
await goToday();
await page.click('.tdeck:has-text("Short answers")');
await page.waitForSelector('#soNew');
ok((await page.textContent('#sheet')).includes('Start over?') && (await page.textContent('#sheet')).includes("lose this session's undo"), 'a different deck asks "Start over?" in the page');
await page.click('#soKeep'); await page.waitForSelector('#flash');
ok((await counts()) === left, 'Keep going returns to the same session');
await goToday();
await page.click('.tdeck:has-text("Short answers")'); await page.waitForSelector('#soNew'); await page.click('#soNew');
await page.waitForSelector('#flash');
ok((await page.textContent('.flash-deck')).includes('Short answers') && await page.locator('#undoBtn').count() === 0, 'Start over begins the other deck\'s session');
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');

// ---- Exam prep is not swallowed by a session in progress ----
await run(async () => {
  const db = await import('./js/db.js'); const x = new Date(Date.now() + 9 * 86400000);
  await db.saveDeck({ ...(await db.getDeck('T')), examDate: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` });
});
await page.reload(); await page.waitForSelector('.tdeck');
await page.click('#startBtn'); await page.waitForSelector('#flash');         // a session for everything is going
await run(() => { location.hash = '#/deck/T'; }); await page.waitForSelector('#prepBtn');
await page.click('#prepBtn');
await page.waitForSelector('#soNew');
ok(true, 'Exam prep during another session asks first');
await page.click('#soNew'); await page.waitForSelector('#flash');
ok((await page.textContent('.flash-deck')).includes('Exam prep') && (await page.textContent('.flash-deck')).includes('Short answers'), 'and then starts the exam prep session, not the old one: ' + (await page.textContent('.flash-deck')).trim());
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');
// from Today's exam list, with no session going: straight in
await page.click('[data-prep="T"]'); await page.waitForSelector('#flash');
ok((await page.textContent('.flash-deck')).includes('Exam prep'), 'Exam prep from the Today list starts the exam session');
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');
// the deck page's Review button never leaves a stale prep behind
await run(() => { location.hash = '#/deck/T'; }); await page.waitForSelector('#reviewBtn');
await page.click('#reviewBtn'); await page.waitForSelector('#flash');
ok(!(await page.textContent('.flash-deck')).includes('Exam prep'), 'a plain Review after exam prep is a plain session');
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');

// ---- Custom study lists exams only for the chosen decks ----
await page.click('#optBtn'); await page.click('#deckChips [data-deck="L"]'); await page.click('#customBtn'); await page.waitForSelector('#csAheadBtn');
ok(await page.locator('#csPrepBtn').count() === 0, 'Custom study: no Exam prep when the chosen decks have no exam');
await page.click('.sheet-x'); await page.click('#optBtn'); await page.click('#deckChips [data-all]'); await page.click('#deckChips [data-deck="T"]'); await page.click('#customBtn'); await page.waitForSelector('#csAheadBtn');
ok(await page.locator('#csPrepBtn').count() === 1 && (await page.textContent('#sheet')).includes('Short answers'), 'Custom study: Exam prep is there for a chosen deck with an exam');
await page.click('.sheet-x'); await page.click('#optBtn'); await page.click('#deckChips [data-all]'); await page.click('#optDone');

// ---- Daily goal counts the chosen decks only ----
await page.click('.tdeck:has-text("Short answers")'); await page.waitForSelector('#flash');
await page.click('#showBtn'); await page.click('[data-rate="3"]'); await page.waitForFunction(() => !document.querySelector('.rv-card.flipped'));
await page.click('#endBtn'); await page.waitForSelector('.finish-next'); await page.click('#againBtn'); await page.waitForSelector('.today-hero');
// v4.10: the ring's number is the cards finished today, each card once. Hand-computed for this session: sample-0 was rated Good
// twice (a review, state 2, due in 2 days: one finished card) and t1 once (a new card in its learning steps, due in 10 minutes:
// still "to go", not finished). So the ring reads 1 with all decks chosen, and 0 for deck L, which nothing was answered in.
const goalDone = () => page.evaluate(() => { const b = document.querySelector('.th-main .ring-in b'); return b ? +b.textContent : null; });
ok((await goalDone()) === 1, 'all decks: the ring counts the 1 finished card (the learning card is still to go)');
await page.click('#optBtn'); await page.click('#deckChips [data-deck="L"]'); await page.click('#optDone');
ok((await goalDone()) === 0, 'one other deck chosen: its ring does not count cards finished elsewhere');
await page.click('#allDecksBtn');

// ---- A failed Review load keeps you on Today, and nothing starts later ----
await page.route('**/js/review.js', r => r.abort());
await page.reload(); await page.waitForSelector('#startBtn');
await page.click('#startBtn');
await page.waitForFunction(() => /open Review/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden);
ok(page.url().endsWith('#/today'), 'a failed load of Review shows a message and stays on Today');
await page.unroute('**/js/review.js');
await run(async () => { (await import('./js/study-data.js')).setLaunch({ deckIds: ['T'], kind: null }); location.hash = '#/decks'; });
await page.waitForSelector('.deck');
ok(await run(async () => (await import('./js/study-data.js')).takeLaunch()) === null, 'a hand-over that never reached Review is dropped when you go elsewhere');

// ---- Deck tile numbers are today's numbers ----
await run(async () => { await (await import('./js/db.js')).setSetting('newPerDay', 3); });
await page.reload(); await page.waitForSelector('.deck');
const tile = (await page.textContent('article.deck:has-text("Intro to Psychology") .deck-counts')).replace(/\s+/g, ' ');
const study = await page.getAttribute('article.deck:has-text("Intro to Psychology") [data-study]', 'aria-label');      // the small round play button says it in its label
const [, tDue, tNew] = tile.match(/(\d+) due (\d+) new/) || [];
ok(+tNew <= 3 && +tDue + +tNew === +study.match(/: (\d+) cards?/)[1] && +tNew > 0, 'tile and Study button agree, with the limit of 3 new a day applied: ' + tile.trim() + ' | ' + study.trim());

// ---- The keyboard hint shows on a computer only ----
const desk = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await desk.goto('http://localhost:8123/#/today'); await desk.waitForSelector('#startBtn'); await desk.click('#startBtn'); await desk.waitForSelector('#flash');
ok(await desk.isVisible('.key-line') && (await desk.textContent('.key-line')).includes('Space to flip'), 'computers see "Space to flip · 1–4 rate"');
ok(errors.length === 0, 'no console errors or browser dialogs ' + errors.join(' | '));
await browser.close();
