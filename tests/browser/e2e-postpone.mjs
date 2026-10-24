// Round 3, batch 2: Postpone reviews (item 10). Ten due reviews with different stabilities: postponing moves the most stable first.
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const open = async ({ w = 375, h = 800, scheme = 'dark' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: w < 600, hasTouch: w < 600, colorScheme: scheme });
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));          // Wed 14 Oct 2026, noon
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck, .empty');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  return p;
};
const STAB = [5, 12, 25, 50, 100, 200, 400, 800, 1600, 3200];      // days; the last has the most to lose from waiting the least
const seed = (p, examDate) => p.evaluate(async ([STAB, examDate]) => {
  const db = await import('./js/db.js'); const DAY = 86400000, now = Date.now();
  const cs = STAB.map((s, i) => ({ id: 'pp' + i, deckId: 'pp', front: 'Q' + i, back: 'A' + i, tags: [], created: i }));
  await db.addDeckWithCards({ id: 'pp', name: 'Busy week', color: '#3E63DD', created: now, ...(examDate ? { examDate } : {}) }, cs);
  // all overdue by a day, last seen 30 days ago
  await db.putStates(STAB.map((s, i) => ({ cardId: 'pp' + i, due: now - DAY, stability: s, difficulty: 5, reps: 5, lapses: 0, state: 2, lastReview: now - 30 * DAY, scheduledDays: 30, elapsedDays: 30, learningSteps: 0 })));
}, [STAB, examDate]);
const states = p => p.evaluate(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cardStates')).map(s => [s.cardId, s.due])));
const logCount = p => p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length);
const openPostpone = async p => {
  await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#optBtn');
  await p.click('#optBtn'); await p.click('#customBtn'); await p.waitForSelector('#csPostBtn');
  await p.click('#csPostBtn'); await p.waitForSelector('#ppGo');
};
const noHScroll = async (p, w, what) => ok(await p.evaluate(x => document.documentElement.scrollWidth <= x, w), 'no sideways scroll: ' + what);

let p = await open();
await seed(p);
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#optBtn');
ok((await p.textContent('[data-count=due]')).trim() === '10', 'Today shows 10 due');
await openPostpone(p);
ok((await p.textContent('#sheetTitle')).trim() === 'Postpone reviews', 'the sheet opens');
ok(await p.locator('[data-pdays]').count() === 4 && (await p.$$eval('[data-pdays]', b => b.map(x => x.textContent.trim()))).join('|') === '1 day|2 days|3 days|1 week', 'chips: 1 day, 2 days, 3 days, 1 week');
ok(await p.getAttribute('[data-pdays="2"]', 'aria-pressed') === 'true', '2 days is the start');
const line = (await p.textContent('#ppLine')).replace(/\s+/g, ' ').trim();
const n0 = +(await p.inputValue('#ppCount'));
ok(/^Moves \d+ of 10 due reviews to (Friday)\. Expected recall on them: \d+% now, \d+% then\.$/.test(line), 'the live line: ' + line);
ok(n0 >= 1 && n0 <= 9, 'the start count keeps only reviews that stay at 80% or better: ' + n0);
ok((await p.textContent('#ppNote')).trim() === 'Decks with an exam in the next 5 days are left out.', 'exam note: ' + (await p.textContent('#ppNote')).trim());
await p.screenshot({ path: SP + '/pp-sheet-375-dark.png' });
await noHScroll(p, 375, 'postpone sheet at 375');
// choose 3
await p.fill('#ppCount', '3'); await p.press('#ppCount', 'Tab');
await p.waitForFunction(() => document.querySelector('#ppGo')?.textContent.trim() === 'Postpone 3 reviews');
ok((await p.textContent('#ppLine')).includes('Moves 3 of 10 due reviews to Friday'), 'the line follows the count: ' + (await p.textContent('#ppLine')).trim());
// the stepper
await p.click('#ppPlus'); ok(await p.inputValue('#ppCount') === '4', 'the + button adds one');
await p.click('#ppMinus'); await p.click('#ppMinus'); ok(await p.inputValue('#ppCount') === '2', 'the − button takes one off');
await p.fill('#ppCount', '3'); await p.press('#ppCount', 'Tab');
const before = await states(p);
await p.click('[data-pdays="3"]');
await p.waitForFunction(() => document.querySelector('#ppLine')?.textContent.includes('to Saturday'));
ok(true, '3 days names the day: ' + (await p.textContent('#ppLine')).trim().slice(0, 60));
await p.click('[data-pdays="2"]');
await p.fill('#ppCount', '3'); await p.press('#ppCount', 'Tab');
await p.click('#ppGo');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Postponed 3 reviews to Friday'));
ok((await p.textContent('#toast')).includes('Undo'), 'the toast has Undo: ' + (await p.textContent('#toast')).trim());
const after = await states(p);
const moved = Object.keys(after).filter(id => after[id] !== before[id]).sort();
ok(moved.join() === 'pp7,pp8,pp9', 'the three most stable reviews moved: ' + moved.join());
const due = new Date(after.pp9);
ok(due.getDay() === 5 && due.getHours() === 6 && due.getMinutes() === 0, 'they are due at 6am on Friday, after the day starts: ' + due.toString().slice(0, 24));
ok(await logCount(p) === 0, 'no review-log rows were written');
await p.waitForFunction(() => document.querySelector('[data-count=due]')?.textContent.trim() === '7');
ok(true, 'Today now counts 7 due');
await p.screenshot({ path: SP + '/pp-after-375-dark.png' });
// Undo puts them back
await p.click('#toast .toast-link');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Put 3 reviews back'));
const undone = await states(p);
ok(JSON.stringify(undone) === JSON.stringify(before), 'Undo puts the old schedules back');
await p.waitForFunction(() => document.querySelector('[data-count=due]')?.textContent.trim() === '10');
ok(true, 'and Today counts 10 due again');

// Undo leaves a card that has been reviewed since alone
await openPostpone(p);
await p.fill('#ppCount', '2'); await p.press('#ppCount', 'Tab'); await p.click('#ppGo');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Postponed 2 reviews'));
await p.evaluate(async () => { const db = await import('./js/db.js'); const s = await db.get('cardStates', 'pp9'); await db.putStates([{ ...s, due: s.due + 86400000 * 40, lastReview: Date.now() }]); });
await p.click('#toast .toast-link');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Put 1 review back'));
ok(true, 'Undo skips a card that changed since: ' + (await p.textContent('#toast')).trim());

// The toast stays until you leave Today
await openPostpone(p);
await p.fill('#ppCount', '1'); await p.press('#ppCount', 'Tab'); await p.click('#ppGo');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Postponed 1 review to Friday'));
await p.waitForTimeout(3500);
ok(await p.isVisible('#toast'), 'the Undo toast is still there after the usual few seconds');
await p.evaluate(() => { location.hash = '#/play'; });
await p.waitForFunction(() => document.getElementById('toast').hidden);
ok(true, 'and gone when you leave Today');

// A deck with an exam in the next days is left alone
const q = await open();
await seed(q, '2026-10-17');           // 3 days away
await openPostpone(q);
ok((await q.textContent('#ppLine')).includes("Your due reviews are in decks with an exam in the next 5 days, so they're left alone.") && await q.isDisabled('#ppGo'), 'exam in 3 days: due reviews are all left alone, and the line says why, button off: ' + (await q.textContent('#ppLine')).trim());
await q.click('[data-pdays="1"]');
ok((await q.textContent('#ppLine')).includes('exam in the next 4 days'), 'still nothing for 1 day (3 ≤ 1 + 3), and it names 4 days');
await q.context().close();
const e = await open();
await seed(e, '2026-11-20');           // a month away: not near
await openPostpone(e);
ok(!(await e.textContent('#ppLine')).includes('Nothing to postpone'), 'an exam far away does not block it');
await e.context().close();

// No due reviews at all
const z = await open();
await z.evaluate(async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'zz', name: 'Calm', color: '#46A758', created: Date.now() }, [{ id: 'z0', deckId: 'zz', front: 'q', back: 'a', tags: [], created: 0 }]); });
await openPostpone(z);
ok((await z.textContent('#ppLine')).includes('Nothing to postpone: no reviews are due.'), 'with no reviews due: ' + (await z.textContent('#ppLine')).trim());
await z.context().close();

// 1440 light
const w = await open({ w: 1440, h: 900, scheme: 'light' });
await seed(w);
await openPostpone(w);
await w.screenshot({ path: SP + '/pp-sheet-1440-light.png' });
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' // ') : ''));
await browser.close();
