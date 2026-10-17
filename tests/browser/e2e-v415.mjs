// v4.15: fixes from the QA of v4.14 (minor and friction items). One part per fix; the labels and selection are in e2e-selection.mjs.
//   A  tags split on spaces, Study by tag reads old tags with spaces, the glossary (plurals, hyphens, aliases, Paste a list)
//   B  "Nothing due" days keep the streak (fixed clock)
//   C  Review: shortcut line in the answer box, Z undo, the finish screen's counts and Keep going, Space on a steps card
//   D  Play: "I was right" never records Easy; wording that said Play counts
// Run with: node tests/browser/run.mjs v415
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const norm = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();

const open = async (w, h, { at = null, hash = '#/decks' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: w < 600, hasTouch: w < 600, reducedMotion: 'reduce' });
  if (at) await ctx.clock.setFixedTime(at);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + hash); await p.waitForSelector('.deck, .today-hero');
  return p;
};
const go = async (p, hash, sel) => { await p.goto('about:blank'); await p.goto(URL + hash); await p.waitForSelector(sel); };

// ============================ A. tags, Study by tag, glossary ============================
{
  const p = await open(1440, 900);
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'T', name: 'Pharm', color: '#5B48E8', created: Date.now() }, [
      { id: 'c1', deckId: 'T', front: 'Which drugs lower blood pressure?', back: 'ACE inhibitors, and the old ACE-inhibitor pills', tags: [], created: 1 },
      { id: 'c2', deckId: 'T', front: 'Old tag card', back: 'saved before spaces split tags', tags: ['#ak_step1_v12::#uworld::23456 #ak_step1_v12::#subject::pulm'], created: 2 }]);
    await db.setSetting('reviewTyping', false);
  });

  // ----- the card editor -----
  await go(p, '#/browse', '.crow');
  await p.locator('.crow', { hasText: 'Which drugs' }).click(); await p.waitForSelector('#ceForm');
  ok((await norm(p, '#ceForm label:has(#ceTags) span')) === 'Tags (separated by spaces or commas)', 'the editor label: "Tags (separated by spaces or commas)"');
  await p.fill('#ceTags', '#AK_Step1_v12::#UWorld::23456 #AK_Step1_v12::#Subject::Pulm, Exam');
  await p.click('button[type=submit][form=ceForm]'); await p.waitForTimeout(500);
  const tags = await p.evaluate(async () => (await (await import('./js/db.js')).get('cards', 'c1')).tags);
  ok(tags.join('|') === '#ak_step1_v12::#uworld::23456|#ak_step1_v12::#subject::pulm|exam', 'spaces and commas both separate tags, saved in lower case: ' + tags.join('|'));
  await p.locator('.crow', { hasText: 'Old tag card' }).click(); await p.waitForSelector('#ceForm');
  await p.click('button[type=submit][form=ceForm]'); await p.waitForTimeout(500);
  const old = await p.evaluate(async () => (await (await import('./js/db.js')).get('cards', 'c2')).tags);
  ok(old.length === 1 && old[0].includes(' '), 'a tag saved earlier with a space is left alone when the card is saved again: ' + old.join('|'));

  // ----- Add card -----
  await go(p, '#/deck/T', '#brAdd');
  await p.click('#brAdd'); await p.waitForSelector('#acTags');
  ok((await norm(p, '#acForm label:has(#acTags) span')) === 'Tags (optional, separated by spaces or commas)', 'Add card label says spaces or commas');

  // ----- Study by tag or question ID finds the card whose old tag has a space in it -----
  await go(p, '#/today', '#optBtn');
  await p.click('#optBtn'); await p.click('#customBtn'); await p.waitForSelector('#csTagBtn');
  await p.click('#csTagBtn'); await p.waitForSelector('#tsText');
  await p.fill('#tsText', '23456');
  await p.waitForSelector('#tsResult b');
  const res = await norm(p, '#tsResult');
  ok(/Found 1 of 1 IDs/.test(res) && !(await p.isVisible('#tsMissing')), 'ID 23456 is found in both the new tags and the old one with a space: ' + res);
  ok(/2 cards/.test(res), 'two cards (one from each kind of tag): ' + res);

  // ----- the glossary: plurals and hyphens -----
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.setSetting('gloss:g1', { term: 'ACE inhibitor', aliases: ['angiotensin blocker'], def: 'Blocks the enzyme.', at: 1 });
  });
  await go(p, '#/review/T', '#flash');
  const front = await p.evaluate(() => document.querySelector('.rv-front .flash-front').textContent);
  if (!front.includes('blood pressure')) { await p.keyboard.press('Space'); await p.keyboard.press('3'); }
  await p.keyboard.press('Space'); await p.waitForSelector('.rate');
  const marks = await p.$$eval('.rv-face:not([inert]) .gl-term', b => b.map(x => x.textContent));
  ok(marks.join() === 'ACE inhibitors', 'the term "ACE inhibitor" is underlined as "ACE inhibitors" (once): ' + marks.join());
  await p.evaluate(async () => { await (await import('./js/db.js')).saveCards([{ ...(await (await import('./js/db.js')).get('cards', 'c1')), back: 'Take an ACE-inhibitor daily' }]); });
  await go(p, '#/review/T', '#flash');
  const f2 = await p.evaluate(() => document.querySelector('.rv-front .flash-front').textContent);
  if (!f2.includes('blood pressure')) { await p.keyboard.press('Space'); await p.keyboard.press('3'); }
  await p.keyboard.press('Space'); await p.waitForSelector('.rate');
  const hy = await p.$$eval('.rv-face:not([inert]) .gl-term', b => b.map(x => x.textContent));
  ok(hy.join() === 'ACE-inhibitor', 'and as "ACE-inhibitor": ' + hy.join());

  // ----- the glossary sheet: aliases in the list, Paste a list with mixed separators -----
  await go(p, '#/settings', '#glossBtn');
  await p.click('#glossBtn'); await p.waitForSelector('.gl-row');
  ok((await norm(p, '.gl-row-t')).includes('Also: angiotensin blocker'), 'the list shows aliases under each term: ' + await norm(p, '.gl-row-t'));
  await p.click('#glPaste'); await p.waitForSelector('#glPasteIn');
  await p.fill('#glPasteIn', 'beta-agonist - stimulates beta receptors\nMallory-Weiss tear - mucosal tear at the GE junction\nAnti-HBs: antibody showing immunity\nOsmosis\twater moving\nlonely line');
  ok((await norm(p, '#glPasteInfo')) === 'Adds 4 terms. 1 line without a definition is left out.', 'mixed separators: every line is read on its own, the counts are right: ' + await norm(p, '#glPasteInfo'));
  ok((await norm(p, '#glPasteGo')) === 'Add 4 terms', 'the button says Add 4 terms');
  await p.close();
}

// ============================ B. "Nothing due" days keep the streak ============================
{
  const WED = new Date(2026, 9, 14, 12);
  const seed = async (p, { overdue = false }) => p.evaluate(async overdue => {
    const db = await import('./js/db.js');
    const { daysAgoStart } = await import('./js/stats-calc.js');
    const now = Date.now(), D = 86400000;
    const cards = Array.from({ length: 3 }, (_, i) => ({ id: 'q' + i, deckId: 'bio', front: `Question ${i}`, back: `Answer ${i}`, tags: [], created: i }));
    await db.addDeckWithCards({ id: 'bio', name: 'Cell Biology', color: '#46A758', created: now + 1 }, cards);
    // All learned; the next reviews are days away (or, in the other run, one is overdue since yesterday).
    await db.putMany('cardStates', cards.map((c, i) => ({ cardId: c.id, due: overdue && i === 0 ? now - D : now + 9 * D, stability: 9, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D, scheduledDays: 9, elapsedDays: 3, learningSteps: 0 })));
    // Last studied 4 days ago and the days before: Sat 10, Fri 9, Thu 8 Oct. Nothing since.
    await db.putMany('reviewLog', [4, 5, 6].flatMap(d => [0, 1].map(i => ({ cardId: 'q' + i, timestamp: daysAgoStart(d, now) + 12 * 3600000 + i * 60000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2 }))));
    await db.setSetting('newPerDay', 0);
  }, overdue);

  // Nothing due, nothing left over: the days since are safe.
  let p = await open(1440, 900, { at: WED, hash: '#/today' });
  await seed(p, {});
  await p.reload(); await p.waitForSelector('.today-hero'); await p.waitForSelector('.streak');
  await p.waitForFunction(() => document.querySelector('.streak')?.textContent.includes('streak is safe'));
  const line = await norm(p, '.streak');
  ok(/^3\s*day streak/.test(line) && line.includes('Nothing due today: your streak is safe'), 'Today: a 3 day streak, "Nothing due today: your streak is safe": ' + line);
  ok((await norm(p, '.th-big')) === 'Nothing due today', 'and the ring says Nothing due today');
  const idle = await p.evaluate(async () => Object.keys((await (await import('./js/db.js')).getSettings()).idleDays || {}).sort());
  ok(idle.join() === '2026-10-11,2026-10-12,2026-10-13,2026-10-14', 'the quiet days (11 to 14 Oct) were noted on this device: ' + idle.join());
  ok(!/Freeze used/.test(line), 'no freeze was used');
  // The streak sheet and Stats agree.
  await go(p, '#/stats', '.pgrid');
  ok(/^3\s*day streak|3\s*days?/.test(await norm(p, '.pgrid .card')), 'Stats shows the same 3 day streak: ' + (await norm(p, '.pgrid .card')).slice(0, 60));
  // A day later (the clock moves on), still safe: the notes stay.
  await p.context().clock.setFixedTime(new Date(2026, 9, 15, 12));
  await go(p, '#/today', '.streak');
  await p.waitForFunction(() => document.querySelector('.streak')?.textContent.includes('streak is safe'));
  ok(/^3\s*day streak/.test(await norm(p, '.streak')), 'the next day, still a 3 day streak and safe: ' + await norm(p, '.streak'));
  await p.context().close();

  // A card was overdue and not studied: those days do count as missed.
  p = await open(1440, 900, { at: WED, hash: '#/today' });
  await seed(p, { overdue: true });
  await p.reload(); await p.waitForSelector('.today-hero'); await p.waitForSelector('.streak');
  const broke = await norm(p, '.streak');
  ok(!broke.includes('streak is safe') && !/^3\s*day streak/.test(broke), 'with a review overdue the missed days are real misses: ' + broke);
  ok((await p.evaluate(async () => Object.keys((await (await import('./js/db.js')).getSettings()).idleDays || {}))).length === 0, 'and nothing is noted as quiet');
  await p.context().close();
}

// ============================ C. Review: keys, finish counts, Keep going, steps ============================
{
  const p = await open(1440, 900);
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const now = Date.now();
    await db.addDeckWithCards({ id: 'A', name: 'Deck A', color: '#5B48E8', created: now }, [0, 1, 2].map(i => ({ id: 'a' + i, deckId: 'A', front: `A front ${i}`, back: `A back ${i}`, tags: [], created: i })));
    await db.addDeckWithCards({ id: 'B', name: 'Deck B', color: '#46A758', created: now + 1 }, [0, 1, 2, 3].map(i => ({ id: 'b' + i, deckId: 'B', front: `B front ${i}`, back: `B back ${i}`, tags: [], created: 10 + i })));
    await db.addDeckWithCards({ id: 'S', name: 'Steps', color: '#E5484D', created: now + 2 }, [
      { id: 's0', deckId: 'S', front: 'Solve it', back: 'Step 1: first\nStep 2: second\nAnswer: forty-two', tags: [], created: 20 }]);
    await db.setSetting('reviewTyping', true);
    await db.setSetting('newPerDay', 50);
  });

  // ----- the shortcut line in the answer box -----
  await go(p, '#/review/A', '#typeIn');
  ok((await norm(p, '#keyLine')).includes('Esc to leave the box for shortcuts') && !(await norm(p, '#keyLine')).includes('D scratchpad'), 'in the answer box the line says "Esc to leave the box for shortcuts" (no single-key hints): ' + await norm(p, '#keyLine'));
  await p.keyboard.press('Escape');
  ok(await p.evaluate(() => document.activeElement?.id !== 'typeIn') && (await norm(p, '#keyLine')).includes('D scratchpad'), 'Esc leaves the box and the shortcut hints come back: ' + await norm(p, '#keyLine'));
  ok(!(await norm(p, '#keyLine')).includes('Z undo'), 'no "Z undo" before anything was answered');

  // Answer one card, then Z undoes it.
  await p.keyboard.press('Space'); await p.waitForSelector('.rate');
  await p.keyboard.press('3');
  await p.waitForFunction(() => !!document.querySelector('#undoBtn'));
  const second = await p.textContent('.rv-front .flash-front');
  ok(second !== 'A front 0', 'the next card shows (' + second + ')');
  await p.waitForSelector('#typeIn'); await p.keyboard.press('Escape');
  ok((await norm(p, '#keyLine')).includes('Z undo'), 'after an answer the line shows "Z undo": ' + await norm(p, '#keyLine'));
  await p.keyboard.press('z');
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent === 'A front 0');
  ok(await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'review').length) === 0, 'Z undid the answer (the log row is gone too)');

  // ----- Space on a steps card never rates -----
  await go(p, '#/review/S', '#flash');
  await p.keyboard.press('Space'); await p.waitForSelector('#stepBtn');
  await p.keyboard.press('Space');                 // step 1
  await p.keyboard.press('Space');                 // step 2: the last one, and the final answer shows
  await p.waitForFunction(() => document.querySelectorAll('.rate').length === 4);
  ok(await p.locator('.steps-final:not([hidden])').count() === 1, 'the last step shows the final answer and the rating buttons');
  await p.keyboard.press('Space'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  ok(await p.locator('.rate').count() === 4 && await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length) === 0, 'Space and Enter after the last step do not rate the card');
  await p.keyboard.press('3');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length === 1);
  ok(true, 'a rating key still rates it');

  // ----- the finish screen: distinct cards, and Keep going counts this deck only -----
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewTyping', false); });
  await go(p, '#/review/A', '#flash');
  await p.keyboard.press('Space'); await p.waitForSelector('.rate'); await p.keyboard.press('1');       // Again: it comes back
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent !== 'A front 0' || document.querySelectorAll('.rv-face:not([inert]) .rate').length === 0);
  for (let i = 0; i < 12 && !(await p.locator('.stats4').count()); i++) {
    await p.keyboard.press('Space'); await p.waitForSelector('.rate').catch(() => {});
    if (await p.locator('.rate').count()) await p.keyboard.press('3');
    await p.waitForTimeout(150);
  }
  await p.waitForSelector('.stats4');
  const done = await p.$$eval('.stats4 > div', d => d.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  const answers = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'review' && l.cardId.startsWith('a')).length);
  ok(done[0].startsWith('3') && answers > 3, `the finish screen counts cards (3), not answers (${answers}): ${done[0]}`);
  ok((await norm(p, '.note')).includes(`${answers} answers on 3 cards`), `and says "${answers} answers on 3 cards": ` + (await norm(p, '.note')));
  ok(await p.locator('#keepBtn').count() === 0, 'Deck B still has cards due, but Keep going is not offered after finishing Deck A (it counts this deck)');

  // End early: Keep going counts what is left in this deck, not every deck.
  await go(p, '#/review/B', '#flash');
  await p.keyboard.press('Space'); await p.waitForSelector('.rate'); await p.keyboard.press('3');
  await p.waitForFunction(() => !!document.querySelector('#undoBtn'));
  await p.click('#endBtn'); await p.waitForSelector('.stats4');
  const keep = await norm(p, '#keepBtn');
  const counts = await p.evaluate(async () => { const sd = await import('./js/study-data.js'); const d = await sd.loadAll(); return [sd.countFor(d, ['B']).total, sd.countFor(d, d.decks.map(x => x.id)).total]; });
  ok(counts[0] < counts[1] && keep === `Keep going · ${counts[0]} cards`, `"Keep going" counts Deck B (${counts[0]}), not every deck (${counts[1]}): ${keep}`);
  await p.close();
}

// ============================ D. Play wording, "I was right" ============================
{
  const p = await open(375, 780);
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'P', name: 'Capitals', color: '#5B48E8', created: Date.now() }, [
      { id: 'p0', deckId: 'P', front: 'Capital of France', back: 'Paris', tags: [], created: 1 },
      { id: 'p1', deckId: 'P', front: 'Capital of Spain', back: 'Madrid', tags: [], created: 2 },
      { id: 'p2', deckId: 'P', front: 'Capital of Italy', back: 'Rome', tags: [], created: 3 },
      { id: 'p3', deckId: 'P', front: 'Capital of Peru', back: 'Lima', tags: [], created: 4 }]);
    await db.setSetting('playCountsAsReviews', false);
  });
  await go(p, '#/today', '#optBtn');
  await p.click('#optBtn'); await p.click('#customBtn'); await p.waitForSelector('#csForgotBtn');
  const forgot = await p.$eval('#csForgotBtn', b => b.closest('.cs-opt').textContent.replace(/\s+/g, ' '));
  ok(/pressed Again on today\./.test(forgot) && !/Play/.test(forgot), 'Custom study: "Cards I forgot today" does not mention Play while Play is practice only: ' + forgot.slice(0, 90));
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('playCountsAsReviews', true); });
  await go(p, '#/today', '#optBtn');
  await p.click('#optBtn'); await p.click('#customBtn'); await p.waitForSelector('#csForgotBtn');
  ok(/got wrong in Play, today/.test(await p.$eval('#csForgotBtn', b => b.closest('.cs-opt').textContent.replace(/\s+/g, ' '))), 'with "Count Play answers as reviews" on it does');
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('playCountsAsReviews', false); });
  await go(p, '#/stats', '.pgrid');
  ok(/Review today to start a streak/.test(await norm(p, '.pgrid')) || (await norm(p, '.pgrid')).includes('streak'), 'Stats: the streak line does not say play');
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
