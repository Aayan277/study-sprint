import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
// Record what would be read aloud.
await ctx.addInitScript(() => {
  window.__said = [];
  if (window.speechSynthesis) window.speechSynthesis.speak = u => window.__said.push([u.text, u.lang]);
});
const p = await ctx.newPage();
p.on('pageerror', e => errors.push(e.stack));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
const said = () => p.evaluate(() => window.__said);

// ---- read aloud ----
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('#editDeck');
await p.click('#editDeck'); await p.waitForSelector('#deckTts');
await p.selectOption('#deckTts', 'en-GB'); await p.check('#deckTtsAuto');
await p.click('button[type=submit][form=deckForm]'); await p.waitForTimeout(300);
const deck = await p.evaluate(async () => (await import('./js/db.js')).getDeck('sample'));
ok(deck.ttsLang === 'en-GB' && deck.ttsAuto === true, 'deck saves its read-aloud language and auto-read');
await p.goto('http://localhost:8123/#/review'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('#speakBtn');
await p.waitForTimeout(200);
let s = await said();
const front = await p.textContent('.flash-front');
ok(s.length === 1 && s[0][0] === front && s[0][1] === 'en-GB', 'auto-read says the front in the deck\'s language: ' + JSON.stringify(s));
await p.keyboard.press(' '); await p.waitForSelector('.rate'); await p.waitForTimeout(200);
s = await said();
ok(s.length === 2 && s[1][0] === (await p.textContent('.flash-back')).trim(), 'and the back when flipped');
await p.click('#speakBtn'); await p.keyboard.press('r');
ok((await said()).length === 4, '🔊 and R read it again');
await p.click('#endBtn');

// ---- duplicates, tags, find and replace ----
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const cs = await db.getCardsInDeck('sample');
  const byFront = f => cs.find(c => c.front === f);
  await db.saveCards([{ ...byFront('Placebo effect'), tags: ['exam1', 'research'] }, { ...byFront('Neuroplasticity'), tags: ['exam1'] }, { ...byFront('Working memory'), tags: ['memory', 'Exam 1'.toLowerCase()] }]);
  await db.saveCards([{ id: 'dupe', deckId: 'sample', front: 'placebo  EFFECT!', back: 'duplicate', tags: [], created: Date.now() }]);
});
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('.crow');
await p.selectOption('#brFilter', 'dupes'); await p.waitForFunction(() => document.querySelectorAll('.crow').length === 2);
ok((await p.$$eval('.crow .f', f => f.map(x => x.textContent))).join('|') === 'Placebo effect|placebo  EFFECT!', 'Duplicates filter finds the same front written differently');
await p.selectOption('#brFilter', 'all');
await p.click('#brTags'); await p.waitForSelector('.tag-list');
ok((await p.$$eval('.tag-name', t => t.map(x => x.textContent))).join('|') === 'exam1|exam 1|memory|research', 'Tags lists every tag, most used first');
await p.screenshot({ path: SP + '/A-tags.png' });
await p.click('.tag-list li[data-tag="exam1"] [data-tag-rename]'); await p.fill('#tagNew', 'Exam 1'); await p.click('#tagForm [type=submit]');
await p.waitForFunction(() => /Renamed/.test(document.querySelector('#toast')?.textContent || ''));
let tags = await p.evaluate(async () => (await (await import('./js/db.js')).getCardsInDeck('sample')).flatMap(c => c.tags));
ok(!tags.includes('exam1') && tags.filter(t => t === 'exam 1').length === 3, 'renaming merges into an existing tag');
await p.click('#brTags'); await p.waitForSelector('.tag-list');
await p.click('.tag-list li[data-tag="memory"] [data-tag-remove]'); await p.click('#cfYes');
await p.waitForFunction(() => /Removed/.test(document.querySelector('#toast')?.textContent || ''));
tags = await p.evaluate(async () => (await (await import('./js/db.js')).getCardsInDeck('sample')).flatMap(c => c.tags));
ok(!tags.includes('memory'), 'remove a tag everywhere');
// find and replace on selected cards
await p.click('#brSelect'); await p.click('#brAll'); await p.click('#brActions'); await p.waitForSelector('#frBox');
await p.click('#frBox summary'); await p.fill('#frFind', 'behavior'); await p.fill('#frWith', 'behaviour');
await p.waitForFunction(() => /Changes \d+ cards?/.test(document.querySelector('#frCount')?.textContent || ''));
const willChange = await p.textContent('#frCount');
await p.screenshot({ path: SP + '/A-replace.png', fullPage: true });
await p.click('#frGo'); await p.waitForFunction(() => /Replaced in/.test(document.querySelector('#toast')?.textContent || ''));
const texts = await p.evaluate(async () => (await (await import('./js/db.js')).getCardsInDeck('sample')).map(c => c.front + ' ' + c.back).join(' '));
ok(!/behavior/i.test(texts.replace(/behaviour/gi, '')) && /behaviour/.test(texts), `find and replace: ${willChange}`);

// ---- more stats ----
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const cs = await db.getCardsInDeck('sample'); const D = 86400000, now = Date.now();
  const logs = [];
  for (let i = 0; i < 60; i++) logs.push({ cardId: cs[i % cs.length].id, timestamp: now - (i % 20) * D - (i % 7) * 3600000, source: 'review', rating: [3, 3, 3, 1, 4, 2][i % 6], correct: i % 6 !== 3, state: i % 4 ? 2 : 1, ms: 3000 });
  await db.putMany('reviewLog', logs);
  await db.putStates(cs.slice(0, 8).map((c, i) => ({ cardId: c.id, due: now + D, stability: 5, difficulty: 1 + i, reps: 3, lapses: 0, state: 2 })));
});
await p.goto('http://localhost:8123/#/stats'); await p.waitForSelector('#btnTitle', { state: 'attached' }); if (await p.isHidden('#btnTitle')) await p.click('#moreBtn');   // phones fold "More stats"
ok((await p.$$('.btn-bar span')).length >= 4 && /\d+% right/.test(await p.textContent('.btn-row')), 'answer buttons shown');
ok(await p.$('#hours') !== null && await p.$('#difficulty') !== null, 'time of day and difficulty charts shown');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
await p.locator('#btnTitle').scrollIntoViewIfNeeded();
await p.screenshot({ path: SP + '/A-stats.png', fullPage: true });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
