// Round 6, Add a card / Practice test / one home per action / the phone "+": the short Add a card sheet with a "More options" fold (also in
// the card editor), the Practice test sheet with a "Customise" fold, one shared "Count Play and test answers as reviews" setting,
// Find by tag and Suggest tags only in Browse -> Tools, and the "+" in the phone header of Today and Decks.
// Run with: node tests/browser/run.mjs addprac        (SHOTS=/some/folder saves screenshots of both styles on phone and PC)
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const THEMES = { original: { ui: 'original', skin: 'indigo', mode: 'dark', oled: false }, clinical: { ui: 'clinical', skin: 'ocean', mode: 'dark', oled: false } };
const FOLDS = ['study-sprint-fold-card-more', 'study-sprint-fold-test-custom'];

async function open(viewport, mobile, theme) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  // The shared test setup opens the folds; here they start closed, as on a new device, unless this test saves a choice.
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('ap-init')) { sessionStorage.setItem('ap-init', '1'); for (const k of ['study-sprint-fold-card-more', 'study-sprint-fold-test-custom']) localStorage.setItem(k, '0'); } } catch { /* fine */ } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e.stack));
  page.on('console', m => { if (m.type() === 'error' && !/katex|jsdelivr|Failed to load resource|net::ERR/i.test(m.text())) errors.push('console ' + m.text()); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async ({ theme }) => {
    const db = await import('./js/db.js');
    await db.setSetting('theme', theme);
    const cards = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: `Q ${id} ${i}?`, back: `A ${id} ${i}`, tags: i % 2 ? ['odd'] : ['even'], created: i + 1 }));
    await db.addDeckWithCards({ id: 'bio', name: 'Biology', color: '#3E63DD', created: 100 }, cards('bio', 12));
    await db.addDeckWithCards({ id: 'chem', name: 'Chemistry', color: '#3E63DD', created: 200 }, cards('chem', 12));
  }, { theme });
  await page.reload(); await page.waitForSelector('.deck');
  return page;
}
const shot = async (p, name) => { if (SHOTS) await p.waitForTimeout(600); if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const closeSheet = p => p.evaluate(() => { const s = document.getElementById('sheet'); if (s?.open) s.close(); });
const val = (p, sel) => p.evaluate(q => { const e = document.querySelector(q); return (e.value ?? e.textContent).trim(); }, sel);
const visible = (p, sel) => p.isVisible(sel);

for (const [styleName, theme] of Object.entries(THEMES)) for (const [size, vp, mobile] of [['phone', { width: 390, height: 844 }, true], ['pc', { width: 1440, height: 900 }, false]]) {
  const T = `${styleName} ${size}`, S = `${styleName}-${size}`;
  const p = await open(vp, mobile, theme);

  // ---------- the + button ----------
  await p.goto(APP + '#/today'); await p.waitForSelector('#optBtn');
  if (mobile) {
    const box = await p.locator('#addBtn').boundingBox();
    ok(await visible(p, '#addBtn') && Math.round(box.width) === 44 && Math.round(box.height) === 44 && await p.getAttribute('#addBtn', 'aria-label') === 'Add cards', `${T}: Today has a 44x44 "+" named "Add cards"`);
    await shot(p, `${S}-today-plus`);
    await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
    ok(await visible(p, '#addBtn'), `${T}: Decks has the "+"`);
    await p.goto(APP + '#/settings'); await p.waitForSelector('#playCounts');
    ok(!(await visible(p, '#addBtn')), `${T}: Settings does not`);
    await p.goto(APP + '#/today'); await p.waitForSelector('#optBtn');
    // the deck used last: Chemistry
    await p.evaluate(() => localStorage.setItem('study-sprint-import-last', 'chem'));
    await p.click('#addBtn'); await p.waitForSelector('#acForm');
    ok(await p.inputValue('#acDeck') === 'chem', `${T}: the + opens Add a card on the deck used last`);
    ok((await p.locator('#acDeck option').count()) >= 2, `${T}: and every deck can still be picked`);
    // a card added from here: stays open, keeps the tags, remembers the deck
    await p.fill('#acFront', 'Plus front'); await p.fill('#acBack', 'Plus back'); await p.fill('#acTags', 'keepme');
    await p.click('button[type=submit][form=acForm]'); await p.waitForTimeout(400);
    ok(await visible(p, '#acForm') && await p.inputValue('#acTags') === 'keepme' && (await val(p, '#acFront')) === '', `${T}: the sheet stays open for the next card and keeps the tags`);
    ok(await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).some(c => c.front === 'Plus front' && c.deckId === 'chem')), `${T}: the card went into the last-used deck`);
    await closeSheet(p);
    // no decks: what the sidebar's Add cards does (the Add cards screen)
    await p.evaluate(async () => { const db = await import('./js/db.js'); for (const d of await db.getDecks()) await db.deleteDeck?.(d.id); });
    if (await p.evaluate(async () => (await (await import('./js/db.js')).getDecks()).length) === 0) {
      await p.goto(APP + '#/today'); await p.waitForTimeout(300);
      if (await visible(p, '#addBtn')) { await p.click('#addBtn'); await p.waitForFunction(() => location.hash.startsWith('#/import')); ok(true, `${T}: with no decks the + goes to the Add cards screen`); }
    }
  } else {
    ok(!(await visible(p, '#addBtn')) && await visible(p, '.side-add'), `${T}: the + is not shown on a PC (the sidebar has Add cards)`);
  }
  await p.close(); await p.context().close();
}

// ---------- the folds, shared settings and one home per action (one run is enough) ----------
for (const [styleName, theme] of Object.entries(THEMES)) for (const [size, vp, mobile] of [['phone', { width: 390, height: 844 }, true], ['pc', { width: 1440, height: 900 }, false]]) {
  const T = `${styleName} ${size}`, S = `${styleName}-${size}`;
  const p = await open(vp, mobile, theme);
  await p.goto(APP + '#/deck/bio'); await p.waitForSelector('#brAdd');
  await p.click('#brAdd'); await p.waitForSelector('#acForm');
  ok(await p.getAttribute('#acMoreBtn', 'aria-expanded') === 'false' && !(await visible(p, '#acMore')), `${T}: Add a card starts with More options closed`);
  const shown = await p.evaluate(() => [...document.querySelectorAll('#acForm input, #acForm textarea, #acForm select, #acForm [contenteditable="true"], #acForm button')].filter(e => e.offsetParent !== null && !e.closest('[hidden]') && !e.closest('.field-tools,.fmt-tools')).length);
  ok(['#acFront', '#acBack', '#acTags', 'button[type=submit][form=acForm]', 'input[name=acKind][value=cloze]'].every(s => s) && await visible(p, '#acFront') && await visible(p, '#acBack') && await visible(p, '#acTags') && await visible(p, 'button[type=submit][form=acForm]'), `${T}: Front, Back, Tags and Add are showing (${shown} controls, formatting buttons included)`);
  ok(!(await visible(p, '#acHook')) && !(await visible(p, '#acRevOn')) && !(await visible(p, '#acTypeIn')) && !(await visible(p, '#acModeSteps')), `${T}: Memory hook, Both directions, Answer by and the answer types are hidden`);
  ok(!/Also asks the back/.test(await p.textContent('#acForm')), `${T}: the Both directions caption is gone`);
  ok((await p.textContent('#acWhy')).trim() === 'Needs front and back', `${T}: the reason reads "Needs front and back"`);
  await shot(p, `${S}-add-closed`);
  await p.click('#acMoreBtn');
  ok(await p.getAttribute('#acMoreBtn', 'aria-expanded') === 'true' && await visible(p, '#acHook') && await visible(p, '#acRevOn') && await visible(p, '#acTypeIn') && await visible(p, '#acModeSteps'), `${T}: More options shows the rest`);
  await shot(p, `${S}-add-open`);
  // remembered on this device
  await closeSheet(p); await p.waitForTimeout(400); await p.reload(); await p.waitForSelector('#brAdd'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  ok(await p.getAttribute('#acMoreBtn', 'aria-expanded') === 'true' && await visible(p, '#acHook'), `${T}: the open fold is remembered on this device`);
  await p.click('#acMoreBtn'); await closeSheet(p);
  await p.waitForTimeout(400); await p.reload(); await p.waitForSelector('#brAdd'); await p.click('#brAdd'); await p.waitForSelector('#acForm');
  ok(await p.getAttribute('#acMoreBtn', 'aria-expanded') === 'false', `${T}: and so is the closed one`);
  // an option still works from the fold: Both directions makes a pair
  await p.click('#acMoreBtn'); await p.check('#acRevOn'); await p.fill('#acFront', 'Pair front'); await p.fill('#acBack', 'Pair back');
  await p.click('button[type=submit][form=acForm]'); await p.waitForTimeout(500);
  ok(await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.front === 'Pair front' || c.front === 'Pair back').length) === 2, `${T}: Both directions from the fold still saves both cards`);
  await p.click('#acMoreBtn'); await closeSheet(p);

  // editor: closed for an ordinary card, open by itself when a hidden option is set
  await p.goto(APP + '#/deck/bio'); await p.waitForSelector('.crow-btn');
  await p.evaluate(() => localStorage.setItem('study-sprint-fold-card-more', '0'));
  await p.locator('.crow-btn').first().click(); await p.waitForSelector('#ceForm');
  ok(await p.getAttribute('#ceMoreBtn', 'aria-expanded') === 'false' && !(await visible(p, '#ceHook')), `${T}: the card editor has the same fold, closed for an ordinary card`);
  ok((await p.textContent('#sheet')).includes('Review it once first') && !(await p.textContent('#sheet')).includes('then you can set its due date'), `${T}: "Review it once first"`);
  await shot(p, `${S}-edit-closed`);
  await closeSheet(p);
  await p.evaluate(async () => { const db = await import('./js/db.js'); const c = (await db.getAll('cards')).find(x => x.deckId === 'bio' && x.front.startsWith('Q bio 3')); await db.saveCards([{ ...c, noteExtra: 'my hook', acceptAnswers: ['other'] }]); });
  await p.waitForTimeout(400); await p.reload(); await p.waitForSelector('.crow-btn');
  await p.locator('.crow-btn', { hasText: 'Q bio 3' }).first().click(); await p.waitForSelector('#ceForm');
  ok(await p.getAttribute('#ceMoreBtn', 'aria-expanded') === 'true' && (await val(p, '#ceHook')) === 'my hook', `${T}: a card with a Memory hook opens the fold by itself`);
  ok((await p.textContent('label:has(#ceAccept) span')).trim() === 'Other answers' && await p.getAttribute('#ceAccept', 'placeholder') === 'a, b', `${T}: "Other answers", placeholder "a, b"`);
  ok(await p.evaluate(() => localStorage.getItem('study-sprint-fold-card-more')) === '0', `${T}: opening by itself is not saved as a choice`);
  await closeSheet(p);

  // Practice test sheet
  await p.goto(APP + '#/deck/bio'); await p.waitForSelector('#testBtn'); await p.click('#testBtn'); await p.waitForSelector('#ptForm');
  ok(await p.getAttribute('#ptCustomBtn', 'aria-expanded') === 'false' && await visible(p, '#ptDeck') && await visible(p, 'input[name=count][value="20"]') && await visible(p, '#ptStart'), `${T}: the Practice test sheet shows Deck, number of questions and Start`);
  ok(!(await visible(p, 'input[name=kind]')) && !(await visible(p, 'input[name=limit]')) && !(await visible(p, 'input[name=order]')), `${T}: question types, time limit and order are under Customise`);
  ok(!(await p.$('#ptCounts')) && !/no time limit|questions from/.test(await p.textContent('#ptNote')), `${T}: no per-sheet counting switch, no "N questions from N cards" line`);
  ok(!!(await p.$('#ptForm a.help-link[aria-label]')) && !(await p.$('#ptCountsHelp')), `${T}: a "?" help link replaces the long caption`);
  await shot(p, `${S}-test-closed`);
  await p.click('#ptCustomBtn'); await p.waitForSelector('input[name=kind]', { state: 'visible' });
  await shot(p, `${S}-test-open`);
  // The last choices are saved for the deck when a test starts, and the sheet comes back with them.
  await p.locator('.chip:has(input[name=order][value=weak])').click();
  await p.click('#ptStart'); await p.waitForSelector('#tPrompt');
  await p.goto(APP + '#/deck/chem'); await p.waitForSelector('#testBtn'); await p.click('#testBtn'); await p.waitForSelector('#ptForm');
  ok(await p.isChecked('input[name=order][value=random]'), `${T}: another deck keeps its own choices`);
  await p.selectOption('#ptDeck', 'bio');
  ok(await p.isChecked('input[name=order][value=weak]'), `${T}: the choices made for a deck are remembered`);
  await closeSheet(p);
  await p.waitForTimeout(400); await p.reload(); await p.waitForSelector('#testBtn'); await p.click('#testBtn'); await p.waitForSelector('#ptForm');
  ok(await p.getAttribute('#ptCustomBtn', 'aria-expanded') === 'true', `${T}: Customise stays open on this device`);

  // one shared setting
  const shared = async on => { await closeSheet(p); await p.evaluate(async v => { await (await import('./js/db.js')).setSetting('playCountsAsReviews', v); }, on); };
  await shared(false);
  await p.goto(APP + '#/deck/bio'); await p.waitForSelector('#testBtn'); await p.click('#testBtn'); await p.waitForSelector('#ptForm'); await p.click('#ptStart'); await p.waitForSelector('#tPrompt');
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('study-sprint-test-run')).cfg.counts) === false, `${T}: with the setting off a test does not count`);
  await p.goto(APP + '#/deck/bio'); await shared(true);
  await p.goto(APP + '#/deck/bio'); await p.waitForSelector('#testBtn'); await p.click('#testBtn'); await p.waitForSelector('#ptForm');
  await p.click('#ptStart'); await p.waitForSelector('#tPrompt');
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('study-sprint-test-run')).cfg.counts) === true, `${T}: with the setting on a test counts, from the same setting Play uses`);
  await p.goto(APP + '#/settings'); await p.waitForTimeout(400); await p.reload(); await p.waitForSelector('#playCounts');
  ok((await p.textContent('#playCountsLbl')).trim() === 'Count Play and test answers as reviews' && await p.isChecked('#playCounts'), `${T}: Settings has the one switch, named for both`);
  await shared(false);

  // one home per action
  await p.goto(APP + '#/today'); await p.waitForSelector('#optBtn'); await p.click('#optBtn'); await p.click('#customBtn'); await p.waitForSelector('#csPostBtn');
  ok(!(await p.$('#csTagBtn')) && !/By tag or question ID/.test(await p.textContent('#sheet')), `${T}: Custom study has no "By tag or question ID"`);
  await closeSheet(p);
  await p.goto(APP + '#/deck/bio'); await p.waitForSelector('#deckMore'); await p.click('#deckMore');
  ok(!(await p.$('#autoTag')), `${T}: the deck's ⋯ menu has no Suggest tags`);
  await p.keyboard.press('Escape');
  await p.click('#brTags');
  ok(await visible(p, '#toolTagStudy') && await visible(p, '#toolAutoTag'), `${T}: Browse → Tools has both Find by tag or question ID and Suggest tags`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${T}: no sideways scroll`);
  await p.close(); await p.context().close();
}
if (errors.length) { for (const e of errors) console.log('FAIL ' + e); process.exitCode = 1; }
await browser.close();
