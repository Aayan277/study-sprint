// Round 2 bug fixes owned by decks.js / exam-sheet.js / the deck page CSS (docs/design/round2-plan.md section 7):
//   #1  double-click "Create deck" makes one deck
//   #6  saving the exam sheet twice does not throw (a pageerror came from two concurrent renderDeck calls)
//   #9  (decks side) a deck with no cards shows "+ Add cards", not a green tick
//   #10 a long unbroken parent-deck name does not overflow the deck page at 1440
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
await ctx.clock.setFixedTime(new Date(2026, 9, 14, 12));
const p = await ctx.newPage();
p.on('pageerror', e => errors.push(e.stack));
const go = async (hash, sel) => { await p.goto('about:blank'); await p.goto('http://localhost:8123/' + hash); await p.waitForSelector(sel); };
const decksNamed = name => p.evaluate(async n => (await (await import('./js/db.js')).getDecks()).filter(d => d.name === n).length, name);

// ---- #1 double-click Create deck ----
await go('#/decks', '#newDeck');
await p.click('#newDeck'); await p.waitForSelector('#deckName');
await p.fill('#deckName', 'Twice');
await p.dblclick('button[type=submit][form=deckForm]');
await p.waitForTimeout(400);
ok(await decksNamed('Twice') === 1, '#1 double-clicking Create deck makes one deck, got ' + await decksNamed('Twice'));
// two submits in the same tick (a fast double tap, or Enter held down)
await p.click('#newDeck'); await p.waitForSelector('#deckName');
await p.fill('#deckName', 'Thrice');
await p.evaluate(() => { const f = document.getElementById('deckForm'); f.requestSubmit(); f.requestSubmit(); });
await p.waitForTimeout(400);
ok(await decksNamed('Thrice') === 1, '#1 two submits in one tick make one deck, got ' + await decksNamed('Thrice'));
// a failed check lets the person try again (the guard is not left on)
await p.click('#newDeck'); await p.waitForSelector('#deckName');
await p.evaluate(() => document.getElementById('deckForm').requestSubmit());
ok(await p.isVisible('#deckErr'), '#1 an empty name shows the error');
await p.fill('#deckName', 'Fourth'); await p.click('button[type=submit][form=deckForm]');
await p.waitForTimeout(300);
ok(await decksNamed('Fourth') === 1, '#1 after an error the form can still be saved');

// ---- #6 exam sheet saved twice ----
await go('#/deck/sample', '#addExam');
const before = errors.length;
await p.click('#addExam'); await p.waitForSelector('#xdForm');
// count how many times the deck page is drawn: a second submit used to draw it twice, at the same moment
await p.evaluate(() => {
  window.__draws = 0;
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('.screen-head') || n.querySelector?.('.screen-head'))) window.__draws++; }).observe(document.querySelector('main'), { childList: true, subtree: true });
  const f = document.getElementById('xdForm'); f.requestSubmit(); f.requestSubmit();
});
await p.waitForTimeout(500);
ok(await p.evaluate(() => window.__draws) === 1, '#6 the deck page is drawn once after a double save, got ' + await p.evaluate(() => window.__draws));
ok(errors.length === before, '#6 saving the exam sheet twice throws nothing: ' + errors.slice(before).join(' | ').slice(0, 200));
ok((await p.textContent('.exam-line')).includes('Exam in 14 days'), '#6 the exam is set once');

// ---- #9 (decks side) empty deck ----
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.saveDeck({ id: 'empty1', name: 'Nothing here', course: '', color: '#3E63DD', parentId: '', created: Date.now() }); });
await go('#/decks', '.deck');
const tile = p.locator('.deck', { hasText: 'Nothing here' });
ok(await tile.locator('a.deck-go.add[href="#/import/empty1"]').count() === 1, '#9 an empty deck offers + Add cards');
ok(await tile.locator('.deck-go.done').count() === 0, '#9 and shows no green tick');
ok(await tile.locator('a.deck-go.add', { hasText: '+ Add cards' }).count() === 1, '#9 the button says + Add cards');

// ---- #10 long parent name at 1440 ----
const long = 'Supercalifragilisticexpialidocious'.repeat(3) + 'Parent';
await p.evaluate(async n => {
  const db = await import('./js/db.js');
  await db.saveDeck({ id: 'longp', name: n, course: '', color: '#E5484D', parentId: '', created: Date.now() });
  await db.saveDeck({ id: 'longk', name: 'Child', course: '', color: '#E5484D', parentId: 'longp', created: Date.now() + 1 });
  await db.saveCards([{ id: 'lk1', deckId: 'longk', front: 'Q', back: 'A', created: Date.now() }]);
}, long);
await p.setViewportSize({ width: 1440, height: 900 });
await go('#/deck/longk', '.crumbs');
await p.waitForSelector('.crow');
await p.click('.crow');                                 // the card editor docks on the right
await p.waitForSelector('body.has-side');
const m = await p.evaluate(() => {
  const side = document.getElementById('sheet').getBoundingClientRect(), c = document.querySelector('.crumbs').getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect();
  return { crumbR: c.right, sideX: side.left, mainR: main.right, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
});
ok(m.crumbR <= m.sideX + 0.5, `#10 the breadcrumb stays left of the docked editor (${Math.round(m.crumbR)} <= ${Math.round(m.sideX)})`);
ok(m.sw <= m.cw, '#10 no sideways scroll at 1440');
await p.screenshot({ path: SP + '/bug10-longname-1440.png' });
await p.keyboard.press('Escape');
await go('#/deck/longp', 'h1');
const h = await p.evaluate(() => ({ r: document.querySelector('h1').getBoundingClientRect().right, mr: document.querySelector('main').getBoundingClientRect().right }));
ok(h.r <= h.mr, '#10 a long deck title also wraps inside the page');
ok(errors.length === 0, 'no page errors: ' + errors.join(' | ').slice(0, 300));
await browser.close();
