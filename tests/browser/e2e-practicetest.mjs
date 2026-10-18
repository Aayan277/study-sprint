// The Practice test: setup, taking a test (flags, navigator, submit confirmation, timer), results (by tag, Wrong only, Drill missed,
// Retake), resume after a reload, "Count answers as reviews" off (nothing changes) and on (the schedule and log change), exam week and phone layout.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const iso = d => { const x = new Date(Date.now() + d * 86400000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);

await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
// A course with 12 cards (6 "bio", 6 "chem" tags) and a subdeck with 4 more ("chem"). pt0 and pt1 are due reviews.
await page.evaluate(async () => {
  const db = await import('./js/db.js'); const day = 86400000;
  const mk = (deckId, p, n, tag) => Array.from({ length: n }, (_, i) => ({ id: p + i, deckId, front: `Term ${p}${i}`, back: `Meaning ${p}${i}`, tags: [tag], created: i }));
  await db.addDeckWithCards({ id: 'pt', name: 'Practice course', color: '#5C9DFF', created: Date.now() + 5 }, [...mk('pt', 'b', 6, 'bio'), ...mk('pt', 'c', 6, 'chem')]);
  await db.addDeckWithCards({ id: 'pts', name: 'Unit 2', parentId: 'pt', color: '#5C9DFF', created: Date.now() + 6 }, mk('pts', 's', 4, 'chem'));
  await db.putStates(['b0', 'b1'].map(id => ({ cardId: id, due: Date.now() - day, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: Date.now() - 10 * day })));
});
const run = () => page.evaluate(() => JSON.parse(localStorage.getItem('study-sprint-test-run')));
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('study-sprint-test-state')));
const snapshot = () => page.evaluate(async () => {
  const db = await import('./js/db.js');
  const by = rows => JSON.stringify(rows.sort((a, b) => String(a.id ?? a.cardId).localeCompare(String(b.id ?? b.cardId))));
  return { states: by(await db.getAll('cardStates')), cards: by(await db.getAll('cards')), logs: (await db.getAll('reviewLog')).length };
});
const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName.toLowerCase());
// Answer the question on screen: right, wrong or not at all.
const answerNow = async how => {
  const r = await run(), s = await state(), q = r.questions[s.i];
  if (how === 'skip') return q;
  if (q.kind === 'mc') {
    const right = q.options.indexOf(q.answer);
    await page.locator('.t-opt').nth(how === 'right' ? right : (right + 1) % q.options.length).click();
  } else if (q.kind === 'tf') {
    await page.locator('.t-opt').nth((how === 'right') === q.truth ? 0 : 1).click();
  } else await page.fill('#tInput', how === 'right' ? q.answer : 'zzz not it');
  return q;
};
const next = async () => { await page.click('#tNext'); };
const startFromDeck = async (deckId, tweak) => {
  await page.goto(URL + '#/deck/' + deckId); await page.waitForSelector('#testBtn');
  await page.click('#testBtn'); await page.waitForSelector('#ptForm');
  if (tweak) await tweak();
  await page.click('#ptStart'); await page.waitForSelector('#tPrompt');
};

// ---------- entry point and setup sheet ----------
await page.goto(URL + '#/deck/pt'); await page.waitForSelector('#testBtn');
ok((await page.textContent('#testBtn')).trim() === 'Practice test', 'the deck page has a Practice test button');
await page.click('#testBtn'); await page.waitForSelector('#ptForm');
ok((await page.textContent('#sheetTitle')).trim() === 'Practice test', 'it opens the setup sheet');
ok(await page.inputValue('#ptDeck') === 'pt', 'the sheet starts on this deck');
ok((await page.textContent('#ptDeck option:checked')).includes('(16)'), 'the deck counts its subdeck: 16 cards');
ok(await page.locator('input[name=kind]:checked').count() === 3 && await page.isDisabled('input[name=kind][value=cloze]'), 'question types default to a mix of all that fit (no cloze cards here, so that one is off)');
ok(await page.isChecked('input[name=limit][value="0"]') && await page.isChecked('input[name=order][value=random]'), 'no time limit and random order by default');
ok(!(await page.isChecked('#ptCounts')), '"Count answers as reviews" is off by default');
ok((await page.textContent('#ptNote')).includes('16 cards') || (await page.textContent('#ptNote')).includes('questions from'), 'a line says how many questions: ' + (await page.textContent('#ptNote')).trim());
await page.screenshot({ path: SP + '/pt-setup.png' });
// narrow by tag
await page.click('[data-tag="chem"]');
ok((await page.textContent('#ptNote')).includes('10 cards'), 'narrowing to "chem" leaves 10 cards (6 + 4 in the subdeck)');
await page.click('[data-tag="chem"]');
// 10 questions, no typed answers
await page.locator('.chip:has(input[name=count][value="10"])').click();
await page.locator('.chip:has(input[name=kind][value=typing])').click();
ok(await page.locator('input[name=kind]:checked').count() === 2, 'a question type can be switched off');
await page.click('#ptStart');
await page.waitForSelector('#tPrompt');
ok(page.url().endsWith('#/test/pt'), 'Start opens #/test/pt');
ok(await page.evaluate(() => document.body.classList.contains('focus')), 'focus mode is on while taking a test');
ok(await active() === 'tPrompt', 'focus is on the question');
ok((await page.textContent('#tProg')).replace(/\s+/g, ' ').trim() === 'Question 1 of 10', 'progress reads "Question 1 of 10"');
ok((await page.textContent('#tAnnounce')).includes('Question 1 of 10'), 'the live region announces the question');
ok(await page.locator('.fb, .feedback').count() === 0, 'no feedback is shown while taking the test');
let r = await run();
ok(r.questions.length === 10 && !r.cfg.kinds.includes('typing') && r.questions.every(q => q.kind === 'mc' || q.kind === 'tf'), 'the saved test has 10 questions and no typed ones');
ok(r.questions.every(q => q.deckId === 'pt' || q.deckId === 'pts'), 'questions come from the deck and its subdeck');
ok(new Set(r.questions.map(q => q.cardId)).size === 10, 'no card twice');
ok(await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).testPrefs?.pt?.count) === 10, 'the choices are remembered per deck');
await page.screenshot({ path: SP + '/pt-question.png' });
await noHScroll('question (desktop)');
ok(await page.isVisible('.t-nav'), 'the navigator sits beside the question on a wide screen');
ok(await page.isHidden('#tNavBtn'), 'and the Questions button is hidden there');

// ---------- taking it: answer 6 right, 2 wrong, skip 2; flag one ----------
const log = [];
for (let i = 0; i < 6; i++) { log.push((await answerNow('right')).kind); if (i === 2) await page.click('#tFlag'); await next(); }
ok(await page.getAttribute('.t-grid [data-q="2"]', 'aria-label') === 'Question 3, answered, flagged', 'the navigator names question 3 as answered and flagged');
ok(await page.getAttribute('.t-grid [data-q="0"]', 'aria-label') === 'Question 1, answered', 'question 1 is answered');
ok(await page.getAttribute('.t-grid [data-q="6"]', 'aria-current') === 'true', 'the current question is marked');
for (let i = 6; i < 8; i++) { await answerNow('wrong'); await next(); }
ok(await page.getAttribute('.t-grid [data-q="9"]', 'aria-label') === 'Question 10, not answered', 'an unanswered question is named so');
await page.click('.t-grid [data-q="1"]');
ok((await page.textContent('#tProg')).includes('2') && await active() === 'tPrompt', 'the navigator jumps to a question and puts focus on it');
const prevAnswer = (await state()).answers[1];
ok(prevAnswer !== null, 'the answer to question 2 is kept');
ok(await page.locator('.t-opt input:checked').count() === 1 || (await run()).questions[1].kind === 'typing', 'and shown when you come back');
await page.click('#tPrev'); await page.click('#tNext');
await page.click('.t-grid [data-q="9"]');
ok((await page.textContent('#tNext')).includes('Review and submit'), 'the last question\'s Next reads "Review and submit"');
// Submit with two unanswered and one flagged: asks first
await page.click('#tSubmit');
ok(await page.isVisible('#tAsk'), 'Submit asks for confirmation when questions are unanswered');
ok((await page.textContent('#tAsk')).includes('2 questions not answered (9, 10)') && (await page.textContent('#tAsk')).includes('1 flagged'), 'it names the unanswered and flagged ones: ' + (await page.textContent('#tAskT')).trim());
ok(await page.evaluate(() => document.getElementById('tLayout').inert), 'the test is inert behind the question');
await page.screenshot({ path: SP + '/pt-submit-ask.png' });
await page.click('#tAskNo');
ok(await page.isHidden('#tAsk') && (await page.textContent('#tProg')).includes('9'), 'Go to first unanswered goes to question 9');
await page.click('#tSubmit'); await page.click('#tAskYes');
await page.waitForSelector('#tReview');
ok(!(await page.evaluate(() => document.body.classList.contains('focus'))), 'focus mode is off on the results');
ok((await page.textContent('.t-ring')).trim() === '60%', 'the score is 60%');
ok((await page.textContent('.res-head')).includes('6') && (await page.textContent('.res-head')).includes('of 10 right'), 'N of M right');
ok(/Time taken/.test(await page.textContent('.stats4')), 'time taken is shown');
ok(await page.locator('.t-bar-row').count() >= 2, 'score by tag has a row per tag');
ok((await page.textContent('#tReview')).includes('Correct answer'), 'every wrong question shows the correct answer');
ok(await page.locator('#tReview > li').count() === 10, 'the list has all 10 questions');
await page.click('#tWrong');
ok(await page.locator('#tReview > li:not([hidden])').count() === 4, 'Wrong only shows the 4 missed (2 wrong, 2 blank)');
ok(await page.getAttribute('#tWrong', 'aria-pressed') === 'true', 'the filter button says it is on');
await page.click('#tAll');
ok(await page.locator('#tReview > li:not([hidden])').count() === 10, 'All shows everything again');
ok((await page.textContent('#tSched')).includes('Practice only'), 'the results say nothing changed in the schedule');
ok((await page.textContent('#tReview li:nth-child(3)')).includes('Flagged'), 'a flagged question is marked in the list');
await page.screenshot({ path: SP + '/pt-results.png', fullPage: true });
await noHScroll('results (desktop)');
const hist = await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).testHistory);
ok(hist?.pt?.length === 1 && hist.pt[0].pct === 60 && hist.pt[0].total === 10, 'the result is kept in the history for the deck');

// ---------- nothing changed (counting is off) ----------
const baseline = await snapshot();
ok(baseline.logs === 0, 'no review-log rows were written');
const q0 = await page.evaluate(async () => { const d = (await (await import('./js/db.js')).getAll('cardStates')).find(s => s.cardId === 'b0'); return d.due; });
ok(q0 < Date.now(), 'the due card is still due (untouched)');

// ---------- a reload on the results shows them again ----------
await page.reload(); await page.waitForSelector('#tReview');
ok((await page.textContent('.t-ring')).trim() === '60%', 'a reload on the results shows them again');

// ---------- Drill missed goes to Review with the 4 missed cards ----------
const missedCount = (await page.textContent('#tDrill')).match(/\((\d+)\)/)[1];
ok(missedCount === '4', 'Drill missed offers the 4 missed cards');
await page.click('#tDrill');
await page.waitForSelector('#rvQ, .flash');
ok(page.url().includes('#/review'), 'Drill missed opens Review');
ok((await page.textContent('.rv-counts')).match(/\d+/g).map(Number).reduce((a, b) => a + b, 0) === 4, 'with just those 4 cards in the queue');
await page.goto(URL + '#/test/pt'); await page.waitForSelector('#tReview');

// ---------- Retake ----------
await page.click('#tRetake'); await page.waitForSelector('#tPrompt');
let s = await state();
ok(s.i === 0 && s.answers.every(a => a === null), 'Retake starts the same questions again with nothing answered');
ok(JSON.stringify((await run()).questions.map(q => q.cardId)) === JSON.stringify(r.questions.map(q => q.cardId)), 'the same questions, in the same order');

// ---------- Leave test? ----------
await page.keyboard.press('Escape');
ok(await page.isVisible('#tAsk') && (await page.textContent('#tAskT')).includes('Leave test?'), 'Esc asks "Leave test?"');
await page.keyboard.press('Escape');
ok(await page.isHidden('#tAsk'), 'Esc again keeps testing');
await answerNow('right');
await page.click('#tLeave'); ok(await page.isVisible('#tAskYes'), 'Leave asks too');
await page.click('#tAskYes');
await page.waitForSelector('#testBtn');
ok(page.url().includes('#/deck/pt'), 'leaving goes to the deck page');
await page.click('#testBtn'); await page.waitForSelector('#ptResume');
ok((await page.textContent('.pt-resume')).includes('question 1 of 10'), 'the setup sheet offers to resume the test in progress');
await page.click('#ptResume'); await page.waitForSelector('#tPrompt');
ok((await state()).answers[0] !== null, 'resuming keeps the answer given before leaving');
// ---------- resume after a reload ----------
await next(); await answerNow('right');
const before = await state();
await page.reload(); await page.waitForSelector('#tPrompt');
s = await state();
ok(s.i === before.i && JSON.stringify(s.answers) === JSON.stringify(before.answers), 'a reload resumes at the same question with the same answers');
ok((await page.textContent('#tProg')).includes('Question 2 of 10'), 'and the progress reads the same');
await page.screenshot({ path: SP + '/pt-resumed.png' });

// ---------- flag shortcut and single-key setting ----------
await page.locator('body').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('f');
ok((await state()).flags[1] === true, 'the F key flags the question (single-key shortcuts on)');
await page.keyboard.press('f');
await page.evaluate(async () => { const m = await import('./js/shortcuts.js'); m.configureShortcuts({ singleKeys: false }); });
await page.keyboard.press('f');
ok((await state()).flags[1] === false, 'with single-key shortcuts off, F does nothing');
await page.evaluate(async () => { const m = await import('./js/shortcuts.js'); m.configureShortcuts({ singleKeys: true }); });
await page.click('#tLeave'); await page.click('#tAskYes'); await page.waitForSelector('#testBtn');

// ---------- the timer auto-submits ----------
await startFromDeck('pt', async () => { await page.locator('.chip:has(input[name=limit][value="10"])').click(); await page.locator('.chip:has(input[name=count][value="10"])').click(); });
ok(await page.isVisible('#tClock') && (await page.textContent('#tClockV')).trim() === '10:00' || (await page.textContent('#tClockV')).trim() === '9:59', 'a time limit shows the time left: ' + (await page.textContent('#tClockV')).trim());
await answerNow('right');
// make the limit 3 seconds and reload (the time used is kept, so this also checks that the clock resumes)
await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('study-sprint-test-run')); r.cfg.limit = 0.05; localStorage.setItem('study-sprint-test-run', JSON.stringify(r)); });
await page.reload(); await page.waitForSelector('#tClock');
await page.waitForSelector('#tReview', { timeout: 8000 });
ok((await page.textContent('.res-head')).includes('Time ran out'), 'when time runs out the test is submitted and the results say so');
ok((await page.textContent('.t-ring')).trim() === '10%', 'only the one answered question scored (1 of 10)');
await page.screenshot({ path: SP + '/pt-timeup.png', fullPage: true });
await page.click('#tDone2'); await page.waitForSelector('#testBtn');

// ---------- count answers as reviews: on ----------
const preOn = await snapshot();
await startFromDeck('pt', async () => { await page.locator('.chip:has(input[name=count][value="10"])').click(); ok(!(await page.isChecked('input[name=kind][value=typing]')), 'the sheet remembers the last choices for the deck (typed was switched off)'); await page.locator('.chip:has(input[name=kind][value=typing])').click(); await page.locator('.chip:has(input[name=kind][value=mc])').click(); await page.locator('.chip:has(input[name=kind][value=tf])').click(); await page.locator('.chip:has(input[name=order][value=weak])').click(); await page.click('#ptCounts'); });
r = await run();
ok(r.cfg.counts === true && r.cfg.order === 'weak', 'counting and Weakest first are saved with the test');
ok(r.questions.every(q => q.kind === 'typing' || q.kind === 'cloze'), 'only typed questions this time');
ok(['b0', 'b1'].includes(r.questions[0].cardId) && ['b0', 'b1'].includes(r.questions[1].cardId), 'Weakest first puts the two due cards (studied ones) first');
for (let i = 0; i < 10; i++) { await answerNow(i < 2 ? 'wrong' : 'right'); if (i < 9) await next(); }
await page.click('#tSubmit'); await page.waitForSelector('#tReview');
await page.waitForFunction(() => document.querySelector('#tSched')?.textContent.includes('Schedule updated'));
const aft = await snapshot();
ok(aft.logs - preOn.logs === 10, 'with counting on, all 10 answers are written to the review log');
const rows = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')));
ok(rows.length === 10 && rows.every(l => l.source === 'test' && l.format === 'test'), 'the rows have source "test"');
const due = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).filter(s => ['b0', 'b1'].includes(s.cardId)));
ok(due.every(s => s.lapses === 1 && s.due > Date.now() - 86400000 && s.lastReview > Date.now() - 60000), 'the two due cards were graded as misses (lapse, rescheduled)');
ok((await page.textContent('#tSched')).includes('2 due cards graded'), 'the results say how the schedule changed: ' + (await page.textContent('#tSched')).trim());
ok(await page.evaluate(async () => { const s = await import('./js/stats-calc.js'); const db = await import('./js/db.js'); return (await db.getAll('reviewLog')).every(l => s.isAnswerLog(l)); }), 'stats read the rows as answers');

// ---------- exam week ----------
await page.evaluate(async d => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDeck('pt')), examDate: d }); }, iso(4));
await page.click('#tDone2'); await page.waitForSelector('#testBtn');
await page.goto(URL + '#/today'); await page.waitForSelector('[data-mock="pt"]');
ok((await page.textContent('[data-mock="pt"]')).includes('Take a mock exam'), 'Today offers "Take a mock exam" in exam week');
await page.click('[data-mock="pt"]'); await page.waitForSelector('#ptForm');
ok((await page.textContent('#sheetTitle')).trim() === 'Mock exam' && (await page.textContent('#ptForm')).includes('Exam in 4 days'), 'it opens the sheet as a mock exam, pre-set to that deck');
ok(await page.inputValue('#ptDeck') === 'pt', 'the deck is the exam deck');
await page.screenshot({ path: SP + '/pt-mock.png' });
await page.click('#ptCancel');
await page.goto(URL + '#/deck/pt'); await page.waitForSelector('#mockBtn');
ok(true, 'the deck page has a "Take a mock exam" link in exam week');
await page.evaluate(async d => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDeck('pt')), examDate: d }); }, iso(12));
await page.goto(URL + '#/today'); await page.waitForSelector('[data-prep="pt"]');
ok(await page.locator('[data-mock="pt"]').count() === 0, 'with the exam 12 days away there is no mock exam button on Today');


// ---------- Change setup on the results page, and on the "no test" page ----------
const setPrefs = cfg => page.evaluate(async c => { const db = await import('./js/db.js'); await db.setSetting('testPrefs', { pt: { count: 10, kinds: ['mc', 'typing', 'tf'], limit: 0, order: 'random', counts: false, tags: [], ...c } }); }, cfg);
const submitAll = async () => { await page.click('#tSubmit'); if (await page.isVisible('#tAskYes')) await page.click('#tAskYes'); await page.waitForSelector('#tReview'); };
await setPrefs({ kinds: ['mc'] });
await startFromDeck('pt');
await submitAll();
const idBefore = (await run()).id;
await page.click('#tSetup'); await page.waitForSelector('#ptForm');
await page.locator('.chip:has(input[name=count][value="20"])').click();
await page.click('#ptStart'); await page.waitForSelector('#tPrompt');
ok((await run()).id !== idBefore && (await run()).cfg.count === 20 && !(await state()).done, 'results > Change setup > Start draws the new test (it is saved and shown)');
await page.evaluate(() => { localStorage.removeItem('study-sprint-test-run'); localStorage.removeItem('study-sprint-test-state'); });
await page.reload(); await page.waitForSelector('#ptForm');
await page.click('#ptStart'); await page.waitForSelector('#tPrompt');
ok((await state()).i === 0 && !(await state()).done, 'the "no test in progress" page: Start draws the test too');

// ---------- forced colors (high contrast) ----------
await answerNow('right'); await next(); await page.click('#tFlag');
await page.emulateMedia({ forcedColors: 'active' });
const w = sel => page.evaluate(sel => { const c = getComputedStyle(document.querySelector(sel)); return { b: c.borderTopWidth, o: c.outlineWidth }; }, sel);
await page.click('.t-grid [data-q="0"]');
const on = await w('.t-opt:has(input:checked)'), off = await w('.t-opt:not(:has(input:checked))');
ok(on.b !== off.b || on.o !== off.o, 'forced colors: a checked option differs from the others (border ' + on.b + ' vs ' + off.b + ')');
const ans = await w('.t-grid [data-q="0"]'), un = await w('.t-grid [data-q="5"]'), cur = await w('.t-grid [data-q="0"].current');
ok(ans.b !== un.b, 'forced colors: an answered cell has a different border from an unanswered one (' + ans.b + ' vs ' + un.b + ')');
ok(cur.o !== '0px' && un.o === '0px', 'forced colors: the current cell has an outline (' + cur.o + ')');
const lg = await w('.t-legend .t-q.answered'), lu = await w('.t-legend li:nth-child(2) .t-q');
ok(lg.b !== lu.b, 'forced colors: the legend matches');
await page.emulateMedia({ forcedColors: 'none' });
ok(await page.locator('.t-opt .key[aria-hidden=true]').count() >= 2, 'the key hints in the options are hidden from screen readers');

// ---------- two tabs ----------
const B = await ctx.newPage();
await B.goto(URL + '#/test/pt'); await B.waitForSelector('#tPrompt');
await page.waitForSelector('#tAsk:not([hidden])', { timeout: 5000 });
ok((await page.textContent('#tAsk')).includes('open in another tab'), 'a second tab on the same test makes the first one ask instead of overwriting');
const frozenBefore = JSON.stringify((await state()).answers);
await page.click('#tLeave'); await page.waitForSelector('#tAskNo');
await page.click('#tAskNo');
ok(await page.isVisible('#tAsk') && (await page.textContent('#tAsk')).includes('open in another tab'), 'frozen: Leave then Keep testing brings the "another tab" question back');
await page.keyboard.press('Escape');
ok((await page.textContent('#tAsk')).includes('open in another tab'), 'frozen: Esc does not remove it');
await page.goBack().catch(() => {}); await page.waitForTimeout(300);
ok(await page.isVisible('#tAsk') && (await page.textContent('#tAsk')).includes('open in another tab'), 'frozen: Back does not remove it');
await page.click('#tAskYes'); await page.waitForSelector('#tPrompt');
await B.waitForSelector('#tAsk:not([hidden])', { timeout: 5000 });
ok((await B.textContent('#tAsk')).includes('open in another tab'), 'Continue here takes over, and the other tab asks in turn');
ok(JSON.stringify((await state()).answers) === frozenBefore, 'no answers were lost in the hand-over');
await B.close();

// ---------- count as reviews: reload in the middle of saving ----------
await page.click('#tLeave'); await page.click('#tAskYes'); await page.waitForSelector('#testBtn');
await setPrefs({ kinds: ['typing'], counts: true });
const preRows = (await snapshot()).logs;
await startFromDeck('pt');
for (let i = 0; i < 10; i++) { await answerNow('right'); if (i < 9) await next(); }
await submitAll();
await page.waitForFunction(() => document.querySelector('#tSched')?.textContent.includes('Saved to your schedule'));
const rowsFull = (await snapshot()).logs;
ok(rowsFull - preRows === 10, 'counted answers are saved, and the status says "Saved to your schedule"');
// 1. the reload comes after the rows were written but before they were marked: nothing is written twice
await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('study-sprint-test-state')); s.rec = s.rec.map(() => 0); localStorage.setItem('study-sprint-test-state', JSON.stringify(s)); });
await page.reload(); await page.waitForSelector('#tReview');
await page.waitForFunction(() => document.querySelector('#tSched')?.textContent.includes('Saved to your schedule'));
ok((await snapshot()).logs === rowsFull, 'reloading while the answers were marked unsaved does not write them a second time');
ok((await state()).rec.every(r => r === 1), 'and they are marked saved now');
// 2. the reload comes before anything was written: the answers are saved on resume
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const s = JSON.parse(localStorage.getItem('study-sprint-test-state'));
  for (const l of (await db.getAll('reviewLog')).filter(l => l.source === 'test' && l.timestamp >= s.finished - 1000)) await db.deleteLogRow(l.id);
  s.rec = s.rec.map(() => 0); localStorage.setItem('study-sprint-test-state', JSON.stringify(s));
});
ok((await snapshot()).logs === preRows, 'the test rows are gone (a reload before saving)');
await page.reload(); await page.waitForSelector('#tReview');
await page.waitForFunction(() => document.querySelector('#tSched')?.textContent.includes('Saved to your schedule'));
ok((await snapshot()).logs === rowsFull, 'a reload in the middle of saving: the answers are saved when the results come back');
await page.click('#tDone2'); await page.waitForSelector('#testBtn');

// ---------- true or false: logged, not scheduled ----------
await setPrefs({ kinds: ['tf'], counts: true });
const statesBefore = (await snapshot()).states, rowsBefore = (await snapshot()).logs;
await startFromDeck('pt');
for (let i = 0; i < 10; i++) { await answerNow('right'); if (i < 9) await next(); }
await submitAll();
await page.waitForFunction(() => document.querySelector('#tSched')?.textContent.includes('Saved to your schedule'));
const tfRows = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'test').slice(-10));
ok((await snapshot()).logs - rowsBefore === 10 && tfRows.every(l => l.reason === 'logged' && l.applied === false), 'true or false answers are logged but do not apply to the schedule');
ok((await snapshot()).states === statesBefore, 'and no card schedule changed');
ok((await page.textContent('#tSched')).includes('only logged'), 'the status says so');
await page.click('#tDone2'); await page.waitForSelector('#testBtn');

// ---------- a deleted deck ----------
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'tmpd', name: 'Temp deck', color: '#5C9DFF', created: Date.now() + 9 }, Array.from({ length: 5 }, (_, i) => ({ id: 'tm' + i, deckId: 'tmpd', front: 'T ' + i, back: 'A ' + i, tags: [], created: i }))); });
await page.goto(URL + '#/deck/tmpd'); await page.waitForSelector('#testBtn'); await page.click('#testBtn'); await page.waitForSelector('#ptForm'); await page.click('#ptStart'); await page.waitForSelector('#tPrompt');
await page.evaluate(async () => { await (await import('./js/db.js')).deleteDeck('tmpd'); });
await page.reload(); await page.waitForSelector('#tPrompt');
ok((await page.textContent('h1.sr-only')).includes('Deleted deck'), 'a deck deleted during the test is named "Deleted deck"');
await page.evaluate(() => { localStorage.removeItem('study-sprint-test-run'); localStorage.removeItem('study-sprint-test-state'); });

ok(errors.length === 0, 'no console errors: ' + errors.join(' | '));

// ---------- phone ----------
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p2 = await phone.newPage();
p2.on('pageerror', e => errors.push('pageerror ' + e.message));
await p2.goto(URL + '#/decks'); await p2.waitForSelector('.deck');
await p2.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'ph', name: 'Phone course', color: '#5C9DFF', created: Date.now() + 5 },
    Array.from({ length: 8 }, (_, i) => ({ id: 'ph' + i, deckId: 'ph', front: `Phone term ${i}`, back: `Phone answer ${i}`, tags: [i % 2 ? 'odd' : 'even'], created: i })));
});
const noH2 = async w => ok(await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
await p2.goto(URL + '#/deck/ph'); await p2.waitForSelector('#testBtn');
await p2.click('#testBtn'); await p2.waitForSelector('#ptForm'); await noH2('setup sheet (phone)');
await p2.screenshot({ path: SP + '/pt-phone-setup.png' });
await p2.locator('.chip:has(input[name=count][value="10"])').click();
await p2.locator('.chip:has(input[name=kind][value=typing])').click();       // multiple choice and true or false only, so every question has options
await p2.click('#ptStart'); await p2.waitForSelector('#tPrompt');
ok(await p2.isHidden('.t-nav') && await p2.isVisible('#tNavBtn'), 'on a phone the navigator is a button');
const box = async sel => (await p2.locator(sel).first().boundingBox());
const small = [];
for (const sel of ['#tNext', '#tPrev', '#tFlag', '#tNavBtn', '#tSubmit', '.t-opt']) { const b = await box(sel).catch(() => null); if (!b) { small.push(sel + ' missing'); continue; } if (b.height < 44) small.push(sel + ' ' + b.height); }
ok(small.length === 0, 'touch targets are at least 44px tall' + (small.length ? ': ' + small.join(', ') : ''));
await noH2('question (phone)');
await p2.screenshot({ path: SP + '/pt-phone-question.png' });
await p2.click('.t-opt >> nth=0');
await p2.click('#tNavBtn'); await p2.waitForSelector('#sheet .t-grid [data-q]');
ok(await p2.locator('#sheet .t-grid [data-q]').count() === 8, 'the Questions button opens a sheet with all 8 questions');
const cell = await p2.locator('#sheet .t-q').first().boundingBox();
ok(cell.width >= 44 && cell.height >= 44, 'navigator cells are 44px');
await p2.screenshot({ path: SP + '/pt-phone-navigator.png' });
await p2.click('#sheet [data-q="5"]');
ok((await p2.textContent('#tProg')).includes('Question 6 of 8'), 'a navigator cell jumps there');
await p2.click('#tSubmit'); await p2.click('#tAskYes');
await p2.waitForSelector('#tReview'); await noH2('results (phone)');
await p2.screenshot({ path: SP + '/pt-phone-results.png', fullPage: true });
ok(errors.length === 0, 'no console errors on the phone: ' + errors.join(' | '));
await browser.close();
