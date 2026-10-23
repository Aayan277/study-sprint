// Cloze cards in every list and summary: the raw {{c1::...}} markup must never show, only the card's readable text (the
// blanked front, or the sentence with its answers filled in). Seeds a deck of cloze notes (one with hints, one with bold and
// a formula) and visits the lists, rounds and sheets that name a card.
// Run with: node tests/browser/run.mjs cloze-lists      (SHOTS=/some/folder also saves 375px dark screenshots)
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const SHOTS = process.env.SHOTS || '';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck, .empty');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

// Three cloze notes (7 cards) and one ordinary card, in the only deck. Every card has a schedule with lapses (Stats: hardest
// cards) and is due; one note is tagged leech.
const seeded = await page.evaluate(async () => {
  const db = await import('./js/db.js'), cz = await import('./js/cloze.js');
  const DAY = 86400000, now = Date.now();
  for (const d of await db.getDecks()) await db.deleteDeck(d.id);          // (the sample deck: only the seeded cards are on the screens)
  await db.addDeckWithCards({ id: 'czd', name: 'Cloze lists', color: '#46A758', created: now + 1 },
    [{ id: 'basic1', deckId: 'czd', front: 'Ribosome', back: 'Makes proteins', tags: [], created: now - 50 }]);
  const texts = ['The {{c1::mitochondria}} makes {{c2::ATP}} for the {{c3::cell}}', 'The {{c1::nucleus::organelle}} holds the {{c2::DNA::molecule}}',
    'A **{{c1::bold}}** idea and {{c2::$x^2$::a formula}}'];
  for (const [i, t] of texts.entries()) await db.saveNote(cz.planNoteSave([], t), { deckId: 'czd', noteId: 'note' + i, tags: i === 1 ? ['leech'] : ['bio'] });
  const cards = (await db.getAll('cards')).filter(c => c.noteId);
  await db.putMany('cardStates', cards.map((c, i) => ({ cardId: c.id, due: now - DAY, stability: 3 + i, difficulty: 6, elapsedDays: 2, scheduledDays: 2, learningSteps: 0, reps: 4, lapses: 3 + i, state: 2, lastReview: now - 3 * DAY })));
  await db.putMany('reviewLog', cards.map((c, i) => ({ cardId: c.id, timestamp: now - i * 60000, source: 'review', mode: 'flip', correct: false, ms: 4000, rating: 1, state: 2, applied: true, reason: 'due' })));
  await db.setSetting('leechThreshold', 4); await db.setSetting('leechAction', 'tag');
  return { cloze: cards.length, all: (await db.getAll('cards')).length };
});
ok(seeded.cloze === 7 && seeded.all === 8, 'seeded 7 cloze cards and 1 ordinary card');

// What is visible: the screen's text, plus the labels a screen reader or a hover reads. (Not what is typed into a box: the
// editor shows the note's own text on purpose. The "{{c1::…}}" in the import screen's link is an instruction, not a card.)
const leaks = () => page.evaluate(() => {
  const clean = s => (s || '').replace(/\{\{c1::…\}\}/g, '');
  const found = [], bad = s => /\{\{c\d/.test(clean(s));
  const text = clean(document.body.innerText);
  if (bad(text)) found.push('text: ' + text.split('\n').filter(l => /\{\{c\d/.test(l)).join(' | ').slice(0, 200));
  for (const el of document.body.querySelectorAll('[aria-label],[title],[alt]')) for (const a of ['aria-label', 'title', 'alt']) if (bad(el.getAttribute(a))) found.push(a + ': ' + el.getAttribute(a).slice(0, 120));
  return found;
});
const check = async (where, shot) => {
  const f = await leaks();
  ok(!f.length, `no {{c markup in ${where}${f.length ? ' -> ' + f.join(' || ') : ''}`);
  if (shot && SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}.png` });
};
const go = async (hash, sel) => { await page.evaluate(h => { location.hash = h; }, hash); if (sel) await page.waitForSelector(sel); await page.waitForTimeout(400); };

await go('#/today', '.today-hero'); await check('Today', 'today');
await go('#/decks', '.deck'); await check('Decks');
await go('#/deck/czd', '.crow'); await check('the deck view', 'deck');
await go('#/browse', '.crow'); await check('Browse (all cards)', 'browse');
ok((await page.locator('.crow .ckind').count()) === 7, 'Browse shows the 7 cloze cards (c1, c2...)');
await go('#/browse/leech', '.crow'); await check('Browse, leech filter', 'browse-leech');
await page.fill('#brQuery', 'mitochondria'); await page.waitForTimeout(500); await check('Browse search results', 'browse-search');
await page.fill('#brQuery', ''); await page.selectOption('#brFilter', 'all'); await page.waitForTimeout(300);
await page.selectOption('#brFilter', 'dupes'); await page.waitForTimeout(300); await check('Browse, duplicates filter');
await page.selectOption('#brFilter', 'all'); await page.waitForTimeout(200);
await page.click('#brSelect'); await page.click('#brAll'); await page.click('#brActions'); await page.waitForTimeout(300); await check('Browse, selected cards and actions', 'browse-actions');
await page.keyboard.press('Escape');

// The editor panel of a cloze card, and Browse > Tools (Link cloze cards)
await go('#/browse', '.crow');
await page.locator('.crow', { hasText: 'mitochondria' }).first().click(); await page.waitForSelector('#ceText');
await check('the card editor panel', 'editor'); await page.keyboard.press('Escape');
await page.evaluate(async () => {            // two older plain cards that belong together, for the link tool
  const db = await import('./js/db.js'), now = Date.now();
  await db.saveCards([1, 2].map(n => ({ id: 'old' + n, deckId: 'czd', front: n === 1 ? 'The […] pumps blood' : 'The heart pumps […]', back: n === 1 ? 'heart' : 'blood', tags: [], created: now })));
});
await go('#/browse', '.crow'); await page.click('#brTags'); await page.waitForSelector('#linkFind'); await page.click('#linkFind'); await page.waitForTimeout(400);
await check('Browse > Tools > Link cloze cards', 'link-tool');
await page.reload(); await page.waitForSelector('.crow'); await page.click('#brTags'); await page.click('#toolAutoTag'); await page.waitForTimeout(2500);
await check('Browse > Tools > Auto-tag', 'autotag');
await page.reload(); await page.waitForSelector('.crow'); await page.click('#brTags'); await page.click('#toolTagStudy'); await page.waitForTimeout(500);
await check('Browse > Tools > Study by tag');
await page.reload(); await page.waitForSelector('.tab');

// Stats: hardest cards, the mastery grid and a tapped square
await go('#/stats', '.chart'); await page.locator('#hardList').scrollIntoViewIfNeeded(); await check('Stats', 'stats');
ok((await page.locator('.hard-list li').count()) >= 5, 'Stats lists the hardest cards');
const tile = page.locator('.mtile').first();
if (await tile.isVisible()) { await tile.click(); await page.waitForTimeout(300); await check('Stats, a tapped mastery square', 'stats-tile'); }

// Play: setup, a round answered wrong, the results (mix-ups, missed cards) and the Compare sheet
await go('#/play', '#startBtn'); await check('Play setup', 'play-setup');
await page.$eval('input[name=fmt][value=classic]', el => el.click());
await page.$eval('input[name=qtype][value=front]', el => el.click());
await page.click('#startBtn'); await page.waitForSelector('#pPrompt');
await page.waitForFunction(() => document.querySelector('#pPrompt')?.textContent);
let sawBlank = false;
for (let i = 0; i < 40 && !(await page.locator('.res-head').count()); i++) {
  if (!(await page.locator('#options .lbl').count())) break;
  sawBlank = sawBlank || /\[[^\]]+\]/.test(await page.textContent('#pPrompt'));
  if (i === 0) await check('a Play question', 'play-question');
  await page.keyboard.press('1');
  await page.waitForSelector('.fb, .res-head', { timeout: 5000 }).catch(() => {});
  await check('Play feedback ' + i);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
}
ok(sawBlank, 'Play asked a cloze card (a question with its blank)');
await page.waitForSelector('.res-head', { timeout: 5000 });
await check('Play results', 'play-results');
const cmp = page.locator('button:has-text("Compare")').first();
if (await cmp.count()) { await cmp.click(); await page.waitForSelector('#sheet'); await page.waitForTimeout(400); await check('the Compare sheet of two mixed-up cloze cards', 'compare'); await page.keyboard.press('Escape'); }

// Practice test: a question and the results with every question reviewed
await go('#/deck/czd', '#testBtn');
await page.click('#testBtn'); await page.waitForSelector('#ptForm');
await page.click('#ptStart'); await page.waitForSelector('#tPrompt');
await check('a Practice test question', 'test-question');
for (let i = 0; i < 12 && !(await page.locator('#tSubmit').count()); i++) { await page.click('#tNext'); await page.waitForTimeout(100); }
await page.click('#tSubmit'); if (await page.locator('#tAskYes').isVisible().catch(() => false)) await page.click('#tAskYes');
await page.waitForSelector('#tReview');
await check('Practice test results', 'test-results');

// Review: every card of the round (front, then answer), then the end of the round
await go('#/today', '.today-hero');
await page.click('.today-hero .btn.primary, #startBtn');
await page.waitForSelector('#flash, .flash-front');
let sawCloze = false;
for (let i = 0; i < 12; i++) {
  if (!(await page.locator('button:has-text("Show answer")').count())) break;
  sawCloze = sawCloze || (await page.locator('.cloze-blank').count()) > 0;
  await check('Review, question ' + i, i === 1 ? 'review' : '');
  await page.keyboard.press('Space'); await page.waitForTimeout(250);
  await check('Review, answer ' + i, i === 1 ? 'review-answer' : '');
  await page.keyboard.press('1'); await page.waitForTimeout(450);
}
ok(sawCloze, 'Review showed a cloze card (with its blank)');
await page.waitForTimeout(800);
await check('the end of a Review round', 'review-finish');

// Import: pasted cloze lines (the preview), and an Anki file with a cloze note
await go('#/import', '#pasteBox');
await page.fill('#pasteBox', 'The {{c1::cell}} has a {{c2::nucleus::organelle}} and {{c3::DNA}}\nWater is {{c1::H2O}}');
await page.waitForSelector('#clozeNote:not([hidden])'); await page.waitForTimeout(400);
await check('the import preview', 'import-preview');
await page.selectOption('#deckSel', 'czd'); await page.waitForTimeout(300); await check('the import preview with a deck chosen (duplicate check)');
await go('#/import', '#tab-file'); await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/files/anki-new.apkg');
await page.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
await check('the import preview of an Anki file', 'import-anki');

// A desktop window: the side panel, Stats and Today
await page.setViewportSize({ width: 1280, height: 900 });
await go('#/browse', '.crow'); await page.locator('.crow', { hasText: 'nucleus' }).first().click(); await page.waitForTimeout(500);
await check('Browse on a desktop, with a card open');
await go('#/stats', '.chart'); await check('Stats on a desktop');
await go('#/today', '.today-hero'); await check('Today on a desktop');

ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ').slice(0, 300) : ''));
await browser.close();
