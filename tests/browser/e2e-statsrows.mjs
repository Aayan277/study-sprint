// Stats: cards that share a grid row are the same height (within 1px) at 1440 and 1024 wide, with every section shown,
// for all decks and for one course (readiness header + Mastery side by side). Also the two stat tiles on a phone.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

// Groups every card by where its top edge is, and returns the rows that hold two or more cards.
const rowsOf = page => page.evaluate(() => {
  const cards = [...document.querySelectorAll('main[data-route="stats"] .view .card')].filter(c => c.offsetParent && !c.parentElement.closest('.card'));
  const rows = new Map();
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    const key = Math.round(r.top + scrollY);
    const hit = [...rows.keys()].find(k => Math.abs(k - key) <= 1) ?? key;
    rows.set(hit, [...(rows.get(hit) || []), { name: (c.querySelector('h2')?.textContent || c.className).trim(), h: r.height }]);
  }
  return [...rows.values()].filter(r => r.length > 1);
});

for (const [w, h] of [[1440, 900], [1024, 768], [375, 812]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const DAY = 86400000, now = Date.now();
    const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
    const st = (c, state, stability, dueIn, lapses) => ({ cardId: c.id, due: now + dueIn * DAY, stability, difficulty: 5, elapsedDays: 1, scheduledDays: 1, learningSteps: 0, reps: 4, lapses, state, lastReview: now - DAY });
    await db.putMany('cardStates', [st(cs[0], 2, 40, 12, 0), st(cs[1], 2, 30, 3, 1), st(cs[2], 2, 8, 1, 4), st(cs[3], 2, 5, 0, 2)]);
    const logs = [];
    for (let d = 0; d < 20; d++) for (let i = 0; i < 4; i++) logs.push({ cardId: cs[(d + i) % 4].id, timestamp: now - d * DAY - i * 60000, source: 'review', mode: 'flip', correct: i % 3 !== 0, ms: 4000, rating: 3, state: 2, applied: true, reason: 'due' });
    await db.putMany('reviewLog', logs);
    await db.addDeckWithCards({ id: 'chem', name: 'Chemistry', color: '#46A758', created: now + 1, examDate: new Date(now + 20 * DAY).toISOString().slice(0, 10) },
      ['Atom', 'Ion', 'Isotope'].map((f, i) => ({ id: 'chem' + i, deckId: 'chem', front: f, back: f + ' definition', tags: [], created: i })));
  });
  for (const course of [false, true]) {
    await page.goto('http://localhost:8123/#/decks'); await page.reload(); await page.waitForSelector('.deck');
    await page.click('.tab[data-tab=stats]'); await page.waitForSelector('.chart');
    if (course) { await page.click('#sDeckBtn'); await page.click('.pick-row[data-id="chem"]'); await page.waitForSelector('.ready-card'); }
    if (w < 1024 && await page.isVisible('#moreBtn') && await page.getAttribute('#moreBtn', 'aria-expanded') === 'false') await page.click('#moreBtn');
    const rows = await rowsOf(page);
    const bad = rows.filter(r => Math.max(...r.map(c => c.h)) - Math.min(...r.map(c => c.h)) > 1);
    const where = `${w}px, ${course ? 'one course' : 'all decks'}`;
    ok(rows.length >= 1, `${where}: found ${rows.length} rows with 2 cards`);
    ok(!bad.length, `${where}: cards in a row are equal height` + (bad.length ? ' ' + JSON.stringify(bad) : ''));
  }
  await ctx.close();
}
await browser.close();
