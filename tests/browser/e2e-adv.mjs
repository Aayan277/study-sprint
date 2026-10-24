import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const setting = k => page.evaluate(async k => (await (await import('./js/db.js')).getSettings())[k], k);
const buttons = () => page.$$eval('.rate', bs => bs.map(b => b.querySelector('b').textContent + ' ' + b.querySelector('span').textContent));

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// defaults: new card buttons as before
await page.goto('http://localhost:8123/#/review'); await page.waitForSelector('#startBtn'); await page.click('#startBtn'); await page.click('#showBtn');
const before = await buttons();
ok(before[0] === 'Again 1m' && before[2] === 'Good 10m', 'defaults unchanged: ' + before.join(' | '));
await page.click('#endBtn'); await page.waitForSelector('#againBtn'); await page.click('#againBtn');

// Settings → Advanced
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#advanced');
await page.click('#advanced summary');
const L = '.steps-editor[data-key="learningSteps"]', RL = '.steps-editor[data-key="relearningSteps"]';
ok(await page.inputValue('#lsteps') === '1m 10m' && await page.inputValue('#rsteps') === '10m' && await page.inputValue('#maxDays') === '36500' && await page.isChecked('#fuzz'), 'advanced shows the defaults in text boxes');
const explain = await page.textContent(L + ' .steps-explain');
console.log('   explanation:', explain.replace(/\s+/g, ' '));
ok(explain.includes('Again → back in 1 minute (step 1)') && explain.includes('Good → moves to the next step: 10 minutes (step 2)') && explain.includes('Good on the last step → moves on to normal reviews'), 'each step and button is explained');
ok(await page.locator(L + ' .steps-hint').count() === 0 && (await page.getAttribute('#lsteps', 'placeholder')) === '1m 10m' && (await page.getAttribute('#lsteps', 'aria-describedby')) === 'lstepsExplain' && await page.locator('#lstepsExplain').count() === 1, 'the default is the placeholder and the live explanation describes the box');
await page.screenshot({ path: SP + '/adv-steps.png', fullPage: true });
await page.fill('#lsteps', '10x'); await page.press('#lsteps', 'Tab');
ok((await page.textContent(L + ' .err')).includes('"10x" isn\'t a step') && (await setting('learningSteps')) === '1m 10m', 'bad steps are refused and not saved');
await page.fill('#lsteps', '1h, 5m 30m 5m');
ok((await page.textContent(L + ' .steps-explain')).includes('back in 1 hour (step 1)'), 'explanation follows what you type');
await page.press('#lsteps', 'Tab'); await page.waitForTimeout(200);
ok((await setting('learningSteps')) === '5m 30m 1h' && (await page.inputValue('#lsteps')) === '5m 30m 1h' && (await page.textContent(L + ' .steps-explain')).includes('back in 5 minutes (step 1)'), 'saved tidied: in order, no duplicates');
await page.click(L + ' [data-reset]'); await page.waitForTimeout(200);
ok((await setting('learningSteps')) === '1m 10m' && (await page.inputValue('#lsteps')) === '1m 10m', 'Reset puts just learning steps back to 1m 10m');
await page.fill('#lsteps', '5m 30m'); await page.press('#lsteps', 'Tab'); await page.waitForTimeout(200);
ok((await setting('learningSteps')) === '5m 30m', 'learning steps now 5m 30m');
await page.fill('#rsteps', ''); await page.press('#rsteps', 'Tab'); await page.waitForTimeout(200);
ok((await page.textContent(RL + ' .steps-explain')).includes('No steps'), 'no steps is explained');
await page.fill('#rsteps', '15m 2h'); await page.press('#rsteps', 'Tab'); await page.waitForTimeout(200);
ok((await setting('relearningSteps')) === '15m 2h', 'relearning steps saved');
await page.click('[data-max="30"]');
ok((await setting('maxInterval')) === 30 && (await page.inputValue('#maxDays')) === '30' && (await page.getAttribute('[data-max="30"]', 'aria-pressed')) === 'true', '1 month preset sets 30 days');
await page.fill('#maxDays', '0'); await page.press('#maxDays', 'Tab');
ok(!(await page.isHidden('#maxErr')) && (await setting('maxInterval')) === 30, 'bad maximum refused');
await page.fill('#maxDays', '45'); await page.press('#maxDays', 'Tab'); await page.waitForTimeout(200);
ok((await setting('maxInterval')) === 45 && (await page.locator('[data-max][aria-pressed="true"]').count()) === 0, 'custom maximum (45 days) saved');
await page.click('#fuzz');
ok((await setting('fuzz')) === false, 'fuzz switched off');
await page.screenshot({ path: SP + '/adv-settings.png', fullPage: true });

// Review uses them
await page.goto('http://localhost:8123/#/review'); await page.waitForSelector('#startBtn'); await page.click('#startBtn'); await page.click('#showBtn');
const after = await buttons();
ok(after[0] === 'Again 5m' && after[2] === 'Good 30m', 'review buttons follow new learning steps: ' + after.join(' | '));
// Maximum interval is a hard limit even for Easy on a strong card
const capped = await page.evaluate(async () => {
  const srs = await import('./js/srs.js'); const { schedulerOptions } = await import('./js/sched-settings.js'); const db = await import('./js/db.js');
  const opts = schedulerOptions(await db.getSettings());
  const now = Date.now();
  const strong = { cardId: 'x', due: now, stability: 200, difficulty: 3, elapsedDays: 60, scheduledDays: 60, learningSteps: 0, reps: 8, lapses: 0, state: 2, lastReview: now - 60 * 86400000 };
  const iv = srs.previewIntervals(strong, opts, now);
  const next = srs.rate('x', strong, 4, opts, now);
  return { easyDays: iv[4] / 86400000, goodDays: iv[3] / 86400000, rated: (next.due - now) / 86400000, sched: next.scheduledDays };
});
ok(capped.easyDays <= 45 && capped.goodDays <= 45 && capped.rated <= 45 && capped.sched <= 45, 'nothing goes past the 45-day maximum: ' + JSON.stringify(capped));
await page.click('#endBtn');

// Reset to defaults
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#advanced'); if (!(await page.evaluate(() => document.getElementById('advanced').open))) await page.click('#advanced summary');   // (the fold remembers it was opened)
ok(await page.evaluate(() => document.getElementById('advanced').open), 'advanced opens (by its summary, or remembered)');
await page.click('#schedReset'); await page.waitForFunction(() => document.getElementById('lsteps')?.value === '1m 10m');
ok((await setting('maxInterval')) === 36500 && (await setting('fuzz')) === true && (await setting('relearningSteps')) === '10m' && (await setting('learningSteps')) === '1m 10m', 'reset puts every default back');
ok(await page.evaluate(() => document.getElementById('advanced').open), 'advanced stays open after reset');

// Play: definition deck starts on Back → front; your pick is remembered per deck
await page.evaluate(async () => { const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'vocab', name: 'Spanish', color: '#46A758', created: Date.now() }, ['uno|one', 'dos|two', 'tres|three', 'cuatro|four', 'cinco|five'].map((p, i) => ({ id: 'v' + i, deckId: 'vocab', front: p.split('|')[0], back: p.split('|')[1], tags: [], created: i }))); });
await page.goto('http://localhost:8123/#/play'); await page.waitForSelector('#pDeck');
const sampleId = await page.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name.includes('Psychology')).id);
await page.selectOption('#pDeck', sampleId);
ok(await page.isChecked('input[name=qtype][value=back]') && (await page.textContent('#customBody fieldset:nth-of-type(1) .note')).includes('long answers'), 'psychology deck (long backs) starts on Back → front, with a reason');
await page.screenshot({ path: SP + '/adv-play.png', fullPage: true });
await page.selectOption('#pDeck', 'vocab');
ok(await page.isChecked('input[name=qtype][value=front]'), 'short-answer deck starts on Front → back');
await page.selectOption('#pDeck', sampleId);
if (await page.getAttribute('#customBtn', 'aria-expanded') !== 'true') await page.click('#customBtn');   // the question type lives under Customise
await page.click('#customBody label.chip:has(input[name=qtype][value=front])');
await page.selectOption('#pDeck', 'vocab'); await page.selectOption('#pDeck', sampleId);
ok(await page.isChecked('input[name=qtype][value=front]'), 'your pick for a deck is remembered');
await page.reload(); await page.waitForSelector('#pDeck');
ok(await page.isChecked('input[name=qtype][value=front]'), '...even after reopening the app');
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
