// Browse > Select mode: range selection (Shift+click, Shift+Space, Ctrl+A, long-press on touch).
// Run with: node tests/browser/run.mjs rangeselect
import { chromium } from './pw.mjs';
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

const open = async (touch) => {
  const ctx = await browser.newContext(touch ? { viewport: { width: 390, height: 1600 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const cards = Array.from({ length: 200 }, (_, i) => ({ id: 'c' + String(i).padStart(3, '0'), deckId: 'R', front: (i % 2 ? 'odd ' : 'even ') + i, back: 'back ' + i, tags: [], created: i + 1 }));
    await db.addDeckWithCards({ id: 'R', name: 'Range', color: '#5B48E8', created: Date.now() }, cards);
    await db.deleteCards((await db.getAll('cards')).filter(c => c.deckId !== 'R').map(c => c.id));      // (only the 200 test cards)
  });
  await p.goto('about:blank'); await p.goto(URL + '#/browse'); await p.waitForSelector('.crow');
  await p.click('#brSelect');
  return p;
};
const sel = p => p.evaluate(() => [...document.querySelectorAll('.crow.selected')].map(r => r.dataset.id));
const row = (p, i) => p.locator(`.crow[data-id="c${String(i).padStart(3, '0')}"] .crow-btn`);
const idsOf = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => 'c' + String(a + k).padStart(3, '0'));
const same = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());
const focusedId = p => p.evaluate(() => document.activeElement.closest('.crow')?.dataset.id);
const count = p => p.textContent('#brSel');

// ---------- desktop ----------
{
  const p = await open(false);
  ok((await p.textContent('#brHint')).includes('Shift-click'), 'mouse hint is shown in Select mode');
  ok(await p.isVisible('#brHint'), 'hint is visible');
  await row(p, 2).click();
  await row(p, 5).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), idsOf(2, 5)), 'shift-click down selects anchor..target');
  ok((await count(p)) === '4 selected', 'count says 4 selected');
  ok((await p.getAttribute('#brList .crow[data-id="c003"] .crow-btn', 'aria-checked')) === 'true', 'aria-checked set on range rows');
  ok((await focusedId(p)) === 'c005', 'focus stays on the shift-clicked row (no redraw)');
  ok((await p.evaluate(() => getSelection().toString())) === '', 'no text selected by shift-click');
  // Anchor stays at 2: shift-click upward
  await row(p, 0).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), [...idsOf(0, 5)]), 'shift-click up from the same anchor extends to 0..2 (3..5 stay)');
  // Plain click moves the anchor; shift-click upward
  await row(p, 20).click(); await row(p, 17).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), [...idsOf(0, 5), ...idsOf(17, 20)]), 'shift-click in the other direction (up)');
  // Deselect a range: click on a selected row (deselects it, becomes anchor), shift-click another
  await row(p, 3).click();       // deselect 3
  await row(p, 1).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), [0, ...idsOf(4, 5).map(x => +x.slice(1)), ...[17, 18, 19, 20]].map(x => typeof x === 'number' ? 'c' + String(x).padStart(3, '0') : x)), 'shift-click after un-ticking the anchor un-ticks the range (1..3)');
  // Shift+click with no anchor behaves like a normal click
  await p.click('#brSelect'); await p.click('#brSelect');
  await row(p, 9).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), ['c009']), 'shift-click with no anchor = normal click');
  // Show more: range across the page boundary
  await p.click('#brSelect'); await p.click('#brSelect');
  ok((await p.locator('.crow').count()) === 150, 'one page drawn (150)');
  await row(p, 140).click();
  // use keyboard-free approach: draw more first to click target, but ALSO test undrawn targets via Select all of range
  await p.click('#brMore');
  ok((await p.locator('.crow').count()) === 200, 'Show more drew the rest');
  await row(p, 160).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), idsOf(140, 160)), 'range across the page boundary');
  // Ctrl+A with only one page drawn: all 200 are selected, and the rows "Show more" draws later are already ticked
  await p.click('#brSelect'); await p.click('#brSelect');
  await p.fill('#brQuery', 'zzz'); await p.fill('#brQuery', '');       // (a new search starts again at one page)
  await p.waitForFunction(() => document.querySelectorAll('.crow').length === 150);
  await row(p, 145).click();
  await p.keyboard.press('Control+a');
  ok((await sel(p)).length === 150 && (await count(p)) === '200 selected', 'Ctrl+A selects all 200 (150 drawn)');
  await p.click('#brMore');
  ok((await sel(p)).length === 200, 'rows drawn by Show more are already ticked');
  // Shift-click with the target on the first page and anchor too, undrawn rows in between are impossible; but a range to the last drawn row works
  await p.click('#brSelect'); await p.click('#brSelect');
  await p.fill('#brQuery', 'zzz'); await p.fill('#brQuery', '');
  await p.waitForFunction(() => document.querySelectorAll('.crow').length === 150);
  // Filtered / searched list: hidden rows untouched
  await p.click('#brSelect'); await p.click('#brSelect');
  await p.fill('#brQuery', 'odd'); await p.waitForFunction(() => document.querySelectorAll('.crow').length === 100);
  await p.locator('.crow', { hasText: 'odd 3' }).first().locator('.crow-btn').click();
  await p.locator('.crow', { hasText: 'odd 11' }).first().locator('.crow-btn').click({ modifiers: ['Shift'] });
  const oddSel = await sel(p);
  ok(same(oddSel, ['c003', 'c005', 'c007', 'c009', 'c011']), 'search: only the odd rows between are selected');
  await p.fill('#brQuery', ''); await p.waitForFunction(() => document.querySelectorAll('.crow').length === 150);
  ok(same(await sel(p), ['c003', 'c005', 'c007', 'c009', 'c011']), 'hidden even rows were not touched');
  // Bulk action acts on exactly the selected ids
  await p.click('#brActions'); await p.waitForSelector('#sheet [data-act], #sheet button');
  const bulk = await p.evaluate(() => document.querySelector('#sheet')?.textContent || '');
  ok(/5 cards|5 selected|5/.test(bulk), 'bulk sheet refers to 5 cards');
  await p.keyboard.press('Escape');
  // Flag them and check the db
  await p.evaluate(() => document.getElementById('sheet')?.querySelector('.sheet-x')?.click());
  await p.click('#brActions');
  const flagBtn = p.locator('#sheet [data-flag="1"]');
  if (await flagBtn.count()) {
    await flagBtn.first().click(); await p.waitForTimeout(500);
    const flagged = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.flag === 1).map(c => c.id).sort());
    ok(same(flagged, ['c003', 'c005', 'c007', 'c009', 'c011']), 'bulk flag changed exactly the selected ids');
  } else ok(false, 'bulk sheet has a flag button');
  await p.close();
}
// ---------- only drawn rows; anchor reset; Ctrl+A from the bar ----------
{
  const p = await open(false);
  await p.click('#brMore');
  await row(p, 170).click();
  await p.fill('#brQuery', 'zzz'); await p.fill('#brQuery', '');
  await p.waitForFunction(() => document.querySelectorAll('.crow').length === 150);
  await row(p, 5).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), ['c005']), 'after a search resets the page, the old anchor is gone: Shift+click is a plain click (only c005 drawn-selected)');
  ok((await count(p)) === '2 selected', 'nothing undrawn was added');
  await p.focus('#brAll'); await p.keyboard.press('Control+a');
  ok((await count(p)) === '200 selected', 'Ctrl+A with focus on the bulk bar selects all');
  await p.focus('#brSelect'); await p.keyboard.press('Control+a');
  ok((await count(p)) === '200 selected', 'Ctrl+A on the Select/Cancel button selects all');
  ok((await p.getAttribute('#brList', 'aria-describedby')) === 'brHint', 'list is described by the hint');
  ok((await p.textContent('#brHint')).includes('Shift+Space'), 'hint mentions the keyboard');
  await p.close();
}
// ---------- keyboard ----------
{
  const p = await open(false);
  await row(p, 10).click();
  await row(p, 13).focus();
  await p.keyboard.press('Shift+Space');
  ok(same(await sel(p), idsOf(10, 13)), 'Shift+Space selects the range from the anchor');
  ok((await focusedId(p)) === 'c013', 'focus stays on the row after Shift+Space');
  await row(p, 15).focus();
  await p.keyboard.press('Shift+Enter');
  ok(same(await sel(p), idsOf(10, 15)), 'Shift+Enter extends the range');
  ok((await p.locator('#sheet.open, #sheet[open]').count()) === 0, 'no card panel opened');
  await row(p, 12).focus(); await p.keyboard.press('Space');
  ok(!(await sel(p)).includes('c012'), 'plain Space still toggles a row');
  await p.keyboard.press('Control+a');
  ok((await count(p)) === '200 selected', 'Ctrl+A selects all in the list');
  await p.keyboard.press('Control+a');
  ok((await count(p)) === '200 selected', 'Ctrl+A again keeps everything selected');
  // Ctrl+A in the search box is left alone
  await p.click('#brSelect'); await p.click('#brSelect');
  await p.fill('#brQuery', 'abc'); await p.focus('#brQuery'); await p.keyboard.press('Control+a');
  ok((await count(p)) === '0 selected', 'Ctrl+A in the search box does not select cards');
  await p.close();
}
// ---------- shift-click outside Select mode ----------
{
  const p = await open(false);
  await p.click('#brSelect');   // leave Select mode
  await row(p, 4).click({ modifiers: ['Shift'] });
  ok((await p.getAttribute('#brList .crow[data-id="c004"] .crow-btn', 'role')) === 'checkbox' && same(await sel(p), ['c004']), 'Shift+click outside Select mode enters it with that row ticked');
  ok((await p.locator('#ceForm').count()) === 0, 'and does not open the panel');
  ok((await focusedId(p)) === 'c004', 'focus on that row');
  await row(p, 7).click({ modifiers: ['Shift'] });
  ok(same(await sel(p), idsOf(4, 7)), 'then Shift+click extends from it');
  await p.click('#brSelect'); await row(p, 4).click(); await p.waitForSelector('#ceForm');
  ok(true, 'plain click outside Select mode still opens the panel');
  await p.close();
}
// ---------- touch ----------
{
  const p = await open(true);
  ok((await p.textContent('#brHint')).includes('press and hold'), 'touch hint is shown');
  const cdp = await p.context().newCDPSession(p);
  const press = async (i, ms, move = 0) => {
    const b = await row(p, i).boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (move) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + move }] });
    await p.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(100);
  };
  await row(p, 1).tap();
  ok(same(await sel(p), ['c001']), 'tap selects one row');
  await press(4, 700);
  ok(same(await sel(p), idsOf(1, 4)), 'long-press selects from the anchor to the row');
  ok((await focusedId(p)) === 'c004' && (await count(p)) === '4 selected', 'row 4 stays focused and count updated (no toggle by the lift)');
  await press(6, 150);
  ok(same(await sel(p), [...idsOf(1, 4), 'c006']), 'a short press is just a tap');
  ok((await p.evaluate(() => getSelection().toString())) === '', 'no text selection');
  const cs = await p.evaluate(() => { const s = getComputedStyle(document.querySelector('.crow-btn')); return (s.webkitTouchCallout || s.getPropertyValue('-webkit-touch-callout')) + '|' + (s.userSelect || s.webkitUserSelect); });
  ok(/none$/.test(cs) , 'rows are user-select:none in Select mode (' + cs + ')');
  await press(9, 700, 40);
  ok(!(await sel(p)).includes('c009'), 'a press that moves (scrolling) does nothing');
  // long-press, then a cancel with no click: a later keyboard Space still selects the row
  await p.click('#brSelect'); await p.click('#brSelect');
  await p.evaluate(() => { const b = document.querySelector('.crow[data-id="c012"] .crow-btn'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 5, clientY: 5 })); });
  await p.waitForTimeout(600);
  await p.evaluate(() => { document.querySelector('.crow[data-id="c012"] .crow-btn').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' })); });
  await row(p, 14).focus(); await p.keyboard.press('Space');
  ok((await sel(p)).includes('c014'), 'a long-press that ended in a cancel does not swallow the next keyboard Space');
  await p.close();
}
ok(errors.length === 0, 'no page errors ' + errors.join(';'));
await browser.close();
