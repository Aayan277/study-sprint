import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const card = front => page.evaluate(async f => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === f), front);
const rows = () => page.$$eval('.crow .f', fs => fs.map(f => f.textContent));
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// give a few cards schedules
await page.evaluate(async () => { const db = await import('./js/db.js'); const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created); const now = Date.now();
  await db.putMany('cardStates', [{ cardId: cs[0].id, due: now - 86400000, stability: 4, difficulty: 7, reps: 3, lapses: 2, state: 2 }, { cardId: cs[1].id, due: now + 5 * 86400000, stability: 9, difficulty: 3, reps: 4, lapses: 0, state: 2 }]);
  await db.addLog({ cardId: cs[0].id, timestamp: now - 3600000, source: 'review', correct: false, rating: 1, ms: 4200, state: 2 }); });
await page.click('.deck-open'); await page.waitForSelector('.crow');
ok((await page.locator('.crow').count()) === 12, 'deck page lists all 12 cards');
ok((await page.textContent('#brCount')) === '12 cards', 'count shown');
await noHScroll('card list'); await page.screenshot({ path: SP + '/b-list.png' });

// search, filter, sort
await page.fill('#brQuery', 'MEMORY'); await page.waitForFunction(() => document.querySelectorAll('.crow').length === 1);
ok((await rows())[0] === 'Working memory' && (await page.textContent('#brCount')).includes('Showing 1 of 12'), 'search finds Working memory');
await page.fill('#brQuery', ''); await page.waitForFunction(() => document.querySelectorAll('.crow').length === 12);
await page.selectOption('#brFilter', 'due'); await page.waitForFunction(() => document.querySelectorAll('.crow').length === 1);
ok((await rows())[0] === 'Classical conditioning', 'Due today filter');
await page.selectOption('#brFilter', 'all'); await page.selectOption('#brSort', 'az');
ok((await rows())[0] === 'Classical conditioning' && (await rows())[11] === 'Working memory', 'A → Z sort');
await page.selectOption('#brSort', 'lapses');
ok((await rows())[0] === 'Classical conditioning', 'Most forgotten sort');

// card panel: edit, flag, suspend, bury, info
await page.locator('.crow', { hasText: 'Placebo effect' }).click(); await page.waitForSelector('#ceForm');
await page.screenshot({ path: SP + '/b-panel.png', fullPage: true });
await page.fill('#ceBack', 'Getting better because you believe you were treated'); await page.fill('#ceTags', 'Research, Exam 1');
await page.click('button[type=submit][form=ceForm]'); await page.waitForTimeout(400);
let c = await card('Placebo effect');
ok(c.back === 'Getting better because you believe you were treated' && c.tags.join() === 'research,exam 1', 'edit back and tags');
await page.click('[data-flag="1"]'); await page.waitForTimeout(400);
ok((await card('Placebo effect')).flag === 1, 'red flag set');
await page.click('[data-act="suspend"]'); await page.waitForTimeout(400);
ok((await card('Placebo effect')).suspended === true && (await page.textContent('#sheetTitle')).includes('Suspended'), 'suspended (panel shows it)');
await page.click('.sheet-x');
ok((await page.locator('.crow', { hasText: 'Placebo effect' }).locator('.st').textContent()) === 'Suspended', 'list shows Suspended');
await page.locator('.crow', { hasText: 'Neuroplasticity' }).click(); await page.click('[data-act="bury"]'); await page.waitForTimeout(400);
ok((await card('Neuroplasticity')).buriedUntil > Date.now(), 'buried until tomorrow'); await page.click('.sheet-x');
await page.locator('.crow', { hasText: 'Classical conditioning' }).click();
await page.click('.card-info summary');
ok((await page.textContent('.card-info')).includes('Forgotten2 times') || (await page.textContent('.card-info')).includes('2 times'), 'card info shows lapses');
ok((await page.locator('.history tbody tr').count()) === 1 && (await page.textContent('.history')).includes('Again'), 'card info shows answer history');
await page.screenshot({ path: SP + '/b-info.png', fullPage: true });
// set due date + reset
await page.fill('#ceDue', '3'); await page.click('#ceDueBtn'); await page.waitForTimeout(400);
let st = await page.evaluate(async () => { const db = await import('./js/db.js'); const c = (await db.getAll('cards')).find(c => c.front === 'Classical conditioning'); return db.get('cardStates', c.id); });
ok(st.due > Date.now() + 2 * 86400000 && st.due < Date.now() + 4 * 86400000 && st.stability === 4, 'set due date to 3 days, FSRS memory kept');
await page.click('[data-act="reset"]'); await page.click('#cfYes'); await page.waitForTimeout(400);
st = await page.evaluate(async () => { const db = await import('./js/db.js'); const c = (await db.getAll('cards')).find(c => c.front === 'Classical conditioning'); return db.get('cardStates', c.id); });
ok(!st, 'reset to new removes the schedule');
await page.click('.sheet-x');

// Review and Play skip suspended / buried
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn');
ok((await page.textContent('#startBtn')).includes('9 cards'), 'Review leaves out the suspended and buried cards (12 − 2 hidden − 1 not due): ' + await page.textContent('#startBtn'));
await page.click('.tab[data-tab=play]'); await page.waitForSelector('#pDeck');
ok((await page.textContent('#pDeck option')).includes('10 cards'), 'Play leaves them out too');

// select several + bulk actions + add card + delete
await page.click('.tab[data-tab=decks]'); await page.waitForSelector('.deck'); await page.click('.deck-open'); await page.waitForSelector('.crow');
ok((await page.textContent('.deck-summary')).includes('2 suspended or buried'), 'deck summary counts suspended/buried');
await page.click('#brSelect');
await page.locator('.crow').nth(0).click(); await page.locator('.crow').nth(1).click(); await page.locator('.crow').nth(2).click();
ok((await page.textContent('#brSel')) === '3 selected', 'select 3 cards');
await page.screenshot({ path: SP + '/b-select.png' });
await page.click('#brActions'); await page.waitForSelector('[data-act="unsuspend"]');
await page.click('[data-flag="3"]'); await page.waitForTimeout(400);
const greens = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.flag === 3).length);
ok(greens === 3, 'bulk green flag on 3 cards');
await page.selectOption('#brFilter', 'flag3'); await page.waitForFunction(() => document.querySelectorAll('.crow').length === 3);
ok((await page.textContent('#brAll')) === 'Clear', 'with everything shown selected, the button offers Clear');
await page.click('#brActions'); await page.click('[data-act="delete"]'); await page.click('#cfYes');
await page.waitForFunction(() => document.querySelectorAll('.crow').length === 0 && document.querySelector('.crows .empty'));
ok((await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).length)) === 9, 'bulk delete removed 3 cards');
await page.click('#brSelect'); await page.selectOption('#brFilter', 'all');
await page.click('#brAdd'); await page.fill('#acFront', 'Heuristic'); await page.fill('#acBack', 'A mental shortcut'); await page.click('button[type=submit][form=acForm]');
await page.waitForFunction(() => document.getElementById('acFront').value === '');
await page.fill('#acFront', 'Schema'); await page.fill('#acBack', 'A mental framework'); await page.click('button[type=submit][form=acForm]');
await page.waitForTimeout(400); await page.click('#acDone');
ok((await page.locator('.crow').count()) === 11 && (await page.textContent('.deck-summary')).includes('11'), 'added 2 cards one after another; counts updated');
// move a card to a new deck via the All cards browser
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ id: 'other', name: 'Other deck', color: '#46A758', created: Date.now() }); });
await page.goto('http://localhost:8123/#/browse'); await page.waitForSelector('.crow');
ok((await page.locator('.crow .d').count()) === 11, 'All cards browser shows each card\'s deck');
await page.locator('.crow', { hasText: 'Schema' }).click(); await page.selectOption('#ceMove', 'other'); await page.click('#ceMoveBtn'); await page.waitForTimeout(400);
ok((await card('Schema')).deckId === 'other', 'moved card to another deck');
await page.click('.sheet-x'); await noHScroll('all cards');
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
