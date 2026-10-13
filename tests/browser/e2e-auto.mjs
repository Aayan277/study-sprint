import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const DAY = 86400000;

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// Cards 0-3 overdue, 4-7 not due for 10 days, 8-11 new.
const cards = await page.evaluate(async DAY => {
  const db = await import('./js/db.js');
  const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
  const now = Date.now();
  const st = (c, due) => ({ cardId: c.id, due, stability: 5, difficulty: 5, elapsedDays: 3, scheduledDays: 5, learningSteps: 0, reps: 3, lapses: 0, state: 2, lastReview: now - 5 * DAY });
  await db.putMany('cardStates', [...cs.slice(0, 4).map(c => st(c, now - 2 * DAY)), ...cs.slice(4, 8).map(c => st(c, now + 10 * DAY))]);
  return cs.map((c, i) => ({ id: c.id, front: c.front, back: c.back, cat: i < 4 ? 'due' : i < 8 ? 'notdue' : 'new', i }));
}, DAY);
const byFront = Object.fromEntries(cards.map(c => [c.front, c]));
const wrongOn = new Set([cards[1].id, cards[5].id]);   // one due card and one not-due card answered wrong

const playRound = async () => {
  await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await page.$eval(s, el => el.click());
  await page.click('#startBtn'); await page.waitForSelector('#pCard');
  const seen = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
    const c = byFront[await page.textContent('#pPrompt')];
    seen.push(c.id);
    const idx = await page.evaluate(v => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === v), c.back);
    const pick = wrongOn.has(c.id) ? (idx + 1) % 4 : idx;
    await page.keyboard.press(String(pick + 1));
    await page.waitForSelector('.fb');
    await page.keyboard.press('Enter');
  }
  await page.waitForSelector('.stamp');
  return seen;
};

const seen1 = await playRound();
const note1 = await page.textContent('.sched-note');
console.log('   results note:', note1.trim());
await page.screenshot({ path: SP + '/a-results.png', fullPage: true });
const logs = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'play'));
ok(logs.length === 10, 'every answer logged (10)');
const states = await page.evaluate(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cardStates')).map(s => [s.cardId, s])));
let checks = 0;
for (const l of logs) {
  const c = cards.find(x => x.id === l.cardId);
  const wrong = wrongOn.has(c.id);
  // A right multiple-choice answer on a due card counts at most as Hard (recognition, not recall).
  const want = c.cat === 'due' ? { applied: true, rating: wrong ? 1 : 2 }
    : c.cat === 'notdue' ? { applied: wrong, rating: wrong ? 1 : 3 }
    : { applied: false, rating: wrong ? 1 : 3 };
  const good = l.applied === want.applied && l.rating === want.rating && l.mode === 'front' && l.format === 'classic' && typeof l.ms === 'number';
  if (!good) console.log('   mismatch', c.cat, c.front, JSON.stringify(l));
  checks += good;
  // schedule actually moved (or not)
  const s = states[c.id];
  if (c.cat === 'due' && !wrong) ok(s.due > Date.now() + DAY && s.reps === 4, `due card answered right was graded (Hard, multiple choice) and pushed out (${c.front})`);
  if (c.cat === 'due' && wrong) ok(s.state === 3 && s.lapses === 1, `due card answered wrong went to relearning (${c.front})`);
  if (c.cat === 'notdue' && !wrong) ok(s.reps === 3 && s.due > Date.now() + 9 * DAY, `not-due card answered right is unchanged (${c.front})`);
  if (c.cat === 'notdue' && wrong) ok(s.state === 3 && s.lapses === 1, `not-due card answered wrong went to relearning (${c.front})`);
  if (c.cat === 'new') ok(!s, `new card was not scheduled (${c.front})`);
}
ok(checks === logs.length, `log rows match the rules (${checks}/${logs.length})`);
ok(/Schedule updated/.test(note1), 'results screen explains the schedule change');

// Second round the same day: nothing already changed by Play changes again.
const appliedFirst = new Set(logs.filter(l => l.applied).map(l => l.cardId));
const before = await page.evaluate(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cardStates')).map(s => [s.cardId, s.due])));
await page.click('#menuBtn'); await playRound();
const logs2 = (await page.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'play'))).slice(10);
const after = await page.evaluate(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cardStates')).map(s => [s.cardId, s.due])));
const twice = logs2.filter(l => appliedFirst.has(l.cardId));
ok(twice.length > 0 && twice.every(l => !l.applied) && twice.every(l => before[l.cardId] === after[l.cardId]), `cards already changed today were not changed again (${twice.length} checked)`);

// A paused Review session doesn't resume after Play changed schedules
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn, .empty');
if (await page.$('#startBtn')) {
  await page.click('#startBtn'); await page.waitForSelector('#flash');
  // make a due card for play to change
  await page.evaluate(async DAY => { const db = await import('./js/db.js'); const s = (await db.getAll('cardStates')); const one = s[0]; await db.saveReview({ ...one, due: Date.now() - DAY, state: 2 }, { cardId: one.cardId, timestamp: Date.now(), source: 'test' }); }, DAY);
  await page.evaluate(() => { location.hash = '#/decks'; }); await page.waitForSelector('.deck'); await page.evaluate(() => { location.hash = '#/review'; });
  await page.waitForSelector('#startBtn, .empty, #flash');
  ok(!(await page.$('#flash')), 'review session starts fresh after schedules changed elsewhere');
}
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
