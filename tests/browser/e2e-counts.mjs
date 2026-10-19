// Round 2 A2 "Due" numbers + A4 desktop deck page + A6 pieces owned by decks.js / today.js (docs/design/round2-plan.md).
//   - one number for "due" everywhere: Today, the sidebar, the Decks tile, the deck page and Review's own counts
//   - subdecks + own cards = the parent; what a daily limit / the one-card-per-note rule holds back is said on the deck page
//   - 1440 with the sidebar open: the deck-tree column is hidden and the list is wide; with the icon rail it comes back, with due numbers
//   - an empty deck offers + Add cards; the % ring says "mastered"; the empty Decks screen is the shared start block
//   - Today has no "N answers today" line and no "~1 min" on rows; the exam chips scroll sideways instead of wrapping
//   - the deck page's header: Exam prep is the main button within 14 days, Edit / Add subdeck / Export live in a ⋯ menu
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const open = async (width, height, scheme = 'dark') => {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', colorScheme: scheme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.stack));
  return { ctx, p };
};
const go = async (p, hash, sel) => { await p.goto('about:blank'); await p.goto('http://localhost:8123/' + hash); await p.waitForSelector(sel); };
const noHScroll = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + what);
const num = async (p, sel) => +(await p.locator(sel).first().textContent()).trim();

// Bio (top) with 3 due + 2 new of its own; Unit 1 (4 due, 3 new); Unit 2 (2 due); Unit 3 (1 new). Chem (top): 6 due.
const seed = p => p.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.deleteDeck('sample');
  const D = 86400000, now = Date.now();
  const decks = [
    { id: 'Bio', name: 'Biology', course: 'BIOL 201', color: '#46A758', parentId: '', created: now - 9000 },
    { id: 'U1', name: 'Unit 1', course: '', color: '#46A758', parentId: 'Bio', created: now - 8000 },
    { id: 'U2', name: 'Unit 2', course: '', color: '#46A758', parentId: 'Bio', created: now - 7000 },
    { id: 'U3', name: 'Unit 3', course: '', color: '#46A758', parentId: 'Bio', created: now - 6000 },
    { id: 'Chem', name: 'Chemistry', course: '', color: '#3E63DD', parentId: '', created: now - 5000 }
  ];
  for (const d of decks) await db.saveDeck(d);
  const cards = [], states = [];
  let n = 0;
  const add = (deckId, due, extra = {}) => {
    const id = `c${n++}`;
    cards.push({ id, deckId, front: `Q ${id}`, back: `A ${id}`, created: now - 100000 + n, ...extra });
    if (due) states.push({ cardId: id, due: now - D - n * 1000, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 6 * D, elapsedDays: 6, scheduledDays: 5, learningSteps: 0 });
  };
  for (let i = 0; i < 3; i++) add('Bio', true);
  for (let i = 0; i < 2; i++) add('Bio', false);
  for (let i = 0; i < 4; i++) add('U1', true);
  for (let i = 0; i < 3; i++) add('U1', false);
  for (let i = 0; i < 2; i++) add('U2', true);
  add('U3', false);
  for (let i = 0; i < 6; i++) add('Chem', true);
  await db.saveCards(cards); await db.putStates(states);
});
const setDeck = (p, id, patch) => p.evaluate(async ([id, patch]) => { const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.id === id); await db.saveDeck({ ...d, ...patch }); }, [id, patch]);

// ======================= 1440, sidebar open: the numbers agree =======================
let { ctx, p } = await open(1440, 900);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await seed(p);

await go(p, '#/today', '.tdeck');
const todayBio = await num(p, '.tdeck[data-start="Bio"] .due b');
const sideBio = await num(p, '.side-deck[data-key="Bio"] .side-due');
await go(p, '#/decks', '.deck');
const tileBio = await num(p, '.deck:has-text("Biology") > .deck-open .due b');
await go(p, '#/deck/Bio', '.deck-summary');
const pageBio = await num(p, '.deck-summary .due b');
ok([todayBio, sideBio, tileBio, pageBio].every(x => x === 9), `Biology is 9 due on Today, the sidebar, the Decks tile and its page: ${todayBio}/${sideBio}/${tileBio}/${pageBio}`);
const summary = (await p.textContent('.deck-summary')).replace(/\s+/g, ' ');
ok(/9 due today/.test(summary) && /6 new today/.test(summary) && /15 cards/.test(summary), 'the deck page reads "9 due today · 6 new today · 15 cards": ' + summary.slice(0, 80));
ok(!(await p.isVisible('.held-note')), 'nothing is held back, so no "wait until tomorrow" line');
const kidDue = await p.$$eval('.subdecks-page .subdeck', rows => rows.map(r => [r.querySelector('.sd-name').textContent, +r.querySelector('.due b').textContent, +r.querySelectorAll('.sd-counts b')[1].textContent]));
ok(JSON.stringify(kidDue) === JSON.stringify([['Unit 1', 4, 3], ['Unit 2', 2, 0], ['Unit 3', 0, 1]]), 'subdeck rows: ' + JSON.stringify(kidDue));
ok(kidDue.reduce((n, r) => n + r[1], 0) + 3 === pageBio, 'subdecks + the 3 of its own = the parent');
ok(!(await p.isVisible('.subdecks-page .note:has-text("shared")')), 'no shared-limit note when the numbers add up');

// Review's own counts add up to the same number
await go(p, '#/review/Bio', '.rv-counts');
const rv = await p.$$eval('.rv-counts span', s => s.map(x => +x.textContent));
ok(rv.reduce((a, b) => a + b, 0) === 15, 'Review for Biology has 15 cards (9 due + 6 new): ' + rv.join('+'));
// Today's total and the sidebar's badge
await go(p, '#/today', '.today-hero');
ok(await num(p, '[data-count=due]') === 15 && await num(p, '[data-count=new]') === 6, 'Today: 15 due, 6 new across both courses');
ok(!/answers? today/.test(await p.textContent('.today-hero')), 'Today has no "N answers today" line (the ring already counts them)');
ok(await p.locator('.td-min').count() === 0, 'course rows have no "~1 min" repeat');
ok(/min/.test(await p.textContent('#startBtn')), 'the Start button still gives the time');

// ======================= daily limit and shared limits =======================
await setDeck(p, 'Bio', { reviewPerDay: 5 });
await setDeck(p, 'Chem', { reviewPerDay: 4 });
await go(p, '#/today', '.tdeck');
const t2 = [await num(p, '.tdeck[data-start="Bio"] .due b'), await num(p, '.tdeck[data-start="Chem"] .due b'), await num(p, '[data-count=due]')];
ok(JSON.stringify(t2) === '[5,4,9]', 'with a limit of 5 and 4 the numbers are 5, 4 and 9 in all: ' + t2);
await go(p, '#/deck/Chem', '.deck-summary');
ok(await num(p, '.deck-summary .due b') === 4, 'Chemistry page: 4 due');
const held = (await p.textContent('.held-note')).replace(/\s+/g, ' ');
ok(/2 wait until tomorrow/.test(held) && /daily limit/.test(held), 'it says what waits: ' + held);
await go(p, '#/deck/Bio', '.deck-summary');
ok(await num(p, '.deck-summary .due b') === 5, 'Biology page: 5 due');
ok(/4 wait until tomorrow/.test(await p.textContent('.held-note')), 'Biology: 4 wait until tomorrow');
const shared = (await p.textContent('.subdecks-page .note')).replace(/\s+/g, ' ');
ok(/Daily limits are shared/.test(shared) && /Biology's 5 due/.test(shared), 'the shared-limit note: ' + shared);
await go(p, '#/decks', '.deck');
ok(await num(p, '.deck:has-text("Biology") > .deck-open .due b') === 5, 'the Decks tile says 5 too');
await setDeck(p, 'Bio', { reviewPerDay: null }); await setDeck(p, 'Chem', { reviewPerDay: null });

// cloze siblings wait: one card per note a day
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const D = 86400000, now = Date.now();
  const cs = [1, 2, 3].map(k => ({ id: 'z' + k, deckId: 'U2', front: `{{c${k}::x}} note`, back: '', noteId: 'N1', cloze: k, created: now + k }));
  await db.saveCards(cs);
  await db.putStates(cs.map(c => ({ cardId: c.id, due: now - D, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 6 * D, elapsedDays: 6, scheduledDays: 5, learningSteps: 0 })));
});
await go(p, '#/deck/U2', '.deck-summary');
ok(await num(p, '.deck-summary .due b') === 3, 'Unit 2: its 2 cards and one cloze card are due');
const held2 = (await p.textContent('.held-note')).replace(/\s+/g, ' ');
ok(/2 wait until tomorrow/.test(held2) && /one card per note a day/.test(held2), 'the other two cloze cards wait: ' + held2);

// ======================= A4: the deck tree column =======================
await go(p, '#/deck/Bio', '.crow');
const view = await p.evaluate(() => { const r = document.querySelector('.crows').getBoundingClientRect(); return { x: r.x, w: r.width }; });
ok(!(await p.isVisible('.deck-tree')), 'sidebar open: the deck-tree column is hidden');
ok(view.w > 800, 'and the card list is wide: ' + Math.round(view.w) + 'px');
ok(await p.locator('.dock-empty').count() === 0, 'no empty editor placeholder');
const mainOpen = await p.evaluate(() => document.querySelector('main').getBoundingClientRect().width);
await p.screenshot({ path: SP + '/c-deck-1440-open.png' });
await p.locator('.crow').first().click(); await p.waitForSelector('#ceForm'); await p.waitForTimeout(350);
const mainDock = await p.evaluate(() => document.querySelector('main').getBoundingClientRect().width);
ok(await p.evaluate(() => document.body.classList.contains('has-side')) && mainDock < mainOpen - 300, `picking a card opens the panel and the page narrows (${Math.round(mainOpen)} → ${Math.round(mainDock)})`);
await p.screenshot({ path: SP + '/c-deck-1440-docked.png' });
await p.keyboard.press('Escape'); await p.waitForTimeout(350);
ok(!(await p.evaluate(() => document.body.classList.contains('has-side'))) && Math.abs((await p.evaluate(() => document.querySelector('main').getBoundingClientRect().width)) - mainOpen) < 2, 'Escape gives the width back');
// the icon rail brings the tree back, with the due count in it
await p.click('#sideCollapse'); await p.waitForTimeout(200);
ok(await p.isVisible('.deck-tree') && Math.round((await p.locator('.deck-tree').boundingBox()).x) === 72, 'icon rail on: the deck tree is a column next to the rail');
const bioRow = p.locator('.dt-row', { hasText: 'Biology' });
ok((await bioRow.locator('.dt-n').textContent()).trim() === '10' && await bioRow.locator('.dt-n').getAttribute('aria-label') === '10 due', 'the tree shows the due number (10: 9 and the cloze note), labelled "10 due"');
ok((await bioRow.locator('a').getAttribute('title')).includes('18 cards'), 'the card count is in the tooltip: ' + await bioRow.locator('a').getAttribute('title'));
ok(await p.locator('.dt-row', { hasText: 'Unit 3' }).locator('.dt-n').count() === 0, 'a deck with nothing due shows no number');
ok((await p.locator('.dt-row', { hasText: 'Unit 1' }).locator('.dt-n').textContent()).trim() === '4', 'Unit 1 shows 4');
await p.screenshot({ path: SP + '/c-deck-1440-rail.png' });
await p.click('#sideCollapse');
await ctx.close();

// ======================= deck page header + ⋯ menu, 1440 light =======================
({ ctx, p } = await open(1440, 900, 'light'));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck'); await seed(p);
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('theme', { skin: 'violet', mode: 'light', oled: false }); });
const iso = n => { const d = new Date(2026, 9, 14 + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
await setDeck(p, 'Chem', { examDate: iso(9) });
await go(p, '#/deck/Chem', '#prepBtn');
// (UI audit M7: with cards due, "Review · N" is the main button and Exam prep the second; Exam prep is main only when nothing is due: e2e-uipolish)
ok(await p.locator('.head-actions #reviewBtn.primary').count() === 1 && /^Review · \d+$/.test((await p.textContent('#reviewBtn')).trim()), 'exam within 14 days, cards due: "Review · N" is the main button');
ok(await p.locator('#prepBtn.ghost').count() === 1 && await p.locator('#prepBtn.primary').count() === 0, 'and Exam prep steps back to the second button');
ok(await p.locator('.exam-line #prepBtn').count() === 0, 'no second Exam prep link in the sentence');
ok(!(await p.isVisible('#editDeck')) && !(await p.isVisible('#addSub')) && !(await p.isVisible('#exportDeck')), 'Edit, Add subdeck and Export are tucked away');
await p.click('#deckMore');
ok(await p.getAttribute('#deckMore', 'aria-expanded') === 'true' && await p.isVisible('#editDeck') && await p.isVisible('#addSub') && await p.isVisible('#exportDeck'), '⋯ opens a menu with the three');
ok(await p.evaluate(() => document.activeElement.id) === 'editDeck', 'focus moves to the first item');
await p.keyboard.press('ArrowDown'); ok(await p.evaluate(() => document.activeElement.id) === 'addSub', 'arrow keys move between items');
await p.screenshot({ path: SP + '/c-deck-menu-1440-light.png' });
ok(await p.evaluate(() => [...document.querySelectorAll('#deckMenu [role=menuitem]')].every(b => b.getAttribute('tabindex') === '-1')), 'menu items use roving focus (tabindex -1)');
await p.keyboard.press('End'); ok(await p.evaluate(() => document.activeElement.id) === 'shareDeck', 'End goes to the last item (Share, added in 4.35 after Export)');
await p.keyboard.press('Home'); ok(await p.evaluate(() => document.activeElement.id) === 'editDeck', 'Home goes to the first item');
await p.keyboard.press('Escape');
ok(!(await p.isVisible('#deckMenu')) && await p.evaluate(() => document.activeElement.id) === 'deckMore', 'Esc closes it and puts focus back on ⋯');
await p.click('#deckMore'); await p.mouse.click(700, 600);
ok(!(await p.isVisible('#deckMenu')), 'a click outside closes it');
await p.click('#deckMore'); await p.click('#editDeck'); await p.waitForSelector('#deckName');
ok(!(await p.isVisible('#deckMenu')) && (await p.inputValue('#deckName')) === 'Chemistry', 'choosing Edit deck closes the menu and opens the editor');
await p.keyboard.press('Escape');
await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(await p.evaluate(() => document.activeElement.id) === 'deckMore', 'after Edit and Esc the focus is back on the ⋯ button, not the page body');
await p.click('#deckMore'); await p.click('#addSub'); await p.waitForSelector('#deckName'); await p.keyboard.press('Escape');
await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(await p.evaluate(() => document.activeElement.id) === 'deckMore', 'after Add subdeck and Esc the focus is back on ⋯');
// exam far away: Review is the main button, Exam prep a quiet link
await setDeck(p, 'Chem', { examDate: iso(40) });
await go(p, '#/deck/Chem', '#prepBtn');
ok(await p.locator('#reviewBtn.primary').count() === 1 && await p.locator('.exam-line #prepBtn').count() === 1, 'exam in 40 days: Review is the main button, Exam prep a link in the sentence');
await ctx.close();

// ======================= 375: phone =======================
({ ctx, p } = await open(375, 740));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck'); await seed(p);
ok(!(await p.textContent('main')).includes('LIBRARY') && (await p.locator('.screen-head .eyebrow').count()) === 0, 'the Decks screen has no LIBRARY eyebrow');
await setDeck(p, 'Chem', { examDate: iso(9) });
await go(p, '#/deck/Chem', '#prepBtn');
const hb = await p.evaluate(() => [...document.querySelectorAll('.head-actions > *')].map(e => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right) }; }));
ok(hb.every(b => b.r <= 375 - 12) && hb.find(b => b.id === 'reviewBtn').w > 300, 'phone: header buttons fit with a 16px gutter and the main one is full width: ' + JSON.stringify(hb.map(b => [b.id, b.w])));
await noHScroll(p, 'deck page, phone');
await p.screenshot({ path: SP + '/c-deck-375.png', fullPage: true });
await p.click('#deckMore'); await p.waitForSelector('#deckMenu:not([hidden])');
const mb = await p.locator('#deckMenu').boundingBox();
ok(mb.x >= 0 && mb.x + mb.width <= 375, 'the menu stays on screen on a phone');
await p.screenshot({ path: SP + '/c-deck-menu-375.png' });
await p.keyboard.press('Escape');

// empty deck tile, % ring caption
await go(p, '#/decks', '.deck');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ id: 'E', name: 'Brand new', course: '', color: '#8E4EC6', parentId: '', created: Date.now() }); });
await go(p, '#/decks', '.deck');
const empty = p.locator('.deck', { hasText: 'Brand new' });
ok(await empty.locator('a.deck-go.add').count() === 1 && await empty.locator('.deck-go.done').count() === 0 && await empty.locator('.deck-ring').count() === 0, 'an empty deck: + Add cards, no tick, no ring');
// a deck that is caught up (cards, none due or new) gets the check
await p.evaluate(async () => { const db = await import('./js/db.js'); const now = Date.now(); await db.addDeckWithCards({ id: 'Done1', name: 'Caught up', color: '#12A594', created: now }, [{ id: 'dn1', deckId: 'Done1', front: 'q', back: 'a', created: now }]);
  await db.putStates([{ cardId: 'dn1', due: now + 30 * 86400000, stability: 30, difficulty: 5, reps: 4, lapses: 0, state: 2, lastReview: now - 86400000, elapsedDays: 1, scheduledDays: 30, learningSteps: 0 }]); });
await go(p, '#/decks', '.deck');
ok(await p.locator('.deck', { hasText: 'Caught up' }).locator('.deck-go.done').count() === 1, 'a deck with cards and nothing due still gets the check');
const ringTxt = (await p.locator('.deck:has-text("Chemistry") .deck-ring').textContent()).replace(/\s+/g, ' ').trim();
ok(/^\d+%\s*mastered$/.test(ringTxt), 'the ring reads "0% mastered": ' + ringTxt);
await noHScroll(p, 'decks, phone');
await p.screenshot({ path: SP + '/c-decks-375.png', fullPage: true });
// the empty Decks screen is the shared start block
await p.evaluate(async () => { const db = await import('./js/db.js'); for (const d of await db.getDecks()) await db.deleteDeck(d.id); });
await go(p, '#/decks', '.empty-first');
ok(await p.locator('.empty-first #trySample').count() === 1 && await p.locator('.empty-first a:has-text("Add cards")').count() === 1, 'no decks: the shared "Nothing to study yet" block with Paste notes and Try sample cards');
await noHScroll(p, 'empty decks, phone');
await p.screenshot({ path: SP + '/c-decks-empty-375.png' });

// Today: exam chips scroll on one line
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  const names = ['Anatomy and Physiology', 'Organic Chemistry II', 'Macroeconomics', 'Constitutional Law', 'Linear Algebra', 'World History'];
  for (const [i, name] of names.entries()) { await db.addDeckWithCards({ id: 'x' + i, name, color: '#3E63DD', created: now + i }, [{ id: 'xc' + i, deckId: 'x' + i, front: 'q', back: 'a', created: now + i }]); }
});
await go(p, '#/today', '.exam-add');
const ea = await p.evaluate(() => { const e = document.querySelector('.exam-add'); const mid = [...e.children].map(c => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; }); return { sw: e.scrollWidth, cw: e.clientWidth, oneLine: Math.max(...mid) - Math.min(...mid) < 4, ox: getComputedStyle(e).overflowX }; });
ok(ea.oneLine && ea.sw > ea.cw && ea.ox === 'auto', `the exam chips stay on one line and scroll sideways (${ea.sw} > ${ea.cw})`);
await noHScroll(p, 'Today with exam chips');
await p.screenshot({ path: SP + '/c-today-375.png', fullPage: true });
await ctx.close();

ok(errors.length === 0, 'no page errors: ' + errors.join(' | ').slice(0, 300));
await browser.close();
