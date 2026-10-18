// QA fixes (v4.34 testing round): unsaved work is not thrown away by Back / Close, the "You mix these up" rows and long deck names
// stay inside the screen (checked by every element's right edge: scrollWidth misses it on a phone), leaving Browse while typing,
// Q:/A: paste, the Retention helper's axis and "not enough data" note, and Play waiting for KaTeX before it shows an option.
// Run with: node tests/browser/run.mjs e2e-qafix
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const SEED = `(() => { let s = 20261014; Math.random = () => (s = (s * 16807) % 2147483647) / 2147483647; })();`;
const open = async ({ w = 375, h = 800, scheme = 'light', ui = 'original', hash = '#/decks', route = null, rail = '0' } = {}) => {
  const touch = w < 600;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, colorScheme: scheme });
  await ctx.addInitScript(SEED);
  await ctx.addInitScript(([ui, scheme, rail]) => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui, skin: ui === 'clinical' ? 'ocean' : 'violet', mode: scheme })); localStorage.setItem('study-sprint-rail', rail); } catch { /* fine */ } }, [ui, scheme, rail]);
  if (route) await ctx.route(...route);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + hash); await p.waitForSelector('#screen .view'); await p.waitForTimeout(500);
  return p;
};
// Elements whose right edge passes the screen's width (scrollWidth <= innerWidth misses this with isMobile, where the layout viewport grows).
const edges = (p, W) => p.evaluate(W => {
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    // (a row that scrolls sideways on purpose, like Today's exam chips, may be wider than the screen inside its own box)
    const scrolls = el => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (/auto|scroll/.test(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= W + 1) return true; } return false; };
    if (r.width && r.right > W + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('dialog:not([open]), [hidden], svg') && !scrolls(e)) out.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} right=${Math.round(r.right)}`);
  }
  return out.slice(0, 6);
}, W);
const noEdge = async (p, W, what) => { const o = await edges(p, W); ok(o.length === 0, `${what}: nothing runs past the right edge${o.length ? ' ' + JSON.stringify(o) : ''}`); };
const back = async p => { await p.evaluate(() => history.back()); await p.waitForTimeout(600); };
const sheetOpen = p => p.evaluate(() => document.getElementById('sheet')?.open === true);
const asking = p => p.evaluate(() => { const a = document.getElementById('discardAsk'); return !!a && /Discard changes\?/.test(a.textContent) && !!a.querySelector('#discardKeep') && !!a.querySelector('#discardYes'); });
const deckOf = p => p.evaluate(() => { location.hash = '#/decks'; });

// ---------- 1. unsaved edits ----------
{
  const p = await open();
  await p.click('.deck-open'); await p.waitForSelector('.crow');
  // Add card: typed text, then Back
  await p.click('#brAdd'); await p.waitForSelector('#acFront');
  await back(p);
  ok(!(await sheetOpen(p)), 'Add card: Back with nothing typed just closes (no question)');
  await p.click('#brAdd'); await p.waitForSelector('#acFront');
  await p.click('#acFront'); await p.keyboard.type('Half a card'); await p.waitForTimeout(200);
  await back(p);
  ok(await sheetOpen(p) && await asking(p), 'Add card: Back with typed text asks "Discard changes?" (Keep editing / Discard)');
  ok((await p.textContent('#acFront')).includes('Half a card') || (await p.inputValue('#acFront').catch(() => '')).includes('Half a card'), 'Add card: the typed text is still there');
  await p.click('#discardKeep'); await p.waitForTimeout(200);
  ok(await sheetOpen(p) && !(await asking(p)), 'Add card: Keep editing closes the question and stays');
  await back(p);
  ok(await asking(p), 'Add card: Back again asks again');
  await p.click('#discardKeep');
  await p.click('#acDone'); await p.waitForTimeout(300);
  ok(await sheetOpen(p) && await asking(p), 'Add card: the Close button asks too');
  await p.click('#discardKeep');
  await p.click('.sheet-x'); await p.waitForTimeout(300);
  ok(await sheetOpen(p) && await asking(p), 'Add card: the x asks too');
  await p.click('#discardYes'); await p.waitForTimeout(500);
  ok(!(await sheetOpen(p)), 'Add card: Discard closes the sheet');
  // after discarding, one Back leaves the deck page, not a dead entry
  await back(p);
  ok(await p.evaluate(() => location.hash) === '#/decks', 'Add card: the next Back goes to Decks (no leftover entry)');

  // After a card is added the form is empty again (the tags stay): Close is not asked about
  await p.click('.deck-open'); await p.waitForSelector('.crow');
  await p.click('#brAdd'); await p.waitForSelector('#acFront');
  await p.click('#acFront'); await p.keyboard.type('Front one');
  await p.click('#acBack'); await p.keyboard.type('Back one');
  await p.fill('#acTags', 'keepme');
  await p.click('button[type=submit][form=acForm]'); await p.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Card added'));
  await p.click('#acDone'); await p.waitForTimeout(400);
  ok(!(await sheetOpen(p)), 'Add card: after Add, Close just closes (what is left over is not unsaved work)');
  await back(p);

  // Editing a card from the card list: change then Back
  await p.click('.deck-open'); await p.waitForSelector('.crow');
  await p.click('.crow-btn'); await p.waitForSelector('#ceForm');
  await p.click('.sheet-x'); await p.waitForTimeout(400);
  ok(!(await sheetOpen(p)), 'Edit: closing an untouched card does not ask');
  await p.click('.crow-btn'); await p.waitForSelector('#ceForm');
  await p.click('#ceFront'); await p.keyboard.type(' changed'); await p.waitForTimeout(200);
  await back(p);
  ok(await sheetOpen(p) && await asking(p), 'Edit: Back after a change asks "Discard changes?"');
  await p.click('#discardYes'); await p.waitForTimeout(500);
  ok(!(await sheetOpen(p)), 'Edit: Discard closes');
  await p.close();
}
{
  // Review ⋯ → Edit card
  const p = await open({ hash: '#/today' });
  await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash');
  await p.click('#moreBtn'); await p.waitForSelector('.act-list'); await p.click('[data-go=edit]'); await p.waitForSelector('#ceForm');
  await p.click('#ceFront'); await p.keyboard.type('x'); await p.waitForTimeout(200);
  await back(p);
  ok(await sheetOpen(p) && await asking(p), 'Review: Edit card, Back after typing asks "Discard changes?"');
  await p.click('#discardKeep'); await p.waitForTimeout(200);
  ok((await p.textContent('#ceFront')).endsWith('x') || (await p.inputValue('#ceFront').catch(() => '')).endsWith('x'), 'Review: Keep editing keeps the edit');
  await p.click('#ceCancel'); await p.waitForTimeout(400);
  ok(!(await sheetOpen(p)), 'Review: Cancel still closes at once (it means discard)');
  await p.close();
}
{
  // Import: pasted text survives Back
  const p = await open({ hash: '#/import' });
  await p.waitForSelector('#pasteBox');
  await p.fill('#pasteBox', 'Alpha - first\nBeta - second'); await p.waitForSelector('#preview:not([hidden])');
  await p.click('#back'); await p.waitForTimeout(600);
  await p.evaluate(() => { location.hash = '#/import'; }); await p.waitForSelector('#pasteBox');
  await p.waitForTimeout(500);
  ok(await p.inputValue('#pasteBox') === 'Alpha - first\nBeta - second', 'Import: the pasted text is back after leaving and returning');
  ok(await p.locator('.prow').count() === 2, 'Import: and the preview is drawn again');
  await p.click('#clearBtn');
  await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck');
  await p.evaluate(() => { location.hash = '#/import'; }); await p.waitForSelector('#pasteBox');
  ok(await p.inputValue('#pasteBox') === '', 'Import: Clear forgets the draft');
  // a finished import forgets it too
  await p.fill('#pasteBox', 'Gamma - third\nDelta - fourth'); await p.waitForSelector('#preview:not([hidden])');
  await p.fill('#newName', 'Draft deck'); await p.click('#saveBtn'); await p.waitForTimeout(1200);
  await p.evaluate(() => { location.hash = '#/import'; }); await p.waitForSelector('#pasteBox');
  ok(await p.inputValue('#pasteBox') === '', 'Import: after the cards are saved the draft is gone');
  await p.close();
}

// ---------- 5. Q: / A: paste ----------
{
  const p = await open({ hash: '#/import' });
  await p.waitForSelector('#pasteBox');
  await p.fill('#pasteBox', 'Q: What is mitosis?\nA: Cell division\n\nQ: What is meiosis?\nA: Makes gametes\n\nQuestion: Capital of France?\nAnswer: Paris');
  await p.waitForSelector('#preview:not([hidden])');
  const found = await p.textContent('#found');
  const fronts = await p.$$eval('.prow textarea[data-side=front]', t => t.map(x => x.value));
  const backs = await p.$$eval('.prow textarea[data-side=back]', t => t.map(x => x.value));
  ok(/Found 3 cards/.test(found), 'Q:/A: paste: three cards found (' + found.trim() + ')');
  ok(fronts.join('|') === 'What is mitosis?|What is meiosis?|Capital of France?' && backs.join('|') === 'Cell division|Makes gametes|Paris', 'Q:/A: paste: fronts and backs are the pairs (' + fronts.join('|') + ' / ' + backs.join('|') + ')');
  await p.close();
}

// ---------- 4. leaving Browse while typing ----------
{
  const p = await open({ hash: '#/browse' });
  await p.waitForSelector('#brQuery');
  const before = errors.length;
  await p.evaluate(async () => {
    const q = document.getElementById('brQuery');
    q.value = 'mit'; q.dispatchEvent(new Event('input', { bubbles: true }));
    (await import('./js/nav.js')).go('#/today');          // leaves Browse inside the 150 ms
  });
  await p.waitForTimeout(500);
  ok(errors.length === before, 'Browse: leaving within 150 ms of typing throws nothing' + (errors.length > before ? ' ' + errors.slice(before).join(' / ') : ''));
  await p.close();
}

// ---------- 2. "You mix these up" rows stay on the screen ----------
for (const ui of ['original', 'clinical']) {
  const p = await open({ ui, hash: '#/decks' });
  const FR = ['Antidisestablishmentarianism_is_a_very_long_word_without_any_breaks_alpha', 'Pneumonoultramicroscopicsilicovolcanoconiosis_without_spaces_beta', 'Gamma', 'Delta'], BK = ['Apple', 'Banana', 'Cherry', 'Durian'];
  await p.evaluate(async ({ FR, BK }) => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'mx', name: 'Fruit', color: '#46A758', created: Date.now() }, FR.map((f, i) => ({ id: 'mx' + i, deckId: 'mx', front: f, back: BK[i], tags: [], created: i })));
    await db.setSetting('playCountsAsReviews', true);
  }, { FR, BK });
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', 'mx');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click());
  await p.click('#startBtn'); await p.waitForSelector('#pCard');
  for (let i = 0; i < 10; i++) {
    await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
    const prompt = (await p.textContent('#pPrompt')).trim();
    const want = { [FR[0]]: 'Banana', [FR[1]]: 'Apple' }[prompt] ?? BK[FR.indexOf(prompt)];
    const idx = await p.evaluate(w => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === w), want);
    await p.keyboard.press(String(idx + 1));
    await p.waitForSelector('.fb'); await p.keyboard.press('Enter');
  }
  await p.waitForSelector('.res-head'); await p.waitForSelector('.mixups .mix-row');
  await p.waitForTimeout(400);
  await noEdge(p, 375, `Play results (${ui}) with long names, 375px`);
  ok(await p.evaluate(() => [...document.querySelectorAll('.mix-card')].every(c => c.scrollWidth <= c.clientWidth + 1)), `Play results (${ui}): the labels wrap, none is cut off`);
  await p.screenshot({ path: SP + `/qafix-mix-${ui}.png`, fullPage: true });
  await p.close();
}

// ---------- 6. a long unbroken parent name ----------
for (const ui of ['original', 'clinical']) {
  const p = await open({ ui });
  const long = 'Pharmacology_and_Therapeutics_Module_Three_Cardiovascular_Renal_Endocrine_FinalExamPrep2026';
  await p.evaluate(async long => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'ln', name: long, course: 'PHARMACOLOGY-AND-THERAPEUTICS-301-SECTION-A', color: '#E5484D', created: Date.now() }, [{ id: 'ln1', deckId: 'ln', front: 'a', back: 'b', tags: [], created: 1 }]);
    await db.saveDeck({ id: 'ln-sub', parentId: 'ln', name: 'Subdeck_with_an_extremely_long_name_that_has_no_spaces_at_all_ok', color: '#3E63DD', created: Date.now() });
    await db.saveCards([{ id: 'ln2', deckId: 'ln-sub', front: 'c', back: 'd', tags: [], created: 2 }]);
  }, long);
  for (const r of ['decks', 'deck/ln-sub', 'deck/ln', 'today', 'browse', 'play', 'stats']) {
    await p.evaluate(h => { location.hash = '#/' + h; }, r); await p.waitForTimeout(900);
    await noEdge(p, 375, `${ui} #/${r} with long names`);
  }
  await p.evaluate(() => { location.hash = '#/deck/ln-sub'; }); await p.waitForSelector('#back'); await p.waitForTimeout(500);
  const bw = await p.$eval('#back', b => Math.round(b.getBoundingClientRect().width));
  ok(bw <= 343, `${ui}: the subdeck page's back button fits the screen (${bw}px wide)`);
  ok((await p.textContent('#back')).includes(long), `${ui}: and still holds the whole parent name (cut with an ellipsis, not removed)`);
  await p.click('#deckMore'); await p.click('#editDeck').catch(() => {}); await p.waitForTimeout(500);
  if (await sheetOpen(p)) await noEdge(p, 375, `${ui} edit-deck sheet with a long name`);
  await p.evaluate(() => { location.hash = '#/deck/ln'; }); await p.waitForTimeout(600);
  await p.click('#deckMore'); await p.click('#exportDeck'); await p.waitForTimeout(500);
  if (await sheetOpen(p)) await noEdge(p, 375, `${ui} export sheet with a long name`);
  await p.evaluate(() => { location.hash = '#/review/ln'; }); await p.waitForTimeout(900);
  await noEdge(p, 375, `${ui} review of a long-named deck`);
  await p.close();
}
{
  // The deck tree in the sidebar on a computer
  const p = await open({ w: 1440, h: 900, rail: '1' });
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'ln', name: 'Pharmacology_and_Therapeutics_Module_Three_Cardiovascular_Renal_Endocrine_FinalExamPrep2026', color: '#E5484D', created: Date.now() }, [{ id: 'ln1', deckId: 'ln', front: 'a', back: 'b', tags: [], created: 1 }]);
    await db.saveDeck({ id: 'ln-sub', parentId: 'ln', name: 'Subdeck_with_an_extremely_long_name_that_has_no_spaces_at_all_ok', color: '#3E63DD', created: Date.now() });
  });
  await p.evaluate(() => { location.hash = '#/deck/ln-sub'; }); await p.waitForSelector('#dtNav a, #dtNav button'); await p.waitForTimeout(700);
  const bad = await p.evaluate(() => {
    const out = [];
    for (const box of document.querySelectorAll('#dtNav, aside.deck-tree, #sidebar, .sidebar, nav')) {
      const b = box.getBoundingClientRect();
      for (const e of box.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && r.right > b.right + 1) out.push(`${box.id || box.className} > ${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${Math.round(r.right)}>${Math.round(b.right)}`); }
    }
    return out.slice(0, 5);
  });
  ok(bad.length === 0, 'computer: long names stay inside the sidebar and deck tree' + (bad.length ? ' ' + JSON.stringify(bad) : ''));
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'computer: no sideways scroll');
  await p.close();
}

// ---------- 8. Retention helper ----------
{
  const p = await open({ hash: '#/settings' });
  await p.evaluate(async () => (await import('./js/retention-sheet.js')).openRetentionSheet({ deckId: '', current: () => 90, onPick() {} }));
  await p.waitForSelector('.rc-svg', { timeout: 30000 });
  const ticks = await p.$$eval('.rc-svg:first-of-type .rc-tick[text-anchor=end]', t => t.map(x => x.textContent));
  ok(ticks.length === 5 && new Set(ticks).size === 5, 'Retention: the vertical axis labels are all different (' + ticks.join(', ') + ')');
  const sugg = await p.textContent('.rc-sugg');
  ok(/Not enough reviews yet to suggest a number/.test(sugg), 'Retention: with no reviews it says "Not enough reviews yet to suggest a number"');
  ok(!(await p.$('[data-rc=pickSug]')) && !/Suggested/.test(await p.$eval('.rc-svg', s => s.textContent)), 'Retention: no suggested target is offered or marked');
  await p.close();
}

// ---------- 9. Play waits for KaTeX ----------
{
  const KATEX = '**/katex@0.16.47/dist/katex.mjs';
  let release; const gate = new Promise(r => { release = r; });
  const p = await open({ route: [KATEX, async route => { await gate; await route.continue(); }] });
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'mt', name: 'Maths', color: '#3E63DD', created: Date.now() },
      [['$\\frac{a}{b}$', '$\\sqrt{x^{2}}$'], ['$\\int_0^1 x\\,dx$', '$\\frac{1}{2}$'], ['$\\sum_{i=1}^{n} i$', '$\\frac{n(n+1)}{2}$'], ['$e^{i\\pi}$', '$-1$']].map(([f, b], i) => ({ id: 'mt' + i, deckId: 'mt', front: f, back: b, tags: [], created: i })));
  });
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', 'mt');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']) await p.$eval(s, el => el.click());
  await p.click('#startBtn'); await p.waitForSelector('#options .opt');
  await p.waitForTimeout(400);
  const waiting = await p.evaluate(() => [...document.querySelectorAll('#options .tex')].map(e => ({ done: e.dataset.done || '', vis: getComputedStyle(e).visibility })));
  ok(waiting.length >= 3 && waiting.every(x => x.done !== '1' && x.vis === 'hidden'), 'Play: while KaTeX is still loading no option shows raw LaTeX (' + JSON.stringify(waiting.slice(0, 2)) + ')');
  release();
  await p.waitForFunction(() => document.querySelectorAll('#options .tex[data-done="1"] .katex').length >= 3, null, { timeout: 30000 });
  const shown = await p.evaluate(() => [...document.querySelectorAll('#options .tex')].every(e => getComputedStyle(e).visibility === 'visible'));
  ok(shown, 'Play: once KaTeX has loaded the options are drawn and shown');
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' / ') : ''));
await browser.close();
