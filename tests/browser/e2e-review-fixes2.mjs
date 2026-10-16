// v4.2.1 review fixes, in the browser (the pure parts are in tests/*.test.js).
//   item 2  a merged setting is stamped after the server's time even when another device's clock is ahead
//   item 9  the answer is not shown twice: Review has one corrected line, Play has no bold answer next to the diff
//   item 10 the week dots are a list with a sentence per day; the legend is not hidden; #streakBtn says ", details"
//   nits    maxlength 500, the exam chip is not aria-pressed, kana marks and symbols in Browse and typed answers
// Screenshots (Review, item 9) at 375 and 1440 in dark and light go to SP.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const WED = new Date(2026, 9, 14, 12);
const open = async (w, h, { touch = false, at = null } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
  if (at) await ctx.clock.setFixedTime(at);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !m.text().includes('Could not save answer')) errors.push('console ' + m.text()); });
  p.ctx = ctx;
  return p;
};
const skin = (p, mode) => p.evaluate(m => {
  const r = document.documentElement;
  if (m === 'light') r.setAttribute('data-theme', 'light'); else r.removeAttribute('data-theme');
}, mode);
const noHScroll = async (p, w) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const text = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();

// ============================ item 2: a merged setting beats a server clock that is ahead ============================
{
  const p = await open(1000, 700);
  await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
  const r = await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const ahead = Date.now() + 3 * 3600000;                       // another device's clock is 3 hours ahead
    const dayIn = n => { const t = new Date(Date.now() + n * 86400000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
    const TIMES = (await import('./js/sync-data.js')).SETTING_TIMES;
    const key = 'restDays', k2 = dayIn(5), k3 = dayIn(6);
    // the server holds restDays stamped in the future (by that clock) and lacks a day this device has, so the union goes back
    await db.setSetting('restDays', { [k2]: { on: true, at: Date.now() - 1000 } });
    await db.applyRemote([{ store: 'settings', id: 'restDays', data: { value: { [k3]: { on: true, at: Date.now() - 500 } } }, deleted: false, updated_at: ahead, seq: 1 }]);
    const times = (await db.getSettings())[TIMES];
    // and a normal local save of a merged setting, with a stored time that is ahead
    await db.setSetting('restDays', { [k2]: { on: true, at: Date.now() } });
    const times2 = (await db.getSettings())[TIMES];
    return { ahead, stamped: times?.restDays, stamped2: times2?.restDays, key };
  });
  ok(r.stamped > r.ahead, 'applyRemote stamps a merged setting after the server time: ' + (r.stamped - r.ahead) + ' ms later');
  ok(r.stamped2 > r.stamped, 'setSetting stamps a merged setting after the time already stored: +' + (r.stamped2 - r.stamped));
  await p.ctx.close();
}

// ============================ item 10, nits: streak sheet and button ============================
{
  const p = await open(375, 740, { touch: true, at: WED });
  await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const { daysAgoStart } = await import('./js/stats-calc.js');
    const now = Date.now(), D = 86400000;
    const cards = [0, 1, 2].map(i => ({ id: 'c' + i, deckId: 'bio', front: 'Q' + i, back: 'A' + i, tags: [], created: i }));
    await db.addDeckWithCards({ id: 'bio', name: 'Cell Biology', color: '#46A758', created: now + 1 }, cards);
    await db.putMany('cardStates', cards.map(c => ({ cardId: c.id, due: now - D, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D, scheduledDays: 3, elapsedDays: 3, learningSteps: 0 })));
    await db.putMany('reviewLog', [2, 3, 4, 5, 6].map(d => ({ cardId: 'c0', timestamp: daysAgoStart(d, now) + 12 * 3600000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true })));
    const exam = daysAgoStart(-30, now);
    await db.saveDeck({ ...(await db.getDecks()).find(x => x.id === 'bio'), examDate: new Date(exam).toISOString().slice(0, 10) });
  });
  await p.reload(); await p.waitForSelector('#streakBtn');
  ok((await text(p, '#streakBtn .sr-only')) === ', details', '#streakBtn has an sr-only ", details"');
  await p.click('#streakBtn'); await p.waitForSelector('#sheet[open] .ys .week');
  ok(await p.getAttribute('#sheet .week', 'role') === 'list' && await p.locator('#sheet .week [role=listitem]').count() === 7, 'the week is a list of 7 items');
  const frz = await text(p, '#sheet .wd.frz .sr-only');
  ok(/^Tue 13 Oct: streak freeze used$/.test(frz), 'the covered day says it in text: ' + frz);
  ok(/^Wed 14 Oct: not studied yet$/.test(await text(p, '#sheet .wd.today .sr-only')), 'today says "not studied yet"');
  ok(await p.locator('#sheet .wd.on .sr-only').first().textContent().then(t => /: studied$/.test(t)), 'a studied day says "studied"');
  ok(await p.locator('#sheet .wd i[aria-hidden=true]').count() === 7, 'the squares are hidden from screen readers');
  ok(await p.locator('#sheet .ys-key[aria-hidden]').count() === 0 && (await text(p, '#sheet .ys-key')).includes('Streak freeze'), 'the legend is not aria-hidden');
  ok(await p.locator('#sheet .ys-exams [aria-pressed]').count() === 0 && await p.locator('#sheet .ys-exams button').count() === 1, 'the exam chip has no aria-pressed');
  await p.click('.ys-exams button'); await p.waitForSelector('.ys-list li');
  ok(await p.locator('#sheet .ys-exams button').count() === 0 && (await text(p, '#sheet .ys-exams .tchip')).startsWith('Day off planned'), 'once added, the chip is a "Day off planned" label: ' + await text(p, '#sheet .ys-exams .tchip'));
  await p.ctx.close();
}

// ============================ item 9: Review shows the answer once ============================
const seedReview = p => p.evaluate(async () => {
  const db = await import('./js/db.js');
  const card = (id, front, back, i) => ({ id, deckId: 'rv', front, back, tags: [], created: i });
  await db.addDeckWithCards({ id: 'rv', name: 'One line', color: '#E5484D', created: Date.now() },
    [['Powerhouse', 'mitochondria'], ['Colour', 'red / scarlet'], ['Far', 'photosynthesis'], ['Kana', 'がっこう'], ['Brain', '🧠']].map(([f, b], i) => card('rv' + i, f, b, i)));
  await db.setSetting('reviewTyping', true);
});
const typedCases = { Powerhouse: 'mitocondrix', Colour: 'scarlett', Far: 'xqzvbnm', Kana: 'かっこう', Brain: '🧠' };
for (const [w, h, touch] of [[375, 740, true], [1440, 900, false]]) {
  const p = await open(w, h, { touch });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await seedReview(p);
  await p.evaluate(() => { location.hash = '#/review/rv'; });
  await p.waitForSelector('#typeIn');
  ok(await p.getAttribute('#typeIn', 'maxlength') === '500', `Review: the answer box has maxlength 500 (${w})`);
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    await p.waitForSelector('#typeIn');
    const front = (await text(p, '.flash-front')).trim();
    seen.add(front);
    await p.fill('#typeIn', typedCases[front]); await p.keyboard.press('Enter'); await p.waitForSelector('.rv-typed .typed');
    const box = await text(p, '.rv-typed');
    if (front === 'Powerhouse') {
      ok(await p.locator('.rv-typed .adiff-row').count() === 1 && await p.locator('.rv-typed .adiff .one, .rv-typed .adiff.one').count() === 1, `Review: one corrected line, no answer row (${w})`);
      ok(await p.locator('.rv-typed ins.d-miss').count() === 1 && await p.locator('.rv-typed mark.d-wrong').count() === 1 && await p.locator('.rv-typed .d-caret').count() === 0, 'Review: wrong letter marked, missing letter inserted inline, no caret');
      ok(!(await text(p, '.rv-typed .sr-only')).includes('The answer is') && !box.includes('Closest answer'), 'Review: no "The answer is", no "Closest answer" for a single answer');
      await noHScroll(p, `review one line ${w}`);
      await p.waitForTimeout(500);
      for (const m of ['dark', 'light']) { await skin(p, m); await p.screenshot({ path: `${SP}/qw-review-oneline-${m}-${w}.png` }); }
      await skin(p, 'dark');
    }
    if (front === 'Colour') {
      ok(await p.locator('.rv-typed .adiff-row').count() === 2 && box.includes('Closest answer') && (await text(p, '.rv-typed .adiff-row:nth-child(2) .adiff-txt')) === 'scarlet',
        `Review: an alternate adds a "Closest answer" row (${w})`);
      ok(await p.locator('.rv-typed del.d-extra').count() === 1, 'Review: the extra letter is struck through');
      await noHScroll(p, `review closest ${w}`);
      await p.waitForTimeout(500);
      for (const m of ['dark', 'light']) { await skin(p, m); await p.screenshot({ path: `${SP}/qw-review-closest-${m}-${w}.png` }); }
      await skin(p, 'dark');
    }
    if (front === 'Far') {
      ok(box.includes('Not quite. You typed xqzvbnm') && await p.locator('.rv-typed .adiff').count() === 0, `Review: too different is "Not quite. You typed X" with no diff box (${w})`);
      await p.waitForTimeout(500);
      for (const m of ['dark', 'light']) { await skin(p, m); await p.screenshot({ path: `${SP}/qw-review-toofar-${m}-${w}.png` }); }
      await skin(p, 'dark');
    }
    if (front === 'Kana') ok(box.includes('Not quite'), 'Review: か for がっこう-style marks is wrong (が is not か)');
    if (front === 'Brain') ok(box.includes('Correct') && !box.includes('typo'), 'Review: a symbol-only answer (🧠) can be typed correctly');
    await p.waitForSelector('.rate.r3'); await p.click('.rate.r3'); await p.waitForTimeout(150);
  }
  ok(seen.size === 5, `Review: all five cards seen (${w})`);
  await p.ctx.close();
}

// ============================ item 9 (Play) and Browse symbols ============================
{
  const p = await open(375, 740, { touch: true });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const card = (id, front, back, i) => ({ id, deckId: 'pl', front, back, tags: [], created: i });
    await db.addDeckWithCards({ id: 'pl', name: 'Symbols', color: '#3E63DD', created: Date.now() },
      [['C++ intro', 'language'], ['C# intro', 'language'], ['Plain C', 'language'], ['Brain 🧠', 'thinking'], ['Surprise', 'Really?! yes'], ['P-hello', 'hello']].map(([f, b], i) => card('pl' + i, f, b, i)));
  });
  await p.evaluate(() => { location.hash = '#/browse'; });
  await p.waitForSelector('.crow');
  const count = async q => { await p.fill('#brQuery', q); await p.waitForTimeout(400); return p.locator('.crow').count(); };
  ok(await count('c++') === 1, 'Browse: "c++" finds only the C++ card');
  ok(await count('🧠') === 1, 'Browse: "🧠" finds one card, not all of them');
  ok(await count('?!') === 1, 'Browse: "?!" finds one card, not all of them');
  ok(await count('+') === 1, 'Browse: "+" finds the C++ card only');
  await p.ctx.close();
}
{
  const p = await open(375, 740, { touch: true });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'pl', name: 'Diff play', color: '#3E63DD', created: Date.now() },
      [['P-hello', 'hello'], ['P-hello2', 'hello'], ['P-hello3', 'hello']].map(([f, b], i) => ({ id: 'pl' + i, deckId: 'pl', front: f, back: b, tags: [], created: i })));
  });
  await p.click('.tab[data-tab=play]'); await p.waitForSelector('#pDeck');
  await p.selectOption('#pDeck', 'pl');
  for (const s of ['input[name=fmt][value=classic]', 'input[name=len][value="10"]']) await p.$eval(s, el => el.click());
  await p.click('#startBtn'); await p.waitForSelector('#pInput');
  ok(await p.getAttribute('#pInput', 'maxlength') === '500', 'Play: the answer box has maxlength 500');
  await p.fill('#pInput', 'hallx'); await p.keyboard.press('Enter'); await p.waitForSelector('.fb.no');
  ok(await p.locator('#feedback mark.d-wrong').count() >= 1 && await p.locator('#feedback .fb-info').count() === 0 && await p.locator('#feedback b').count() === 0, 'Play: with a diff there is no separate bold answer');
  ok((await text(p, '#feedback .adiff')).includes('Answer') && (await text(p, '#feedback .adiff')).includes('hello'), 'Play: the diff still has its Answer row');
  await p.ctx.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
