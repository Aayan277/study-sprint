// Customise Stats, the list sheet (Edit, then Edit as a list): the sheet (show/hide, move, size, reset), the page it builds at 1280 and 390 wide, and that it is kept after a
// reload. Both styles (Original and Clinical). Screenshots go in $SHOTS (or the run's out folder).
import { chromium } from './pw.mjs';
import fs from 'node:fs';
const SP = process.env.SHOTS || process.argv[2] || '/tmp';
fs.mkdirSync(SP, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const DEFAULT = ['Day streak', 'Retention', 'Retention vs target', 'Study calendar', 'Reviews per day', 'Due in the next 7 days', 'Hardest cards', 'Answer buttons', 'Time of day', 'Difficulty', 'Mastery'];

const open = async (ui, width, height) => {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', deviceScaleFactor: width < 600 ? 2 : 1, isMobile: width < 600, hasTouch: width < 600 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${ui}/${width} pageerror ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/katex|jsdelivr|Failed to load resource|net::ERR/i.test(m.text())) errors.push(`${ui}/${width} console ${m.text()}`); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ui => { const db = await import('./js/db.js'); await db.setSetting('theme', { ui, skin: 'violet', mode: 'dark', oled: false }); }, ui);
  await p.reload(); await p.waitForSelector('.deck');
  return p;
};
const stats = async p => { await p.goto('http://localhost:8123/#/stats'); await p.reload(); await p.waitForSelector('main[data-route=stats] .pgrid, .stats-none'); };
// The cards' titles as they sit on the page: top to bottom, left to right (what the eye sees).
const seen = p => p.$$eval('main[data-route=stats] .view .card h2', hs => hs.filter(h => h.offsetParent !== null && !h.closest('.ready-card')).map(h => { const r = h.closest('.card').getBoundingClientRect(); return { t: h.textContent.trim(), y: Math.round(r.top), x: Math.round(r.left) }; }).sort((a, b) => a.y - b.y || a.x - b.x).map(o => o.t));
const dom = p => p.$$eval('main[data-route=stats] .view .card h2', hs => hs.map(h => h.textContent.trim()));
const box = (p, title) => p.evaluate(t => { const h = [...document.querySelectorAll('main[data-route=stats] .view .card h2')].find(x => x.textContent.trim() === t); if (!h) return null; const r = h.closest('.card').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }; }, title);
// The list sheet is reached from edit mode (Edit, then "Edit as a list"); leaving it also leaves edit mode.
const openList = async p => { if (!(await p.$('#edBar'))) { await p.click('#editBtn, #editEmpty'); await p.waitForSelector('#edBar'); } await p.click('.ed-list'); await p.waitForSelector('#sheet[open] #slList'); };
const leave = async p => { if (await p.$('#edBar')) { await p.click('#edDone'); await p.waitForSelector('#editBtn'); } };
const saved = p => p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).statsLayout);

for (const ui of ['original', 'clinical']) {
  const tag = ui.slice(0, 4);
  // ---------------- computer ----------------
  let p = await open(ui, 1280, 900);
  await stats(p);
  ok(JSON.stringify(await seen(p)) === JSON.stringify(DEFAULT), `${tag} 1280: the default order`);
  ok(await p.isVisible('#editBtn') && !(await p.$('#customBtn')), `${tag}: an Edit button beside the deck picker`);
  const bb = await p.$eval('#editBtn', e => { const r = e.getBoundingClientRect(), s = document.querySelector('#sDeckBtn').getBoundingClientRect(); return { h: r.height, w: r.width, sameRow: Math.abs((r.top + r.height / 2) - (s.top + s.height / 2)) < 30 }; });
  ok(bb.h >= 44 && bb.w >= 44 && bb.sameRow, `${tag}: Edit is a 44px target on the picker's row`);
  await openList(p);
  ok(await p.$eval('#sheet', d => d.getAttribute('aria-labelledby') === 'sheetTitle' && d.querySelector('#sheetTitle').textContent === 'Customise Stats'), `${tag}: the sheet is a labelled dialog`);
  ok((await p.$$('#slList .sl-row')).length === 11, `${tag}: a row for each of the 11 cards`);
  ok(/Size applies on wider screens/.test(await p.textContent('#sheet')), `${tag}: the sheet says sizes apply on wider screens`);
  ok(await p.evaluate(() => [...document.querySelectorAll('#slList .sl-row')].every(r => r.querySelector('[data-act=show]').getAttribute('aria-label').startsWith('Show ') && (['rs', 'cal'].includes(r.dataset.id) ? !r.querySelector('[role=radiogroup]') : r.querySelector('[role=radiogroup]').getAttribute('aria-label')))), `${tag}: every row is labelled with the card name, and the two fixed-size cards have no size chips`);
  await p.screenshot({ path: `${SP}/sheet-desktop-${tag}.png` });
  // hide Difficulty
  await p.getByLabel('Show Difficulty').uncheck();
  await p.waitForFunction(() => !document.body.textContent.includes('FSRS\'s difficulty for each card'));
  ok(!(await seen(p)).includes('Difficulty'), `${tag}: hiding Difficulty removes it from the page behind the sheet`);
  // move Hardest cards up twice; the focus stays on the button, the live region says where it went
  await p.click('button[aria-label="Move Hardest cards up"]');
  await p.click('button[aria-label="Move Hardest cards up"]');
  ok(await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Move Hardest cards up'), `${tag}: the focus stays on the pressed move button`);
  await p.waitForFunction(() => document.querySelector('#slLive').textContent.includes('Hardest cards moved to position 5 of 11'));
  ok(true, `${tag}: announced "Hardest cards moved to position 5 of 11"`);
  ok((await p.$$eval('#slList .sl-row', r => r.map(x => x.dataset.id))).join() === 'streak,retention,rs,cal,hardest,perDay,forecast,buttons,hours,difficulty,mastery', `${tag}: the list shows the new order`);
  // keyboard: Enter on the down button
  await p.focus('button[aria-label="Move Hardest cards down"]'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('#slLive').textContent.includes('position 6 of 11'));
  await p.focus('button[aria-label="Move Hardest cards up"]'); await p.keyboard.press('Space');
  await p.waitForFunction(() => document.querySelector('#slLive').textContent.includes('position 5 of 11'));
  ok(true, `${tag}: the move buttons work from the keyboard`);
  // the first card's Up button is inert
  ok(await p.getAttribute('button[aria-label="Move Day streak up"]', 'aria-disabled') === 'true', `${tag}: the first card cannot move up`);
  // Mastery to Half (it has no half card to pair with, so it still fills its row)
  await p.locator('.sl-row[data-id=mastery] label.chip', { hasText: 'Half' }).click();
  await p.waitForFunction(() => document.querySelector('#slList .sl-row[data-id=mastery] input[value=half]')?.checked);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${SP}/sheet-desktop-${tag}-after.png` });
  await p.click('#slDone'); await p.waitForFunction(() => !document.querySelector('#sheet').open); await leave(p);
  let order = await seen(p);
  ok(JSON.stringify(order) === JSON.stringify(['Day streak', 'Retention', 'Retention vs target', 'Study calendar', 'Hardest cards', 'Reviews per day', 'Due in the next 7 days', 'Answer buttons', 'Time of day', 'Mastery']), `${tag} 1280: customised order on the page: ${order.join(' | ')}`);
  const cal = await box(p, 'Study calendar'), per = await box(p, 'Reviews per day'), rs = await box(p, 'Retention vs target'), mast = await box(p, 'Mastery'), hard = await box(p, 'Hardest cards'), hrs = await box(p, 'Time of day'), btn = await box(p, 'Answer buttons');
  ok(hard.w < rs.w * 0.6 && per.y === hard.y && hard.x < per.x && hard.y > cal.y, `${tag} 1280: Hardest cards moved up pairs with Reviews per day (${hard.w}px of ${rs.w}px)`);
  ok(btn.y !== hrs.y && hrs.y === mast.y && hrs.x < mast.x && mast.w < rs.w * 0.6, `${tag} 1280: a half Mastery pairs with the half card before it (Time of day)`);
  await p.screenshot({ path: `${SP}/page-desktop-${tag}.png`, fullPage: true });
  // kept after a reload
  await p.reload(); await p.waitForSelector('main[data-route=stats] .pgrid');
  ok(JSON.stringify(await seen(p)) === JSON.stringify(order), `${tag} 1280: kept after a reload`);
  const s = await saved(p);
  ok(s && s.hidden.join() === 'difficulty' && s.size.mastery === 'half' && s.order.indexOf('hardest') === 4, `${tag}: saved as one setting { order, hidden, size }`);
  ok(await p.evaluate(async () => (await import('./js/sync-data.js')).SYNCED_SETTINGS.includes('statsLayout')), `${tag}: the setting is a synced one`);
  // reset asks first
  await openList(p);
  await p.click('#slReset');
  ok(await p.isVisible('#slConfirm') && /Reset to the default layout\?/.test(await p.textContent('#slConfirm')), `${tag}: Reset to default asks to confirm`);
  await p.click('#slNo');
  ok(JSON.stringify(await seen(p)) === JSON.stringify(order), `${tag}: "Keep my layout" changes nothing`);
  await p.click('#slReset'); await p.click('#slYes');
  await p.waitForFunction(d => document.querySelector('#slList .sl-row[data-id=mastery] input[value=full]')?.checked && [...document.querySelectorAll('main[data-route=stats] .view .card h2')].some(h => h.textContent === 'Difficulty'));
  await p.waitForTimeout(100);
  ok(JSON.stringify(await seen(p)) === JSON.stringify(DEFAULT), `${tag} 1280: Reset to default restores the order, all cards and the sizes`);
  ok((await saved(p)) === null, `${tag}: reset saves the default (null)`);
  ok(await p.evaluate(() => [...document.querySelectorAll('#slList .sl-row')].every(r => r.querySelector('[data-act=show]').checked)), `${tag}: the sheet's switches are all on again`);
  await p.keyboard.press('Escape');
  // junk saved: the default; hidden everything: friendly empty state
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('statsLayout', 'junk'); });
  await stats(p);
  ok(JSON.stringify(await seen(p)) === JSON.stringify(DEFAULT), `${tag}: a corrupt saved value shows the default`);
  await p.evaluate(async () => { const m = await import('./js/stats-layout.js'); await (await import('./js/db.js')).setSetting('statsLayout', { order: m.IDS, hidden: m.IDS, size: {} }); });
  await stats(p);
  ok(await p.isVisible('.stats-none') && (await p.$$('main[data-route=stats] .pgrid')).length === 0, `${tag}: every card hidden shows a friendly empty state`);
  await openList(p);
  ok(true, `${tag}: its Edit button starts edit mode and the list opens from there`);
  await p.getByLabel('Show Mastery').check();
  await p.waitForSelector('main[data-route=stats] .stats-mastery');
  ok(!(await p.isVisible('.stats-none')) && (await seen(p)).join() === 'Mastery', `${tag}: showing one card brings it back`);
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('statsLayout', null); });
  await p.context().close();

  // ---------------- phone ----------------
  p = await open(ui, 390, 800);
  await stats(p);
  const bp = await p.$eval('#editBtn', e => { const r = e.getBoundingClientRect(); return { h: r.height, right: r.right, vw: innerWidth }; });
  ok(bp.h >= 44 && bp.right <= bp.vw, `${tag} 390: Edit is at least 44px tall and on the screen`);
  await openList(p);
  ok(await p.evaluate(() => [...document.querySelectorAll('#slList button.sl-btn')].every(b => { const r = b.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })), `${tag} 390: the move buttons are 44px`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag} 390: no sideways scroll with the sheet open`);
  await p.screenshot({ path: `${SP}/sheet-phone-${tag}.png` });
  await p.getByLabel('Show Difficulty').uncheck();
  await p.click('button[aria-label="Move Hardest cards up"]'); await p.click('button[aria-label="Move Hardest cards up"]');
  await p.locator('.sl-row[data-id=mastery] label.chip', { hasText: 'Half' }).click();
  await p.waitForFunction(() => document.querySelector('#slList .sl-row[data-id=mastery] input[value=half]')?.checked);
  await p.waitForTimeout(150);
  await p.click('#slDone'); await p.waitForFunction(() => !document.querySelector('#sheet').open); await leave(p);
  // a phone keeps the "More stats" fold: Answer buttons, Time of day and Mastery are in it, after the cards that are not
  const d = await dom(p);
  ok(d.join() === ['Day streak', 'Retention', 'Retention vs target', 'Study calendar', 'Hardest cards', 'Reviews per day', 'Due in the next 7 days', 'Answer buttons', 'Time of day', 'Mastery'].join(), `${tag} 390: page order: ${d.join(' | ')}`);
  await p.click('#moreBtn');
  const widths = await p.evaluate(() => [...document.querySelectorAll('main[data-route=stats] .view .card')].filter(c => c.offsetParent && !c.closest('.pgrid')).map(c => Math.round(c.getBoundingClientRect().width)));
  ok(widths.length >= 7 && new Set(widths).size === 1, `${tag} 390: every card is full width on a phone, whatever its size (${[...new Set(widths)]})`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag} 390: no sideways scroll`);
  await p.screenshot({ path: `${SP}/page-phone-${tag}.png`, fullPage: true });
  await p.reload(); await p.waitForSelector('main[data-route=stats] .pgrid');
  ok((await dom(p)).join() === d.join(), `${tag} 390: kept after a reload`);
  await p.context().close();

  // ---------------- drag to reorder ----------------
  const ids = p => p.$$eval('#slList .sl-row', r => r.map(x => x.dataset.id));
  const centre = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const stay = (p, n) => p.evaluate(n => new Promise(r => setTimeout(r, n)), n);
  p = await open(ui, 1280, 900);
  await stats(p);
  await openList(p);
  ok(await p.$eval('.sl-grip', e => e.getBoundingClientRect().height >= 44 && getComputedStyle(e).touchAction === 'none'), `${tag}: each row has a grip at least 44px tall with touch-action none`);
  ok(await p.$eval('#slList', e => getComputedStyle(e).touchAction !== 'none'), `${tag}: the rest of the list still scrolls by touch`);
  // mouse: drag Time of day up three rows, above Due in the next 7 days
  await p.$eval('.sl-row[data-id=hours]', e => e.scrollIntoView({ block: 'center' }));
  let from = await centre(p, '.sl-row[data-id=hours] .sl-grip'), to = await centre(p, '.sl-row[data-id=forecast]');
  await p.mouse.move(from.x, from.y); await p.mouse.down();
  await p.mouse.move(from.x, from.y - 20, { steps: 3 });
  ok(await p.$eval('.sl-row[data-id=hours]', e => e.classList.contains('lifted')), `${tag}: the dragged row is lifted`);
  await p.mouse.move(to.x, to.y - 60, { steps: 12 });
  ok((await ids(p))[5] === 'hours', `${tag}: the list opens a gap where it will land`);
  ok((await saved(p)) === null, `${tag}: nothing is saved until the drop`);
  await p.mouse.up();
  await p.waitForFunction(() => document.querySelector('#slLive').textContent.includes('Moved Time of day to position 6 of 11'));
  ok(true, `${tag}: announced "Moved Time of day to position 6 of 11"`);
  await p.waitForFunction(() => document.querySelector('main[data-route=stats] .view .card h2')?.textContent !== 'Day streak' || true);
  await p.waitForTimeout(200);
  ok((await seen(p)).indexOf('Time of day') === 5, `${tag}: the dragged order shows on Stats`);
  // Escape puts it back
  await p.$eval('.sl-row[data-id=hardest]', e => e.scrollIntoView({ block: 'center' }));
  from = await centre(p, '.sl-row[data-id=hardest] .sl-grip'); to = await centre(p, '.sl-row[data-id=hours]');
  await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps: 10 });
  await p.keyboard.press('Escape'); await p.mouse.up();
  ok((await ids(p))[7] === 'hardest' && await p.evaluate(() => document.querySelector('#sheet').open), `${tag}: Escape while dragging puts the row back and keeps the sheet open`);
  await p.reload(); await p.waitForSelector('main[data-route=stats] .pgrid');
  ok((await seen(p)).indexOf('Time of day') === 5, `${tag}: the dragged order persists after a reload`);
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('statsLayout', null); });
  await p.context().close();
  // touch (pointer events of type touch on the grip)
  p = await open(ui, 390, 800);
  await stats(p);
  await openList(p);
  await p.$eval('.sl-row[data-id=perDay]', e => e.scrollIntoView({ block: 'center' }));
  await p.evaluate(async () => {
    const grip = document.querySelector('.sl-row[data-id=perDay] .sl-grip'), r = grip.getBoundingClientRect(), tgt = document.querySelector('.sl-row[data-id=rs]').getBoundingClientRect();
    const ev = (type, y) => grip.dispatchEvent(new PointerEvent(type, { pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: y }));
    const y0 = r.top + r.height / 2;
    ev('pointerdown', y0);
    for (let k = 1; k <= 12; k++) { ev('pointermove', y0 + (tgt.top - y0) * k / 12); await new Promise(r => setTimeout(r, 20)); }
    ev('pointerup', tgt.top);
  });
  await p.waitForFunction(() => /Moved Reviews per day to position \d+ of 11/.test(document.querySelector('#slLive').textContent));
  const t = await ids(p);
  ok(t.indexOf('perDay') <= 2, `${tag} 390: a touch drag moves the row (${t.slice(0, 4)})`);
  // a cancelled pointer puts it back
  await p.$eval('.sl-row[data-id=hardest]', e => e.scrollIntoView({ block: 'center' }));
  const before = (await ids(p)).join();
  await p.evaluate(async () => {
    const grip = document.querySelector('.sl-row[data-id=hardest] .sl-grip'), r = grip.getBoundingClientRect(), tgt = document.querySelector('.sl-row[data-id=hours]').getBoundingClientRect();
    const ev = (type, y) => grip.dispatchEvent(new PointerEvent(type, { pointerId: 42, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: y }));
    ev('pointerdown', r.top + 20); ev('pointermove', tgt.top); ev('pointercancel', tgt.top);
  });
  ok((await ids(p)).join() === before, `${tag} 390: pointercancel puts the row back`);
  await p.click('#slDone'); await p.waitForTimeout(200);
  await p.reload(); await p.waitForSelector('main[data-route=stats] .pgrid');
  ok((await dom(p)).indexOf('Reviews per day') <= 2, `${tag} 390: the touch-dragged order persists after a reload`);
  await p.context().close();

  // ---------------- closing the sheet in the middle of a drag ----------------
  p = await open(ui, 1280, 900);
  await stats(p);
  await openList(p);
  await p.$eval('.sl-row[data-id=hours]', e => e.scrollIntoView({ block: 'center' }));
  from = await centre(p, '.sl-row[data-id=hours] .sl-grip'); to = await centre(p, '.sl-row[data-id=forecast]');
  await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y - 60, { steps: 10 });
  await p.evaluate(() => document.querySelector('.sl-x, .sheet-x').click());
  await p.mouse.move(to.x, to.y + 300, { steps: 5 }); await p.mouse.up();
  await p.waitForTimeout(300);
  ok(!(await p.evaluate(() => document.querySelector('#sheet').open)) && (await saved(p)) === null, `${tag}: closing the sheet mid-drag saves nothing`);
  ok(JSON.stringify(await seen(p)) === JSON.stringify(DEFAULT), `${tag}: and the page keeps its order`);
  // quick changes end in the right state
  await openList(p);
  await p.evaluate(() => { for (const id of ['hours', 'buttons', 'hours', 'difficulty', 'hours', 'forecast']) document.querySelector(`.sl-row[data-id=${id}] [data-act=show]`).click(); });
  await p.waitForTimeout(1500);
  ok(JSON.stringify((await saved(p)).hidden) === JSON.stringify(['forecast', 'buttons', 'hours', 'difficulty'].sort((a, b) => ['forecast', 'hardest', 'buttons', 'hours', 'difficulty'].indexOf(a) - ['forecast', 'hardest', 'buttons', 'hours', 'difficulty'].indexOf(b))) && !(await seen(p)).includes('Time of day') && !(await seen(p)).includes('Due in the next 7 days'), `${tag}: six quick taps end in the right saved state and page`);
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('statsLayout', null); });
  await p.context().close();

  // ---------------- pairing, tab order, the fold ----------------
  p = await open(ui, 1440, 900);
  await p.evaluate(async () => { const m = await import('./js/stats-layout.js'); const o = ['perDay', 'streak', 'retention', 'forecast', ...m.IDS.filter(i => !['perDay', 'streak', 'retention', 'forecast'].includes(i))]; await (await import('./js/db.js')).setSetting('statsLayout', { order: o, hidden: [], size: {} }); });
  await stats(p);
  const rowsOf = await p.evaluate(() => [...document.querySelectorAll('main[data-route=stats] .view [data-card]')].map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.card, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), right: Math.round(r.right) }; }));
  const g = id => rowsOf.find(r => r.id === id);
  const viewW = await p.$eval('main[data-route=stats] .view', e => Math.round(e.getBoundingClientRect().width));
  ok(g('perDay').y === g('streak').y && g('retention').y === g('forecast').y && g('streak').w < viewW * 0.6 && g('retention').w < viewW * 0.6 && g('retention').x < g('forecast').x, `${tag} 1440: perDay, streak, retention, forecast sit two to a row (no gap beside half cards)`);
  ok(g('streak').right - g('streak').x > viewW * 0.4 && g('retention').w > viewW * 0.4, `${tag} 1440: a lone streak or retention card fills its half`);
  ok(g('forecast').right >= viewW + g('perDay').x - 2, `${tag} 1440: the rows reach the right edge`);
  // Tab order follows the picture
  ok(JSON.stringify(await dom(p)) === JSON.stringify(await seen(p)), `${tag} 1440: the page is built in the order it shows (Tab order = visual order)`);
  ok(await p.$('#moreBtn') === null, `${tag} 1440: no More stats fold on a computer`);
  await p.context().close();
  p = await open(ui, 390, 800);
  await p.evaluate(async () => { const m = await import('./js/stats-layout.js'); const o = ['perDay', 'streak', 'forecast', 'retention', 'buttons', ...m.IDS.filter(i => !['perDay', 'streak', 'retention', 'forecast', 'buttons'].includes(i))]; await (await import('./js/db.js')).setSetting('statsLayout', { order: o, hidden: [], size: {} }); });
  await stats(p);
  const lone = await p.$$eval('.pgrid.one .card', cs => cs.map(c => Math.round(c.getBoundingClientRect().width)));
  const vw = await p.$eval('main[data-route=stats] .view', e => Math.round(e.getBoundingClientRect().width));
  ok(lone.length === 2 && lone.every(w => w >= vw - 2), `${tag} 390: a lone streak or retention card is full width (${lone}, page ${vw})`);
  await p.screenshot({ path: `${SP}/page-phone-lone-${tag}.png`, fullPage: true });
  // Answer buttons sits before Due... so it is not in the fold; only the More cards after the last other card are
  const inFold = await p.$$eval('#moreBody h2', h => h.map(x => x.textContent.trim()));
  ok(inFold.join() === 'Time of day,Difficulty,Mastery', `${tag} 390: a More card placed before other cards leaves the fold (fold: ${inFold})`);
  await p.context().close();
  // default phone page keeps its fold
  p = await open(ui, 390, 800);
  await stats(p);
  ok((await p.$$eval('#moreBody h2', h => h.map(x => x.textContent.trim()))).join() === 'Answer buttons,Time of day,Difficulty,Mastery', `${tag} 390: the default phone page still folds Answer buttons, Time of day, Difficulty, Mastery`);
  await p.context().close();
  // one course picked, Mastery moved: the readiness card takes the full width
  p = await open(ui, 1280, 900);
  await p.evaluate(async () => { const m = await import('./js/stats-layout.js'); await (await import('./js/db.js')).setSetting('statsLayout', { order: ['mastery', ...m.IDS.filter(i => i !== 'mastery')], hidden: [], size: {} }); });
  await stats(p);
  await p.click('#sDeckBtn'); await p.click('.pick-row[data-id="sample"]'); await p.waitForSelector('.ready-card');
  const rw = await p.evaluate(() => ({ r: document.querySelector('.ready-card').getBoundingClientRect().width, v: document.querySelector('main[data-route=stats] .view').getBoundingClientRect().width }));
  ok(rw.r >= rw.v - 2, `${tag} 1280: with Mastery moved, the readiness card is full width (${Math.round(rw.r)} of ${Math.round(rw.v)})`);
  await p.context().close();

  // ---------------- the streak card around 1200px ----------------
  for (const w of [1200, 1279, 1280]) {
    p = await open(ui, w, 900);
    await stats(p);
    await p.evaluate(async () => { const db = await import('./js/db.js'); const DAY = 86400000, now = Date.now(); const cs = await db.getAll('cards'); await db.putMany('reviewLog', Array.from({ length: 1400 }, (_, d) => ({ cardId: cs[0].id, timestamp: now - Math.floor(d / 1.0) * DAY - 1000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true, reason: 'due' }))); });
    await stats(p);
    const o = await p.$eval('.pc-streak', c => { const cr = c.getBoundingClientRect(); const big = c.querySelector('.big').getBoundingClientRect(); const lines = c.querySelector('p').getBoundingClientRect().height / parseFloat(getComputedStyle(c.querySelector('p')).lineHeight); return { inside: big.right <= cr.right, lines: Math.round(lines), digits: c.querySelector('.big').textContent.trim() }; });
    ok(o.inside && o.lines <= 3, `${tag} ${w}: the streak card keeps its count (${o.digits}) and text (${o.lines} lines) inside`);
    await p.context().close();
  }
}
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''));
await browser.close();
