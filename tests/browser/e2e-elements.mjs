// Round 3, item 4: elements cards (the card editor's "Answer: Text | Steps | Elements", Review recalling one element at a time with
// Got it / Missed toggles and a suggested rating, Play asking for the whole list).
// Run with: node tests/browser/run.mjs elements
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

const open = async (w, h, scheme) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async scheme => {
    const db = await import('./js/db.js');
    await db.addDeckWithCards({ id: 'T', name: 'Law', color: '#5B48E8', created: Date.now() }, [
      { id: 'tort', deckId: 'T', front: 'Negligence', back: 'Element 1: Duty\nElement 2: Breach\nElement 3: Causation\nElement 4: Damages', tags: [], created: 1 },
      { id: 'three', deckId: 'T', front: 'Contract', back: 'A valid contract needs:\nElement 1: Offer\nElement 2: Acceptance\nElement 3: Consideration', tags: [], created: 2 },
      { id: 'chem', deckId: 'T', front: 'Water', back: 'Elements: H, O', tags: [], created: 3 }]);
    await db.setSetting('reviewTyping', true);
    await db.setSetting('theme', (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: scheme }));
  }, scheme);
  return p;
};
const sideways = (p, w, tag) => w > 800 || p.evaluate(() => document.documentElement.scrollWidth <= innerWidth).then(v => ok(v, `${tag}: no sideways scroll`));
const addBtn = 'button[type=submit][form=acForm]';
const shown = p => p.$$eval('#steps > li:not([hidden])', l => l.length);
const stored = (p, front) => p.evaluate(async front => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === front), front);
const readLogs = p => p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'review').sort((a, b) => a.timestamp - b.timestamp).map(l => l.rating));

for (const [w, h, scheme] of [[375, 780, 'dark'], [1440, 900, 'light']]) {
  const tag = `${w} ${scheme}`;
  const p = await open(w, h, scheme);

  // ---------- the editor ----------
  await p.goto('about:blank'); await p.goto(URL + '#/deck/T'); await p.waitForSelector('#brAdd');
  await p.click('#brAdd'); await p.waitForSelector('#acFront');
  ok(await p.locator('#acModeElements').count() === 1 && /Elements/.test(await p.textContent('.answer-mode')), `${tag}: the editor offers Elements`);
  await p.fill('#acFront', 'Battery');
  await p.click('.answer-mode .chip:has(#acModeElements)');
  ok(await p.locator('#acSteps').isVisible() && await p.locator('#acBackWrap').isHidden(), `${tag}: Elements shows element rows instead of Back`);
  ok(/Rule or intro \(optional\)/.test(await p.textContent('#acSteps')) && await p.locator('#acFinal').isHidden(), `${tag}: "Rule or intro (optional)", and no final answer`);
  ok(/\+ Add element/.test(await p.textContent('#acSteps')), `${tag}: "+ Add element"`);
  ok(/at least two elements, or choose Text/.test(await p.textContent('#acWhy')), `${tag}: Add explains (${(await p.textContent('#acWhy')).trim()})`);
  const ta = i => p.locator('#acStepList textarea').nth(i);
  await ta(0).fill('Harmful contact');
  await ta(1).fill('Intent');
  ok(await p.getAttribute(addBtn, 'aria-disabled') === 'false', `${tag}: two elements are enough`);
  await ta(1).fill('Intent\nElement 3: sneaky');
  ok(await p.getAttribute(addBtn, 'aria-disabled') === 'true' && /can't start with 'Element N:'/.test(await p.textContent('#acWhy')), `${tag}: "Element N:" inside an element is refused (${(await p.textContent('#acWhy')).trim()})`);
  await ta(1).fill('Intent');
  await p.click('[data-step-add=ac]');
  await ta(2).fill('Offensive');
  ok((await p.getAttribute('#acStepList .step-row:nth-child(3) [data-step=del]', 'aria-label')) === 'Delete element 3', `${tag}: row buttons say "element"`);
  await p.fill('#acIntro', 'Battery');
  if (w < 800) await p.locator('#acStepList').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${SP}/elements-editor-${w}-${scheme}.png` });
  await sideways(p, w, tag + ' editor');
  await p.click(addBtn);
  await p.waitForFunction(() => document.getElementById('acFront').value === '' || document.getElementById('acFront').textContent === '');
  const made = await stored(p, 'Battery');
  ok(made?.back === 'Battery\nElement 1: Harmful contact\nElement 2: Intent\nElement 3: Offensive', `${tag}: saved as Element lines (${JSON.stringify(made?.back)})`);
  // Switching to Steps keeps the rows; to Text writes them into Back.
  await p.fill('#acFront', 'x');
  await ta(0).fill('One'); await ta(1).fill('Two');
  await p.click('.answer-mode .chip:has(#acModeText)');
  ok((await p.evaluate(() => { const b = document.getElementById('acBack'); return b.value ?? b.textContent; })).includes('Element 1: '), `${tag}: choosing Text writes the elements into Back`);
  await p.click('.answer-mode .chip:has(#acModeElements)');
  ok(await p.locator('#acStepList .step-row').count() >= 2, `${tag}: and choosing Elements again reads them back as rows`);
  await p.click('#acDone');

  // ---------- Review ----------
  await p.goto('about:blank'); await p.goto(URL + '#/review/T'); await p.waitForSelector('#flash');
  ok(/Negligence/.test(await p.textContent('.rv-front .flash-front')), `${tag}: the first card is Negligence`);
  ok((await p.textContent('.rv-front .el-count')).trim() === '4 elements', `${tag}: the front says "4 elements"`);
  ok(await p.locator('#typeIn').count() === 0 && /recall them in your head/.test(await p.textContent('#longNote')), `${tag}: no typing; the note says to recall them in your head`);
  await p.keyboard.press('Space'); await p.waitForSelector('#stepBtn');
  ok(await shown(p) === 0 && await p.locator('.rate').count() === 0, `${tag}: after the flip no element is visible`);
  ok(/Recall element 1 of 4, then reveal\./.test(await p.textContent('#stepTry')) && /Reveal element 1 of 4/.test(await p.textContent('#stepBtn')), `${tag}: "Recall element 1 of 4, then reveal." and the button`);
  ok(await p.locator('#stepAllBtn').count() === 1, `${tag}: Show all`);
  await p.screenshot({ path: `${SP}/elements-flipped-${w}-${scheme}.png` });
  await p.keyboard.press('Space');
  ok(await shown(p) === 1 && /Reveal element 2 of 4/.test(await p.textContent('#stepBtn')), `${tag}: Space reveals element 1`);
  ok((await p.getAttribute('#steps > li:not([hidden]) .el-tick', 'aria-pressed')) === 'true' && /Got it/.test(await p.textContent('#steps > li:not([hidden]) .el-tick')), `${tag}: it starts as "Got it"`);
  await p.keyboard.press('Space');                 // element 2
  await p.keyboard.press('x');                     // miss the latest (element 2)
  ok((await p.getAttribute('#steps > li:nth-child(2) .el-tick', 'aria-pressed')) === 'false' && /Missed/.test(await p.textContent('#steps > li:nth-child(2) .el-tick')), `${tag}: X marks the latest element Missed`);
  await p.keyboard.press('Space');                 // element 3
  await p.keyboard.press('Space');                 // element 4: all shown
  ok(await shown(p) === 4 && await p.locator('.rate').count() === 4 && await p.locator('#stepBtn').count() === 0, `${tag}: after the last element the four ratings appear`);
  ok(/You got 3 of 4\. Suggested: Hard\./.test(await p.textContent('#elSum')), `${tag}: "${(await p.textContent('#elSum')).trim()}"`);
  ok(await p.locator('.rate.r2.suggested').count() === 1 && /Suggested/.test(await p.textContent('.rate.r2')), `${tag}: Hard has the ring and the word "Suggested"`);
  await p.screenshot({ path: `${SP}/elements-done-${w}-${scheme}.png` });
  await sideways(p, w, tag + ' review');
  // A tap on a toggle changes the suggestion
  await p.click('#steps > li:nth-child(3) .el-tick');
  ok(/You got 2 of 4\. Suggested: Again\./.test(await p.textContent('#elSum')) && await p.locator('.rate.r1.suggested').count() === 1, `${tag}: a second miss makes it Again`);
  await p.click('#steps > li:nth-child(3) .el-tick');
  ok(/Suggested: Hard/.test(await p.textContent('#elSum')), `${tag}: toggling back returns to Hard`);
  // Space with the focus off the buttons rates the suggestion (Hard = 2)
  await p.evaluate(() => document.querySelector('.rv-back').focus());
  await p.keyboard.press('Space');
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent.includes('Contract'));
  for (let i = 0; i < 40 && (await readLogs(p)).length < 1; i++) await p.waitForTimeout(100);
  ok((await readLogs(p)).join() === '2', `${tag}: Space rated Hard and it was logged (${(await readLogs(p)).join()})`);

  // Show all: everything ticked "Got it", the intro shows, Good is suggested; 1-4 still pick any rating
  ok((await p.textContent('.rv-front .el-count')).trim() === '3 elements', `${tag}: the next card says "3 elements"`);
  await p.keyboard.press('Space'); await p.waitForSelector('#stepBtn');
  ok(/A valid contract needs/.test(await p.textContent('.steps-intro')), `${tag}: the intro shows above the elements`);
  await p.keyboard.press('a');
  ok(await shown(p) === 3 && await p.$$eval('.el-tick', b => b.every(x => x.getAttribute('aria-pressed') === 'true')) && /Suggested: Good/.test(await p.textContent('#elSum')), `${tag}: Show all ticks every element and suggests Good`);
  // read aloud: the elements shown so far (before Show all it would be fewer; here all)
  await p.evaluate(() => { window.__said = []; window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } }; speechSynthesis.cancel = () => {}; speechSynthesis.speak = u => window.__said.push(u.text); });
  await p.keyboard.press('r');
  const said = await p.evaluate(() => window.__said.join(' | '));
  ok(/Element 1\./.test(said) && /Element 3\./.test(said), `${tag}: Read aloud reads the elements ("${said.slice(0, 60)}…")`);
  await p.keyboard.press('4');                      // any rating can be picked
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent.includes('Water'));
  for (let i = 0; i < 40 && (await readLogs(p)).length < 2; i++) await p.waitForTimeout(100);
  ok((await readLogs(p)).join() === '2,4', `${tag}: 4 picked Easy though Good was suggested (${(await readLogs(p)).join()})`);
  // "Elements: H, O" is an ordinary card
  ok(await p.locator('.el-count').count() === 0, `${tag}: "Elements: H, O" is an ordinary card`);

  // ---------- Play ----------
  const q = await p.evaluate(async () => {
    const g = await import('./js/game.js'), db = await import('./js/db.js');
    const cards = await db.getAll('cards');
    const a = cards.find(c => c.id === 'tort');
    return { front: g.questionFor(a, 'front'), back: g.questionFor(a, 'back'), typing: g.questionFor(a, 'typing'), only: g.isFrontOnly(a) };
  });
  ok(q.front.answer === 'Duty · Breach · Causation · Damages' && q.back === null && q.typing === null && q.only, `${tag}: Play asks front → the elements joined with " · ", never typed`);
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
