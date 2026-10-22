// First run: the short start on a brand-new install (pitch, name your course, add cards, guided review),
// skipping it, never seeing it again, and upgrades never seeing it. Uses the real browser launcher
// (not the one that skips onboarding) because the first run is exactly what's tested here.
import { realChromium as chromium } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
// A fresh phone-sized browser window with empty storage.
const fresh = async (w = 375, h = 812) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return page;
};
const noHScroll = async (page, w) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const counts = page => page.evaluate(async () => { const db = await import('./js/db.js'); return { decks: await db.getDecks(), cards: (await db.getAll('cards')).length, states: (await db.getAll('cardStates')).length, logs: (await db.getAll('reviewLog')).length, settings: await db.getSettings() }; });

// ---- the whole walk, on a phone ----
let p = await fresh();
await p.goto(URL); await p.waitForSelector('#wlNext');
ok(p.url().endsWith('#/welcome'), 'a brand-new install opens on the first-run start');
let c = await counts(p);
ok(c.decks.length === 0 && c.cards === 0, 'no sample deck is added on a fresh install');
ok(!(await p.locator('.tabs').isVisible()) && !(await p.locator('.top').isVisible()), 'the tab bar and header are hidden during the start');
ok((await p.textContent('h1')).length > 10 && (await p.locator('.lp-points li').count()) === 3, 'step 1 is a one-screen pitch with three points');
ok((await p.textContent('#wlNext')).trim() === 'Get started' && (await p.textContent('.lp-free')).includes('no account'), 'the pitch button and the free / no account line');
ok((await p.textContent('.lp-demo .lp-rates')).includes('8d'), 'the pitch demo shows Easy as 8d, like the real scheduler');
ok(await p.locator('.lp-demo .lp-rates span').count() === 4 && (await p.textContent('.lp-demo .lp-rates')).includes('Again'), 'the pitch shows a mini card with the four ratings and their intervals');
ok(!(await p.locator('.lp-stage').isVisible()), 'phone width: no phone mock, the mini card is inline');
ok(await p.locator('#wlSkip').isVisible(), 'step 1 can be skipped');
await noHScroll(p, 'pitch'); await p.screenshot({ path: SP + '/onb-1.png' });
await p.click('#wlNext'); await p.waitForSelector('#wlForm');
ok((await p.textContent('h1')) === 'Name your course', 'step 2 is Name your course');
ok(await p.locator('#wlSkip').isVisible() && await p.locator('#wlBack').isVisible(), 'step 2 has Skip and Back');
ok((await p.textContent('#wlForm button[type=submit]')).trim() === 'Create course', 'the step 2 button says Create course, not Create deck');
ok(await p.$eval('#wlExam', e => e.classList.contains('empty') && getComputedStyle(e).color !== getComputedStyle(document.getElementById('wlName')).color), 'an empty exam date is styled as a placeholder (muted)');
await p.screenshot({ path: SP + '/onb-2.png' });
await p.click('#wlForm button[type=submit]');
ok(!(await p.locator('#wlErr').isHidden()) && (await p.textContent('#wlErr')).includes('name'), 'an empty name is asked for');
await p.fill('#wlName', 'Cell Biology'); await p.fill('#wlCourse', 'BIOL 201');
await p.fill('#wlExam', '2020-01-01'); await p.click('#wlForm button[type=submit]');
ok((await p.textContent('#wlErr')).includes('passed'), 'a past exam date is refused');
const exam = new Date(Date.now() + 20 * 864e5), examISO = `${exam.getFullYear()}-${String(exam.getMonth() + 1).padStart(2, '0')}-${String(exam.getDate()).padStart(2, '0')}`;
await p.fill('#wlExam', examISO); await p.click('#wlForm button[type=submit]'); await p.waitForSelector('#wlPaste');
c = await counts(p);
ok(c.decks.length === 1 && c.decks[0].name === 'Cell Biology' && c.decks[0].course === 'BIOL 201' && c.decks[0].examDate === examISO, 'the deck is made with its code and exam date');
ok((await p.textContent('h1')).includes('Cell Biology'), 'step 3 names the deck');
const opts = await p.$$eval('.wl-opt-t', e => e.map(x => x.textContent));
ok(JSON.stringify(opts.map(x => x.replace(/\s*Fastest.*$/, ''))) === '["Try it with sample cards","Paste your notes","Import a file or Anki deck"]' && opts[0].includes('Fastest'), 'step 3 has the three choices, the sample first and labelled honestly: ' + opts);
ok(await p.locator('#wlSkip').isVisible(), 'step 3 can be skipped');
await noHScroll(p, 'add cards'); await p.screenshot({ path: SP + '/onb-3.png' });
// Back keeps what was typed and doesn't make a second deck
await p.click('#wlBack'); await p.waitForSelector('#wlForm');
ok(await p.inputValue('#wlName') === 'Cell Biology' && await p.inputValue('#wlExam') === examISO, 'Back keeps what you typed');
await p.click('#wlForm button[type=submit]'); await p.waitForSelector('#wlPaste');
ok((await counts(p)).decks.length === 1, 'going back and forward does not make a second deck');

// Paste notes: Import opens with this deck chosen, and after saving, the guided review follows
await p.click('#wlPaste'); await p.waitForSelector('#pasteBox');
const deckId = c.decks[0].id;
ok(p.url().endsWith('#/import/' + deckId) && await p.inputValue('#deckSel') === deckId, 'paste notes opens Import with the new deck chosen');
ok(await p.locator('#pasteBox').isVisible(), 'the paste box is showing');
await p.fill('#pasteBox', 'Mitochondria - makes ATP\nRibosome - builds proteins\nNucleus - holds the DNA\nGolgi - packs proteins\nLysosome - digests waste');
await p.waitForSelector('#saveBtn:not([disabled])'); await p.click('#saveBtn');
await p.waitForSelector('.guide #coach');
ok(p.url().endsWith('#/welcome/review/' + deckId), 'after the import, the guided review starts');
ok((await p.textContent('.wl-count')).includes('Card 1 of 3'), 'the guided review is 3 cards');
ok((await p.textContent('#coach')).toLowerCase().includes('tap the card to flip'), 'hint: tap to flip');
ok(!(await p.locator('.tabs').isVisible()), 'the tab bar stays hidden in the guided review');
await noHScroll(p, 'guided front'); await p.screenshot({ path: SP + '/onb-4a.png' });
// accessible flip, like Review: the question is readable (the card is not one big "Show answer" button), a separate Show answer button, the hidden face is inert
ok(await p.evaluate(() => { const f = document.getElementById('flash'); return !f.getAttribute('role') && !f.getAttribute('aria-label') && !f.querySelector('.rv-front').closest('[aria-hidden]') && !!f.querySelector('.flash-front').textContent.trim(); }), 'guided card: the question is readable, the card is not a "Show answer" button');
ok(await p.evaluate(() => { const b = document.querySelector('.rv-back'); return b.inert && b.getAttribute('aria-hidden') === 'true'; }), 'guided card: the answer face is hidden and inert before the flip');
ok((await p.textContent('#showBtn')).trim() === 'Show answer', 'guided card: a separate Show answer button');
await p.click('#flash');
await p.waitForSelector('.rate');
ok(await p.evaluate(() => { const f = document.querySelector('.rv-front'), b = document.querySelector('.rv-back'); return f.inert && f.getAttribute('aria-hidden') === 'true' && !b.inert && !b.hasAttribute('aria-hidden') && document.activeElement === b; }), 'guided card: after the flip the question face is inert and focus is on the answer');
ok((await p.textContent('#coach')).toLowerCase().includes('rate how well you knew it'), 'hint: rate how well you knew it');
ok((await p.textContent('#coach .coach-key')).includes('Again: forgot'), 'the coach lists what the four buttons mean');
ok(await p.locator('.rate').count() === 4 && (await p.textContent('.rate.r3 span')).length > 0, 'four rating buttons with intervals');
await noHScroll(p, 'guided back'); await p.screenshot({ path: SP + '/onb-4b.png' });
await p.click('.rate.r3'); await p.waitForSelector('#showBtn');
ok((await p.textContent('.wl-count')).includes('Card 2 of 3'), 'next card');
await p.keyboard.press('Space'); await p.waitForSelector('.rate');   // keys work like Review: Space flips, 1-4 rate
await p.keyboard.press('1');
await p.waitForSelector('#showBtn'); await p.click('#showBtn'); await p.click('.rate.r4');
await p.waitForSelector('#wlGo');
c = await counts(p);
ok((await p.textContent('.lede')).includes('the wait grows') && (await p.textContent('.wl-foot')).includes('How the app picks your cards'), 'the done screen explains how the wait grows and links to Help');
ok(c.states === 3 && c.logs === 3, 'the 3 guided answers were saved as real reviews: ' + c.states + ' schedules, ' + c.logs + ' log rows');
ok(c.settings.onboarded === true, 'the start is marked as done');
await noHScroll(p, 'done'); await p.screenshot({ path: SP + '/onb-5.png' });
ok(!(await p.locator('.fr-next').count()) && (await p.locator('.fr-when li').count()) === 3, 'after your own cards the done screen lists when each card comes back, with no "add cards" nag');
await p.click('#wlGo'); await p.waitForSelector('.today-hero');
ok(p.url().endsWith('#/today') && await p.locator('.tabs').isVisible(), 'Go to Today shows the tab bar again');
await p.reload(); await p.waitForSelector('.today-hero');
ok(p.url().endsWith('#/today'), 'it never shows again after reload');
await p.goto(URL + '#/welcome'); await p.waitForSelector('.today-hero');
ok(p.url().endsWith('#/today'), 'opening #/welcome after the start goes to Today');
await p.goto(URL); await p.waitForSelector('.today-hero');
ok(p.url().endsWith('#/today'), 'and a fresh open lands on Today');
await p.context().close();

// ---- the sample deck choice ----
p = await fresh();
await p.goto(URL); await p.waitForSelector('#wlNext'); await p.click('#wlNext');
await p.fill('#wlName', 'Psych'); await p.click('#wlForm button[type=submit]'); await p.waitForSelector('#wlSample');
await p.click('#wlSample'); await p.waitForSelector('.guide #showBtn');
c = await counts(p);
ok(c.decks.some(d => d.id === 'sample') && c.cards === 12, 'Try the sample deck adds the sample deck (fixed id "sample", 12 cards)');
ok((await p.textContent('.flash-deck')).includes('sample'), 'the guided review uses the sample deck');
await p.click('#gSkip'); await p.waitForSelector('.today-hero');
c = await counts(p);
ok(p.url().endsWith('#/today') && c.states === 0, 'Skip the walk-through goes to Today without saving anything');
await p.context().close();

// ---- skipping at step 1 ----
p = await fresh();
await p.goto(URL); await p.waitForSelector('#wlSkip'); await p.click('#wlSkip');
await p.waitForSelector('.empty');
c = await counts(p);
ok(c.decks.length === 0 && c.settings.onboarded === true, 'Skip leaves the app empty and remembers it');
ok((await p.textContent('.empty')).includes('Nothing to study yet'), 'Today shows its empty state');
await p.reload(); await p.waitForSelector('.empty');
ok(p.url().endsWith('#/today'), 'after skipping, it does not come back');
await p.context().close();

// ---- leaving by any other way counts as skipping; the file choice opens the File tab ----
p = await fresh();
await p.goto(URL); await p.waitForSelector('#wlNext'); await p.click('#wlNext');
await p.fill('#wlName', 'Chem'); await p.click('#wlForm button[type=submit]'); await p.waitForSelector('#wlFile');
await p.click('#wlFile'); await p.waitForSelector('#fileIn', { state: 'attached' });
ok(p.url().includes('#/import/') && p.url().endsWith('/file') && await p.locator('#pane-file').isVisible(), 'import a file opens Import on the File tab');
await p.reload(); await p.waitForSelector('#fileIn', { state: 'attached' });
await p.goto(URL); await p.waitForSelector('.today-hero, .empty');
ok(!p.url().endsWith('welcome'), 'it never shows again once a choice was made');
await p.context().close();
p = await fresh();
await p.goto(URL); await p.waitForSelector('#wlNext'); await p.click('#wlNext');
await p.click('.back, #wlBack'); await p.waitForSelector('#wlNext');
await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.empty');
await p.goto(URL); await p.waitForSelector('.empty');
ok(p.url().endsWith('#/today'), 'leaving through a link counts as skipping');
await p.context().close();

// ---- upgrades and tests: no start ----
p = await fresh();
await p.goto(URL + '?skipOnboarding'); await p.waitForSelector('.today-hero');
c = await counts(p);
ok(c.decks.length === 1 && c.decks[0].id === 'sample' && c.cards === 12, '?skipOnboarding opens the app with the sample deck, as before');
// An old install: has the old "seeded" flag and data, but not the new "onboarded" flag
await p.evaluate(async () => { const db = await import('./js/db.js'); const d = await db.openDB(); await new Promise(r => { const tx = d.transaction('settings', 'readwrite'); tx.objectStore('settings').delete('onboarded'); tx.oncomplete = r; }); });
await p.goto(URL + 'index.html'); await p.waitForSelector('.today-hero');
ok(p.url().endsWith('#/today') && (await counts(p)).settings.onboarded === true, 'an install from before this version never sees the start');
// Same, but the deck was deleted (data empty, seeded still set)
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.deleteDeck('sample'); const d = await db.openDB(); await new Promise(r => { const tx = d.transaction('settings', 'readwrite'); tx.objectStore('settings').delete('onboarded'); tx.oncomplete = r; }); });
await p.goto(URL + 'index.html'); await p.waitForSelector('.empty');
ok(p.url().endsWith('#/today') && (await counts(p)).decks.length === 0, 'an old install whose decks were all deleted does not get the start or the sample back');
await p.context().close();
// An old install with a deck but no flags at all (e.g. restored backup)
p = await fresh();
await p.goto(URL + '?skipOnboarding'); await p.waitForSelector('.today-hero');
await p.evaluate(async () => { const db = await import('./js/db.js'); const d = await db.openDB(); await new Promise(r => { const tx = d.transaction('settings', 'readwrite'); tx.objectStore('settings').clear(); tx.oncomplete = r; }); });
await p.goto(URL + 'index.html'); await p.waitForSelector('.today-hero');
ok(p.url().endsWith('#/today'), 'a device with decks but no saved flags never sees the start');
await p.context().close();

// ---- no built-in starter or JLPT decks are offered ----
p = await fresh();
await p.goto(URL + '?skipOnboarding#/decks'); await p.waitForSelector('.deck');
ok(await p.locator('#startersBox, .starter, [data-starter]').count() === 0 && !/starter decks|JLPT/i.test(await p.textContent('#screen')), 'Decks shows no starter or JLPT section');
await p.goto(URL + '#/import'); await p.waitForSelector('#screen h1, #screen h2');
ok(await p.locator('#readyMade').count() === 0 && !/ready-made|starter decks|JLPT/i.test(await p.textContent('#screen')), 'Import shows no ready-made or JLPT section');
await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
ok(!(await p.content()).includes('JLPT'), 'no JLPT deck is mentioned on Today');
await p.context().close();

// ---- after the start: no way back, and the sample deck is never overwritten ----
p = await fresh();
await p.goto(URL); await p.waitForSelector('#wlNext'); await p.click('#wlNext'); await p.waitForSelector('#wlForm');
await p.fill('#wlName', 'Bio'); await p.click('#wlForm button[type=submit]'); await p.waitForSelector('#wlLater');
await p.click('#wlLater'); await p.waitForSelector('.crow, .empty');
await p.goBack(); await p.waitForTimeout(400);
ok(!p.url().includes('welcome'), 'Back after the start does not return to it: ' + p.url());
await p.goto(URL + '#/decks'); await p.waitForSelector('.empty, .deck');
await p.evaluate(() => { location.hash = '#/welcome'; }); await p.waitForTimeout(500);
ok(p.url().endsWith('#/today'), '#/welcome goes to Today once the start is done');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'sample', name: 'My edited sample', color: '#46A758', created: 1 }, [{ id: 'sx', deckId: 'sample', front: 'q', back: 'a', tags: [], created: 1 }]); });
await p.evaluate(() => { location.hash = '#/welcome/again'; }); await p.waitForSelector('#wlNext');
ok(p.url().endsWith('#/welcome/again'), '#/welcome/again re-opens the pitch ("How it works")');
await p.context().close();
p = await fresh();
await p.goto(URL); await p.waitForSelector('#wlNext'); await p.click('#wlNext'); await p.waitForSelector('#wlForm');
await p.fill('#wlName', 'Bio'); await p.click('#wlForm button[type=submit]'); await p.waitForSelector('#wlSample');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'sample', name: 'My edited sample', color: '#46A758', created: 1 }, [{ id: 'sx', deckId: 'sample', front: 'q', back: 'a', tags: [], created: 1 }]); });
await p.click('#wlSample'); await p.waitForSelector('#coach, .today-hero, .empty'); await p.waitForTimeout(300);
const sampleNow = await p.evaluate(async () => { const db = await import('./js/db.js'); return { name: (await db.getDeck('sample')).name, cards: (await db.getAll('cards')).filter(c => c.deckId === 'sample').length }; });
ok(sampleNow.name === 'My edited sample' && sampleNow.cards === 1, 'Try the sample deck leaves an existing sample deck alone');
await p.context().close();

// ---- desktop ----
p = await fresh(1440, 900);
await p.goto(URL); await p.waitForSelector('#wlNext');
ok(!(await p.locator('.tabs').isVisible()) && !(await p.locator('.top').isVisible()), 'desktop: the sidebar is hidden during the start');
const box = await p.locator('.view > .welcome').boundingBox();
ok(box.x > 100 && box.width > 900 && await p.locator('.lp-stage').isVisible() && !(await p.locator('.lp-demo').isVisible()), 'desktop: two columns, the copy beside a phone mock: x=' + Math.round(box.x) + ' w=' + Math.round(box.width));
const cb = await p.locator('.lp-copy').boundingBox(), sb = await p.locator('.lp-phone').boundingBox();
ok(sb.x > cb.x + cb.width - 5, 'desktop: the phone sits to the right of the copy');
await p.screenshot({ path: SP + '/onb-desktop.png' });
await p.context().close();

await browser.close();
if (errors.length) { console.log('ERRORS\n' + errors.join('\n')); process.exitCode = 1; }
