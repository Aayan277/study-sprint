// Round 3, batch 2: Play "I was right" and "Accept this answer from now on" (improvement C), and the same accept link in typed Review.
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
// CPU_THROTTLE=4 slows every page 4x (Chrome DevTools Protocol), to shake out timing races like a busy computer would.
const THROTTLE = +process.env.CPU_THROTTLE || 1;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const open = async ({ w = 375, h = 800, scheme = 'dark' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: w < 600, hasTouch: w < 600, colorScheme: scheme });
  const p = await ctx.newPage();
  if (THROTTLE > 1) await (await ctx.newCDPSession(p)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  p.on('pageerror', e => errors.push('pageerror ' + e.message + (e.stack ? ' @ ' + e.stack.split('\n').slice(1, 3).join(' | ').trim() : '')));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck, .empty');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  return p;
};
const seed = (p, id, cards, { due = false, counts = false } = {}) => p.evaluate(async ([id, cards, due, counts]) => {
  const DAY = 86400000;
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id, name: 'Override ' + id, color: '#46A758', created: Date.now() },
    cards.map(([front, back], i) => ({ id: id + i, deckId: id, front, back, tags: [], created: i })));
  if (due) await db.putStates(cards.map((_, i) => ({ cardId: id + i, due: Date.now() - DAY, stability: 10, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: Date.now() - 12 * DAY, scheduledDays: 10, elapsedDays: 12, learningSteps: 0 })));
  await db.setSetting('playCountsAsReviews', counts);
}, [id, cards, due, counts]);
const setup = async (p, deck, { fmt = 'classic', qtype = 'typing' } = {}) => {
  await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck');
  await p.evaluate(() => { location.hash = '#/play'; }); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', deck);
  for (const s of [`input[name=fmt][value=${fmt}]`, `input[name=qtype][value=${qtype}]`, ...(fmt === 'classic' ? ['input[name=len][value="10"]'] : []), 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click());
  await p.click('#startBtn'); await p.waitForSelector('#pCard');
};
const typeAnswer = async (p, text) => {
  await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && !document.querySelector('#pInput')?.disabled && document.querySelector('#pPrompt')?.textContent);
  await p.fill('#pInput', text); await p.press('#pInput', 'Enter'); await p.waitForSelector('#feedback .fb');
};
const hud = async p => ({ score: (await p.textContent('#score')).trim(), streak: (await p.textContent('#streak')).trim() });
// Wait for something in the database. (page.waitForFunction does not wait for an async function: it takes the Promise it
// returns as true at once, so these checks used to pass straight away and then raced the app's background saves.)
// This asks the page again every 50 ms until the answer is true.
const until = async (p, fn, arg, what = 'the database to change') => {
  const end = Date.now() + 15000;
  for (;;) {
    if (await p.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 50));
  }
};
const cardOf = (p, id) => p.evaluate(async id => (await import('./js/db.js')).get('cards', id), id);

// ----- practice mode (the default): only the round and the accept list change -----
let p = await open();
await seed(p, 'po', [['Heart attack', 'Myocardial infarction']]);
await setup(p, 'po');
await typeAnswer(p, 'MI');
ok(await p.locator('#feedback .fb.no').count() === 1, 'a wrong typed answer');
ok(await p.isVisible('#rightBtn') && (await p.textContent('#rightBtn')).trim() === 'I was right', 'I was right is next to Next');
const h0 = await hud(p);
await p.screenshot({ path: SP + '/po-wrong-375-dark.png' });
await p.click('#rightBtn');
await p.waitForFunction(() => document.querySelector('#feedback .fb.ok')?.textContent.includes('Counted as right'));
ok(true, 'the heading changes to Counted as right');
const h1 = await hud(p);
ok(h0.score === h1.score && h0.streak === h1.streak && h1.streak === '0', `score and streak do not change: ${JSON.stringify(h0)} → ${JSON.stringify(h1)}`);
ok(await p.locator('#rightBtn').count() === 0, 'I was right is gone after the tap');
const acc = (await p.textContent('#acceptBtn')).trim();
ok(acc === 'Accept “MI” from now on', 'Accept button: ' + acc);
await p.screenshot({ path: SP + '/po-counted-375-dark.png' });
await p.click('#acceptBtn');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Accepted for this card'));
ok(JSON.stringify((await cardOf(p, 'po0')).acceptAnswers) === '["MI"]', 'the card keeps the accepted answer: ' + JSON.stringify((await cardOf(p, 'po0')).acceptAnswers));
ok(await p.locator('#acceptBtn').count() === 0, 'Accept is gone after it');
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length) === 0 && await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).length) === 0, 'practice mode: nothing was saved to the schedule or the log');
await p.keyboard.press('Enter');
// the next questions: the accepted text is right now, and the streak starts from 0 (the override did not count it)
await typeAnswer(p, 'mi');
ok(await p.locator('#feedback .fb.ok').count() === 1 && (await p.textContent('#feedback .fb-mark')).includes('Correct'), 'the accepted answer is marked right in the same round');
ok((await hud(p)).streak === '1', 'streak is 1 after one real right answer');
for (let i = 0; i < 8; i++) { await p.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' || document.querySelector('.res-head')).catch(() => {}); if (await p.locator('.res-head').count()) break; await typeAnswer(p, 'MI'); }
await p.waitForSelector('.res-head', { timeout: 15000 });
const stats = await p.$$eval('.stats4 .v', v => v.map(x => x.textContent.trim()));
ok(stats[0] === '100%' && stats[3] === '10/10', 'results count the fixed answer as right: ' + stats.join(' | '));
ok((await p.textContent('.missed')).includes('Clean round'), 'nothing is missed');
ok((await p.textContent('.sched-note')).includes('Practice only'), 'results still say Practice only');
await p.screenshot({ path: SP + '/po-results-375-dark.png', fullPage: true });
// "Play again": a new round accepts it from the start
await p.click('#againBtn'); await p.waitForSelector('#pInput');
await typeAnswer(p, 'MI');
ok(await p.locator('#feedback .fb.ok').count() === 1, 'a new round accepts the answer from the first question');
await p.keyboard.press('Escape');

// ----- the card was changed meanwhile: nothing is fixed -----
await seed(p, 'pq', [['Capital of France', 'Paris']]);
await setup(p, 'pq');
await typeAnswer(p, 'Lyon');
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.saveCards([{ ...(await db.get('cards', 'pq0')), back: 'Paris, France' }]); });
await p.click('#rightBtn');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('That card changed; nothing to fix.'));
ok(await p.locator('#feedback .fb.no').count() === 1 && await p.isEnabled('#rightBtn'), 'an edited card: toast, and nothing changes');
await p.keyboard.press('Escape');

// ----- Count Play answers as reviews: the schedule and stats are fixed too -----
await seed(p, 'pr', [['Process of light to sugar', 'Photosynthesis']], { due: true, counts: true });
await setup(p, 'pr');
await typeAnswer(p, 'zzzzzz');
await until(p, async () => { const db = await import('./js/db.js'); return (await db.getAll('reviewLog')).length === 1 && (await db.get('cardStates', 'pr0'))?.lapses === 1; }, null, 'the wrong answer to be saved');
let st = await p.evaluate(async () => (await (await import('./js/db.js')).get('cardStates', 'pr0')));
ok(st.lapses === 1, 'the wrong answer was saved as Again (a lapse): ' + JSON.stringify(st));
await p.click('#rightBtn');
await p.waitForFunction(() => document.querySelector('#feedback .fb.ok')?.textContent.includes('Counted as right'));
await until(p, async () => {
  const db = await import('./js/db.js');
  return (await db.getAll('reviewLog')).some(l => l.overridden) && (await db.get('cardStates', 'pr0'))?.lapses === 0;
}, null, 'the correction to be saved');
st = await p.evaluate(async () => (await (await import('./js/db.js')).get('cardStates', 'pr0')));
const rows = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.cardId === 'pr0'));
ok(st.lapses === 0 && st.state === 2 && st.stability > 10 && st.reps === 4, `the schedule is what a right answer gives, not Again: ${JSON.stringify({ lapses: st.lapses, state: st.state, stability: Math.round(st.stability), reps: st.reps })}`);
ok(rows.length === 1 && rows[0].correct === true && rows[0].overridden === true && rows[0].applied === true && rows[0].rating >= 2, 'one log row, right, marked overridden: ' + JSON.stringify(rows.map(r => [r.correct, r.overridden, r.rating, r.reason])));
await p.keyboard.press('Escape');

// ----- the wrong answer made the card a leech: "I was right" takes that back too -----
for (const [id, action] of [['pl', 'tag'], ['pm', 'suspend']]) {
  await seed(p, id, [['Leech question ' + id, 'Hemoglobin ' + id]], { due: true, counts: true });
  await p.evaluate(async a => { const db = await import('./js/db.js'); await db.setSetting('leechThreshold', 1); await db.setSetting('leechAction', a); const c = await db.get('cards', a === 'tag' ? 'pl0' : 'pm0'); await db.saveCards([{ ...c, tags: ['keep'] }]); }, action);
  await setup(p, id);
  await typeAnswer(p, 'qqqqqq');
  await until(p, async cid => ((await (await import('./js/db.js')).get('cards', cid)).tags || []).includes('leech'), id + '0', 'the leech tag');
  const made = await cardOf(p, id + '0');
  ok(made.tags.includes('leech') && !!made.suspended === (action === 'suspend'), `${action}: the wrong answer made it a leech: ${JSON.stringify([made.tags, made.suspended])}`);
  await p.click('#rightBtn');
  await p.waitForFunction(() => document.querySelector('#feedback .fb.ok')?.textContent.includes('Counted as right'));
  const back = await cardOf(p, id + '0');
  ok(JSON.stringify(back.tags) === '["keep"]' && !back.suspended, `${action}: I was right took the leech back: ${JSON.stringify([back.tags, back.suspended])}`);
  const st2 = await p.evaluate(async cid => (await import('./js/db.js')).get('cardStates', cid), id + '0');
  ok(st2.lapses === 0, `${action}: and the schedule has no lapse: ${st2.lapses}`);
  await p.keyboard.press('Escape');
}
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('leechThreshold', 8); await db.setSetting('leechAction', 'suspend'); await db.setSetting('playCountsAsReviews', false); });

// ----- Survival: the results' Missed rows have the buttons -----
await seed(p, 'ps', [['Q one', 'Alpha one'], ['Q two', 'Beta two'], ['Q three', 'Gamma three']]);
await setup(p, 'ps', { fmt: 'survival' });
for (let i = 0; i < 3; i++) { await typeAnswer(p, 'nope'); await p.keyboard.press('Enter'); }
await p.waitForSelector('.res-head', { timeout: 15000 });
let r4 = await p.$$eval('.stats4 .v', v => v.map(x => x.textContent.trim()));
ok(r4[0] === '0%' && r4[3] === '0/3', 'Survival ended with three misses: ' + r4.join(' | '));
ok(await p.locator('.miss [data-right]').count() === 3, 'each typed miss has I was right on the results');
const pts = (await p.textContent('.res-n')).trim();
await p.screenshot({ path: SP + '/po-miss-375-dark.png', fullPage: true });
await p.click('.miss [data-right] >> nth=0');
await p.waitForFunction(() => document.querySelector('.stats4 .v')?.textContent.trim() !== '0%');
r4 = await p.$$eval('.stats4 .v', v => v.map(x => x.textContent.trim()));
ok(r4[0] === '33%' && r4[3] === '1/3', 'accuracy follows the correction: ' + r4.join(' | '));
ok((await p.textContent('.res-n')).trim() === pts, 'the score does not change: ' + pts);
ok((await p.textContent('.missed')).includes('Counted as right') && await p.locator('.miss [data-right]').count() === 2, 'the fixed row stays in the list as Counted as right');
ok((await p.textContent('.res-actions')).includes('Drill missed'), 'Drill missed is still there');
ok(await p.locator('.miss [data-accept]').count() === 1, 'the fixed row offers Accept');
await p.click('.miss [data-accept]');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Accepted for this card'));
ok(await p.locator('.miss [data-accept]').count() === 0, 'Accept is gone after it');
const accepted = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.deckId === 'ps' && c.acceptAnswers).map(c => c.acceptAnswers));
ok(accepted.length === 1 && accepted[0][0] === 'nope', 'saved on that card: ' + JSON.stringify(accepted));

// ----- Lightning moves on by itself: no button in the feedback -----
await setup(p, 'ps', { fmt: 'lightning' });
await typeAnswer(p, 'wrong');
ok(await p.locator('#rightBtn').count() === 0, 'Lightning has no I was right in the feedback');
await p.keyboard.press('Escape');

// ----- Edit card: Other accepted answers -----
await p.evaluate(() => { location.hash = '#/browse'; }); await p.waitForSelector('#brList .crow');
const accCard = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).find(c => c.deckId === 'ps' && c.acceptAnswers));
await p.fill('#brQuery', accCard.front);
await p.waitForFunction(f => document.querySelectorAll('#brList .crow').length === 1 && document.querySelector('#brList .crow').textContent.includes(f), accCard.front);
await p.click('#brList .crow-btn'); await p.waitForSelector('#ceAccept');
ok((await p.inputValue('#ceAccept')) === 'nope', 'the card editor shows Other accepted answers: ' + await p.inputValue('#ceAccept'));
await p.fill('#ceAccept', 'nope, nah');
await p.$eval('button[type=submit][form=ceForm]', b => b.click());
await until(p, async id => (await (await import('./js/db.js')).get('cards', id)).acceptAnswers?.length === 2, accCard.id, 'the list to save');
ok(true, 'editing the list saves it');
await p.waitForSelector('#ceAccept');
await p.fill('#ceAccept', '');
await p.$eval('button[type=submit][form=ceForm]', b => b.click());
await until(p, async id => !('acceptAnswers' in (await (await import('./js/db.js')).get('cards', id))), accCard.id, 'the field to be removed');
ok(true, 'emptying it removes the field');

// ----- typed Review: Accept my answer from now on -----
const rv = await open();
await seed(rv, 'rv', [['Heart attack', 'Myocardial infarction']]);
await rv.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('reviewTyping', true); });
await rv.evaluate(() => { location.hash = '#/today'; }); await rv.waitForSelector('[data-start="rv"]');
await rv.click('[data-start="rv"]'); await rv.waitForSelector('#typeIn');
await rv.fill('#typeIn', 'MI'); await rv.press('#typeIn', 'Enter');
await rv.waitForSelector('.rv-typed .typed.no');
ok((await rv.textContent('[data-accept-typed]')).trim() === 'Accept my answer from now on', 'typed Review offers the link under a wrong answer');
await rv.screenshot({ path: SP + '/rv-accept-375-dark.png' });
await rv.click('[data-accept-typed]');
await rv.waitForSelector('.rv-typed .typed.ok');
ok(JSON.stringify((await cardOf(rv, 'rv0')).acceptAnswers) === '["MI"]' && await rv.locator('[data-accept-typed]').count() === 0, 'saved on the card; the answer now reads as correct');
ok(await rv.locator('.rate.suggested').count() === 1 && (await rv.textContent('.rate.suggested')).includes('Good'), 'Good is suggested; the rating stays yours');
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' // ') : ''));

// ----- 1440 light -----
const w = await open({ w: 1440, h: 900, scheme: 'light' });
await seed(w, 'pw', [['Heart attack', 'Myocardial infarction']]);
await setup(w, 'pw');
await typeAnswer(w, 'MI');
await w.click('#rightBtn'); await w.waitForSelector('#acceptBtn');
await w.screenshot({ path: SP + '/po-counted-1440-light.png' });
await browser.close();
