// FSRS-7 (beta): the Scheduler switch in Settings → Study → Advanced scheduling, reviewing under FSRS-7, switching back and on again,
// and the new card-state field going through sync (with the fake Supabase) between two devices. Plan: docs/design/fsrs7-plan.md.
// Run with: node tests/browser/run.mjs fsrs7
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const DAY = 86400000;

async function open(name, fake) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  if (fake) await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name} pageerror ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/status of (400|422)/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  return p;
}
const run = (p, fn, arg) => p.evaluate(fn, arg);
const states = p => run(p, async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cardStates')).map(s => [s.cardId, s])));
const setting = (p, key) => run(p, async k => (await (await import('./js/db.js')).getSettings())[k], key);
const sideways = (p, tag) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth).then(v => ok(v, `${tag}: no sideways scroll`));

// ================= 1. one device: the switch, reviewing, switching back and on again =================
const page = await open('A');
// A deck of 8 cards: three with FSRS-6 history (three real reviews each, due now), five new. The sample deck is removed so Today is only these.
await run(page, async () => {
  const db = await import('./js/db.js');
  const { rate } = await import('./js/srs.js');
  const { schedulerOptions } = await import('./js/sched-settings.js');
  await db.deleteDeck('sample');
  await db.setSetting('fuzz', false);
  const opts = schedulerOptions({ fuzz: false });
  const DAY = 86400000, now = Date.now();
  await db.addDeckWithCards({ id: 'f7', name: 'F7', color: '#5B48E8', created: now },
    Array.from({ length: 8 }, (_, i) => ({ id: `f7-${i}`, deckId: 'f7', front: `Question ${i}`, back: `Answer ${i}`, tags: [], created: now + i })));
  for (let c = 0; c < 3; c++) {
    let st = null;
    for (const [i, ago] of [30, 22, 9].entries()) {
      const when = now - ago * DAY - c * 60000;
      const log = { cardId: `f7-${c}`, timestamp: when, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: st ? st.state : 0 };
      st = rate(`f7-${c}`, st, 3, opts, when);
      await db.saveReview(i === 2 ? { ...st, due: now - 3600000 } : st, log);
    }
  }
});
const seeded = await states(page);
ok(Object.keys(seeded).length === 3 && Object.values(seeded).every(s => !('fsrs7' in s) && s.state === 2), 'seeded: three cards with FSRS-6 history, none with an FSRS-7 memory');

// the switch in Settings
await page.goto(URL + '#/settings'); await page.waitForSelector('#advanced');
await page.evaluate(() => { document.getElementById('advanced').open = true; });
await page.waitForSelector('#fsrsChips');
const chipText = await page.$$eval('#fsrsChips .chip', cs => cs.map(c => c.textContent.trim()));
ok(JSON.stringify(chipText) === JSON.stringify(['FSRS-6 (standard)', 'FSRS-7 (beta)']), 'the Scheduler row offers FSRS-6 (standard) and FSRS-7 (beta): ' + chipText.join(' | '));
ok((await page.textContent('#fsrsLbl')) === 'Scheduler', 'the row is labelled Scheduler');
ok((await page.textContent('#fsrsHint')) === 'FSRS-7 models short-term memory better (same-day repeats, cramming). Beta: off by default. Your cards keep their history; switching back is safe.', 'the hint says what it does, that it is beta and that switching back is safe');
ok(await page.$eval('input[name=fsrsVersion][value="6"]', r => r.checked) && (await setting(page, 'fsrsVersion')) === 6, 'FSRS-6 is selected by default');
ok(!(await page.textContent('#optStatus')).includes('FSRS-7'), 'with FSRS-6 the Optimize row is as before');
await sideways(page, 'Settings');
await page.click('#fsrsChips label:has(input[value="7"])');
await page.waitForFunction(() => document.getElementById('optStatus')?.textContent.includes('FSRS-7'));      // (Settings is drawn again after the choice)
ok((await setting(page, 'fsrsVersion')) === 7, 'choosing FSRS-7 saves the setting');
ok((await page.textContent('#optStatus')) === 'Personal tuning for FSRS-7 is coming; using standard FSRS-7 settings.', 'with FSRS-7 on the Optimize row says tuning is coming');
ok(await page.$eval('#optOpen', b => b.disabled), 'and the Optimize button is off');
ok((await page.textContent('#optWhy')) === 'Your FSRS-6 tuning is kept for when you switch back.' && (await page.getAttribute('#optOpen', 'aria-describedby')).includes('optWhy'), 'with a note that FSRS-6 tuning is kept (no empty description)');
ok(await page.evaluate(() => document.activeElement?.matches?.('input[name=fsrsVersion]')), 'focus stays on the Scheduler choice');
await page.screenshot({ path: SP + '/fsrs7-settings.png', fullPage: true });

// review all of Today's cards under FSRS-7
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#flash');
const seen = [];
for (let i = 0; i < 8; i++) {
  await page.waitForSelector('#flash');
  const front = await page.textContent('.flash-front');
  await page.keyboard.press('Space'); await page.waitForSelector('.rate');
  const labels = await page.$$eval('.rate', bs => bs.map(b => b.querySelector('b').textContent + ' ' + b.querySelector('span').textContent));
  seen.push({ front: front.trim(), labels });
  const rating = ['3', '3', '4', '2', '3', '3', '3', '3'][i];
  await page.keyboard.press(rating);
  await page.waitForFunction(f => !document.querySelector('.flash-front') || document.querySelector('.flash-front').textContent !== f, front);
}
console.log('   buttons seen:', seen.map(s => s.labels.join(' ')).slice(0, 2).join(' || '));
const newCardLabels = seen.find(s => /Question [3-7]/.test(s.front)).labels;
ok(newCardLabels[0] === 'Again 1m' && !/^Good (10m|1m)$/.test(newCardLabels[2]) && /^Good \d+d$/.test(newCardLabels[2]), 'a new card under FSRS-7: Again 1m, Good is days, not the 10 minute step: ' + newCardLabels.join(' | '));
await page.waitForSelector('.rv-done, .finish, #screen', { timeout: 5000 }).catch(() => {});
let after = await states(page);
ok(Object.keys(after).length === 8, 'all eight cards have a schedule now');
const old = [0, 1, 2].map(i => after[`f7-${i}`]);
ok(old.every(s => s.fsrs7 && s.fsrs7.at === s.lastReview && s.fsrs7.stability > 0 && s.fsrs7.stabilityFast > 0 && s.fsrs7.difficulty >= 1), 'the cards with FSRS-6 history got an FSRS-7 memory on their first FSRS-7 review');
ok(old.every((s, i) => s.stability > 0 && s.difficulty >= 1 && s.reps === 4 && s.lastReview > seeded[`f7-${i}`].lastReview), 'and kept their FSRS-6 fields and counters (reps 4)');
const fresh = [3, 4, 5, 6, 7].map(i => after[`f7-${i}`]);
ok(fresh.every(s => s.fsrs7 && s.fsrs7.at === s.lastReview && s.reps === 1), 'new cards have both memories after one review');
const logs = await run(page, async () => (await (await import('./js/db.js')).getAll('reviewLog')));
ok(logs.filter(l => l.source === 'review').length === 9 + 8, 'every answer is logged (9 old + 8 new)');
await page.screenshot({ path: SP + '/fsrs7-after.png', fullPage: true });

// back to FSRS-6: make two cards due again and review them
await page.goto(URL + '#/settings'); await page.waitForSelector('#advanced');
await page.evaluate(() => { document.getElementById('advanced').open = true; });
await page.click('#fsrsChips label:has(input[value="6"])');
await page.waitForFunction(() => !document.getElementById('optStatus')?.textContent.includes('FSRS-7'));
ok((await setting(page, 'fsrsVersion')) === 6, 'switching back saves FSRS-6');
ok(!(await page.textContent('#optStatus')).includes('FSRS-7'), 'the Optimize row is back to normal');
const before6 = await states(page);
await run(page, async () => {
  const db = await import('./js/db.js');
  for (const id of ['f7-0', 'f7-3']) await db.putStates([{ ...(await db.get('cardStates', id)), due: Date.now() - 3600000 }]);
});
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#flash');
for (let i = 0; i < 2; i++) {
  const front = await page.textContent('.flash-front');
  await page.keyboard.press('Space'); await page.waitForSelector('.rate');
  await page.keyboard.press('3');
  await page.waitForFunction(f => !document.querySelector('.flash-front') || document.querySelector('.flash-front').textContent !== f, front);
}
after = await states(page);
ok(!('fsrs7' in after['f7-0']) && !('fsrs7' in after['f7-3']), 'reviews under FSRS-6 write states without the (now stale) FSRS-7 memory');
ok(after['f7-0'].stability >= before6['f7-0'].stability && after['f7-0'].difficulty > 0 && after['f7-0'].reps === 5 && after['f7-0'].state === 2, 'FSRS-6 carried on from the FSRS-6 fields it had kept (reps 5, still a review card)');
ok(after['f7-1'].fsrs7 && after['f7-1'].fsrs7.at === after['f7-1'].lastReview, 'a card not reviewed meanwhile keeps its FSRS-7 memory untouched');

// on again: the stale card is rebuilt from its history
await page.goto(URL + '#/settings'); await page.waitForSelector('#advanced');
await page.evaluate(() => { document.getElementById('advanced').open = true; });
await page.click('#fsrsChips label:has(input[value="7"])');
await page.waitForFunction(() => document.getElementById('optStatus')?.textContent.includes('FSRS-7'));
// Only f7-0 may be in this session. FSRS-7 sets a Good on a new card (f7-4, reviewed above) to come back after about 14 hours, and a
// learning card due before the 4am rollover is "due today": the session then shows it early instead of ending, which is right
// but depends on the time of day the test runs. So park every learning card a few days out, the same way f7-0 is made due.
await run(page, async () => {
  const db = await import('./js/db.js');
  const learning = (await db.getAll('cardStates')).filter(s => (s.state === 1 || s.state === 3) && s.cardId !== 'f7-0');
  await db.putStates([...learning.map(s => ({ ...s, due: Date.now() + 3 * 86400000 })), { ...(await db.get('cardStates', 'f7-0')), due: Date.now() - 3600000 }]);
});
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#flash');
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await page.waitForFunction(() => !document.querySelector('.flash-front'));
after = await states(page);
ok(after['f7-0'].fsrs7 && after['f7-0'].fsrs7.at === after['f7-0'].lastReview && after['f7-0'].reps === 6, 'switched on again: the card\'s FSRS-7 memory is rebuilt and current (reps 6)');

// Stats and Browse still draw with FSRS-7 states
await page.goto(URL + '#/stats'); await page.waitForSelector('.screen-head');
await page.goto(URL + '#/deck/f7'); await page.waitForSelector('.crow');
ok(true, 'Stats and the deck page open with FSRS-7 states');
await sideways(page, 'deck page');

// ================= 2. two devices: the setting and the new field through sync =================
const fake = fakeSupabase();
const A = await open('sync-A', fake), B = await open('sync-B', fake);
const syncNow = p => run(p, async () => { await (await import('./js/sync.js')).syncNow(); return (await import('./js/sync.js')).lastStatus(); });
const signIn = async (p, create) => {
  await p.goto(URL + '#/settings'); await p.waitForSelector('#syncEmail');
  await p.fill('#syncEmail', 'f7@example.com'); await p.fill('#syncPw', 'secret123');
  await p.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
  await p.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
};
await run(A, async () => {
  const db = await import('./js/db.js');
  const { rate } = await import('./js/srs.js');
  const { schedulerOptions } = await import('./js/sched-settings.js');
  await db.deleteDeck('sample');
  await db.addDeckWithCards({ id: 'sy', name: 'Sync', color: '#46A758', created: Date.now() }, [0, 1].map(i => ({ id: `sy-${i}`, deckId: 'sy', front: `Q${i}`, back: `A${i}`, tags: [], created: Date.now() + i })));
  await db.setSetting('fsrsVersion', 7);
  const opts = schedulerOptions({ fsrsVersion: 7, fuzz: false });
  const now = Date.now();
  const st = rate('sy-0', null, 3, opts, now);
  await db.saveReview(st, { cardId: 'sy-0', timestamp: now, source: 'review', mode: 'flip', correct: true, ms: 2000, rating: 3, state: 0 });
});
await signIn(A, true);
const server = fake.userRows('f7@example.com');
const stateRow = server.find(r => r.store === 'cardStates' && r.id === 'sy-0');
ok(stateRow && stateRow.data.fsrs7 && stateRow.data.fsrs7.stabilityFast > 0 && stateRow.data.fsrs7.at === stateRow.data.lastReview && stateRow.data.stability > 0, 'the server holds the card with its FSRS-7 memory and its FSRS-6 fields');
ok(server.some(r => r.store === 'settings' && r.id === 'fsrsVersion' && r.data.value === 7), 'the Scheduler choice is a synced setting');
await signIn(B, false);
const bStates = await states(B);
const aStates = await states(A);
ok(JSON.stringify(bStates['sy-0'].fsrs7) === JSON.stringify(aStates['sy-0'].fsrs7) && bStates['sy-0'].fsrs7.at === bStates['sy-0'].lastReview, 'device B received the FSRS-7 memory unchanged');
ok((await setting(B, 'fsrsVersion')) === 7, 'and the setting: B is on FSRS-7 too');
// B (an "older app": it reviews with FSRS-6 and writes a state with no FSRS-7 memory) -> A
await run(B, async () => {
  const db = await import('./js/db.js');
  const { rate } = await import('./js/srs.js');
  const { schedulerOptions } = await import('./js/sched-settings.js');
  await db.setSetting('fsrsVersion', 6);
  const prev = await db.get('cardStates', 'sy-0');
  const when = Date.now() + 2 * 3600000;
  await db.saveReview(rate('sy-0', prev, 3, schedulerOptions({ fuzz: false }), when), { cardId: 'sy-0', timestamp: when, source: 'review', mode: 'flip', correct: true, ms: 2000, rating: 3, state: prev.state });
});
await syncNow(B); await syncNow(A);
ok((await setting(A, 'fsrsVersion')) === 6, 'turning FSRS-7 off on one device turns it off on the other');
const aNow = await states(A);
ok(!('fsrs7' in aNow['sy-0']) && aNow['sy-0'].reps === 2, 'a review by FSRS-6 replaced the whole state on A: no half-updated FSRS-7 fields');
// ...and A turns it on again and reviews that card: rebuilt from the synced log
await run(A, async () => {
  const db = await import('./js/db.js');
  const { rate, prepare7 } = await import('./js/srs.js');
  const { schedulerOptions } = await import('./js/sched-settings.js');
  await db.setSetting('fsrsVersion', 7);
  const prev = await db.get('cardStates', 'sy-0');
  await prepare7([prev], db.getCardLogs);
  const when = Date.now() + 4 * 3600000;
  await db.saveReview(rate('sy-0', prev, 3, schedulerOptions({ fsrsVersion: 7, fuzz: false }), when), { cardId: 'sy-0', timestamp: when, source: 'review', mode: 'flip', correct: true, ms: 2000, rating: 3, state: prev.state });
});
const final = (await states(A))['sy-0'];
ok(final.fsrs7 && final.fsrs7.at === final.lastReview && final.reps === 3, 'on again: A rebuilt the memory from the log and carried on (reps 3)');
await syncNow(A); await syncNow(B);
ok(JSON.stringify((await states(B))['sy-0'].fsrs7) === JSON.stringify(final.fsrs7) && (await setting(B, 'fsrsVersion')) === 7, 'and B has the same state and setting again');

ok(errors.length === 0, 'no page errors or console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''));
await browser.close();
