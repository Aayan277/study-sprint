import { chromium, sheetSettled } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const DAY = 86400000;
const deckData = name => page.evaluate(async n => {
  const db = await import('./js/db.js');
  const d = (await db.getDecks()).find(d => d.name === n);
  const cards = await db.getCardsInDeck(d.id), out = {};
  const logs = await db.getAll('reviewLog');
  for (const c of cards) out[c.front] = { state: await db.get('cardStates', c.id), logs: logs.filter(l => l.cardId === c.id) };
  return out;
}, name);

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const load = async file => {
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  await page.waitForSelector('#preview[data-guids]'); if (await page.isVisible('#updRow')) await page.click('#updateOld');          // (this file imports the same notes twice on purpose: as new cards each time)
};

// new format, progress on
await load('anki-sched-new.apkg');
ok(await page.isVisible('#progRow') && await page.isChecked('#ankiProg'), 'progress switch shown, on by default');
ok((await page.textContent('#progInfo')).startsWith('10 reviews on 3 cards'), 'progress info: ' + await page.textContent('#progInfo'));
await page.screenshot({ path: SP + '/anki-prog.png' });
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Bio new'); await page.click('#saveBtn'); await page.waitForSelector('.crow');
ok((await page.textContent('#toast')).includes('3 with Anki progress'), 'toast: ' + await page.textContent('#toast'));
let d = await deckData('Bio new');
const m = d['Mitochondria'];
ok(m.state?.state === 2 && m.logs.length === 5 && m.logs.every(l => l.source === 'anki'), 'Mitochondria: in review with 5 Anki reviews');
// The test file's reviews have fixed dates, so compare with its own last review rather than today's date.
const lastLog = Math.max(...m.logs.map(l => l.timestamp));
ok(Math.abs(m.state.lastReview - lastLog) < DAY, 'last review is the last Anki review');
ok(m.state.due > m.state.lastReview && m.state.reps === 5, `due rebuilt from history (due in ${((m.state.due - Date.now()) / DAY).toFixed(1)} days)`);
ok(!d['Ribosome'].state && d['Ribosome'].logs.length === 4, 'Ribosome: Forget in Anki → new, history kept');
ok(!d['Nucleus'].state && !d['Nucleus'].logs.length, 'Nucleus: never reviewed → new');
const z = d['DNA is copied into […]'];
ok(z && z.state && z.logs.length === 1 && !d['[…] is copied into RNA'].state, 'cloze blank 2 got its own history, blank 1 is new');
// card info shows Anki rows
await page.locator('.crow', { hasText: 'Mitochondria' }).click(); await page.waitForSelector('#ceForm');
await page.click('.card-info summary');
ok((await page.locator('.history tbody tr').count()) === 5 && (await page.textContent('.history')).includes('Anki'), 'card info lists Anki reviews');
await page.click('.sheet-x');
// stats screen counts them
await sheetSettled(page); await page.goto('http://localhost:8123/#/stats'); await page.waitForSelector('.stats4, .stat, h1');
await page.waitForTimeout(500);
const statsText = await page.innerText('#screen');
ok(!/No reviews yet/i.test(statsText), 'stats show the imported reviews');
await page.screenshot({ path: SP + '/anki-stats.png', fullPage: true });

// old format, progress off
await load('anki-sched-legacy.apkg');
ok((await page.textContent('#progInfo')).startsWith('10 reviews on 3 cards'), 'legacy file has progress too');
await page.click('#ankiProg');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Bio fresh'); await page.click('#saveBtn'); await page.waitForSelector('.crow');
d = await deckData('Bio fresh');
ok(Object.values(d).every(x => !x.state && !x.logs.length), 'switch off: all new, no history');

// a file without progress hides the switch
await load('anki-new.apkg');
ok(!(await page.isVisible('#progRow')) && (await page.textContent('#found')).includes('Include scheduling information'), 'no history: switch hidden, tip shown');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
