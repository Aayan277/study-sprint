import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);

await page.goto('http://localhost:8123/'); await page.waitForSelector('.deck');
const cards = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')));
const byFront = Object.fromEntries(cards.map(c => [c.front, c.back]));
const byBack = Object.fromEntries(cards.map(c => [c.back, c.front]));
const pick = (o, v) => page.evaluate(([v]) => {
  const opts = [...document.querySelectorAll('#options .opt')];
  return opts.findIndex(b => b.querySelector('.lbl').textContent === v);
}, [v]);
const setup = async (sel) => { for (const s of sel) await page.$eval(s, el => el.click()); };
const waitQuestion = () => page.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);

await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
await noHScroll('play setup'); await page.screenshot({ path: SP + '/p-setup.png', fullPage: true });
// Classic 10, front -> back, answer everything right
await setup(['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']);
await page.click('#startBtn'); await page.waitForSelector('#pCard');
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
const res = { stamp: await page.textContent('.stamp'), score: await page.textContent('.res-score'), acc: await page.textContent('.stats4 .v') };
console.log('   classic result:', JSON.stringify(res));
ok(res.acc === '100%' && /^[SA]$/.test(res.stamp.trim()), 'all right gives 100% and an S/A stamp');
ok(await page.isVisible('.newbest'), 'first score is a new best');
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
await page.click('#quitBtn'); await page.waitForSelector('#startBtn');
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
await page.click('#quitBtn'); await page.waitForSelector('#startBtn');

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
await page.click('#quitBtn'); await page.waitForSelector('#startBtn');
await setup(['input[name=flash][value="0"]']);

// Classic timeout with 3s timer
await page.$eval('#pace', r => { r.value = 3; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
await setup(['input[name=qtype][value=front]']);
await page.click('#startBtn'); await page.waitForSelector('#pCard');
await page.waitForSelector('.fb.no', { timeout: 6000 });
ok((await page.textContent('.fb-mark')).includes('Out of time'), 'timer runs out after 3s');
// Enter on a focused button presses that button (Quit), not "next question"
await page.focus('#quitBtn'); await page.keyboard.press('Enter');
ok(await page.waitForSelector('#startBtn', { timeout: 3000 }).then(() => true, () => false), 'Enter on the focused Quit button quits');
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
await page.click('#quitBtn'); await page.waitForSelector('#startBtn');

// A deck with 3 cards: multiple choice is off
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'tiny', name: 'Tiny', color: '#E5484D', created: Date.now() },
    [['a', 'one'], ['b', 'two'], ['c', 'three']].map(([f, b], i) => ({ id: 'tiny' + i, deckId: 'tiny', front: f, back: b, tags: [], created: i })));
});
await page.click('.tab[data-tab=decks]'); await page.click('.tab[data-tab=play]'); await page.waitForSelector('#pDeck');
await page.selectOption('#pDeck', 'tiny');
ok(await page.isDisabled('input[name=qtype][value=front]') && await page.isChecked('input[name=qtype][value=typing]'), 'small deck: only Typing');
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
