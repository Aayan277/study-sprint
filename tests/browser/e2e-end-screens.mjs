// 4.66 WP-A: one layout for the three end screens (Review finish, Play results, Practice test results).
// The first button of .res-actions is the primary one, there is at most one ghost button beside it, and everything else sits
// under a "More" fold (button with aria-expanded, a panel that opens and closes). Phone and computer, light and dark.
// Run with: node tests/browser/run.mjs end-screens
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';

const open = async ({ w = 390, h = 844, scheme = 'dark' } = {}) => {
  const touch = w < 600;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck, .empty');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  return p;
};
const seed = p => p.evaluate(async () => {
  const db = await import('./js/db.js'); const day = 86400000;
  const cs = Array.from({ length: 12 }, (_, i) => ({ id: 'e' + i, deckId: 'es', front: `Term e${i}`, back: `Meaning e${i}`, tags: [], created: i }));
  await db.addDeckWithCards({ id: 'es', name: 'End screens', color: '#46A758', created: Date.now() }, cs);
  await db.putStates(cs.map(c => ({ cardId: c.id, due: Date.now() - day, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: Date.now() - 10 * day })));
  await db.setSetting('testPrefs', { es: { count: 10, kinds: ['mc'], limit: 0, order: 'random', counts: false, tags: [] } });
});
const noHScroll = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + what);
// The rule itself: the first button is primary, at most one ghost beside it.
const rule = async (p, what, { more }) => {
  const r = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.res-actions > button, .res-actions > a')];
    return { first: b[0]?.classList.contains('primary'), n: b.length, ghosts: b.filter(x => x.classList.contains('ghost')).length, primaries: b.filter(x => x.classList.contains('primary')).length };
  });
  ok(r.first && r.primaries === 1 && r.ghosts <= 1 && r.n <= 2, `${what}: first button is primary, at most one ghost (${r.n} buttons, ${r.ghosts} ghost)`);
  if (more) ok(await p.locator(`${more}`).count() === 1, `${what}: the other buttons sit under More`);
};
// Play: all wrong, so Drill missed shows.
const playRound = async p => {
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', 'es');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click());
  await p.click('#startBtn'); await p.waitForSelector('#pCard');
  for (let i = 0; i < 10; i++) {
    await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
    const prompt = await p.textContent('#pPrompt');
    const right = await p.evaluate(v => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === 'Meaning' + v.slice(4)), prompt);
    await p.keyboard.press(String(((right + 1) % 4) + 1));
    await p.waitForSelector('.fb'); await p.keyboard.press('Enter');
  }
  await p.waitForSelector('.res-head');
};
const state = p => p.evaluate(() => JSON.parse(localStorage.getItem('study-sprint-test-state')));
const run = p => p.evaluate(() => JSON.parse(localStorage.getItem('study-sprint-test-run')));
// Practice test: answer every question right (all=true) or wrong, submit.
const testRound = async (p, allRight) => {
  await p.goto(URL + '#/deck/es'); await p.waitForSelector('#testBtn');
  await p.click('#testBtn'); await p.waitForSelector('#ptForm');
  await p.click('#ptStart'); await p.waitForSelector('#tPrompt');
  const r = await run(p);
  for (let i = 0; i < r.questions.length; i++) {
    const q = r.questions[i];
    if (q.kind === 'mc') { const right = q.options.indexOf(q.answer); await p.locator('.t-opt').nth(allRight ? right : (right + 1) % q.options.length).click(); }
    else await p.locator('.t-opt').nth((allRight) === q.truth ? 0 : 1).click();
    if (i < r.questions.length - 1) await p.click('#tNext');
  }
  await p.click('#tSubmit'); if (await p.isVisible('#tAskYes')) await p.click('#tAskYes');
  await p.waitForSelector('#tReview');
};
const foldWorks = async (p, btn, panel, what) => {
  ok(await p.getAttribute(btn, 'aria-expanded') === 'false' && await p.isHidden(panel), `${what}: More starts closed`);
  await p.click(btn);
  ok(await p.getAttribute(btn, 'aria-expanded') === 'true' && await p.isVisible(panel), `${what}: More opens the panel and says so (aria-expanded)`);
  ok(await p.evaluate(b => document.activeElement?.id === b, btn.slice(1)), `${what}: focus stays on More`);
  await p.click(btn);
  ok(await p.getAttribute(btn, 'aria-expanded') === 'false' && await p.isHidden(panel), `${what}: a second tap closes it`);
};

for (const [w, scheme] of [[390, 'dark'], [1280, 'light']]) {
  const tag = `${w}px ${scheme}`;
  const p = await open({ w, scheme });
  await seed(p);

  // ---- Play ----
  await playRound(p);
  await rule(p, `Play results (${tag})`, { more: '#playMore #menuBtn' });
  ok(await p.locator('#drillBtn.ghost').count() === 1 && await p.locator('#againBtn.primary').count() === 1, `Play (${tag}): Play again primary, Drill missed ghost`);
  ok(await p.isHidden('#menuBtn'), `Play (${tag}): Change setup is hidden until More is opened`);
  await foldWorks(p, '#playMoreBtn', '#playMore', `Play (${tag})`);
  await noHScroll(p, `Play results ${tag}`);
  await p.click('#playMoreBtn');
  ok(await p.isVisible('#menuBtn'), `Play (${tag}): More reveals Change setup`);
  await noHScroll(p, `Play results with More open ${tag}`);
  await p.click('#menuBtn'); await p.waitForSelector('#startBtn');

  // ---- Practice test, with missed questions ----
  await testRound(p, false);
  await rule(p, `Practice results (${tag})`, { more: '#tMore #tRetake' });
  ok(await p.locator('#tDrill.primary').count() === 1 && await p.locator('#tDone2.ghost').count() === 1, `Practice (${tag}): Drill missed primary, Done ghost`);
  ok(await p.locator('#tMore button').count() === 3, `Practice (${tag}): More holds three buttons (Retake, New set, Change setup)`);
  ok(await p.isHidden('#tRetake') && await p.isHidden('#tNewSet') && await p.isHidden('#tSetup'), `Practice (${tag}): the three are hidden until More is opened`);
  await foldWorks(p, '#tMoreBtn', '#tMore', `Practice (${tag})`);
  await noHScroll(p, `Practice results ${tag}`);
  await p.click('#tMoreBtn');
  ok(await p.isVisible('#tRetake') && await p.isVisible('#tNewSet') && await p.isVisible('#tSetup'), `Practice (${tag}): More reveals all three`);
  await noHScroll(p, `Practice results with More open ${tag}`);
  await p.screenshot({ path: `${process.argv[2] || '/tmp'}/end-practice-${w}-${scheme}.png`, fullPage: true });

  // ---- Practice test, nothing missed: Retake becomes primary ----
  await testRound(p, true);
  ok(await p.locator('#tDrill').count() === 0 && await p.locator('.res-actions > #tRetake.primary').count() === 1, `Practice, all right (${tag}): Retake is the primary button`);
  await rule(p, `Practice, all right (${tag})`, {});
  ok(await p.locator('#tMore button').count() === 2 && await p.isHidden('#tNewSet'), `Practice, all right (${tag}): New set and Change setup sit under More`);

  // ---- Review finish ----
  await p.evaluate(async () => { const db = await import('./js/db.js'); const day = 86400000; const c = await db.getAll('cardStates'); await db.putStates(c.map(s => ({ ...s, due: Date.now() - day }))); });
  await p.goto(URL + '#/today'); await p.waitForSelector('#startBtn');
  await p.click('#startBtn');
  for (let i = 0; i < 60 && !(await p.$('.res-actions')); i++) {
    await p.waitForSelector('#showBtn, .res-actions'); if (await p.$('.res-actions')) break;
    await p.click('#showBtn'); await p.click('.rate.r3');
    await p.waitForTimeout(50);
  }
  await p.waitForSelector('.res-actions');
  await rule(p, `Review finish (${tag})`, {});
  await p.context().close();
}
if (errors.length) { console.log('FAIL errors: ' + errors.join(' | ')); process.exitCode = 1; } else ok(true, 'no page errors');
await browser.close();
