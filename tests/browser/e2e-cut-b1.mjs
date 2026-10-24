// Study flow after the copy cut: Compare keeps a card's line breaks, a leftover toast is hidden when Study starts,
// the first focus in Review is the Show answer button, and the Review counts have words for screen readers.
// Run with: node tests/browser/run.mjs cut-b1
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, serviceWorkers: 'block' });
const p = await ctx.newPage();
p.on('pageerror', e => errors.push('pageerror ' + e.message));
p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
await p.goto(URL + '#/decks'); await p.waitForSelector('.deck, .empty');
await p.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.saveDeck({ id: 'cb', name: 'Cut B1', color: '#8b5cf6', parentId: '', created: Date.now() });
  await db.saveCards([
    { id: 'c1', deckId: 'cb', front: 'First line\nSecond line', back: 'Answer one\nAnswer two', tags: [], created: 1 },
    { id: 'c2', deckId: 'cb', front: 'Other', back: 'Thing', tags: [], created: 2 }]);
});

// Compare: a multi-line card keeps its lines apart (not run together on one line).
await p.evaluate(async () => {
  const db = await import('./js/db.js'), cmp = await import('./js/compare-sheet.js');
  cmp.openCompare(await db.get('cards', 'c1'), await db.get('cards', 'c2'));
});
await p.waitForSelector('#sheet .cmp');
const lines = await p.$eval('#sheet .cmp-col .cmp-text', e => ({ html: e.innerHTML, h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) || 20 }));
ok(/First line/.test(lines.html) && /Second line/.test(lines.html) && (/<br|<p|<div/.test(lines.html) || lines.h > lines.lh * 1.7), 'Compare: the two lines of a card are on separate lines: ' + lines.html.slice(0, 80));
ok(await p.locator('#sheet .cmp-note').count() === 0, 'Compare: no "Side by side" sentence when the pair was never mixed up');
await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#sheet[open]'));

// A toast left from the screen before is gone when Study starts.
await p.goto(URL + '#/today'); await p.waitForSelector('#startBtn');
await p.evaluate(async () => (await import('./js/ui.js')).toast('Added 2 cards'));
ok(await p.evaluate(() => !document.getElementById('toast').hidden), 'the "Added" toast is showing on Today');
await p.click('#startBtn'); await p.waitForSelector('#flash');
ok(await p.evaluate(() => document.getElementById('toast').hidden), 'Study started: the toast is hidden');
// ...but a toast raised during the round stays.
await p.evaluate(async () => (await import('./js/ui.js')).toast('During the round'));
await p.evaluate(async () => (await import('./js/ui.js')).setFocusMode(true));
ok(await p.evaluate(() => !document.getElementById('toast').hidden), 'a toast shown during the round is not hidden by a redraw');

// Review: first focus is the Show answer button, which is described by the question; the counts have words.
ok(await p.evaluate(() => document.activeElement?.id === 'showBtn' && document.getElementById('showBtn').getAttribute('aria-describedby') === 'rvQ'), 'Review: first focus is #showBtn, described by the question');
const counts = (await p.locator('.rv-counts').ariaSnapshot()).replace(/\s+/g, ' ');
ok(/New \d+ Learn \d+ Due \d+/.test(counts) && !/\b(New|Learn|Due) \1\b/.test(counts), 'Review: the counts read "New n Learn n Due n" once each for screen readers: ' + counts);
ok(await p.locator('.flash-hint, #longNote').count() === 0, 'Review: no hint line or flip note under the card');
await p.keyboard.press('Space'); await p.waitForSelector('#flash.flipped');
ok(await p.evaluate(() => document.activeElement?.classList.contains('rv-back')), 'Review: after Space the answer has focus');

// A typing card: Esc from the card menu puts focus back in the answer box (Space there types, it does not answer "I don't know").
await p.evaluate(async () => { const db = await import('./js/db.js'); await db.saveCards((await db.getAll('cards')).map(c => ({ ...c, typeIn: true }))); });      // (both cards ask for a typed answer)
const q = await ctx.newPage(); await q.goto(URL + '#/today'); await q.waitForSelector('#startBtn'); await q.click('#startBtn'); await q.waitForSelector('#typeIn');
await q.click('#moreBtn'); await q.waitForSelector('#sheet[open]'); await q.keyboard.press('Escape');
await q.waitForFunction(() => !document.querySelector('#sheet[open]'));
await q.waitForFunction(() => document.activeElement?.id === 'typeIn', null, { timeout: 2000 }).catch(() => {});      // (focus moves on the dialog's close event)
ok(await q.evaluate(() => document.activeElement?.id === 'typeIn'), 'typing card: after the card menu closes, focus is in the answer box');

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
