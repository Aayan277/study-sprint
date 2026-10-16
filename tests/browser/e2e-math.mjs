// F2: maths on cards (KaTeX): Review, Play, Browse, the editor's sum button and preview, the import preview, a failed
// download, and prices that are not maths. At 375px and on a desktop, in dark, light and OLED.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const watch = (page, { quiet = false } = {}) => {
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (!quiet && m.type() === 'error' && !m.text().includes('Could not save answer')) errors.push('console ' + m.text()); });
};
const noHScroll = async (page, w) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const skin = (page, mode) => page.evaluate(m => {
  const r = document.documentElement;
  r.dataset.theme = m === 'light' ? 'light' : 'dark';
  if (m === 'oled') r.dataset.oled = 'on'; else delete r.dataset.oled;
}, mode);
const drawn = (page, sel = '.katex') => page.waitForFunction(s => document.querySelector(s), sel, { timeout: 20000 });

const LONG = '$$' + Array.from({ length: 14 }, (_, i) => `x_{${i + 1}}^{2}`).join(' + ') + ' = \\sum_{k=1}^{n} \\frac{k^2 + 1}{k} \\cdot \\sqrt{\\alpha_k + \\beta_k}$$';
const seed = page => page.evaluate(async long => {
  const db = await import('./js/db.js');
  const card = (id, front, back, i) => ({ id, deckId: 'mth', front, back, tags: [], created: i });
  await db.addDeckWithCards({ id: 'mth', name: 'Maths', color: '#3E63DD', created: Date.now() }, [
    ['What is $\\frac{a}{b}$?', '$$E=mc^2$$'],
    ['Long one', long],
    ['Price', '$5 and $10'],
    ['Area of a circle', '**Area** is $\\pi r^2$'],
    ['Derivative of $x^2$', '$2x$']
  ].map(([f, b], i) => card('m' + i, f, b, i)));
  await db.setSetting('reviewTyping', false);
}, LONG);

// ---------- Review at 375px ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await seed(page);
  await page.evaluate(() => { location.hash = '#/review/mth'; });
  await page.waitForSelector('#flash');
  const seen = {};
  for (let i = 0; i < 5; i++) {
    await page.waitForSelector('.flash-front');
    const front = (await page.textContent('.rv-front .flash-front')).trim();
    if (front.startsWith('What is')) {
      await drawn(page, '.rv-front .flash-front .katex');
      ok(await page.locator('.rv-front .flash-front .tex[data-done="1"]').count() === 1, 'Review: the front formula is drawn');
      ok(await page.locator('.rv-front .flash-front .katex-display').count() === 0 && (await page.textContent('.rv-front .flash-front')).includes('What is'), 'Review: an inline formula stays in the line');
      await page.click('#flash'); await page.waitForSelector('.rv-back .flash-back .katex-display');
      ok(await page.locator('.rv-back .flash-back .katex-display').count() === 1, 'Review: the back is display maths');
      await noHScroll(page, 'review maths');
      await page.waitForTimeout(500);
      await page.screenshot({ path: SP + '/f2-review-dark-375.png' });
      for (const m of ['light', 'oled']) {
        await skin(page, m);
        await page.waitForTimeout(150);
        const same = await page.evaluate(() => { const c = e => getComputedStyle(e).color; return c(document.querySelector('.rv-back .flash-back .katex')) === c(document.querySelector('.rv-back .flash-back')); });
        ok(same, `Review: maths follows the text colour in ${m}`);
        await page.screenshot({ path: SP + `/f2-review-${m}-375.png` });
      }
      await skin(page, 'dark');
      seen.basic = true;
    } else if (front === 'Long one') {
      await page.click('#flash'); await page.waitForSelector('.rv-back .flash-back .katex-display');
      await page.waitForTimeout(400);
      const box = await page.evaluate(() => { const e = document.querySelector('.rv-back .flash-back .tex-d'); return { sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX, tab: e.tabIndex }; });
      ok(box.sw > box.cw + 20 && box.ox === 'auto', `Review: long display maths scrolls inside its box (${box.sw} > ${box.cw})`);
      ok(box.tab === 0, 'Review: a scrolling formula can be reached with the keyboard');
      await noHScroll(page, 'review long maths');
      await page.screenshot({ path: SP + '/f2-review-long-375.png' });
      seen.long = true;
    } else if (front === 'Price') {
      await page.click('#flash'); await page.waitForSelector('.rv-back .flash-back');
      ok(await page.locator('.tex').count() === 0, 'Review: "$5 and $10" shows no maths');
      ok((await page.textContent('.rv-back .flash-back')).includes('$5 and $10'), 'Review: the prices show as typed');
      seen.price = true;
    } else if (front === 'Area of a circle') {
      await page.click('#flash'); await page.waitForSelector('.rv-back .flash-back .katex');
      ok(await page.locator('.rv-back .flash-back b').count() === 1, 'Review: bold still works next to maths');
      seen.bold = true;
    } else {
      await page.click('#flash'); await page.waitForSelector('.rv-back .flash-back');
      seen.other = true;
    }
    await page.waitForSelector('.rate.r3'); await page.click('.rate.r3'); await page.waitForTimeout(150);
    if (i < 4) await page.waitForFunction(old => document.querySelector('.rv-front .flash-front')?.textContent.trim() !== old, front).catch(() => {});
  }
  ok(Object.keys(seen).length === 5, 'Review: all five cards seen');
  await ctx.close();
}

// ---------- Review: typing a maths answer ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'ty', name: 'Typed maths', color: '#E5484D', created: Date.now() }, [{ id: 'ty0', deckId: 'ty', front: 'Slope of $x^2$ at 1', back: '$\\frac{a}{b}$', tags: [], created: 0 }]);
    await db.setSetting('reviewTyping', true);
  });
  await page.evaluate(() => { location.hash = '#/review/ty'; });
  await page.waitForSelector('#typeIn');
  await page.fill('#typeIn', 'a/b'); await page.keyboard.press('Enter');
  await page.waitForSelector('.rv-typed .typed');
  ok((await page.textContent('.rv-typed')).includes('Correct'), 'Typing: the plain text of a formula is accepted (a/b)');
  await ctx.close();
}

// ---------- Play and Browse at 375px ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await seed(page);
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'mp', name: 'Play maths', color: '#30A46C', created: Date.now() },
      ['$x^2$', '$\\sqrt{y}$', '$\\frac{1}{2}$', '$\\alpha+\\beta$', '$e^{i\\pi}$'].map((b, i) => ({ id: 'p' + i, deckId: 'mp', front: 'Q' + i + ' of $z_' + i + '$', back: b, tags: [], created: i })));
  });
  await page.click('.tab[data-tab=play]'); await page.waitForSelector('#pDeck');
  await page.selectOption('#pDeck', 'mp');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']) await page.$eval(s, el => el.click()).catch(() => {});
  await page.click('#startBtn'); await page.waitForSelector('#options .opt');
  await drawn(page, '#pPrompt .katex');
  ok(await page.locator('#pPrompt .tex[data-done="1"]').count() === 1, 'Play: the prompt formula is drawn');
  await drawn(page, '#options .lbl .katex');
  ok(await page.locator('.opt .lbl .katex').count() >= 4, 'Play: the options show drawn formulas (.lbl .katex)');
  await noHScroll(page, 'play maths');
  await page.waitForTimeout(400);
  await page.screenshot({ path: SP + '/f2-play-375.png' });
  await page.click('#options .opt >> nth=0'); await page.waitForSelector('.fb');
  ok(await page.locator('#feedback .katex, .opt .katex').count() >= 1, 'Play: maths stays drawn after answering');
  // Browse
  await page.evaluate(() => { location.hash = '#/deck/mth'; });
  await page.waitForSelector('.crow');
  await drawn(page, '.crow .katex');
  ok(await page.locator('.crow .f .katex').count() >= 2, 'Browse: rows show drawn maths');
  const price = page.locator('.crow', { hasText: 'Price' });
  ok(await price.locator('.tex').count() === 0 && (await price.textContent()).includes('$5 and $10'), 'Browse: the price row has no maths');
  await noHScroll(page, 'browse maths');
  await page.screenshot({ path: SP + '/f2-browse-375.png' });
  // The editor: the sum button on a plain box, and the preview
  await page.click('#brAdd'); await page.waitForSelector('#acForm');
  await page.fill('#acFront', 'Area of a circle is pi r^2');
  await page.evaluate(() => { const t = document.getElementById('acFront'); const i = t.value.indexOf('pi r^2'); t.focus(); t.setSelectionRange(i, i + 6); });
  ok(await page.locator('#acForm [data-fmt=math]').count() >= 2, 'Editor: the front and back boxes have a sum button');
  await page.click('#acForm [data-fmt=math][data-for=acFront]');
  ok((await page.inputValue('#acFront')) === 'Area of a circle is $pi r^2$', 'Editor: the sum button puts the selection between $ signs');
  await drawn(page, '#acFrontPrev .katex');
  ok(await page.isVisible('#acFrontPrev') && await page.locator('#acFrontPrev .katex').count() === 1, 'Editor: the preview shows the drawn formula');
  await page.click('#acForm [data-fmt=math][data-for=acFront]');
  ok((await page.inputValue('#acFront')) === 'Area of a circle is pi r^2', 'Editor: pressing it again takes the $ signs off');
  await page.waitForFunction(() => document.getElementById('acFrontPrev').hidden);
  ok(await page.evaluate(() => document.getElementById('acFrontPrev').hidden), 'Editor: the preview hides again when there is no maths');
  await page.fill('#acBack', '$$E=mc^2$$'); await drawn(page, '#acBackPrev .katex-display');
  await noHScroll(page, 'editor maths');
  await page.screenshot({ path: SP + '/f2-editor-375.png' });
  await ctx.close();
}

// ---------- Import preview ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#pasteBox');
  await page.fill('#pasteBox', 'Energy - $E = mc^2$\nPlain - nothing special here\nPrice - $5 and $10');
  await page.waitForSelector('#preview:not([hidden])');
  await drawn(page, '.pv-math .katex');
  ok(await page.locator('.prow').count() === 3, 'Import: three cards found');
  ok((await page.inputValue('.prow:nth-child(1) textarea[data-side=front]')) === 'Energy' && (await page.inputValue('.prow:nth-child(1) textarea[data-side=back]')) === '$E = mc^2$', 'Import: the " = " inside the formula did not split the line');
  ok(await page.locator('.prow:nth-child(1) .pv-math .katex').count() === 1, 'Import: the row with maths has a drawn preview (.pv-math)');
  ok(await page.locator('.prow:nth-child(2) .pv-math:not([hidden])').count() === 0 && await page.locator('.prow:nth-child(3) .pv-math:not([hidden])').count() === 0, 'Import: rows without maths have no preview');
  await noHScroll(page, 'import maths');
  await page.screenshot({ path: SP + '/f2-import-375.png', fullPage: true });
  await ctx.close();
}

// ---------- Desktop 1440: the Word-style editor, display maths, themes ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await seed(page);
  await page.evaluate(() => { location.hash = '#/deck/mth'; });
  await page.waitForSelector('.crow');
  await page.click('#brAdd'); await page.waitForSelector('#acForm');
  ok(await page.locator('#acFront[data-rich]').count() === 1, 'Desktop: the editor is the Word-style box');
  await page.click('#acFront'); await page.keyboard.type('Speed is v');
  await page.keyboard.press('Shift+Home'); await page.keyboard.type('x');   // replace the line with a single x selected next
  await page.keyboard.press('Control+A');
  await page.click('#acForm [data-fmt=math][data-for=acFront]');
  const txt = await page.evaluate(() => document.getElementById('acFront').textContent);
  ok(txt === '$x$', 'Desktop: the sum button wraps the selection in $ signs in the rich box (' + txt + ')');
  await drawn(page, '#acFrontPrev .katex');
  ok(await page.isVisible('#acFrontPrev'), 'Desktop: the preview shows under the rich box');
  await page.keyboard.type('^2');
  await page.waitForFunction(() => document.getElementById('acFrontPrev').dataset.src?.includes('^2'));
  ok((await page.evaluate(() => document.getElementById('acFrontPrev').dataset.src)).includes('^2'), 'Desktop: the preview follows typing');
  await page.screenshot({ path: SP + '/f2-editor-1440.png' });
  await page.evaluate(() => { location.hash = '#/review/mth'; });
  await page.waitForSelector('#flash');
  await drawn(page, '.rv-front .katex');
  await page.click('#flash'); await page.waitForSelector('.rv-back .katex-display');
  await noHScroll(page, 'desktop review');
  await page.waitForTimeout(500);
  for (const m of ['dark', 'light', 'oled']) {
    await skin(page, m); await page.waitForTimeout(150);
    await page.screenshot({ path: SP + `/f2-review-${m}-1440.png` });
  }
  await ctx.close();
}

// ---------- KaTeX can't be downloaded: the raw text stays, nothing breaks ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.route(/katex/, r => r.abort());
  const page = await ctx.newPage(); watch(page, { quiet: true });
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await seed(page);
  await page.evaluate(() => { location.hash = '#/review/mth'; });
  await page.waitForSelector('#flash');
  await page.waitForSelector('.flash-front .tex-raw', { timeout: 20000 });
  ok(await page.locator('.rv-front .flash-front .tex-raw').count() === 1, 'Offline: the formula stays as raw text (.tex-raw)');
  ok((await page.textContent('.rv-front .flash-front .tex-raw')) === '$\\frac{a}{b}$', 'Offline: the raw text is what was typed');
  ok((await page.getAttribute('.rv-front .flash-front .tex-raw', 'title')).includes('online'), 'Offline: a tooltip says maths shows once online');
  ok(await page.locator('.katex').count() === 0, 'Offline: nothing was drawn');
  await noHScroll(page, 'offline maths');
  await page.screenshot({ path: SP + '/f2-offline-375.png' });
  await page.click('#flash'); await page.waitForSelector('.rv-back .tex-raw');
  ok(await page.locator('.rv-back .tex-d.tex-raw').count() === 1, 'Offline: the display formula is raw text too');
  await noHScroll(page, 'offline display maths');
  // Back online: the same page draws them
  await ctx.unroute(/katex/);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await drawn(page, '.rv-back .katex-display');
  ok(await page.locator('.tex-raw').count() === 0, 'Offline: coming back online draws the maths');
  await ctx.close();
}

ok(!errors.some(e => e.startsWith('pageerror')), 'no pageerror in any run' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
