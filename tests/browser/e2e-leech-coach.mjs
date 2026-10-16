// Round 2 (2D, B7): the leech coach ("Cards you keep forgetting") on the Review finish screen and Play results.
// Threshold 2 -> toast, the session goes on -> the finish panel -> Split, Memory hook, Fix later -> #/browse/leech,
// the "N cards to fix" links on Decks and Stats -> the Play path -> 375 and 1440, dark and light.
// Run with: node tests/browser/run.mjs leech-coach
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const DAY = 86400000;

const open = async ({ w = 375, h = 800, scheme = 'dark' } = {}) => {
  const touch = w < 600;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, colorScheme: scheme });
  await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck, .empty');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  return p;
};
const noHScroll = async (p, w, what) => ok(await p.evaluate(x => document.documentElement.scrollWidth <= x, w), 'no sideways scroll: ' + what);
// Deck "Bio": three cards one forgetting away from a leech (lapses 1, threshold 2) and three ordinary due cards.
const seed = p => p.evaluate(async DAY => {
  const db = await import('./js/db.js'); const now = Date.now();
  const make = (id, front, back, extra = {}) => ({ id, deckId: 'bio', front, back, tags: ['bio'], created: now - 100 + Object.keys(extra).length, ...extra });
  const cards = [make('L1', 'Primary colours', 'red; green; blue'), make('L2', 'Mitochondria', 'The powerhouse of the cell'), make('L3', 'Ribosome', 'Makes proteins'),
    make('P1', 'Nucleus', 'Holds the DNA'), make('P2', 'Vacuole', 'Stores water'), make('P3', 'Membrane', 'The cell’s skin')];
  await db.addDeckWithCards({ id: 'bio', name: 'Biology', color: '#46A758', created: now }, cards);
  await db.setSetting('leechThreshold', 2);
  await db.setSetting('leechAction', 'suspend');
  const mk = (id, d, l) => ({ cardId: id, due: now - d * DAY, stability: 5, difficulty: 5, elapsedDays: 3, scheduledDays: 5, learningSteps: 0, reps: 9, lapses: l, state: 2, lastReview: now - (d + 5) * DAY });
  await db.putMany('cardStates', [mk('L1', 9, 1), mk('L2', 8, 1), mk('L3', 7, 1), mk('P1', 3, 0), mk('P2', 2, 0), mk('P3', 1, 0)]);
}, DAY);
const cardsNow = p => p.evaluate(async () => { const db = await import('./js/db.js'); return db.getAll('cards'); });

// ---------- 1. Review: threshold 2 -> toast, the session goes on, the panel at the end ----------
let p = await open();
await seed(p);
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
await p.click('#startBtn'); await p.waitForSelector('#flash');
let sawToast = false, afterLeech = null;
while (!(await p.$('.finish-next'))) {
  await p.waitForSelector('#showBtn, .finish-next');
  if (await p.$('.finish-next')) break;
  const front = (await p.textContent('#flash .flash-front, #flash')).trim();
  const leechy = /Primary colours|Mitochondria|Ribosome/.test(front);
  await p.click('#showBtn');
  await p.click(leechy ? '.rate.r1' : '.rate.r3');
  if (leechy && !sawToast) {
    await p.waitForFunction(() => /Leech/.test(document.querySelector('#toast')?.textContent || ''));
    ok((await p.textContent('#toast')).includes('Leech: suspended. You can fix it at the end of the session.'), 'toast: "' + (await p.textContent('#toast')).trim() + '"');
    sawToast = true;
    await p.waitForFunction(() => document.querySelector('#flash, .finish-next'));
    afterLeech = await p.$('#flash') !== null;
  }
  await p.waitForFunction(() => !document.querySelector('.rate'));
}
ok(afterLeech === true, 'the session goes on after the leech toast');
await p.waitForSelector('#finishMore .coach .coach-row');
ok((await p.textContent('#finishMore .coach h2')) === 'Cards you keep forgetting', 'panel heading: "Cards you keep forgetting"');
ok(await p.locator('#finishMore .coach-row').count() === 3, 'one row per leech (3)');
ok(await p.evaluate(() => !/leech/i.test(document.querySelector('#finishMore .coach').textContent)), 'no "leech" jargon in the panel text');
// v4.8.1: "Forgotten 2×" became "Forgotten 2 times" (the × reads badly aloud).
ok(/Forgotten 2 times/.test(await p.textContent('.coach-row[data-id=L1]')), 'row shows the lapse count');
let after = await cardsNow(p);
ok(['L1', 'L2', 'L3'].every(id => { const c = after.find(x => x.id === id); return c.suspended && c.tags.includes('leech'); }), 'all three are suspended and tagged');
await noHScroll(p, 375, 'finish panel 375'); await p.screenshot({ path: SP + '/coach-finish-375-dark.png', fullPage: true });

// ---------- 2. Split into 2: two new cards, the original gone ----------
await p.click('.coach-row[data-id=L1] [data-act=split]'); await p.waitForSelector('#splitForm');
const fronts = await p.$$eval('.split-f', els => els.map(e => e.value)), backs = await p.$$eval('.split-b', els => els.map(e => e.value));
ok(fronts.length === 3 && backs.join('|') === 'red|green|blue', 'Split prefills from ";": ' + backs.join('|'));
ok(fronts.every(f => f === 'Primary colours'), 'the front is copied to every part');
await p.screenshot({ path: SP + '/coach-split-375-dark.png' });
await noHScroll(p, 375, 'split sheet 375');
// Make it 2 pieces: clear the third.
await p.fill('.split-row:nth-child(3) .split-b', '');
// v4.8.1 (L3): keeping the original, suspended, is the default; this test picks Delete to exercise the confirm.
ok(await p.isChecked('input[name=splitOrig][value=keep]'), 'the original is kept (suspended) by default');
await p.check('input[name=splitOrig][value=delete]');
await p.click('#splitForm button[type=submit], #sheet button[form=splitForm]'); await p.waitForSelector('#cfYes');
ok(/Delete the original/.test(await p.textContent('#splitConfirm')), 'deleting the original asks first, in the page');
await p.click('#cfYes'); await p.waitForFunction(() => !document.querySelector('#sheet[open]'));
after = await cardsNow(p);
const kids = after.filter(c => c.front === 'Primary colours');
ok(kids.length === 2 && !after.some(c => c.id === 'L1'), 'Split into 2 makes 2 new cards and removes the original');
ok(kids.every(c => c.deckId === 'bio' && !c.tags.includes('leech') && c.tags.includes('bio') && !c.suspended), 'new cards: same deck, tags without leech, not suspended');
ok(kids.map(c => c.back).sort().join('|') === 'green|red', 'backs are red and green');
ok(await p.locator('.coach-row[data-id=L1]').count() === 0 && await p.locator('.coach-row').count() === 2, 'the row is gone');

// ---------- 3. Memory hook: saved in noteExtra, unsuspended, schedule kept ----------
const before = await p.evaluate(async () => (await import('./js/db.js')).get('cardStates', 'L2'));
await p.click('.coach-row[data-id=L2] [data-act=hook]'); await p.waitForSelector('#hookForm');
await p.screenshot({ path: SP + '/coach-hook-375-dark.png' });
await p.click('#sheet button[form=hookForm]');
ok(!(await p.locator('#hookErr').isHidden()), 'an empty hook asks for text');
await p.fill('#hookText', 'Mighty mito makes the energy');
await p.click('#sheet button[form=hookForm]'); await p.waitForFunction(() => !document.querySelector('#sheet[open]'));
after = await cardsNow(p);
const l2 = after.find(c => c.id === 'L2');
ok(l2.noteExtra === 'Mighty mito makes the energy' && !l2.suspended && !l2.tags.includes('leech') && l2.tags.includes('bio'), 'hook saved, card unsuspended, leech tag removed');
const state2 = await p.evaluate(async () => (await import('./js/db.js')).get('cardStates', 'L2'));
ok(JSON.stringify(state2) === JSON.stringify(before) && state2.lapses === 2, 'the schedule is kept as it was (lapses ' + state2.lapses + ')');
ok(await p.locator('.coach-row[data-id=L2]').count() === 0, 'the hooked row is gone');
// It shows under the answer in Review.
await p.evaluate(async d => { const db = await import('./js/db.js'); const s = await db.get('cardStates', 'L2'); await db.putMany('cardStates', [{ ...s, due: Date.now() - d }]); }, DAY);

// ---------- 4. Fix later: it stays on the Leeches list ----------
await p.click('.coach-row[data-id=L3] [data-act=later]');
await p.waitForFunction(() => !document.querySelector('#finishMore .coach'));
ok(await p.locator('#finishMore .coach').count() === 0 && await p.$eval('#finishMore', m => m.hidden), 'Fix later closes the row; the empty panel hides');
await p.goto(URL + '#/decks'); await p.reload(); await p.waitForSelector('#leechLink');
ok((await p.textContent('#leechLink')).trim() === '1 card to fix' && (await p.getAttribute('#leechLink', 'href')) === '#/browse/leech', 'Decks footer: "1 card to fix" -> #/browse/leech');
await p.screenshot({ path: SP + '/coach-decks-375-dark.png', fullPage: true });
await p.click('#leechLink'); await p.waitForSelector('#brFilter');
ok(await p.$eval('#brFilter', s => s.value) === 'leech', 'the route sets the Leeches filter');
await p.waitForSelector('.crow');
const listed = await p.$$eval('.crow .f', els => els.map(e => e.textContent.trim()));
ok(listed.length === 1 && listed[0] === 'Ribosome', 'the list shows the card left to fix: ' + listed.join(','));
await noHScroll(p, 375, 'browse leech 375');
// Stats link.
await p.goto(URL + '#/stats'); await p.waitForSelector('#leechFix');
ok((await p.getAttribute('#leechFix', 'href')) === '#/browse/leech', 'Stats Hardest links to the list');
await p.goto(URL + '#/browse'); await p.reload(); await p.waitForSelector('#brFilter');
ok(await p.$eval('#brFilter', s => s.value) === 'all', '#/browse without an argument starts on All cards');

// ---------- 5. The hook shows under the answer ----------
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
await p.click('#startBtn'); await p.waitForSelector('#flash');
let seen = false;
for (let i = 0; i < 12 && !seen && !(await p.$('.finish-next')); i++) {
  const front = (await p.textContent('#flash')).trim();
  await p.click('#showBtn');
  if (front.includes('Mitochondria')) {
    await p.waitForSelector('.flash-extra');
    ok((await p.textContent('.flash-extra')).includes('Mighty mito makes the energy'), 'the hook shows under the answer in Review (a Basic card)');
    seen = true;
  }
  await p.click('.rate.r3'); await p.waitForFunction(() => !document.querySelector('.rate'));
}
ok(seen, 'the hooked card came up in Review (unsuspended)');
await p.close();

// ---------- 6. Edit, Delete, Keep suspended, Comparison (a second round) ----------
p = await open();
await seed(p);
await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
await p.click('#startBtn'); await p.waitForSelector('#flash');
while (!(await p.$('.finish-next'))) {
  await p.waitForSelector('#showBtn, .finish-next');
  if (await p.$('.finish-next')) break;
  const front = (await p.textContent('#flash')).trim();
  await p.click('#showBtn'); await p.click(/Primary|Mito|Ribo/.test(front) ? '.rate.r1' : '.rate.r3');
  await p.waitForFunction(() => !document.querySelector('.rate'));
}
await p.waitForSelector('#finishMore .coach-row');
// Edit: save in the editor -> back in reviews, no leech tag.
await p.click('.coach-row[data-id=L2] [data-act=edit]'); await p.waitForSelector('#ceForm');
await p.fill('#ceBack', 'The powerhouse of the cell (makes ATP)');
await p.click('#ceForm button[type=submit], #sheet button[form=ceForm]');
await p.waitForFunction(() => !document.querySelector('.coach-row[data-id=L2]'));
let c2 = (await cardsNow(p)).find(c => c.id === 'L2');
ok(!c2.suspended && !c2.tags.includes('leech') && /ATP/.test(c2.back), 'Edit: saved, unsuspended, leech tag removed');
// Comparison: no mix-up on record, so a search appears.
await p.click('.coach-row[data-id=L3] [data-act=compare]'); await p.waitForSelector('#partnerQ');
await p.fill('#partnerQ', 'nucleus');
ok(await p.locator('.partner-pick').count() === 1, 'the partner search finds a card');
await p.screenshot({ path: SP + '/coach-partner-375-dark.png' });
await p.click('.partner-pick'); await p.waitForSelector('#sheet .cmp');
ok(await p.locator('.cmp-col').count() === 2, 'the comparison opens side by side');
await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#sheet[open]'));
// Delete asks first.
await p.click('.coach-row[data-id=L3] [data-act=delete]'); await p.waitForSelector('.coach-confirm .confirm');
await p.click('.coach-confirm [data-no]');
ok(await p.locator('.coach-row[data-id=L3]').count() === 1, 'Cancel keeps the card');
await p.click('.coach-row[data-id=L3] [data-act=delete]'); await p.click('.coach-confirm [data-yes]');
await p.waitForFunction(() => !document.querySelector('.coach-row[data-id=L3]'));
ok(!(await cardsNow(p)).some(c => c.id === 'L3'), 'Delete removes the card');
// The last row: Keep suspended.
await p.screenshot({ path: SP + '/coach-finish-1-375-dark.png', fullPage: true });
// A deleted card mid-session is tolerated: the panel just skips it (second visit with a missing id).
const res = await p.evaluate(async () => {
  const m = await import('./js/leech-coach.js');
  return (await m.coachHTML(['gone-1', 'gone-2'])) === '';
});
ok(res, 'cards that no longer exist are skipped');
await p.close();

// ---------- 6b. v4.8.1 review fixes (L1 to L7) ----------
p = await open();
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const { planNoteSave } = await import('./js/cloze.js'); const now = Date.now();
  const mk = (id, front, back, extra = {}) => ({ id, deckId: 'bio', front, back, tags: ['bio', 'leech'], suspended: true, created: now - 100, ...extra });
  await db.addDeckWithCards({ id: 'bio', name: 'Biology', color: '#46A758', created: now },
    [mk('B1', 'Primary colours', 'red; green; blue'), mk('B2', 'Mitochondria', 'The powerhouse'), mk('B3', 'Ribosome', 'Makes proteins'),
     { id: 'P1', deckId: 'bio', front: 'Nucleus', back: 'Holds the DNA', tags: ['bio'], created: now - 50 }]);
  await db.saveNote(planNoteSave([], '{{c1::Paris}} is the capital of {{c2::France}}'), { deckId: 'bio', noteId: 'N1', tags: ['bio'] });
  const c1 = (await db.getAll('cards')).find(c => c.noteId === 'N1' && c.cloze === 1);
  await db.saveCards([{ ...c1, suspended: true, tags: ['bio', 'leech'] }]);
});
const cloze1 = (await cardsNow(p)).find(c => c.noteId === 'N1' && c.cloze === 1).id;
await p.goto(URL + '#/today'); await p.waitForSelector('#startBtn');
await p.evaluate(async ids => {
  document.querySelector('main').insertAdjacentHTML('beforeend', '<div id="finishMore" class="finish-more" hidden></div>');
  await (await import('./js/finish-extras.js')).drawFinishExtras(document.getElementById('finishMore'), { source: 'review', leechIds: ids, cardIds: [] });
}, ['B1', 'B2', 'B3', cloze1]);
await p.waitForSelector('#finishMore .coach-row');
ok(await p.locator('.coach-row[data-id=B1] [data-act=split]').count() === 1 && await p.locator(`.coach-row[data-id="${cloze1}"] [data-act=split]`).count() === 0, 'L2: Split is offered on a Basic card but not on a cloze card');
// L1 + L3: Split defaults to keeping the original; a double tap makes the cards once
await p.click('.coach-row[data-id=B1] [data-act=split]'); await p.waitForSelector('#splitForm');
ok(await p.isChecked('input[name=splitOrig][value=keep]'), 'L3: "Keep it, suspended" is the default');
await p.evaluate(() => { const b = document.querySelector('#sheet button[form=splitForm]'); b.click(); b.click(); });
await p.waitForFunction(() => !document.querySelector('#sheet[open]'));
let now2 = await cardsNow(p);
ok(now2.filter(c => c.front === 'Primary colours' && !c.suspended).length === 3, 'L1: a double tap on Split made 3 cards, not 6 (' + now2.filter(c => c.front === 'Primary colours' && !c.suspended).length + ')');
ok(now2.find(c => c.id === 'B1')?.suspended === true && !now2.find(c => c.id === 'B1').tags.includes('leech'), 'L3: the original stays, suspended');
// L4: focus moves to the next row's first button
await p.waitForFunction(() => document.activeElement?.closest('.coach-row')?.dataset.id === 'B2' && document.activeElement.tagName === 'BUTTON', null, { timeout: 3000 }).catch(() => {});
ok(await p.evaluate(() => document.activeElement?.closest('.coach-row')?.dataset.id === 'B2' && document.activeElement.tagName === 'BUTTON'), 'L4: after a row goes, focus is on the next row');
// L5: inline confirm focuses Cancel; Cancel returns focus to the opener
await p.click('.coach-row[data-id=B2] [data-act=delete]'); await p.waitForSelector('.coach-confirm [data-no]');
ok(await p.evaluate(() => document.activeElement?.matches('[data-no]')), 'L5: the delete confirm focuses Cancel');
await p.click('.coach-confirm [data-no]');
ok(await p.evaluate(() => document.activeElement?.matches('.coach-row[data-id=B2] [data-act=delete]')), 'L5: Cancel returns focus to Delete');
// L7: a comparison card made from the row closes the row
await p.click('.coach-row[data-id=B3] [data-act=compare]'); await p.waitForSelector('#partnerQ');
await p.fill('#partnerQ', 'nucleus'); await p.click('.partner-pick'); await p.waitForSelector('#cmpMake');
await p.click('#cmpMake'); await p.waitForSelector('#acForm');
await p.keyboard.press('Control+Enter');
await p.waitForFunction(() => !document.querySelector('.coach-row[data-id=B3]'));
ok((await p.textContent('#toast')).includes('Comparison card made.') && (await cardsNow(p)).some(c => / vs /.test(c.front)), 'L7: adding the comparison card closes the row ("Comparison card made.")');
// Nit: Fix later says where to find it, with a link
await p.click('.coach-row[data-id=B2] [data-act=later]');
ok((await p.getAttribute('#toast a', 'href')) === '#/browse/leech', 'Fix later: the toast links to #/browse/leech');
// L6: Edit on a cloze card must not hand the leech tag to its sibling
await p.waitForSelector(`.coach-row[data-id="${cloze1}"]`);
await p.click(`.coach-row[data-id="${cloze1}"] [data-act=edit]`); await p.waitForSelector('#ceForm #ceText');
ok(!(await p.inputValue('#ceTags')).includes('leech'), 'L6: the editor opens without the leech tag');
await p.evaluate(async () => (await import('./js/card-editor.js')).setCardText('ceText', '{{c1::Paris}} is the capital of {{c2::France}}, in Europe'));
await p.click('#sheet button[form=ceForm]');
await p.waitForFunction(() => !document.querySelector('.coach-row'));
now2 = await cardsNow(p);
const sibs = now2.filter(c => c.noteId === 'N1');
ok(sibs.length === 2 && sibs.every(c => !c.tags.includes('leech')) && sibs.every(c => !c.suspended), 'L6: after Edit no card of the note carries the leech tag and the card is back');
await p.waitForFunction(() => document.activeElement && document.activeElement !== document.body, null, { timeout: 3000 }).catch(() => {});
ok(await p.evaluate(() => document.activeElement && document.activeElement !== document.body), 'L4: when the last row goes, focus is not dropped on the page');
await p.close();

// ---------- 7. Play path ----------
p = await open();
await seed(p);
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.addDeckWithCards({ id: 'pl', name: 'Play deck', color: '#E5484D', created: now + 1 },
    ['Alpha', 'Beta', 'Gamma', 'Delta'].map((f, i) => ({ id: 'pl' + i, deckId: 'pl', front: f, back: ['Apple', 'Banana', 'Cherry', 'Durian'][i], tags: [], created: i })));
});
await p.goto(URL + '#/play'); await p.reload(); await p.waitForSelector('#pDeck');
await p.selectOption('#pDeck', 'bio');
for (const s of ['input[name=fmt][value=classic]', 'input[name=qtype][value=front]', 'input[name=len][value="10"]', 'input[name=diff][value=normal]', 'input[name=flash][value="0"]']) await p.$eval(s, el => el.click());
await p.click('#startBtn'); await p.waitForSelector('#pCard');
const backOf = { 'Primary colours': 'red; green; blue', Mitochondria: 'The powerhouse of the cell', Ribosome: 'Makes proteins', Nucleus: 'Holds the DNA', Vacuole: 'Stores water', Membrane: 'The cell’s skin' };
const missed = new Set();
while (!(await p.$('.stamp'))) {
  await p.waitForFunction(() => (document.querySelector('#feedback')?.innerHTML === '' && document.querySelector('#pPrompt')?.textContent) || document.querySelector('.stamp'));
  if (await p.$('.stamp')) break;
  const front = (await p.textContent('#pPrompt')).trim();
  const idx = await p.evaluate(v => [...document.querySelectorAll('#options .lbl')].findIndex(b => b.textContent === v), backOf[front]);
  const n = await p.locator('#options .lbl').count();
  const miss = front === 'Ribosome' && !missed.has(front);
  missed.add(front);
  await p.keyboard.press(String((miss ? (idx + 1) % n : idx) + 1));
  await p.waitForSelector('.fb'); await p.keyboard.press('Enter');
}
await p.waitForSelector('#resultsMore .coach .coach-row');
ok(await p.locator('#resultsMore .coach-row[data-id=L3]').count() === 1, 'Play results: the missed card shows in "Cards you keep forgetting"');
await noHScroll(p, 375, 'play results 375'); await p.screenshot({ path: SP + '/coach-play-375-dark.png', fullPage: true });
await p.click('#resultsMore .coach-row[data-id=L3] [data-act=park]');
await p.waitForFunction(() => !document.querySelector('#resultsMore .coach'));
ok(await p.locator('#resultsMore .coach').count() === 0, 'Keep suspended closes the row');
const l3 = (await cardsNow(p)).find(c => c.id === 'L3');
ok(l3.suspended && !l3.tags.includes('leech'), 'it stays suspended and leaves the fix list');
await p.close();

// ---------- 8. 1440 and light ----------
for (const [w, h, scheme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [375, 800, 'light']]) {
  p = await open({ w, h, scheme });
  await seed(p);
  await p.goto(URL + '#/today'); await p.reload(); await p.waitForSelector('#startBtn');
  await p.click('#startBtn'); await p.waitForSelector('#flash');
  while (!(await p.$('.finish-next'))) {
    await p.waitForSelector('#showBtn, .finish-next');
    if (await p.$('.finish-next')) break;
    const front = (await p.textContent('#flash')).trim();
    await p.click('#showBtn'); await p.click(/Primary|Mito|Ribo/.test(front) ? '.rate.r1' : '.rate.r3');
    await p.waitForFunction(() => !document.querySelector('.rate'));
  }
  await p.waitForSelector('#finishMore .coach-row');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  await noHScroll(p, w, `finish panel ${w} ${scheme}`);
  await p.screenshot({ path: `${SP}/coach-finish-${w}-${scheme}.png`, fullPage: true });
  if (w === 1440 && scheme === 'dark') { await p.click('.coach-row[data-id=L1] [data-act=split]'); await p.waitForSelector('#splitForm'); await p.screenshot({ path: `${SP}/coach-split-1440-dark.png` }); }
  await p.close();
}

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
