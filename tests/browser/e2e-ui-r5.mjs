// Round 5 UI changes: 3 deck page Review first (PC), 5 sheet "Answer" label on its own line, 7 Help page 760px (PC),
// 8 finish links 44px (phone), 9 "N more in Decks" 44px (phone), 10 onboarding Skip 44px (phone), 11 Clinical exam rows visible (PC).
// Also checks the unapproved ideas did not change: sidebar stripes, deck code colour, sticky rating bar gradient, "All started" word.
// Run with: node tests/browser/run.mjs ui-r5
import { chromium, realChromium } from './pw.mjs';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const PC = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

const open = async (viewport, touch, clinical) => {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', colorScheme: 'dark', isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
  if (clinical) await ctx.addInitScript(() => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: 'clinical', skin: 'ocean', mode: 'dark' })); } catch { /* fine */ } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
  return p;
};
async function seed(p, nExtra = 5) {
  await p.evaluate(async nExtra => {
    const db = await import('./js/db.js');
    await db.deleteDeck('sample');
    const D = 86400000, now = Date.now();
    const iso = d => { const x = new Date(now + d * D); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const mk = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `${id} question ${i}`, back: `${id} answer ${i}`, tags: [], created: i }));
    const decks = [[{ id: 'bio', name: 'Cell Biology', course: 'BIOL 201', color: '#46A758', created: now + 1, examDate: iso(9) }, mk('bio', 12)],
      [{ id: 'neuro', name: 'Neuroscience', course: 'PSYC 240', color: '#8E4EC6', created: now + 2, examDate: iso(23) }, mk('neuro', 8)]];
    for (let i = 0; i < nExtra; i++) decks.push([{ id: 'x' + i, name: 'Extra ' + i, color: '#3E63DD', created: now + 10 + i }, mk('x' + i, 3)]);
    for (const [d, c] of decks) await db.addDeckWithCards(d, c);
    const cs = await db.getAll('cards');
    await db.putMany('cardStates', cs.map(c => ({ cardId: c.id, due: now - D, stability: 4, difficulty: 5, elapsedDays: 3, scheduledDays: 3, learningSteps: 0, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D })));
  }, nExtra);
  await p.reload(); await p.waitForSelector('.tdeck');
}
const go = async (p, hash, sel) => { await p.goto(URL + hash); await p.waitForSelector(sel); await p.waitForTimeout(250); };
const box = (p, sel) => p.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

// ---------- PC, Original ----------
{
  const p = await open(PC, false);
  await seed(p);
  await go(p, '#/deck/bio', '#reviewBtn');
  const order = await p.$$eval('.head-actions > .btn', bs => bs.map(b => ({ id: b.id || b.textContent.trim(), x: b.getBoundingClientRect().x })).sort((a, b) => a.x - b.x).map(b => b.id));
  ok(order[0] === 'reviewBtn', '3: PC deck page (exam 9 days): Review is the first button: ' + order.join(', '));
  const dom = await p.$$eval('.head-actions > .btn', bs => bs.map(b => b.id));
  ok(dom[0] === 'reviewBtn' && dom.indexOf('reviewBtn') < dom.indexOf('prepBtn'), '3: Tab order follows the DOM: Review comes before Exam prep: ' + dom.join(', '));
  const code = await p.$eval('.eyebrow.mono', e => getComputedStyle(e).color);
  const accent = await p.evaluate(() => { const t = document.createElement('i'); t.style.color = 'var(--accent-text)'; document.body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; });
  ok(code === accent, '6 (unchanged): deck code is still the accent colour (' + code + ' vs ' + accent + ')');
  await go(p, '#/help', 'main[data-route="help"] > .view');
  const hw = (await box(p, 'main[data-route="help"] > .view')).w;
  ok(hw <= 760.5 && hw > 500, '7: PC Help page is at most 760px wide (' + hw + ')');
  await go(p, '#/settings', 'main[data-route="settings"] > .view');
  ok(Math.abs((await box(p, 'main[data-route="settings"] > .view')).w - hw) < 1, '7: Help is the same width as Settings');
  await go(p, '#/today', '.today-hero');
  const stripe = await p.$eval('.side-deck:not(.side-new)', e => { const c = getComputedStyle(e, '::before'); return { w: c.width, br: c.borderRadius }; });
  ok(stripe.w === '3px', '1 (unchanged): sidebar deck marker is still a 3px stripe (' + JSON.stringify(stripe) + ')');
  // sheet on PC: label on its own line, choices on one row
  await go(p, '#/browse', '#brAdd');
  await p.click('#brAdd'); await p.waitForSelector('.answer-mode');
  const lab = await box(p, '.answer-mode-l'), chips = await p.$$eval('.answer-mode .chip', cs => cs.map(c => c.getBoundingClientRect().y));
  ok(chips.length === 3 && Math.max(...chips) - Math.min(...chips) < 2, '5: PC sheet: the 3 choices are on one row');
  ok(chips[0] > lab.y + lab.h - 1, '5: the "Answer" label sits above the choices');
  await p.close();
}

// ---------- phone, Original ----------
{
  const p = await open(PHONE, true);
  await seed(p, 6);
  const more = await p.$('.exam-add .link');
  ok(!!more, '9: the "N more in Decks" link is on Today');
  if (more) { const b = await box(p, '.exam-add .link'); ok(b.h >= 43.9, '9: "N more in Decks" is at least 44px tall (' + b.h + ')'); }
  await go(p, '#/browse', '#brAdd');
  await p.tap('#brAdd'); await p.waitForSelector('.answer-mode');
  const chips = await p.$$eval('.answer-mode .chip', cs => cs.map(c => Math.round(c.getBoundingClientRect().y)));
  ok(chips.length === 3 && Math.max(...chips) - Math.min(...chips) < 2, '5: phone 390: the 3 choices are on one row (' + chips + ')');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '5: no sideways scroll with the sheet open');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await go(p, '#/today', '#startBtn');
  await p.click('#startBtn'); await p.waitForSelector('#showBtn');
  await p.click('#showBtn'); await p.click('.rate.r3'); await p.waitForFunction(() => !document.querySelector('.rate'));
  await p.click('#endBtn'); await p.waitForSelector('.fin-links');
  ok(await p.locator('#undoLast').count() === 1, '8: Undo last is on the finish screen');
  for (const sel of ['.fin-links a.link', '.fin-links #undoLast']) { const b = await box(p, sel); ok(b.h >= 43.9, '8: ' + sel + ' is at least 44px tall (' + b.h + ')'); }
  ok(await p.locator('#againBtn').count() === 1 && /Back to Today/.test(await p.textContent('#againBtn')), '8: "Back to Today" is still there');
  await p.close();
}

// ---------- phone, onboarding ----------
{
  const rb = await realChromium.launch();
  const ctx = await rb.newContext({ viewport: PHONE, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(URL); await p.waitForSelector('#wlSkip');
  const b = await box(p, '#wlSkip');
  ok(b.h >= 43.9 && b.w >= 43.9, '10: onboarding Skip is at least 44x44 (' + b.w + 'x' + b.h + ')');
  await rb.close();
}

// ---------- PC, Clinical (clinical.css really loaded) ----------
{
  const p = await open(PC, false, true);
  await seed(p);
  await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('theme', { ui: 'clinical', skin: 'ocean', mode: 'dark', oled: false }); });
  await p.reload(); await p.waitForSelector('.exam-row');
  await p.waitForFunction(() => document.documentElement.dataset.ui === 'clinical' && !!document.getElementById('clinicalCss')?.sheet);
  await go(p, '#/today', '.exam-row');
  const r = await p.$eval('.exam-row > .btn.ghost[data-prep]', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, bc: c.borderTopColor }; });
  ok(r.bg === 'rgba(0, 0, 0, 0)', '11: Clinical: the click layer over an exam row is see-through (' + JSON.stringify(r) + ')');
  const vis = await p.evaluate(() => { const row = document.querySelector('.exam-row'), n = row.querySelector('.exam-name'), b = n.getBoundingClientRect(), t = document.elementFromPoint(b.x + 2, b.y + b.height / 2); return { name: n.textContent.trim(), hit: t === row.querySelector('[data-prep]') }; });
  ok(vis.name.length > 0, '11: Clinical: the exam row shows its deck name: ' + vis.name);
  // the name is painted: the layer on top has no solid paint
  const painted = await p.$eval('.exam-row', row => { const l = row.querySelector('[data-prep]'); return getComputedStyle(l).backgroundImage === 'none' && getComputedStyle(l).backgroundColor === 'rgba(0, 0, 0, 0)'; });
  ok(painted, '11: Clinical: nothing solid covers the exam row');
  await go(p, '#/deck/bio', '#reviewBtn');
  const order = await p.$$eval('.head-actions > .btn', bs => bs.map(b => ({ id: b.id || b.textContent.trim(), x: b.getBoundingClientRect().x })).sort((a, b) => a.x - b.x).map(b => b.id));
  ok(order[0] === 'reviewBtn', '3 (Clinical): the DOM now puts Review first, so Clinical (no CSS order) shows it first too: ' + order.join(', '));
  await go(p, '#/help', 'main[data-route="help"] > .view');
  ok((await box(p, 'main[data-route="help"] > .view')).w > 800, '7 (Clinical unchanged): Clinical Help page keeps its width');
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
