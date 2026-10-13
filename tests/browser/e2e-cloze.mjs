// Cloze cards in a real browser: saving notes, siblings in Review and Today, the editor, Play, export and import,
// and the "Link cloze cards" tool. Run with: node tests/browser/run.mjs cloze
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');

// ---- 1. saving a note in the database ----
const T = 'The {{c1::mitochondria}} makes {{c2::ATP}} for the {{c3::cell}}';
let r = await page.evaluate(async T => {
  const db = await import('./js/db.js'), cz = await import('./js/cloze.js');
  const deck = (await db.getDecks())[0];
  const noteId = db.newId();
  const siblings = async () => (await db.getAll('cards')).filter(c => c.noteId === noteId).sort((a, b) => a.cloze - b.cloze);
  await db.saveNote(cz.planNoteSave([], T), { deckId: deck.id, noteId, tags: ['bio'] });
  let sibs = await siblings();
  const first = sibs.map(c => ({ cloze: c.cloze, front: c.front, back: c.back, tags: c.tags, at: c.updatedAt }));
  // give c2 and c3 a schedule and a history row, then edit the text: keep c1 and c2, drop c3, add c4
  for (const c of [sibs[1], sibs[2]]) {
    await db.saveReview({ cardId: c.id, due: Date.now() + 864e5, stability: 3, difficulty: 5, reps: 1, lapses: 0, state: 2 },
      { cardId: c.id, timestamp: Date.now(), source: 'review', correct: true, rating: 3, ms: 1, state: 0 });
  }
  const c2 = sibs[1].id, c3 = sibs[2].id;
  const T2 = 'The {{c1::mitochondria}} makes {{c2::ATP}} in the {{c4::cell}}';
  await db.saveNote(cz.planNoteSave(sibs, T2), { deckId: deck.id, noteId, tags: ['bio'], noteExtra: 'Powerhouse' });
  sibs = await siblings();
  const logs = await db.getAll('reviewLog');
  return { first, nums: sibs.map(c => c.cloze), same: new Set(sibs.map(c => c.updatedAt)).size, extra: sibs.map(c => c.noteExtra),
    c2Kept: sibs[1].id === c2 && !!(await db.get('cardStates', c2)) && logs.some(l => l.cardId === c2),
    c3Gone: !(await db.get('cards', c3)) && !(await db.get('cardStates', c3)) && !logs.some(l => l.cardId === c3),
    tombstone: (await db.getAll('deleted')).some(d => d.store === 'cards' && d.id === c3) };
}, T);
ok(r.first.length === 3 && r.first[0].front === 'The […] makes ATP for the cell' && r.first[0].back === 'mitochondria' && r.first.every(c => c.tags[0] === 'bio'), 'saveNote makes one card per blank, with front and back');
ok(new Set(r.first.map(c => c.at)).size === 1, 'all siblings share one save time');
ok(r.nums.join() === '1,2,4' && r.same === 1 && r.extra.every(e => e === 'Powerhouse'), 'edit: c3 gone, c4 added, extra on every card');
ok(r.c2Kept, 'edit: c2 keeps its card, schedule and history');
ok(r.c3Gone && r.tombstone, 'edit: the removed blank deletes its card, schedule and history, leaving a deleted marker');

ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
await browser.close();
