// "You mix these up" (Round 2, B2): Play records mixedWith when a wrong pick/typed answer is another card's answer;
// the results panel shows the pair; Compare opens (two columns, stacked on a phone); Review these opens a Review session of the
// pair (v4.9: the game is only on the Play page, so the Play drill is gone); the card panel says "Often mixed up with"; the log row and the backup carry the field; importAll cleans it.
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

// Math.random is seeded in the page, so the order of questions is the same every run.
const SEED = `(() => { let s = 20261014; Math.random = () => (s = (s * 16807) % 2147483647) / 2147483647; })();`;
const open = async ({ w = 375, h = 800, scheme = 'dark' } = {}) => {
  const touch = w < 600;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, colorScheme: scheme });
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));
  await ctx.addInitScript(SEED);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck, .empty');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  return p;
};
const noHScroll = async (p, w, what) => ok(await p.evaluate(x => document.documentElement.scrollWidth <= x, w), 'no sideways scroll: ' + what);
const FRONTS = ['Alpha', 'Beta', 'Gamma', 'Delta'], BACKS = ['Apple', 'Banana', 'Cherry', 'Durian'];
// Four cards: every question shows all four answers, so the wrong pick can always be the partner's answer.
const seed4 = (p, on = true) => p.evaluate(async ({ FRONTS, BACKS, on }) => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'mx', name: 'Fruit', color: '#46A758', created: Date.now() },
    FRONTS.map((f, i) => ({ id: 'mx' + i, deckId: 'mx', front: f, back: BACKS[i], tags: [], created: i })));
  if (on) await db.setSetting('playCountsAsReviews', true);       // v4.10: lasting mix-ups are read from Play log rows, which are only written when Play counts as reviews
}, { FRONTS, BACKS, on });
// Twelve cards where card 0 and card 1 are confused in the log, so the drill's `include` is what puts the partner's answer in the options.
const seed12 = p => p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  const cs = Array.from({ length: 12 }, (_, i) => ({ id: 'bg' + i, deckId: 'bg', front: `Term ${i}`, back: `Meaning ${i}`, tags: [], created: i }));
  await db.addDeckWithCards({ id: 'bg', name: 'Big', color: '#46A758', created: now }, cs);
  for (const [from, to, min] of [['bg0', 'bg1', 10], ['bg1', 'bg0', 20], ['bg0', 'bg1', 30]])
    await db.addLog({ cardId: from, timestamp: now - min * 60000, source: 'play', mode: 'front', format: 'classic', correct: false, ms: 2000, rating: 1, chars: 10, hard: false, state: 0, applied: false, reason: 'new', mixedWith: to });
});
const setup = async (p, deck, qtype) => {
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', deck);
  for (const s of ['input[name=fmt][value=classic]', `input[name=qtype][value=${qtype}]`, 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click());
};
const nextQuestion = p => p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
// Multiple choice: Alpha gets Banana (Beta's answer), Beta gets Apple (Alpha's); the others are right.
const mcRound = async p => {
  for (let i = 0; i < 10; i++) {
    await nextQuestion(p);
    const prompt = (await p.textContent('#pPrompt')).trim();
    const want = { Alpha: 'Banana', Beta: 'Apple' }[prompt] ?? BACKS[FRONTS.indexOf(prompt)];
    const idx = await p.evaluate(w => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === w), want);
    await p.keyboard.press(String(idx + 1));
    await p.waitForSelector('.fb'); await p.keyboard.press('Enter');
  }
  await p.waitForSelector('.res-head');
};
const logs = p => p.evaluate(async () => (await (await import('./js/db.js')).getLogsSince(0)).map(l => ({ c: l.cardId, m: l.mixedWith, ok: l.correct })));

// ---------- 1. Multiple choice: the picks are recorded, the results show the pair, Compare, Drill ----------
let p = await open();
await seed4(p);
await setup(p, 'mx', 'front');
await p.click('#startBtn'); await p.waitForSelector('#pCard');
await mcRound(p);
let rows = await logs(p);
const aRows = rows.filter(r => r.c === 'mx0'), bRows = rows.filter(r => r.c === 'mx1'), otherRows = rows.filter(r => r.c !== 'mx0' && r.c !== 'mx1');
ok(rows.length === 10, 'ten answers logged: ' + rows.length);
ok(aRows.length >= 2 && aRows.every(r => r.m === 'mx1' && !r.ok), 'every wrong pick of Banana for Alpha has mixedWith = Beta');
ok(bRows.length >= 2 && bRows.every(r => r.m === 'mx0' && !r.ok), 'every wrong pick of Apple for Beta has mixedWith = Alpha');
ok(otherRows.every(r => r.m === undefined && r.ok), 'right answers have no mixedWith');
await p.waitForSelector('.mixups .mix-row');
ok((await p.textContent('.mixups h2')) === 'You mix these up', 'results panel: "You mix these up"');
const rowText = await p.textContent('.mix-row');
ok(/Alpha/.test(rowText) && /Beta/.test(rowText) && /2×/.test(rowText), 'the row names both cards and counts 2×: ' + rowText.replace(/\s+/g, ' ').trim());
ok(await p.locator('#resultsMore').isVisible() && (await p.locator('.mix-row').count()) === 1, 'one pair, the slot is shown');
await noHScroll(p, 375, 'results 375'); await p.screenshot({ path: SP + '/mx-results-375-dark.png', fullPage: true });

await p.click('.mix-row button');
await p.waitForSelector('#sheet .cmp');
const cols = await p.evaluate(() => [...document.querySelectorAll('#sheet .cmp-col')].map(c => { const r = c.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), text: c.textContent.replace(/\s+/g, ' ') }; }));
ok(cols.length === 2 && cols[0].text.includes('Alpha') && cols[0].text.includes('Apple') && cols[1].text.includes('Beta') && cols[1].text.includes('Banana'), 'two columns with front and back of each card');
ok(cols[1].t > cols[0].t && Math.abs(cols[0].l - cols[1].l) < 4, 'stacked under 600px');
ok((await p.locator('#sheet button').allTextContents()).map(t => t.trim()).filter(t => ['Review these', 'Make a comparison card', 'Not confused'].includes(t)).length === 3, 'Review these, Make a comparison card and Not confused');
await noHScroll(p, 375, 'compare 375'); await p.screenshot({ path: SP + '/mx-compare-375-dark.png' });

// v4.9: Review these (was "Drill these", a Play round): a Review session of exactly the two cards, no Play round
await p.click('#cmpDrill');
await p.waitForSelector('#flash');
ok(p.url().includes('#/review') && !(await p.locator('#pCard').count()), 'Review these opens Review, not Play');
const seenFronts = [];
while (!(await p.$('.finish-next'))) {
  await p.waitForSelector('#showBtn, .finish-next');
  if (await p.$('.finish-next')) break;
  seenFronts.push((await p.textContent('#flash .flash-front')).trim());
  await p.click('#showBtn'); await p.click('.rate.r4');   // Easy: a new card graduates, so it is seen once
  await p.waitForFunction(() => !document.querySelector('.rate'));
}
ok(seenFronts.length === 2 && seenFronts.some(t => t.includes('Alpha')) && seenFronts.some(t => t.includes('Beta')), 'the session is exactly Alpha and Beta: ' + seenFronts.map(t => t.slice(0, 12)).join(' | '));
ok(await p.locator('#screen a[href="#/play"]').count() === 0, 'the finish screen has no Play link');
await p.context().close();

// ---------- 2. Typed answers: only an exact answer of another card counts ----------
p = await open();
await seed4(p);
await setup(p, 'mx', 'typing');
await p.click('#startBtn'); await p.waitForSelector('#pInput');
for (let i = 0; i < 10; i++) {
  await nextQuestion(p);
  const prompt = (await p.textContent('#pPrompt')).trim();
  if (prompt === 'Gamma') { await p.click('#skipBtn'); }
  else {
    await p.fill('#pInput', { Alpha: 'Banana', Beta: 'Aplpe', Delta: 'xyz' }[prompt]);   // Beta's answer for Alpha; a typo of Alpha's own for Beta
    await p.keyboard.press('Enter');
  }
  await p.waitForSelector('.fb'); await p.keyboard.press('Enter');
  if (i < 9) await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' || document.querySelector('.res-head'));
}
await p.waitForSelector('.res-head');
rows = await logs(p);
const typed = c => rows.filter(r => r.c === c);
ok(typed('mx0').length >= 2 && typed('mx0').every(r => r.m === 'mx1'), 'typing another card’s exact answer sets mixedWith');
ok(typed('mx1').every(r => r.m === undefined), 'a typo of the card’s own answer does not (no forgiveness: "Aplpe" is not "Apple")');
ok(typed('mx2').every(r => r.m === undefined), 'a skip does not');
ok(typed('mx3').every(r => r.m === undefined), 'a wrong answer that matches no card does not');
await p.context().close();

// ---------- 3. The card panel, a drill that includes the partner among many cards, the backup ----------
p = await open();
await seed12(p);
await p.evaluate(() => { location.hash = '#/browse'; });
await p.waitForSelector('.crow[data-id=bg0] .crow-btn');
await p.click('.crow[data-id=bg0] .crow-btn');
await p.waitForSelector('#ceMixed:not([hidden])');
const line = (await p.textContent('#ceMixed')).replace(/\s+/g, ' ').trim();
ok(/^Often mixed up with: Term 1 \(3×\) · Compare$/.test(line), 'card panel: "' + line + '"');
await noHScroll(p, 375, 'card panel 375'); await p.screenshot({ path: SP + '/mx-cardpanel-375-dark.png' });
await p.click('#ceMixed [data-mix-with]');
await p.waitForSelector('#sheet .cmp');
await p.click('#cmpDrill');
await p.waitForSelector('#flash');
const pair = [];
while (!(await p.$('.finish-next'))) {
  await p.waitForSelector('#showBtn, .finish-next');
  if (await p.$('.finish-next')) break;
  pair.push((await p.textContent('#flash .flash-front')).trim());
  await p.click('#showBtn'); await p.click('.rate.r4');
  await p.waitForFunction(() => !document.querySelector('.rate'));
}
ok(pair.length === 2 && pair.some(t => t.includes('Term 0')) && pair.some(t => t.includes('Term 1')), 'Review these from the card panel: Term 0 and Term 1 (' + pair.length + ')');

// Backup and restore keep the field; a bad value is dropped
const backup = await p.evaluate(async () => (await import('./js/db.js')).exportAll());
ok(backup.reviewLog.filter(l => l.mixedWith === 'bg1').length >= 2, 'the backup contains mixedWith');
const cleaned = await p.evaluate(async b => {
  const db = await import('./js/db.js');
  const { id, ...row } = b.reviewLog[0];          // no id: new rows, so the originals stay
  const mark = { ...row, uid: 'bad1', mixedWith: 5 }, long = { ...row, uid: 'bad2', mixedWith: 'x'.repeat(201) };
  const data = { ...b, reviewLog: [...b.reviewLog, mark, long] };
  const err = db.checkBackup(data);
  await db.importAll(data);
  const after = await db.getAll('reviewLog');
  return { err, kept: after.filter(l => l.mixedWith === 'bg1').length, bad: after.filter(l => l.uid === 'bad1' || l.uid === 'bad2').map(l => 'mixedWith' in l) };
}, backup);
ok(cleaned.err === null, 'checkBackup does not reject mixedWith');
ok(cleaned.kept === backup.reviewLog.filter(l => l.mixedWith === 'bg1').length && cleaned.bad.length === 2 && cleaned.bad.every(x => !x), 'importAll keeps a good mixedWith and drops 5 and a 201-character string');

// "Not confused" hides the pair until it has been mixed up twice more
await p.evaluate(() => { location.hash = '#/browse'; });
await p.waitForSelector('.crow[data-id=bg0] .crow-btn');
await p.click('.crow[data-id=bg0] .crow-btn'); await p.waitForSelector('#ceMixed:not([hidden])');
await p.click('#ceMixed [data-mix-with]'); await p.waitForSelector('#cmpNot');
await p.click('#cmpNot');
await p.evaluate(() => { location.hash = '#/browse'; });
await p.waitForSelector('.crow[data-id=bg0] .crow-btn');
await p.click('.crow[data-id=bg0] .crow-btn'); await p.waitForSelector('#sheet .card-info');
await p.waitForTimeout(600);
ok(await p.locator('#ceMixed').isHidden(), 'after "Not confused" the card panel no longer lists the partner');
await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.getElementById('sheet').open);

// Make a comparison card
await p.evaluate(() => { localStorage.removeItem('study-sprint-mix-dismissed'); });
await p.evaluate(() => { location.hash = '#/browse'; });
await p.waitForSelector('.crow[data-id=bg0] .crow-btn');
await p.click('.crow[data-id=bg0] .crow-btn'); await p.waitForSelector('#ceMixed:not([hidden])');
await p.click('#ceMixed [data-mix-with]'); await p.waitForSelector('#cmpMake');
await p.click('#cmpMake');
// v4.8.1: "Make a comparison card" opens the add-card form prefilled; nothing is saved until Add (Cancel leaves no junk).
await p.waitForSelector('#acForm');
const findMade = () => p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.front.includes(' vs ')));
const filled = await p.evaluate(async () => { const m = await import('./js/card-editor.js'); return [m.readCardText('acFront').trim(), m.readCardText('acBack').trim()]; });
ok(filled[0] === "Term 0 vs Term 1: what's the difference?" && filled[1] === '- Term 0: …\n- Term 1: …', 'the add-card form is prefilled with the comparison text');
ok((await findMade()).length === 0, 'nothing is saved before Add');
await p.click('#acDone'); await p.waitForFunction(() => !document.getElementById('sheet').open);
ok((await findMade()).length === 0, 'Cancel leaves no card behind');
await p.click('.crow[data-id=bg0] .crow-btn'); await p.waitForSelector('#ceMixed:not([hidden])');
await p.click('#ceMixed [data-mix-with]'); await p.waitForSelector('#cmpMake');
await p.click('#cmpMake'); await p.waitForSelector('#acForm');
await p.keyboard.press('Control+Enter');
await p.waitForFunction(() => !document.getElementById('sheet').open);
const made = (await findMade())[0];
ok(made && made.front === "Term 0 vs Term 1: what's the difference?" && made.back === '- Term 0: …\n- Term 1: …' && made.deckId === 'bg' && (await findMade()).length === 1, 'Add saves one comparison card in the first card’s deck');
await p.context().close();

// ---------- 3b. Play is practice only (the default): nothing saved, but the results show this round's own mix-ups ----------
p = await open();
await seed4(p, false);
await setup(p, 'mx', 'front');
await p.click('#startBtn'); await p.waitForSelector('#pCard');
await mcRound(p);
ok((await logs(p)).length === 0, 'practice only: no review-log rows are saved');
await p.waitForSelector('.mixups .mix-row');
const offText = await p.textContent('.mix-row');
ok(/Alpha/.test(offText) && /Beta/.test(offText) && /2×/.test(offText), 'practice only: the results panel still shows this round\'s pair, 2×: ' + offText.replace(/\s+/g, ' ').trim());
ok(await p.evaluate(async () => (await (await import('./js/compare-sheet.js')).loadPairs()).pairs.length) === 0, 'practice only: no lasting pair is saved (the card panel and later rounds see none)');
await p.context().close();

// ---------- 4. Looks: Compare and results at 375/1440, dark and light ----------
for (const [w, scheme] of [[375, 'light'], [1440, 'dark'], [1440, 'light']]) {
  p = await open({ w, h: w > 600 ? 900 : 800, scheme });
  await seed4(p);
  await setup(p, 'mx', 'front');
  await p.click('#startBtn'); await p.waitForSelector('#pCard');
  await mcRound(p);
  await p.waitForSelector('.mixups .mix-row');
  await noHScroll(p, w, `results ${w} ${scheme}`);
  await p.screenshot({ path: SP + `/mx-results-${w}-${scheme}.png`, fullPage: true });
  await p.click('.mix-row button'); await p.waitForSelector('#sheet .cmp');
  if (w > 600) {
    const c = await p.evaluate(() => [...document.querySelectorAll('#sheet .cmp-col')].map(x => Math.round(x.getBoundingClientRect().top)));
    ok(c[0] === c[1], `two columns side by side at ${w}`);
  }
  await noHScroll(p, w, `compare ${w} ${scheme}`);
  await p.screenshot({ path: SP + `/mx-compare-${w}-${scheme}.png` });
  await p.context().close();
}

ok(errors.length === 0, 'no page or console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
