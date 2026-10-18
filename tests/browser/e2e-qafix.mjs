// QA fixes (v4.34 testing round): unsaved work is not thrown away by Back / Close, the "You mix these up" rows and long deck names
// stay inside the screen (checked by every element's right edge: scrollWidth misses it on a phone), leaving Browse while typing,
// Q:/A: paste, the Retention helper's axis and "not enough data" note, and Play waiting for KaTeX before it shows an option.
// Run with: node tests/browser/run.mjs e2e-qafix
import fs from 'node:fs';
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
  const waiting = await p.evaluate(() => [...document.querySelectorAll('#options .tex')].map(e => ({ done: e.dataset.done || '', op: getComputedStyle(e).opacity })));
  ok(waiting.length >= 3 && waiting.every(x => x.done !== '1' && x.op === '0'), 'Play: while KaTeX is still loading no option shows raw LaTeX (' + JSON.stringify(waiting.slice(0, 2)) + ')');
  release();
  await p.waitForFunction(() => document.querySelectorAll('#options .tex[data-done="1"] .katex').length >= 3, null, { timeout: 30000 });
  const shown = await p.evaluate(() => [...document.querySelectorAll('#options .tex')].every(e => +getComputedStyle(e).opacity >= 0.7 && getComputedStyle(e).visibility === 'visible'));
  ok(shown, 'Play: once KaTeX has loaded the options are drawn and shown');
  await p.close();
}

// ---------- review fixes (second round) ----------
const startPlayOn = async (p, deck, fmt) => {
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', deck);
  for (const s of [`input[name=fmt][value=${fmt}]`, 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click()).catch(() => {});      // (Lightning has no length)
  await p.click('#startBtn'); await p.waitForSelector('#options .opt');
};
const answerRight = async (p, wrong = false) => {
  await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
  const prompt = (await p.textContent('#pPrompt')).trim();
  const idx = await p.evaluate(([pr, wrong]) => { const o = [...document.querySelectorAll('#options .lbl')].map(b => b.textContent); const r = o.indexOf('a' + pr.slice(1)); return wrong ? (r + 1) % o.length : r; }, [prompt, wrong]);
  await p.keyboard.press(String(idx + 1)); await p.waitForSelector('.fb');
};
const seedPlay = p => p.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'ia', name: 'Inert', color: '#46A758', created: Date.now() }, [1, 2, 3, 4, 5, 6].map(i => ({ id: 'ia' + i, deckId: 'ia', front: 'q' + i, back: 'a' + i, tags: [], created: i })));
});

// ---------- 10. "End this round?" makes the round inert ----------
for (const fmt of ['lightning', 'classic']) {
  const p = await open({ hash: '#/decks' });
  await seedPlay(p);
  await startPlayOn(p, 'ia', fmt);
  await answerRight(p);                                    // an answer, so Quit asks
  if (fmt === 'lightning') await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '');
  else { await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === ''); }
  await p.waitForTimeout(300);
  const secs = async () => { const m = (await p.textContent('#hudClock')).match(/(\d+):(\d+)/); return +m[1] * 60 + +m[2]; };
  const t0 = fmt === 'lightning' ? await secs() : 0;
  const prompt0 = await p.textContent('#pPrompt'), hud0 = (await p.textContent('#hudA')).replace(/Time [\d:]+/, ''), score0 = await p.textContent('#score');
  await p.click('#quitBtn'); await p.waitForSelector('#endAsk:not([hidden])');
  ok(await p.evaluate(() => ['pCard', 'options', 'pType', 'feedback'].every(id => document.getElementById(id).inert)), `End this round (${fmt}): the card, options, typing box and feedback are inert`);
  // (a programmatic click still reaches the handlers: they must refuse by themselves)
  await p.evaluate(() => { document.querySelector('#options .opt')?.click(); document.getElementById('skipBtn')?.click(); document.getElementById('pType')?.requestSubmit?.(); });
  await p.waitForTimeout(1600);
  const st = await p.evaluate(() => ({ fb: document.getElementById('feedback').innerHTML, prompt: document.getElementById('pPrompt').textContent }));
  ok(st.fb === '' && st.prompt === prompt0 && await p.textContent('#score') === score0, `End this round (${fmt}): an option click while asking does nothing`);
  await p.click('#endNo'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => ['pCard', 'options', 'pType', 'feedback'].every(id => !document.getElementById(id).inert)), `End this round (${fmt}): Keep playing makes it playable again`);
  if (fmt === 'lightning') {
    const t2 = await secs();
    ok(t0 - t2 <= 1 && t2 <= t0, `Lightning: the clock is unchanged after asking (${t0}s -> ${t2}s)`);
  }
  ok((await p.textContent('#hudA')).replace(/Time [\d:]+/, '') === hud0 && await p.textContent('#pPrompt') === prompt0, `End this round (${fmt}): same question and HUD after Keep playing`);
  if (fmt === 'classic') {
    await answerRight(p, true);                            // a wrong answer waits for Next
    await p.waitForSelector('#nextBtn');
    const q0 = (await p.textContent('#hudA')).replace(/\s+/g, ' '), pr1 = await p.textContent('#pPrompt');
    await p.click('#quitBtn'); await p.waitForSelector('#endAsk:not([hidden])');
    await p.evaluate(() => document.getElementById('nextBtn').click());
    await p.waitForTimeout(500);
    ok((await p.textContent('#hudA')).replace(/\s+/g, ' ') === q0 && await p.textContent('#pPrompt') === pr1, 'End this round: Next while asking does nothing (same question)');
    await p.click('#endNo'); await p.waitForTimeout(300);
    await p.click('#nextBtn'); await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '');
    ok(true, 'End this round: after Keep playing, Next works');
  }
  await p.close();
}

// ---------- 11. KaTeX that never arrives: the maths shows as typed text after a short wait ----------
{
  const KATEX = '**/katex@0.16.47/dist/katex.mjs';
  const p = await open({ route: [KATEX, () => { /* never answers */ }] });
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'mt', name: 'Maths', color: '#3E63DD', created: Date.now() },
      [['$\\frac{a}{b}$', '$\\sqrt{x^{2}}$'], ['$\\int_0^1 x\\,dx$', '$\\frac{1}{2}$'], ['$\\sum_{i=1}^{n} i$', '$\\frac{n(n+1)}{2}$'], ['$e^{i\\pi}$', '$-1$']].map(([f, b], i) => ({ id: 'mt' + i, deckId: 'mt', front: f, back: b, tags: [], created: i })));
  });
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', 'mt');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]']) await p.$eval(s, el => el.click());
  await p.click('#startBtn'); await p.waitForSelector('#options .opt');
  await p.waitForTimeout(500);
  const early = await p.evaluate(() => ({ bar: document.getElementById('pTimer').style.transform, op: [...document.querySelectorAll('#options .tex')].map(e => getComputedStyle(e).opacity) }));
  ok(early.bar === '' && early.op.every(o => o === '0'), 'KaTeX stalled: at first the question clock has not started and the options wait (' + JSON.stringify(early) + ')');
  await p.waitForTimeout(1800);
  const late = await p.evaluate(() => ({
    bar: document.getElementById('pTimer').style.transform,
    tex: [...document.querySelectorAll('#pPrompt .tex, #options .tex')].map(e => ({ done: e.dataset.done, raw: e.classList.contains('tex-raw'), op: +getComputedStyle(e).opacity, vis: getComputedStyle(e).visibility })),
    names: [...document.querySelectorAll('#options .opt')].map(b => b.textContent.replace(/^\s*\d/, '').trim())
  }));
  ok(late.tex.length >= 4 && late.tex.every(t => t.done === 'raw' && t.raw && t.op >= 0.7 && t.vis === 'visible'), 'KaTeX stalled: after the wait the prompt and options show as typed text, visible (' + JSON.stringify(late.tex.slice(0, 2)) + ')');
  ok(late.names.every(n => n.length > 2), 'KaTeX stalled: each option has readable text, not just its number (' + JSON.stringify(late.names) + ')');
  ok(late.bar !== '', 'KaTeX stalled: the question clock starts once the wait is over');
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await p.waitForTimeout(150);
  const retry = await p.evaluate(() => [...document.querySelectorAll('#pPrompt .tex, #options .tex')].map(e => +getComputedStyle(e).opacity));
  ok(retry.length >= 4 && retry.every(o => o >= 0.7), 'KaTeX stalled: the "online" retry keeps the typed formulas visible while it tries (' + retry.join(',') + ')');
  await p.close();
}

// ---------- 12. the side panel asks before it loses edits (1440px) ----------
{
  const p = await open({ w: 1440, h: 900, rail: '1' });
  await p.evaluate(async () => {
    const db = await import('./js/db.js'), { reverseOf } = await import('./js/reverse.js');
    const now = Date.now(), f = { id: 'g0', deckId: 'g', noteId: 'gn', front: 'Mitosis', back: 'Division', tags: [], created: 1, noteEditedAt: now };
    await db.addDeckWithCards({ id: 'g', name: 'Guard', color: '#3E63DD', created: now }, [f, { ...reverseOf(f, 'g0r'), noteEditedAt: now },
      { id: 'g1', deckId: 'g', front: 'Alpha', back: 'First', tags: [], created: 3 }, { id: 'g2', deckId: 'g', front: 'Beta', back: 'Second', tags: [], created: 4 }]);
  });
  await p.evaluate(() => { location.hash = '#/deck/g'; }); await p.waitForSelector('.crow'); await p.waitForTimeout(400);
  const row = t => p.locator('.crow', { hasText: t }).first();
  const ceFront = () => p.evaluate(() => document.getElementById('ceFront')?.textContent.trim());
  const openAndType = async (t, add) => { await row(t).click(); await p.waitForFunction(x => document.getElementById('ceFront')?.textContent.trim() === x, t); await p.click('#ceFront'); await p.keyboard.press('End'); await p.keyboard.type(add); await p.waitForTimeout(150); };
  await openAndType('Alpha', ' edited');
  await row('Beta').click(); await p.waitForTimeout(400);
  ok(await asking(p) && (await ceFront()) === 'Alpha edited', 'panel: clicking another row with unsaved edits asks "Discard changes?" and keeps the edits');
  await p.click('#discardKeep'); await p.waitForTimeout(150);
  ok(await asking(p) === false && (await ceFront()) === 'Alpha edited', 'panel: Keep editing leaves the panel as it was');
  await row('Beta').click(); await p.click('#discardYes');
  await p.waitForFunction(() => document.getElementById('ceFront')?.textContent.trim() === 'Beta');
  ok(true, 'panel: Discard then opens the other card');
  await p.click('#ceFront'); await p.keyboard.press('End'); await p.keyboard.type(' x'); await p.waitForTimeout(150);
  await p.click('[data-flag="1"]'); await p.waitForTimeout(400);
  const flagged = () => p.evaluate(async () => (await (await import('./js/db.js')).get('cards', 'g2')).flag || 0);
  ok(await asking(p) && await flagged() === 0, 'panel: a flag with unsaved edits asks first and has not changed anything yet');
  await p.click('#discardYes');
  await p.waitForFunction(async () => ((await (await import('./js/db.js')).get('cards', 'g2')).flag || 0) === 1);
  await p.waitForFunction(() => document.getElementById('ceFront')?.textContent.trim() === 'Beta');
  ok(true, 'panel: after Discard the flag is set and the card shows its saved text');
  // suspend, the same way
  await p.click('#ceFront'); await p.keyboard.press('End'); await p.keyboard.type(' y'); await p.waitForTimeout(150);
  await p.click('#sheet [data-act=suspend]'); await p.waitForTimeout(300);
  ok(await asking(p), 'panel: Suspend with unsaved edits asks first');
  await p.click('#discardKeep');
  // "Open the other direction"
  await p.click('.sheet-x'); await p.waitForTimeout(200); if (await asking(p)) await p.click('#discardYes');
  await openAndType('Mitosis', ' z');
  await p.click('#revOpen'); await p.waitForTimeout(300);
  ok(await asking(p) && (await ceFront()) === 'Mitosis z', 'panel: "Open the other direction" with unsaved edits asks first');
  await p.click('#discardYes');
  await p.waitForFunction(() => document.getElementById('ceFront')?.textContent.trim() === 'Division');
  ok(true, 'panel: Discard opens the other direction');
  // changing screen: the edits are kept and come back when the card is opened again
  await p.click('#ceFront'); await p.keyboard.press('End'); await p.keyboard.type(' keep');
  await p.waitForTimeout(150);
  await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForTimeout(800);
  ok(!(await sheetOpen(p)), 'panel: changing screen closes the panel');
  await p.evaluate(() => { location.hash = '#/deck/g'; }); await p.waitForSelector('.crow'); await p.waitForTimeout(400);
  await row('Mitosis').click(); await p.waitForFunction(() => document.getElementById('ceFront')?.textContent.trim() === 'Mitosis');
  ok(!(await asking(p)), 'panel: opening a card right after the screen change does not ask');
  await p.click('#revOpen'); await p.waitForFunction(() => document.getElementById('ceFront')?.textContent.trim().startsWith('Division')); await p.waitForTimeout(400);
  ok((await ceFront()) === 'Division keep', 'panel: the unsaved edits are back when the card is opened again');
  await p.click('.sheet-x'); await p.waitForTimeout(300);
  ok(await asking(p), 'panel: and they still count as unsaved (Close asks)');
  await p.close();
}

// ---------- 13. image occlusion: moving or adding a box counts as an edit ----------
{
  const p = await open({ w: 1440, h: 900, rail: '1' });
  await p.evaluate(async () => {
    const db = await import('./js/db.js'), media = await import('./js/media.js');
    const cv = document.createElement('canvas'); cv.width = 80; cv.height = 60; const g = cv.getContext('2d'); g.fillStyle = '#39c'; g.fillRect(0, 0, 80, 60);
    const mid = await media.saveImage('image/png', await (await new Promise(r => cv.toBlob(r, 'image/png'))).arrayBuffer());
    const masks = [{ id: 'm1', n: 1, shape: 'rect', x: .25, y: .25, w: .4, h: .4 }, { id: 'm2', n: 2, shape: 'rect', x: .1, y: .1, w: .1, h: .1 }];
    await db.addDeckWithCards({ id: 'oc', name: 'Picture', color: '#3E63DD', created: Date.now() }, [{ id: 'oc1', deckId: 'oc', noteId: 'ocn', front: 'Diagram: hidden part 1 of 2', back: 'x', backImage: mid, tags: [], created: 1, occlusion: { n: 1, w: 80, h: 60, masks } }]);
  });
  await p.evaluate(() => { location.hash = '#/deck/oc'; }); await p.waitForSelector('.crow'); await p.waitForTimeout(300);
  const openIt = async () => { await p.locator('.crow').first().click(); await p.waitForSelector('#ceOccEdit'); await p.waitForTimeout(200); };
  const change = fn => p.evaluate(async fn => { const ce = await import('./js/card-editor.js'); const n = ce.readOcclusion('ce'); const masks = (0, eval)('(' + fn + ')')(n.masks); ce.setOcclusion('ce', { masks, image: n.image, w: n.w, h: n.h }); }, fn.toString());
  await openIt();
  await p.click('.sheet-x'); await p.waitForTimeout(300);
  ok(!(await sheetOpen(p)), 'occlusion: closing an untouched picture does not ask');
  await openIt();
  await change(m => m.map(b => (b.id === 'm1' ? { ...b, x: b.x + 0.1 } : b)));
  await p.click('.sheet-x'); await p.waitForTimeout(300);
  ok(await sheetOpen(p) && await asking(p), 'occlusion: moving a box makes Close ask "Discard changes?"');
  await p.click('#discardYes'); await p.waitForTimeout(300);
  await openIt();
  await change(m => [...m, { id: 'm9', n: 3, shape: 'rect', x: .5, y: .5, w: .1, h: .1 }]);
  await p.click('.sheet-x'); await p.waitForTimeout(300);
  ok(await sheetOpen(p) && await asking(p), 'occlusion: adding a box makes Close ask too');
  await p.click('#discardYes'); await p.waitForTimeout(300);
  await p.close();
}

// ---------- 14. cloze cards in a spreadsheet: one row each, deleted blanks stay deleted ----------
{
  const p = await open({ hash: '#/decks' });
  await p.evaluate(async () => {
    const db = await import('./js/db.js'), { clozeCard } = await import('./js/cloze.js');
    const text = 'The {{c1::heart}} has {{c2::four}} chambers and {{c3::two}} sides', now = Date.now();
    const mk = n => ({ id: 'cz' + n, deckId: 'cz', noteId: 'czn', noteText: text, noteExtra: 'Extra, line', cloze: n, ...clozeCard(text, n), tags: ['bio'], created: n });
    await db.addDeckWithCards({ id: 'cz', name: 'Cloze out', color: '#3E63DD', created: now }, [mk(1), mk(3), { id: 'czp', deckId: 'cz', front: 'plain', back: 'card', tags: [], created: 5 }]);
  });
  await p.evaluate(() => { location.hash = '#/deck/cz'; }); await p.waitForSelector('.crow');
  await p.click('#deckMore'); await p.click('#exportDeck'); await p.waitForSelector('#exCsv');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exCsv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  const lines = csv.trim().split('\r\n');
  ok(lines.length === 4 && /Cloze note/.test(lines[0]) && !/two chambers|\{\{c2/.test(csv.replace(/\{\{c2::four\}\}/g, '')), 'CSV: a row per card that exists (header + 3), with a Cloze note column (' + lines.length + ' lines)');
  ok(lines.some(l => l.startsWith('The […] has four chambers and two sides,heart,')) && lines.some(l => l.startsWith('The heart has four chambers and […] sides,two,')), 'CSV: each cloze card has a readable front and back');
  await p.waitForFunction(() => /Exported 3 rows/.test(document.getElementById('toast')?.textContent || ''));
  ok(true, 'CSV: the toast count matches the rows written');
  // round trip through the Import screen
  await p.evaluate(() => { location.hash = '#/import'; }); await p.waitForSelector('#pasteBox');
  await p.fill('#pasteBox', csv); await p.waitForSelector('#preview:not([hidden])');
  const found = await p.textContent('#found'), note = await p.textContent('#screen');
  ok(/Found 3 cards/.test(found) && /1 cloze note/.test(note), 'CSV import: three cards, one of them a cloze note (' + found.trim() + ')');
  await p.fill('#newName', 'Back again'); await p.click('#saveBtn'); await p.waitForTimeout(1500);
  const got = await p.evaluate(async () => { const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === 'Back again'); return (await db.getAll('cards')).filter(c => c.deckId === d.id).map(c => ({ n: c.cloze, note: c.noteId, text: c.noteText, extra: c.noteExtra })); });
  const cl = got.filter(c => c.n);
  ok(cl.length === 2 && cl[0].note === cl[1].note && cl.map(c => c.n).sort().join() === '1,3' && cl[0].extra === 'Extra, line' && got.length === 3, 'CSV import: the same two cloze cards of one note (no deleted blank 2), extra line kept ' + JSON.stringify(cl.map(c => c.n)));
  await p.close();
}

// ---------- 15. Import draft keeps how the text is read ----------
{
  const p = await open({ hash: '#/import' });
  await p.waitForSelector('#pasteBox');
  await p.fill('#pasteBox', 'The {{c1::heart}} pumps blood\nThe {{c1::lung}} takes in air'); await p.waitForSelector('#preview:not([hidden])');
  await p.click('#clozeToggle'); await p.waitForTimeout(300);
  ok(/Turn/.test(await p.textContent('#clozeToggle')), 'Import: "Keep as plain cards" pressed');
  await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck');
  await p.evaluate(() => { location.hash = '#/import'; }); await p.waitForSelector('#pasteBox'); await p.waitForTimeout(700);
  ok(/Turn/.test(await p.textContent('#clozeToggle')) && await p.locator('.prow').count() === 1, 'Import: the draft comes back read the same way (plain cards)');
  const stored = await p.evaluate(() => JSON.parse(sessionStorage.getItem('study-sprint-import-draft')));
  ok(stored && stored.noCloze === true && typeof stored.text === 'string' && 'blocks' in stored && 'aiMade' in stored, 'Import: the draft holds text, blocks, aiMade and noCloze');
  await p.close();
}

// ---------- 16. Retention helper counts only usable, in-scope reviews ----------
{
  const p = await open({ hash: '#/decks' });
  const n = await p.evaluate(async () => {
    const db = await import('./js/db.js'), { gatherInput } = await import('./js/retention-sheet.js');
    const now = Date.now(), DAY = 86400000;
    const mk = (id, deckId) => ({ id, deckId, front: id, back: id, tags: [], created: 1 });
    await db.addDeckWithCards({ id: 'ra', name: 'A', color: '#3E63DD', created: now }, [mk('ra1', 'ra')]);
    await db.addDeckWithCards({ id: 'rb', name: 'B', color: '#3E63DD', created: now }, [mk('rb1', 'rb')]);
    await db.putStates([{ cardId: 'ra1', due: now + DAY, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - DAY }, { cardId: 'rb1', due: now + DAY, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - DAY }]);
    const row = (cardId, source, i) => ({ cardId, timestamp: now - i * 1000, source, rating: 3, correct: true, state: 2 });
    const before = (await gatherInput({ deckId: 'ra' })).info.reviews;
    await db.putMany('reviewLog', [...[1, 2, 3].map(i => row('ra1', 'review', i)), ...[4, 5].map(i => row('ra1', 'play', i)), ...[6, 7, 8, 9].map(i => row('rb1', 'review', i))]);
    return { before, deckA: (await gatherInput({ deckId: 'ra' })).info.reviews, deckB: (await gatherInput({ deckId: 'rb' })).info.reviews };
  });
  ok(n.deckA - n.before === 3 && n.deckB >= 4, `Retention: one deck's helper counts only its own non-Play reviews (A +${n.deckA - n.before} of 3 review + 2 Play + 4 in B)`);
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' / ') : ''));
await browser.close();
