// Fixes found in the layout pass's review: a tap on a sheet's header must not close it, Undo must not bring back an
// old version of an edited card, the short card sheet's E / - / @ keys work, a half-typed answer survives an edit,
// and a folded deck stays folded in the classic (Compact deck list off) layout.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const open = async (touch) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block', isMobile: touch, hasTouch: touch });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.stack));
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
  return p;
};
const seed = (p, cards = 3) => p.evaluate(async n => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'fx', name: 'Fixes', color: '#46A758', created: Date.now() },
    Array.from({ length: n }, (_, i) => ({ id: 'fx' + i, deckId: 'fx', front: `Q${i}`, back: `A${i}`, tags: [], created: i })));
}, cards);
const getCard = (p, id) => p.evaluate(async i => (await import('./js/db.js')).get('cards', i), id);

// ---- a tap on the sheet's header does not close it (touch) ----
let p = await open(true);
await seed(p, 3);
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#optBtn');
await p.click('#optBtn'); await p.waitForSelector('#sheet[open] #sheetTitle'); await p.waitForTimeout(500);
const t = await p.$eval('#sheetTitle', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await p.touchscreen.tap(t.x, t.y); await p.waitForTimeout(400);
ok(await p.evaluate(() => document.getElementById('sheet').open), 'a tap on the sheet title leaves the sheet open');
// Safari and Firefox aim the click at the dialog itself after a header tap (the pointer was captured there): the same event, by hand
await p.evaluate(({ x, y }) => document.getElementById('sheet').dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true })), t);
await p.waitForTimeout(300);
ok(await p.evaluate(() => document.getElementById('sheet').open), 'a click aimed at the dialog from inside its box does not close it');
await p.touchscreen.tap(195, 20); await p.waitForTimeout(500);
ok(await p.evaluate(() => !document.getElementById('sheet').open), 'a tap on the dim area outside still closes it');

// ---- E / - / @ in the short card sheet ----
p = await open(false);
await seed(p, 3);
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('[data-start="fx"]');
await p.click('[data-start="fx"]'); await p.waitForSelector('#flash');
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
await p.keyboard.press('e'); await p.waitForSelector('#ceForm');
ok(true, 'E in the short sheet opens the editor');
await p.click('#ceCancel'); await p.waitForFunction(() => !document.getElementById('sheet').open);
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
const first = await p.textContent('.flash-front');
await p.keyboard.press('-'); await p.waitForFunction(() => !document.getElementById('sheet').open);
await p.waitForTimeout(300);
const buried = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.buriedUntil).length);
ok(buried === 1 && (await p.textContent('.flash-front')) !== first, '- in the short sheet buries the card and moves on');
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
await p.keyboard.press('@'); await p.waitForFunction(() => !document.getElementById('sheet').open); await p.waitForTimeout(300);
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.suspended).length) === 1, '@ in the short sheet suspends the card');

// ---- edit mid-session, then Undo: the edit stays ----
p = await open(false);
await seed(p, 1);
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('[data-start="fx"]');
await p.click('[data-start="fx"]'); await p.waitForSelector('#flash');
await p.keyboard.press('Space'); await p.keyboard.press('1');           // Again: the only card comes straight back
await p.waitForFunction(() => document.querySelector('#flash:not(.flipped)') && document.querySelector('.rv-counts'));
await p.waitForTimeout(300);
await p.keyboard.press('e'); await p.waitForSelector('#ceForm');
await p.evaluate(async () => (await import('./js/card-editor.js')).setCardText('ceFront', 'EDITED'));
await p.evaluate(() => document.getElementById('ceForm').requestSubmit()); await p.waitForFunction(() => !document.getElementById('sheet').open); await p.waitForTimeout(300);
await p.click('#undoBtn'); await p.waitForTimeout(400);
ok((await p.textContent('.flash-front')).includes('EDITED'), 'Undo shows the edited card, not the old text');
await p.keyboard.press('e'); await p.waitForSelector('#ceForm');
ok((await p.evaluate(async () => (await import('./js/card-editor.js')).readCardText('ceFront'))).includes('EDITED'), 'and the editor opens with the edited text');
await p.evaluate(() => document.getElementById('ceForm').requestSubmit()); await p.waitForFunction(() => !document.getElementById('sheet').open); await p.waitForTimeout(300);
ok((await getCard(p, 'fx0')).front.includes('EDITED'), 'the edit is still saved after Undo and another save');

// ---- an edit keeps a half-typed answer ----
p = await open(false);
await seed(p, 2);
await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewTyping', true); location.hash = '#/today'; });
await p.waitForSelector('[data-start="fx"]'); await p.click('[data-start="fx"]'); await p.waitForSelector('#typeIn');
await p.fill('#typeIn', 'half an ans');
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.getElementById('sheet').open);
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
await p.click('[data-flag]'); await p.waitForFunction(() => !document.getElementById('sheet').open); await p.waitForTimeout(300);
ok((await p.inputValue('#typeIn')) === 'half an ans', 'flagging the card keeps the half-typed answer');

// ---- classic layout: a folded deck stays folded ----
p = await open(false);
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'par', name: 'Parent', color: '#46A758', created: now }, [{ id: 'par0', deckId: 'par', front: 'a', back: 'b', tags: [], created: 1 }]);
  await db.addDeckWithCards({ id: 'kid', name: 'Kid', parentId: 'par', color: '#46A758', created: now + 1 }, [{ id: 'kid0', deckId: 'kid', front: 'a', back: 'b', tags: [], created: 1 }]);
  await db.setSetting('compactDecks', false);
});
await p.reload(); await p.waitForSelector('details.subdecks[data-fold="par"]');
ok(await p.$eval('details.subdecks[data-fold="par"]', d => d.open), 'classic layout: subdecks start open');
await p.click('details.subdecks[data-fold="par"] summary'); await p.waitForTimeout(150);
await p.reload(); await p.waitForSelector('details.subdecks[data-fold="par"]');
ok(!(await p.$eval('details.subdecks[data-fold="par"]', d => d.open)), 'classic layout: a folded deck is still folded after a reload');

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors[0] : ''));
await browser.close();
