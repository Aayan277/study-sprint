// UI audit round (v4.41 findings H1-H4, M1-M7): the Import save button says what it needs, the Clinical sidebar footer fits, the exam-cap line under
// Hard/Good/Easy, the finish screen's Continue button, dark-mode edges and selected chips, no glow on primary buttons, the Clinical Young segment,
// mouse-only hover (no sticky hover on touch screens), 44px taps on touch screens, and "Review · N" as the deck page's main button.
// Second round (M8-M12, L1-L9): Settings hierarchy, centred desktop columns, the calendar's cell size, the cloze tips, the practice test,
// plain answer-type wording, Today without repeats, the What's new card, Study ahead and the small fixes.
// Run with: node tests/browser/run.mjs uipolish
import fs from 'node:fs';
import { chromium, deckMenu } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const DAY = 86400000;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1440, height: 900 } };

const open = async (vp, { mode = 'dark', ui = 'original' } = {}) => {
  const ctx = await browser.newContext({ ...vp, deviceScaleFactor: 1, colorScheme: mode, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ([ui, mode]) => {
    const t = await import('./js/themes.js'); const db = await import('./js/db.js');
    await db.setSetting('theme', t.applyTheme({ ui, skin: 'violet', mode, oled: false })); await db.setSetting('whatsNewSeen', '999');
  }, [ui, mode]);
  if (ui === 'clinical') await p.waitForFunction(() => document.documentElement.getAttribute('data-ui') === 'clinical' && document.getElementById('clinicalCss')?.sheet);      // (its style sheet loads first)
  return p;
};
const go = async (p, hash, sel) => { await p.goto(URL + hash); await p.reload(); await p.waitForSelector(sel); };
const seedDecks = p => p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'B', name: 'Second', color: '#E5484D', created: now + 1 }, [1, 2, 3, 4].map(i => ({ id: 'b' + i, deckId: 'B', front: 'B front ' + i, back: 'B back ' + i, tags: [], created: i })));
  await db.addDeckWithCards({ id: 'C', name: 'Third', color: '#30A46C', created: now + 2 }, [{ id: 'c1', deckId: 'C', front: 'C front', back: 'C back', tags: [], created: 1 }]);
});
const pad = n => String(n).padStart(2, '0');
const inDays = n => { const d = new Date(Date.now() - 4 * 3600000 + n * DAY); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// Colour maths in the page: any CSS colour over a background → WCAG contrast.
const MATHS = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = c => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (t, b) => { const a = t[3] + b[3] * (1 - t[3]); return [0, 1, 2].map(i => (t[i] * t[3] + b[i] * b[3] * (1 - t[3])) / a).concat(a); };
  const lum = ([r, g2, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g2) + .0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const bgOf = e => { const layers = []; for (let a = e; a; a = a.parentElement) { const c = rgba(getComputedStyle(a).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= .99) break; } let bg = [0, 0, 0, 1]; for (const l of layers.reverse()) bg = over(l, bg); return bg; };
  const tok = (name, on) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;background:var(' + name + ')'; document.body.appendChild(d); const c = rgba(getComputedStyle(d).backgroundColor); d.remove(); return on ? over(c, on) : c; };
  return { rgba, over, ratio, bgOf, tok };
})()`;
const maths = (p, body) => p.evaluate(`(() => { const M = ${MATHS}; ${body} })()`);

// ---------- H1: the Import save button says what it needs (no hint above it to overlap the page) ----------
for (const ui of ['original', 'clinical']) {
  const p = await open(PHONE, { ui });
  await p.evaluate(() => sessionStorage.removeItem('study-sprint-import-draft'));
  await go(p, '#/import', '#pasteBox');
  await p.fill('#pasteBox', 'Photosynthesis - converts light into chemical energy\nStomata - pores on the leaf\nXylem - carries water up');
  await p.waitForFunction(() => /Name the deck/.test(document.querySelector('#saveBtn')?.textContent || ''));
  ok((await p.textContent('#saveBtn')).trim() === 'Name the deck to add 3 cards', `H1 (${ui}): an unnamed new deck: the button says "Name the deck to add 3 cards"`);
  ok(await p.locator('#saveHint, .save-hint').count() === 0, `H1 (${ui}): no hint line above the button to overlap the page`);
  await p.fill('#newName', 'Plants');
  ok((await p.textContent('#saveBtn')).trim() === 'Add 3 cards to “Plants”', `H1 (${ui}): named: Add 3 cards to “Plants”`);
  await p.context().close();
}

// ---------- H2: the Clinical sidebar footer is not cut off ----------
for (const ui of ['clinical', 'original']) {
  const p = await open(DESK, { ui });
  await go(p, '#/today', '.side-foot');
  const fit = await p.evaluate(() => { const foot = document.querySelector('.side-foot').getBoundingClientRect(); const bad = [...document.querySelectorAll('.side-tools > *')].filter(e => e.getBoundingClientRect().right > foot.right + .5 || e.getBoundingClientRect().left < foot.left - .5).map(e => e.id); return { bad, last: document.querySelector('#sideCollapse').getBoundingClientRect().right, foot: foot.right }; });
  ok(!fit.bad.length, `H2 (${ui}): every button in the sidebar footer is inside it (collapse button ends at ${Math.round(fit.last)}px, footer at ${Math.round(fit.foot)}px)`);
  if (ui === 'clinical') await p.screenshot({ path: SP + '/uipolish-sidebar-clinical.png', clip: { x: 0, y: 740, width: 260, height: 160 } });
  await p.context().close();
}

// ---------- H3: one quiet line when the exam's limit changed what Hard, Good and Easy show ----------
{
  const p = await open(PHONE);
  const setUp = (examDate, stability) => p.evaluate(async ([examDate, stability]) => {
    const db = await import('./js/db.js'); const D = 86400000, now = Date.now();
    const deck = await db.getDeck('sample'); await db.saveDeck({ ...deck, examDate });
    const st = (i, due, s, last) => ({ cardId: `sample-${i}`, due, stability: s, difficulty: 4, reps: 4, lapses: 0, state: 2, lastReview: last, elapsedDays: 5, scheduledDays: 30, learningSteps: 0 });
    await db.putStates([st(0, now - 3600000, stability, now - 10 * D), ...[1, 2, 3, 4].map(i => st(i, now + 80 * D, 900, now - D))]);
  }, [examDate, stability]);
  const answerSide = async () => { await go(p, '#/review/sample', '#startBtn, #flash'); if (await p.$('#startBtn')) await p.click('#startBtn'); await p.waitForSelector('#showBtn'); await p.click('#showBtn'); await p.waitForSelector('.rate'); };
  const ivls = () => p.$$eval('.rate span.mono', s => s.map(x => x.textContent));
  await setUp(inDays(10), 20);
  await answerSide();
  const iv = await ivls();
  ok(await p.locator('#rateNote').count() === 1 && /^Capped by your exam on /.test((await p.textContent('#rateNote')).trim()), 'H3: a card the exam cap moved: "' + (await p.textContent('#rateNote')).trim() + '"');
  ok(iv[1] === iv[2] && iv[2] === iv[3], 'H3: Hard, Good and Easy show the same gap, so the line is needed (' + iv.join(' / ') + ')');
  const shown = new Date(Date.now() - 4 * 3600000 + 10 * DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  ok((await p.textContent('#rateNote')).includes(shown), 'H3: the line names the exam day (' + shown + ')');
  await p.screenshot({ path: SP + '/uipolish-capped-line.png' });
  await setUp(inDays(120), 20);
  await answerSide();
  ok(await p.locator('#rateNote').count() === 0, 'H3: exam far away: the cap changed nothing, no line (' + (await ivls()).join(' / ') + ')');
  await setUp(null, 20);
  await answerSide();
  ok(await p.locator('#rateNote').count() === 0, 'H3: no exam: no line');
  await p.context().close();
}

// ---------- H4: after finishing a deck, other decks with cards due: "Continue · N cards" ----------
{
  const p = await open(PHONE);
  await seedDecks(p);
  await go(p, '#/review/C', '#startBtn, #flash'); if (await p.$('#startBtn')) await p.click('#startBtn');
  await p.waitForSelector('#showBtn'); await p.click('#showBtn'); await p.click('.rate.r4');
  await p.waitForSelector('.finish-next');
  const cont = (await p.textContent('#keepBtn')).trim();
  ok(/^Continue · \d+ cards$/.test(cont), 'H4: finished deck C with cards due elsewhere: "' + cont + '"');
  ok(await p.$eval('#keepBtn', b => b.classList.contains('primary')) && await p.$eval('#againBtn', b => b.classList.contains('ghost') && b.textContent.trim() === 'Back to Today'), 'H4: Continue is the primary button, Back to Today is the secondary one');
  ok((await p.getAttribute('#keepBtn', 'aria-label')) === 'Continue: ' + cont.match(/(\d+) cards/)[1] + ' cards', 'H4: its aria-label says how many cards');
  await p.screenshot({ path: SP + '/uipolish-finish-continue.png' });
  await p.click('#keepBtn'); await p.waitForSelector('#flash');
  const deckName = (await p.textContent('.flash-deck')).trim();
  ok(!deckName.includes('Third'), 'H4: Continue starts the cards from the other decks (' + deckName + ')');
  await p.context().close();
}
{
  const p = await open(PHONE);
  await p.evaluate(async () => { const db = await import('./js/db.js'); await db.deleteDeck('sample'); await db.addDeckWithCards({ id: 'C', name: 'Third', color: '#30A46C', created: Date.now() }, [{ id: 'c1', deckId: 'C', front: 'C front', back: 'C back', tags: [], created: 1 }]); });
  await go(p, '#/review/C', '#startBtn, #flash'); if (await p.$('#startBtn')) await p.click('#startBtn');
  await p.waitForSelector('#showBtn'); await p.click('#showBtn'); await p.click('.rate.r4');
  await p.waitForSelector('.finish-next');
  ok(await p.locator('#keepBtn').count() === 0 && await p.$eval('#againBtn', b => b.classList.contains('primary') && b.textContent.trim() === 'Back to Today'), 'H4: nothing due anywhere: Back to Today alone, as before');
  await p.context().close();
}

// H4: Today's choice is respected: with Today limited to deck C, finishing C does not offer decks Today leaves out
{
  const p = await open(PHONE);
  await seedDecks(p);
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewDecks', ['C']); });
  await go(p, '#/today', '#startBtn'); await p.click('#startBtn');
  await p.waitForSelector('#showBtn'); await p.click('#showBtn'); await p.click('.rate.r4');
  await p.waitForSelector('.finish-next');
  ok(await p.locator('#keepBtn').count() === 0 && await p.$eval('#againBtn', b => b.classList.contains('primary')), 'H4: Today limited to deck C, other decks due: no Continue (Today says all done), only Back to Today');
  await p.context().close();
}

// ---------- M1: state edges still win over the shared dark outline ----------
for (const ui of ['original', 'clinical']) {
  const p = await open(PHONE, { ui });
  await go(p, '#/deck/sample', '#deckMore');
  await p.click('#deckMore'); await p.waitForSelector('#deckMenu:not([hidden])');
  const r = await p.evaluate(() => {
    const px = v => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;color:var(' + v + ')'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    const more = getComputedStyle(document.querySelector('#deckMore')).borderTopColor;
    const host = document.createElement('div'); host.className = 'ys-exams'; host.innerHTML = '<button class="tchip on" type="button">x</button><button class="snd-btn playing" type="button">s</button><button class="occ-peek" aria-pressed="true" type="button">p</button>'; document.body.appendChild(host);
    const [on, playing, peek] = [...host.children].map(e => getComputedStyle(e).borderTopColor);
    host.remove();
    return { more, ctrl: px('--control'), accent: px('--accent'), on, playing, peek, accentLine: (() => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;border:1px solid var(--accent-line)'; document.body.appendChild(d); const c = getComputedStyle(d).borderTopColor; d.remove(); return c; })() };
  });
  ok(r.more === r.ctrl, `M1 (${ui}, dark): the expanded ⋯ button has the same --control edge as the closed one, not the dimmer --line-strong (${r.more})`);
  ok(r.on === r.accent, `M1 (${ui}, dark): ".tchip.on" keeps the accent edge (${r.on})`);
  ok(r.playing === r.accent, `M1 (${ui}, dark): a playing sound button keeps the accent edge`);
  ok(r.peek === r.accentLine, `M1 (${ui}, dark): a pressed occlusion peek button keeps its accent-line edge`);
  await p.context().close();
}
// ---------- M1b: the open ⋯ button and a hovered sound button have a 3:1 edge in dark, in both looks ----------
for (const ui of ['original', 'clinical']) {
  const p = await open(DESK, { ui });
  await go(p, '#/deck/sample', '#deckMore');
  const edgeOf = (sel) => maths(p, `const e = document.querySelector(${JSON.stringify(sel)}); const bg = M.bgOf(e.parentElement); return M.ratio(M.over(M.rgba(getComputedStyle(e).borderTopColor), bg), bg);`);
  const closed = await edgeOf('#deckMore');
  await p.click('#deckMore'); await p.waitForSelector('#deckMenu:not([hidden])'); await p.mouse.move(2, 2);
  const opened = await edgeOf('#deckMore');
  ok(closed >= 3 && opened >= 3 && opened >= closed - 0.01, `M1b (${ui}, dark): the open ⋯ button's edge is ${opened.toFixed(2)}:1, at least the closed one's (${closed.toFixed(2)}:1) and 3:1`);
  await p.evaluate(() => { const h = document.createElement('div'); h.style.cssText = 'position:fixed;left:300px;top:300px;padding:20px'; h.innerHTML = '<button class="snd-btn" id="sndProbe" type="button">s</button>'; document.querySelector('main').appendChild(h); });
  const rest = await edgeOf('#sndProbe');
  const restColor = await p.evaluate(() => getComputedStyle(document.querySelector('#sndProbe')).borderTopColor);
  await p.hover('#sndProbe');
  await p.waitForFunction(c => getComputedStyle(document.querySelector('#sndProbe')).borderTopColor !== c, restColor, { timeout: 5000 })
    .catch(() => { throw new Error(`M1b (${ui}): the hovered sound button's edge never changed from its resting colour ${restColor}`); });
  const hov = await edgeOf('#sndProbe');
  ok(rest >= 3 && hov >= 3 && hov > rest, `M1b (${ui}, dark): a hovered sound button's edge is ${hov.toFixed(2)}:1 (resting ${rest.toFixed(2)}:1), and stands out from the resting one`);
  await p.context().close();
}
{
  // a hovered ghost button keeps the 3:1 edge (it used to drop to the dimmer --line-strong), and a chip does not change width when selected
  const d = await open(DESK);
  await go(d, '#/deck/sample', '#testBtn');
  await d.hover('#testBtn');
  const hov = await maths(d, `const e = document.querySelector('#testBtn'); const outer = M.bgOf(e.parentElement); return M.ratio(M.over(M.rgba(getComputedStyle(e).borderTopColor), outer), outer);`);
  ok(hov >= 3, 'M1: a hovered ghost button keeps a 3:1 outline (' + hov.toFixed(2) + ')');
  await d.context().close();
  const p = await open(PHONE);
  await go(p, '#/today', '#optBtn'); await p.click('#optBtn'); await p.waitForSelector('#sheet[open] .tchip[aria-pressed="false"]');
  const w1 = await p.$eval('#sheet .tchip[aria-pressed="false"]', c => c.getBoundingClientRect().width);
  await p.tap('#sheet .tchip[aria-pressed="false"] >> nth=0');
  await p.waitForTimeout(300);
  const w2 = await p.evaluate(() => [...document.querySelectorAll('#sheet .tchip')].map(c => Math.round(c.getBoundingClientRect().width)));
  ok(w2.includes(Math.round(w1)), 'M3: a chip keeps its width when selected (the check mark sits in its padding): ' + Math.round(w1) + ' → ' + w2.slice(0, 4));
  await p.context().close();
}

// ---------- M5 (Original): the dark Young segment is 3:1 too ----------
for (const skin of ['violet', 'ocean', 'forest', 'ember', 'rose']) {
  const p = await open(PHONE);
  await p.evaluate(s => document.documentElement.setAttribute('data-skin', s), skin);
  const r = await maths(p, `const s1 = M.tok('--surface-1', M.tok('--bg')); return M.ratio(M.tok('--lv-young', s1), M.tok('--surface-3', s1));`);
  ok(r >= 3, `M5 (Original dark, ${skin}): Young against its track is ${r.toFixed(2)}:1`);
  await p.context().close();
}

// ---------- M7: the deck page's main button is "Review · N" when cards are due; Import is in the ⋯ menu ----------
for (const [vp, label] of [[PHONE, '390'], [{ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }, '320']]) {
  const p = await open(vp);
  await seedDecks(p);
  await p.evaluate(async d => { const db = await import('./js/db.js'); const deck = await db.getDeck('B'); await db.saveDeck({ ...deck, examDate: d }); }, inDays(9));
  await go(p, '#/deck/B', '#reviewBtn');
  ok((await p.textContent('#reviewBtn')).trim() === 'Review · 4' && await p.$eval('#reviewBtn', b => b.classList.contains('primary')), `M7 (${label}): cards due, exam within 14 days: "Review · 4" is the main button`);
  ok(await p.$eval('#prepBtn', b => b.classList.contains('ghost')) && await p.locator('.head-actions #prepBtn').count() === 1, `M7 (${label}): Exam prep is still there, as the second button`);
  ok(await p.locator('.head-actions a[href^="#/import"]').count() === 0, `M7 (${label}): no Import button in the header row`);
  const rows = await p.$$eval('.screen-head .head-actions > *:not(#reviewBtn)', els => [...new Set(els.map(e => Math.round(e.getBoundingClientRect().top)))].length);
  ok(rows === 1, `M7 (${label}): Exam prep, Practice test and the ⋯ button fit on one line`);
  const tall = await p.$eval('#testBtn', b => b.getBoundingClientRect().height);
  ok(tall <= 48, `M7 (${label}): "Practice test" is not wrapped onto two lines (${Math.round(tall)}px high)`);
  await p.screenshot({ path: SP + `/uipolish-deck-${label}.png` });
  await deckMenu(p);
  ok(await p.locator('#deckMenu #importHere').count() === 1 && (await p.textContent('#importHere')).includes('Import cards'), `M7 (${label}): "Import cards" is in the ⋯ menu`);
  await p.click('#importHere'); await p.waitForSelector('#pasteBox');
  ok(p.url().endsWith('#/import/B'), `M7 (${label}): it opens Import for this deck`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `M7 (${label}): no sideways scroll on the import page`);
  await go(p, '#/deck/B', '#reviewBtn');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `M7 (${label}): no sideways scroll on the deck page`);
  await p.context().close();
}
{
  // exam within 14 days but nothing due today: Exam prep is the main button, Review steps back (no number)
  const p = await open(PHONE); await seedDecks(p);
  await p.evaluate(async d => { const db = await import('./js/db.js'); const deck = await db.getDeck('C'); await db.saveDeck({ ...deck, examDate: d });
    await db.putStates([{ cardId: 'c1', due: Date.now() + 40 * 86400000, stability: 900, difficulty: 4, reps: 4, lapses: 0, state: 2, lastReview: Date.now() - 86400000, elapsedDays: 5, scheduledDays: 30, learningSteps: 0 }]); }, inDays(9));
  await go(p, '#/deck/C', '#reviewBtn');
  ok(await p.$eval('#prepBtn', b => b.classList.contains('primary')) && await p.$eval('#reviewBtn', b => b.classList.contains('ghost') && b.textContent.trim() === 'Review'), 'M7: exam soon but nothing due: Exam prep stays the main button and Review (no number) steps back');
  await p.context().close();
}
{
  // no exam, cards due: Review is main, Practice test beside the ⋯
  const p = await open(PHONE); await seedDecks(p); await go(p, '#/deck/B', '#reviewBtn');
  ok((await p.textContent('#reviewBtn')).trim() === 'Review · 4' && await p.$eval('#reviewBtn', b => b.classList.contains('primary')) && await p.locator('#prepBtn').count() === 0, 'M7: no exam: "Review · 4" is the main button');
  await p.context().close();
}

// ---------- M1, M3, M4: dark mode edges, selected chips, no glow ----------
for (const ui of ['original', 'clinical']) {
  const p = await open(PHONE, { ui });
  await go(p, '#/deck/sample', '#testBtn');
  const edges = await maths(p, `const out = {}; for (const [k, sel] of [['ghost', '#testBtn'], ['small', '#brTags'], ['more', '#deckMore'], ['input', '#brQuery']]) { const e = document.querySelector(sel); const outer = M.bgOf(e.parentElement); out[k] = M.ratio(M.over(M.rgba(getComputedStyle(e).borderTopColor), outer), outer); } return out;`);
  ok(Object.values(edges).every(r => r >= 3), `M1 (${ui}, dark): outlines of secondary buttons and inputs are 3:1 or more (${Object.entries(edges).map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ')})`);
  const lines = await maths(p, `const bg = M.tok('--bg'); const s1 = M.tok('--surface-1', bg); return { page: M.ratio(M.over(M.tok('--line'), bg), bg), card: M.ratio(M.over(M.tok('--line'), s1), s1) };`);
  ok(lines.page >= 1.3 && lines.card >= 1.3 && lines.card < 3, `M1 (${ui}, dark): dividers and card edges are clearly there but still quiet (${lines.page.toFixed(2)} on the page, ${lines.card.toFixed(2)} on a card)`);
  await go(p, '#/today', '#optBtn');
  const glow = await p.$eval('#startBtn', b => getComputedStyle(b).boxShadow);
  ok(glow === 'none' || glow.split(/,(?![^(]*\))/).every(s => /inset/.test(s)), `M4 (${ui}, dark): the main button has no glow (${glow})`);
  const txt = await maths(p, `const b = document.querySelector('#startBtn'); const bg = M.bgOf(b); return M.ratio(M.over(M.rgba(getComputedStyle(b).color), bg), bg);`);
  ok(txt >= 4.5, `M4 (${ui}, dark): its text is still 4.5:1 or more (${txt.toFixed(2)})`);
  await p.click('#optBtn'); await p.waitForSelector('#sheet[open] .tchip');
  const chips = await maths(p, `const all = [...document.querySelectorAll('#sheet .tchip')]; const on = all.find(c => c.getAttribute('aria-pressed') === 'true'), off = all.find(c => c.getAttribute('aria-pressed') === 'false'); const sheet = M.bgOf(off.parentElement);
    return { onFill: M.ratio(M.bgOf(on), sheet), offFill: M.ratio(M.bgOf(off), sheet), onCheck: getComputedStyle(on, '::after').content, offCheck: getComputedStyle(off, '::after').content, offEdge: M.ratio(M.over(M.rgba(getComputedStyle(off).borderTopColor), sheet), sheet) };`);
  ok(chips.onFill >= 1.35 && chips.onFill > chips.offFill + .25, `M3 (${ui}, dark): a selected chip has a clearly tinted fill (${chips.onFill.toFixed(2)} against ${chips.offFill.toFixed(2)} unselected)`);
  ok(chips.onCheck !== 'none' && chips.offCheck === 'none', `M3 (${ui}, dark): and a check mark; an unselected chip has none`);
  ok(chips.offEdge >= 3, `M1 (${ui}, dark): an unselected chip's outline is 3:1 or more (${chips.offEdge.toFixed(2)})`);
  await p.screenshot({ path: SP + `/uipolish-chips-${ui}.png` });
  await p.context().close();
  // light mode keeps its look: soft glow-free edge, the old tinted selection, still a check mark
  const l = await open(PHONE, { ui, mode: 'light' });
  await go(l, '#/deck/sample', '#testBtn');
  const lightEdge = await maths(l, `const e = document.querySelector('#testBtn'); return getComputedStyle(e).borderTopColor;`);
  ok(/rgba?\(11, 13, 18|rgb\(2[0-9]{2}/.test(lightEdge) || ui === 'clinical', `M1 (${ui}, light): the light-mode outline is unchanged (${lightEdge})`);
  await go(l, '#/today', '#optBtn'); await l.click('#optBtn'); await l.waitForSelector('#sheet[open] .tchip');
  const lc = await l.evaluate(() => { const on = document.querySelector('#sheet .tchip[aria-pressed="true"]'); return { check: getComputedStyle(on, '::after').content, bg: getComputedStyle(on).backgroundColor }; });
  ok(lc.check !== 'none', `M3 (${ui}, light): the check mark shows in light mode too (${lc.bg})`);
  await l.context().close();
}

// ---------- M5: the Clinical dark "Young" segment is 3:1 against its track ----------
for (const skin of ['violet', 'ocean', 'forest', 'ember', 'rose']) {
  const p = await open(PHONE, { ui: 'clinical' });
  await p.evaluate(s => document.documentElement.setAttribute('data-skin', s), skin);
  const r = await maths(p, `const s1 = M.tok('--surface-1', M.tok('--bg')); return M.ratio(M.tok('--lv-young', s1), M.tok('--surface-3', s1));`);
  ok(r >= 3, `M5 (Clinical dark, ${skin}): Young against its track is ${r.toFixed(2)}:1`);
  await p.context().close();
}

// ---------- M2: hover styles are for mice only ----------
{
  const p = await open(PHONE, { ui: 'clinical' });      // (Clinical on, so both style sheets are loaded)
  await p.waitForFunction(() => document.getElementById('clinicalCss')?.sheet);
  const bad = await p.evaluate(async () => {
    const out = [];
    const MICE = /hover:\s*hover/;
    const walk = (rules, inMice, file) => { for (const r of rules) {
      if (r.type === 1) { if (!inMice && /:hover/.test(r.selectorText)) out.push(file + ': ' + r.selectorText.slice(0, 80)); }
      else if (r.type === 4 || r.type === 12) walk(r.cssRules, inMice || (r.type === 4 && MICE.test(r.conditionText || r.media.mediaText) && /pointer:\s*fine/.test(r.conditionText || r.media.mediaText)), file);
    } };
    for (const s of document.styleSheets) { try { walk(s.cssRules, false, (s.href || '').split('/').pop()); } catch { out.push('unreadable ' + s.href); } }
    return out;
  });
  ok(!bad.length, 'M2: no :hover rule outside @media (hover:hover) and (pointer:fine)' + (bad.length ? ': ' + bad.slice(0, 5).join(' | ') : ''));
  await p.context().close();
  const t = await open(PHONE);
  await go(t, '#/today', '#optBtn'); await t.click('#optBtn'); await t.waitForSelector('#sheet[open] .tchip');
  const before = await t.$eval('#sheet .tchip[aria-pressed="false"]', c => getComputedStyle(c).borderTopColor);
  await t.tap('#sheet .tchip[aria-pressed="false"]');       // a tap selects it; tapping another one must not leave the first one "hovered"
  await t.tap('#sheet .tchip[aria-pressed="false"] >> nth=0');
  const hovered = await t.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches);
  ok(!hovered, 'M2: the touch screen reports no mouse hover (so the hover styles never apply)');
  await t.context().close();
  const d = await open(DESK);
  await go(d, '#/deck/sample', '#testBtn');
  const rest = await d.$eval('#testBtn', b => getComputedStyle(b).backgroundColor);
  await d.hover('#testBtn');
  const hov = await d.$eval('#testBtn', b => getComputedStyle(b).backgroundColor);
  ok(rest !== hov, 'M2: with a mouse, hover still shows (' + rest + ' → ' + hov + ')');
  await d.context().close();
}

// ---------- M6: touch screens get 44px buttons (40px editor toolbar); the desktop layout stays ----------
for (const [w, h] of [[390, 844], [320, 640]]) {
  const p = await open({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
  await go(p, '#/deck/sample', '#brAdd');
  const sizes = await p.evaluate(() => Object.fromEntries(['#brTags', '#brSelect', '#brAdd', '#back'].map(s => [s, Math.round(document.querySelector(s).getBoundingClientRect().height)])));
  ok(Object.values(sizes).every(v => v >= 44), `M6 (${w}px): Tools, Select, + Add card and ‹ Decks are 44px or more high (${JSON.stringify(sizes)})`);
  await go(p, '#/today', '#optBtn');
  ok(await p.$eval('#optBtn', b => b.getBoundingClientRect().height) >= 44, `M6 (${w}px): Options is 44px high`);
  await go(p, '#/deck/sample', '.crow'); await p.locator('.crow').first().click(); await p.waitForSelector('#ceForm .fmt-tools button');
  const tb = await p.$$eval('#ceForm .fmt-tools button', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  ok(tb.length >= 4 && tb.every(([bw, bh]) => bw >= 40 && bh >= 40), `M6 (${w}px): the editor toolbar buttons are 40x40 or more (${tb.slice(0, 3).map(x => x.join('x')).join(', ')} ...)`);
  ok(await p.evaluate(() => { const s = document.querySelector('#sheet'); return s.scrollWidth <= s.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; }), `M6 (${w}px): nothing overflows sideways with the editor open`);
  await p.screenshot({ path: SP + `/uipolish-editor-${w}.png` });
  await p.keyboard.press('Escape');
  for (const hash of ['#/today', '#/decks', '#/deck/sample', '#/import', '#/stats', '#/settings']) {
    await go(p, hash, 'main h1, main .screen-head');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `M6 (${w}px): no sideways scroll on ${hash}`);
  }
  await p.context().close();
}
{
  const d = await open(DESK);
  await go(d, '#/deck/sample', '#brTags');
  const h = await d.$eval('#brTags', b => b.getBoundingClientRect().height);
  ok(h < 44, 'M6: with a mouse the small buttons keep their size (Tools ' + Math.round(h) + 'px), the desktop layout is the same');
  await d.context().close();
}


// ================= Second round: M8-M12, L1-L9 =================
const DAYMS = 86400000;
const seedHistory = (p, long = false) => p.evaluate(async long => {
  const db = await import('./js/db.js'); const now = Date.now(), DAY = 86400000;
  await db.addDeckWithCards({ id: 'H', name: 'History', color: '#3E63DD', created: now - 30 * DAY }, Array.from({ length: 16 }, (_, i) => ({ id: 'h' + i, deckId: 'H', front: 'Front ' + i, back: 'Back ' + i, tags: ['t' + (i % 2)], created: now - 30 * DAY + i })));
  const logs = [], states = [];
  for (let i = 0; i < 16; i++) {
    for (let d = long ? (i === 0 ? 360 : 2) : 20; d >= 2; d -= (long ? 7 : 3)) logs.push({ cardId: 'h' + i, timestamp: now - d * DAY + i * 60000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true, reason: 'due' });
    states.push({ cardId: 'h' + i, due: now + (i + 8) * DAY, stability: 12, difficulty: 5, reps: 5, lapses: 0, state: 2, lastReview: now - 2 * DAY });
  }
  await db.putMany('cardStates', states); await db.putMany('reviewLog', logs);
}, long);

// ---------- M8: Settings: one row-title style (16px / 600) and real section headings (20px), in both styles ----------
for (const ui of ['original', 'clinical']) {
  const p = await open(PHONE, { ui });
  await go(p, '#/settings', '#exportBtn');
  const r = await p.evaluate(() => {
    const cs = e => { const x = getComputedStyle(e); return [parseFloat(x.fontSize), +x.fontWeight]; };
    const titles = [...document.querySelectorAll('main .set-row > div:first-child > b, main .switch-row > span:first-child > b, main .adv-row > b, main .adv-row > label > b, main .advanced > summary')];
    return { h2: [...document.querySelectorAll('.section > h2')].map(cs), titles: titles.map(e => cs(e).join('/')), n: titles.length };
  });
  ok(r.h2.length === 5 && r.h2.every(([f, w]) => f === 20 && w >= 600), `M8 (${ui}): the five section headings are 20px bold (${JSON.stringify(r.h2[0])})`);
  ok(r.n >= 30 && r.titles.every(t => t === '16/600'), `M8 (${ui}): all ${r.n} row titles are 16px / 600 (${[...new Set(r.titles)].join(', ')})`);
  await p.context().close();
}

// ---------- M9: desktop columns are centred, lists capped at 900px, the finish screen reads from one left edge ----------
for (const ui of ['original', 'clinical']) {
  const d = await open(DESK, { ui });
  await seedDecks(d);
  const gaps = async sel => d.evaluate(sel => { const m = document.querySelector('main').getBoundingClientRect(), v = document.querySelector(sel).getBoundingClientRect(); return [Math.round(v.left - m.left), Math.round(m.right - v.right), Math.round(v.width)]; }, sel);
  for (const [hash, wait, name] of [['#/settings', '#exportBtn', 'Settings'], ['#/import', '#pasteBox', 'Import'], ['#/play', '#startBtn', 'Play']]) {
    await go(d, hash, wait);
    const [l, r, w] = await gaps('main > .view');
    ok(Math.abs(l - r) <= 2 && w <= 1000 && l > 40, `M9 (${ui}): ${name} is a centred column (left ${l}px, right ${r}px, ${w}px wide)`);
  }
  await go(d, '#/browse', '.crow');
  { const [l, r, w] = await gaps('main > .view'); ok(Math.abs(l - r) <= 2 && w <= 900, `M9 (${ui}): Browse is centred and at most 900px wide (left ${l}, right ${r}, ${w}px)`); }
  await go(d, '#/deck/B', '.crow');
  { const w = await d.$eval('#browser', e => Math.round(e.getBoundingClientRect().width)); ok(w <= 900, `M9 (${ui}): the deck's card list is at most 900px wide (${w}px)`); }
  // what stays wide on purpose
  await go(d, '#/decks', '.deck'); { const [, , w] = await gaps('main > .view'); ok(w >= 1000, `M9 (${ui}): the Decks grid stays full width (${w}px)`); }
  await go(d, '#/stats', 'h1'); { const [, , w] = await gaps('main > .view'); ok(w >= 1000, `M9 (${ui}): Stats stays full width (${w}px)`); }
  await d.context().close();
}
{
  const d = await open(DESK);
  const css = await d.evaluate(async () => (await (await fetch('css/styles.css')).text()));
  ok(/\.fin-links\{[^}]*justify-content:flex-start/.test(css), 'M9: the finish screen\'s Decks · Undo row starts at the left edge like the rest of it');
  await d.context().close();
}

// ---------- M10: calendar cells fill the card (22px or more on touch), and "Tap a day" still works ----------
for (const [vp, label, min] of [[PHONE, 'phone', 22], [DESK, 'desktop', 14]]) {
  const p = await open(vp);
  await seedHistory(p);
  await go(p, '#/stats', '.cal-card');
  const c = await p.evaluate(() => { const i = document.querySelector('#calGrid i[data-t]'); const r = i.getBoundingClientRect(); const n = document.querySelectorAll('#calGrid .cal-m').length; return { w: Math.round(r.width), n, box: document.querySelector('#calScroll').clientWidth, grid: document.querySelector('#calGrid').scrollWidth }; });
  ok(c.w >= min && c.w <= 30, `M10 (${label}): calendar squares are ${c.w}px (at least ${min}px) for ${c.n} weeks`);
  ok(c.grid <= c.box + 2, `M10 (${label}): the ${c.n} weeks fit the card without sideways scrolling (${c.grid} of ${c.box}px)`);
  await p.locator('#calGrid i.lv1, #calGrid i.lv2, #calGrid i.lv3, #calGrid i.lv4').first().click();
  ok(/: \d+ answers?|: no studying/.test(await p.textContent('#calInfo')) && await p.locator('#calGrid i.sel').count() === 1, `M10 (${label}): tapping a day shows it (${(await p.textContent('#calInfo')).trim()})`);
  await p.context().close();
}

// A year of history on a phone: 53 weeks cannot fit at 22px, so the squares stay 22px and the weeks scroll (newest on the right)
{
  const p = await open(PHONE);
  await seedHistory(p, true);
  await go(p, '#/stats', '.cal-card');
  const c = await p.evaluate(() => { const b = document.querySelector('#calScroll'); return { w: Math.round(document.querySelector('#calGrid i[data-t]').getBoundingClientRect().width), n: document.querySelectorAll('#calGrid .cal-m').length, sc: b.scrollLeft, max: b.scrollWidth - b.clientWidth }; });
  ok(c.n >= 52 && c.w === 22, `M10 (phone, a year): ${c.n} weeks, squares ${c.w}px (22px on touch)`);
  ok(c.max > 0 && c.sc >= c.max - 2, `M10 (phone, a year): it opens scrolled to the newest weeks (${c.sc} of ${c.max})`);
  await p.context().close();
}

// ---------- M11: the cloze add-card sheet keeps one hint inline, the rest behind "More tips" ----------
for (const ui of ['original', 'clinical']) {
  const p = await open(PHONE, { ui });
  await go(p, '#/deck/sample', '#brAdd'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  await p.locator('.kind-switch .chip', { hasText: 'Cloze' }).click();
  ok(!(await p.locator('.more-tips, .cloze-help').count()), `M11 (${ui}): no "More tips" fold or long help in the form`);
  ok((await p.locator('#acCloze').innerText()).match(/select a word/gi)?.length === 1, `M11 (${ui}): the "select a word" hint appears once in the form`);
  await p.context().close();
}

// ---------- M12: Practice test: "Proposed answer", and Previous / Next pinned to the bottom on a phone ----------
{
  const p = await open(PHONE);
  await seedHistory(p);
  await go(p, '#/deck/H', '#testBtn'); await p.click('#testBtn'); await p.waitForSelector('#ptForm');
  for (const k of ['mc', 'typing']) if (await p.isChecked(`input[name=kind][value=${k}]`)) await p.locator(`.chip:has(input[name=kind][value=${k}])`).click();     // only true or false is left on
  await p.click('#ptStart'); await p.waitForSelector('#tPrompt');
  const claim = await p.evaluate(() => document.querySelector('.t-claim-l')?.textContent ?? null);
  ok(claim === 'Proposed answer', `M12: a true/false question labels the shown answer "Proposed answer" (${claim})`);
  await p.evaluate(() => document.activeElement?.blur?.());
  const b = await p.evaluate(() => { const r = document.querySelector('.t-step').getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), top: Math.round(r.top), h: innerHeight, pos: getComputedStyle(document.querySelector('.t-step')).position }; });
  ok(await p.evaluate(() => { const n = document.querySelector('#tNext').getBoundingClientRect(), u = document.querySelector('#tSubmit').getBoundingClientRect(); return n.top > u.bottom + 8; }), 'M12: on a phone Submit and the other tools sit above Next with a gap');
  ok(b.pos === 'sticky' && b.bottom <= 24, `M12: Previous / Next sit at the bottom of the phone screen (${b.bottom}px from the bottom edge)`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'M12: no sideways scroll in the practice test');
  await p.context().close();
}
ok(!/Answer given/.test(fs.readFileSync('js/mock-exam.js', 'utf8')), 'M12: "Answer given" is gone from the practice test');

// ---------- L1: the card editor's answer type has plain wording and one hint; the stored values are unchanged ----------
{
  const p = await open(PHONE);
  await go(p, '#/deck/sample', '#brAdd'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  const t = await p.textContent('.answer-mode');
  ok(/Plain text/.test(t) && /Step by step/.test(t) && /List of parts/.test(t) && !/Elements/.test(t), `L1: the choices read "Plain text", "Step by step", "List of parts" (${t.replace(/\s+/g, ' ').trim()})`);
  ok(!(await p.locator('.answer-hint').count()), 'L1: no hint line under the choices');
  const vals = await p.$$eval('.answer-mode input', is => is.map(i => i.value));
  ok(vals.join() === 'text,steps,elements', 'L1: the stored values are still text, steps, elements');
  await p.context().close();
}

// ---------- L2 / L4: Today says each thing once; the Options chips say "7 due · 3 new" ----------
for (const ui of ['original', 'clinical']) {
  const p = await open(DESK, { ui });
  await p.evaluate(async () => { const db = await import('./js/db.js'); const ex = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
    await db.addDeckWithCards({ id: 'X', name: 'Exam deck', color: '#E5484D', created: Date.now(), examDate: ex }, [1, 2, 3].map(i => ({ id: 'x' + i, deckId: 'X', front: 'f' + i, back: 'b' + i, tags: [], created: i }))); });
  await go(p, '#/today', '.today-hero');
  const txt = await p.locator('main').innerText();
  ok((txt.match(/Exam in \d+ days?/g) || []).length === 1, `L2 (${ui}): the exam countdown appears once on Today (${(txt.match(/Exam in \d+ days?/g) || []).length})`);
  ok(!/\d+ of \d+ done today/.test(txt), `L2 (${ui}): no "N of M done today" repeating the count`);
  await p.click('#optBtn'); await p.waitForSelector('#sheet[open]');
  const chip = (await p.locator('#deckChips .tchip[data-deck="X"]').innerText()).replace(/\s+/g, ' ');
  ok(/\d+ due · \d+ new/.test(chip), `L4 (${ui}): the Options chip reads "${chip.trim()}"`);
  await p.context().close();
}

// ---------- L6 / L8: one card count in Browse, swatches in two even rows ----------
{
  const p = await open(PHONE);
  await go(p, '#/decks', '.deck');
  await go(p, '#/browse', '.crow, .brow, #brCount');
  const head = await p.textContent('.br-head h2');
  ok(head.trim() === 'Cards' && /\d+ cards?/.test(await p.textContent('#brCount')), `L6: Browse says "Cards" once and the count once ("${head.trim()}" + "${(await p.textContent('#brCount')).trim()}")`);
  await go(p, '#/deck/sample', '#deckMore'); await p.click('#deckMore'); await p.click('#editDeck'); await p.waitForSelector('.swatches');
  const rows = await p.$$eval('.swatch', bs => [...new Set(bs.map(b => Math.round(b.getBoundingClientRect().top)))].length);
  const per = await p.$$eval('.swatch', bs => { const t = {}; bs.forEach(b => { const k = Math.round(b.getBoundingClientRect().top); t[k] = (t[k] || 0) + 1; }); return Object.values(t); });
  ok(rows === 2 && per.join() === '4,4', `L8: the 8 colour swatches are two rows of 4 at 390px (${per.join('+')})`);
  await p.context().close();
}

// ---------- L5: What's new: at most three lines, "See all", plain wording ----------
{
  const p = await open(PHONE);
  await p.evaluate(async () => (await import('./js/db.js')).setSetting('whatsNewSeen', '4.30'));
  await p.evaluate(() => { localStorage.removeItem('study-sprint-skip-whatsnew'); location.hash = '#/today'; }); await p.waitForSelector('.wn');      // (the test browser switches this card off; the app looks at that when Today draws, so no reload)
  const n = await p.locator('.wn li').count();
  ok(n >= 1 && n <= 3 && await p.isVisible('#wnAll'), `L5: the card shows ${n} line(s) (3 at most) and "See all"`);
  await p.click('#wnAll'); await p.waitForSelector('#sheet[open] .wn-list');
  ok(await p.locator('#sheet .wn-list li').count() >= n, 'L5: "See all" opens the full list');
  await p.context().close();
}

// ---------- L7: Suggest tags with nothing to suggest shows only Close ----------
{
  const p = await open(PHONE);
  await p.evaluate(async () => { const db = await import('./js/db.js'); const pairs = 'la cocina|kitchen,el dormitorio|bedroom,el baño|bathroom,la sala|living room,el comedor|dining room,el jardín|garden,el garaje|garage,la puerta|door,la ventana|window,el techo|roof,la pared|wall,la escalera|stairs'.split(',');
    await db.addDeckWithCards({ id: 'es', name: 'Spanish', color: '#3E63DD', created: Date.now() + 5 }, pairs.map((x, i) => ({ id: 'es' + i, deckId: 'es', front: x.split('|')[0], back: x.split('|')[1], created: i + 1 }))); });
  await go(p, '#/deck/es', '.crow'); await p.click('#deckMore'); await p.click('#autoTag');
  await p.waitForSelector('#atMsg', { timeout: 30000 });
  ok(!(await p.isVisible('#atAdd')) && (await p.textContent('#atCancel')).trim() === 'Close', 'L7: no "Add tags" button and the other button says Close');
  await p.context().close();
}

// ---------- L9: a deck with nothing due offers "Study ahead" ----------
{
  const p = await open(PHONE);
  await seedHistory(p);
  await go(p, '#/review/H', '.empty');
  const label = (await p.textContent('#aheadBtn')).trim();
  ok(/^Study ahead · \d+ cards?$/.test(label), `L9: a caught-up deck offers "${label}"`);
  await p.click('#aheadBtn'); await p.waitForSelector('#flash, #startBtn', { timeout: 10000 });
  const want = +/(\d+) card/.exec(label)[1];
  ok(await p.evaluate(() => location.hash.startsWith('#/review')) && await p.locator('#flash, #startBtn').count() > 0, 'L9: it starts a session of cards from this deck');
  const got = await p.evaluate(() => [...document.querySelectorAll('.rv-counts span')].reduce((a, e) => a + (+e.textContent || 0), 0));
  ok(got === want, `L9: the session has the ${want} cards the button promised (${got})`);
  await p.context().close();
}


// ---------- review fixes: desktop practice test spacing, the Clinical deck page's one width, finish and caught-up alignment ----------
{
  const d = await open(DESK);
  await seedHistory(d);
  await go(d, '#/deck/H', '#testBtn'); await d.click('#testBtn'); await d.waitForSelector('#ptForm'); await d.click('#ptStart'); await d.waitForSelector('#tPrompt');
  const g = await d.evaluate(() => { const n = document.querySelector('#tNext').getBoundingClientRect(), u = document.querySelector('#tSubmit').getBoundingClientRect(); const order = [...document.querySelectorAll('#tPrev,#tNext,#tFlag,#tSubmit')].map(e => e.id); return { gap: Math.round(u.top - n.bottom), order: order.join() }; });
  ok(g.gap >= 12 && g.order === 'tPrev,tNext,tFlag,tSubmit', `desktop practice test: Previous/Next come first (focus order ${g.order}) and Submit is ${g.gap}px below them`);
  await d.context().close();
}
for (const w of [1280, 1440, 1680]) {
  const d = await open({ viewport: { width: w, height: 900 } }, { ui: 'clinical' });
  await d.evaluate(async () => { const db = await import('./js/db.js'); const now = Date.now();
    await db.addDeckWithCards({ id: 'P', name: 'Parent', color: '#3E63DD', created: now }, []);
    await db.addDeckWithCards({ id: 'P1', name: 'Child', parentId: 'P', color: '#3E63DD', created: now + 1 }, [1, 2, 3].map(i => ({ id: 'p' + i, deckId: 'P1', front: 'f' + i, back: 'b' + i, tags: [], created: i }))); });
  await go(d, '#/deck/P', '.crow');
  const r = await d.evaluate(() => { const m = document.querySelector('main').getBoundingClientRect(); const box = e => { const r = e?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.right)] : null; };
    return { main: [Math.round(m.left), Math.round(m.right)], sub: box(document.querySelector('.subdecks-page')), list: box(document.querySelector('#browser')), view: box(document.querySelector('main > .view')) }; });
  ok(r.sub && r.list && r.sub[1] === r.list[1] && r.sub[0] === r.list[0], `Clinical deck page at ${w}px: Subdecks and Cards share one width (${r.sub}, ${r.list})`);
  ok(r.list[1] - r.list[0] <= 900 && r.view[1] - r.view[0] <= 1240, `Clinical deck page at ${w}px: the column is at most 900px (${r.list[1] - r.list[0]}px)`);
  const gl = r.view[0] - r.main[0], gr = r.main[1] - r.view[1];
  ok(Math.abs(gl - gr) <= 2, `Clinical deck page at ${w}px: it is centred (${gl}px / ${gr}px)`);
  await d.context().close();
}
{
  const p = await open(PHONE);
  await seedHistory(p);
  await go(p, '#/review/H', '.empty');
  const r = await p.evaluate(() => { const a = document.querySelector('#aheadBtn').getBoundingClientRect(), b = document.querySelector('.res-actions a.btn').getBoundingClientRect(), l = document.querySelector('.fin-links .link'); return { sameRow: Math.abs(a.top - b.top) < 2, link: l.tagName + ' ' + l.className, linkLeft: Math.round(l.getBoundingClientRect().left), btnLeft: Math.round(a.left) }; });
  ok(r.sameRow && /^A link/.test(r.link), `caught-up screen at 390px: Study ahead and Back to Today share a row and Open deck is a text link (${r.link})`);
  ok(r.linkLeft === r.btnLeft, `caught-up screen: "Open deck" starts where the button does (${r.linkLeft}px / ${r.btnLeft}px)`);
  await p.context().close();
}
{
  const p = await open({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  await seedHistory(p);
  await go(p, '#/review/H', '.empty');
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, right: Math.round(Math.max(...[...document.querySelectorAll('.res-actions .btn')].map(b => b.getBoundingClientRect().right))) }));
  ok(r.sw <= r.w && r.right <= r.w, `caught-up screen at 320px: no sideways scroll, the buttons fit (${r.sw}/${r.w}, right edge ${r.right})`);
  await p.context().close();
}

ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors[0] : ''));
await browser.close();
