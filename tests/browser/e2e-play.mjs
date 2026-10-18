import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('failing on purpose') && !m.text().includes('Could not save answer')) errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const cards = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')));
const byFront = Object.fromEntries(cards.map(c => [c.front, c.back]));
const byBack = Object.fromEntries(cards.map(c => [c.back, c.front]));
const pick = (o, v) => page.evaluate(([v]) => {
  const opts = [...document.querySelectorAll('#options .opt')];
  return opts.findIndex(b => b.querySelector('.lbl').textContent === v);
}, [v]);
// Leave a round: Quit asks first when there are answers to keep (End round -> the results -> the menu).
const quit = async () => { await page.click('#quitBtn'); if (await page.isVisible('#endAsk')) { await page.click('#endYes'); await page.waitForSelector('#menuBtn'); await page.click('#menuBtn'); } await page.waitForSelector('#startBtn'); };
const setup = async (sel) => { for (const s of sel) await page.$eval(s, el => el.click()); };
const waitQuestion = () => page.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);

await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
await noHScroll('play setup'); await page.screenshot({ path: SP + '/p-setup.png', fullPage: true });
// Classic 10, front -> back, answer everything right
await setup(['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']);
await page.click('#startBtn'); await page.waitForSelector('#pCard');
const focusOn = () => page.evaluate(() => document.body.classList.contains('focus'));
ok(await focusOn(), 'focus mode is on during a Play round');
ok((await page.locator('#options .opt').count()) === 4, 'Normal: 4 options');
await page.screenshot({ path: SP + '/p-q.png' }); await noHScroll('question');
for (let i = 0; i < 10; i++) {
  await waitQuestion();
  const prompt = await page.textContent('#pPrompt');
  const idx = await pick(null, byFront[prompt]);
  if (i === 0) ok(idx >= 0, 'right answer is among the options');
  await page.keyboard.press(String(idx + 1));
  await page.waitForSelector('.fb');
  if (i === 0) { ok((await page.textContent('.fb-mark')).includes('Correct'), 'number key answers'); await page.screenshot({ path: SP + '/p-correct.png' }); }
  await page.keyboard.press('Enter');
}
await page.waitForSelector('.stamp');
ok(!(await focusOn()), 'focus mode is off on the Play result screen');
const res = { stamp: await page.textContent('.stamp'), score: await page.textContent('.res-score'), acc: await page.textContent('.stats4 .v') };
console.log('   classic result:', JSON.stringify(res));
ok(res.acc === '100%' && /^[SA]$/.test(res.stamp.trim()), 'all right gives 100% and an S/A stamp');
ok((await page.textContent('.newbest')).trim() === 'First score for this setup', 'the first score for a setup says so, not "New best"');
ok(!(await page.textContent('.res-grade')).includes('Keep practicing') && /^Grade [SAB]/.test((await page.textContent('.res-grade')).trim()), 'a best shows "Grade X" in the head');
await page.screenshot({ path: SP + '/p-results.png', fullPage: true }); await noHScroll('results');

// Play again -> wrong answer shows correct one, then Quit
await page.click('#againBtn'); await waitQuestion();
const prompt = await page.textContent('#pPrompt');
const right = await pick(null, byFront[prompt]);
await page.keyboard.press(String(((right + 1) % 4) + 1));
await page.waitForSelector('.fb.no');
ok((await page.textContent('.fb-info')).includes(byFront[prompt]), 'wrong answer shows the right one');
ok(await page.isVisible('.opt.correct') && await page.isVisible('.opt.wrong'), 'options marked right/wrong');
await page.screenshot({ path: SP + '/p-wrong.png' });
// Quit (or Esc) mid-round asks first; the score so far is kept in the results.
await page.click('#quitBtn');
ok(await page.isVisible('#endAsk') && (await page.textContent('#endAskT')).includes('End this round? Your score so far is kept in the results.'), 'Quit asks "End this round? Your score so far is kept in the results."');
await page.click('#endNo');
ok(await page.isHidden('#endAsk') && await page.isVisible('#pCard'), 'Keep playing closes the question and the round goes on');
await page.keyboard.press('Escape');
ok(await page.isVisible('#endAsk'), 'Esc asks too');
await page.keyboard.press('Escape');
await page.waitForSelector('#menuBtn');
ok(await page.isVisible('.res-grade'), 'Esc again ends the round and shows its results');
await page.click('#menuBtn'); await page.waitForSelector('#startBtn');
ok((await page.textContent('.mode-best')).includes('Best for this setup'), 'best score shown on setup');

// Survival, back -> front, Hard: 6 options, three wrong answers end it
await setup(['input[name=fmt][value=survival]', 'input[name=qtype][value=back]', 'input[name=diff][value=hard]']);
await page.click('#startBtn'); await page.waitForSelector('#pCard');
ok((await page.locator('#options .opt').count()) === 6, 'Hard: 6 options');
for (let i = 0; i < 3; i++) {
  await waitQuestion();
  const p = await page.textContent('#pPrompt');
  const r = await pick(null, byBack[p]);
  await page.keyboard.press(String(((r + 1) % 6) + 1));
  await page.waitForSelector('.fb.no');
  await page.keyboard.press('Enter');
}
await page.waitForSelector('.stamp');
ok((await page.textContent('.res-line')).includes('Survived 3 questions'), 'survival ends after 3 lives');
ok(await page.isVisible('#drillBtn'), 'drill missed offered');
await page.click('#drillBtn'); await page.waitForSelector('#pCard');
ok((await page.textContent('#hudA')).includes('/6'), 'drill round of the missed cards: ' + await page.textContent('#hudA'));
await quit();

// Typing (sample backs are long, so you type the front), Normal, with a typo
await setup(['input[name=fmt][value=classic]', 'input[name=qtype][value=typing]', 'input[name=diff][value=normal]', 'input[name=flash][value="500"]']);
await page.click('#startBtn'); await page.waitForSelector('#pInput');
await page.waitForTimeout(700);
ok(await page.evaluate(() => document.querySelector('#pPrompt').classList.contains('gone')), 'Flash 0.5s hides the question');
const p2 = (await page.evaluate(() => document.querySelector('#pPrompt').textContent));
const ans = byBack[p2];
await page.fill('#pInput', ans.slice(0, -1) + (ans.length > 4 ? '' : ''));   // drop last letter = 1 typo
await page.keyboard.press('Enter'); await page.waitForSelector('.fb');
ok((await page.textContent('.fb-mark')).includes('Correct') || ans.length < 5, `typing with one typo accepted (${ans})`);
await page.screenshot({ path: SP + '/p-typing.png' });
await quit();
await setup(['input[name=flash][value="0"]']);

// Classic timeout with 3s timer
await page.$eval('#pace', r => { r.value = 3; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
await setup(['input[name=qtype][value=front]']);
await page.click('#startBtn'); await page.waitForSelector('#pCard');
await page.waitForSelector('.fb.no', { timeout: 6000 });
ok((await page.textContent('.fb-mark')).includes('Out of time'), 'timer runs out after 3s');
// Enter on a focused button presses that button (Quit), not "next question"
await page.focus('#quitBtn'); await page.keyboard.press('Enter');
await page.waitForSelector('#endAsk', { state: 'visible', timeout: 3000 });
await page.keyboard.press('Enter');             // (focus is on "End round")
ok(await page.waitForSelector('#menuBtn', { timeout: 3000 }).then(() => true, () => false), 'Enter on the focused Quit button asks, and Enter ends the round with its results');
await page.click('#menuBtn'); await page.waitForSelector('#startBtn');
ok((await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).timer)) === 3, 'timer setting saved');

// Lightning: wrong answer costs 3s
await setup(['input[name=fmt][value=lightning]']);
await page.click('#startBtn'); await page.waitForSelector('#hudClock');
const p3 = await page.textContent('#pPrompt'); const r3 = await pick(null, byFront[p3]);
await page.keyboard.press(String(((r3 + 1) % 4) + 1)); await page.waitForSelector('.fb.no');
const clk = await page.textContent('#hudClock');
ok(clk === '0:57' || clk === '0:56', 'lightning: −3s for a wrong answer, clock paused during feedback: ' + clk);
await page.waitForTimeout(1500);
ok((await page.textContent('#hudClock')) <= clk, 'lightning keeps going');
await quit();

// A deck with 3 cards: multiple choice is off
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'tiny', name: 'Tiny', color: '#E5484D', created: Date.now() },
    [['a', 'one'], ['b', 'two'], ['c', 'three']].map(([f, b], i) => ({ id: 'tiny' + i, deckId: 'tiny', front: f, back: b, tags: [], created: i })));
});
await page.click('.tab[data-tab=decks]'); await page.click('.tab[data-tab=play]'); await page.waitForSelector('#pDeck');
await page.selectOption('#pDeck', 'tiny');
ok(await page.isDisabled('input[name=qtype][value=front]') && await page.isChecked('input[name=qtype][value=typing]'), 'small deck: only Typing');
// An error after the review is saved (here: the leech check can't save the card) must not log the answer twice
await page.evaluate(async () => {
  const db = await import('./js/db.js'); const day = 86400000;
  await db.addDeckWithCards({ id: 'lk', name: 'Leechy', color: '#E5484D', created: Date.now() },
    ['a', 'b', 'c', 'd'].map((f, i) => ({ id: 'lk' + i, deckId: 'lk', front: 'q' + f, back: 'ans' + f, tags: [], created: i })));
  await db.putStates(['a', 'b', 'c', 'd'].map((f, i) => ({ cardId: 'lk' + i, due: Date.now() - day, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: Date.now() - 10 * day })));
});
await page.click('.tab[data-tab=decks]'); await page.click('.tab[data-tab=play]'); await page.waitForSelector('#pDeck');
await page.selectOption('#pDeck', 'lk');
await setup(['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']);
// v4.10: Play is practice only by default. A wrong answer and a right one on due cards change nothing: no due date, no FSRS state, no log row.
const lkState = () => page.evaluate(async () => JSON.stringify((await (await import('./js/db.js')).getAll('cardStates')).filter(s => s.cardId.startsWith('lk')).sort((a, b) => a.cardId.localeCompare(b.cardId))));
const lkRows = () => page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.cardId.startsWith('lk')).length);
ok(await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).playCountsAsReviews) === false, 'Play counts as reviews is off by default');
const before = await lkState(), nLogs = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length);
await page.click('#startBtn'); await page.waitForSelector('#pCard');
for (const wrong of [true, false]) {
  await waitQuestion();
  const pr = await page.textContent('#pPrompt'); const rt = await pick(null, 'ans' + pr.slice(1));
  await page.keyboard.press(String((wrong ? (rt + 1) % 4 : rt) + 1)); await page.waitForSelector('.fb');
  await page.keyboard.press('Enter');
}
await page.waitForTimeout(500);
ok(await lkState() === before, 'Play off: the due dates and FSRS state of due cards did not change');
ok(await lkRows() === 0 && await page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length) === nLogs, 'Play off: no review-log rows were added');
await quit();
// Turn it on: the old behaviour (the next checks)
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('playCountsAsReviews', true); await db.setSetting('leechThreshold', 1); });
await page.click('.tab[data-tab=decks]'); await page.click('.tab[data-tab=play]'); await page.waitForSelector('#pDeck');
await page.selectOption('#pDeck', 'lk');
await setup(['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']);
await page.click('#startBtn'); await page.waitForSelector('#pCard');
await page.evaluate(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...a) { if (this.name === 'cards') throw new Error('failing on purpose'); return window.__put.apply(this, a); }; });
const lkPrompt = await page.textContent('#pPrompt');
const lkRight = await pick(null, 'ans' + lkPrompt.slice(1));
await page.keyboard.press(String(((lkRight + 1) % 4) + 1)); await page.waitForSelector('.fb.no');
await page.waitForTimeout(800);
await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
const lkLogs = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.cardId.startsWith('lk')));
ok(lkLogs.length === 1 && lkLogs[0].applied === true, 'one review-log row for the answer, not two: ' + JSON.stringify(lkLogs.map(l => [l.applied, l.reason])));
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
