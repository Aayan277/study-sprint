// Anki progress, the way Anki's own FSRS code reads it: cram reviews skipped, resets, cut-off histories, the deck's
// own scheduling settings and exam; and image-occlusion notes imported as one card per box.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const DAY = 86400000;
const near = (a, b) => Math.abs(a - b) < 1e-3;
const pad = n => String(n).padStart(2, '0');
const inDays = n => { const d = new Date(Date.now() - 4 * 3600000 + n * DAY); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const deckData = name => page.evaluate(async n => {
  const db = await import('./js/db.js');
  const d = (await db.getDecks()).find(d => d.name === n);
  const cards = await db.getCardsInDeck(d.id), out = {};
  const logs = await db.getAll('reviewLog');
  for (const c of cards) out[c.front] = { card: c, state: await db.get('cardStates', c.id), logs: logs.filter(l => l.cardId === c.id).sort((a, b) => a.timestamp - b.timestamp) };
  return out;
}, name);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// Two decks with their own settings: a slow-forgetting one (70% target) and one with an exam in 3 days.
await page.evaluate(async d => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.saveDeck({ id: 'slow', name: 'Slow', course: '', color: '#8b5cf6', parentId: '', created: now, options: { targetRetention: 0.7 } });
  await db.saveDeck({ id: 'exam', name: 'Exam', course: '', color: '#46A758', parentId: '', created: now + 1, examDate: d });
}, inDays(3));

const load = async (file, deckValue) => {
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  await page.waitForSelector('#preview[data-guids]'); if (await page.isVisible('#updRow')) await page.click('#updateOld');          // (this file imports the same notes twice on purpose: as new cards each time)
  if (deckValue) await page.selectOption('#deckSel', deckValue);
};

for (const file of ['anki-replay-new.apkg', 'anki-replay-legacy.apkg']) {
  const name = file.includes('new') ? 'Replay new' : 'Replay old';
  await load(file);
  const found = await page.textContent('#found');
  ok(found.includes('Found 5 cards'), `${file}: 3 ordinary notes + 1 image-occlusion note with 2 boxes = 5 cards: ${found.slice(0, 60)}`);
  ok(/1 image-occlusion note makes these cards: one card per box/.test(found) && !/later update/.test(found) && !/plain picture card/.test(found), `${file}: the preview says one card per box`);
  ok(!(await page.innerText('#screen')).includes('image-occlusion:') && !(await page.innerText('#screen')).includes('[…]'), `${file}: no broken [...] or mask code in the preview`);
  ok((await page.textContent('#progInfo')).startsWith('10 reviews on 3 cards'), `${file}: progress counts 10 reviews (the cram miss is not one): ` + await page.textContent('#progInfo'));
  await page.selectOption('#deckSel', '__new'); await page.fill('#newName', name); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
  const d = await deckData(name);

  const cram = d['Cram card'];
  ok(cram.state?.state === 2 && cram.state.reps === 3 && cram.state.lapses === 0, `${file}: cram miss ignored (3 reviews, no lapse, still in review)`);
  ok(cram.logs.length === 3 && cram.logs.every(l => l.source === 'anki'), `${file}: and not in the log`);

  const cut = d['Cut-off card'];
  ok(cut.state?.state === 2 && cut.state.reps === 2 && cut.logs.length === 2 && cut.logs[0].state === 2, `${file}: cut-off history starts from the card's interval, as a card in review (log state ${cut.logs[0]?.state})`);
  ok(cut.state.stability > 40, `${file}: its stability is built on the 30-day interval, not from a new card: ${cut.state.stability.toFixed(1)}`);

  const again = d['Restarted card'];
  ok(again.state?.state === 2 && again.state.reps === 2 && again.logs.length === 5, `${file}: learned again after an unlogged reset: only the last group sets the schedule (reps ${again.state?.reps}), all 5 reviews kept in the log`);

  const ios = [d['Heart anatomy: hidden part 1 of 2'], d['Heart anatomy: hidden part 2 of 2']];
  const o = ios.map(x => x?.card.occlusion);
  ok(ios.every(x => x && x.card.back === '' && x.card.backImage && !x.card.frontImage && !x.state && x.card.noteExtra === 'The left side pumps to the body'), `${file}: image-occlusion note is 2 cards (one per box) with the picture and its Back Extra, new`);
  ok(o.every(m => m && m.w === 8 && m.h === 8 && m.header === 'Heart anatomy' && m.masks.length === 2) && o[0].n === 1 && o[1].n === 2 && ios[0].card.noteId === ios[1].card.noteId, `${file}: both cards share a note, the picture size (8×8) and both boxes`);
  const [m1, m2] = o[0].masks;
  ok(near(m1.x, 0.1) && near(m1.y, 0.1) && near(m1.w, 0.2) && near(m1.h, 0.2) && near(m2.x, 0.5) && near(m2.y, 0.5) && near(m2.w, 0.2) && near(m2.h, 0.2) && m1.n === 1 && m2.n === 2, `${file}: the boxes are where Anki put them (.1,.1,.2,.2) and (.5,.5,.2,.2)`);
  ok(Object.keys(d).length === 5 && !Object.keys(d).some(k => k.includes('[')), `${file}: no cloze-style cards from the masks`);
}

// The deck's own settings and exam shape the rebuilt due date (compare the same card's last gap).
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const base = (await deckData('Replay new'))['Cram card'].state; const baseGap = base.due - base.lastReview;
await load('anki-replay-new.apkg', 'slow'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
const slow = (await deckData('Slow'))['Cram card'].state; const slowGap = slow.due - slow.lastReview;
ok(slowGap > baseGap * 1.5, `the deck's own target retention (70%) is used: ${(slowGap / DAY).toFixed(0)} days vs ${(baseGap / DAY).toFixed(0)} days with the default`);
await load('anki-replay-new.apkg', 'exam'); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
const ex = (await deckData('Exam'))['Cram card'].state; const exGap = ex.due - ex.lastReview;
ok(exGap < baseGap * 0.8, `the exam's rising retention is used for the last review: ${(exGap / DAY).toFixed(0)} days vs ${(baseGap / DAY).toFixed(0)} days`);

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
