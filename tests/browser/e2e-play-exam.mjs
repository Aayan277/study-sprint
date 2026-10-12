// Play: the quick-start setup (deck, format and Start above the fold, "Customise" fold, default deck) and
// new cards being scheduled by Play in decks with an exam.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const iso = d => { const x = new Date(Date.now() + d * 86400000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
// A second deck (no exam) that was used last, and an exam in 9 days on the sample deck
await page.evaluate(async exam => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'zzz', name: 'Other course', color: '#E5484D', created: Date.now() + 5 },
    ['a', 'b', 'c', 'd', 'e'].map((f, i) => ({ id: 'z' + i, deckId: 'zzz', front: 'Z ' + f, back: 'Zed ' + f + ' answer', tags: [], created: i })));
  await db.setSetting('playPrefs', { deckId: 'zzz', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20, qtypeByDeck: {} });
  await db.setSetting('newPerDay', 3);
  await db.saveDeck({ ...(await db.getDeck('sample')), examDate: exam });
}, iso(9));

// ----- quick-start setup -----
await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
ok(await page.inputValue('#pDeck') === 'sample', 'Play opens on the deck with the nearest exam, not the last one used');
const startBox = await page.locator('#startBtn').boundingBox();
ok(startBox.y + startBox.height <= 812 - 70, 'Start is above the fold at 375x812 (bottom at ' + Math.round(startBox.y + startBox.height) + ')');
const deckBox = await page.locator('#pDeck').boundingBox();
ok(deckBox.y > 0 && deckBox.y < 400, 'the deck picker is above the fold');
ok(await page.locator('.mode').count() === 3 && (await page.locator('.mode').evaluateAll(els => els.every(e => e.getBoundingClientRect().bottom < 700))), 'three format tiles, all above the fold');
ok(await page.locator('.mode').evaluateAll(els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size === 1), 'the tiles sit side by side');
ok(await page.getAttribute('#customBtn', 'aria-expanded') === 'false' && await page.isHidden('#customBody'), 'Customise starts folded');
for (const n of ['Question', 'Difficulty', 'Flash']) ok(await page.locator('#customBody legend', { hasText: new RegExp('^' + n + '$') }).isHidden(), n + ' is inside the fold');
const sum = (await page.textContent('#customBtn .muted')).trim();
ok(/questions/.test(sum) && /Normal/.test(sum) && /each/.test(sum), 'a one-line summary of the choices: ' + sum);
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
await page.screenshot({ path: SP + '/play-folded.png' });
await page.click('#customBtn');
ok(await page.isVisible('#customBody legend:text-is("Question")') && await page.isVisible('#customBody legend:text-is("Flash")'), 'tapping Customise shows the options');
await page.click('input[name=len][value="10"]', { force: true }).catch(() => {});
await page.$eval('input[name=diff][value=hard]', el => el.click());
ok((await page.textContent('#customBtn .muted')).includes('Hard') && (await page.textContent('#customBtn .muted')).includes('10 questions'), 'the summary follows the choices');
await page.screenshot({ path: SP + '/play-custom.png', fullPage: true });
await page.reload(); await page.waitForSelector('#startBtn');
ok(await page.getAttribute('#customBtn', 'aria-expanded') === 'true', 'the open fold is remembered');
ok(await page.$eval('input[name=diff][value=hard]', e => e.checked), 'the last choices are remembered (Hard)');
await page.$eval('input[name=diff][value=normal]', el => el.click());
await page.click('#customBtn');
// Picking a deck by hand sticks while you stay in the app
await page.selectOption('#pDeck', 'zzz');
await page.click('.tab[data-tab=stats]'); await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
ok(await page.inputValue('#pDeck') === 'zzz', 'a deck you picked stays picked');
await page.selectOption('#pDeck', 'sample');

// ----- exam deck: Play starts new cards -----
const cards = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.deckId === 'sample').map(c => ({ id: c.id, front: c.front, back: c.back })));
const byFront = Object.fromEntries(cards.map(c => [c.front, c]));
let wrongId = null;
const playRound = async () => {
  await page.click('.tab[data-tab=stats]'); await page.click('.tab[data-tab=play]'); await page.waitForSelector('#startBtn');
  await page.selectOption('#pDeck', 'sample');
  await page.click('#customBtn');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await page.$eval(s, el => el.click());
  await page.click('#startBtn'); await page.waitForSelector('#pCard');
  const seen = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(() => document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent);
    const c = byFront[await page.textContent('#pPrompt')];
    seen.push(c.id);
    if (!wrongId) wrongId = c.id;                          // the very first card is answered wrong
    const idx = await page.evaluate(v => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === v), c.back);
    await page.keyboard.press(String((c.id === wrongId ? (idx + 1) % 4 : idx) + 1));
    await page.waitForSelector('.fb'); await page.keyboard.press('Enter');
  }
  await page.waitForSelector('.stamp');
  return seen;
};
const seen = await playRound();
const distinct = new Set(seen).size;
const info = await page.evaluate(async () => { const db = await import('./js/db.js'); return { logs: (await db.getAll('reviewLog')).filter(l => l.source === 'play'), states: await db.getAll('cardStates') }; });
const first = new Set(info.logs.filter(l => l.reason === 'first').map(l => l.cardId));
console.log('   distinct cards seen:', distinct, 'started:', first.size, 'results note:', (await page.textContent('.sched-note')).trim());
ok(distinct >= 4, 'the round showed at least 4 different new cards (' + distinct + ')');
ok(first.size === 3, 'new cards started by Play stop at the new-cards-per-day limit (3): ' + first.size);
ok(info.states.length === 3 && info.states.every(s => first.has(s.cardId)), 'only those cards got a schedule');
ok(info.logs.filter(l => l.reason === 'new-limit').length >= 1 && info.logs.filter(l => l.reason === 'new-limit').every(l => !l.applied), 'cards over the limit are only logged');
const wrongLog = info.logs.find(l => l.cardId === wrongId && l.reason === 'first');
ok(wrongLog && wrongLog.rating === 1 && wrongLog.applied && wrongLog.state === 0, 'a wrong first answer counts as Again');
const right = info.logs.filter(l => l.reason === 'first' && l.cardId !== wrongId && l.correct);
ok(right.length >= 1 && right.every(l => l.rating === 3 || l.rating === 2), 'right multiple-choice answers are Good or Hard, never Easy');
ok(info.states.some(s => s.cardId === wrongId && s.state === 1), 'the missed card is now learning');
const note = await page.textContent('.sched-note');
ok(/new cards? started, because (its|their) deck has an exam/.test(note), 'the results note explains why new cards started');
ok(/over today.s new-card limit/.test(note), 'and mentions the cards over the limit');
await page.screenshot({ path: SP + '/play-results-exam.png', fullPage: true });

// ----- a card Play already started today is not changed again -----
const before = JSON.stringify(info.states.sort((a, b) => a.cardId.localeCompare(b.cardId)));
await playRound();
const after = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).sort((a, b) => a.cardId.localeCompare(b.cardId)));
const startedAgain = after.filter(s => !JSON.parse(before).some(b => b.cardId === s.cardId));
ok(startedAgain.length === 0, 'with the limit used up, a second round starts no more new cards');
ok(JSON.stringify(after.filter(s => JSON.parse(before).some(b => b.cardId === s.cardId))) === before, 'and cards Play changed today are not changed again (one change a day)');

// ----- no exam: the old behaviour -----
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ ...(await db.getDeck('sample')), examDate: null }); await db.setSetting('newPerDay', 20);
  const ids = (await db.getAll('cardStates')).map(s => s.cardId); await db.clearStates(ids); });
const states0 = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).length);
if (states0 === 0) {
  await page.reload(); wrongId = 'none';
  await playRound();
  const n = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).length);
  ok(n === 0, 'no exam: Play still leaves new cards for Review');
  ok(/start in Review, not here/.test(await page.textContent('.sched-note')), 'and the note says so');
} else console.log('   (skipped the no-exam round: could not clear schedules)');

await browser.close();
if (errors.length) { console.log('ERRORS\n' + errors.join('\n')); process.exitCode = 1; }
