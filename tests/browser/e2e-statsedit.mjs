// Stats edit mode (the iPhone home-screen way): Edit / Done, drag the real cards by mouse and by touch long-press, x, Add widget,
// sizes (only on cards that have two), the empty slot beside a lone half card, Reset, leaving mid-drag, the keyboard path, reduced motion.
// Both styles (Original and Clinical). Screenshots go in $SHOTS (or the run's out folder).
import { chromium } from './pw.mjs';
import fs from 'node:fs';
const SP = process.env.SHOTS || process.argv[2] || '/tmp';
fs.mkdirSync(SP, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const IDS = ['streak', 'retention', 'rs', 'cal', 'perDay', 'forecast', 'hardest', 'buttons', 'hours', 'difficulty', 'mastery'];
const FIXED = ['rs', 'cal'];

const open = async (ui, width, height, { motion = 'reduce', touch = width < 600 } = {}) => {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion: motion, deviceScaleFactor: touch ? 2 : 1, isMobile: touch, hasTouch: touch });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${ui}/${width} pageerror ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/katex|jsdelivr|Failed to load resource|net::ERR/i.test(m.text())) errors.push(`${ui}/${width} console ${m.text()}`); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ui => {
    const db = await import('./js/db.js');
    await db.setSetting('theme', { ui, skin: 'violet', mode: 'dark', oled: false });
    // some history, so every chart has something in it
    const DAY = 86400000, now = Date.now();
    const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
    const st = (c, state, stability, dueIn, lapses) => ({ cardId: c.id, due: now + dueIn * DAY, stability, difficulty: 5, elapsedDays: 1, scheduledDays: 1, learningSteps: 0, reps: 4, lapses, state, lastReview: now - DAY });
    await db.putMany('cardStates', cs.slice(0, 8).map((c, i) => st(c, 2, 5 + i * 9, i, i % 4)));
    const logs = [];
    for (let d = 0; d < 60; d++) for (let i = 0; i < 5; i++) logs.push({ cardId: cs[(d + i) % 8].id, timestamp: now - d * DAY - i * 3600000, source: 'review', mode: 'flip', correct: (i + d) % 4 !== 0, ms: 4000, rating: 1 + (i % 4), state: 2, applied: true, reason: 'due' });
    await db.putMany('reviewLog', logs);
  }, ui);
  await p.reload(); await p.waitForSelector('.deck');
  return p;
};
const stats = async p => { await p.goto('http://localhost:8123/#/stats'); await p.reload(); await p.waitForSelector('#editBtn'); };
const edit = async p => { await p.click('#editBtn'); await p.waitForSelector('.ed-unit'); await p.waitForTimeout(80); };
const order = p => p.$$eval('.ed-unit', u => u.map(x => x.dataset.card));
const saved = p => p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).statsLayout);
const live = p => p.$eval('#edLive', e => e.textContent);
const liveHas = (p, t) => p.waitForFunction(t => document.querySelector('#edLive')?.textContent.includes(t), t);
const centre = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const grab = (p, id) => p.$eval(`.ed-unit[data-card=${id}]`, e => { e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 70 }; });
const box = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, w: r.width, h: r.height, right: r.right }; });
const setLayout = (p, l) => p.evaluate(async l => { await (await import('./js/db.js')).setSetting('statsLayout', l); }, l);

for (const ui of ['original', 'clinical']) {
  const tag = ui.slice(0, 4);
  // ---------------- entering and leaving ----------------
  let p = await open(ui, 1440, 900);
  await stats(p);
  ok(!(await p.$('#customBtn')) && /Edit/.test(await p.textContent('#editBtn')), `${tag}: an Edit button replaces Customise`);
  const bb = await p.$eval('#editBtn', e => { const r = e.getBoundingClientRect(), s = document.querySelector('#sDeckBtn').getBoundingClientRect(); return { h: r.height, w: r.width, same: Math.abs((r.top + r.height / 2) - (s.top + s.height / 2)) < 6 }; });
  ok(bb.h >= 44 && bb.w >= 44 && bb.same, `${tag}: Edit is a 44px target on the picker's row`);
  ok((await p.$$('.ed-unit')).length === 0 && !(await p.$('#edBar')), `${tag}: no edit controls outside edit mode`);
  await edit(p);
  ok(await p.evaluate(() => document.activeElement?.id === 'edDone'), `${tag}: focus goes to Done when edit mode opens`);
  ok(await p.isVisible('#edBar') && await p.isVisible('#edReset') && /Edit as a list/.test(await p.textContent('#edBar')), `${tag}: a sticky bar with Done, Reset and Edit as a list`);
  ok(await p.$eval('#edBar', e => getComputedStyle(e).position === 'sticky'), `${tag}: the bar is sticky`);
  ok((await order(p)).join() === IDS.join(), `${tag}: all 11 cards are there, in order`);
  ok(await p.evaluate(() => [...document.querySelectorAll('.ed-unit')].every(u => u.querySelector('.ed-body').inert && u.querySelector('[data-act=remove]') && u.querySelector('[data-act=earlier]') && u.querySelector('[data-act=later]'))), `${tag}: every card has an x and Move buttons, and its content is inert`);
  const names = await p.$$eval('.ed-unit', us => us.map(u => ({ id: u.dataset.card, name: u.getAttribute('aria-label'), x: u.querySelector('[data-act=remove]').getAttribute('aria-label'), size: u.querySelector('[data-act=size]')?.getAttribute('aria-label') || null, e: u.querySelector('[data-act=earlier]').getAttribute('aria-label'), l: u.querySelector('[data-act=later]').getAttribute('aria-label') })));
  ok(names.every(n => n.x === `Remove ${n.name}` && n.e === `Move ${n.name} earlier` && n.l === `Move ${n.name} later`), `${tag}: every control is named after its card`);
  ok(names.filter(n => n.size).length === 9 && FIXED.every(id => !names.find(n => n.id === id).size), `${tag}: a size badge on the 9 cards that have two sizes, none on Study calendar or Retention vs target`);
  ok(names.filter(n => n.size).every(n => new RegExp(`^Make ${n.name} (half|full) width$`).test(n.size)), `${tag}: size badges say "Make X half width" or "Make X full width"`);
  const sizes = await p.$$eval('.ed-x, .ed-size, .ed-mv', bs => bs.map(b => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  ok(Math.min(...sizes) >= 44, `${tag}: every badge is a 44px target`);
  // inert: a tap on the calendar or a chart does nothing
  await p.$eval('.ed-unit[data-card=cal]', e => e.scrollIntoView({ block: 'center' }));
  const calDay = await centre(p, '.ed-unit[data-card=cal] .cal-d, .ed-unit[data-card=cal] [data-day]').catch(() => null);
  if (calDay) { await p.mouse.click(calDay.x, calDay.y); }
  ok(await p.evaluate(() => !document.querySelector('.ed-unit .chart-tip:not([hidden])') && document.querySelector('.ed-unit[data-card=cal]')?.querySelector('[aria-pressed="true"]') === null), `${tag}: taps on a card's content do nothing while editing`);
  await p.mouse.move(5, 5);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(80);
  await p.screenshot({ path: `${SP}/edit-1440-${tag}.png`, fullPage: true });
  await p.screenshot({ path: `${SP}/edit-1440-${tag}-top.png` });
  await p.click('#edDone');
  await p.waitForFunction(() => !document.querySelector('.ed-unit'));
  ok(await p.evaluate(() => document.activeElement?.id === 'editBtn'), `${tag}: focus goes back to the Edit button when edit mode closes`);
  ok(!(await p.$('#edBar')) && (await p.$$('main[data-route=stats] [data-card]')).length >= 11, `${tag}: Done leaves edit mode and the page is normal again`);
  ok(await p.evaluate(() => document.querySelectorAll('main[data-route=stats] .view .card h2').length >= 11), `${tag}: the cards are all still there`);

  // ---------------- mouse drag ----------------
  await edit(p);
  let from = await grab(p, 'hours');
  await p.mouse.move(from.x, from.y); await p.mouse.down();
  await p.mouse.move(from.x + 4, from.y - 14, { steps: 3 });
  ok(await p.$eval('.ed-unit[data-card=hours]', e => e.classList.contains('lifted')) && !!(await p.$('.ed-ph')), `${tag}: a mouse drag lifts the real card at once and leaves a placeholder`);
  const lifted0 = await box(p, '.ed-unit[data-card=hours]');
  let to = await grab(p, 'perDay').catch(() => null);
  // (grab scrolled the page; the dragged card is fixed, so aim by the target's current place)
  const tgt = await p.$eval('.ed-unit[data-card=perDay]', e => { const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
  await p.mouse.move(tgt.x, tgt.y, { steps: 14 });
  const mid = await p.evaluate(() => ({ lifted: document.querySelector('.ed-unit.lifted')?.dataset.card, ph: !!document.querySelector('.ed-ph'), order: [...document.querySelectorAll('.ed-unit:not(.lifted), .ed-ph')].map(x => x.dataset.card), mouse: null }));
  ok(mid.lifted === 'hours' && mid.order.indexOf('hours') < mid.order.indexOf('perDay'), `${tag}: the page reflows live, the placeholder is above Reviews per day (${mid.order.join()})`);
  ok(await p.$eval('.ed-unit.lifted', (e, t) => { const r = e.getBoundingClientRect(); return getComputedStyle(e).position === 'fixed' && t.x > r.left && t.x < r.right && t.y > r.top && t.y < r.bottom; }, tgt), `${tag}: the lifted card follows the pointer`);
  ok((await saved(p)) === null, `${tag}: nothing is saved until the drop`);
  await p.screenshot({ path: `${SP}/middrag-1440-${tag}.png` });
  await p.mouse.up();
  await liveHas(p, 'Moved Time of day to position 5 of 11');
  ok(true, `${tag}: announced "Moved Time of day to position 5 of 11"`);
  ok(!(await p.$('.ed-ph')) && !(await p.$('.ed-unit.lifted')) && (await order(p)).indexOf('hours') === 4, `${tag}: the card lands, no placeholder is left (${(await order(p)).join()})`);
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).statsLayout?.order.indexOf('hours') === 4);
  ok((await saved(p)).order.indexOf('hours') === 4, `${tag}: the order is saved on the drop`);
  // Escape puts it back
  const before = (await order(p)).join();
  from = await grab(p, 'hardest');
  await p.mouse.move(from.x, from.y); await p.mouse.down();
  const t2 = await p.$eval('.ed-unit[data-card=cal]', e => { const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 60 }; }).catch(() => null);
  await p.mouse.move(from.x + 10, from.y - 200, { steps: 10 });
  await p.keyboard.press('Escape');
  ok((await order(p)).join() === before && !(await p.$('.ed-ph')) && !(await p.$('.ed-unit.lifted')), `${tag}: Escape puts the card back`);
  await p.mouse.up();
  ok((await order(p)).join() === before && (await saved(p)).order.join() === (await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).statsLayout.order.join())).split(',').join(), `${tag}: and the release after Escape does nothing`);
  // a cancelled pointer puts it back too
  await p.evaluate(() => {
    const u = document.querySelector('.ed-unit[data-card=hardest]'), r = u.getBoundingClientRect();
    const ev = (type, y) => u.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, clientX: r.left + 40, clientY: y }));
    ev('pointerdown', r.top + 60);
    document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: r.left + 40, clientY: r.top - 100, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9, pointerType: 'mouse', isPrimary: true, bubbles: true }));
  });
  ok((await order(p)).join() === before && !(await p.$('.ed-ph')), `${tag}: pointercancel puts the card back`);
  // edge auto-scroll: hold a card near the bottom of the window and the page scrolls
  await p.evaluate(() => scrollTo(0, 0));
  from = await grab(p, 'rs');
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(60);
  const f2 = await p.$eval('.ed-unit[data-card=rs]', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; });
  await p.mouse.move(f2.x, f2.y); await p.mouse.down(); await p.mouse.move(f2.x + 5, f2.y + 20, { steps: 2 });
  await p.mouse.move(f2.x, 890, { steps: 4 });
  await p.waitForTimeout(600);
  const sy = await p.evaluate(() => scrollY);
  ok(sy > 150, `${tag}: holding a card at the bottom edge scrolls the page (${Math.round(sy)}px)`);
  await p.keyboard.press('Escape'); await p.mouse.up();
  await p.click('#edDone');
  await setLayout(p, null);
  await p.context().close();

  // ---------------- x, Add widget, Reset, list ----------------
  p = await open(ui, 1280, 900);
  await stats(p);
  await edit(p);
  ok(/All widgets are on the page/.test(await p.textContent('#edAdd')) && await p.getAttribute('#edAdd', 'aria-disabled') === 'true', `${tag}: with nothing hidden the Add tile says so`);
  await p.click('button[aria-label="Remove Difficulty"]');
  ok(!(await p.$('.ed-unit[data-card=difficulty]')) && (await order(p)).length === 10, `${tag}: x hides the card`);
  await liveHas(p, 'Difficulty removed');
  ok(await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Remove Mastery'), `${tag}: focus moves on to the next card's x`);
  await p.click('button[aria-label="Remove Time of day"]');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).statsLayout?.hidden.length === 2);
  ok(JSON.stringify((await saved(p)).hidden) === JSON.stringify(['hours', 'difficulty']), `${tag}: the hidden cards are saved`);
  ok(/Add widget/.test(await p.textContent('#edAdd')) && /2 hidden/.test(await p.textContent('#edAdd')) && await p.getAttribute('#edAdd', 'aria-disabled') === null, `${tag}: the Add tile counts the hidden cards`);
  await p.click('#edAdd'); await p.waitForSelector('#sheet[open] .aw-list');
  const items = await p.$$eval('.aw-item', bs => bs.map(b => ({ id: b.dataset.id, name: b.querySelector('b').textContent, desc: b.querySelector('.muted').textContent, thumb: !!b.querySelector('svg.aw-svg path, svg.aw-svg rect, svg.aw-svg circle'), label: b.getAttribute('aria-label') })));
  ok(items.length === 2 && items.every(i => i.name && i.desc.length > 10 && i.thumb && i.label.startsWith('Add ')), `${tag}: the Add sheet lists the hidden cards with a name, a line and a picture (${items.map(i => i.name)})`);
  await p.screenshot({ path: `${SP}/add-widget-${tag}.png` });
  await p.click('.aw-item[data-id=difficulty]');
  await p.waitForSelector('.ed-unit[data-card=difficulty]');
  await p.waitForFunction(() => !document.querySelector('#sheet').open);
  ok((await order(p)).at(-1) === 'difficulty' && (await order(p)).length === 10, `${tag}: tapping a card in Add widget puts it back at the end`);
  await p.waitForFunction(async () => JSON.stringify((await (await import('./js/db.js')).getSettings()).statsLayout?.hidden) === '["hours"]');
  ok(/1 hidden/.test(await p.textContent('#edAdd')), `${tag}: the tile now says 1 hidden`);
  ok(await p.evaluate(() => document.activeElement?.closest('.ed-unit')?.dataset.card === 'difficulty'), `${tag}: focus lands on the added card`);
  // Reset asks first
  await p.click('#edReset');
  ok(await p.isVisible('#edConfirm') && /Reset to the default layout\?/.test(await p.textContent('#edConfirm')), `${tag}: Reset asks to confirm`);
  await p.click('#edConfirm [data-act=reset-no]');
  ok(!(await p.isVisible('#edConfirm')) && (await order(p)).length === 10, `${tag}: "Keep my layout" changes nothing`);
  await p.click('#edReset'); await p.click('#edConfirm [data-act=reset-yes]');
  await p.waitForFunction(() => document.querySelectorAll('.ed-unit').length === 11);
  ok((await order(p)).join() === IDS.join() && (await saved(p)) === null && await p.isVisible('#edBar'), `${tag}: Reset restores everything, saves the default and stays in edit mode`);
  // the list, as the accessible way
  await p.click('.ed-list'); await p.waitForSelector('#sheet[open] #slList');
  ok((await p.$$('#slList [role=radiogroup]')).length === 9 && !(await p.$('.sl-row[data-id=cal] [role=radiogroup]')) && !(await p.$('.sl-row[data-id=rs] [role=radiogroup]')), `${tag}: the list has size chips only for the 9 cards with two sizes`);
  await p.getByLabel('Show Mastery').uncheck();
  await p.waitForFunction(() => !document.querySelector('.ed-unit[data-card=mastery]'));
  ok(await p.isVisible('#edBar'), `${tag}: a change in the list shows on the page behind it, still in edit mode`);
  await p.click('#slDone'); await p.waitForFunction(() => !document.querySelector('#sheet').open);
  await setLayout(p, null);
  await p.context().close();

  // ---------------- sizes and the empty slot ----------------
  p = await open(ui, 1440, 900);
  await setLayout(p, { order: IDS, hidden: [], size: { forecast: 'full' } });      // Reviews per day is half, the card after it is full: a lone half card
  await stats(p);
  await edit(p);
  const lone = await p.evaluate(() => { const u = document.querySelector('.ed-unit[data-card=perDay]'), s = u.nextElementSibling, v = document.querySelector('main .view').getBoundingClientRect(); const r = u.getBoundingClientRect(), sr = s?.getBoundingClientRect(); return { slot: s?.classList.contains('ed-slot') && s.textContent.trim(), w: r.width, view: v.width, sameRow: sr && Math.abs(sr.top - r.top) < 2, right: sr && sr.left > r.left, aria: s?.getAttribute('aria-hidden') }; });
  ok(lone.slot === 'Drop a half-size card here' && lone.w < lone.view * 0.6 && lone.sameRow && lone.right && lone.aria === 'true', `${tag}: a lone half card shows its true half width with an empty slot beside it (${Math.round(lone.w)} of ${Math.round(lone.view)})`);
  await p.$eval('.ed-unit[data-card=perDay]', e => e.scrollIntoView({ block: 'center' }));
  await p.screenshot({ path: `${SP}/lone-half-${tag}.png` });
  // the size toggle visibly does something: perDay half -> full
  await p.click('button[aria-label="Make Reviews per day full width"]');
  const full = await p.evaluate(() => { const u = document.querySelector('.ed-unit[data-card=perDay]'), v = document.querySelector('main .view').getBoundingClientRect(); return { w: u.getBoundingClientRect().width, view: v.width, slot: !!document.querySelector('.ed-slot'), label: u.querySelector('[data-act=size]').getAttribute('aria-label') }; });
  ok(full.w > full.view - 4 && !full.slot && full.label === 'Make Reviews per day half width', `${tag}: Make full width fills the row and the slot goes (${Math.round(full.w)})`);
  await p.click('button[aria-label="Make Reviews per day half width"]');
  ok(await p.evaluate(() => !!document.querySelector('.ed-slot')), `${tag}: and back to half brings the slot back`);
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).statsLayout?.size.perDay === 'half');
  // the empty slot takes a drop: Hardest cards (half) dragged into it pairs with Reviews per day
  const fromH = await grab(p, 'hardest');
  await p.mouse.move(fromH.x, fromH.y); await p.mouse.down(); await p.mouse.move(fromH.x + 4, fromH.y - 10, { steps: 2 });
  const slotAt = await p.$eval('.ed-slot', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.move(slotAt.x, slotAt.y, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(150);
  const paired = await p.evaluate(() => { const a = document.querySelector('.ed-unit[data-card=perDay]').getBoundingClientRect(), b = document.querySelector('.ed-unit[data-card=hardest]').getBoundingClientRect(); return { same: Math.abs(a.top - b.top) < 2, right: b.left > a.left, slot: !!document.querySelector('[data-card=perDay] + .ed-slot') }; });
  ok(paired.same && paired.right, `${tag}: a half card dropped on the slot pairs with the lone half card`);
  const savedSz = await saved(p);
  // outside edit mode a lone half card stretches
  await setLayout(p, { order: IDS, hidden: [], size: { forecast: 'full', perDay: 'half' } });
  await p.click('#edDone'); await p.waitForFunction(() => !document.querySelector('.ed-unit'));
  await stats(p);
  const out = await p.evaluate(() => { const c = document.querySelector('[data-card=perDay]'), v = document.querySelector('main .view').getBoundingClientRect(); return { w: c.getBoundingClientRect().width, view: v.width, slot: !!document.querySelector('.ed-slot') }; });
  ok(out.w > out.view - 4 && !out.slot, `${tag}: outside edit mode a lone half card still fills its row (${Math.round(out.w)} of ${Math.round(out.view)})`);
  await edit(p);
  ok(await p.evaluate(() => document.querySelector('[data-card=perDay]').getBoundingClientRect().width < document.querySelector('main .view').getBoundingClientRect().width * 0.6), `${tag}: in edit mode the same card is shown at half width`);
  await setLayout(p, null);
  await p.context().close();

  // ---------------- leaving the page in the middle of a drag ----------------
  p = await open(ui, 1280, 900);
  await p.evaluate(() => {      // count the listeners that edit mode adds and removes
    window.__ls = {};
    const track = (t, name) => {
      const add = t.addEventListener.bind(t), rem = t.removeEventListener.bind(t);
      t.addEventListener = (type, fn, o) => { if (/^(pointermove|pointerup|pointercancel|keydown|touchmove|hashchange|pagehide)$/.test(type)) { const k = name + type; (window.__ls[k] = window.__ls[k] || new Set()).add(fn); if (o && o.signal) o.signal.addEventListener('abort', () => window.__ls[k].delete(fn)); } return add(type, fn, o); };
      t.removeEventListener = (type, fn, o) => { window.__ls[name + type]?.delete(fn); return rem(type, fn, o); };
    };
    track(document, 'doc:'); track(window, 'win:');
  });
  await p.evaluate(() => { location.hash = '#/stats'; }); await p.waitForSelector('#editBtn');
  const base = await p.evaluate(() => Object.fromEntries(Object.entries(window.__ls).map(([k, v]) => [k, v.size])));
  await edit(p);
  from = await grab(p, 'forecast');
  await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(from.x, from.y - 200, { steps: 8 });
  ok(!!(await p.$('.ed-unit.lifted')), `${tag}: (a card is held)`);
  const held = await p.evaluate(() => Object.entries(window.__ls).filter(([k, v]) => v.size > (0)).length);
  await p.evaluate(() => { location.hash = '#/decks'; });
  await p.waitForSelector('main[data-route=decks]');
  await p.mouse.move(from.x, from.y + 300, { steps: 4 }); await p.mouse.up();
  await p.waitForTimeout(400);
  const after = await p.evaluate(() => Object.fromEntries(Object.entries(window.__ls).map(([k, v]) => [k, v.size])));
  const leaked = Object.keys(after).filter(k => (after[k] || 0) > (base[k] || 0));
  ok(leaked.length === 0, `${tag}: leaving mid-drag leaves no listener behind${leaked.length ? ' (' + leaked + ')' : ''}`);
  ok((await saved(p)) === null, `${tag}: and nothing is saved`);
  await p.evaluate(() => { location.hash = '#/stats'; }); await p.waitForSelector('#editBtn');
  ok(!(await p.$('#edBar')) && (await p.$$('.ed-unit')).length === 0, `${tag}: coming back, Stats is not in edit mode`);
  // leaving from edit mode without a drag ends it as well
  await edit(p);
  await p.evaluate(() => { location.hash = '#/decks'; });
  await p.waitForSelector('main[data-route=decks]'); await p.waitForTimeout(200);
  const after2 = await p.evaluate(() => Object.fromEntries(Object.entries(window.__ls).map(([k, v]) => [k, v.size])));
  ok(Object.keys(after2).every(k => (after2[k] || 0) <= (base[k] || 0)), `${tag}: leaving edit mode by navigating removes its listeners`);
  await p.context().close();

  // ---------------- keyboard ----------------
  p = await open(ui, 1280, 900);
  await stats(p);
  await edit(p);
  ok(await p.getAttribute('button[aria-label="Move Day streak earlier"]', 'aria-disabled') === 'true' && await p.getAttribute('button[aria-label="Move Mastery later"]', 'aria-disabled') === 'true', `${tag}: the first card cannot move earlier and the last cannot move later`);
  await p.focus('button[aria-label="Move Hardest cards earlier"]'); await p.keyboard.press('Enter');
  await liveHas(p, 'Moved Hardest cards to position 6 of 11');
  ok((await order(p)).indexOf('hardest') === 5 && await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Move Hardest cards earlier'), `${tag}: Enter on Move earlier moves the card and keeps the focus on the button`);
  await p.keyboard.press('Space');
  await liveHas(p, 'position 5 of 11');
  await p.focus('button[aria-label="Move Hardest cards later"]'); await p.keyboard.press('Enter');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).statsLayout?.order.indexOf('hardest') === 5);
  ok((await saved(p)).order.indexOf('hardest') === 5, `${tag}: the keyboard moves are saved`);
  await p.focus('button[aria-label="Make Answer buttons full width"]'); await p.keyboard.press('Enter');
  ok(await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Make Answer buttons half width'), `${tag}: the size badge toggles from the keyboard and keeps focus`);
  // Tab reaches every control in page order
  const tabs = await p.evaluate(() => [...document.querySelectorAll('.ed-unit')].every(u => [...u.querySelectorAll(':scope > button, :scope > .ed-moves > button')].every(b => b.tabIndex === 0)));
  ok(tabs, `${tag}: every control is reachable by Tab`);
  await setLayout(p, null);
  await p.context().close();

  // ---------------- touch (a phone) ----------------
  p = await open(ui, 390, 800);
  await stats(p);
  ok(await p.$eval('#editBtn', e => { const r = e.getBoundingClientRect(); return r.height >= 44 && r.right <= innerWidth; }), `${tag} 390: Edit is a 44px target on the screen`);
  await edit(p);
  ok(!(await p.$('#moreBtn')) && (await p.$$('.ed-unit')).length === 11, `${tag} 390: edit mode shows all cards unfolded`);
  ok(await p.$$eval('.ed-size', bs => bs.every(b => getComputedStyle(b).display === 'none')) && !(await p.isVisible('.ed-slot').catch(() => false)), `${tag} 390: size badges are hidden on a phone`);
  const widths = await p.$$eval('.ed-unit', us => us.map(u => Math.round(u.getBoundingClientRect().width)));
  ok(new Set(widths).size === 1 && await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag} 390: every card is full width, no sideways scroll`);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(80);
  await p.screenshot({ path: `${SP}/edit-390-${tag}.png` });
  await p.screenshot({ path: `${SP}/edit-390-${tag}-full.png`, fullPage: true });
  // a quick swipe scrolls the page and does not lift a card (real touch events)
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await p.evaluate(() => scrollTo(0, 0));
  await touch('touchStart', 200, 600);
  for (let k = 1; k <= 8; k++) { await touch('touchMove', 200, 600 - k * 45); await p.waitForTimeout(12); }
  await touch('touchEnd');
  await p.waitForTimeout(500);
  const sc = await p.evaluate(() => ({ y: scrollY, lifted: !!document.querySelector('.ed-unit.lifted'), ph: !!document.querySelector('.ed-ph') }));
  ok(sc.y > 100 && !sc.lifted && !sc.ph, `${tag} 390: a quick touch swipe still scrolls the page and lifts nothing (scrolled ${Math.round(sc.y)}px)`);
  // a short tap lifts nothing
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(100);
  await touch('touchStart', 200, 560); await p.waitForTimeout(80); await touch('touchEnd'); await p.waitForTimeout(450);
  ok(!(await p.$('.ed-unit.lifted')), `${tag} 390: a short tap does not lift a card`);
  // long-press (300ms) then drag: the card lifts and the page does not scroll
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(100);
  const startOrder = (await order(p)).join();
  const rr = await p.$eval('.ed-unit[data-card=retention]', e => { const r = e.getBoundingClientRect(); return { x: r.left + 150, y: r.top + 60 }; });
  await touch('touchStart', rr.x, rr.y);
  await p.waitForTimeout(450);
  ok(await p.$eval('.ed-unit[data-card=retention]', e => e.classList.contains('lifted')), `${tag} 390: holding a card for about 300ms lifts it`);
  await p.screenshot({ path: `${SP}/middrag-390-${tag}.png` });
  const hd = await p.$eval('.ed-unit[data-card=hardest]', e => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return r.top + 40; }).catch(() => null);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(60);
  const targetY = await p.$eval('.ed-unit[data-card=streak]', e => { const r = e.getBoundingClientRect(); return r.top + 25; });
  for (let k = 1; k <= 12; k++) { await touch('touchMove', rr.x, rr.y + (targetY - rr.y) * k / 12); await p.waitForTimeout(25); }
  await touch('touchEnd');
  await p.waitForTimeout(300);
  const now = (await order(p)).join();
  ok(now !== startOrder && (await order(p)).indexOf('retention') === 0, `${tag} 390: a long-press and drag moves the card (${(await order(p)).slice(0, 5)})`);
  await liveHas(p, 'Moved Retention to position');
  ok(true, `${tag} 390: announced the move`);
  // x and Add on a phone
  await p.$eval('button[aria-label="Remove Mastery"]', e => e.scrollIntoView({ block: 'center' }));
  await p.click('button[aria-label="Remove Mastery"]');
  await p.waitForFunction(() => !document.querySelector('.ed-unit[data-card=mastery]'));
  await p.$eval('#edAdd', e => e.scrollIntoView({ block: 'center' }));
  await p.click('#edAdd'); await p.waitForSelector('#sheet[open] .aw-item');
  await p.screenshot({ path: `${SP}/add-widget-390-${tag}.png` });
  await p.click('.aw-item[data-id=mastery]'); await p.waitForSelector('.ed-unit[data-card=mastery]');
  ok(true, `${tag} 390: x and Add widget work on a phone`);
  // Done back to the normal page: the More stats fold is as before
  await p.evaluate(() => scrollTo(0, 0));
  await p.click('#edDone'); await p.waitForSelector('#editBtn');
  ok(await p.isVisible('#moreBtn').catch(() => false) || (await p.$('#moreBtn')) !== null, `${tag} 390: out of edit mode the phone page has its fold again`);
  await setLayout(p, null);
  await p.context().close();

  // ---------------- motion ----------------
  for (const motion of ['reduce', 'no-preference']) {
    p = await open(ui, 1280, 900, { motion });
    await stats(p); await edit(p);
    const m = await p.$eval('.ed-unit[data-card=perDay]', e => { const s = getComputedStyle(e); return { anim: s.animationName, outline: s.outlineStyle, w: s.outlineWidth }; });
    const wiggles = m.anim === 'ed-wiggle';
    if (motion === 'reduce') ok(m.anim === 'none' && m.outline === 'dashed', `${tag}: reduced motion: a dashed outline and no wiggle (${m.anim}, ${m.outline})`);
    else if (ui === 'original') ok(wiggles && m.outline !== 'dashed', `${tag}: with motion allowed the cards wiggle (${m.anim})`);
    else ok(m.anim === 'none' && m.outline === 'dashed', `${tag}: Clinical stays calm: a dashed outline, no wiggle (${m.anim}, ${m.outline})`);
    await p.context().close();
  }
}
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''));
await browser.close();
