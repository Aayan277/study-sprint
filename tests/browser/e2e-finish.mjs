// Round 2 (1B): Review's finish screen (Keep going, links row, titles, #finishMore, answered/leech tracking), the Review bar
// (Undo only when possible, Speak in the card corner), key hints only with a mouse, the occlusion picture in Review,
// and two bugs: double-tapping Undo, and #/review/<empty or missing deck>.
// Run with: node tests/browser/run.mjs finish
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const DAY = 86400000;

const open = async (viewport, extra = {}) => {
  const p = await (await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'dark', serviceWorkers: 'block', ...extra })).newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  return p;
};
const noSideways = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll ' + what);
// Decks B (4 cards) and C (1 card), and Today scoped to one of them.
const seedDecks = (p, chosen) => p.evaluate(async chosen => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'B', name: 'Second', color: '#E5484D', created: now + 1 }, [1, 2, 3, 4].map(i => ({ id: 'b' + i, deckId: 'B', front: 'B front ' + i, back: 'B back ' + i, tags: [], created: i })));
  await db.addDeckWithCards({ id: 'C', name: 'Third', color: '#30A46C', created: now + 2 }, [{ id: 'c1', deckId: 'C', front: 'C front', back: 'C back', tags: [], created: 1 }]);
  await db.setSetting('reviewDecks', chosen);
}, chosen);
const goToday = async p => { await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn'); };
const answerOne = async (p, rate = 4) => { await p.click('#showBtn'); await p.click(`.rate.r${rate}`); await p.waitForFunction(() => !document.querySelector('.rate')); };

// ---------- 1. Keep going: the same session as Today's Start, with the same number as the sidebar (1440) ----------
let p = await open({ width: 1440, height: 900 });
await seedDecks(p, ['B']);
await goToday(p);
await p.click('#startBtn'); await p.waitForSelector('#flash');
await answerOne(p);
await p.click('#endBtn'); await p.waitForSelector('.finish-next');
const keep = await p.textContent('#keepBtn');
await p.waitForFunction(() => document.querySelector('#sideBadge span')?.textContent === '3'); const badge = (await p.textContent('#sideBadge span[aria-hidden]')).trim();
ok(/^Keep going · 3 cards$/.test(keep.trim()), 'Keep going · N cards after ending early: "' + keep.trim() + '"');
ok(keep.match(/(\d+) cards/)[1] === badge, 'Keep going N equals the sidebar badge (' + badge + ')');
ok(await p.$eval('#keepBtn', b => b.classList.contains('primary')) && await p.$eval('#againBtn', b => b.classList.contains('ghost')), 'Keep going is the primary button, Back to Today is ghost');
ok((await p.textContent('h1')).trim() === 'Session ended', 'ended early: the title says "Session ended"');
ok(!(await p.textContent('main')).includes('Nothing due tomorrow') && !(await p.locator('.fn-line:has(.ico-calendar), .fn-line:has-text("due tomorrow")').count()), 'no calendar line, and never "Nothing due tomorrow"');
ok(await p.locator('.fin-links a[href="#/decks"]').count() === 1 && await p.locator('.fin-links #undoLast').count() === 1, 'links row: Decks and Undo last');
ok(await p.locator('#finishMore').count() === 1 && await p.evaluate(() => { const m = document.querySelector('#finishMore'); return m.previousElementSibling?.compareDocumentPosition(m) & 4 && m.nextElementSibling?.classList.contains('finish-next'); }), '#finishMore sits before .finish-next, after the stats');
ok(await p.locator('.finish-next a[href="#/play"]').count() === 1, 'Play a round stays in the next-steps box');
await p.screenshot({ path: SP + '/finish-keep-1440.png' });
await p.click('#keepBtn'); await p.waitForSelector('#flash');
ok((await p.textContent('.flash-deck')).includes('Second') && (await p.textContent('.rv-counts')).replace(/\D+/g, ' ').trim().split(' ').map(Number).reduce((a, b) => a + b) === 3, 'Keep going opens a new session of Today\'s deck with the 3 cards left');
// The answered ids and the leech list feed #finishMore (data attributes on the slot, for the panels to read).
await answerOne(p); await p.click('#endBtn'); await p.waitForSelector('#finishMore', { state: 'attached' });
ok(await p.$eval('#finishMore', m => m.dataset.answered === '1' && m.dataset.leeches === '0'), 'finish slot knows 1 answered card, 0 leeches');
await p.click('#undoLast'); await p.waitForSelector('#flash');
await p.click('#endBtn'); await p.waitForSelector('#finishMore', { state: 'attached' });
ok(await p.$eval('#finishMore', m => m.dataset.answered === '0'), 'undo takes the card out of the answered set');
await noSideways(p, 'on the finish screen (1440)');
await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await p.screenshot({ path: SP + '/finish-keep-1440-light.png' });

// ---------- 2. Nothing left: Back to Today is the primary, "Nice work", Due tomorrow once ----------
p = await open({ width: 375, height: 740 }, { isMobile: true, hasTouch: true });
await seedDecks(p, ['C']);
await goToday(p);
await p.click('#startBtn'); await p.waitForSelector('#flash');
ok(await p.locator('#undoBtn').count() === 0, 'phone bar: no Undo button before the first answer');
await answerOne(p);
await p.waitForSelector('.finish-next');
ok(await p.locator('#keepBtn').count() === 0 && await p.$eval('#againBtn', b => b.classList.contains('primary')), 'nothing left: Back to Today is the primary and there is no Keep going');
ok((await p.textContent('h1')).trim() === 'Nice work', 'reviewed and nothing left: "Nice work"');
ok((await p.textContent('.stats4')).includes('Due tomorrow') && !(await p.textContent('main')).includes('Nothing due tomorrow'), 'Due tomorrow appears once, in the stats');
ok(await p.locator('#undoLast').count() === 1, 'Undo last is in the links row');
const rows = await p.$$eval('.res-actions > *', els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size);
ok(rows <= 2, 'at most 2 button rows at 375: ' + rows);
await noSideways(p, 'on the finish screen (375)');
await p.screenshot({ path: SP + '/finish-done-375.png', fullPage: true });
await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await p.screenshot({ path: SP + '/finish-done-375-light.png', fullPage: true });

// Keep going when there is more, at 375
await p.evaluate(() => { location.hash = '#/today'; });
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('reviewDecks', ['B']); });
await goToday(p);
await p.click('#startBtn'); await p.waitForSelector('#flash'); await answerOne(p); await p.click('#endBtn'); await p.waitForSelector('#keepBtn');
const rows2 = await p.$$eval('.res-actions > *', els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size);
ok(rows2 <= 2, 'with Keep going: at most 2 button rows at 375: ' + rows2);
await p.screenshot({ path: SP + '/finish-keep-375.png', fullPage: true });
await noSideways(p, 'on the finish screen with Keep going (375)');

// ---------- 3. The leech toast ----------
await p.evaluate(async DAY => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.setSetting('reviewDecks', ['C']);
  await db.putMany('cardStates', [{ cardId: 'c1', due: now - DAY, stability: 5, difficulty: 5, elapsedDays: 3, scheduledDays: 5, learningSteps: 0, reps: 9, lapses: 7, state: 2, lastReview: now - 5 * DAY }]);
}, DAY);
await goToday(p);
await p.click('#startBtn'); await p.waitForSelector('#flash');
await p.click('#showBtn'); await p.click('.rate.r1');
await p.waitForFunction(() => /Leech/.test(document.querySelector('#toast')?.textContent || ''));
ok((await p.textContent('#toast')).includes('Leech: suspended. You can fix it at the end of the session.'), 'leech toast: "' + (await p.textContent('#toast')).trim() + '"');
await p.waitForSelector('.finish-next');
ok(await p.$eval('#finishMore', m => m.dataset.leeches === '1' && m.dataset.answered === '1'), 'the leech is collected for the finish panels');
await p.click('#undoLast'); await p.waitForSelector('#flash');
await p.click('#endBtn'); await p.waitForSelector('#finishMore', { state: 'attached' });
ok(await p.$eval('#finishMore', m => m.dataset.leeches === '0'), 'undoing the leech answer takes it out of the leech list');

// ---------- 4. Bug 2: double-tapping Undo must not lose an entry ----------
await p.evaluate(async DAY => {
  const db = await import('./js/db.js');
  await db.setSetting('reviewDecks', ['B']);
  await db.putMany('cardStates', []);
}, DAY);
await p.click('#againBtn'); await p.waitForSelector('#startBtn');
await goToday(p);
await p.click('#startBtn'); await p.waitForSelector('#flash');
await answerOne(p); await answerOne(p);
const logsN = () => p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'review' && l.cardId.startsWith('b')).length);
const base = await logsN();
ok(base >= 2, 'answers logged: ' + base);
await p.evaluate(() => { const b = document.querySelector('#undoBtn'); b.click(); b.click(); });
await p.waitForFunction(() => document.querySelector('#flash') && !document.querySelector('.rate'));
await p.waitForTimeout(300);
ok(await logsN() === base - 1, 'double-tap Undo undoes exactly one answer: ' + base + ' → ' + await logsN());
ok(await p.locator('#undoBtn').count() === 1, 'the other answer can still be undone');
await p.click('#undoBtn'); await p.waitForFunction(async n => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'review' && l.cardId.startsWith('b')).length === n, base - 2);
ok(await p.locator('#undoBtn').count() === 0, 'after undoing both, the Undo button goes away');

// ---------- 5. Bug 9: an empty deck, and a deck that does not exist ----------
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ id: 'E', name: 'Empty one', color: '#8F80FF', created: Date.now() + 5 }); });
await p.goto(URL + '#/review/E'); await p.reload(); await p.waitForSelector('main .empty');
const emptyText = await p.textContent('main');
ok(emptyText.includes('No cards yet') && !emptyText.includes('All caught up'), '#/review/<empty deck> says "No cards yet"');
ok(await p.locator('a.btn.primary[href="#/import/E"]').count() === 1 && (await p.textContent('a.btn.primary[href="#/import/E"]')).includes('+ Add cards'), 'with a "+ Add cards" button that opens Import for that deck');
ok(!/REVIEW/.test(await p.textContent('main .screen-head')), 'no REVIEW eyebrow');
await p.goto(URL + '#/review/nope-not-a-deck'); await p.reload(); await p.waitForSelector('main .empty');
const missing = await p.textContent('main');
ok(missing.includes('Deck not found') && !missing.includes('This deck'), '#/review/<missing id> says "Deck not found"');
await noSideways(p, 'on the empty-deck screens');
await p.screenshot({ path: SP + '/review-empty-375.png' });

// ---------- 6. Speak in the card corner, Undo only when possible ----------
await p.goto(URL + '#/today'); await goToday(p);
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('reviewDecks', ['B']); });
await goToday(p);
await p.click('#startBtn'); await p.waitForSelector('#flash');
ok(await p.locator('#speakBtn').count() === 1 && await p.$eval('#speakBtn', b => !!b.closest('#flash') && b.classList.contains('rv-speak')), 'Read aloud is a button in the card corner (.rv-speak)');
ok(await p.locator('.rv-head #speakBtn').count() === 0, 'and no longer in the top bar');
const flipped = await p.evaluate(() => { document.querySelector('#speakBtn').click(); return document.querySelector('#flash').classList.contains('flipped'); });
ok(!flipped, 'pressing Speak does not flip the card');
const bar = await p.$$eval('.rv-head > *', els => els.map(e => e.id || e.className.split(' ')[0]));
ok(bar.join() === 'rv-counts,moreBtn,endBtn', 'phone bar before any answer: counts, more, End (' + bar.join() + ')');
await p.screenshot({ path: SP + '/review-bar-375.png' });
await answerOne(p);
ok((await p.$$eval('.rv-head > *', els => els.map(e => e.id || e.className.split(' ')[0]))).join() === 'rv-counts,undoBtn,moreBtn,endBtn', 'after an answer: counts, Undo, more, End');
await noSideways(p, 'in the Review bar');

// ---------- 7. Key hints only where there is a mouse ----------
const mouse = await open({ width: 800, height: 760 });
await seedDecks(mouse, ['B']); await goToday(mouse);
await mouse.click('#startBtn'); await mouse.waitForSelector('#flash');
ok(await mouse.isVisible('.key-line'), 'a mouse at 800px wide (under 1024) sees the key hint line');
ok(await mouse.isVisible('#showBtn .key-hint'), 'and the Space hint on Show answer');
const touch = await open({ width: 1100, height: 760 }, { hasTouch: true, isMobile: true });
await seedDecks(touch, ['B']); await goToday(touch);
await touch.click('#startBtn'); await touch.waitForSelector('#flash');
ok(await touch.isHidden('.key-line') && await touch.isHidden('#showBtn .key-hint'), 'a touch screen (no hover) never sees key hints, whatever its width');

// ---------- 8. Image occlusion in Review: bigger picture, light masks, header, small zoom ----------
const seedOcc = async q => q.evaluate(async () => {
  const db = await import('./js/db.js'), occ = await import('./js/occlusion.js'), media = await import('./js/media.js');
  const c = document.createElement('canvas'); c.width = 900; c.height = 600;
  const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 900, 600); g.fillStyle = '#c33'; g.fillRect(100, 100, 300, 200);
  const file = new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'a.png', { type: 'image/png' });
  const info = await media.addImageInfo(file, { maxSide: media.OCCLUSION_SIDE });
  const deck = { id: 'O', name: 'Diagram', color: '#8F80FF', created: Date.now() + 9 };
  await db.saveDeck(deck);
  const masks = [{ id: 'm1', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.2, label: 'Aorta' }, { id: 'm2', n: 2, shape: 'rect', x: 0.55, y: 0.5, w: 0.3, h: 0.3, label: 'Valve' }];
  await db.saveNote(occ.planOcclusionSave([], { masks, header: 'Heart anatomy', w: info.width, h: info.height, image: info.id }), { deckId: deck.id, noteId: db.newId(), tags: [] });
  await db.setSetting('reviewDecks', ['O']);
});
const occPhone = await open({ width: 375, height: 740 }, { isMobile: true, hasTouch: true });
await seedOcc(occPhone); await goToday(occPhone);
await occPhone.click('#startBtn'); await occPhone.waitForSelector('.rv-front .occ-img[src]');
const g = await occPhone.evaluate(() => {
  const card = document.querySelector('#flash').getBoundingClientRect(), occ = document.querySelector('.rv-front .occ').getBoundingClientRect();
  const z = document.querySelector('.rv-front .occ-zoom').getBoundingClientRect();
  const head = getComputedStyle(document.querySelector('.rv-front .occ-head'));
  return { cardW: card.width, occW: occ.width, zoomW: z.width, zoomOffRight: occ.right - z.right, zoomOffTop: z.top - occ.top, ls: head.letterSpacing, fs: parseFloat(head.fontSize), ff: head.fontFamily };
});
ok(g.occW >= g.cardW - 2 * 24 - 1, 'the diagram fills the card width (card ' + Math.round(g.cardW) + ', picture ' + Math.round(g.occW) + ')');
ok(g.zoomW === 32 && Math.round(g.zoomOffRight) === 6 && Math.round(g.zoomOffTop) === 6, 'the zoom button is 32px, 6px from the corner (' + g.zoomW + ')');
ok(g.ls === 'normal' || g.ls === '0px', 'diagram header has normal letter-spacing (' + g.ls + ')');
await occPhone.screenshot({ path: SP + '/occ-review-375-dark.png' });
// Light mode: a covered box must stand out from the (white) picture by at least 3:1.
await occPhone.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
const contrast = await occPhone.evaluate(() => {
  const m = [...document.querySelectorAll('.rv-front .occ-mask:not(.occ-ask)')][0];
  const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, 1, 1); g.fillStyle = getComputedStyle(m).backgroundColor; g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  const lum = (r, g, b) => [r, g, b].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
  return (1.05) / (lum(r, gr, b) + .05);
});
ok(contrast >= 3, 'light mode: covered boxes contrast >= 3:1 with the picture (' + contrast.toFixed(2) + ')');
await occPhone.screenshot({ path: SP + '/occ-review-375-light.png' });
await noSideways(occPhone, 'in occlusion Review');
const occDesk = await open({ width: 1440, height: 900 });
await seedOcc(occDesk); await goToday(occDesk);
await occDesk.click('#startBtn'); await occDesk.waitForSelector('.rv-front .occ-img[src]');
await occDesk.screenshot({ path: SP + '/occ-review-1440-dark.png' });
await occDesk.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await occDesk.screenshot({ path: SP + '/occ-review-1440-light.png' });

ok(errors.length === 0, 'no page errors or console errors ' + errors.join(' | '));
await browser.close();
