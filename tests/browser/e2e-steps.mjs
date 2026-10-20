// Round 2 (2B), B5 and B7: step-by-step cards (the card editor's "Answer in steps", Review revealing one step at a time, Play
// asking for the final step) and the memory hook (noteExtra) on Basic cards.
// Run with: node tests/browser/run.mjs steps
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
    await db.addDeckWithCards({ id: 'T', name: 'Algebra', color: '#5B48E8', created: Date.now() }, [
      { id: 'plain', deckId: 'T', front: 'Quadratic formula', back: 'x = (-b ± √(b²-4ac)) / 2a', noteExtra: 'Sing it to Pop Goes the Weasel', tags: [], created: 1 }]);
    await db.setSetting('reviewTyping', true);
    await db.setSetting('theme', (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: scheme }));
  }, scheme);
  return p;
};
const sideways = (p, w, tag) => w > 800 || p.evaluate(() => document.documentElement.scrollWidth <= innerWidth).then(v => ok(v, `${tag}: no sideways scroll`));
const addBtn = 'button[type=submit][form=acForm]';
const visibleSteps = p => p.$$eval('#steps > li:not([hidden])', l => l.length);
const stored = (p, front) => p.evaluate(async front => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === front), front);

for (const [w, h, scheme] of [[375, 780, 'dark'], [375, 780, 'light'], [1440, 900, 'dark'], [1440, 900, 'light']]) {
  const tag = `${w} ${scheme}`;
  const p = await open(w, h, scheme);

  // ---------- the editor: Answer in steps, Memory hook ----------
  await p.goto('about:blank'); await p.goto(URL + '#/deck/T'); await p.waitForSelector('#brAdd');
  await p.click('#brAdd'); await p.waitForSelector('#acFront');
  ok(await p.locator('#acModeSteps').count() === 1 && /Answer:\s*Plain text\s*Step by step\s*List of parts/.test(await p.textContent('.answer-mode')), `${tag}: Basic has an "Answer: Plain text | Step by step | List of parts" choice`);
  ok(await p.locator('#acSteps').isHidden() && await p.locator('#acBackWrap').isVisible(), `${tag}: off = the normal Back box`);
  ok(/Memory hook \(optional\)/.test(await p.textContent('#acForm')), `${tag}: Basic has a "Memory hook (optional)" field`);
  await p.fill('#acFront', 'Solve 2x + 3 = 7');
  await p.click('.answer-mode .chip:has(#acModeSteps)');
  ok(await p.locator('#acSteps').isVisible() && await p.locator('#acBackWrap').isHidden(), `${tag}: on = step fields instead of Back`);
  ok(await p.locator('#acStepList .step-row').count() === 2, `${tag}: it starts with two step fields`);
  ok(await p.$$eval('#acStepList [data-step=del]', b => b.length === 2 && b.every(x => x.disabled)), `${tag}: with two steps the delete buttons are off`);
  ok(/step/i.test(await p.textContent('#acWhy')), `${tag}: Add explains what is missing: "${(await p.textContent('#acWhy')).trim()}"`);
  const rows = () => p.$$eval('#acStepList textarea', t => t.map(x => x.value));
  const ta = i => p.locator('#acStepList textarea').nth(i);
  await ta(0).fill('subtract 3 from both sides');
  await ta(1).fill('divide by 2');
  ok(await p.getAttribute(addBtn, 'aria-disabled') === 'false', `${tag}: two steps are enough to add`);
  await p.click('[data-step-add=ac]');
  ok(await p.locator('#acStepList .step-row').count() === 3 && await p.evaluate(() => document.activeElement === document.querySelectorAll('#acStepList textarea')[2]), `${tag}: + Add step adds a field and focuses it`);
  await ta(2).fill('check');
  await p.locator('#acStepList [data-step=up]').nth(2).click();                 // check ↑
  ok((await rows()).join('|') === 'subtract 3 from both sides|check|divide by 2', `${tag}: move up`);
  await p.locator('#acStepList [data-step=down]').nth(1).click();               // check ↓ again
  ok((await rows()).join('|') === 'subtract 3 from both sides|divide by 2|check', `${tag}: move down`);
  ok((await p.getAttribute('#acStepList .step-row:nth-child(3) [data-step=del]', 'aria-label')) === 'Delete step 3', `${tag}: buttons say which step they act on`);
  await p.locator('#acStepList [data-step=del]').nth(1).click();                // delete "divide by 2"
  ok((await rows()).join('|') === 'subtract 3 from both sides|check', `${tag}: delete`);
  await p.locator('#acStepList [data-step=up]').nth(1).click();                 // check ↑  → check, subtract
  await p.locator('#acStepList [data-step=down]').nth(0).click();               // back again
  await p.click('[data-step-add=ac]');
  await ta(2).fill('divide by 2 to get x');
  await p.fill('#acFinal', 'x = 2');
  await p.fill('#acHook', 'Undo the plus, then the times');
  if (w > 800) await p.screenshot({ path: `${SP}/steps-editor-${w}-${scheme}.png` });
  else { await p.locator('#acStepList').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SP}/steps-editor-${w}-${scheme}.png` }); }
  await sideways(p, w, tag + ' editor');
  await p.click(addBtn);
  await p.waitForFunction(() => document.getElementById('acFront').value === '' || document.getElementById('acFront').textContent === '');
  const made = await stored(p, 'Solve 2x + 3 = 7');
  ok(made?.back === 'Step 1: subtract 3 from both sides\nStep 2: check\nStep 3: divide by 2 to get x\nAnswer: x = 2', `${tag}: saved back is the Step lines (${JSON.stringify(made?.back)})`);
  ok(made?.noteExtra === 'Undo the plus, then the times', `${tag}: the hook is saved as noteExtra`);
  ok(await p.locator('#acStepList .step-row').count() === 2 && (await rows()).every(v => v === ''), `${tag}: after adding, the step fields are empty again`);
  ok(await p.locator('#acModeSteps').isChecked(), `${tag}: Steps stays chosen for the next card`);
  // Fewer than two steps is refused.
  await p.fill('#acFront', 'One step only');
  await ta(0).fill('just this');
  ok(await p.getAttribute(addBtn, 'aria-disabled') === 'true' && /two steps/.test(await p.textContent('#acWhy')), `${tag}: one step cannot be added (${(await p.textContent('#acWhy')).trim()})`);
  // v4.8.1: a line inside a step that starts "Answer:" or "Step N:" would not read back as the same steps: it is refused with a reason
  ok(await p.locator('#acIntro').isVisible() && /Intro \(optional\)/.test(await p.textContent('#acSteps')), `${tag}: the intro is a visible "Intro (optional)" field`);
  await ta(1).fill('then\nAnswer: x');
  ok(await p.getAttribute(addBtn, 'aria-disabled') === 'true' && /can't start with 'Step N:' or 'Answer:'/.test(await p.textContent('#acWhy')), `${tag}: "Answer:" inside a step is refused (${(await p.textContent('#acWhy')).trim()})`);
  await ta(1).fill('then');
  await p.fill('#acFinal', 'so\nStep 3: more');
  ok(await p.getAttribute(addBtn, 'aria-disabled') === 'true' && /can't start with/.test(await p.textContent('#acWhy')), `${tag}: "Step 3:" inside the final answer is refused`);
  await p.fill('#acFinal', 'done');
  await p.fill('#acIntro', 'Warm up first');
  ok(await p.getAttribute(addBtn, 'aria-disabled') === 'false', `${tag}: fixed, it can be added`);
  await p.click(addBtn);
  await p.waitForFunction(() => document.getElementById('acFront').value === '' || document.getElementById('acFront').textContent === '');
  ok((await stored(p, 'One step only'))?.back === 'Warm up first\nStep 1: just this\nStep 2: then\nAnswer: done', `${tag}: the intro field is saved above the steps`);
  ok(await p.inputValue('#acIntro') === '', `${tag}: and cleared for the next card`);
  await p.fill('#acFront', 'One step only 2');
  await ta(0).fill('just this');
  // Switching off puts the steps into Back.
  await p.click('.answer-mode .chip:has(#acModeText)');
  ok((await p.evaluate(() => { const b = document.getElementById('acBack'); return b.value ?? b.textContent; })).includes('Step 1: just this'), `${tag}: switching off writes the steps into Back`);
  await p.click('#acDone');
  // Tidy the second stepped card for the review below: replace the first with a clear 3-step card with an intro and no Answer.
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const c = (await db.getAll('cards')).find(x => x.front === 'Solve 2x + 3 = 7');
    await db.saveCards([{ ...c, back: 'Work it out in three moves.\nStep 1: subtract 3 from both sides, so 2x = 4\nStep 2: divide both sides by 2\nStep 3: check: 2(2) + 3 = 7\nAnswer: x = 2', created: 2 },
      { id: 'two', deckId: 'T', front: 'Derivative of x^2', back: 'Step 1: power rule\nStep 2: bring the 2 down\nStep 3: 2x', tags: [], created: 3 },
      { id: 'mathy', deckId: 'T', front: 'Mask check', back: 'Step 1: write $$\nStep 2: not a step\n$$\nStep 2: real second step', tags: [], created: 4 }]);
  });

  // ---------- Review ----------
  await p.goto('about:blank'); await p.goto(URL + '#/review/T'); await p.waitForSelector('#flash');
  // New cards come in creation order: plain, then the stepped ones.
  ok(await p.locator('#typeIn').count() === 1, `${tag}: the plain card is typed (typing is on)`);
  await p.fill('#typeIn', 'x'); await p.keyboard.press('Enter'); await p.waitForSelector('.rate');
  ok(/Pop Goes the Weasel/.test(await p.textContent('.rv-back:not([inert]) .flash-extra')), `${tag}: a Basic card shows its memory hook under the answer`);
  const hookBox = await p.$eval('.rv-back .flash-extra', e => { const r = e.getBoundingClientRect(), a = document.querySelector('.rv-back .flash-back').getBoundingClientRect(); return r.top >= a.bottom - 1 && r.width > 0; });
  ok(hookBox, `${tag}: the hook sits below the answer`);
  if (w > 800 || scheme === 'dark') await p.screenshot({ path: `${SP}/hook-review-${w}-${scheme}.png` });
  await p.click('.rate.r3');
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent.includes('Solve 2x'));

  // the stepped card: no typing, steps one at a time
  ok(await p.locator('#typeIn').count() === 0 && await p.locator('#typeForm').count() === 0, `${tag}: a stepped card has no typing box even with typing on`);
  ok(await p.locator('#showBtn').count() === 1, `${tag}: it shows "Show answer"`);
  await p.keyboard.press('Space'); await p.waitForSelector('#stepBtn');
  ok(await visibleSteps(p) === 0 && await p.locator('.rate').count() === 0, `${tag}: after the flip no steps are visible and there are no rating buttons`);
  ok(/Reveal step 1 of 3/.test(await p.textContent('#stepBtn')) && /Try step 1 yourself, then reveal/.test(await p.textContent('#stepTry')), `${tag}: "Reveal step 1 of 3" and "Try step 1 yourself, then reveal"`);
  // v4.8.1 review: no live region (the focus move is what is read out; both together read every step twice).
  ok((await p.getAttribute('#steps', 'aria-live')) === null, `${tag}: the steps are not a live region (the focus move is announced instead)`);
  ok(/Work it out in three moves/.test(await p.textContent('.steps-intro')), `${tag}: the intro shows`);
  ok(await p.$eval('.rv-back:not([inert]) .flash-extra', e => e.hidden), `${tag}: the memory hook waits until the last step`);
  await p.screenshot({ path: `${SP}/steps-flipped-${w}-${scheme}.png` });
  await p.keyboard.press('Space');
  ok(await visibleSteps(p) === 1 && /Reveal step 2 of 3/.test(await p.textContent('#stepBtn')), `${tag}: Space reveals step 1; the button now says step 2 of 3`);
  ok(await p.evaluate(() => document.activeElement?.matches('#steps > li') && document.activeElement === document.querySelector('#steps > li:not([hidden])')), `${tag}: focus is on the revealed step`);
  await p.keyboard.press('ArrowRight');
  ok(await visibleSteps(p) === 2 && await p.evaluate(() => document.activeElement === document.querySelectorAll('#steps > li')[1]), `${tag}: → reveals step 2 and focuses it`);
  // read aloud: steps shown so far
  await p.evaluate(() => { window.__said = []; window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } }; speechSynthesis.cancel = () => {}; speechSynthesis.speak = u => window.__said.push(u.text); });
  await p.keyboard.press('r');
  const said = await p.evaluate(() => window.__said.join(' | '));
  ok(/Step 1\./.test(said) && /Step 2\./.test(said) && !/Step 3\./.test(said) && !/x = 2/.test(said), `${tag}: Read aloud reads the revealed steps only ("${said.slice(0, 70)}…")`);
  await p.screenshot({ path: `${SP}/steps-mid-${w}-${scheme}.png` });
  await p.keyboard.press('Enter');
  ok(await visibleSteps(p) === 3 && await p.locator('.rate').count() === 4 && await p.locator('#stepBtn').count() === 0, `${tag}: Enter reveals the last step and the four rating buttons appear`);
  ok(await p.$eval('.steps-final', e => !e.hidden && /x = 2/.test(e.textContent)) && await p.$eval('.rv-back:not([inert]) .flash-extra', e => !e.hidden), `${tag}: the final answer is shown with the last step, and the hook`);
  ok(await p.evaluate(() => document.activeElement === document.querySelector('.steps-final')), `${tag}: the last step moves focus to the final answer`);
  await p.screenshot({ path: `${SP}/steps-done-${w}-${scheme}.png` });
  await sideways(p, w, tag + ' review');
  await p.keyboard.press('3');
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent.includes('Derivative'));

  // A shows all; the last step is the answer when there is no Answer line
  await p.keyboard.press('Space'); await p.waitForSelector('#stepBtn');
  ok(await p.locator('#stepAllBtn').count() === 1 && (await p.getAttribute('#stepAllBtn', 'aria-keyshortcuts')) === 'A', `${tag}: a Show all button (A)`);
  await p.keyboard.press('a');
  ok(await visibleSteps(p) === 3 && await p.locator('.rate').count() === 4 && await p.locator('.steps-final').count() === 0, `${tag}: A shows every step at once and brings the ratings`);
  await p.keyboard.press('2');
  await p.waitForFunction(() => document.querySelector('.rv-front .flash-front')?.textContent.includes('Mask check'));

  // 1-4 work before every step is shown; Step 2 inside $$ is not a step
  await p.keyboard.press('Space'); await p.waitForSelector('#stepBtn');
  ok(/of 2/.test(await p.textContent('#stepBtn')), `${tag}: "Step 2:" inside $$…$$ is not counted (${(await p.textContent('#stepBtn')).trim().slice(0, 24)})`);
  await p.keyboard.press('Space');
  await p.keyboard.press('1');
  const readLogs = () => p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).filter(l => l.source === 'review').sort((a, b) => a.timestamp - b.timestamp).map(l => l.rating));
  for (let i = 0; i < 40 && (await readLogs()).length < 4; i++) await p.waitForTimeout(100);
  const logs = await readLogs();
  ok(logs.join() === '3,3,2,1', `${tag}: ratings 3, 3, 2 and an early 1 were all logged (${logs.join()})`);

  // ---------- Play asks for the final step ----------
  const q = await p.evaluate(async () => {
    const g = await import('./js/game.js'), db = await import('./js/db.js');
    const cards = await db.getAll('cards');
    const a = cards.find(c => c.front === 'Solve 2x + 3 = 7'), b = cards.find(c => c.id === 'two');
    return { a: g.questionFor(a, 'front'), b: g.questionFor(b, 'front'), back: g.questionFor(a, 'back'), only: g.isFrontOnly(a) };
  });
  ok(q.a.answer === 'x = 2' && q.b.answer === '2x' && q.back === null && q.only, `${tag}: Play asks for the Answer line, else the last step, and never back → front`);
  await p.close();
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
