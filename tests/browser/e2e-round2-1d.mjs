// Round 2, coder 1D: the Import screen (A3), the card editor and Welcome polish (A6), and three bug-hunt fixes:
// #1 double-click Add makes one card, #5 CSV round trip through the Import screen, #7 Escape on the docked editor
// puts the focus back on the card row.
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const SHOTS = process.env.SHOTS || SP;
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const newPage = async (w, h, scheme = 'dark') => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: scheme, isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message + ' ' + String(e.stack).split('\n').slice(1, 3).join(' ')));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return p;
};
const noHScroll = async (p, w) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const go = async (p, hash, sel) => { await p.goto('about:blank'); await p.goto(URL + hash); await p.waitForSelector(sel); };
const kind = (p, name) => p.locator('.kind-switch .chip', { hasText: name }).click();
const paste = async (p, text, contains) => { await p.fill('#pasteBox', text); await p.waitForFunction(c => document.querySelector('#found')?.textContent.includes(c), contains); };
const setLight = p => p.evaluate(async () => { const th = (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: 'light' }); await (await import('./js/db.js')).setSetting('theme', th); });
const cards = p => p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')));
const deckCards = (p, name) => p.evaluate(async name => { const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === name);
  return (await db.getAll('cards')).filter(c => c.deckId === d.id).sort((a, b) => a.created - b.created); }, name);

// ---------------- 375, dark ----------------
let p = await newPage(375, 780);
await go(p, '#/deck/sample', '.crow');
const base = (await cards(p)).length;

// ---- bug #1: a double click on Add makes one card ----
await p.click('#brAdd'); await p.waitForSelector('#acFront');
await p.fill('#acFront', 'Dbl front'); await p.fill('#acBack', 'Dbl back');
await p.evaluate(() => { const f = document.getElementById('acForm'); f.requestSubmit(); f.requestSubmit(); });
await p.waitForFunction(() => document.getElementById('acFront').value === '');
await p.waitForTimeout(300);
ok((await cards(p)).filter(c => c.front === 'Dbl front').length === 1 && (await cards(p)).length === base + 1, 'bug 1: two quick Adds of a basic card make one card');
await kind(p, 'Cloze'); await p.waitForSelector('#acText');
await p.fill('#acText', 'The {{c1::cell}} has a {{c2::nucleus}}');
await p.evaluate(() => { const f = document.getElementById('acForm'); f.requestSubmit(); f.requestSubmit(); });
await p.waitForFunction(() => document.getElementById('acText').value === '');
await p.waitForTimeout(300);
ok((await cards(p)).filter(c => c.noteText === 'The {{c1::cell}} has a {{c2::nucleus}}').length === 2, 'bug 1: two quick Adds of a 2-blank cloze make 2 cards, not 4');
await p.click('#acDone');

await p.click('#brAdd'); await p.waitForSelector('#acForm');
await kind(p, 'Basic'); await p.waitForSelector('#acFront');
await kind(p, 'Basic');
ok((await p.textContent('#acDone')).trim() === 'Close', 'the add panel button says Close, not Done');
ok(await p.getAttribute('button[type=submit][form=acForm]', 'aria-describedby') === 'acWhy' && await p.getAttribute('button[type=submit][form=acForm]', 'aria-disabled') === 'true', 'Add is aria-disabled and described by the reason');
ok(await p.isDisabled('button[type=submit][form=acForm]') && (await p.textContent('#acWhy')).toLowerCase().includes('front'), 'Add is disabled and the reason says what is missing: ' + await p.textContent('#acWhy'));
await p.fill('#acFront', 'Only a front');
ok(await p.isDisabled('button[type=submit][form=acForm]') && (await p.textContent('#acWhy')).toLowerCase().includes('back'), 'with a front only, the reason asks for the back: ' + await p.textContent('#acWhy'));
await p.fill('#acBack', 'and a back');
ok(!(await p.isDisabled('button[type=submit][form=acForm]')) && (await p.locator('#acWhy').isHidden() || (await p.textContent('#acWhy')).trim() === ''), 'with both sides Add is enabled and the reason is gone');
await p.fill('#acBack', '');
ok(await p.isDisabled('button[type=submit][form=acForm]'), 'emptying a side disables Add again');
await p.fill('#acBack', 'and a back');
const basicH = await p.$eval('.kind-body', e => e.getBoundingClientRect().height);
await p.screenshot({ path: SHOTS + '/1d-editor-basic-375-dark.png' });
await kind(p, 'Cloze'); await p.waitForSelector('#acText');
ok(await p.isDisabled('button[type=submit][form=acForm]') && (await p.textContent('#acWhy')).toLowerCase().includes('word'), 'cloze: disabled until a word is hidden: ' + await p.textContent('#acWhy'));
const clozeText = await p.$eval('#acCloze', e => e.textContent);
ok(!clozeText.includes('{{') && !(await p.getAttribute('#acText', 'placeholder') || '').includes('{{'), 'cloze help and placeholder have no raw {{ }} code');
ok((await p.textContent('#acCloze')).includes('Same blank as the last one'), 'the second blank button says "Same blank as the last one"');
const clozeH = await p.$eval('.kind-body', e => e.getBoundingClientRect().height);
await kind(p, 'Image occlusion');
const occH = await p.$eval('.kind-body', e => e.getBoundingClientRect().height);
ok(Math.abs(basicH - occH) < 2 && clozeH >= basicH && basicH >= 280, `the kind body has a fixed minimum height, so Basic and an empty Image occlusion are the same (${basicH}, ${occH}; cloze needs more: ${clozeH})`);
ok(await p.isDisabled('button[type=submit][form=acForm]') && (await p.textContent('#acWhy')) === 'Choose a picture first.', 'occlusion: disabled until a picture: ' + await p.textContent('#acWhy'));
await kind(p, 'Cloze');
await p.fill('#acText', 'The cell has a nucleus');
ok(await p.isDisabled('button[type=submit][form=acForm]'), 'cloze text without a blank is still disabled');
await p.fill('#acText', 'The {{c1::cell}} has a nucleus');
ok(!(await p.isDisabled('button[type=submit][form=acForm]')), 'cloze text with a blank enables Add');
await p.screenshot({ path: SHOTS + '/1d-editor-cloze-375-dark.png' });
const gaps = await p.evaluate(() => {
  const f = document.getElementById('acForm'), cs = getComputedStyle(f);
  const s3 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s-3')) || null;
  const probe = document.createElement('div'); probe.style.height = 'var(--s-3)'; document.body.append(probe);
  const px = probe.getBoundingClientRect().height; probe.remove();
  return { row: parseFloat(cs.rowGap), px, s3, margins: [...f.querySelectorAll(':scope > .field')].map(x => parseFloat(getComputedStyle(x).marginTop)) };
});
ok(gaps.row === gaps.px && gaps.margins.every(m => m === 0), `fields are spaced by one --s-3 gap (${gaps.row}px)`);
await noHScroll(p, 'add card panel');
await p.click('#acDone');

// ---- Import (A3) ----
await go(p, '#/import', '#pasteBox');
ok(await p.$eval('#deckSel', s => s.value) === '__new' && !(await p.$('#eyebrowIMPORT')) && !(await p.locator('.eyebrow').count()), 'import starts on a new deck, with no IMPORT eyebrow');
const tops = await p.evaluate(() => ({ sel: document.getElementById('deckSel').getBoundingClientRect().top, paste: document.getElementById('pasteBox').getBoundingClientRect().top }));
ok(tops.sel < tops.paste, 'the deck picker is above the paste box');
await paste(p, 'Mitosis - cell division\nMeiosis - makes gametes\nCell - the {{c1::basic}} unit of {{c2::life}}', 'Found 4 cards');
ok(!(await p.$('#clozeBtn')), 'the "Make cloze notes" button is gone');
const found = await p.textContent('#found');
ok(found.includes('Found 4 cards') && found.includes('plus 1 cloze note') && !found.toLowerCase().includes('make cloze notes'), 'cloze lines are included: ' + found.slice(0, 110));
const badges = await p.$$eval('.prow .badge:not([hidden])', b => b.map(x => x.textContent));
ok(badges.length === 2 && badges.every(t => /^Cloze card c\d/.test(t)) && !badges.some(t => t.includes('Missing a side')), 'the cloze rows are badged, no "Missing a side": ' + badges);
ok((await p.textContent('#clozeToggle')) === 'Keep {{c1::…}} lines as plain cards', 'the link to keep them as plain cards');
ok((await p.textContent('#saveBtn')) === 'Add 4 cards' && await p.isVisible('#saveHint') && (await p.textContent('#saveHint')) === 'Name the new deck above', 'unnamed new deck: "Add 4 cards" and the hint');
await p.screenshot({ path: SHOTS + '/1d-import-newdeck-375-dark.png', fullPage: true });
await p.evaluate(() => document.getElementById('preview').scrollIntoView());
await p.screenshot({ path: SHOTS + '/1d-import-preview-375-dark.png' });
await p.fill('#newName', 'Cells');
ok((await p.textContent('#saveBtn')) === 'Add 4 cards to “Cells”' && await p.isHidden('#saveHint'), 'named: Add 4 cards to “Cells”');
for (const t of [await p.textContent('#saveBtn'), await p.textContent('#saveHint'), await p.textContent('#found')]) ok(!/new deck/i.test(t) || t === 'Name the new deck above', 'wording: no "new deck" in ' + JSON.stringify(t.slice(0, 40)));
await p.click('#clozeToggle');
await p.waitForFunction(() => document.querySelector('#found').textContent.includes('Found 3 cards'));
ok((await p.textContent('#found')).includes('Found 3 cards') && (await p.locator('.prow .badge:not([hidden])').count()) === 0, 'keep as plain cards: the lines are plain cards');
await p.fill('#pasteBox', 'Mitosis - cell division\nMeiosis - makes gametes\nCell - the {{c1::basic}} unit of {{c2::life}}');
await p.waitForFunction(() => document.querySelector('#found').textContent.includes('Found 4 cards'));
ok(true, 'new text brings the cloze notes back');
await noHScroll(p, 'import with preview');
await p.click('#saveBtn'); await p.waitForSelector('.crow');
let cs = await deckCards(p, 'Cells');
ok(cs.length === 4 && cs.filter(c => c.noteId).length === 2 && new Set(cs.filter(c => c.noteId).map(c => c.noteId)).size === 1, 'saved: 2 plain cards and a cloze note with 2 cards');
// opened from the library the next import starts on a new deck (not the one used last); from a deck page it is that deck
await go(p, '#/import', '#pasteBox');
ok(await p.$eval('#deckSel', s => s.value) === '__new' && await p.isVisible('#newName'), 'an import opened from the library starts on a new deck, not the deck of the last import');
const cellsId = await p.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(x => x.name === 'Cells').id);
await go(p, '#/import/' + cellsId, '#pasteBox');
ok((await p.$eval('#deckSel', s => s.selectedOptions[0].dataset.name)) === 'Cells' && await p.isHidden('#newName'), 'opened from the deck page, that deck is chosen');
await paste(p, 'a - b', 'Found 1 card');
ok((await p.textContent('#saveBtn')) === 'Add 1 card to “Cells”' && await p.isHidden('#saveHint'), 'existing deck: Add 1 card to “Cells”');
// a deck that no longer exists is not preselected
await p.evaluate(async () => { const db = await import('./js/db.js'); const d = (await db.getDecks()).find(x => x.name === 'Cells'); await db.deleteDeck(d.id); });
await go(p, '#/import/' + cellsId, '#pasteBox');
ok(await p.$eval('#deckSel', s => s.value) === '__new', 'a deleted deck in the address falls back to a new deck');
// all cloze lines
await paste(p, 'Water is {{c1::H2O}}\nSalt is {{c1::NaCl}}', 'Found 2 cards');
ok((await p.textContent('#found')).includes('Found 2 cards, as cloze notes') && !(await p.textContent('#found')).includes('Missing'), 'only cloze lines: "as cloze notes"');
// CSV text with tags and a multi-line cell
await paste(p, 'Front,Back,Tags\r\nTopic,"Intro\n\n- one\n- two",bio week1\r\n\'-5 degrees,cold,\r\n', 'Tags come along');
ok((await p.textContent('#found')).includes('Found 2 cards') && (await p.textContent('#found')).includes('Tags come along too'), 'CSV paste: 2 cards, tags come along: ' + (await p.textContent('#found')).slice(0, 120));
ok((await p.$$eval('.prow textarea', t => t.map(x => x.value))).join('|') === 'Topic|Intro\n\n- one\n- two|-5 degrees|cold', 'the multi-line cell keeps its blank line and bullets, and the guarded -5 degrees comes back');
await p.fill('#newName', 'CSV deck'); await p.click('#saveBtn'); await p.waitForSelector('.crow');
cs = await deckCards(p, 'CSV deck');
ok(cs.length === 2 && cs[0].tags.join() === 'bio,week1' && cs[0].back === 'Intro\n\n- one\n- two', 'saved with its tags and the cell intact');

// ---------------- 1440 ----------------
const d = await newPage(1440, 900);
await go(d, '#/deck/sample', '.crow');
// bug #7: Escape on the docked editor puts the focus back on the card row
const row = d.locator('.crow').nth(2);
await row.click(); await d.waitForSelector('#sheet.side[open]');
await d.keyboard.press('Escape');
await d.waitForFunction(() => !document.getElementById('sheet').open);
ok(await d.evaluate(() => !!document.activeElement?.closest('.crow')), 'bug 7: Escape on the docked editor returns the focus to the card row, not ' + await d.evaluate(() => document.activeElement?.tagName));
ok(await d.evaluate(() => document.activeElement?.closest('.crow')?.dataset.id) === await row.getAttribute('data-id'), 'bug 7: it is the same row that was opened');
// the docked add panel
await d.click('#brAdd'); await d.waitForSelector('#acForm');
await d.screenshot({ path: SHOTS + '/1d-editor-basic-1440-dark.png' });
ok(await d.isDisabled('button[type=submit][form=acForm]'), '1440: Add is disabled on an empty form');
await d.click('#acDone');
ok(await d.evaluate(() => !!document.activeElement?.closest('#brAdd, .crow')), 'closing the add panel returns the focus to the Add card button');
// import at 1440
await go(d, '#/import', '#pasteBox');
await d.fill('#pasteBox', 'Mitosis - cell division\nCell - the {{c1::basic}} unit of {{c2::life}}');
await d.waitForSelector('#preview:not([hidden])');
await d.screenshot({ path: SHOTS + '/1d-import-1440-dark.png', fullPage: true });

// ---------------- light skins ----------------
const l = await newPage(375, 780, 'light');
await go(l, '#/import', '#pasteBox'); await setLight(l);
await l.fill('#pasteBox', 'Mitosis - cell division\nCell - the {{c1::basic}} unit of {{c2::life}}');
await l.waitForSelector('#preview:not([hidden])');
await l.fill('#newName', 'Light deck');
await l.screenshot({ path: SHOTS + '/1d-import-375-light.png', fullPage: true });
await l.evaluate(() => document.getElementById('preview').scrollIntoView());
await l.screenshot({ path: SHOTS + '/1d-import-preview-375-light.png' });
await go(l, '#/deck/sample', '.crow');
await l.click('#brAdd'); await l.waitForSelector('#acForm');
await l.screenshot({ path: SHOTS + '/1d-editor-basic-375-light.png' });
ok(await l.evaluate(() => document.documentElement.dataset.theme === 'light'), 'the light skin is on for the light screenshots');
const dl = await newPage(1440, 900, 'light');
await go(dl, '#/import', '#pasteBox'); await setLight(dl);
await dl.fill('#pasteBox', 'Mitosis - cell division\nCell - the {{c1::basic}} unit of {{c2::life}}');
await dl.waitForSelector('#preview:not([hidden])');
await dl.screenshot({ path: SHOTS + '/1d-import-1440-light.png', fullPage: true });
await go(dl, '#/browse', '.crow');
ok(!(await dl.locator('.eyebrow').count()), 'Browse has no BROWSE eyebrow');
await dl.screenshot({ path: SHOTS + '/1d-browse-1440-light.png' });

ok(errors.length === 0, 'no page errors or console errors ' + errors.join(' | '));
await browser.close();
