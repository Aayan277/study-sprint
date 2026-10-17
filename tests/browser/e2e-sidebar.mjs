// The desktop sidebar (v3.9): Add cards, a Today count, an exam dot on Decks, a Decks list, a footer (goal ring and streak,
// sync, Settings, light/dark, collapse) and the collapsed 72px icon rail. At 1440x900 and 1024x768; phones keep their tab bar.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const DAY = 86400000;
const URL = 'http://localhost:8123/';
const open = async (w, h, { touch = false, init = null } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: touch, hasTouch: touch });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return p;
};
const box = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; });
const go = async (p, hash, sel) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(sel); await p.waitForTimeout(200); };
const redraw = p => p.evaluate(async () => { await (await import('./js/sidebar.js')).drawSidebar(); });
// n study days from now: the day starts at 4am (days.js), so before 04:00 "today" is still yesterday's date.
const iso = n => { const d = new Date(Date.now() - 4 * 3600000); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// What a CSS colour token is right now (as the browser writes a computed colour), to compare with what an element uses.
const token = (p, name, prop = 'color') => p.evaluate(([n, pr]) => { const s = document.createElement('i'); s.style[pr] = `var(${n})`; document.body.append(s); const c = getComputedStyle(s)[pr]; s.remove(); return c; }, [name, prop]);

// The library: the same six courses as the design preview, with due cards, exams, and subdecks that must not show.
async function seed(p) {
  await p.evaluate(async () => {
    const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
    const iso = n => { const d = new Date(now - 4 * 3600000); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const cards = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `${id} q${i}`, back: `${id} a${i}`, tags: [], created: i }));
    const defs = [['bio', 'Cell Biology', '#46A758', 5, 3], ['org', 'Organic Chemistry', '#12A594', 2, 4], ['eco', 'Microeconomics', '#3E63DD', null, 6],
      ['neu', 'Neuroscience', '#8E4EC6', 23, 2], ['spa', 'Spanish B1 Vocabulary', '#F76B15', 12, 2], ['lin', 'Linear Algebra', '#D6409F', null, 0]];
    let k = 0;
    for (const [id, name, color, ex, n] of defs) await db.addDeckWithCards({ id, name, color, created: now + ++k, ...(ex != null ? { examDate: iso(ex) } : {}) }, cards(id, n));
    await db.addDeckWithCards({ id: 'bio1', name: 'Cell Biology: Unit 1', parentId: 'bio', color: '#46A758', created: now + 20 }, cards('bio1', 2));
    const st = cardId => ({ cardId, due: now - D, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D, scheduledDays: 3, elapsedDays: 3, learningSteps: 0 });
    // due reviews: Cell Biology 3, Organic Chemistry 4, Microeconomics 6 (the rest are new)
    await db.putMany('cardStates', [...cards('bio', 3), ...cards('org', 4), ...cards('eco', 6)].map(c => st(c.id)));
    // a streak: answers today and the two days before
    await db.putMany('reviewLog', [0, 1, 2].map(i => ({ cardId: 'bio0', timestamp: now - 60000 - i * D, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true })));
  });
}

// ============================ 1440 x 900 ============================
let p = await open(1440, 900, { init: () => { document.addEventListener('DOMContentLoaded', () => { window.__railAtDCL = document.documentElement.getAttribute('data-rail'); }); } });
await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero, .empty');
await seed(p);
await p.reload(); await p.waitForSelector('#startBtn'); await p.waitForSelector('.side-deck');
await p.waitForTimeout(300);

let nav = await box(p, '.tabs');
ok(nav.x === 0 && nav.w === 248 && nav.h > 800, 'sidebar: 248px wide from 1280px');
ok(!(await p.isVisible('#gearBtn')), 'the gear has left the header on a computer');
ok(await p.isVisible('.top .brand') && !(await p.locator('.top .icon-btn:visible').count()), 'the header holds only the logo');
ok(await p.isVisible('.side-add') && (await p.textContent('.side-add')).trim() === 'Add cards', 'a quiet "Add cards" button under the logo');

// the Decks section is told apart from the Decks link
ok(await p.locator('nav.tabs a[data-tab="decks"]').count() === 1 && (await p.getByRole('button', { name: 'Your decks' }).count()) === 1, 'the Decks link and the "Your decks" heading have different names');
ok((await p.textContent('#sideDecksH')).trim() === 'Decks', 'the heading says "Decks", not "Courses"');
ok(await p.evaluate(() => !/courses/i.test(document.querySelector('.side-decks').textContent)), 'the word "Courses" appears nowhere in the list');

// the Today badge is the number on Start
const startN = +(await p.textContent('#startBtn')).match(/Start · (\d+) card/)[1];
const badge = +(await p.textContent('#sideBadge > [aria-hidden]'));
ok(startN > 0 && badge === startN, `Today badge ${badge} equals the Start button's ${startN}`);
ok(/cards? to study/.test(await p.textContent('#sideBadge')), 'the badge has a spoken label');
ok((await p.textContent('.tab[data-tab=today]')).includes('Today'), 'the Today link still reads Today');

// the exam dot and pills
ok(await p.isVisible('#sideDot') && (await p.getAttribute('#sideDot', 'class')).includes('soon'), 'an exam in 2 days: the Decks dot is shown and red');
ok((await p.$eval('#sideDot', e => getComputedStyle(e).backgroundColor)) === await token(p, '--again', 'backgroundColor'), 'the red dot uses the crimson token');
const pill = k => p.$eval(`.side-deck[data-key="${k}"] .side-exam`, e => ({ text: e.textContent, color: getComputedStyle(e).color, cls: e.className })).catch(() => null);
const orgPill = await pill('org'), bioPill = await pill('bio');
ok(orgPill?.text === '2d' && orgPill.color === await token(p, '--again'), 'Organic Chemistry: red "2d" pill (exam within 3 days)');
ok(bioPill?.text === '5d' && bioPill.color === await token(p, '--exam') && !bioPill.cls.includes('soon'), 'Cell Biology: amber "5d" pill');
ok((await pill('spa'))?.text === '12d', 'an exam 12 days away shows a pill (14 days or fewer)');
ok(!(await pill('neu')) && !(await pill('eco')), 'no pill for an exam 23 days away, or for none');
// the dot turns amber from 3 to 7 days, and goes at more than 7
await p.evaluate(async d => { const db = await import('./js/db.js'); const decks = await db.getDecks(); await db.saveDeck({ ...decks.find(x => x.id === 'org'), examDate: d }); }, iso(6));
await redraw(p);
ok(await p.isVisible('#sideDot') && !(await p.getAttribute('#sideDot', 'class')).includes('soon') && (await p.$eval('#sideDot', e => getComputedStyle(e).backgroundColor)) === await token(p, '--exam', 'backgroundColor'), 'nearest exam 5 days away: amber dot');
await p.evaluate(async () => { const db = await import('./js/db.js'); for (const id of ['org', 'bio']) { const d = (await db.getDecks()).find(x => x.id === id); await db.saveDeck({ ...d, examDate: '' }); } });
await redraw(p);
ok(await p.isHidden('#sideDot'), 'no exam within 7 days: no dot');
await p.evaluate(async ([d2, d5]) => { const db = await import('./js/db.js'); const decks = await db.getDecks(); await db.saveDeck({ ...decks.find(x => x.id === 'org'), examDate: d2 }); await db.saveDeck({ ...decks.find(x => x.id === 'bio'), examDate: d5 }); }, [iso(2), iso(5)]);
await redraw(p);

// the list: top-level decks in tree order, with due counts
const rows = await p.$$eval('.side-deck[data-key]:not(.side-new)', r => r.map(x => ({ key: x.dataset.key, name: x.querySelector('.side-name').textContent, due: x.querySelector('.side-due').textContent, stripe: getComputedStyle(x, '::before').backgroundColor })));
ok(rows.map(r => r.key).join() === 'sample,bio,org,eco,neu,spa,lin', 'the list is the top-level decks in tree order (no subdecks): ' + rows.map(r => r.key));
ok(rows.find(r => r.key === 'org').due === '4' && rows.find(r => r.key === 'eco').due === '6' && rows.find(r => r.key === 'lin').due === '0', 'each row shows its due count');
ok(rows.find(r => r.key === 'bio').stripe === 'rgb(70, 167, 88)', 'each row has its deck colour stripe');
ok((await p.textContent('.side-decks')).includes('New deck'), 'the list ends with "+ New deck"');
ok((await p.getAttribute('.side-deck[data-key=org]', 'aria-label')).includes('4 cards due') && (await p.getAttribute('.side-deck[data-key=org]', 'aria-label')).includes('exam in 2 days'), 'a row says its due count and exam to a screen reader');

// clicking a deck opens it and highlights it
await p.click('.side-deck[data-key=eco]'); await p.waitForSelector('main[data-route=deck]');
ok(p.url().endsWith('#/deck/eco'), 'clicking a deck opens it');
ok(await p.locator('.side-deck[aria-current="page"]').count() === 1 && (await p.getAttribute('.side-deck[aria-current="page"]', 'data-key')) === 'eco', 'and marks it aria-current');
ok((await p.getAttribute('.tab[data-tab=decks]', 'aria-current')) === 'true', 'the Decks link is current too, as the section ("true"; the deck row holds "page")');
await p.click('.side-deck[data-key=bio]'); await p.waitForSelector('main[data-route=deck] h1'); await p.waitForFunction(() => location.hash.endsWith('/bio') && document.querySelector('.side-deck[data-key=bio]')?.getAttribute('aria-current') === 'page');   // v4.9: wait for the move (the old deck page also has an h1)
ok((await p.locator('.side-deck[aria-current="page"]').count()) === 1 && (await p.getAttribute('.side-deck[aria-current="page"]', 'data-key')) === 'bio', 'the highlight moves to the next deck');
await go(p, '#/stats', 'main[data-route=stats] .card');
ok(await p.locator('.side-deck[aria-current]').count() === 0 && (await p.getAttribute('.tab[data-tab=stats]', 'aria-current')) === 'page', 'on another screen no deck is highlighted');

// + New deck
await p.click('.side-new'); await p.waitForSelector('#deckForm');
ok((await p.textContent('#sheetTitle')) === 'New deck', '+ New deck opens the new-deck editor');
await p.fill('#deckName', 'Zoology');
await p.click('button[type=submit][form=deckForm]');
await p.waitForSelector('main[data-route=deck] h1');
const zoo = await p.waitForSelector('.side-deck:has-text("Zoology")');
ok(/#\/deck\//.test(p.url()) && (await zoo.getAttribute('aria-current')) === 'page', 'after saving, the sidebar lists the new deck and it is current');
// a rename elsewhere shows up (refresh after deck edits)
await p.evaluate(async () => { const m = await import('./js/decks.js'); const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === 'Zoology'); await m.openDeckEditor(d, () => {}); });
await p.fill('#deckName', 'Zoology 2'); await p.click('button[type=submit][form=deckForm]');
await p.waitForSelector('.side-deck:has-text("Zoology 2")');
ok(true, 'renaming a deck updates the list');

// + Add cards
await p.click('.side-add'); await p.waitForSelector('main[data-route=import]');
ok(p.url().endsWith('#/import'), '+ Add cards goes to Import');
ok((await p.getAttribute('.tab[data-tab=decks]', 'aria-current')) === 'page', 'Import counts as the Decks section');

// the heading folds the list, remembered after a reload
await go(p, '#/today', '#startBtn');
await p.click('#sideDecksH');
ok((await p.getAttribute('#sideDecksH', 'aria-expanded')) === 'false' && !(await p.isVisible('.side-deck[data-key=bio]')), 'the Decks heading folds the list');
await p.reload(); await p.waitForSelector('#startBtn'); await p.waitForSelector('.side-new', { state: 'attached' });
ok((await p.getAttribute('#sideDecksH', 'aria-expanded')) === 'false' && !(await p.isVisible('.side-deck[data-key=bio]')), 'and it stays folded after a reload (kept per device)');
await p.click('#sideDecksH');
ok(await p.isVisible('.side-deck[data-key=bio]') && (await p.getAttribute('#sideDecksH', 'aria-expanded')) === 'true', 'the heading opens it again');

// the footer: ring and streak
const streakText = await p.textContent('#sideStreak');
ok(/3-day streak/.test(streakText) && (await p.getAttribute('#sideStreak', 'aria-label')).startsWith('3-day streak'), 'footer: "3-day streak" from the log');
ok((await box(p, '#sideStreak .ring')).w === 30, 'the goal ring is 30px');
ok(await p.$eval('#sideStreak .ring-fg', e => !!e).catch(() => false), 'the ring shows today\'s answers over the daily goal');
ok(/1 of \d+ today/.test(streakText), 'and says how many answers: ' + streakText.replace(/\s+/g, ' ').trim());

// sync status
ok((await p.textContent('#sideSync')).trim() === 'Sign in to sync', 'signed out: "Sign in to sync"');
await p.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.setSetting('syncAuth', { user: { email: 'a@b.c', id: 'u1' }, access_token: 'x', refresh_token: 'y' });
  await db.setSetting('syncState', { lastSync: Date.now() - 5 * 60000 });
  dispatchEvent(new CustomEvent('sync', { detail: { state: 'done', applied: 0 } }));
});
await p.waitForFunction(() => /Synced/.test(document.getElementById('sideSync').textContent));
ok((await p.textContent('#sideSync')).trim() === 'Synced 5m ago', 'signed in: "Synced 5m ago" (the wording of Settings)');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('syncAuth', null); await db.setSetting('syncState', null); dispatchEvent(new CustomEvent('sync', { detail: { state: 'signed-out' } })); });
await p.waitForFunction(() => /Sign in/.test(document.getElementById('sideSync').textContent));
ok(true, 'signing out brings "Sign in to sync" back');

// Settings: the link, the version, going back
const ver = (await p.textContent('#sideVer')).trim();
await go(p, '#/decks', '.deck');
await p.click('#sideSet'); await p.waitForSelector('#skins');
ok((await p.getAttribute('#sideSet', 'aria-current')) === 'page' && (await p.getAttribute('#sideSet', 'aria-label')) === 'Close settings', 'Settings link: highlighted, and "Close settings" while open');
ok(ver === 'v' + (await p.textContent('.note.mono:has-text("Study Sprint")')).match(/(\d+(?:\.\d+)+)/)[1], `the footer shows the app version (${ver})`);
await p.click('#sideSet'); await p.waitForSelector('.deck');
ok(p.url().endsWith('#/decks') && (await p.getAttribute('#sideSet', 'aria-label')) === 'Settings', 'clicking it again closes Settings and goes back');

// light / dark
ok((await p.getAttribute('html', 'data-theme')) === 'dark' && (await p.getAttribute('#sideMode', 'aria-label')) === 'Switch to light mode', 'dark to begin with; the button offers light');
await p.click('#sideMode');
ok((await p.getAttribute('html', 'data-theme')) === 'light' && (await p.getAttribute('#sideMode', 'aria-label')) === 'Switch to dark mode', 'the toggle switches to light');
await p.screenshot({ path: `${SP}/desk/sidebar-1440-light.png` });
const saved = await p.evaluate(async () => ({ ls: JSON.parse(localStorage.getItem('study-sprint-theme')).mode, db: (await (await import('./js/db.js')).getSettings()).theme.mode }));
ok(saved.ls === 'light' && saved.db === 'light', 'and saves it (device copy and settings)');
await p.reload(); await p.waitForSelector('.side-deck');
ok((await p.getAttribute('html', 'data-theme')) === 'light', 'it is still light after a reload');
await go(p, '#/settings', '#skins');
ok(await p.isChecked('input[name=mode][value=light]'), 'Settings → Appearance shows Light');
await p.click('#sideMode');
ok(await p.isChecked('input[name=mode][value=dark]'), 'the toggle while Settings is open moves its Mode choice');
await p.click('.chip:has(input[value=auto])');
await p.click('#sideMode');
const afterAuto = await p.evaluate(async () => ({ mode: (await (await import('./js/db.js')).getSettings()).theme.mode, theme: document.documentElement.dataset.theme }));
ok(['light', 'dark'].includes(afterAuto.mode) && afterAuto.mode === afterAuto.theme, `Auto becomes an explicit ${afterAuto.mode} when toggled`);
if (afterAuto.theme !== 'dark') await p.click('#sideMode');
await go(p, '#/today', '#startBtn');

// a Review round refreshes the sidebar (counts and ring)
const before = { badge: +(await p.textContent('#sideBadge > [aria-hidden]')), eco: await p.textContent('.side-deck[data-key=eco] .side-due') };
await p.click('[data-start="eco"]'); await p.waitForSelector('#flash');
for (let i = 0; i < 6; i++) { await p.keyboard.press('Space'); await p.keyboard.press('3'); await p.waitForTimeout(60); }
await p.waitForSelector('.stats4');
await p.waitForFunction(() => document.querySelector('.side-deck[data-key=eco] .side-due').classList.contains('zero'));
const afterRound = +(await p.textContent('#sideBadge > [aria-hidden]'));
ok(before.eco === '6' && afterRound === before.badge - 6, `after a round the count drops (Today ${before.badge} to ${afterRound}) and Microeconomics shows no due`);
ok(/7 of/.test(await p.textContent('#sideStreak')), 'and the ring counts the answers');
await go(p, '#/today', '#startBtn');

// the badge hides at 0
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'empty', name: 'Empty', color: '#999999', created: Date.now() + 99 }, []); await db.setSetting('reviewDecks', ['empty']); });
await p.reload(); await p.waitForSelector('.side-deck');
ok(await p.isHidden('#sideBadge'), 'the Today badge is hidden at 0');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('reviewDecks', []); });
await p.reload(); await p.waitForSelector('#sideBadge:not([hidden])');

// many decks scroll inside the list, with a fade
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  for (let i = 0; i < 24; i++) await db.addDeckWithCards({ id: 'x' + i, name: 'Extra deck number ' + i, color: '#8E4EC6', created: now + 200 + i }, []);
});
await p.reload(); await p.waitForSelector('.side-deck[data-key=x23]', { state: 'attached' });
await p.waitForTimeout(200);
const sc = await p.$eval('#sideList', e => ({ scroll: e.scrollHeight, client: e.clientHeight, more: e.classList.contains('more'), mask: getComputedStyle(e).maskImage !== 'none' }));
ok(sc.scroll > sc.client + 100 && sc.more && sc.mask, 'many decks scroll inside the list with a fade');
ok((await box(p, '#sideFoot')).b <= 900 && (await box(p, '#sideCollapse')).b <= 900 && (await box(p, '.tabs')).b <= 900, 'the footer stays on screen');
await p.$eval('#sideList', e => { e.scrollTop = e.scrollHeight; });
await p.waitForTimeout(100);
ok(!(await p.$eval('#sideList', e => e.classList.contains('more'))), 'the fade goes at the end of the list');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '1440: no sideways scroll');
await p.evaluate(async () => { const db = await import('./js/db.js'); for (let i = 0; i < 24; i++) await db.deleteDeck('x' + i); });
await p.reload(); await p.waitForSelector('.side-deck[data-key=bio]');
await p.screenshot({ path: `${SP}/desk/sidebar-1440.png` });

// ---------- the deck page's own tree column: hidden while the sidebar is open (Round 2 A4), a column beside the icon rail ----------
await go(p, '#/deck/bio', '#deckMore');
ok(!(await p.isVisible('.deck-tree')), 'sidebar open: the deck page has no tree column of its own');
await p.click('#sideCollapse'); await p.waitForTimeout(150);
ok(await p.isVisible('.deck-tree') && Math.round((await box(p, '.deck-tree')).x) === 72, 'icon rail: the deck page shows its deck-tree column, next to the rail');
await p.click('#sideCollapse'); await p.waitForTimeout(150);

// ---------- keyboard order follows the visual order ----------
await go(p, '#/today', '#startBtn');
// the first Tab stop is "Skip to page"; Enter moves focus to the page (and leaves the URL alone)
await p.reload(); await p.waitForSelector('#startBtn'); await p.waitForSelector('.side-deck');      // a fresh page: focus starts at the top
await p.keyboard.press('Tab');
ok(await p.evaluate(() => document.activeElement.classList.contains('skip') && document.activeElement.textContent === 'Skip to page'), 'the first Tab stop is the "Skip to page" link');
ok((await box(p, '.skip')).y >= 0, 'and it is visible once focused');
await p.keyboard.press('Enter');
ok(await p.evaluate(() => document.activeElement === document.querySelector('main')) && p.url().endsWith('#/today'), 'Enter moves focus to the page, and the address stays');
await p.evaluate(() => document.activeElement?.blur());
await p.evaluate(() => document.querySelector('.top .brand').focus());
const order = [];
for (let i = 0; i < 40; i++) {
  const here = await p.evaluate(() => { const a = document.activeElement, r = a.getBoundingClientRect(); return { inNav: !!a.closest('nav.tabs'), inTop: !!a.closest('.top'), top: r.top, id: a.id || a.dataset.key || a.dataset.tab || a.className, text: (a.getAttribute('aria-label') || a.textContent).trim().slice(0, 24) }; });
  if (!here.inNav && !here.inTop) break;
  order.push(here);
  await p.keyboard.press('Tab');
}
const ids = order.map(o => o.id.split(' ')[0]);
ok(ids[0] === 'brand' && ids[1] === 'side-add' && ids.slice(2, 6).join() === 'today,decks,play,stats' && ids[6] === 'sideDecksH', 'Tab order: logo, Add cards, the four sections, the Decks heading: ' + ids.slice(0, 8));
ok(ids.slice(-6).join() === 'new,sideStreak,sideSync,sideSet,sideMode,sideCollapse', 'then + New deck and the footer: streak, sync, Settings, light/dark, collapse: ' + ids.slice(-6));
ok(order.slice(1).every((o, i) => o.top >= order[i].top - 1), 'every Tab stop is at or below the one before (top to bottom): ' + order.length + ' stops');
ok(await p.evaluate(() => !document.activeElement.closest('nav.tabs') && document.activeElement !== document.body), 'the stop after the sidebar is in the page');
const mainFirst = await p.evaluate(() => { const a = document.activeElement; return a.closest('main') ? 'main' : a.tagName; });
ok(mainFirst === 'main', 'the page follows the sidebar');

// ---------- contrast (AA) in dark, light and OLED for every accent ----------
await go(p, '#/deck/bio', '#deckMore');
await p.evaluate(async iso2 => { const db = await import('./js/db.js'); const dk = (await db.getDecks()).find(x => x.id === 'org'); await db.saveDeck({ ...dk, examDate: iso2 }); }, iso(2));
await redraw(p);
const contrast = () => p.evaluate(() => {
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = c => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1); };
  const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] === 1) break; } } let out = [0, 0, 0, 1]; for (const l of layers.reverse()) out = over(l, out); return out; };
  const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const bad = [], seen = [];
  for (const el of document.querySelectorAll('.top *, nav.tabs *')) {
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!text || r.width <= 1 || r.height <= 1 || cs.visibility === 'hidden' || cs.fontSize === '0px' || el.closest('[hidden]') || el.closest('[aria-hidden="true"]') && !el.matches('[aria-hidden="true"]')) continue;
    const bg = bgOf(el), fg = over(rgba(cs.color), bg), cr = ratio(fg, bg);
    seen.push(text);
    if (cr < 4.5) bad.push(`${text.slice(0, 20)} ${cr.toFixed(2)}`);
  }
  // keyboard focus ring: the accent on the sidebar background
  const side = rgba(getComputedStyle(document.querySelector('nav.tabs')).backgroundColor), acc = rgba(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#000');
  const ring = ratio(over(acc, side), side);
  return { bad, n: seen.length, ring };
});
const skins = ['violet', 'ocean', 'forest', 'ember', 'rose'];
const modes = [['dark', false], ['light', false], ['dark', true]];
let worst = 99, texts = 0; const fails = [];
for (const route of ['#/deck/bio', '#/today', '#/settings']) for (const skin of skins) for (const [mode, oled] of modes) {
  if (skin === 'violet' && mode === 'dark' && !oled) await go(p, route, route === '#/today' ? '#startBtn' : route === '#/settings' ? '#skins' : '#deckMore');       // the current link differs per screen
  await p.evaluate(([s, m, o]) => { const r = document.documentElement; r.setAttribute('data-skin', s); r.setAttribute('data-theme', m); if (o) r.setAttribute('data-oled', 'on'); else r.removeAttribute('data-oled'); }, [skin, mode, oled]);
  const c = await contrast();
  texts = Math.max(texts, c.n); worst = Math.min(worst, c.ring);
  if (c.bad.length || c.ring < 3) fails.push(`${route} ${skin}/${mode}${oled ? '/oled' : ''}: ${c.bad.join('; ')} ring ${c.ring.toFixed(2)}`);
}
ok(fails.length === 0 && texts > 20, `sidebar text passes 4.5:1 and focus ring 3:1 in 5 accents x dark/light/OLED (Today, a deck and Settings current; ${texts} texts checked, worst ring ${worst.toFixed(2)})` + (fails.length ? ' ' + fails.join(' | ') : ''));
await p.evaluate(() => { const r = document.documentElement; r.setAttribute('data-skin', 'violet'); r.setAttribute('data-theme', 'dark'); r.removeAttribute('data-oled'); });

// ---------- the collapsed rail ----------
await go(p, '#/today', '#startBtn');
await p.click('#sideCollapse');
await p.waitForTimeout(150);
nav = await box(p, '.tabs');
ok(nav.w === 72 && (await box(p, 'main')).x >= 72 && (await box(p, 'main')).x < 200, 'collapsed: a 72px icon rail, and the page moves left to fill the room');
ok((await p.getAttribute('#sideCollapse', 'aria-expanded')) === 'false' && (await p.getAttribute('#sideCollapse', 'aria-label')) === 'Expand sidebar', 'the toggle now says "Expand sidebar"');
ok(!(await p.isVisible('.side-name >> nth=0')) || (await p.$eval('.side-name', e => getComputedStyle(e.parentElement).fontSize)) === '0px', 'icons only: no names');
ok((await box(p, '#sideBadge')).w === 7 && (await box(p, '#sideBadge')).h === 7, 'the Today count becomes a dot');
ok(await p.isVisible('#sideDot') && (await box(p, '#sideDot')).w === 7, 'the Decks exam dot stays');
// the sync line is hidden in the rail: a problem shows as a dot on the Settings icon
const setDot = () => p.evaluate(() => getComputedStyle(document.getElementById('sideSet'), '::after').display);
ok((await setDot()) === 'none', 'rail: no dot on Settings while sync is fine');
await p.evaluate(async () => {
  const db = await import('./js/db.js'), sync = await import('./js/sync.js');
  await db.setSetting('syncAuth', { user: { email: 'a@b.c', id: 'u1' }, access_token: 'x', refresh_token: 'y' });
  Object.assign(sync.lastStatus(), { state: 'error', error: 'offline', at: 0 });
  dispatchEvent(new CustomEvent('sync', { detail: { state: 'error' } }));
});
await p.waitForFunction(() => document.getElementById('sideSet').classList.contains('warn'));
ok((await setDot()) === 'block' && (await p.getAttribute('#sideSet', 'data-tip')).includes("Couldn't sync"), 'rail: a sync problem puts a warn dot on the Settings icon (and in its tooltip)');
await p.evaluate(async () => {
  const db = await import('./js/db.js'), sync = await import('./js/sync.js');
  Object.assign(sync.lastStatus(), { state: 'idle', error: null });
  await db.setSetting('syncAuth', null);
  dispatchEvent(new CustomEvent('sync', { detail: { state: 'signed-out' } }));
});
await p.waitForFunction(() => !document.getElementById('sideSet').classList.contains('warn'));
ok((await setDot()) === 'none', 'rail: the dot goes when sync is fine or signed out');
const dotInfo = await p.$$eval('.side-deck[data-key]:not(.side-new)', r => r.map(x => { const b = getComputedStyle(x, '::before'); return { key: x.dataset.key, w: b.width, shadow: b.boxShadow }; }));
ok(dotInfo.every(d => d.w === '10px'), 'decks are colour dots');
const ringOf = k => dotInfo.find(d => d.key === k).shadow;
ok(ringOf('org').includes((await token(p, '--again', 'color'))) && ringOf('bio').includes(await token(p, '--exam', 'color')) && ringOf('eco') === 'none', 'amber and red rings for close exams, none otherwise');
await p.hover('.side-deck[data-key=bio]');
await p.waitForSelector('.side-tip:not([hidden])');
ok((await p.textContent('.side-tip')) === 'Cell Biology · 3 due · 5d', 'tooltip: ' + await p.textContent('.side-tip'));
await p.mouse.move(800, 400);
await p.keyboard.press('Tab'); await p.evaluate(() => document.querySelector('.side-deck[data-key=eco]').focus());
await p.waitForSelector('.side-tip:not([hidden])');
ok((await p.textContent('.side-tip')) === 'Microeconomics · 0 due', 'the tooltip also shows on keyboard focus');
await p.keyboard.press('Escape');
ok(await p.isHidden('.side-tip'), 'Escape dismisses it');
ok(!(await p.isVisible('#sideSync')) && await p.isVisible('#sideSet') && await p.isVisible('#sideMode') && await p.isVisible('#sideStreak'), 'footer: ring, Settings, light/dark and the toggle stay; the text goes');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && (await box(p, '#sideCollapse')).b <= 900, 'the rail fits');
await p.click('.side-deck[data-key=org]'); await p.waitForSelector('main[data-route=deck] h1');
ok((await p.getAttribute('.side-deck[data-key=org]', 'aria-current')) === 'page', 'in the rail the open deck is highlighted too');
await go(p, '#/stats', 'main[data-route=stats] .card');
await p.screenshot({ path: `${SP}/desk/sidebar-rail.png` });
await p.reload(); await p.waitForSelector('.side-deck');
ok((await box(p, '.tabs')).w === 72 && (await p.getAttribute('html', 'data-rail')) === 'on', 'the rail is remembered after a reload');
ok((await p.evaluate(() => window.__railAtDCL)) === 'on', 'and it is set before the page draws (no flash)');
await p.click('#sideCollapse'); await p.waitForTimeout(100);
ok((await box(p, '.tabs')).w === 248 && !(await p.getAttribute('html', 'data-rail')), 'expanding goes back to 248px');
await p.reload(); await p.waitForSelector('.side-deck');
ok((await box(p, '.tabs')).w === 248, 'and that is remembered too');

// ============================ 1024 x 768 ============================
await p.setViewportSize({ width: 1024, height: 768 });
await go(p, '#/today', '#startBtn');
nav = await box(p, '.tabs');
ok(nav.w === 232 && (await box(p, 'main')).x === 232, '1024: the sidebar is 232px');
ok(await p.isVisible('.side-add') && await p.isVisible('#sideFoot') && (await box(p, '#sideFoot')).b <= 768 && await p.isVisible('.side-deck[data-key=bio]'), '1024x768: everything fits (Add cards, the list, the footer)');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '1024: no sideways scroll');
await p.screenshot({ path: `${SP}/desk/sidebar-1024.png` });
await p.setViewportSize({ width: 1100, height: 800 });
ok((await box(p, '.tabs')).w === 232, '1100: still 232px');
await p.setViewportSize({ width: 1280, height: 800 });
ok((await box(p, '.tabs')).w === 248, '1280: 248px');
await p.setViewportSize({ width: 1279, height: 800 });
ok((await box(p, '.tabs')).w === 232, '1279: 232px');
// the sidebar draws when the window grows to a computer, and the nav sits before the page for the keyboard
ok(await p.evaluate(() => document.querySelector('nav.tabs').nextElementSibling === document.getElementById('screen')), 'on a computer the sidebar comes before the page in the document');
await p.context().close();

// ============================ phone ============================
p = await open(375, 740, { touch: true, init: () => { try { localStorage.setItem('study-sprint-rail', '1'); } catch { /* fine */ } } });
await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero, .empty');
await seed(p);
await p.reload(); await p.waitForSelector('#startBtn');
await p.waitForTimeout(300);
nav = await box(p, '.tabs');
ok(nav.w === 375 && nav.y > 600, 'phone: the tab bar is still along the bottom (even with the rail remembered)');
ok(!(await p.isVisible('.side-add')) && !(await p.isVisible('.side-decks')) && !(await p.isVisible('#sideFoot')) && !(await p.isVisible('#sideBadge')) && !(await p.isVisible('#sideDot')), 'phone: no sidebar pieces');
ok(await p.isVisible('#gearBtn') && (await p.textContent('.top')).includes('Study Sprint'), 'phone: the header keeps its gear');
ok(await p.evaluate(() => document.documentElement.scrollWidth) <= 375, 'phone: scrollWidth is at most 375');
ok(await p.evaluate(() => document.getElementById('sideList').children.length === 0 && document.querySelector('main').nextElementSibling === document.querySelector('nav.tabs')), 'phone: nothing drawn into the list, and the tab bar stays after the page');
await p.click('#gearBtn'); await p.waitForSelector('#skins');
ok((await p.getAttribute('#gearBtn', 'aria-label')) === 'Close settings', 'phone: the gear still opens and closes Settings');
await p.click('#gearBtn'); await p.waitForSelector('#startBtn');
ok(p.url().endsWith('#/today'), 'phone: and goes back');
await p.screenshot({ path: `${SP}/desk/sidebar-phone.png` });
await p.context().close();

// always-dark skins have nothing to toggle (their names are kept for old saved themes; the picker no longer offers them)
{
  const q = await open(1440, 900);
  await q.goto(URL + '#/today'); await q.waitForSelector('#sideMode');
  ok(await q.evaluate(async () => { const t = await import('./js/themes.js'); return ['neon', 'onyx', 'kuro'].every(t.isAlwaysDark) && !t.isAlwaysDark('violet'); }), 'isAlwaysDark: neon, onyx and kuro, not violet');
  ok(!(await q.getAttribute('#sideMode', 'aria-disabled')), 'a normal skin: the toggle is enabled');
  await q.context().close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
