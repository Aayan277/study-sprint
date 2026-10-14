// v4.2.2 (docs/design/katex-review.md): import-map integrity enforced in Chromium, the fetch fallback, the raw fallback
// for formulas KaTeX can't read, typed answers (words or text as written), the render cache and idle chunks, scrolling
// formulas (tabindex, role, resize), retry after a failed load, the desktop sum button taking the $ off, and the
// one-line typed-answer diff at 375px.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const watch = (page, { quiet = false } = {}) => {
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (!quiet && m.type() === 'error' && !m.text().includes('Could not save answer')) errors.push('console ' + m.text()); });
};
const URL0 = 'http://localhost:8123/';
const KATEX_JS = '**/katex@0.16.47/dist/katex.mjs';
const mobile = { serviceWorkers: 'block', viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const seed = (page, id, cards, typing = false) => page.evaluate(async ([id, cards, typing]) => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id, name: 'Deck ' + id, color: '#3E63DD', created: Date.now() },
    cards.map(([f, b], i) => ({ id: id + i, deckId: id, front: f, back: b, tags: [], created: i })));
  await db.setSetting('reviewTyping', typing);
}, [id, cards, typing]);
const open = async (ctx, id, cards, typing = false, quiet = false) => {
  const page = await ctx.newPage(); watch(page, { quiet });
  await page.goto(URL0 + '#/decks'); await page.waitForSelector('.deck');
  await seed(page, id, cards, typing);
  await page.evaluate(h => { location.hash = h; }, '#/review/' + id);
  return page;
};
const typeAndCheck = async (ctx, id, back, typed) => {
  const page = await open(ctx, id, [['Q', back]], true);
  await page.waitForSelector('#typeIn');
  await page.fill('#typeIn', typed); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .typed');
  const text = await page.textContent('.rv-typed .typed');
  await page.close();
  return text;
};

// ---------- the import map is enforced (Chromium) ----------
{
  const ctx = await browser.newContext(mobile);
  const page = await open(ctx, 'ok', [['What is $x^2$?', 'Squared']]);
  await page.waitForSelector('.flash-front .katex', { timeout: 20000 });
  const info = await page.evaluate(() => {
    const link = document.querySelector('link[data-katex]'), map = document.querySelector('script[type=importmap]');
    return { integrity: link.integrity, cross: link.crossOrigin, map: JSON.parse(map.textContent).integrity, before: !!(map.compareDocumentPosition(document.querySelector('script[type=module]')) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  ok(info.integrity === 'sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA' && info.cross === 'anonymous', 'the KaTeX stylesheet has integrity and crossorigin=anonymous, and still loads');
  ok(info.before && Object.keys(info.map).length >= 5 && info.map['https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.mjs'].startsWith('sha384-7P2cqEHJR2'), 'the import map is in the page before the module script');
  ok(await page.evaluate(async () => { const m = await import('https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs'); return typeof m.fsrs === 'function'; }), 'ts-fsrs loads through its fingerprint');
  await ctx.close();
}
{
  // a tampered katex.mjs is refused: the raw text stays and the injected code never runs
  const ctx = await browser.newContext(mobile);
  let served = 0;
  await ctx.route(KATEX_JS, async route => {
    const real = await route.fetch();
    served++;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' }, body: (await real.text()) + '\n;globalThis.__pwned = 1;\n' });
  });
  const page = await open(ctx, 'bad', [['What is $x^2$?', 'Squared']], false, true);
  await page.waitForSelector('.flash-front .tex[data-done="raw"]', { timeout: 20000 });
  ok(served >= 1, 'the browser asked for katex.mjs and got the tampered copy (' + served + ')');
  ok(await page.evaluate(() => globalThis.__pwned === undefined), 'tampered katex.mjs was not executed');
  ok(await page.locator('.flash-front .katex').count() === 0 && (await page.textContent('.flash-front .tex-raw')) === '$x^2$', 'the raw formula text is shown instead');
  await ctx.close();
}
{
  // the first request fails (and a browser may remember that): the file is fetched, checked against the fingerprint, imported from a blob
  const ctx = await browser.newContext(mobile);
  let hits = 0;
  await ctx.route(KATEX_JS, route => (hits++ === 0 ? route.abort() : route.continue()));
  const page = await open(ctx, 'retry', [['What is $x^2$?', 'Squared']], false, true);
  await page.waitForSelector('.flash-front .katex', { timeout: 20000 });
  ok(hits >= 2, 'after a failed first request katex.mjs was fetched again and drawn (' + hits + ' requests)');
  await ctx.close();
}
{
  // KaTeX fails to load (offline, say): raw text; when it loads later, the raw marks clear by themselves
  const ctx = await browser.newContext(mobile);
  await ctx.route(KATEX_JS, route => route.abort());
  const page = await open(ctx, 'late', [['What is $x^2$?', 'Squared']], false, true);
  await page.waitForSelector('.flash-front .tex[data-done="raw"]', { timeout: 20000 });
  await ctx.unroute(KATEX_JS);
  await page.evaluate(() => import('./js/math.js').then(m => m.loadKatex()));
  await page.waitForSelector('.flash-front .katex', { timeout: 20000 });
  ok(await page.locator('.flash-front .tex-raw').count() === 0 && await page.locator('.flash-front .tex[data-done="1"]').count() === 1, 'a later successful load clears the raw marks and draws the formula');
  await ctx.close();
}

// ---------- formulas KaTeX can't read show as typed ----------
{
  const ctx = await browser.newContext(mobile);
  const page = await open(ctx, 'err', [['Bad $\\frac{a$ and good $y^2$', 'Back']]);
  await page.waitForSelector('.flash-front .tex-raw', { timeout: 20000 });
  await page.waitForSelector('.flash-front .katex');
  ok((await page.textContent('.flash-front .tex-raw')) === '$\\frac{a$' && await page.locator('.flash-front .katex-error').count() === 0, 'a formula KaTeX rejects shows as the raw text (tex-raw), not as an error');
  ok(await page.locator('.flash-front .tex[data-done="1"] .katex').count() === 1, 'the good formula next to it is drawn');
  await ctx.close();
}

// ---------- typed answers: the words, or the text as written ----------
{
  const ctx = await browser.newContext(mobile);
  ok((await typeAndCheck(ctx, 'ty1', 'It costs \\$5', 'It costs $5')).includes('Correct'), 'typing the literal text of a card with an escaped dollar is right');
  ok((await typeAndCheck(ctx, 'ty2', '$\\frac{a}{b}$', '\\frac{a}{b}')).includes('Correct'), 'typing the LaTeX of a formula answer is right');
  ok((await typeAndCheck(ctx, 'ty3', '$\\frac{a}{b}$', 'a/b')).includes('Correct'), 'typing the words of a formula answer is still right');
  ok((await typeAndCheck(ctx, 'ty4', '$\\alpha$', 'α')).includes('Correct'), 'typing α is right for \\alpha');
  ok(!(await typeAndCheck(ctx, 'ty5', '$\\frac{a}{b}$', 'c/d')).includes('Correct'), 'a wrong answer is still wrong');
  // size is measured as words: long LaTeX with a short meaning is not a "long" answer
  const long = Array(8).fill('$\\frac{\\displaystyle a}{b}$').join(' + ');
  const page = await open(ctx, 'siz', [['Sum?', long]]);
  await page.waitForSelector('#flash'); await page.click('#flash'); await page.waitForSelector('.rv-back .flash-back');
  ok(long.length > 160 && !/\blong\b/.test(await page.getAttribute('.rv-back .flash-back', 'class')), 'a long LaTeX answer with short words keeps the normal size');
  await ctx.close();
}

// ---------- scrolling formulas, the render cache, idle chunks ----------
{
  const ctx = await browser.newContext(mobile);
  const wide = '$$' + Array.from({ length: 9 }, (_, i) => `x_{${i + 1}}^{2}`).join(' + ') + '$$';
  const page = await open(ctx, 'wide', [['Wide', wide]]);
  await page.waitForSelector('#flash'); await page.click('#flash');
  await page.waitForSelector('.rv-back .tex-d .katex');
  const attrs = () => page.evaluate(() => { const e = document.querySelector('.rv-back .tex-d'); return [e.getAttribute('tabindex'), e.getAttribute('role'), e.getAttribute('aria-label')]; });
  ok(JSON.stringify(await attrs()) === '["0","group","Formula"]', 'a formula wider than its box is a focusable group named Formula ' + JSON.stringify(await attrs()));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction(() => !document.querySelector('.rv-back .tex-d').hasAttribute('tabindex'), null, { timeout: 5000 }).catch(() => {});
  ok(JSON.stringify(await attrs()) === '[null,null,null]', 'after a resize it fits, so the tab stop, role and label are removed ' + JSON.stringify(await attrs()));
  await page.setViewportSize({ width: 375, height: 740 });
  await page.waitForFunction(() => document.querySelector('.rv-back .tex-d').hasAttribute('tabindex'), null, { timeout: 5000 }).catch(() => {});
  ok((await attrs())[0] === '0', 'and back again when it is narrow');

  const r = await page.evaluate(async () => {
    const m = await import('./js/math.js'), katex = await m.loadKatex();
    let calls = 0, idles = 0;
    const orig = katex.renderToString;
    katex.renderToString = (...a) => { calls++; return orig.apply(katex, a); };
    const ric = window.requestIdleCallback;
    window.requestIdleCallback = (f, o) => { idles++; return ric(f, o); };
    const box = document.createElement('div');
    for (let i = 0; i < 130; i++) { const s = document.createElement('span'); s.className = 'tex'; s.dataset.tex = `x_{${i % 5}}`; s.textContent = '$x$'; box.append(s); }
    document.body.append(box);
    await m.renderMath(box);
    katex.renderToString = orig; window.requestIdleCallback = ric;
    return { calls, idles, drawn: box.querySelectorAll('.katex').length, done: box.querySelectorAll('.tex[data-done="1"]').length };
  });
  ok(r.drawn === 130 && r.done === 130, 'a page of 130 formulas is all drawn (' + r.drawn + ')');
  ok(r.calls === 5, 'the same formula is drawn by KaTeX once (cache): 5 calls for 5 different ones, got ' + r.calls);
  ok(r.idles >= 2, 'the formulas after the first 50 are drawn in idle chunks (' + r.idles + ' idle callbacks)');
  await ctx.close();
}

// ---------- desktop: the sum button takes the $ off again ----------
{
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); watch(page);
  await page.goto(URL0 + '#/decks'); await page.waitForSelector('.deck');
  await seed(page, 'dsk', [['Q', 'A']]);
  await page.evaluate(() => { location.hash = '#/deck/dsk'; });
  await page.waitForSelector('.crow');
  await page.click('#brAdd'); await page.waitForSelector('#acForm');
  await page.click('#acFront'); await page.keyboard.type('x');
  await page.keyboard.press('Control+A');
  const text = () => page.evaluate(() => document.getElementById('acFront').textContent);
  await page.click('#acForm [data-fmt=math][data-for=acFront]');
  ok(await text() === '$x$', 'Desktop: the sum button wraps the selection');
  await page.keyboard.press('Control+A');
  await page.click('#acForm [data-fmt=math][data-for=acFront]');
  ok(await text() === 'x', 'Desktop: with the selection already wrapped it takes the $ signs off');
  await ctx.close();
}

// ---------- the one-line typed diff: the label column hugs its label (375px) ----------
{
  const ctx = await browser.newContext(mobile);
  const check = async (id, back, typed) => {
    const page = await open(ctx, id, [['Q', back]], true);
    await page.waitForSelector('#typeIn');
    await page.fill('#typeIn', typed); await page.keyboard.press('Enter'); await page.waitForSelector('.rv-typed .adiff.one');
    const m = await page.evaluate(() => [...document.querySelectorAll('.adiff.one .adiff-lbl')].map(e => { const r = e.getBoundingClientRect(); return { text: e.textContent, w: Math.round(r.width), h: Math.round(r.height), lh: parseFloat(getComputedStyle(e).lineHeight) }; }));
    await page.close();
    return m;
  };
  const one = await check('d1', 'hello there', 'hallo there');
  ok(one.length === 1 && one[0].text === 'You typed' && one[0].w < 80, 'one row: the "You typed" label hugs its text (' + JSON.stringify(one) + ')');
  const two = await check('d2', 'red / scarlet', 'scarlt');
  ok(two.length === 2 && two[1].text === 'Closest answer' && two.every(l => l.h < l.lh * 1.6) && two[0].w === two[1].w, 'two rows: both labels on one line, in one column (' + JSON.stringify(two) + ')');
  ok(two[0].w < 110, 'and the column is no wider than "Closest answer" needs (' + two[0].w + 'px)');
  await ctx.close();
}

ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
await browser.close();
