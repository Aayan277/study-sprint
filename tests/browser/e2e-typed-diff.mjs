// F3: typed answers show which letters were wrong (Review, Play, the missed list), at 375px and on a desktop.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const watch = page => {
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Could not save answer')) errors.push('console ' + m.text()); });
};
const noHScroll = async (page, w) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const skin = (page, mode) => page.evaluate(m => {
  const r = document.documentElement;
  r.dataset.theme = m === 'light' ? 'light' : 'dark';
  if (m === 'oled') r.dataset.oled = 'on'; else delete r.dataset.oled;
}, mode);

const seed = page => page.evaluate(async () => {
  const db = await import('./js/db.js');
  const card = (id, deckId, front, back, i) => ({ id, deckId, front, back, tags: [], created: i });
  await db.addDeckWithCards({ id: 'rv', name: 'Diff review', color: '#E5484D', created: Date.now() },
    [['Powerhouse', 'mitochondria'], ['Hello', 'hello'], ['Colour', 'red / scarlet'], ['Long', 'photosynthesis'], ['Close', 'The Café']].map(([f, b], i) => card('rv' + i, 'rv', f, b, i)));
  await db.addDeckWithCards({ id: 'pl', name: 'Diff play', color: '#3E63DD', created: Date.now() },
    [['P-mito', 'mitochondria'], ['P-hello', 'hello'], ['P-red', 'red / scarlet']].map(([f, b], i) => card('pl' + i, 'pl', f, b, i)));
  await db.setSetting('reviewTyping', true);
});

// ---------- Review at 375px ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await seed(page);
  await page.evaluate(() => { location.hash = '#/review/rv'; });
  await page.waitForSelector('#flash');
  const typeAnswer = async text => { await page.fill('#typeIn', text); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed'); };
  const next = async () => { await page.click('.rate.r3'); await page.waitForTimeout(120); };
  const frontNow = () => page.textContent('.flash-front');
  const wanted = { Powerhouse: 'mitocondria', Hello: 'hello', Colour: 'scarlett', Long: 'xqzvbnm', Close: 'cafe' };
  const seen = {};
  for (let i = 0; i < 5; i++) {
    await page.waitForSelector('#typeIn');
    const f = (await frontNow()).trim();
    await typeAnswer(wanted[f]);
    seen[f] = true;
    const typed = await page.textContent('.rv-typed');
    if (f === 'Powerhouse') {
      ok((await page.textContent('.rv-typed ins.d-miss')) === 'h', 'Review: the missing letter is h');
      ok((await page.textContent('.rv-typed .sr-only')).includes('missing'), 'Review: the screen-reader sentence mentions missing');
      ok(typed.includes('1 missing'), 'Review: summary says 1 missing');
      // v4.2.1: Review has one corrected line, so the missing letter is inserted in place (ins.d-miss above) and there is no caret
      ok(await page.locator('.rv-typed .d-caret').count() === 0 && await page.locator('.rv-typed .adiff-row').count() === 1, 'Review: the missing letter is inserted inline (one line, no caret)');
      ok((await page.getAttribute('.rv-typed .adiff-row', 'aria-hidden')) === 'true', 'Review: the rows are hidden from screen readers');
      ok(typed.includes('Correct, with a small typo'), 'Review: verdict line kept');
      await noHScroll(page, 'review diff'); await page.waitForTimeout(600); await page.screenshot({ path: SP + '/f3-review-dark-375.png' });
      for (const m of ['light', 'oled']) { await skin(page, m); await page.screenshot({ path: SP + `/f3-review-${m}-375.png` }); }
      await skin(page, 'dark');
    }
    if (f === 'Hello') ok(!(await page.locator('.rv-typed .adiff').count()) && typed.includes('Correct'), 'Review: an exact answer shows no diff');
    if (f === 'Colour') {
      ok(await page.locator('.rv-typed del.d-extra').count() === 1 && (await page.textContent('.rv-typed .adiff-row:nth-child(2)')).includes('scarlet') && !(await page.textContent('.rv-typed .adiff-row:nth-child(2)')).includes('red'),
        'Review: "scarlett" is compared with "scarlet" (nearest allowed answer), 1 extra');
    }
    if (f === 'Long') {
      // v4.2.1: too different is just "Not quite. You typed X" (the card shows the answer): no diff box at all
      ok(typed.includes('Not quite. You typed xqzvbnm') && await page.locator('.rv-typed .adiff').count() === 0 && await page.locator('.rv-typed mark, .rv-typed ins, .rv-typed del').count() === 0, 'Review: a very different answer shows "You typed X", no diff box, no marks');
      await noHScroll(page, 'review plain'); await page.waitForTimeout(600); await page.screenshot({ path: SP + '/f3-review-plain-375.png' });
    }
    if (f === 'Close') ok(!(await page.locator('.rv-typed .adiff').count()), 'Review: case, accents and article differences are not marked');
    await page.waitForSelector('.rate.r3'); await next();
    if (i < 4) await page.waitForFunction(old => document.querySelector('.flash-front')?.textContent.trim() !== old, f).catch(() => {});
  }
  ok(Object.keys(seen).length === 5, 'Review: all five cards seen');
  await ctx.close();
}

// ---------- Review: wrong answer with two wrong letters, and escaping ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'one', name: 'One', color: '#E5484D', created: Date.now() }, [{ id: 'one0', deckId: 'one', front: 'Greeting', back: 'hello there', tags: [], created: 0 }]);
    await db.setSetting('reviewTyping', true);
  });
  await page.evaluate(() => { location.hash = '#/review/one'; });
  await page.waitForSelector('#typeIn');
  await page.fill('#typeIn', 'hallo <b>thxre</b>'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed');
  ok(await page.locator('.rv-typed b').count() === 0, 'Review: typed HTML is escaped');
  ok((await page.textContent('.rv-typed .typed')).includes('Not quite') && await page.locator('.rv-typed .adiff').count() === 1, 'Review: a wrong answer gets the diff');
  await noHScroll(page, 'review wrong'); await page.waitForTimeout(600); await page.screenshot({ path: SP + '/f3-review-wrong-375.png' });
  await ctx.close();
}

// ---------- Play at 375px ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await seed(page);
  await page.click('.tab[data-tab=play]'); await page.waitForSelector('#pDeck');
  await page.selectOption('#pDeck', 'pl');
  ok(await page.isChecked('input[name=qtype][value=typing]'), 'Play: a small deck is typing only');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=len][value="10"]']) await page.$eval(s, el => el.click());
  await page.click('#startBtn'); await page.waitForSelector('#pInput');
  const typedFor = { 'P-mito': 'mitocondria', 'P-hello': 'hallx', 'P-red': 'zzzzzzzz' };
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    const prompt = (await page.textContent('#pPrompt')).trim();
    await page.fill('#pInput', typedFor[prompt]); await page.keyboard.press('Enter');
    await page.waitForSelector('.fb');
    seen.add(prompt);
    if (prompt === 'P-mito') {
      ok((await page.textContent('.fb-mark')).includes('Correct') && await page.locator('#feedback ins.d-miss').count() === 1, 'Play: a forgiven typo shows the missing letter');
      await noHScroll(page, 'play correct diff'); await page.screenshot({ path: SP + '/f3-play-correct-375.png' });
    } else if (prompt === 'P-hello') {
      ok((await page.textContent('.fb-mark')).includes('Not quite') && await page.locator('#feedback mark.d-wrong').count() >= 1 && !(await page.textContent('#feedback')).includes('You answered'),
        'Play: a wrong answer shows the diff instead of "You answered"');
      // v4.2.1: the bold answer is dropped when a diff is shown; the diff's Answer row has it
      ok(!(await page.locator('.fb-info').count()) && (await page.textContent('#feedback .adiff')).includes('hello'), 'Play: the right answer is shown once, in the diff');
      await noHScroll(page, 'play wrong diff'); await page.screenshot({ path: SP + '/f3-play-wrong-375.png' });
    } else {
      ok(await page.locator('#feedback .adiff.plain').count() === 1, 'Play: a very different answer shows both texts');
    }
    if (await page.locator('#nextBtn').textContent().then(t => t.includes('See results'))) { await page.click('#nextBtn'); break; }
    if (await page.locator('.fb.no').count()) await page.click('#nextBtn');
    await page.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' || document.querySelector('.stamp')).catch(() => {});
    if (await page.locator('.stamp').count()) break;
  }
  await page.waitForSelector('.stamp', { timeout: 6000 });
  ok(seen.size === 3, 'Play: all three cards asked');
  ok(await page.locator('.miss .adiff.small mark.d-wrong').count() >= 1, 'Play results: the missed list keeps the marks');
  ok(await page.locator('.miss').count() === 2, 'Play results: two missed cards');
  await noHScroll(page, 'play results'); await page.screenshot({ path: SP + '/f3-play-results-375.png', fullPage: true });
  await ctx.close();
}

// ---------- Desktop 1440 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await seed(page);
  await page.evaluate(() => { location.hash = '#/review/rv'; });
  await page.waitForSelector('#typeIn');
  for (let i = 0; i < 5 && (await page.textContent('.flash-front')).trim() !== 'Powerhouse'; i++) { await page.keyboard.press('Space'); await page.waitForSelector('.rate.r3'); await page.click('.rate.r3'); await page.waitForTimeout(150); }
  await page.fill('#typeIn', 'mitocondria'); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .adiff');
  ok((await page.textContent('.rv-typed ins.d-miss')) === 'h', 'Desktop: the diff shows');
  await noHScroll(page, 'desktop review'); await page.waitForTimeout(600);
  for (const m of ['dark', 'light', 'oled']) { await skin(page, m); await page.screenshot({ path: SP + `/f3-review-${m}-1440.png` }); }
  await ctx.close();
}

ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
