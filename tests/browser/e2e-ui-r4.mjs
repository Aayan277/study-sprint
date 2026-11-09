// Round 4 (v4.62): one accent per screen, compact phone Decks, status dots, amber only inside 14 days, the snowflake only when a freeze was used,
// the finish screen ("<1 min" and Today's streak chip), one streak on a computer, one left edge, no helper text, and no 6px jump when a card flips on a phone.
// The clock is fixed at noon on Wed 14 Oct 2026 so the week and the freeze are the same on every run.
// Run with: node tests/browser/run.mjs ui-r4
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const WED = new Date(2026, 9, 14, 12);
const PC = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

const open = async (viewport, touch) => {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', colorScheme: 'dark', isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
  await ctx.clock.setFixedTime(WED);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
  return p;
};
// Courses (one exam in 9 days, one in 23, one with none), cards due now, a review history and the days studied (days back from today).
async function seed(p, studied) {
  await p.evaluate(async studied => {
    const db = await import('./js/db.js');
    const { daysAgoStart } = await import('./js/stats-calc.js');
    await db.deleteDeck('sample');
    const D = 86400000, now = Date.now();
    const iso = d => { const x = new Date(now + d * D); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const mk = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `${id} question ${i}`, back: `${id} answer ${i}`, tags: [], created: i }));
    const decks = [[{ id: 'bio', name: 'Cell Biology', course: 'BIOL 201', color: '#46A758', created: now + 1, examDate: iso(9) }, mk('bio', 12)],
      [{ id: 'neuro', name: 'Neuroscience', course: 'PSYC 240', color: '#8E4EC6', created: now + 2, examDate: iso(23) }, mk('neuro', 8)],
      [{ id: 'econ', name: 'Microeconomics', course: 'ECON 101', color: '#3E63DD', created: now + 3 }, mk('econ', 8)]];
    for (const [d, c] of decks) await db.addDeckWithCards(d, c);
    const cs = await db.getAll('cards');
    await db.putMany('cardStates', cs.map((c, i) => ({ cardId: c.id, due: now - D, stability: 4, difficulty: 5, elapsedDays: 3, scheduledDays: 3, learningSteps: 0, reps: 3, lapses: 0, state: 2, lastReview: now - 4 * D })));
    // answers on the studied days, and a month of due reviews (most remembered) for Stats
    const logs = [];
    for (const d of studied) for (let i = 0; i < 4; i++) logs.push({ cardId: cs[i].id, timestamp: daysAgoStart(d, now) + 12 * 3600000 + i * 60000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2, applied: true, reason: 'due' });
    for (let d = 7; d < 30; d++) for (let i = 0; i < 3; i++) logs.push({ cardId: cs[(d + i) % cs.length].id, timestamp: daysAgoStart(d, now) + 10 * 3600000 + i * 60000, source: 'review', mode: 'flip', correct: (d + i) % 5 !== 0, ms: 3000, rating: (d + i) % 5 !== 0 ? 3 : 1, state: 2, applied: true, reason: 'due' });
    await db.putMany('reviewLog', logs);
  }, studied);
  await p.reload(); await p.waitForSelector('.tdeck');
}
const go = async (p, hash, sel) => { await p.goto(URL + hash); await p.waitForSelector(sel); await p.waitForTimeout(250); };
const norm = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
const noHScroll = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + what);
const primaries = p => p.locator('main .btn.primary:visible').count();

for (const [label, viewport, touch] of [['PC 1440x900', PC, false], ['phone 390x844', PHONE, true]]) {
  console.log('--- ' + label);
  const p = await open(viewport, touch);
  await seed(p, [2, 3, 4, 5, 6]);      // Tuesday is covered by this week's freeze: "freeze used"
  const phone = touch;

  // ---------- one filled button on Today, the deck page and Browse ----------
  ok(await primaries(p) === 1 && await p.locator('#startBtn.btn.primary:visible').count() === 1, label + ': Today has one filled button (Start)');
  await noHScroll(p, label + ' Today');
  await go(p, '#/deck/bio', '#reviewBtn');
  ok(await primaries(p) === 1 && await p.locator('#reviewBtn.btn.primary').count() === 1, label + ': the deck page has one filled button (Review); "+ Add card" is ghost: ' + await p.getAttribute('#brAdd', 'class'));
  ok((await p.getAttribute('#brAdd', 'class')).includes('ghost'), label + ': + Add card on the deck page is a ghost button');
  await noHScroll(p, label + ' deck page');
  await go(p, '#/browse', '#brAdd');
  ok(await primaries(p) === 1 && (await p.getAttribute('#brAdd', 'class')).includes('primary'), label + ': Browse has one filled button (+ Add card)');
  ok(await p.locator('.br-head h2').count() === 0, label + ': Browse does not repeat its title as a second "Cards" heading');
  await noHScroll(p, label + ' Browse');
  // the status is a word with a dot, not a filled chip
  const st = await p.$eval('.crow .st', e => { const c = getComputedStyle(e), b = getComputedStyle(e, '::before'); return { text: e.textContent.trim(), bg: c.backgroundColor, dot: b.width, shadow: c.boxShadow }; });
  ok(st.text.length > 0 && st.bg === 'rgba(0, 0, 0, 0)' && st.dot === '6px' && st.shadow === 'none', label + ': a card status is its word with a 6px dot (' + JSON.stringify(st) + ')');

  // ---------- Decks: compact rows on a phone, amber only inside 14 days ----------
  await go(p, '#/decks', '.deck');
  const near = await p.$$eval('.deck', ds => ds.map(d => { const b = d.querySelector('.exam-badge'); return b ? { name: d.querySelector('.deck-name').textContent.trim(), text: b.textContent.trim(), near: b.classList.contains('near'), color: getComputedStyle(b).color } : null; }).filter(Boolean));
  const bio = near.find(x => x.name === 'Cell Biology'), neuro = near.find(x => x.name === 'Neuroscience');
  ok(bio && bio.near && /9 days/.test(bio.text), label + ': Decks: the exam in 9 days is amber (.near): ' + JSON.stringify(bio));
  ok(neuro && !neuro.near && /23 days/.test(neuro.text), label + ': Decks: the exam in 23 days is not amber: ' + JSON.stringify(neuro));
  ok(bio && neuro && bio.color !== neuro.color, label + ': the amber and the plain exam text really differ in colour');
  ok(await primaries(p) === 1, label + ': Decks has one filled button (+ New deck); the play circles are quiet');
  if (phone) {
    const rows = await p.$$eval('.decks.compact .deck', ds => ds.map(d => Math.round(d.getBoundingClientRect().height)));
    ok(rows.length === 3 && rows.every(h => h <= 130), label + ': Decks rows are 130px or less: ' + rows.join(', '));
    const taps = await p.$$eval('.decks.compact .deck', ds => ds.map(d => [...d.querySelectorAll('.deck-go, .icon-btn, .deck-open')].map(e => { const r = e.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); })));
    ok(taps.every(r => r.length === 3 && r.every(s => s >= 44)), label + ': every Decks tap target (open, menu, play) is 44px or more: ' + JSON.stringify(taps));
  }
  await noHScroll(p, label + ' Decks');
  await go(p, '#/deck/bio', '#reviewBtn');
  ok(await p.$eval('.exam-line .exam-badge', e => e.classList.contains('near')), label + ': the deck page marks 9 days as amber');
  await go(p, '#/deck/neuro', '#reviewBtn');
  ok(await p.$eval('.exam-line .exam-badge', e => !e.classList.contains('near')), label + ': the deck page does not mark 23 days as amber');

  // ---------- the snowflake only when a freeze was used ----------
  await go(p, '#/today', '#startBtn');
  ok(await p.locator('.today-hero .streak .frz-pill.used svg').count() === 1, label + ': a freeze was used: Today shows the snowflake');
  const sheetWords = await norm(p, '.today-hero .streak');
  ok(/Freeze used/.test(sheetWords), label + ': and a screen reader still hears which day: ' + sheetWords);

  // ---------- Stats: the Retention caption stays; the streak caption goes ----------
  await go(p, '#/stats', '.pgrid');
  const ret = await norm(p, '.pc-ret');
  ok(await p.locator('.pc-ret p:visible').count() === 1 && /You remembered \d+ of \d+ due reviews? in the last 30 days\./.test(ret), label + ': the Retention caption is still visible: ' + ret);
  ok(!/Any deck counts|You studied today/.test(await norm(p, '.pc-streak')), label + ': the streak card has no "You studied today. Any deck counts." caption');
  await noHScroll(p, label + ' Stats');

  // ---------- the finish screen ----------
  await go(p, '#/today', '#startBtn');
  await p.click('#startBtn'); await p.waitForSelector('#flash');
  if (phone) await p.tap('#showBtn'); else await p.keyboard.press('Space');
  await p.waitForSelector('.rate'); await p.click('.rate.r3');
  await p.waitForSelector('#endBtn'); await p.click('#endBtn'); await p.waitForSelector('.finish-next .streak');
  const time = (await p.locator('.stats4 > div', { hasText: 'Time spent' }).locator('.v').textContent()).trim();
  ok(time === '<1 min', label + ': finish: a short session says "<1 min", not 0:00 ("' + time + '")');
  const chip = await p.$eval('.finish-next .streak', e => ({ cls: e.className, pill: e.querySelectorAll('.frz-pill').length, text: e.textContent.replace(/\s+/g, ' ').trim() }));
  ok(chip.cls.includes('streak-chip') && /^\d+\s*day streak/.test(chip.text), label + ': finish: the same one-line streak chip as Today: ' + chip.text);
  ok(await p.$eval('.finish-next .streak', e => { const r = e.getBoundingClientRect(); return r.height <= 48 && getComputedStyle(e).borderTopWidth === '1px'; }), label + ': finish: the chip is one outlined line');
  ok(await p.locator('.finish-next .streak .frz-pill.used').count() === 1, label + ': finish: the snowflake shows because a freeze was used');
  ok(await p.$eval('.fin-links .link', e => getComputedStyle(e).textDecorationLine === 'none'), label + ': finish: the links are not underlined');
  if (!phone) ok(await p.locator('.today-hero, .streak, .side-streak').evaluateAll(es => es.filter(e => e.offsetParent !== null).length) === 1, label + ': finish on a computer: one streak (the sidebar copy is hidden)');
  await noHScroll(p, label + ' finish');
  await p.close();
}

// ---------- a freeze that is only ready shows no snowflake (a week with every day studied up to yesterday) ----------
{
  const p = await open(PHONE, true);
  await seed(p, [1, 2, 3, 4]);
  await p.reload(); await p.waitForSelector('#startBtn');
  ok(await p.locator('.today-hero .streak').count() === 1 && await p.locator('.today-hero .streak .frz-pill').count() === 0 && await p.locator('.today-hero .streak svg.ico').count() === 2, 'a freeze that is only ready: no snowflake on Today (flame and chevron only)');
  ok(/freeze ready/i.test(await norm(p, '.today-hero .streak')), 'and the "freeze ready" words are still there for a screen reader: ' + await norm(p, '.today-hero .streak'));
  await p.close();
}

// ---------- one streak on a computer (Today) ----------
{
  const p = await open(PC, false);
  await seed(p, [2, 3, 4, 5, 6]);
  const n = await p.locator('.streak, .side-streak').evaluateAll(es => es.filter(e => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden').length);
  ok(n === 1, 'PC Today: exactly one streak is visible (the hero chip), not two: ' + n);
  await go(p, '#/decks', '.deck');
  ok(await p.locator('#sideStreak').isVisible(), 'on a screen with no streak of its own, the sidebar still shows it');

  // ---------- the left edges of every screen agree ----------
  const lefts = {};
  const left = async (name, hash, sel) => { await go(p, hash, sel); lefts[name] = await p.$eval('main > .view', e => Math.round(e.getBoundingClientRect().left)); };
  await left('today', '#/today', '#startBtn'); await left('decks', '#/decks', '.deck'); await left('stats', '#/stats', '.pgrid');
  await left('play', '#/play', '#startBtn'); await left('settings', '#/settings', '#setNav'); await left('import', '#/import', '#screen .view *');
  await left('browse', '#/browse', '.crow'); await left('deck', '#/deck/bio', '#reviewBtn');
  await go(p, '#/today', '#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash'); await p.keyboard.press('Space'); await p.waitForSelector('.rate'); await p.click('.rate.r3');
  await p.click('#endBtn'); await p.waitForSelector('.finish-next'); lefts.finish = await p.$eval('main > .view', e => Math.round(e.getBoundingClientRect().left));
  const xs = Object.values(lefts);
  ok(Math.max(...xs) - Math.min(...xs) <= 2, 'PC 1440: every screen starts at the same left edge: ' + JSON.stringify(lefts));
  // a narrower window, where the 760px screens used to float to the middle
  await p.setViewportSize({ width: 1180, height: 800 });
  const l2 = {};
  for (const [name, hash, sel] of [['today', '#/today', '#startBtn'], ['play', '#/play', '#startBtn'], ['settings', '#/settings', '#setNav'], ['deck', '#/deck/bio', '#reviewBtn']]) { await go(p, hash, sel); l2[name] = await p.$eval('main > .view', e => Math.round(e.getBoundingClientRect().left)); }
  ok(Math.max(...Object.values(l2)) - Math.min(...Object.values(l2)) <= 2, 'PC 1180: the same left edge: ' + JSON.stringify(l2));
  // the focused review stays centred (a reading surface)
  await go(p, '#/today', '#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#flash');
  const mid = await p.$eval('main > .view', e => { const r = e.getBoundingClientRect(); return Math.abs((r.left + r.right) / 2 - (240 + innerWidth) / 2) <= 130; });
  ok(mid, 'the focused review is still centred in the page');
  await p.close();
}

// ---------- Play: Start round comes last ----------
{
  const p = await open(PHONE, true);
  await seed(p, [2, 3, 4, 5, 6]);
  await go(p, '#/play', '#startBtn');
  ok(await p.evaluate(() => { const b = document.getElementById('startBtn'), all = [...document.querySelectorAll('main fieldset, main .fold-toggle')]; return all.every(e => e.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'Play: Start round sits after Format and Customise');
  await noHScroll(p, 'Play at 390');
  await p.close();
}

// ---------- the card does not jump on a phone when it flips ----------
{
  const p = await open(PHONE, true);
  await seed(p, [2, 3, 4, 5, 6]);
  await p.click('#startBtn'); await p.waitForSelector('#showBtn');
  const probe = () => p.evaluate(() => ({ sy: Math.round(scrollY), sh: document.scrollingElement.scrollHeight, ih: innerHeight, q: Math.round(document.querySelector('.flash-front').getBoundingClientRect().top), bar: Math.round(document.querySelector('.ratebar').getBoundingClientRect().height) }));
  const front = await probe();
  await p.tap('#showBtn'); await p.waitForSelector('.rate'); await p.waitForTimeout(500);
  const back = await probe();
  ok(Math.abs(front.q - back.q) <= 1, 'phone: the question top moves 1px or less on flip (' + front.q + ' to ' + back.q + ')');
  ok(front.sy === 0 && back.sy === 0 && front.sh <= front.ih && back.sh <= back.ih, 'phone: the page does not scroll on either side (scrollY ' + front.sy + '/' + back.sy + ', height ' + front.sh + '/' + back.sh + ' of ' + back.ih + ')');
  await noHScroll(p, 'the study screen at 390');
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
