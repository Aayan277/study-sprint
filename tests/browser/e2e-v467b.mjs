// Release 4.67 WP-B: the Flagged filter, the Decks search that also finds cards, and "Save a copy first" in the delete-deck confirm.
import { chromium } from './pw.mjs';
import fs from 'node:fs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const open = async (w, h, ui) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', acceptDownloads: true });
  if (ui) await ctx.addInitScript(() => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui: 'clinical', skin: 'ocean', mode: 'light' })); localStorage.setItem('study-sprint-rail', '0'); } catch { /* fine */ } });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.stack)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('body');
  return { ctx, p };
};
const seed = (p, extra = 0) => p.evaluate(async extra => {
  const db = await import('./js/db.js'); const now = Date.now();
  const mk = (deckId, n, pre) => Array.from({ length: n }, (_, i) => ({ id: `${deckId}${i}`, deckId, front: `${pre} front ${i}`, back: `${pre} back ${i}`, tags: [], created: i }));
  const a = mk('A', 3, 'alpha'); a[0].front = 'mitochondria powerhouse';
  await db.addDeckWithCards({ id: 'A', name: 'Cell Biology', color: '#46A758', created: now + 1 }, a);
  await db.addDeckWithCards({ id: 'A1', name: 'Unit 1', parentId: 'A', color: '#46A758', created: now + 2 }, mk('A1', 2, 'sub'));
  await db.addDeckWithCards({ id: 'B', name: 'Law', color: '#E5484D', created: now + 3 }, mk('B', 2, 'law'));
  if (extra) await db.addDeckWithCards({ id: 'BIG', name: 'Big', color: '#3E63DD', created: now + 4 }, Array.from({ length: extra }, (_, i) => ({ id: 'g' + i, deckId: 'BIG', front: `filler ${i} text`, back: `more words ${i}`, tags: [], created: i })));
}, extra);
const names = p => p.$$eval('#deckGrid .deck .deck-name', e => e.map(x => x.textContent));
const reload = async p => { await p.reload(); await p.waitForSelector('#deckGrid .deck'); };

// ---- Flagged filter ----
{
  const { ctx, p } = await open(390, 844); await seed(p); await reload(p);
  await p.evaluate(async () => { const db = await import('./js/db.js'); const a = await db.get('cards', 'A0'), b = await db.get('cards', 'A1'); await db.saveCards([{ ...a, flag: 1 }, { ...b, flag: 4 }]); });
  await p.goto('http://localhost:8123/#/browse'); await p.waitForSelector('.crow');
  const o = await p.$eval('#brFilter option[value=flagged]', e => ({ t: e.textContent, g: e.parentElement.label }));
  ok(o.t === 'Flagged' && o.g === 'Flags', 'filter option reads "Flagged" in the Flags group');
  await p.selectOption('#brFilter', 'flagged'); await p.waitForTimeout(300);
  ok((await p.$$('.crow')).length === 2, 'Flagged shows exactly the 2 flagged cards');
  await ctx.close();
}

// ---- Decks search finds cards ----
{
  const { ctx, p } = await open(390, 844); await seed(p); await reload(p);
  await p.fill('#deckSearch', 'm'); await p.waitForTimeout(500);
  ok(await p.getAttribute('#deckGrid', 'data-searched') === 'm' && await p.$eval('#cardHits', e => e.hidden), 'one letter does not run the card search');
  await p.fill('#deckSearch', 'mitochon'); await p.waitForSelector('#deckGrid[data-searched="mitochon"]');
  ok((await names(p)).join() === 'Cell Biology', 'card text finds its deck: ' + (await names(p)).join());
  ok((await p.textContent('#deckGrid .deck-counts .hit')).trim() === '1 matching', 'tile says "1 matching"');
  ok((await p.textContent('#showHits')).trim() === 'Show 1 matching card', 'link reads "Show 1 matching card"');
  await p.fill('#deckSearch', 'mitochondrìa'); await p.waitForSelector('#deckGrid[data-searched="mitochondrìa"]');
  ok((await names(p)).join() === 'Cell Biology', 'accented search matches too');
  // typing fast keeps the last query
  await p.fill('#deckSearch', 'sub front'); await p.fill('#deckSearch', 'law front');
  await p.waitForSelector('#deckGrid[data-searched="law front"]'); await p.waitForTimeout(400);
  ok((await names(p)).join() === 'Law' && await p.getAttribute('#deckGrid', 'data-searched') === 'law front', 'typing fast keeps only the last query');
  await p.fill('#deckSearch', 'qqqq'); await p.waitForSelector('#deckNone:not([hidden])');
  ok((await p.textContent('#deckNone')).includes('No decks or cards match'), 'no match says so');
  await p.fill('#deckSearch', 'mitochon'); await p.waitForSelector('#showHits');
  await p.click('#showHits'); await p.waitForSelector('.crow');
  ok(p.url().endsWith('#/browse') && await p.inputValue('#brQuery') === 'mitochon' && (await p.$$('.crow')).length === 1, 'link opens Browse with the search and 1 card');
  await ctx.close();
}

// ---- Performance with 20k cards ----
{
  const { ctx, p } = await open(1440, 900); await seed(p, 20000); await reload(p);
  await p.waitForTimeout(3000);
  const ms = await p.evaluate(async () => {
    const bl = await import('./js/browse-logic.js'); const db = await import('./js/db.js');
    const cards = await db.getAll('cards'); const m = bl.cardMatcher('mitochon'); const t0 = performance.now(); let n = 0;
    for (const c of cards) if (m(c)) n++;           // (cold fold included: the worst case)
    return performance.now() - t0;
  });
  ok(ms < 150, `card pass over 20k cards took ${ms.toFixed(0)}ms (< 150)`);
  await ctx.close();
}

// ---- Save a copy first ----
for (const ui of [false, true]) {
  const T = ui ? 'Clinical' : 'Original';
  const { ctx, p } = await open(ui ? 1440 : 390, ui ? 900 : 844, ui); await seed(p); await reload(p);
  await p.click('[data-edit="A"]'); await p.click('#deckDelete'); await p.waitForSelector('#delCopy');
  ok(await p.isVisible('#delCopy'), `${T}: "Save a copy first" is visible`);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#delCopy')]);
  const txt = fs.readFileSync(await dl.path(), 'utf8');
  ok(dl.suggestedFilename() === 'Cell Biology.csv', `${T}: file is ${dl.suggestedFilename()}`);
  ok(txt.includes('mitochondria powerhouse') && txt.includes('sub front 0'), `${T}: the copy has the deck's and its subdeck's cards`);
  ok((await p.textContent('#delCopy')).trim() === 'Copy saved' && await p.isDisabled('#delCopy'), `${T}: button says "Copy saved"`);
  ok(await p.evaluate(async () => !!(await (await import('./js/db.js')).get('decks', 'A'))), `${T}: the deck still exists`);
  const ord = await p.$$eval('.sheet-actions .btn', b => b.map(x => { const r = x.getBoundingClientRect(); return [x.id, Math.round(r.y) * 10000 + r.x]; }));
  ok(ord.map(x => x[0]).join() === 'delNo,delKeep,delYes' && ord.every((x, i) => !i || x[1] > ord[i - 1][1]), `${T}: action buttons keep their order: ${ord.map(x => x[0]).join()}`);
  await p.click('#delYes'); await p.waitForFunction(() => !document.querySelector('[data-open="A"]'));
  ok(await p.evaluate(async () => !(await (await import('./js/db.js')).get('decks', 'A'))), `${T}: Delete still deletes`);
  await ctx.close();
}

ok(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors[0] : ''));
await browser.close();
