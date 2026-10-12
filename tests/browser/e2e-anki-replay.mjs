// Anki progress, the way Anki's own FSRS code reads it: cram reviews skipped, resets, cut-off histories, the deck's
// own scheduling settings and exam; and image-occlusion notes imported as plain picture cards.
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
  if (deckValue) await page.selectOption('#deckSel', deckValue);
};

for (const file of ['anki-replay-new.apkg', 'anki-replay-legacy.apkg']) {
  const name = file.includes('new') ? 'Replay new' : 'Replay old';
  await load(file);
  const found = await page.textContent('#found');
  ok(found.includes('Found 4 cards'), `${file}: 3 ordinary notes + 1 image-occlusion note = 4 cards (not one per mask): ${found.slice(0, 60)}`);
  ok(/1 image-occlusion note comes in as a plain picture card/.test(found) && /later update/.test(found), `${file}: the preview says occlusion comes later`);
  ok(!(await page.innerText('#screen')).includes('image-occlusion:') && !(await page.innerText('#screen')).includes('[…]'), `${file}: no broken [...] or mask code in the preview`);
  ok((await page.textContent('#progInfo')).startsWith('10 reviews on 3 cards'), `${file}: progress counts 10 reviews (the cram miss is not one): ` + await page.textContent('#progInfo'));
  await page.fill('#newName', name); await page.click('#saveBtn'); await page.waitForSelector('.crow', { timeout: 30000 });
  const d = await deckData(name);

  const cram = d['Cram card'];
  ok(cram.state?.state === 2 && cram.state.reps === 3 && cram.state.lapses === 0, `${file}: cram miss ignored (3 reviews, no lapse, still in review)`);
  ok(cram.logs.length === 3 && cram.logs.every(l => l.source === 'anki'), `${file}: and not in the log`);

  const cut = d['Cut-off card'];
  ok(cut.state?.state === 2 && cut.state.reps === 2 && cut.logs.length === 2 && cut.logs[0].state === 2, `${file}: cut-off history starts from the card's interval, as a card in review (log state ${cut.logs[0]?.state})`);
  ok(cut.state.stability > 40, `${file}: its stability is built on the 30-day interval, not from a new card: ${cut.state.stability.toFixed(1)}`);

  const again = d['Restarted card'];
  ok(again.state?.state === 2 && again.state.reps === 2 && again.logs.length === 5, `${file}: learned again after an unlogged reset: only the last group sets the schedule (reps ${again.state?.reps}), all 5 reviews kept in the log`);

  const io = d['Heart anatomy'];
  ok(io && io.card.back === 'The left side pumps to the body' && io.card.backImage && !io.card.frontImage && !io.state, `${file}: image-occlusion note is a picture card: heading on the front, the picture on the back, new`);
  ok(Object.keys(d).length === 4 && !Object.keys(d).some(k => k.includes('[')), `${file}: no cloze-style cards from the masks`);
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
