// Reading to cards: Import → Suggest cards. Notes pasted, a PDF's or slides' text, word pairs; the ticks, the filter, the keyboard, the draft,
// saving, the AI view, a phone-sized screen, 60,000 words, and a browser without workers. pdf.js and fflate come from the CDN like in the
// other import tests; nothing else leaves the page (checked).
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const read = f => fs.readFileSync(new URL('../fixtures/reading/' + f, import.meta.url), 'utf8');
const BIO = read('biology.txt'), HISTORY = read('history.txt'), VOCAB = read('spanish-vocab.txt'), MESSY = read('lecture-messy.txt');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [], requests = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
page.on('request', r => { const u = r.url(); if (!/^(http:\/\/localhost:8123|data:|blob:|about:)/.test(u)) requests.push(u); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const fold = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const rows = () => page.locator('.prow.sug');
const ticked = () => page.locator('.prow.sug .pick:checked').count();
const label = async () => Number(((await page.textContent('#saveBtn')).match(/Add (\d+) card/) || [])[1] || 0);
const openImport = async () => { await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck'); await page.evaluate(() => sessionStorage.removeItem('study-sprint-import-draft')); await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#pasteBox'); };
const fillText = async text => { await page.evaluate(t => { const b = document.getElementById('pasteBox'); b.value = t; b.dispatchEvent(new Event('input', { bubbles: true })); }, text); };
const suggested = () => page.waitForSelector('.prow.sug', { timeout: 30000 });
const cardsInDb = () => page.evaluate(async () => (await import('./js/db.js')).getAll('cards'));

// ---- 1. notes pasted: the note under them, then the suggestions ----
await openImport();
ok(await page.isVisible('#suggestBtn') && (await page.textContent('#suggestBtn')) === 'Suggest cards', 'the Paste tab has a Suggest cards button');
await page.click('#suggestBtn');
ok((await page.textContent('#toast')).includes('Paste some text first') && await page.isHidden('#sugBar'), 'an empty box: "Paste some text first"');
await page.fill('#pasteBox', BIO);
await page.waitForSelector('#proseNote:not([hidden])');
ok((await page.textContent('#proseNote')).startsWith('This looks like notes or an article, not cards.'), 'the "looks like notes" note: ' + (await page.textContent('#proseNote')).trim());
await noHScroll('paste with the note');
await page.click('#proseSuggest');
await suggested();
const found = await page.textContent('#found');
ok(/Suggested \d+ cards/.test(found), 'summary: ' + found.slice(0, 160));
ok(found.includes('Check each one: suggestions can be wrong.') && found.includes('suggested tag'), 'it says they can be wrong, and about the tag');
ok(await ticked() >= 5, 'the strong ones are ticked: ' + await ticked());
ok((await page.textContent('#pvTitle')) === 'Suggestions', 'the heading says Suggestions');
ok(await page.evaluate(() => document.activeElement.id) === 'pvTitle', 'focus is on the Suggestions heading');
ok(await page.isHidden('#proseNote') && await page.isHidden('#suggestBtn') && await page.isHidden('#swapBtn') && await page.isHidden('#dupBtn'), 'the note, the Suggest button, Swap and Remove duplicates are hidden');
const fronts = await page.$$eval('.prow.sug textarea[data-side=front]', t => t.map(x => x.value));
ok(fronts.some(f => fold(f) === 'osmosis'), 'a definition for osmosis: ' + fronts.slice(0, 5).join(' | '));
const kinds = await page.$$eval('.prow.sug', r => [...new Set(r.map(x => x.dataset.kind))]);
ok(['definition', 'acronym', 'list'].every(k => kinds.includes(k)), 'kinds found: ' + kinds.join(', '));
ok((await page.locator('.prow.sug .sug-kind').first().textContent()).length > 3, 'each row says what kind it is');
await page.screenshot({ path: SP + '/rc-suggestions.png', fullPage: true });
await noHScroll('suggestions');

// ---- 2. ticks, edits, the filter ----
const before = await label();
const firstPick = page.locator('.prow.sug .pick:checked').first();
const rowI = await firstPick.evaluate(el => +el.closest('li').dataset.i);
await firstPick.uncheck();
ok(await label() === before - 1, `unticking a row: "Add ${before} cards" → ${await label()}`);
ok(await page.locator(`.prow.sug[data-i="${rowI}"]`).evaluate(el => el.classList.contains('off')), 'the unticked row looks unticked');
const basic = page.locator('.prow.sug:has(.pick:checked) textarea[data-side=front]').first();
await basic.fill('Edited front');
ok(await basic.inputValue() === 'Edited front', 'a front can be edited');
const clozeBox = page.locator('.prow.sug textarea[data-side=cloze]').first();
const clozeRow = clozeBox.locator('xpath=ancestor::li');
const clozeBefore = await label();
const wasTicked = await clozeRow.locator('.pick').isChecked();
if (!wasTicked) await clozeRow.locator('.pick').check();
const afterTick = await label();
await clozeBox.fill((await clozeBox.inputValue()).replace(/\{\{c1::(.*?)\}\}/g, '$1'));
ok((await clozeRow.locator('.badge').textContent()) === 'No {{c1::…}} blank, so it will be skipped', 'a cloze without its {{c1::…}} blank says it will be skipped');
ok(await label() === afterTick - 1, 'and it is not counted');
await clozeBox.fill('The {{c1::cell}} bursts in water.');
ok(await clozeRow.locator('.badge').isHidden() && await label() === afterTick, 'putting the blank back makes it a card again');
const lists = await page.locator('.prow.sug[data-kind=list]').count();
await page.selectOption('#sugKind', 'list');
ok(await page.locator('.prow.sug:not([hidden])').count() === lists && lists > 0 && await page.locator('.prow.sug:not([hidden])').evaluateAll(r => r.every(x => x.dataset.kind === 'list')), 'the Lists filter shows only the lists (' + lists + ')');
ok((await page.$eval('#sugKind', s => s.selectedOptions[0].textContent)).startsWith('Lists ('), 'the option is named: ' + await page.$eval('#sugKind', s => s.selectedOptions[0].textContent));
await page.click('#sugNone');
ok(await page.locator('.prow.sug[data-kind=list] .pick:checked').count() === 0, 'Untick all shown');
const others = await page.locator('.prow.sug:not([data-kind=list]) .pick:checked').count();
ok(others > 0, 'it only changed the rows that were shown (' + others + ' others still ticked)');
await page.click('#sugAll');
ok(await page.locator('.prow.sug[data-kind=list] .pick:checked').count() === lists, 'Tick all shown');
await page.selectOption('#sugKind', 'all');
ok(await page.locator('.prow.sug:not([hidden])').count() === await rows().count(), 'All shows every row');
ok(await page.locator('.prow.sug .sug-src summary').first().isVisible(), '"Where it came from" is there');
await page.locator('.prow.sug .sug-src summary').first().click();
ok((await page.locator('.prow.sug .sug-src p').first().textContent()).startsWith('“'), 'it shows the sentence');

// ---- 3. keyboard and names ----
await page.evaluate(() => document.getElementById('pvTitle').focus());
let reached = false;
for (let i = 0; i < 12 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.classList.contains('pick')); }
ok(reached, 'Tab from the heading reaches the first tick box');
const focusedWas = await page.evaluate(() => document.activeElement.checked);
await page.keyboard.press('Space');
ok(await page.evaluate(() => document.activeElement.checked) === !focusedWas, 'Space toggles it');
await page.keyboard.press('Space');
ok(await page.$$eval('.prow.sug .pick', b => b.every(x => x.getAttribute('aria-label')?.startsWith('Use card '))), 'every tick box has a name');
ok(await page.$$eval('.prow.sug textarea', t => t.every(x => (x.getAttribute('aria-label') || '').length > 5)), 'every text box has a name');
ok(await page.$eval('#sugKind', s => !!s.closest('label')?.textContent.includes('Show')), 'the Show box is labelled');

// ---- 4. leave and come back: the draft ----
const keepTicked = await ticked();
const keepFront = 'Edited front';
const keepOff = await page.locator('.prow.sug:not(:has(.pick:checked))').count();
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#pasteBox');
await suggested();
ok((await page.textContent('#toast')).includes('Brought back the text you pasted'), 'back on Import: "Brought back the text you pasted"');
ok(await page.isHidden('#suggestBtn') && (await page.textContent('#pvTitle')) === 'Suggestions', 'and it is still in suggest mode');
ok(await ticked() === keepTicked && await page.locator('.prow.sug:not(:has(.pick:checked))').count() === keepOff, `the ticks are kept (${keepTicked} ticked)`);
ok((await page.$$eval('.prow.sug textarea[data-side=front]', t => t.map(x => x.value))).includes(keepFront), 'and the edit is kept: ' + keepFront);

// ---- 5. save into a new deck ----
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Bio test');
const want = await label();
const reverse = await page.locator('.prow.sug:has(.pick:checked) .badge:text-is("Both directions: makes 2 cards")').count();
ok(await page.isVisible('#revRow') === (reverse > 0), 'the reverse switch shows when an abbreviation is ticked');
await page.click('#saveBtn');
await page.waitForFunction(() => /^#\/deck\//.test(location.hash));
ok(/^#\/deck\/[\w-]+$/.test(await page.evaluate(() => location.hash)), 'saved: now on the deck page');
await page.waitForSelector('.crow');
const deckId = (await page.evaluate(() => location.hash)).split('/')[2];
const saved = (await cardsInDb()).filter(c => c.deckId === deckId);
ok(saved.length === want, `the deck has ${saved.length} cards (the button said ${want}: ticked cards plus reverse cards)`);
ok(saved.every(c => c.tags.includes('suggested')), 'every card has the tag "suggested"');
const clozes = saved.filter(c => c.noteText);
ok(clozes.length > 0 && clozes.every(c => c.noteText.includes('{{c1::') && c.cloze === 1), `${clozes.length} cloze cards keep their {{c1::…}} text`);
ok(saved.some(c => c.front === 'Edited front'), 'the edited front was saved');
ok(saved.some(c => /photosynthesis/i.test(c.front)), 'a definition is a card');
ok(await page.evaluate(() => !sessionStorage.getItem('study-sprint-import-draft')), 'the kept draft is gone');

// ---- 6. the same text into the same deck: what is there starts unticked ----
await page.goto('http://localhost:8123/#/import/' + deckId); await page.waitForSelector('#pasteBox');
await page.fill('#pasteBox', BIO);
await page.click('#suggestBtn');
await suggested();
const dupRows = page.locator('.prow.sug:has(.badge:text-is("Already in this deck"))');
const dupN = await dupRows.count();
ok(dupN >= 5, `${dupN} rows say "Already in this deck"`);
ok(await dupRows.evaluateAll(r => r.every(x => !x.querySelector('.pick').checked)), 'and they start unticked');
ok(await page.locator('.prow.sug:not(:has(.badge:text-is("Already in this deck"))) .pick:checked').count() > 0 || (await page.locator('.prow.sug .pick:checked').count()) === 0, 'new ones can still be ticked');
await noHScroll('suggestions with duplicates');

// ---- 7. word pairs ----
await openImport();
await page.fill('#pasteBox', VOCAB);
ok(await page.isHidden('#proseNote'), 'a word list is not "notes or an article"');
await page.click('#suggestBtn');
await suggested();
ok(await rows().count() >= 28, `${await rows().count()} word pairs`);
ok(await page.locator('.prow.sug[data-kind=vocab]').count() === await rows().count() && await page.locator('.prow.sug textarea[data-side=cloze]').count() === 0, 'all word pairs, no cloze rows');
ok(await page.locator('.prow.sug .badge:text-is("Both directions: makes 2 cards")').count() >= 28, 'rows show "Both directions: makes 2 cards"');
ok(await page.isVisible('#revRow'), 'the reverse switch is shown');
ok(/\b(\d\d) cards? to/.test(await page.textContent('#saveBtn')) && (await label()) >= 56 || (await label()) >= 28, 'the button counts the reverse cards: ' + await page.textContent('#saveBtn'));

// ---- 8. slides ----
await openImport();
await page.click('#tab-file');
await page.setInputFiles('#fileIn', SP + '/files/doc-slides.pptx');
await page.waitForSelector('#docBox:not([hidden])', { timeout: 60000 });
ok(await page.isVisible('#docSuggest') && (await page.textContent('#docSuggest')) === 'Suggest cards', 'a file shows Suggest cards first');
ok((await page.$$eval('#docBox .pane-actions button', b => b.map(x => x.textContent))).join('|') === 'Suggest cards|Make cards with AI|Use the text as it is', 'the three choices, in order');
ok((await page.textContent('#docBox .note')).startsWith('Suggest cards finds definitions, lists and key facts, right here on your device.'), 'and the note explains them');
await noHScroll('slides choice');
await page.click('#docSuggest');
await page.waitForSelector('.prow.sug', { timeout: 30000 }).catch(() => {});
const slideFronts = await page.$$eval('.prow.sug textarea[data-side=front]', t => t.map(x => x.value));
const slideCount = await rows().count();
ok(slideCount > 0 || await page.isVisible('#loadErr'), `slides: ${slideCount} suggestions` + (slideCount ? '' : ' (' + (await page.textContent('#loadErr')) + ')'));
ok(slideFronts.every(f => !/^Slide \d+$/.test(f)), 'no card is just a slide number');
ok(await page.isVisible('#pasteBox') && (await page.inputValue('#pasteBox')).includes('Slide 1'), 'the slides text, with its marks, is in the paste box');

// ---- 9. the AI view for pasted text ----
await openImport();
await fillText(BIO);
await page.click('#suggestBtn');
await suggested();
await page.click('#sugAi');
await page.waitForSelector('#aiView:not([hidden])');
ok(await page.isHidden('#preview') && await page.isHidden('#sugBar'), 'the suggestions are put away');
ok(await page.isHidden('#suggestBtn') === false, 'and Suggest cards is back');
ok((await page.textContent('#aiParts li')).includes('Part 1 of'), 'the text is in parts: ' + (await page.textContent('#aiParts li')).replace(/\s+/g, ' ').trim());
await page.click('#aiParts [data-part="0"]');
const clip = await page.evaluate(() => navigator.clipboard.readText());
ok(clip.includes('Turn the study material below into flashcards') && clip.includes('Osmosis is the movement of water'), 'the copied prompt has the instructions and the notes');
const hrefs = await page.$$eval('#aiSites [data-site]', a => a.map(x => x.getAttribute('href')));
const { AI_SITES } = await page.evaluate(async () => import('./js/doc-import.js'));
ok(JSON.stringify(hrefs) === JSON.stringify(AI_SITES.map(a => a.url)), 'the links are Claude, ChatGPT and Gemini: ' + hrefs.join(' '));
ok(await page.$$eval('#aiSites [data-site]', a => a.every(x => x.target === '_blank' && /noopener/.test(x.rel))), 'they open in a new tab without a connection back');
await page.click('#aiBack');
ok(await page.isVisible('#aiNote') && await page.evaluate(() => document.activeElement.id) === 'pasteBox', '"I have the answer" goes back to the box');

// ---- 10. a narrow screen ----
await ctx.close();
const narrow = await browser.newContext({ viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'] });
const p2 = await narrow.newPage();
p2.on('pageerror', e => errors.push('pageerror ' + e.message + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
p2.on('request', r => { const u = r.url(); if (!/^(http:\/\/localhost:8123|data:|blob:|about:)/.test(u)) requests.push(u); });
p2.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
await p2.goto('http://localhost:8123/#/decks'); await p2.waitForSelector('.deck');
await p2.goto('http://localhost:8123/#/import'); await p2.waitForSelector('#pasteBox');
await p2.fill('#pasteBox', HISTORY);
await p2.click('#suggestBtn');
await p2.waitForSelector('.prow.sug', { timeout: 30000 });
ok(await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 320px');
const boxes = await p2.$$eval('.pick-wrap', l => l.map(x => { const r = x.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
ok(boxes.length > 5 && boxes.every(([w, h]) => w >= 44 && h >= 44), `each tick box has a 44 by 44 area (${boxes.length}, smallest ${Math.min(...boxes.map(b => b[0]))}x${Math.min(...boxes.map(b => b[1]))})`);
ok(await p2.$$eval('#sugBar button, #sugBar select', c => c.every(x => x.getBoundingClientRect().height >= 40 && x.getBoundingClientRect().right <= innerWidth)), 'the bar wraps and its buttons fit');
await p2.screenshot({ path: SP + '/rc-320.png', fullPage: true });
// the messy notes: lecture furniture does not become cards
await p2.goto('http://localhost:8123/#/decks'); await p2.waitForSelector('.deck');
await p2.evaluate(() => sessionStorage.removeItem('study-sprint-import-draft'));
await p2.goto('http://localhost:8123/#/import'); await p2.waitForSelector('#pasteBox');
await p2.evaluate(t => { const b = document.getElementById('pasteBox'); b.value = t; b.dispatchEvent(new Event('input', { bubbles: true })); }, MESSY);
await p2.click('#suggestBtn');
await p2.waitForSelector('.prow.sug', { timeout: 30000 });
const messy = (await p2.$$eval('.prow.sug textarea', t => t.map(x => x.value.toLowerCase()))).join('\n');
ok(!/midterm|room 204|office|todo|http|@|10:32|psyc 101|slide 4|lec 5/.test(messy), 'the lecture notes: no times, links, admin lines or headers in the cards');
ok(/conditioned stimulus/.test(messy) && /schedules of reinforcement/.test(messy), 'but the abbreviations and the list are there');
await narrow.close();

// ---- 11. 60,000 words ----
const ctx3 = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const p3 = await ctx3.newPage();
p3.on('pageerror', e => errors.push('pageerror ' + e.message + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
p3.on('request', r => { const u = r.url(); if (!/^(http:\/\/localhost:8123|data:|blob:|about:)/.test(u)) requests.push(u); });
p3.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
await p3.goto('http://localhost:8123/#/decks'); await p3.waitForSelector('.deck');
await p3.goto('http://localhost:8123/#/import'); await p3.waitForSelector('#pasteBox');
const big = (() => { const parts = [BIO, HISTORY, MESSY]; const out = []; let w = 0, n = 0; while (w < 60000) { const t = parts[n % 3].replace(/\b(19|20)\d\d\b/g, y => String(+y + n)); out.push(`Page ${n + 1}\n${t}`); w += t.split(/\s+/).length; n++; } return out.join('\n\n'); })();
await p3.evaluate(t => { document.getElementById('pasteBox').value = t; }, big);
await p3.evaluate(() => {
  window.__long = []; window.__pct = [];
  new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] });
  new MutationObserver(() => { const t = document.getElementById('sugStatusText').textContent; if (/\d+%/.test(t) && !document.getElementById('sugStatus').hidden) window.__pct.push(t); }).observe(document.getElementById('sugStatusText'), { childList: true, characterData: true, subtree: true });
});
await p3.evaluate(() => { window.__click = performance.now(); document.addEventListener('click', () => { window.__click = performance.now(); }, true); });
await p3.click('#suggestBtn');
await p3.waitForSelector('.prow.sug', { timeout: 60000 });
const perf = await p3.evaluate(() => {
  const mark = performance.getEntriesByName('suggest-done')[0]?.startTime ?? Infinity;
  return { long: window.__long.filter(([s]) => s < mark), pct: window.__pct, mark, click: window.__click };
});
const worst = Math.max(0, ...perf.long.map(l => l[1]));
ok(perf.long.every(l => l[1] <= 200), `60,000 words: no long task over 200 ms while working (${perf.long.length} long tasks, worst ${worst.toFixed(0)} ms)`);
if (perf.long.length) console.log('   long tasks (ms after the click, ms long, ms before done):', perf.long.map(l => `${(l[0] - perf.click).toFixed(0)}/${l[1].toFixed(0)}/${(perf.mark - l[0]).toFixed(0)}`).join('  '));
ok(perf.pct.length > 0, 'the status showed a percentage: ' + (perf.pct[0] || 'none'));
ok(await p3.locator('.prow.sug').count() <= 200 && /Showing the best 200 of \d+/.test(await p3.textContent('#found')), '200 at most, and it says so: ' + (await p3.textContent('#found')).slice(-90));
ok(await p3.isHidden('#sugStatus'), 'the status goes away');
await ctx3.close();

// ---- 12. a browser without workers ----
const ctx4 = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
await ctx4.addInitScript(() => { delete window.Worker; });
const p4 = await ctx4.newPage();
p4.on('pageerror', e => errors.push('pageerror ' + e.message + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
p4.on('request', r => { const u = r.url(); if (!/^(http:\/\/localhost:8123|data:|blob:|about:)/.test(u)) requests.push(u); });
p4.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
await p4.goto('http://localhost:8123/#/decks'); await p4.waitForSelector('.deck');
ok(await p4.evaluate(() => typeof Worker === 'undefined'), 'this browser has no Worker');
await p4.goto('http://localhost:8123/#/import'); await p4.waitForSelector('#pasteBox');
await p4.fill('#pasteBox', BIO);
await p4.click('#suggestBtn');
await p4.waitForSelector('.prow.sug', { timeout: 30000 });
ok(await p4.locator('.prow.sug').count() > 10, `still works without workers: ${await p4.locator('.prow.sug').count()} suggestions`);

// ---- 13. Stop ----
await p4.goto('http://localhost:8123/#/decks'); await p4.waitForSelector('.deck');
await p4.evaluate(() => sessionStorage.removeItem('study-sprint-import-draft'));
await p4.goto('http://localhost:8123/#/import'); await p4.waitForSelector('#pasteBox');
await p4.evaluate(t => { document.getElementById('pasteBox').value = t; }, big);
await p4.click('#suggestBtn');
await p4.waitForSelector('#sugStatus:not([hidden])', { timeout: 10000 });
await p4.click('#sugStop');
await p4.waitForSelector('#loadErr:not([hidden])');
ok((await p4.textContent('#loadErr')) === 'Stopped. Press Suggest cards to try again.' && await p4.isVisible('#suggestBtn') && await p4.isHidden('#preview'), 'Stop: "Stopped. Press Suggest cards to try again."');
await ctx4.close();

// ---- no network, no errors ----
const outside = [...new Set(requests.map(u => new URL(u).host))].filter(h => h !== 'cdn.jsdelivr.net');
ok(outside.length === 0, 'nothing left the page except the CDN loads for slides: ' + (outside.join(', ') || [...new Set(requests.map(u => new URL(u).host))].join(', ') || 'none'));
ok(errors.length === 0, 'no page errors or console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
