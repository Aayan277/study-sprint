// Play results (Round 2, A5) and Play's polish (A6): the order of the results screen, the first three misses plus
// "Show all", "First score for this setup" / "New best", a D with no "Keep practicing", leeches handed to the finish
// slot, the key hint only with a mouse, the empty Play screen, and re-tapping the Play tab starting a fresh setup.
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

// A recorder in place of the finish-extras module: remembers what Play hands to the results slot.
const SPY = `export const drawFinishExtras = (slot, args) => { (window.__fx = window.__fx || []).push({ ...args, entries: (args.entries || []).length }); };`;
const open = async ({ w = 375, h = 800, touch = true, scheme = 'dark' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, colorScheme: scheme });
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));
  await ctx.route('**/js/finish-extras.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: SPY }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck, .empty');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  return p;
};
const noHScroll = async (p, w, what) => ok(await p.evaluate(x => document.documentElement.scrollWidth <= x, w), 'no sideways scroll: ' + what);
const seed = (p, { id = 'pr', n = 40, due = false, leech = false } = {}) => p.evaluate(async ({ id, n, due, leech }) => {
  const db = await import('./js/db.js'); const day = 86400000;
  const cs = Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `Q${id}${i}`, back: `A${id}${i}`, tags: [], created: i }));
  await db.addDeckWithCards({ id, name: 'Results ' + id, color: '#46A758', created: Date.now() }, cs);
  if (due) await db.putStates(cs.map(c => ({ cardId: c.id, due: Date.now() - day, stability: 5, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: Date.now() - 10 * day })));
  if (leech) { await db.setSetting('playCountsAsReviews', true); await db.setSetting('leechThreshold', 1); await db.setSetting('leechAction', 'tag'); }
}, { id, n, due, leech });
const setup = async (p, deck) => {
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', deck);
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click());
};
// Answers the 10 questions of a running Classic round: right on the first `rights`, wrong on the rest.
const answerAll = async (p, rights) => {
  for (let i = 0; i < 10; i++) {
    await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
    const prompt = await p.textContent('#pPrompt');
    const right = await p.evaluate(v => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === 'A' + v.slice(1)), prompt);
    await p.keyboard.press(String((i < rights ? right : (right + 1) % 4) + 1));
    await p.waitForSelector('.fb'); await p.keyboard.press('Enter');
  }
  await p.waitForSelector('.res-head');
};
const playRound = async (p, rights) => { await p.click('#startBtn'); await p.waitForSelector('#pCard'); await answerAll(p, rights); };
const text = (p, sel) => p.evaluate(s => document.querySelector(s)?.textContent.trim() || '', sel);

// ---------- 1. Order, three misses, Show all, a D with no best ----------
let p = await open();
await seed(p);
await setup(p, 'pr');
await playRound(p, 0);                                   // all wrong: score 0, so not a best
const order = await p.evaluate(() => {
  const seq = ['.res-head', '.stats4', '.res-actions', '.sched-note', '#resultsMore', '.missed'].map(s => document.querySelector(s));
  return seq.every(Boolean) && seq.every((e, i) => !i || (seq[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
});
ok(order, 'results order: head, stats, actions, schedule note, #resultsMore, missed');
const total = await p.locator('.missed .miss').count();
ok(total >= 4, 'an all-wrong round misses several cards: ' + total);
ok((await p.locator('.missed .miss:visible').count()) === 3, 'only the first 3 misses are shown');
ok((await text(p, '#showAllMiss')) === `Show all ${total}`, 'a "Show all ' + total + '" button');
ok(await p.locator('#resultsMore').isHidden(), 'the finish slot stays hidden while there is nothing for it');
await noHScroll(p, 375, 'results 375'); await p.screenshot({ path: SP + '/pr-results-375-dark.png', fullPage: true });
await p.click('#showAllMiss');
ok((await p.locator('.missed .miss:visible').count()) === total && (await p.locator('#showAllMiss').count()) === 0, 'Show all reveals every miss and the button goes');
ok(!(await p.locator('.newbest').count()), 'a score of 0 is not a best');
ok((await text(p, '.stamp')) === 'D' && (await p.locator('.stamp.quiet').count()) === 1, 'a D gets the quiet stamp');
ok((await text(p, '.res-grade')).startsWith('Keep practicing'), 'a D that is not a best says what it is');

// A D that is a first best: "First score", "Grade D", no "Keep practicing"
await p.click('#menuBtn'); await p.waitForSelector('#startBtn');
await playRound(p, 1);
ok((await text(p, '.stamp')) === 'D', 'one right in ten is a D');
ok((await text(p, '.newbest')) === 'First score for this setup', 'the first score for a setup says so');
ok((await text(p, '.res-grade')).startsWith('Grade D') && !(await p.content()).includes('Keep practicing'), 'a D best shows "Grade D", no "Keep practicing"');
await p.screenshot({ path: SP + '/pr-results-375-dark-D.png', fullPage: true });

// Beat it: "New best"
await p.evaluate(async () => { const db = await import('./js/db.js'); const s = await db.getSettings(); const b = {}; for (const k in s.playBest) b[k] = 1; await db.setSetting('playBest', b); });
await p.click('#againBtn'); await p.waitForSelector('#pCard'); await answerAll(p, 10);
ok((await text(p, '.newbest')) === 'New best for this setup', 'beating an earlier score says "New best"');
ok(/^[SAB]$/.test(await text(p, '.stamp')) && !(await p.locator('.stamp.quiet').count()), 'an S, A or B gets the full stamp');
await p.screenshot({ path: SP + '/pr-results-375-dark-best.png', fullPage: true });

// ---------- 2. Re-tapping the Play tab on the results starts a fresh setup ----------
await p.click('.tab[data-tab=play]');
await p.waitForSelector('#startBtn');
ok((await p.locator('.res-head').count()) === 0, 're-tapping the Play tab on the results opens a fresh setup');
await p.click('.tab[data-tab=play]'); await p.waitForSelector('#startBtn');
ok(true, 're-tapping it on the setup is harmless');
ok(!(await p.content()).includes('>PLAY<'), 'no PLAY eyebrow');
await p.context().close();

// A touch screen (no hover) never sees the key hint
p = await open(); await seed(p); await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#startBtn');
ok(await p.locator('.hint.keys').count() === 0, 'no key hint line on the Play setup (cut)');
await p.context().close();

// ---------- 3. Leeches are collected and handed to the finish slot ----------
p = await open();
await seed(p, { id: 'lk', n: 8, due: true, leech: true });
await setup(p, 'lk');
await playRound(p, 0);
await p.waitForFunction(() => window.__fx && window.__fx.length);
const fx = await p.evaluate(() => (window.__fx || []).slice(-1)[0]);
ok(fx && fx.source === 'play' && fx.leechIds.length >= 4 && fx.leechIds.every(id => id.startsWith('lk')), 'leech ids go to drawFinishExtras: ' + JSON.stringify(fx && fx.leechIds));
ok(fx && fx.cardIds.length >= 4 && fx.entries === 10, 'and the answered card ids and the 10 log entries');
await p.context().close();

// ---------- 4. Key hint with a mouse; 1440 light and dark; 375 light ----------
for (const scheme of ['light', 'dark']) {
  p = await open({ w: 1440, h: 900, touch: false, scheme });
  await seed(p);
  await setup(p, 'pr');
  ok(await p.locator('.hint.keys').count() === 0, `a mouse sees no key hint line either (${scheme})`);
  await p.screenshot({ path: SP + `/pr-setup-1440-${scheme}.png`, fullPage: true });
  await playRound(p, 2);
  await p.screenshot({ path: SP + `/pr-results-1440-${scheme}.png`, fullPage: true });
  await p.context().close();
}
p = await open({ scheme: 'light' });
await seed(p);
await setup(p, 'pr'); await playRound(p, 0);
await p.screenshot({ path: SP + '/pr-results-375-light.png', fullPage: true });
await p.context().close();

// ---------- 5. The empty Play screen ----------
p = await open();
await p.evaluate(async () => { const db = await import('./js/db.js'); for (const d of await db.getAll('decks')) await db.deleteDeck(d.id); location.hash = '#/play'; });
await p.waitForSelector('.empty-first');
ok((await text(p, '.empty-first b')) === 'Nothing to study yet' && (await p.locator('#trySample').count()) === 1, 'no cards: the shared start block (paste notes, try samples)');
ok(!(await p.content()).includes('>PLAY<'), 'no PLAY eyebrow on the empty screen');
await noHScroll(p, 375, 'empty Play'); await p.screenshot({ path: SP + '/pr-empty-375-dark.png', fullPage: true });
await p.click('#trySample'); await p.waitForURL(/#\/welcome\/review\/sample/);
ok(true, '"Try sample cards" opens the guided review');
await p.context().close();

ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
