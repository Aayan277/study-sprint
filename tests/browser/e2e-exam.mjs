import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true })).newPage();
page.on('pageerror', e => errors.push(e.stack));
await page.goto('http://localhost:8123/'); await page.waitForSelector('.deck');
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const inDays = n => { const d = new Date(Date.now() + n * DAY); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// half the sample deck studied: some due far after the exam, one well known, the rest seen recently
await page.evaluate(async () => {
  const db = await import('./js/db.js'); const D = 86400000, now = Date.now();
  const st = (i, due, stability, last) => ({ cardId: `sample-${i}`, due, stability, difficulty: 4, reps: 4, lapses: 0, state: 2, lastReview: last, elapsedDays: 5, scheduledDays: 30, learningSteps: 0 });
  await db.putStates([st(0, now + 60 * D, 80, now - 20 * D), st(1, now + 45 * D, 20, now - 10 * D), st(2, now + 90 * D, 200, now - 30 * D), st(3, now + 2 * D, 6, now - D), st(4, now + 5 * D, 9, now - 6 * D)]);
});
const examDate = inDays(10);
await page.goto('http://localhost:8123/#/deck/sample'); await page.waitForSelector('#editDeck');
await page.click('#editDeck'); await page.waitForSelector('#deckExam');
await page.fill('#deckExam', examDate);
await page.screenshot({ path: SP + '/exam-editor.png', fullPage: true });
await page.click('#deckForm button[type=submit]');
await page.waitForFunction(() => /brought forward/.test(document.querySelector('#toast')?.textContent || ''));
ok((await page.textContent('#toast')).includes('3 cards brought forward'), 'setting the date pulls in cards scheduled after it: ' + await page.textContent('#toast'));
const examStart = await page.evaluate(async d => (await import('./js/exam.js')).examStart(d), examDate);
let states = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')));
ok(states.every(s => s.due <= examStart), 'no card in the deck is due after the exam');
ok((await page.textContent('.exam-line')).includes('Exam in 10 days'), 'deck page shows the countdown');
await page.screenshot({ path: SP + '/exam-deck.png' });
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
ok((await page.textContent('.deck .exam-badge')) === 'Exam in 10 days', 'deck tile shows the countdown');
// exam prep from the deck page
await page.goto('http://localhost:8123/#/deck/sample'); await page.waitForSelector('#prepBtn');
await page.click('#prepBtn'); await page.waitForSelector('.flash');
ok((await page.textContent('.flash-deck')).includes('Exam prep'), 'Exam prep opens straight into a session');
const counts = await page.$$eval('.rv-counts span', s => s.map(x => +x.textContent));
ok(counts.reduce((a, b) => a + b, 0) === 11, 'prep covers the 4 not seen in 3 days + 7 never studied: ' + counts.join('/'));
// rating a strong card Easy still comes back before the exam
const first = await page.textContent('.flash-front');
await page.keyboard.press(' '); await page.waitForSelector('.rate');
const easyLabel = await page.$eval('.rate.r4 span', s => s.textContent);
await page.keyboard.press('4'); await page.waitForTimeout(300);
states = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')));
ok(states.every(s => s.due <= examStart), `Easy on "${first}" (${easyLabel}) still comes back before the exam`);
ok(/^(\d+d|1[0-9]?d|[1-9]d)$/.test(easyLabel) && parseInt(easyLabel) <= 10, 'the Easy button shows the capped gap: ' + easyLabel);
await page.click('#endBtn');
// custom study offers exam prep too
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/review'); await page.waitForSelector('#customBtn'); await page.click('#customBtn');
await page.waitForSelector('#csPrepBtn');
ok((await page.textContent('.cs-opt:has(#csPrepBtn)')).includes('exam in 10 days'), 'Custom study offers Exam prep');
await page.click('#csClose');
// clearing the date turns it off
await page.goto('http://localhost:8123/#/deck/sample'); await page.waitForSelector('#editDeck');
await page.click('#editDeck'); await page.fill('#deckExam', ''); await page.click('#deckForm button[type=submit]');
await page.waitForFunction(() => !document.querySelector('.exam-line'));
ok(true, 'clearing the date removes exam mode');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
