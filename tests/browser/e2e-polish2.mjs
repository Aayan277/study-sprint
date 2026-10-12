// Polish pass 2 (layout B1 to B7): the card action sheet, one sheet frame, the Review progress bar, Decks that scale,
// exam date in 3 taps, the per-course Stats header, and the 3-column Decks page on a wide screen.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const DAY = 86400000;
const open = async (w, h, { touch = w < 800 } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.stack)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, p };
};
const go = async (p, hash, sel) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(sel); await p.waitForTimeout(250); };
const box = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; });
const card = (p, id) => p.evaluate(async i => (await import('./js/db.js')).get('cards', i), id);
const state = (p, id) => p.evaluate(async i => (await import('./js/db.js')).get('cardStates', i), id);
const isoIn = n => { const d = new Date(Date.now() + n * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// The library every test below uses.
async function seed(p) {
  await p.evaluate(async () => {
    const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
    const cards = (id, n, p = '') => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `${p || id} question ${i}`, back: `${p || id} answer ${i}`, tags: [], created: i }));
    const iso = n => { const d = new Date(now + n * D); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    await db.addDeckWithCards({ id: 'bio', name: 'Cell Biology', course: 'BIOL 201', color: '#46A758', created: now + 1, examDate: iso(9) }, cards('bio', 8));
    await db.addDeckWithCards({ id: 'econ', name: 'Microeconomics', color: '#3E63DD', created: now + 2 }, cards('econ', 6));
    await db.addDeckWithCards({ id: 'span', name: 'Spanish B1', color: '#F76B15', created: now + 3 }, cards('span', 4));
    await db.addDeckWithCards({ id: 'law', name: 'Law', color: '#E5484D', created: now + 4 }, cards('law', 2));
    await db.addDeckWithCards({ id: 'law1', name: 'Unit 1', parentId: 'law', color: '#E5484D', created: now + 5 }, cards('law1', 3));
    await db.addDeckWithCards({ id: 'law2', name: 'Unit 2', parentId: 'law', color: '#E5484D', created: now + 6 }, cards('law2', 3));
    await db.addDeckWithCards({ id: 'law1a', name: 'Lecture 3', parentId: 'law1', color: '#E5484D', created: now + 7 }, cards('law1a', 2));
    await db.addDeckWithCards({ id: 'zed', name: 'Zoology', color: '#8E4EC6', created: now + 8 }, cards('zed', 3));
    await db.addDeckWithCards({ id: 'chem', name: 'Chemistry', color: '#12A594', created: now + 9 }, []);
    const st = (cardId, o) => ({ cardId, due: now + D, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 2 * D, scheduledDays: 3, elapsedDays: 2, learningSteps: 0, ...o });
    const states = [];
    for (let i = 0; i < 3; i++) states.push(st('bio' + i, { stability: 300, due: now + 100 * D }));      // strong: still 90%+ on exam day
    states.push(st('bio3', { stability: 1, due: now - D, lastReview: now - 5 * D }));                    // weak, and due
    for (let i = 0; i < 6; i++) states.push(st('econ' + i, { due: now - D, stability: 4 }));              // 6 due reviews: Review's cards
    states.push(st('span0', { due: now + 60 * D, stability: 5, lastReview: now - D }));                  // far away: an exam brings it forward
    states.push(st('law10', { due: now - D }), st('law11', { due: now - D }));                           // 2 due, inside Unit 1
    await db.putMany('cardStates', states);
  });
}
const names = p => p.$$eval('#deckGrid .deck-name', e => e.map(x => x.textContent));

// ============================ phone ============================
let { ctx, p } = await open(375, 812);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await seed(p);
await p.reload(); await p.waitForSelector('.deck');

// ---------- B2: one sheet frame ----------
await go(p, '#/today', '#optBtn');
await p.click('#optBtn'); await p.waitForSelector('#sheet[open] .sheet-x'); await p.waitForTimeout(400);
let sh = await box(p, '#sheet'), x = await box(p, '.sheet-x');
ok(x.r > sh.r - 24 && x.y < sh.y + 80, `the × is at the top right of the sheet: x ${Math.round(x.x)} y ${Math.round(x.y - sh.y)}`);
ok(await p.$eval('#sheet .sheet-head #sheetTitle', e => !!e) && (await p.textContent('#sheetTitle')) === 'Study options', 'the title sits in the sticky header');
let f = await box(p, '.sheet-foot'), prim = await box(p, '#optDone'), sec = await box(p, '#customBtn');
ok(Math.abs(f.b - sh.b) < 2 && prim.x > sec.x && prim.r <= f.r, 'the footer is stuck to the bottom, with the primary button on the right of the other one');
ok(await p.$eval('#sheet .sheet-in', e => e.scrollHeight >= e.clientHeight), 'the body is the part that scrolls');
for (let i = 0; i < 10; i++) await p.keyboard.press('Tab');
ok(await p.evaluate(() => document.getElementById('sheet').contains(document.activeElement)), 'Tab stays inside the sheet (focus trap)');
await p.click('.sheet-x'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(await p.evaluate(() => document.activeElement?.id) === 'optBtn', '× closes the sheet and focus goes back to the button that opened it');
await p.click('#optBtn'); await p.waitForSelector('#sheet[open]'); await p.keyboard.press('Escape');
await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(await p.evaluate(() => document.activeElement?.id) === 'optBtn', 'Escape closes the sheet and focus goes back too');
// a sticky footer: scrolling a long sheet keeps Save in view (Edit deck)
await go(p, '#/decks', '.deck'); await p.click('[data-edit="econ"]'); await p.waitForSelector('#deckForm'); await p.waitForTimeout(400);
sh = await box(p, '#sheet'); sec = await box(p, '#deckCancel'); prim = await box(p, 'button[type=submit][form=deckForm]');
ok(prim.x > sec.x && Math.abs(prim.b - sh.b) < 30, 'Edit deck: Cancel on the left, Save on the right, both at the bottom');
const y0 = (await box(p, '.sheet-foot')).y; await p.$eval('#sheet .sheet-in', e => { e.scrollTop = e.scrollHeight; });
ok(Math.abs((await box(p, '.sheet-foot')).y - y0) < 1, 'the footer stays put while the body scrolls');
await p.fill('#deckName', 'Micro 2'); await p.keyboard.press('Enter');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Deck saved');
ok((await p.evaluate(async () => (await import('./js/db.js')).getDecks())).find(d => d.id === 'econ').name === 'Micro 2', 'Enter in a field still submits, though Save is outside the form');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDecks()).find(d => d.id === 'econ'), name: 'Microeconomics' }); });
// the grab bar really drags: a short pull snaps back, a long one closes the sheet (touch)
await go(p, '#/today', '#optBtn'); await p.click('#optBtn'); await p.waitForSelector('#sheet[open] .sheet-head'); await p.waitForTimeout(400);
const cdp = await ctx.newCDPSession(p);
const swipe = async (dy, steps = 8) => {
  const h = await box(p, '.sheet-head'); const cx = Math.round(h.x + 120), cy = Math.round(h.y + 14);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
  for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx, y: cy + Math.round(dy * i / steps) }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const top0 = (await box(p, '#sheet')).y;
await swipe(30); await p.waitForTimeout(400);
ok(await p.evaluate(() => document.getElementById('sheet').open) && Math.abs((await box(p, '#sheet')).y - top0) < 2, 'a short drag on the grab bar springs back');
await swipe(260); await p.waitForFunction(() => !document.getElementById('sheet').open, null, { timeout: 3000 }).catch(() => {});
ok(await p.evaluate(() => !document.getElementById('sheet').open), 'dragging the grab bar down closes the sheet');
await p.waitForTimeout(300);
await p.click('#optBtn'); await p.waitForSelector('#sheet[open]'); await p.waitForTimeout(400);
ok(Math.abs((await box(p, '#sheet')).y - top0) < 2, 'and the sheet opens normally afterwards');
await p.click('.sheet-x');

// ---------- B4: Decks that scale (phone) ----------
await go(p, '#/decks', '.deck-tools');
ok(await p.isVisible('#deckSearch') && (await p.$$eval('[data-sort]', b => b.map(x => x.textContent))).join('|') === 'Due first|Exam|A–Z', 'compact list is on by default: search box and Due first / Exam / A–Z');
ok(!(await p.$('.dsum')), 'the summary strip is gone');
ok((await p.$$eval('#deckGrid > .deck', d => d.length)) === 7, 'one tile per course (subdecks are not tiles)');
let n = await names(p);
ok(n.indexOf('Microeconomics') < n.indexOf('Law') && n.indexOf('Law') < n.indexOf('Cell Biology'), 'Due first puts the course with most due on top: ' + n.join(', '));
ok(await p.$eval('#deckGrid .deck .deck-go.lead', e => e.closest('.deck').querySelector('.deck-name').textContent) === 'Microeconomics', 'and the first one has the filled play button');
await p.click('[data-sort=exam]'); n = await names(p);
ok(n[0] === 'Cell Biology' && (await p.getAttribute('[data-sort=exam]', 'aria-pressed')) === 'true', 'Exam puts the nearest exam first: ' + n.slice(0, 3).join(', '));
await p.click('[data-sort=az]'); n = await names(p);
const sorted = [...n].sort((a, b) => a.localeCompare(b));
ok(n.join() === sorted.join(), 'A–Z is alphabetical: ' + n.join(', '));
await p.reload(); await p.waitForSelector('#deckGrid .deck');
ok((await p.getAttribute('[data-sort=az]', 'aria-pressed')) === 'true', 'the sort is remembered on this device');
await p.click('[data-sort=due]');
// search
await p.fill('#deckSearch', 'spanish'); n = await names(p);
ok(n.join() === 'Spanish B1', 'search by name: ' + n.join());
await p.fill('#deckSearch', 'biol 201'); n = await names(p);
ok(n.join() === 'Cell Biology', 'search by course code: ' + n.join());
await p.fill('#deckSearch', 'unit 2'); n = await names(p);
ok(n.join() === 'Law' && await p.$eval('.subdecks', d => d.open) && (await p.$$eval('.subdecks .sd-name', r => r.map(x => x.textContent))).join() === 'Unit 2', 'a subdeck match shows its course with just that subdeck, open: ' + n.join());
await p.fill('#deckSearch', 'zzz'); n = await names(p);
ok(n.length === 0 && (await p.textContent('#deckNone')).includes('zzz'), 'no match says so');
await p.fill('#deckSearch', ''); n = await names(p);
ok(n.length >= 6 && !(await p.$eval('.subdecks', d => d.open)), 'clearing the search brings everything back, folds as they were (a search does not remember its open folds)');
// subdecks collapsed, remembered per device
ok(!(await p.$eval('.subdecks', d => d.open)) && (await p.textContent('.subdecks summary')).trim() === '2 subdecks · 3 in all', 'subdecks start folded under their course: ' + (await p.textContent('.subdecks summary')).trim());
await p.click('.subdecks summary'); await p.waitForTimeout(100);
await p.reload(); await p.waitForSelector('#deckGrid .deck');
ok(await p.$eval('.subdecks', d => d.open), 'an open fold is remembered');
await p.click('.subdecks summary'); await p.waitForTimeout(100); await p.reload(); await p.waitForSelector('#deckGrid .deck');
ok(!(await p.$eval('.subdecks', d => d.open)), 'and so is a closed one');
// small round play buttons
ok(await p.$$eval('.deck-act .btn', b => b.length) === 0, 'no full-width Study buttons');
const go1 = await box(p, '.deck-go'); ok(go1.w === 40 && go1.h === 40, 'the play button is a 40px circle');
ok((await p.getAttribute('[data-study="econ"]', 'aria-label')) === 'Study Microeconomics: 6 cards', 'with an accessible name: ' + await p.getAttribute('[data-study="econ"]', 'aria-label'));
ok(await p.$eval('.deck:has([data-study="zed"]) .deck-go', e => !!e) && await p.$('.deck-go.done') !== null, 'a deck with nothing to do shows a check instead');
await p.click('[data-study="econ"]'); await p.waitForSelector('#flash');
ok(await p.evaluate(() => location.hash) === '#/review/econ', 'the play button starts the deck');
await p.click('#endBtn'); await p.waitForSelector('.finish-next');
// the switch: Settings → Appearance
await go(p, '#/settings', '#compactDecks');
ok(await p.isChecked('#compactDecks') && await p.isChecked('#statsReadiness'), 'both switches are in Settings → Appearance, on by default');
ok(await p.evaluate(async () => { const m = await import('./js/sync-data.js'); return !m.SYNCED_SETTINGS.includes('compactDecks') && !m.SYNCED_SETTINGS.includes('statsReadiness'); }), 'they are stored on this device only (not synced)');
ok(await p.$eval('#compactDecks', e => e.closest('section').querySelector('h2').textContent) === 'Appearance', 'in the Appearance section');
await p.click('label:has(#compactDecks)'); await p.waitForTimeout(150);
ok((await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).compactDecks)) === false, 'turning it off is saved');
await go(p, '#/decks', '.deck');
ok(!(await p.$('.deck-tools')) && await p.isVisible('.dsum') && await p.$eval('.subdecks', d => d.open), 'off: the old list is back (summary strip, no search, subdecks showing)');
ok((await p.textContent('[data-study="econ"]')).trim() === 'Study 6' && await p.$$eval('.deck-act .btn.primary', b => b.length) >= 3, 'off: full-width "Study N" buttons are back');
ok(await p.$$eval('.deck-go', b => b.length) === 0, 'off: no round buttons');
await go(p, '#/settings', '#compactDecks'); await p.click('label:has(#compactDecks)'); await p.waitForTimeout(150);
await go(p, '#/decks', '.deck-tools');

// ---------- B5: exam date in 3 taps ----------
await go(p, '#/today', '.today-hero');
let chips = await p.$$eval('[data-addexam]', c => c.map(x => x.dataset.addexam));
ok([...chips].sort().join() === 'econ,law,span,zed', 'Today offers "Add exam date" for courses with cards and no exam (not the one with an exam, the empty one, or subdecks): ' + chips.join());
ok(!(await p.$eval('.exam-add', e => e.textContent)).includes('Cell Biology') && !(await p.$eval('.exam-add', e => e.textContent)).includes('sample'), 'and not for Cell Biology or the sample deck');
let taps = 0;
await p.click('[data-addexam="span"]'); taps++; await p.waitForSelector('#xdForm');
ok((await p.textContent('#sheetTitle')) === 'Spanish B1 exam', 'the sheet is named for the course');
await p.click('[data-days="14"]'); taps++;
ok(await p.inputValue('#xdDate') === isoIn(14) && await p.getAttribute('[data-days="14"]', 'aria-pressed') === 'true', 'the 2 weeks preset fills the date: ' + await p.inputValue('#xdDate'));
await p.click('button[type=submit][form=xdForm]'); taps++;
await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(taps === 3 && (await p.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.id === 'span').examDate)) === isoIn(14), 'three taps set deck.examDate to ' + isoIn(14));
ok((await p.textContent('#toast')).includes('Spanish B1: exam in 14 days'), 'toast: ' + await p.textContent('#toast'));
ok(await p.$$eval('.exam-row', r => r.some(x => x.textContent.includes('Spanish B1'))) && !(await p.$('[data-addexam="span"]')), 'the course is now under Upcoming exams, and its chip is gone');
const examStart = await p.evaluate(async d => (await import('./js/exam.js')).examStart(d), isoIn(14));
ok((await state(p, 'span0')).due < examStart, 'the card that was scheduled after the exam was brought forward (the same pull-in as Edit deck)');
// validation: a date that has passed
await p.click('[data-addexam="econ"]'); await p.waitForSelector('#xdForm');
await p.fill('#xdDate', isoIn(-3)); await p.click('button[type=submit][form=xdForm]');
ok(await p.isVisible('#xdErr') && (await p.textContent('#xdErr')).includes('passed') && await p.evaluate(() => document.getElementById('sheet').open), 'a date in the past is refused, with a message');
ok(!(await p.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.id === 'econ').examDate)), 'and nothing was saved');
await p.click('.sheet-x');
// the deck page has the same action
await go(p, '#/deck/law', '#addExam');
await p.click('#addExam'); await p.waitForSelector('#xdForm'); await p.click('[data-days="28"]'); await p.click('button[type=submit][form=xdForm]');
await p.waitForSelector('#prepBtn');
ok((await p.textContent('.exam-line .exam-badge')) === 'Exam in 28 days' && !(await p.$('#addExam')), 'the deck page: Add exam date sets it the same way, and the exam line takes its place');

// ---------- B6: per-course Stats header ----------
await go(p, '#/stats', '#sDeckBtn');
ok(!(await p.$('.ready-card')) && !(await p.$('#sDeck')), 'with all decks there is no header, and the picker button replaces the select');
await p.click('#sDeckBtn'); await p.waitForSelector('#pickQ');
ok(await p.$$eval('.pick-row', r => r.length) >= 10 && (await p.textContent('.pick-row.pick-all')).includes('All decks'), 'the picker lists every deck as a tree, with All decks first');
const depths = await p.$$eval('.pick-row', r => r.map(x => [x.querySelector('.pick-name').textContent.trim(), +getComputedStyle(x).getPropertyValue('--depth')]));
ok(depths.find(d => d[0] === 'Lecture 3')[1] === 2 && depths.find(d => d[0] === 'Unit 1')[1] === 1 && depths.find(d => d[0] === 'Law')[1] === 0, 'subdecks are indented by depth');
await p.fill('#pickQ', 'cell'); await p.waitForTimeout(150);
ok((await p.$$eval('.pick-row', r => r.map(x => x.dataset.id))).join() === 'bio', 'searching filters the tree: ' + (await p.$$eval('.pick-row', r => r.map(x => x.dataset.id))).join());
await p.fill('#pickQ', 'lecture'); await p.waitForTimeout(150);
ok((await p.$$eval('.pick-row', r => r.map(x => x.dataset.id))).join() === 'law,law1,law1a' && await p.$$eval('.pick-row.ctx', r => r.length) === 2, 'a match keeps the decks it sits inside, dimmed');
await p.fill('#pickQ', 'zzz'); ok(!(await p.isVisible('.pick-row')) && (await p.textContent('#pickNone')).includes('zzz'), 'no match says so');
await p.fill('#pickQ', 'cell'); await p.keyboard.press('ArrowDown'); ok(await p.evaluate(() => document.activeElement?.dataset?.id) === 'bio', 'the arrow key moves from the search box to the list');
await p.keyboard.press('Enter'); await p.waitForSelector('.ready-card');
ok(!(await p.evaluate(() => document.getElementById('sheet').open)), 'Enter picks the deck and closes the picker');
const head = await p.$eval('.ready-card', e => ({ pct: e.querySelector('.ready-ring b').textContent, badge: e.querySelector('.exam-badge')?.textContent, line: e.querySelector('.ready-line').textContent.replace(/\s+/g, ' ').trim(), title: e.querySelector('h2').textContent, prep: !!e.querySelector('#readyPrep'), ring: !!e.querySelector('svg circle.ring-fg') }));
ok(head.pct === '38%' && head.ring, 'readiness ring: 3 of 8 cards will still be at 90%+ on exam day = 38%: ' + head.pct);
ok(head.badge === 'Exam in 9 days' && head.title === 'Exam readiness', 'the exam badge: ' + head.badge);
ok(head.line === '4/8 seen · 3 mature', 'seen and mature counts: ' + head.line);
ok(head.prep, 'an Exam prep button');
ok(await p.evaluate(() => { const a = document.querySelector('.ready-card'), m = document.querySelector('.stats-mastery'), g = document.querySelector('.pgrid'); return !!(a.compareDocumentPosition(m) & 4) && !!(m.compareDocumentPosition(g) & 4); }), 'Mastery moved to the top, right under the header');
ok(await p.isVisible('#mTitle') && await p.isVisible('#mGrid .mtile'), 'and it shows without opening "More stats"');
ok((await p.textContent('.pgrid .card h2')) === 'Overall streak', 'the streak card says Overall streak');
ok(await p.evaluate(async () => { const { readiness } = await import('./js/exam.js'); const db = await import('./js/db.js'); const cs = (await db.getAll('cards')).filter(c => c.deckId === 'bio'); const m = new Map((await db.getAll('cardStates')).map(s => [s.cardId, s])); const e = (await import('./js/exam.js')).examStart((await db.getDecks()).find(d => d.id === 'bio').examDate); return Math.round(readiness(cs, m, e).share * 100) === 38; }), 'the number agrees with exam.js readiness() on exam day');
const pb = await box(p, '#sDeckBtn'); ok(pb.h >= 44, 'the picker button is a 44px target');
await p.click('#readyPrep'); await p.waitForSelector('#flash');
ok((await p.textContent('.flash-deck')).includes('Exam prep'), 'Exam prep starts an exam prep session');
await p.click('#endBtn'); await p.waitForSelector('.finish-next');
// no exam: readiness for today, and a way to add one
await go(p, '#/stats', '#sDeckBtn'); await p.click('#sDeckBtn'); await p.click('.pick-row[data-id="zed"]'); await p.waitForSelector('.ready-card');
ok((await p.textContent('.ready-card h2')) === 'Readiness today' && !(await p.$('.ready-card .exam-badge')) && await p.isVisible('#readyExam') && !(await p.$('#readyPrep')), 'without an exam: Readiness today, and Add exam date instead of Exam prep');
await p.click('#sDeckBtn'); await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(await p.evaluate(() => document.activeElement?.id) === 'sDeckBtn', 'Escape closes the picker and focus goes back to its button');
// the switch off: no header, the old select
await go(p, '#/settings', '#statsReadiness'); await p.click('label:has(#statsReadiness)'); await p.waitForTimeout(150);
ok((await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).statsReadiness)) === false, 'turning Exam readiness in Stats off is saved');
await go(p, '#/stats', '#sDeck');
await p.selectOption('#sDeck', 'bio'); await p.waitForFunction(() => document.querySelectorAll('.mtile').length === 8 || document.querySelector('#mTitle'));
ok(!(await p.$('.ready-card')) && !(await p.$('#sDeckBtn')) && (await p.$$eval('.pgrid .card h2', h => h[0].textContent)) === 'Day streak', 'off: no header, the plain deck select, the streak card as before');
ok(await p.evaluate(() => { const m = document.querySelector('.stats-mastery'); return !!m && !!m.closest('#moreBody') && !m.classList.contains('up'); }), 'off: Mastery stays in More stats');
await go(p, '#/settings', '#statsReadiness'); await p.click('label:has(#statsReadiness)'); await p.waitForTimeout(150);
// ---------- B3 and B1: a Review session ----------
await go(p, '#/today', '[data-start="econ"]'); await p.click('[data-start="econ"]'); await p.waitForSelector('#flash');
const bar = () => p.$eval('.rv-prog', e => ({ now: +e.getAttribute('aria-valuenow'), max: +e.getAttribute('aria-valuemax'), min: e.getAttribute('aria-valuemin'), role: e.getAttribute('role'), label: e.getAttribute('aria-label'), w: parseFloat(e.firstElementChild.style.width), keep: !!e.__keep }));
let b = await bar();
ok(b.role === 'progressbar' && b.min === '0' && b.now === 0 && b.max === 6 && b.w === 0 && b.label, 'progress bar: role, 0 of 6 at the start: ' + JSON.stringify(b));
ok((await box(p, '.rv-prog')).h <= 2.5, 'it is 2px tall');
ok(await p.$eval('#undoBtn', e => !!e.querySelector('svg') && e.textContent.trim() === '' && e.getAttribute('aria-label') === 'Undo'), 'Undo is an icon button with a label');
ok(await p.$eval('.rv-head', h => [...h.querySelectorAll('.link')].every(l => { const r = l.getBoundingClientRect(); return l.id === 'endBtn' || (Math.round(r.width) === 40 && Math.round(r.height) === 40); })), 'the toolbar buttons share one size');
ok(await p.$eval('.rv-prog', e => getComputedStyle(e.firstElementChild).transitionProperty.includes('width')), 'the fill has a width transition');
await p.$eval('.rv-prog', e => { e.__keep = true; });
await p.click('#showBtn'); await p.click('[data-rate="3"]'); await p.waitForFunction(() => document.querySelector('#undoBtn') && !document.querySelector('#undoBtn').disabled);
b = await bar();
ok(b.now === 1 && b.max === 6 && Math.abs(b.w - 100 / 6) < 0.2 && b.keep, 'Good on a due card: 1 of 6, and it is the same bar element (outside what is redrawn): ' + JSON.stringify(b));
await p.click('#showBtn'); await p.click('[data-rate="1"]'); await p.waitForTimeout(400);
b = await bar();
ok(b.now === 2 && b.max === 7 && b.keep, 'Again sends the card to relearn: it still counts as left, so 2 of 7: ' + JSON.stringify(b));
await p.click('#undoBtn'); await p.waitForTimeout(400);
b = await bar();
ok(b.now === 1 && b.max === 6 && b.keep, 'Undo takes the bar back: 1 of 6: ' + JSON.stringify(b));
ok((await p.$eval('.rv-prog', e => e.getAttribute('aria-valuetext'))) === '1 of 6 cards done', 'screen readers get "1 of 6 cards done"');

// B1: the ⋯ sheet
await p.click('#showBtn');
const before = await p.$$eval('.rv-counts span', s => s.map(x => x.textContent).join('|'));
const frontBefore = await p.textContent('.rv-front .flash-front');
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
const rows = await p.$$eval('.act-list .act-row', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok(rows.length === 5 && /^Edit card/.test(rows[0]) && /^Flag/.test(rows[1]) && /^Bury until tomorrow/.test(rows[2]) && /^Suspend/.test(rows[3]) && /^More/.test(rows[4]), 'the ⋯ sheet is short: Edit, Flag, Bury, Suspend, More: ' + rows.join(' / '));
ok((await box(p, '#sheet')).h < 480, 'and it is small (not the old 1,100px panel): ' + Math.round((await box(p, '#sheet')).h));
await p.click('[data-go=edit]'); await p.waitForSelector('#ceForm'); await p.waitForTimeout(300);
ok(await p.isVisible('#ceFront') && await p.isVisible('#ceBack') && await p.isVisible('#ceTags') && await p.isVisible('[data-fmt=bold]') && await p.isVisible('[data-img-add="ceFront"]'), 'Edit has Front, Back, Tags, the formatting buttons and pictures');
ok(!(await p.isVisible('[data-act=delete]')) && !(await p.isVisible('#ceMove')), 'and nothing else');
let sf = await box(p, '.sheet-foot'); sh = await box(p, '#sheet');
ok(Math.abs(sf.b - sh.b) < 2 && (await box(p, '#ceCancel')).x < (await box(p, 'button[type=submit][form=ceForm]')).x, 'Cancel and Save are in the sticky footer, Save on the right');
await p.fill('#ceFront', 'Edited front'); await p.click('button[type=submit][form=ceForm]');
await p.waitForFunction(() => !document.getElementById('sheet').open);
ok((await p.textContent('#toast')) === 'Card saved', 'saving shows a toast');
ok((await p.textContent('.rv-front .flash-front')) === 'Edited front' && (await p.$$eval('.rv-counts span', s => s.map(x => x.textContent).join('|'))) === before, 'back on the same card with the new text, and the counts did not move');
ok(await p.$eval('#flash', e => e.classList.contains('flipped')), 'a card that was turned over is still turned over');
ok(await p.evaluate(() => document.getElementById('flash').contains(document.activeElement)), 'focus is back on the card');
const editedId = (await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === 'Edited front')?.id));
ok(!!editedId && editedId.startsWith('econ'), 'the edit went to that card');
// Cancel and Escape leave the card alone
await p.keyboard.press('e'); await p.waitForSelector('#ceForm');
ok(!(await p.isVisible('.act-list')), 'E opens the editor straight away');
await p.fill('#ceFront', 'Not saved'); await p.click('#ceCancel');
ok((await p.textContent('.rv-front .flash-front')) === 'Edited front', 'Cancel throws the change away');
// the keys I, - and @ still work
await p.keyboard.press('i'); await p.waitForSelector('#ceForm');
ok(await p.evaluate(() => document.querySelector('.card-info').open), 'I shows the card info');
await p.click('.sheet-x');
// flag from the sheet: closes it and keeps the card
await p.click('#moreBtn'); await p.waitForSelector('.act-list'); await p.click('.act-flag[data-flag="1"]'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok((await card(p, editedId)).flag === 1 && (await p.textContent('#toast')) === 'Red flag' && (await p.textContent('.rv-front .flash-front')) === 'Edited front', 'Flag sets the flag, shows a toast and stays on the card');
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
ok(await p.getAttribute('.act-flag[data-flag="1"]', 'aria-pressed') === 'true', 'the sheet shows which flag is on');
await p.click('.act-flag[data-flag="1"]'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok((await card(p, editedId)).flag === 0, 'tapping the same flag takes it off');
// More: every old action is still there
await p.click('#moreBtn'); await p.waitForSelector('.act-list'); await p.click('[data-go=more]'); await p.waitForSelector('#ceForm [data-act], [data-act=reset]');
const have = await p.evaluate(() => ({ suspend: !!document.querySelector('[data-act=suspend]'), bury: !!document.querySelector('[data-act=bury]'), reset: !!document.querySelector('[data-act=reset]'), del: !!document.querySelector('[data-act=delete]'), move: !!document.querySelector('#ceMove') && !!document.querySelector('#ceMoveBtn'), due: !!document.querySelector('#ceDue') && !!document.querySelector('#ceDueBtn'), info: !!document.querySelector('.card-info summary'), flags: document.querySelectorAll('[data-flag]').length, edit: !!document.querySelector('#ceFront') }));
ok(Object.entries(have).every(([k, v]) => v) && have.flags >= 4, 'More opens the full panel with edit, suspend, bury, reset, delete, move, due date, flags and card info: ' + JSON.stringify(have));
await p.selectOption('#ceMove', 'zed'); await p.click('#ceMoveBtn'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok((await card(p, editedId)).deckId === 'zed' && (await p.textContent('.rv-front .flash-front')) === 'Edited front', 'Move works from More and you are back on the card');
await p.click('#moreBtn'); await p.waitForSelector('.act-list'); await p.click('[data-go=more]'); await p.waitForSelector('#ceDueBtn');
await p.fill('#ceDue', '5'); await p.click('#ceDueBtn'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok((await state(p, editedId)).due > Date.now() + 4 * DAY && (await p.textContent('.rv-front .flash-front')) !== 'Edited front', 'Set due date works from More and moves on to the next card');
let left = await p.$$eval('.rv-counts span', s => s.reduce((n, x) => n + +x.textContent, 0));
await p.click('#moreBtn'); await p.waitForSelector('.act-list'); await p.click('[data-go=more]'); await p.waitForSelector('[data-act=delete]');
await p.click('[data-act=delete]'); await p.click('#cfYes'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok(await p.$$eval('.rv-counts span', s => s.reduce((n, x) => n + +x.textContent, 0)) === left - 1, 'Delete works from More (with its confirmation) and moves on');
left -= 1;
await p.keyboard.press('-'); await p.waitForTimeout(300);
ok(await p.$$eval('.rv-counts span', s => s.reduce((n, x) => n + +x.textContent, 0)) === left - 1, '- still buries and moves on');
await p.keyboard.press('@'); await p.waitForTimeout(300);
ok(await p.$$eval('.rv-counts span', s => s.reduce((n, x) => n + +x.textContent, 0)) === left - 2, '@ still suspends and moves on');
await p.click('#endBtn'); await p.waitForSelector('.finish-next');

await ctx.close();

// ============================ computer ============================
({ ctx, p } = await open(1440, 900));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await seed(p);
await p.reload(); await p.waitForSelector('#deckGrid .deck');

// ---------- B4 on a computer: tiles keep their own height ----------
const tiles = () => p.$$eval('#deckGrid > .deck', d => d.map(x => { const r = x.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height) }; }));
let t = await tiles(); const row1 = t.filter(x => x.y === t[0].y);
ok(row1.length >= 3, 'three tiles in a row at 1440: ' + row1.length);
const rowMates = await p.evaluate(() => { const ds = [...document.querySelectorAll('#deckGrid > .deck')].map(d => { const r = d.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height) }; }); const byRow = {}; for (const d of ds) (byRow[d.y] ||= []).push(d.h); return Object.values(byRow).some(hs => new Set(hs).size > 1); });
ok(rowMates, 'in at least one row, tiles of different heights sit side by side');
await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('compactDecks', false); });
await p.reload(); await p.waitForSelector('#deckGrid .deck');
ok(await p.evaluate(() => { const byRow = {}; for (const d of document.querySelectorAll('#deckGrid > .deck')) { const r = d.getBoundingClientRect(); (byRow[Math.round(r.y)] ||= []).push(Math.round(r.height)); } return Object.values(byRow).every(hs => new Set(hs).size === 1); }), 'off: tiles in a row all stretch to the same height, as before');
await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('compactDecks', true); });

// ---------- B7: three columns ----------
await go(p, '#/deck/law', '.crow');
const tree = await box(p, '.deck-tree'), side = await box(p, '.tabs');
ok(tree.x === side.r && Math.round(tree.w) === 240, `the deck tree is a left column next to the sidebar: x ${tree.x}, width ${tree.w}`);
ok((await p.$$eval('.dt-row', r => r.length)) >= 8 && (await p.textContent('.dt-row.cur')).includes('Law'), 'it lists the decks and highlights this one');
ok((await p.$eval('.dt-row.cur a', e => e.getAttribute('aria-current'))) === 'page', 'the current deck is marked for screen readers');
const kids = await p.$$eval('.dt-row', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok(kids.some(k => k.startsWith('Unit 1')) && kids.some(k => k.startsWith('Lecture 3')) === false, 'this course is open and the deeper levels folded: ' + kids.join(' | '));
await p.click('[data-tw="law1"]'); ok((await p.$$eval('.dt-row', r => r.map(x => x.textContent))).some(k => k.includes('Lecture 3')), 'a fold opens in the tree');
await p.fill('#dtQ', 'lecture'); ok((await p.$$eval('.dt-row', r => r.length)) === 3, 'the tree has its own search');
await p.fill('#dtQ', '');
const view = await box(p, 'main > .view');
ok(view.x >= tree.r + 20, 'the deck sits in the middle column, right of the tree: x ' + Math.round(view.x));
const dock = await box(p, '.dock-empty');
ok(await p.isVisible('.dock-empty') && dock.x > 1000 && dock.r >= 1439 && view.r <= dock.x, 'the card editor column is docked on the right, waiting for a card: x ' + Math.round(dock.x));
await p.locator('.crow').first().click(); await p.waitForSelector('#ceForm'); await p.waitForTimeout(400);
sh = await box(p, '#sheet');
ok(await p.evaluate(() => document.getElementById('sheet').classList.contains('side') && document.getElementById('sheet').open && !document.getElementById('sheet').matches(':modal')), 'a card opens in the docked panel (not a pop-up)');
ok(Math.abs(sh.x - dock.x) < 2 && Math.round(sh.w) === 400 && sh.b >= 899, 'in the same place, 400px wide, full height: x ' + Math.round(sh.x));
ok(!(await p.isVisible('.dock-empty')), 'the placeholder is hidden while a card is open');
ok((await box(p, '.crows')).r <= sh.x && (await box(p, '.crows')).x > tree.r, 'the card list sits between the tree and the editor, not under it');
ok(await p.isVisible('.sheet-x') && (await box(p, '.sheet-x')).r > sh.r - 24, 'the editor has a × at the top');
sf = await box(p, '.sheet-foot'); ok(Math.abs(sf.b - sh.b) < 2 && await p.isVisible('button[type=submit][form=ceForm]'), 'Save changes is in a footer that stays in view');
ok(await p.$eval('.crow.sel', e => !!e), 'the open card is highlighted in the list');
await p.fill('#ceFront', 'Docked edit'); await p.click('button[type=submit][form=ceForm]'); await p.waitForTimeout(500);
ok(await p.isVisible('#ceForm') && (await p.$eval('.crow.sel .f', e => e.textContent)).includes('Docked edit'), 'saving in the dock keeps it open and updates the list');
await p.locator('.crow').nth(1).click(); await p.waitForTimeout(400);
ok((await p.textContent('#ceFront')) !== 'Docked edit', 'clicking another card switches the dock to that card');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
ok(!(await p.evaluate(() => document.getElementById('sheet').open)) && await p.isVisible('.dock-empty'), 'Escape closes the panel and the dock waits again');
await p.click('.dt-row:has-text("Microeconomics") a'); await p.waitForFunction(() => location.hash === '#/deck/econ');
await p.waitForSelector('.dt-row.cur:has-text("Microeconomics")');
ok((await p.textContent('h1')) === 'Microeconomics', 'a deck in the tree opens that deck');
await ctx.close();

// below 1200px nothing changes
({ ctx, p } = await open(1100, 800));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck'); await seed(p);
await go(p, '#/deck/law', '.crow');
ok(!(await p.isVisible('.deck-tree')) && !(await p.isVisible('.dock-empty')), '1100px: no tree and no dock');
ok((await box(p, '.tabs')).w === 232 && (await box(p, 'main')).x === 232, '1100px: the page starts right after the sidebar, as before');
await p.locator('.crow').first().click(); await p.waitForSelector('#ceForm');
ok(await p.evaluate(() => document.getElementById('sheet').matches(':modal') && !document.getElementById('sheet').classList.contains('side')), '1100px: a card still opens as a pop-up');
await ctx.close();
({ ctx, p } = await open(375, 812));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck'); await seed(p);
await go(p, '#/deck/law', '.crow');
ok(!(await p.isVisible('.deck-tree')) && !(await p.isVisible('.dock-empty')) && await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '375px: no tree, no dock, no sideways scroll');
await ctx.close();

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
