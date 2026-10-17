// Play misses on cards that aren't due still bring the card back (Again) but don't count toward the leech limit.
// Review and Play answers on due cards still do.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const DAY = 86400000;

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// 12 cards. Threshold is 8 (default). Each of these has been forgotten 7 times:
//   control   due, no Play misses on record            -> a miss makes it the 8th lapse: a leech
//   mixed     due, 3 of its 7 lapses were Play misses  -> a miss makes 5 counted lapses: not a leech
//   notdue    not due, a Play miss                     -> brought back, but never a leech
const cards = await page.evaluate(async DAY => {
  const db = await import('./js/db.js');
  const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
  const now = Date.now();
  const st = (c, due) => ({ cardId: c.id, due, stability: 5, difficulty: 5, elapsedDays: 3, scheduledDays: 5, learningSteps: 0, reps: 9, lapses: 7, state: 2, lastReview: now - 5 * DAY });
  const miss = (c, d) => ({ cardId: c.id, timestamp: now - d * DAY, source: 'play', mode: 'front', format: 'classic', correct: false, ms: 3000, rating: 1, state: 2, applied: true, reason: 'again' });
  await db.putMany('cardStates', [st(cs[0], now - 2 * DAY), st(cs[1], now - 2 * DAY), st(cs[2], now + 10 * DAY)]);
  await db.putMany('reviewLog', [10, 9, 8].map(d => miss(cs[1], d)));
  await db.setSetting('playCountsAsReviews', true);       // v4.10: Play is practice only unless on; this file is about the "on" behaviour
  return cs.map((c, i) => ({ id: c.id, front: c.front, back: c.back, role: ['control', 'mixed', 'notdue'][i] || 'other' }));
}, DAY);
const byFront = Object.fromEntries(cards.map(c => [c.front, c]));
const wrong = new Set(cards.slice(0, 3).map(c => c.id));

await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="20"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await page.$eval(s, el => el.click());
await page.click('#startBtn'); await page.waitForSelector('#pCard');
// Wrong on the three set up above (the first time each comes up), right on the rest, until the results screen.
const missed = new Set();
while (!(await page.$('.stamp'))) {
  await page.waitForFunction(() => (document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent) || document.querySelector('.stamp'));
  if (await page.$('.stamp')) break;
  const c = byFront[await page.textContent('#pPrompt')];
  const idx = await page.evaluate(v => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === v), c.back);
  const miss = wrong.has(c.id) && !missed.has(c.id);
  missed.add(c.id);
  await page.keyboard.press(String((miss ? (idx + 1) % 4 : idx) + 1));
  await page.waitForSelector('.fb');
  await page.keyboard.press('Enter');
}
await page.waitForSelector('.stamp');
const got = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const [cs, sts] = await Promise.all([db.getAll('cards'), db.getAll('cardStates')]);
  return Object.fromEntries(cs.map(c => [c.id, { tags: c.tags || [], suspended: !!c.suspended, lapses: sts.find(s => s.cardId === c.id)?.lapses }]));
});
const control = got[cards[0].id], mixed = got[cards[1].id], notdue = got[cards[2].id];
ok(control.lapses === 8 && control.tags.includes('leech') && control.suspended, 'a miss on a due card with 7 lapses makes it a leech (suspended)');
ok(mixed.lapses === 8 && !mixed.tags.includes('leech') && !mixed.suspended, 'with 3 of its lapses being Play misses on cards not due, the 8th lapse is only the 5th counted: not a leech');
ok(notdue.lapses === 8 && !notdue.tags.includes('leech') && !notdue.suspended, 'a Play miss on a card that is not due is a lapse for FSRS but never makes a leech');
const stateOf = await page.evaluate(async id => (await (await import('./js/db.js')).get('cardStates', id)), cards[2].id);
ok(stateOf.state === 3, 'and the not-due card still came back (relearning)');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
