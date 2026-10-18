// The resizable card editor panel (js/panel-resize.js) and Duplicate (card panel and Browse bulk actions).
// Screenshots: <out>/desk/panel-<original|clinical>-<light|dark>.png
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const URL = 'http://localhost:8123/';

const open = async ({ width = 1440, height = 900, ui = 'original', mode = 'light', phone = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(t => { try { if (!localStorage.getItem('study-sprint-theme')) localStorage.setItem('study-sprint-theme', JSON.stringify(t)); } catch { /* fine */ } }, { ui, skin: 'violet', mode });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.stack));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
  {
    await page.evaluate(async t => { await (await import('./js/db.js')).setSetting('theme', t); }, { ui, skin: 'violet', mode, oled: false });
    await page.reload(); await page.waitForSelector('.deck');
  }
  return page;
};
const box = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cards = p => p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')));
const openPanel = async (p, n = 0) => { await p.locator('.crow').nth(n).click(); await p.waitForSelector('#ceForm'); await p.waitForSelector('#panelResizer', { state: 'visible' }); };
const width = p => p.$eval('#sheet', e => Math.round(e.getBoundingClientRect().width));
const dragTo = async (p, x) => {
  const b = await box(p, '#panelResizer');
  await p.mouse.move(b.x + b.w / 2, 400); await p.mouse.down(); await p.mouse.move(x, 400, { steps: 6 }); await p.mouse.up();
};

// ---------------------------------------------------------------- resizing
let p = await open();
await p.goto(URL + '#/deck/sample'); await p.waitForSelector('.crow');
ok(await p.locator('#panelResizer').count() === 1 && !(await p.isVisible('#panelResizer')), 'the divider exists but is hidden while no panel is open');
await openPanel(p);
const first = await width(p);
ok(first === 400, 'the deck page panel starts at its default (400px), got ' + first);
const sep = p.locator('#panelResizer');
ok(await sep.getAttribute('role') === 'separator' && await sep.getAttribute('tabindex') === '0' && await sep.getAttribute('aria-orientation') === 'vertical', 'the divider is a focusable vertical separator');
ok(await sep.getAttribute('aria-valuenow') === '400' && await sep.getAttribute('aria-valuemin') === '360', 'aria-valuenow and aria-valuemin set');
const edge = await box(p, '#sheet');
const bar = await box(p, '#panelResizer');
ok(Math.abs(bar.x + bar.w / 2 - edge.x) <= 2, 'the divider sits on the editor panel\'s left edge');

await dragTo(p, 840);                                   // the editor becomes 1440 - 840 = 600 wide
ok(Math.abs((await width(p)) - 600) <= 2, 'dragging resizes the editor: ' + await width(p));
ok(Math.abs(Number(await sep.getAttribute('aria-valuenow')) - 600) <= 2, 'aria-valuenow follows');
ok(await p.evaluate(() => { const m = document.querySelector('main').getBoundingClientRect(); return m.right <= innerWidth - 590; }), 'the list narrows with it');
ok(Math.abs(Number(await p.evaluate(() => localStorage.getItem('study-sprint-panel-w'))) - 600) <= 2, 'the width is saved on this device');
await p.reload(); await p.waitForSelector('.crow'); await openPanel(p);
ok(Math.abs((await width(p)) - 600) <= 2, 'the width survives a reload: ' + await width(p));

// limits: not below 360, not above 70% of the window (1008) and the list keeps 320px
await dragTo(p, 1400);
ok((await width(p)) === 360, 'clamped at the minimum, 360px: ' + await width(p));
await dragTo(p, 5);
const wide = await width(p);
const listLeft = await p.$eval('main', m => parseFloat(getComputedStyle(m).marginLeft));
ok(wide <= 1008 && wide >= 800 && 1440 - listLeft - wide >= 319, `clamped at the maximum (70% and a 320px list): ${wide}`);
ok(await p.$eval('main', m => { const r = m.getBoundingClientRect(); return r.width - (parseFloat(getComputedStyle(m).paddingLeft) + parseFloat(getComputedStyle(m).paddingRight)) >= 0; }), 'the list is still laid out');

// keyboard: arrows resize by 24px
await dragTo(p, 940);                                   // 500
const before = await width(p);
await sep.focus();
await p.keyboard.press('ArrowLeft');
ok((await width(p)) === before + 24, 'ArrowLeft makes the editor 24px wider: ' + before + ' -> ' + await width(p));
await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight');
ok((await width(p)) === before - 24, 'ArrowRight makes it 24px narrower');
ok(Number(await sep.getAttribute('aria-valuenow')) === before - 24, 'aria-valuenow follows the keys');
for (let i = 0; i < 20; i++) await p.keyboard.press('ArrowRight');
ok((await width(p)) === 360, 'keys stop at the minimum');
await p.keyboard.press('End');
ok((await width(p)) === Number(await sep.getAttribute('aria-valuemax')), 'End goes to the widest');
const keyed = await p.evaluate(() => localStorage.getItem('study-sprint-panel-w'));
ok(Number(keyed) === await width(p), 'keyboard changes are saved too');

await sep.dblclick();
ok((await width(p)) === 400 && (await p.evaluate(() => localStorage.getItem('study-sprint-panel-w'))) === null, 'double-click goes back to the default and forgets the saved width');
await p.reload(); await p.waitForSelector('.crow'); await openPanel(p);
ok((await width(p)) === 400, 'after the reset a reload opens at the default');

// a blocked storage does not break anything: the panel still resizes, it just is not remembered
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {      // reading or writing the panel's key fails, like a blocked or full storage
    for (const m of ['getItem', 'setItem', 'removeItem']) { const was = Storage.prototype[m]; Storage.prototype[m] = function (k, ...r) { if (k === 'study-sprint-panel-w') throw new Error('blocked'); return was.call(this, k, ...r); }; }
  });
  const b = await ctx.newPage();
  b.on('pageerror', e => errors.push('blocked storage: ' + e.stack));
  await b.goto(URL + '#/deck/sample'); await b.waitForSelector('.crow');
  await openPanel(b); await dragTo(b, 800);
  ok(Math.abs((await width(b)) - 640) <= 2, 'with storage blocked the panel still resizes');
  await ctx.close();
}

// the all-cards screen too
await p.goto(URL + '#/browse'); await p.waitForSelector('.crow');
await openPanel(p);
ok((await width(p)) === 440, 'All cards: its own default (440px), got ' + await width(p));
await dragTo(p, 800);
ok(Math.abs((await width(p)) - 640) <= 2, 'All cards resizes too');
await p.context().close();

// screenshots
for (const ui of ['original', 'clinical']) for (const mode of ['light', 'dark']) {
  const s = await open({ ui, mode });
  await s.goto(URL + '#/deck/sample'); await s.waitForSelector('.crow');
  await openPanel(s, 1);
  await dragTo(s, 780);
  await s.hover('#panelResizer');
  await s.waitForTimeout(250);
  ok(await s.evaluate(() => document.documentElement.dataset.ui) === ui, `${ui} ${mode}: style applied`);
  ok(await s.$eval('#panelResizer', e => getComputedStyle(e, '::before').backgroundColor !== 'rgba(0, 0, 0, 0)'), `${ui} ${mode}: the divider shows when hovered`);
  await s.screenshot({ path: `${SP}/desk/panel-${ui}-${mode}.png` });
  await s.context().close();
}
{
  const s = await open({ ui: 'clinical' });
  await s.goto(URL + '#/deck/sample'); await s.waitForSelector('.crow'); await openPanel(s);
  ok(await s.$eval('#panelResizer', e => getComputedStyle(e, '::before').backgroundColor !== 'rgba(0, 0, 0, 0)'), 'Clinical: the divider rule is visible even when not hovered');
  await s.context().close();
}

// ---------------------------------------------------------------- not on a phone, and not in a pop-up width
p = await open({ width: 375, height: 740, phone: true });
await p.goto(URL + '#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceForm');
ok(!(await p.isVisible('#panelResizer')) && await p.evaluate(() => document.querySelector('#sheet').matches(':modal')), 'phone: no divider, the sheet is unchanged');
await p.context().close();
p = await open({ width: 1100, height: 800 });
await p.goto(URL + '#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceForm');
ok(!(await p.isVisible('#panelResizer')), '1100px (the editor is a pop-up): no divider');
await p.context().close();
// Review's side panel has no divider
p = await open();
await p.goto(URL + '#/review'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#showBtn');
await p.click('#moreBtn'); await p.waitForSelector('.act-list');
ok(!(await p.isVisible('#panelResizer')), 'Review\'s side panel has no divider');
await p.context().close();

// ---------------------------------------------------------------- duplicate
p = await open();
await p.goto(URL + '#/deck/sample'); await p.waitForSelector('.crow');
// give the first card the full set of extras
const src = await p.evaluate(async () => {
  const db = await import('./js/db.js');
  const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
  const c = { ...cs[0], tags: ['alpha', 'beta'], noteExtra: 'my hook', acceptAnswers: ['other answer'], frontImage: 'imgF', backImage: 'imgB', flag: 3, suspended: true };
  await db.saveCards([c]);
  await db.putStates([{ cardId: c.id, due: Date.now() + 86400000 * 5, stability: 9, difficulty: 3, reps: 4, lapses: 0, state: 2 }]);
  return c;
});
await p.reload(); await p.waitForSelector('.crow');
const total0 = (await cards(p)).length;
await p.locator(`.crow[data-id="${src.id}"]`).click(); await p.waitForSelector('#ceForm');
ok(await p.isVisible('#sheet [data-act=duplicate]'), 'the card panel has Duplicate');
await p.click('#sheet [data-act=duplicate]');
await p.waitForFunction(n => document.querySelectorAll('.crow').length === n, total0 + 1);
ok((await p.textContent('#toast')).startsWith('Duplicated. Editing the copy.') && (await p.locator('#toast .toast-link').textContent()) === 'Undo', 'toast says "Duplicated. Editing the copy." with Undo');
let all = await cards(p);
const copy = all.find(c => c.id !== src.id && c.front === src.front && c.back === src.back);
ok(!!copy && copy.deckId === src.deckId && copy.tags.join() === 'alpha,beta' && copy.noteExtra === 'my hook' && copy.acceptAnswers.join() === 'other answer' && copy.frontImage === 'imgF' && copy.backImage === 'imgB', 'the copy has the same deck, fields, tags, pictures, hook and accepted answers');
ok(!copy.flag && !copy.suspended && !copy.buriedUntil, 'and none of the original\'s flag, suspend or bury');
const st = await p.evaluate(async id => (await import('./js/db.js')).get('cardStates', id), copy.id);
ok(!st, 'the copy has a fresh schedule (new)');
ok(await p.locator('.crow.sel').getAttribute('data-id') === copy.id && (await p.inputValue('#ceTags').catch(() => null)) === 'alpha, beta', 'the copy is open in the editor');
ok(!!(await p.evaluate(async id => (await import('./js/db.js')).get('cardStates', id), src.id)), 'the original keeps its schedule');
// Undo
await p.click('#toast .toast-link');
await p.waitForFunction(n => document.querySelectorAll('.crow').length === n, total0);
ok((await cards(p)).length === total0 && !(await cards(p)).some(c => c.id === copy.id), 'Undo removes the copy');
ok(!(await p.evaluate(() => document.querySelector('#sheet').open)), 'and closes its editor');

// a cloze note is copied whole
await p.evaluate(async () => {
  const db = await import('./js/db.js');
  const d = (await db.getAll('decks'))[0];
  await db.saveNote({ add: [{ cloze: 1, front: 'The {{c1::heart}} pumps {{c2::blood}}', back: 'x', noteText: 'The {{c1::heart}} pumps {{c2::blood}}' }, { cloze: 2, front: 'y', back: 'z', noteText: 'The {{c1::heart}} pumps {{c2::blood}}' }] }, { deckId: d.id, noteId: 'NOTE1', tags: ['bio'], noteExtra: 'ex' });
});
await p.reload(); await p.waitForSelector('.crow');
const n1 = (await cards(p)).length;
await p.locator('.crow', { hasText: 'heart' }).first().click(); await p.waitForSelector('#ceForm');
await p.click('#sheet [data-act=duplicate]');
await p.waitForFunction(n => document.querySelectorAll('.crow').length === n, n1 + 2);
all = await cards(p);
const newNotes = all.filter(c => c.noteId && c.noteId !== 'NOTE1' && c.noteText);
ok(newNotes.length === 2 && new Set(newNotes.map(c => c.noteId)).size === 1 && newNotes.map(c => c.cloze).sort().join() === '1,2' && newNotes.every(c => c.tags.join() === 'bio' && c.noteExtra === 'ex'), 'a cloze note is duplicated whole under a new noteId');
ok(await p.locator('.crow.sel').count() === 1 && newNotes.some(c => c.id === null) === false, 'a copy is open in the editor');
await p.click('#toast .toast-link');
await p.waitForFunction(n => document.querySelectorAll('.crow').length === n, n1);

// bulk
await p.click('#brSelect');
await p.locator('.crow').nth(0).click(); await p.locator('.crow').nth(1).click();
await p.click('#brActions'); await p.waitForSelector('#sheet [data-act=duplicate]');
const n2 = (await cards(p)).length;
await p.click('#sheet [data-act=duplicate]');
await p.waitForFunction(n => document.querySelectorAll('.crow').length === n, n2 + 2);
ok((await p.textContent('#toast')).startsWith('Duplicated 2 cards') && (await cards(p)).length === n2 + 2, 'bulk Duplicate copies the selected cards, with an Undo toast');
await p.click('#toast .toast-link');
await p.waitForFunction(n => document.querySelectorAll('.crow').length === n, n2);
ok((await cards(p)).length === n2, 'bulk Undo removes them');
await p.context().close();

// a width chosen wide on one screen, or before the window shrank, never squeezes the list
{
  const w = await open();
  await w.goto(URL + '#/browse'); await w.waitForSelector('.crow'); await openPanel(w);
  await dragTo(w, 5);
  const saved = await w.evaluate(() => Number(localStorage.getItem('study-sprint-panel-w')));
  await w.goto(URL + '#/deck/sample'); await w.waitForSelector('.crow'); await openPanel(w);
  const left = () => w.$eval('main', m => parseFloat(getComputedStyle(m).marginLeft) || 0);
  const listRoom = async () => innerWidthOf(w) - (await left()) - (await width(w));
  const innerWidthOf = pg => pg.viewportSize().width;
  ok(await listRoom() >= 319, 'the deck page keeps a 320px list after dragging wide on All cards: ' + await listRoom());
  ok(await w.evaluate(() => Number(localStorage.getItem('study-sprint-panel-w'))) === saved, 'and the stored preference is unchanged');
  await w.setViewportSize({ width: 1100, height: 900 });
  await w.waitForTimeout(200);
  const nw = await width(w);
  ok(nw <= 770 && nw >= 360 && await listRoom() >= 319, `a narrowed window re-clamps: panel ${nw}, list room ${await listRoom()}`);
  ok(Number(await w.getAttribute('#panelResizer', 'aria-valuenow')) === nw && (await w.getAttribute('#panelResizer', 'aria-valuetext')) === nw + ' pixels', 'aria-valuenow and aria-valuetext follow the clamp');
  ok(await w.evaluate(() => Number(localStorage.getItem('study-sprint-panel-w'))) === saved, 'narrowing does not overwrite the saved width');
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.waitForTimeout(200);
  ok(await width(w) > nw, 'widening the window gives the preferred width back');
  await w.context().close();
}

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
