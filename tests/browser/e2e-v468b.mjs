// 4.68 WP-B: "Add exam date" on Today is one button. It opens one sheet with a Deck dropdown (every deck without an exam
// date, largest first). Checks: one deck (no dropdown), six decks (all listed, no chips, no Decks link), the toast and
// Upcoming exams after saving, the past-date error, Escape returning focus, and the layout in Original and Clinical.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const open = async (w, h, clinical) => {
  const touch = w < 800;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
  if (clinical) await ctx.addInitScript(() => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: 'clinical', skin: 'ocean', mode: 'light' })); } catch { /* fine */ } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
  if (clinical) { await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('theme', { ui: 'clinical', skin: 'ocean', mode: 'light', oled: false }); }); await p.reload(); await p.waitForSelector('.today-hero'); }
  return { ctx, p };
};
// n decks without an exam date; deck i has (n - i) cards, so "largest first" is the order they were made in.
async function seed(p, n, { withExam = false } = {}) {
  await p.evaluate(async ({ n, withExam }) => {
    const db = await import('./js/db.js');
    await db.deleteDeck('sample');
    const D = 86400000, now = Date.now();
    const iso = d => { const x = new Date(now + d * D); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const mk = (id, k) => Array.from({ length: k }, (_, i) => ({ id: id + i, deckId: id, front: `${id} q${i}`, back: `${id} a${i}`, tags: [], created: i }));
    if (withExam) await db.addDeckWithCards({ id: 'ex', name: 'Has Exam', color: '#46A758', created: now, examDate: iso(9) }, mk('ex', 3));
    const names = ['Anatomy and Physiology', 'Organic Chemistry II', 'Macroeconomics', 'Constitutional Law', 'Linear Algebra', 'World History'];
    for (let i = 0; i < n; i++) await db.addDeckWithCards({ id: 'd' + i, name: names[i], color: '#3E63DD', created: now + i + 1 }, mk('d' + i, 10 - i));
    const cs = await db.getAll('cards');
    await db.putMany('cardStates', cs.map(c => ({ cardId: c.id, due: now - D, stability: 4, difficulty: 5, elapsedDays: 3, scheduledDays: 3, learningSteps: 0, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D })));
  }, { n, withExam });
  await p.reload(); await p.waitForSelector('.tdeck');
}
const waitClosed = p => p.waitForFunction(() => !document.getElementById('sheet').open);

// ---------- one deck without an exam: no dropdown ----------
{
  const { ctx, p } = await open(1440, 900, false);
  await seed(p, 1, { withExam: true });
  ok(await p.$$eval('#addExamBtn', b => b.length) === 1, 'one deck: one button');
  ok((await p.textContent('#addExamBtn')).trim() === 'Add exam date', 'the button says "Add exam date"');
  await p.click('#addExamBtn'); await p.waitForSelector('#xdForm');
  ok(!(await p.$('#xdDeck')), 'one deck: no dropdown');
  ok((await p.textContent('#sheetTitle')) === 'Anatomy and Physiology exam', 'one deck: title is "{name} exam"');
  await p.keyboard.press('Escape'); await waitClosed(p);
  ok(await p.evaluate(() => document.activeElement && document.activeElement.id) === 'addExamBtn', 'Escape returns focus to the button');
  await ctx.close();
}

// ---------- six decks ----------
{
  const { ctx, p } = await open(1440, 900, false);
  await seed(p, 6);
  ok(await p.$$eval('#addExamBtn', b => b.length) === 1 && !(await p.$('[data-addexam]')) && !(await p.$('.exam-add a')), 'six decks: one button, no chips, no Decks link');
  await p.click('#addExamBtn'); await p.waitForSelector('#xdForm');
  const opts = await p.$$eval('#xdDeck option', o => o.map(x => x.value));
  ok(opts.length === 6 && opts.join() === 'd0,d1,d2,d3,d4,d5', 'the dropdown lists all 6, largest first: ' + opts.join());
  ok((await p.textContent('#sheetTitle')) === 'Add exam date', 'the title is "Add exam date"');
  await p.selectOption('#xdDeck', 'd2');
  await p.click('[data-days="14"]');
  await p.click('button[type=submit][form=xdForm]'); await waitClosed(p);
  ok((await p.textContent('#toast')).includes('Macroeconomics: exam in 14 days'), 'toast names deck 3: ' + await p.textContent('#toast'));
  ok(await p.$$eval('.exam-row', r => r.some(x => x.textContent.includes('Macroeconomics'))), 'it is under Upcoming exams');
  await p.click('#addExamBtn'); await p.waitForSelector('#xdForm');
  ok(!(await p.$('#xdDeck option[value="d2"]')) && await p.$$eval('#xdDeck option', o => o.length) === 5, 'and it is gone from the dropdown');
  // a past date
  await p.fill('#xdDate', '2020-01-01'); await p.click('button[type=submit][form=xdForm]');
  ok(await p.isVisible('#xdErr') && (await p.textContent('#xdErr')).includes('passed') && await p.evaluate(() => document.getElementById('sheet').open), 'a past date shows the error');
  await ctx.close();
}

// ---------- layout ----------
for (const [w, h, clinical, name] of [[375, 812, false, 'Original 375'], [1440, 900, false, 'Original 1440'], [375, 812, true, 'Clinical 375'], [1280, 800, true, 'Clinical 1280'], [1440, 900, true, 'Clinical 1440']]) {
  const { ctx, p } = await open(w, h, clinical);
  await seed(p, 6, { withExam: true });
  const g = await p.evaluate(() => {
    const b = document.getElementById('addExamBtn'), r = b.getBoundingClientRect(), hero = document.querySelector('.today-hero').getBoundingClientRect();
    return { inSide: !!b.closest('.today-side'), left: r.left, right: r.right, top: r.top, heroRight: hero.right, heroBottom: hero.bottom, h: r.height, vw: innerWidth, hs: document.documentElement.scrollWidth > innerWidth };
  });
  console.log(name, JSON.stringify(g));
  if (clinical) ok(await p.evaluate(() => document.documentElement.dataset.ui) === 'clinical', name + ': Clinical is on');
  ok(g.inSide, name + ': the button is inside .today-side');
  ok(g.left >= 0 && g.right <= g.vw, name + ': the button is not cut off');
  ok(!g.hs, name + ': no sideways scroll');
  if (clinical && w >= 1280) ok(g.left >= g.heroRight - 1, name + ': to the right of the hero');
  else if (w >= 1440) ok(g.left >= g.heroRight - 1 || g.top >= g.heroBottom - 1, name + ': beside or below the hero');
  await ctx.close();
}
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
