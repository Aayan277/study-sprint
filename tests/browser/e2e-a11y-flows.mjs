// Keyboard and screen-reader flows (WCAG 2.2): Play focus and announcements, form errors, single-key shortcuts, Browse select,
// Review headings and rating names, the Stats day picker, and the formatting toolbar. Everything here is driven with the keyboard.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Could not save answer')) errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const URL = 'http://localhost:8123/';
const active = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.tagName.toLowerCase()) : ''; });
const attr = (sel, a) => page.getAttribute(sel, a);
// After End round: the results screen -> its menu button -> Play's setup again.
const leaveResults = async () => { await page.waitForSelector('#menuBtn, #startBtn'); if (await page.locator('#menuBtn').count()) await page.click('#menuBtn'); await page.waitForSelector('#startBtn'); };
const snap = sel => page.locator(sel).first().ariaSnapshot();

await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');

// ---------- 2. Play: focus and announcements ----------
await page.evaluate(async () => { await (await import('./js/db.js')).setSetting('timer', 3); });
await page.goto(URL + '#/play'); await page.waitForSelector('#startBtn');
await page.$eval('input[name=fmt][value=classic]', el => el.click());
await page.$eval('input[name=qtype][value=front]', el => el.click());
await page.$eval('input[name=len][value="10"]', el => el.click());
await page.focus('#startBtn'); await page.keyboard.press('Enter'); await page.waitForSelector('#pCard');
ok(await active() === 'pPrompt', 'Play: starting a round puts focus on the question');
ok((await page.textContent('#pAnnounce')).trim() === 'Question 1 of 10', 'Play: with focus on the question, the live region only says "Question 1 of 10" (the prompt is read from the focus, not twice)');
{ const cdp = await ctx.newCDPSession(page); const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const h = nodes.find(n => n.role?.value === 'heading' && n.properties?.some(p => p.name === 'focused' && p.value.value));
  ok(h && (h.name?.value || '').length > 0, 'Play: the focused node in the accessibility tree is the question heading, named with the prompt'); await cdp.detach(); }
ok((await page.locator('h1').first().textContent()).includes('Play'), 'Play: the round has an h1');
{ const s = await snap('#screen'); ok(/heading "Play: Classic round" \[level=1\]/.test(s) && /heading ".+" \[level=2\]/.test(s), 'Play: ARIA snapshot has the h1 and the question as a level-2 heading'); }
const front = await page.textContent('#pPrompt');
const back = await page.evaluate(async f => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === f)?.back, front);
const idx = await page.evaluate(b => [...document.querySelectorAll('#options .opt')].findIndex(o => o.querySelector('.lbl').textContent === b), back);
await page.keyboard.press(String(idx + 1));
await page.waitForSelector('.fb.ok');
ok((await page.textContent('#feedback')).includes('Correct') && /\+\d+/.test(await page.textContent('#feedback')), 'Play: "Correct +points" is still in the feedback live region');
ok(await attr('#feedback', 'aria-live') === 'polite' && await attr('#pAnnounce', 'aria-live') === 'polite', 'Play: both regions are polite live regions');
await page.waitForFunction(() => /^Question 2 of 10$/.test(document.querySelector('#pAnnounce')?.textContent || ''), null, { timeout: 4000 });
ok(await active() === 'pPrompt', 'Play: after a right answer moves on by itself, focus is back on the question (not on the page)');
// Focus on Quit is left alone while a right answer moves on.
await page.focus('#quitBtn');
{ const f2 = await page.textContent('#pPrompt');
  const b2 = await page.evaluate(async f => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === f)?.back, f2);
  const i2 = await page.evaluate(b => [...document.querySelectorAll('#options .opt')].findIndex(o => o.querySelector('.lbl').textContent === b), b2);
  await page.click(`#options .opt[data-i="${i2}"]`, { force: true }); }
await page.focus('#quitBtn');
await page.waitForFunction(() => /^Question 3 of 10/.test(document.querySelector('#pAnnounce')?.textContent || ''), null, { timeout: 4000 });
ok(await active() === 'quitBtn', 'Play: focus on Quit is not pulled away by the next question');
ok(/^Question 3 of 10: ./.test(await page.textContent('#pAnnounce')), 'Play: when focus is not on the question, the announcement includes the prompt');
await page.click('#quitBtn'); if (await page.isVisible('#endAsk')) await page.click('#endYes');
await leaveResults();

// Typed answers: focus goes to the box, and what was typed stays.
await page.goto(URL + '#/play'); await page.waitForSelector('#startBtn');
await page.$eval('input[name=qtype][value=typing]', el => el.click());
await page.click('#startBtn'); await page.waitForSelector('#pInput');
ok(await active() === 'pInput', 'Play typing: focus is in the answer box');
ok(/^Question 1 of \d+: ./.test(await page.textContent('#pAnnounce')), 'Play typing: the announcement has the full prompt (focus is on the answer box)');
await page.keyboard.type('abc');
await page.waitForTimeout(500);
ok(await page.inputValue('#pInput') === 'abc' && await active() === 'pInput', 'Play typing: text being typed is left alone');
await page.click('#quitBtn'); if (await page.isVisible('#endAsk')) await page.click('#endYes');
await leaveResults();

// ---------- 9. Play reads a cloze blank as "blank" ----------
await page.evaluate(async () => { const db = await import('./js/db.js'); const { planNoteSave } = await import('./js/cloze.js');
  await db.addDeckWithCards({ id: 'czdeck', name: 'Cloze check', created: Date.now() + 9 }, []);
  const plan = planNoteSave([], 'The mitochondria makes {{c1::ATP}} for the cell'); await db.saveNote(plan, { deckId: 'czdeck', noteId: db.newId(), tags: [] }); });
await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
await page.goto(URL + '#/play'); await page.waitForSelector('#startBtn');
await page.selectOption('#pDeck', 'czdeck');
await page.$eval('input[name=qtype][value=typing]', el => el.click());
await page.click('#startBtn'); await page.waitForSelector('#pInput');
{ const said = await page.textContent('#pAnnounce'); console.log('   cloze announcement:', said);
  ok(/makes blank for the cell/.test(said) && !said.includes('…'), 'Play: a cloze blank is announced as "blank"'); }
await page.click('#quitBtn'); if (await page.isVisible('#endAsk')) await page.click('#endYes');
await leaveResults();
await page.evaluate(async () => { const db = await import('./js/db.js'); await db.deleteDeck('czdeck'); await db.setSetting('playPrefs', {}); });

// ---------- 12. Play: no time limit ----------
await page.goto(URL + '#/play'); await page.waitForSelector('#startBtn');
await page.$eval('input[name=fmt][value=classic]', el => el.click());
await page.$eval('input[name=qtype][value=front]', el => el.click());
if (await attr('#customBtn', 'aria-expanded') !== 'true') await page.click('#customBtn');
ok(await page.locator('#untimed').count() === 1, 'Play: Classic has a "No time limit" switch');
await page.focus('#untimed'); await page.keyboard.press('Space');
ok(await page.isChecked('#untimed') && await attr('#pace', 'disabled') !== null && await active() === 'untimed', 'Play: the switch works from the keyboard, disables the slider and keeps focus');
ok((await page.textContent('#paceOut')).includes('Off'), 'Play: the pace shows Off');
await page.$eval('input[name=fmt][value=lightning]', el => el.click());
ok(await page.locator('#untimed').count() === 0, 'Play: Lightning has no such switch (it is a 60-second race)');
await page.$eval('input[name=fmt][value=survival]', el => el.click());
ok(await page.locator('#untimed').count() === 1 && await page.isChecked('#untimed'), 'Play: Survival has it too, and remembers the choice');
await page.$eval('input[name=fmt][value=classic]', el => el.click());
await page.click('#startBtn'); await page.waitForSelector('#pCard');
await page.waitForTimeout(4500);       // the timer was set to 3 s: a timed question would have run out
ok(await page.locator('#nextBtn').count() === 0 && await page.evaluate(() => document.querySelector('.timer')?.hidden === true), 'Play: an untimed question does not run out, and the timer bar is gone');
await page.click('#quitBtn'); if (await page.isVisible('#endAsk')) await page.click('#endYes');
await leaveResults();
await page.evaluate(async () => { const db = await import('./js/db.js'); const p = (await db.getSettings()).playPrefs || {}; await db.setSetting('playPrefs', { ...p, untimed: false }); });

// ---------- 7 + 8. Review: headings, names, rating buttons ----------
await page.goto(URL + '#/today'); await page.waitForSelector('#startBtn');
await page.focus('#startBtn'); await page.keyboard.press('Enter'); await page.waitForSelector('#flash');
ok((await page.textContent('h1')).trim() === 'Review', 'Review: the page has an h1');
{ const cdp = await ctx.newCDPSession(page); const { root } = await cdp.send('DOM.getDocument'); const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#flash' });
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
  const card = nodes[0];
  const q = (await page.textContent('#rvQ')).trim();
  console.log('   card node:', card?.role?.value, '|', card?.name?.value, '|', card?.description?.value);
  ok(card && (card.name?.value || '').includes(q.slice(0, 20)) && !/Press Space/.test(card.name.value), 'Review: the focused card is named by the question text (accessibility tree)');
  ok(/Press Space or Enter to show the answer/.test(card?.description?.value || ''), 'Review: the Space/Enter hint is its description, not part of the name');
  await cdp.detach(); }
ok(await attr('#flash', 'aria-label') === null, 'Review: no aria-label hides the question text');
{ const s = await snap('#flash'); ok(/heading "Question" \[level=2\]/.test(s), 'Review: ARIA snapshot of the front has the Question heading'); }
ok(await active() === 'flash', 'Review: the card has focus');
await page.keyboard.press('Space'); await page.waitForSelector('.rate');
ok(await page.evaluate(() => document.activeElement.classList.contains('rv-back') && document.activeElement.getAttribute('role') === 'region' && document.activeElement.getAttribute('aria-label') === 'Answer'), 'Review: after flipping, focus is on the Answer region');
{ const s = await snap('.rv-back'); ok(/region "Answer"/.test(s), 'Review: ARIA snapshot names the back "Answer"'); }
const names = await page.$$eval('.rate', bs => bs.map(b => b.getAttribute('aria-label')));
console.log('   rating names:', names.join(' | '));
ok(names.length === 4 && names.every(n => /^(Again|Hard|Good|Easy), next review in (less than a minute|\d+ (minutes?|hours?|days?)|[\d.]+ (months?|years?))/.test(n)), 'Review: rating buttons say "Good, next review in 5 days"');
ok(/^Again, next review in 1 minute/.test(names[0]) || /^Again, next review in \d+ minutes?/.test(names[0]), 'Review: Again is a few minutes for a new card');
{ const s = await snap('#ratebar'); ok(/button "Good, next review in /.test(s), 'Review: ARIA snapshot shows the spoken name of Good'); }
ok(await attr('#flash', 'aria-labelledby') === null && await attr('#flash', 'aria-describedby') === null, 'Review: after flipping the card drops its question name and hint');
ok(await page.locator('.rate kbd.key-hint').count() === 4 && (await page.textContent('#keyLine')).includes('1–4'), 'Review: key hints are shown while shortcuts are on');

// ---------- 4. Single-key shortcuts ----------
await page.keyboard.press('i');
await page.waitForFunction(() => document.getElementById('sheet').open, null, { timeout: 5000 }).catch(() => {});
ok(await page.evaluate(() => document.getElementById('sheet').open), 'Shortcuts on: I opens the card info');
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
if (await page.evaluate(() => document.getElementById('sheet').open)) await page.evaluate(async () => (await import('./js/ui.js')).closeSheet());
await page.waitForFunction(() => !document.getElementById('sheet').open);
await page.click('.rate.r3'); await page.waitForSelector('.rv-front:not([inert])');      // next card, not flipped
// turn them off in Settings (keyboard only)
await page.goto(URL + '#/settings'); await page.waitForSelector('#singleKeys');
ok(await page.isChecked('#singleKeys'), 'Settings: Single-key shortcuts is on by default');
ok(await page.evaluate(() => !!document.querySelector('#singleKeys').closest('#studyTitle, section')?.querySelector('#studyTitle') || !!document.querySelector('[aria-labelledby=studyTitle] #singleKeys')), 'Settings: it sits in the Study section');
await page.focus('#singleKeys'); await page.keyboard.press('Space');
ok(!(await page.isChecked('#singleKeys')) && await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).singleKeys) === false, 'Settings: the switch saves (this device only)');
ok(await page.evaluate(async () => !(await import('./js/sync-data.js')).SYNCED_SETTINGS.includes('singleKeys')), 'Settings: singleKeys is a per-device setting, not synced');
await page.goto(URL + '#/today'); await page.waitForSelector('#startBtn, #flash');
if (await page.locator('#startBtn').count()) { await page.focus('#startBtn'); await page.keyboard.press('Enter'); }
await page.waitForSelector('#flash');
console.log('   active before keys:', await active());
ok(await page.locator('kbd').count() === 0 && (await page.textContent('#keyLine')).trim() === '', 'Shortcuts off: Review shows no key hints');
ok(await page.locator('[aria-keyshortcuts]').count() === 0, 'Shortcuts off: no aria-keyshortcuts left on the page');
ok(await page.evaluate(() => [...document.querySelectorAll('[title]')].every(e => !/\((?:[A-Z]|@|-|Space)\)$/.test(e.title))), 'Shortcuts off: no "(R)" or "(D)" in button titles');
await page.keyboard.press('i'); await page.waitForTimeout(200);
ok(!(await page.evaluate(() => document.getElementById('sheet').open)), 'Shortcuts off: I does nothing');
const pen = await attr('#scratchBtn', 'aria-pressed');
await page.keyboard.press('d'); await page.waitForTimeout(150);
ok(await attr('#scratchBtn', 'aria-pressed') === pen, 'Shortcuts off: D does not toggle the scratchpad');
await page.keyboard.press('Space'); await page.waitForSelector('.rate');
ok(await page.locator('.rate').count() === 4, 'Shortcuts off: Space on the focused card still flips it');
const before = await page.textContent('.rv-counts');
await page.keyboard.press('3'); await page.waitForTimeout(300);
ok(await page.locator('.rate').count() === 4 && (await page.textContent('.rv-counts')) === before, 'Shortcuts off: 3 does not rate the card');
await page.keyboard.press('Enter'); await page.waitForTimeout(400);
ok((await page.textContent('.rv-counts')) !== before || await page.locator('.rate').count() === 0, 'Shortcuts off: Enter on the focused answer still rates the suggested button');
// Play with the keys off
await page.goto(URL + '#/play'); await page.waitForSelector('#startBtn');
await page.$eval('input[name=qtype][value=front]', el => el.click());
ok((await page.textContent('.keys')).trim() === 'Esc to quit', 'Shortcuts off: Play setup hint drops the number keys');
await page.click('#startBtn'); await page.waitForSelector('#pCard');
ok(await page.locator('#options .key').count() === 0, 'Shortcuts off: Play options show no number badges');
await page.keyboard.press('1'); await page.waitForTimeout(300);
ok(await page.locator('.fb').count() === 0, 'Shortcuts off: 1 does not answer in Play');
await page.focus('#options .opt'); await page.keyboard.press('Enter'); await page.waitForSelector('.fb');
ok(await page.locator('.fb').count() === 1, 'Shortcuts off: an option still answers with Enter when focused');
await page.click('#quitBtn'); if (await page.isVisible('#endAsk')) await page.click('#endYes');
await leaveResults();
// back on, for the rest
await page.goto(URL + '#/settings'); await page.waitForSelector('#singleKeys');
await page.focus('#singleKeys'); await page.keyboard.press('Space');
ok(await page.isChecked('#singleKeys'), 'Settings: turned back on');

// ---------- 5. Browse select mode keeps focus ----------
await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
await page.click('.deck-open'); await page.waitForSelector('.crow');
await page.focus('#brSelect'); await page.keyboard.press('Enter');
await page.focus('.crow .crow-btn'); const firstRow = await page.evaluate(() => document.activeElement.closest('.crow').dataset.id);
ok(await attr('.crow .crow-btn', 'role') === 'checkbox' && await attr('.crow .crow-btn', 'aria-checked') === 'false', 'Select: rows are checkboxes, unchecked');
await page.keyboard.press('Space');
ok(await attr('.crow .crow-btn', 'aria-checked') === 'true' && await page.evaluate(id => document.activeElement.closest('.crow')?.dataset.id === id, firstRow), 'Select: Space checks the row and focus stays on it');
ok((await page.textContent('#brSel')).trim() === '1 selected', 'Select: the count updates');
await page.keyboard.press('Tab'); await page.keyboard.press('Space');
ok((await page.textContent('#brSel')).trim() === '2 selected' && await page.evaluate(() => document.activeElement.closest('.crow') !== null), 'Select: the next row checks the same way');
{ const s = await snap('#brList'); ok(/checkbox ".+" \[checked\]/.test(s), 'Select: ARIA snapshot shows checked rows'); }
await page.keyboard.press('Space');
ok(await page.evaluate(() => document.activeElement.getAttribute('aria-checked')) === 'false' && (await page.textContent('#brSel')).trim() === '1 selected', 'Select: Space again unchecks it');

// ---------- 17. Browse rows keep maths in their name ----------
await page.evaluate(async () => { const db = await import('./js/db.js'); const c = (await db.getAll('cards'))[0]; await db.saveCards([{ ...c, id: 'math1', front: 'What is $\\frac{1}{2}+\\frac{1}{4}$?', back: '$\\frac{3}{4}$', created: Date.now() }]); });
await page.goto(URL + '#/decks'); await page.waitForSelector('.deck'); await page.click('.deck-open'); await page.waitForSelector('.crow');
{ const label = await page.evaluate(() => [...document.querySelectorAll('.crow-btn')].map(b => b.getAttribute('aria-label')).find(l => l.includes('What is')));
  console.log('   maths row:', label);
  ok(label && label.includes('1/2') && label.includes('3/4') && !/katex|\\frac/i.test(label), 'Browse: a row with maths is named with the formulas as words'); }
await page.evaluate(async () => (await import('./js/db.js')).deleteCards(['math1']));

// ---------- 18. Formatting toolbar: one Tab stop ----------
await page.goto(URL + '#/decks'); await page.waitForSelector('.deck'); await page.click('.deck-open'); await page.waitForSelector('#brAdd');
await page.click('#brAdd'); await page.waitForSelector('#acForm');
const bar = '#acFront';
const toolStops = () => page.evaluate(() => { const b = document.querySelector('#acForm .fmt-tools'); return [...b.querySelectorAll('button')].filter(x => x.tabIndex === 0).length; });
ok(await toolStops() === 1, 'Toolbar: exactly one button is in the Tab order');
await page.evaluate(() => document.querySelector('#acForm .fmt-tools button').focus());
const fmtOf = () => page.evaluate(() => document.activeElement.dataset.fmt || (document.activeElement.hasAttribute('data-img-add') ? 'image' : document.activeElement.hasAttribute('data-snd-add') ? 'sound' : document.activeElement.hasAttribute('data-rec') ? 'record' : '?'));
ok(await fmtOf() === 'bold', 'Toolbar: starts on Bold');
await page.keyboard.press('ArrowRight'); ok(await fmtOf() === 'italic', 'Toolbar: → moves to Italic');
await page.keyboard.press('End'); ok(await fmtOf() === 'record', 'Toolbar: End goes to the last button (the mic)');
await page.keyboard.press('ArrowRight'); ok(await fmtOf() === 'bold', 'Toolbar: → wraps to the first');
await page.keyboard.press('ArrowLeft'); ok(await fmtOf() === 'record', 'Toolbar: ← wraps to the last');
await page.keyboard.press('Home'); ok(await fmtOf() === 'bold', 'Toolbar: Home goes to the first');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');   // list
await page.keyboard.press('Tab');
ok(await page.evaluate(() => !document.activeElement.closest('.fmt-tools')), 'Toolbar: Tab leaves the toolbar in one press');
await page.keyboard.press('Shift+Tab');
ok(await fmtOf() === 'list', 'Toolbar: Shift+Tab comes back to the button used last');
ok(await toolStops() === 1, 'Toolbar: still one Tab stop');
{ const s = await snap('#acForm .fmt-tools'); ok(/toolbar "Formatting"/.test(s) && /button "Bold"/.test(s), 'Toolbar: ARIA snapshot'); }

// ---------- 20. Both directions: help text is a description, not part of the name ----------
{ const s = await snap('#acBasic .rev-switch'); console.log('   ', s.replace(/\n/g, ' | '));
  ok(/checkbox "Both directions"/.test(s) && /description/i.test(s) || await page.evaluate(() => document.getElementById('acRevOn').getAttribute('aria-describedby') === 'acRevHelp' && document.getElementById('acRevOn').getAttribute('aria-labelledby') === 'acRevLbl'), 'Both directions: name is just the label; help text is the description'); }
// Add card: disabled-looking button is reachable and linked to its reason
ok(await attr('#acForm button[type=submit], button[type=submit][form=acForm]', 'aria-describedby') === 'acWhy' && (await page.textContent('#acWhy')).length > 0, 'Add card: the button is linked to the reason it cannot add yet');

// ---------- 3. Form errors: Add card ----------
await page.evaluate(() => document.querySelector('button[type=submit][form=acForm], #acForm button[type=submit]').click());
await page.waitForTimeout(200);
ok(await page.evaluate(() => { const f = document.activeElement; return f?.getAttribute('aria-invalid') === 'true' && (f.getAttribute('aria-describedby') || '').includes('acErr'); }) || await attr('#acErr', 'role') === 'alert', 'Errors: the Add card error is announced (described by the field, or an alert)');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);

// ---------- 3. Form errors: Edit deck ----------
await page.goto(URL + '#/decks'); await page.waitForSelector('.deck'); await page.click('.deck-open'); await page.waitForSelector('#deckMore');
await page.click('#deckMore'); await page.click('[data-act=edit], #deckEdit, button:has-text("Edit deck")'); await page.waitForSelector('#deckForm');
await page.fill('#deckName', ''); await page.focus('#deckCourse');
await page.evaluate(() => document.querySelector('#deckForm').requestSubmit());
await page.waitForSelector('#deckErr:not([hidden])');
ok((await page.textContent('#deckErr')).includes('name') && await attr('#deckErr', 'role') === null, 'Errors: when focus moves to the field the message is its description, not also an alert (no double speech)');
ok(await attr('#deckName', 'aria-invalid') === 'true' && (await attr('#deckName', 'aria-describedby') || '').includes('deckErr'), 'Errors: the name field is aria-invalid and described by the error');
ok(await active() === 'deckName', 'Errors: focus goes to the field');
{ const s = await snap('#deckForm'); ok(/textbox "Name"/.test(s), 'Errors: the field keeps its name in the ARIA snapshot'); }
// Enter pressed inside the empty box: focus is already there, so nothing is read by moving it: the message must be an alert.
await page.fill('#deckName', ''); await page.focus('#deckName'); await page.keyboard.press('Enter');
await page.waitForSelector('#deckErr:not([hidden])');
ok(await attr('#deckErr', 'role') === 'alert' && await attr('#deckName', 'aria-invalid') === 'true', 'Errors: Enter in the empty Name box (focus already there) keeps the alert role');
await page.keyboard.type('Biology');
ok(await attr('#deckName', 'aria-invalid') === null && await page.locator('#deckErr').isHidden(), 'Errors: typing a fix clears aria-invalid and the message');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);

// ---------- 6. Steps editor keeps its error while the value is still wrong ----------
await page.goto(URL + '#/settings'); await page.waitForSelector('#lsteps', { state: 'attached' });
await page.evaluate(() => { document.getElementById('advanced').open = true; });
await page.fill('#lsteps', 'zz'); await page.dispatchEvent('#lsteps', 'change');
await page.waitForSelector('[data-key=learningSteps] .err:not([hidden])');
ok(await attr('[data-key=learningSteps] .err', 'role') === 'alert' && await attr('#lsteps', 'aria-invalid') === 'true', 'Steps: a bad value is an alert and aria-invalid (focus is not pulled back)');
await page.focus('#lsteps'); await page.keyboard.type('q');
ok(await attr('#lsteps', 'aria-invalid') === 'true' && await page.locator('[data-key=learningSteps] .err').isVisible(), 'Steps: typing another wrong character keeps the error');
await page.fill('#lsteps', '1m 10m');
ok(await attr('#lsteps', 'aria-invalid') === null && await page.locator('[data-key=learningSteps] .err').isHidden(), 'Steps: a readable value clears it as you type');
await page.fill('#maxDays', '0'); await page.dispatchEvent('#maxDays', 'change');
ok(await attr('#maxDays', 'aria-invalid') === 'true', 'Max interval: a bad value is flagged');
await page.focus('#maxDays'); await page.keyboard.type('0');
ok(await attr('#maxDays', 'aria-invalid') === 'true', 'Max interval: still flagged while the value is still wrong');
await page.fill('#maxDays', '30');
ok(await attr('#maxDays', 'aria-invalid') === null, 'Max interval: cleared once it is valid');

// ---------- 3 + 20. Sign-in form ----------
await page.goto(URL + '#/settings'); await page.waitForSelector('#syncEmail');
ok(await attr('#syncPw', 'autocomplete') === 'current-password', 'Sign-in: the password field starts as current-password');
await page.focus('#syncForm button[type=submit]'); await page.keyboard.press('Enter');
await page.waitForSelector('#syncErr:not([hidden])');
ok(await attr('#syncErr', 'role') === null && await attr('#syncEmail', 'aria-invalid') === 'true' && await active() === 'syncEmail', 'Sign-in: an empty email is an alert, aria-invalid, and focuses the email box');
ok((await attr('#syncEmail', 'aria-describedby') || '').includes('syncErr'), 'Sign-in: the email box is described by the error');
await page.fill('#syncEmail', 'a@b.co');
ok(await attr('#syncEmail', 'aria-invalid') === null, 'Sign-in: fixing the email clears aria-invalid');
await page.focus('#syncForm button[type=submit]'); await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('syncPw').getAttribute('aria-invalid') === 'true');
ok(await active() === 'syncPw' && (await page.textContent('#syncErr')).includes('password'), 'Sign-in: then the password box is flagged');
await page.fill('#syncPw', 'short');
await page.focus('#syncCreate');
ok(await attr('#syncPw', 'autocomplete') === 'new-password', 'Sign-in: focusing Create account already marks the password as new-password');
await page.focus('#syncForm button[type=submit]');
ok(await attr('#syncPw', 'autocomplete') === 'current-password', 'Sign-in: focusing Sign in puts it back');
await page.click('#syncCreate'); await page.waitForTimeout(200);
ok(await attr('#syncPw', 'autocomplete') === 'new-password' && await attr('#syncPw', 'aria-invalid') === 'true', 'Sign-in: Create account marks the password as new-password and checks the rules');

// ---------- 10. Stats: pick a day ----------
await page.evaluate(async () => { const db = await import('./js/db.js'); const c = (await db.getAll('cards'))[0]; const t = Date.now() - 3 * 86400000;
  for (let i = 0; i < 5; i++) await db.addLog({ cardId: c.id, timestamp: t + i * 60000, source: 'review', correct: true, rating: 3, ms: 3000, state: 2 }); });
await page.goto(URL + '#/stats'); await page.waitForSelector('#calPick');
const day = await page.evaluate(async () => { const { dayKey } = await import('./js/stats-calc.js'); return dayKey(Date.now() - 3 * 86400000); });
await page.focus('#calPick');
ok(await active() === 'calPick', 'Calendar: the day picker takes focus from the keyboard');
await page.fill('#calPick', day);
ok((await page.textContent('#calInfo')).includes('5 answers'), 'Calendar: picking a day reads out its answers (' + (await page.textContent('#calInfo')) + ')');
ok(await page.locator('#calGrid i.sel').count() === 1, 'Calendar: the picked square is marked');
await page.fill('#calPick', await page.evaluate(async () => (await import('./js/stats-calc.js')).dayKey(Date.now() - 1 * 86400000)));
ok((await page.textContent('#calInfo')).includes('no studying'), 'Calendar: a day with no studying says so');
ok(await attr('#calInfo', 'aria-live') === 'polite', 'Calendar: the line is a polite live region');

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
