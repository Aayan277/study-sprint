import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true })).newPage();
page.on('pageerror', e => errors.push(e.stack));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
// Counted from the study day (which starts at 4am, like the app), so the test also works between midnight and 4am.
const inDays = n => { const d = new Date(Date.now() - 4 * 3600000 + n * DAY); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// half the sample deck studied: some due far after the exam, one well known, the rest seen recently
await page.evaluate(async () => {
  const db = await import('./js/db.js'); const D = 86400000, now = Date.now();
  const st = (i, due, stability, last) => ({ cardId: `sample-${i}`, due, stability, difficulty: 4, reps: 4, lapses: 0, state: 2, lastReview: last, elapsedDays: 5, scheduledDays: 30, learningSteps: 0 });
  await db.putStates([st(0, now + 60 * D, 600, now - 20 * D), st(1, now + 45 * D, 20, now - 10 * D), st(2, now + 90 * D, 1500, now - 30 * D), st(3, now + 2 * D, 6, now - D), st(4, now + 5 * D, 9, now - 6 * D)]);
});
const examDate = inDays(10);
await page.goto('http://localhost:8123/#/deck/sample'); await page.waitForSelector('#editDeck');
await page.click('#editDeck'); await page.waitForSelector('#deckExam');
await page.fill('#deckExam', examDate);
await page.screenshot({ path: SP + '/exam-editor.png', fullPage: true });
await page.click('button[type=submit][form=deckForm]');
await page.waitForFunction(() => /brought forward/.test(document.querySelector('#toast')?.textContent || ''));
// v3.1: only cards that would be below 99% on exam day are pulled in. Here 1 of the 3 cards due after the exam (stability 20, ~90%);
// the other two (stability 600 and 1500, ~99.4% and ~99.7%) stay where they are.
ok((await page.textContent('#toast')).includes('1 card brought forward'), 'setting the date pulls in the card that needs it: ' + await page.textContent('#toast'));
const examStart = await page.evaluate(async d => (await import('./js/exam.js')).examStart(d), examDate);
// Cards due after the exam must be ones expected to be at 99% or better on exam day.
const lateNeedy = () => page.evaluate(async d => {
  const { examStart, recallAt, FINAL_R } = await import('./js/exam.js');
  const start = examStart(d);
  return (await (await import('./js/db.js')).getAll('cardStates')).filter(s => s.due > start && recallAt(s, start) < FINAL_R).map(s => s.cardId);
}, examDate);
let states = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')));
ok(!(await lateNeedy()).length, 'no card that needs a review is due after the exam');
ok(states.filter(s => s.due > examStart).length === 2, 'the two cards at 99%+ on exam day keep their dates after it');
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
ok(!(await lateNeedy()).length, `Easy on "${first}" (${easyLabel}) leaves no card that needs a review waiting until after the exam`);
// If Easy sends the card past the exam, it must be one we expect to remember on exam day (99%+).
const rated = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).sort((a, b) => b.lastReview - a.lastReview)[0]);
const pastExam = rated.due > examStart;
const onExamDay = await page.evaluate(async ([s, start]) => (await import('./js/exam.js')).recallAt(s, start), [rated, examStart]);
const finalR = await page.evaluate(async () => (await import('./js/exam.js')).FINAL_R);
ok(!pastExam || onExamDay >= finalR, `Easy (${easyLabel}) goes past the exam only when recall on exam day is 99%+: ${onExamDay.toFixed(3)}`);
await page.click('#endBtn');
// custom study offers exam prep too
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#optBtn'); await page.click('#optBtn'); await page.waitForSelector('#customBtn'); await page.click('#customBtn');
await page.waitForSelector('#csPrepBtn');
ok((await page.textContent('.cs-opt:has(#csPrepBtn)')).includes('exam in 10 days'), 'Custom study offers Exam prep');
await page.click('.sheet-x');
// ending an Exam prep session without rating anything shows the real streak (same as Today), not "0 day streak"
await page.evaluate(async () => { const db = await import('./js/db.js'); const D = 86400000, now = Date.now(); await db.putMany('reviewLog', [1, 2, 3].map(d => ({ cardId: 'sample-5', timestamp: now - d * D, source: 'review', rating: 3, correct: true, state: 2 }))); });
await page.goto('http://localhost:8123/#/today'); await page.reload(); await page.waitForSelector('.streak');   // reload: the log was written straight to the database
const todayStreak = (await page.textContent('.streak')).replace(/\s+/g, ' ').trim();
await page.goto('http://localhost:8123/#/deck/sample'); await page.waitForSelector('#prepBtn'); await page.click('#prepBtn');
await page.waitForSelector('#endBtn'); await page.click('#endBtn'); await page.waitForSelector('.finish-next .streak');
const endStreak = (await page.textContent('.finish-next .streak')).replace(/\s+/g, ' ').trim();
ok(!todayStreak.startsWith('0 ') && endStreak === todayStreak, `end of Exam prep shows the same streak as Today: "${endStreak}" vs "${todayStreak}"`);
// clearing the date turns it off
await page.goto('http://localhost:8123/#/deck/sample'); await page.waitForSelector('#editDeck');
await page.click('#editDeck'); await page.fill('#deckExam', ''); await page.click('button[type=submit][form=deckForm]');
await page.waitForFunction(() => !document.querySelector('.exam-line'));
ok(true, 'clearing the date removes exam mode');
// the Exam date field is near the top of Edit deck (right after the name and course code), above Study options and Read aloud
await page.click('#editDeck'); await page.waitForSelector('#deckExam');
const order = await page.$$eval('#deckForm [id=deckName], #deckForm [id=deckCourse], #deckForm [id=deckExam], #deckForm [id=deckOpts], #deckForm [id=deckTts]', els => els.map(e => e.id));
ok(order.join() === 'deckName,deckCourse,deckExam,deckOpts,deckTts', 'Edit deck: Exam date comes right after name and course code: ' + order.join());
await page.click('#deckCancel');
// New deck has an Exam date too, and keeps it
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('#newDeck');
await page.click('#newDeck'); await page.waitForSelector('#deckExam');
await page.fill('#deckName', 'Chem'); await page.fill('#deckExam', inDays(20)); await page.click('button[type=submit][form=deckForm]');
await page.waitForFunction(() => /Created/.test(document.querySelector('#toast')?.textContent || ''));
ok(await page.evaluate(async d => (await (await import('./js/db.js')).getDecks()).find(x => x.name === 'Chem')?.examDate === d, inDays(20)), 'a new deck saves its exam date');
ok((await page.textContent('.deck:has-text("Chem")')).includes('Exam in 20 days'), 'and shows the exam countdown');
// Cards that arrive after the date was set (an import, a move, a new subdeck) are covered when the queue is built:
// no write happens, but the weak ones that were saved far after the exam are due now, the strong one is not.
await page.evaluate(async d => {
  const db = await import('./js/db.js'); const D = 86400000, now = Date.now();
  const cards = ['w1', 'w2', 'strong'].map((id, i) => ({ id: 'late-' + id, deckId: 'late', front: 'Q' + id, back: 'A' + id, created: now + i }));
  await db.addDeckWithCards({ id: 'late', name: 'Late', course: '', color: '#8b5cf6', parentId: '', created: now + 50, examDate: d }, cards);
  const st = (id, due, stability) => ({ cardId: 'late-' + id, due, stability, difficulty: 5, reps: 4, lapses: 0, state: 2, lastReview: now - D, elapsedDays: 1, scheduledDays: 30, learningSteps: 0 });
  await db.putStates([st('w1', now + 60 * D, 2), st('w2', now + 70 * D, 3), st('strong', now + 90 * D, 400)]);
}, inDays(3));
await page.goto('http://localhost:8123/#/today'); await page.reload(); await page.waitForSelector('.tdeck');
const lateRow = (await page.textContent('.tdeck:has-text("Late")')).replace(/\s+/g, ' ');
// 3 days left: the 2 weak cards go on different days (1 today, 1 tomorrow), the weakest later; the strong one is left alone.
ok(/ 1 due/.test(lateRow), 'cards that arrive in an exam deck later are covered: one weak card is due today: ' + lateRow);
const plan = await page.evaluate(async () => {
  const db = await import('./js/db.js'); const { examSchedule } = await import('./js/exam.js');
  const [decks, cards, states] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('cardStates')]);
  const { caps } = examSchedule(decks, cards, new Map(states.map(s => [s.cardId, s])));
  return Object.fromEntries([...caps]);
});
ok(plan['late-w2'] < plan['late-w1'] && !('late-strong' in plan), 'the weakest card is planned closest to the exam, the strong one not at all');
const lateDates = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).filter(s => s.cardId.startsWith('late-')).map(s => s.due > Date.now() + 30 * 86400000));
ok(lateDates.every(Boolean), 'and nothing was rewritten: the saved dates are unchanged');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
