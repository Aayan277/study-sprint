// Round 2 #8: on a computer, Enter (or S) on Today starts or resumes studying; the Start button's tooltip shows the key cap.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })).newPage();
const errors = []; p.on('pageerror', e => errors.push(e.message));
await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'B', name: 'Second', color: '#E5484D', created: now + 1 }, [1, 2, 3, 4].map(i => ({ id: 'b' + i, deckId: 'B', front: 'B front ' + i, back: 'B back ' + i, tags: [], created: i })));
});
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
// the tooltip
await p.hover('#startBtn'); await p.waitForSelector('.ui-tip:not([hidden])');
ok(/Start studying/.test(await p.textContent('.ui-tip')) && (await p.textContent('.ui-tip kbd')) === 'Enter', 'the Start tooltip says what it does and shows the Enter key cap');
await p.mouse.move(5, 5);
// Enter starts
await p.keyboard.press('Enter'); await p.waitForSelector('#flash');
ok(true, 'Enter on Today starts studying');
await p.click('#endBtn'); await p.waitForSelector('.finish-next'); await p.click('#againBtn'); await p.waitForSelector('#startBtn');
// S starts
await p.keyboard.press('s'); await p.waitForSelector('#flash');
ok(true, 'S on Today starts studying');
// resume
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#startBtn[data-resume]');
ok(/Resume/.test(await p.textContent('#startBtn')), 'with a session in progress the same key resumes it');
await p.keyboard.press('Enter'); await p.waitForSelector('#flash');
ok((await p.evaluate(() => location.hash)).startsWith('#/review'), 'Enter resumed the session');
await p.click('#endBtn'); await p.waitForSelector('.finish-next'); await p.click('#againBtn'); await p.waitForSelector('#startBtn');
// not while typing, not on a focused control
await p.click('#optBtn'); await p.waitForSelector('#sheet[open]'); await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#sheet').open);
await p.evaluate(() => document.querySelector('#optBtn').focus()); await p.keyboard.press('Enter'); await p.waitForSelector('#sheet[open]');
ok(await p.locator('#flash').count() === 0, 'Enter on a focused button presses that button, not Start');
await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#sheet').open);
// single keys off: S does nothing, Enter still works
await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('singleKeys', false); (await import('./js/shortcuts.js')).configureShortcuts({ singleKeys: false }); });
await p.evaluate(() => document.activeElement?.blur()); await p.keyboard.press('s'); await p.waitForTimeout(400);
ok(await p.locator('#flash').count() === 0, 'with single-key shortcuts off, S does nothing');
await p.keyboard.press('Enter'); await p.waitForSelector('#flash');
ok(true, 'and Enter still starts');
// holding Enter on Today must not rate cards in the session it starts
await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('singleKeys', true); (await import('./js/shortcuts.js')).configureShortcuts({ singleKeys: true }); });
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
await p.evaluate(() => document.activeElement?.blur());
const logsBefore = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length);
for (let i = 0; i < 25; i++) { await p.keyboard.down('Enter'); await p.waitForTimeout(40); }
await p.keyboard.up('Enter');
await p.waitForTimeout(300);
const logsAfter = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length);
ok(logsAfter === logsBefore, `holding Enter for a second wrote no review logs (${logsBefore} -> ${logsAfter})`);
ok(await p.locator('#flash').count() === 1 && await p.locator('#flash.flipped').count() === 0, 'and the first card is still waiting, not flipped');
ok(errors.length === 0, 'no page errors: ' + errors.join('|'));
await browser.close();
