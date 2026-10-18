// PDF and slides into cards: a text PDF, a scanned PDF, a .pptx, the AI prompt in parts, the ai-made tag, the size limit and Android's Share Target.
// pdf.js and fflate come from the CDN, like Excel and Anki files do in the other import tests.
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|InvalidPDFException/.test(m.text())) errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noHScroll = async w => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const fronts = () => page.$$eval('.prow textarea[data-side=front]', t => t.map(x => x.value));
const backs = () => page.$$eval('.prow textarea[data-side=back]', t => t.map(x => x.value));
const openFile = async () => { await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck'); await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file'); };
const ready = () => page.waitForSelector('#docBox:not([hidden])', { timeout: 60000 });

// ---- a PDF with text ----
await openFile();
ok((await page.getAttribute('#fileIn', 'accept')).includes('.pdf') && (await page.getAttribute('#fileIn', 'accept')).includes('.pptx'), 'the file box accepts .pdf and .pptx');
await page.setInputFiles('#fileIn', SP + '/files/doc-text.pdf');
await ready();
ok((await page.textContent('#docInfo')).includes('2 pages'), 'PDF read: ' + await page.textContent('#docInfo'));
ok(await page.isHidden('#docNotesRow'), 'no speaker-notes switch for a PDF');
ok(await page.isVisible('#docAi') && await page.isVisible('#docRaw'), 'the two choices are shown');
await noHScroll('PDF choice');
await page.screenshot({ path: SP + '/doc-choice.png', fullPage: true });

// (b) the text as it is
await page.click('#docRaw');
await page.waitForSelector('#preview:not([hidden])');
const found = await page.textContent('#found');
ok(found.includes('Found 2 cards') && found.includes('blocks'), 'as-is: ' + found);
ok((await fronts()).join('|') === 'Page 1|Page 2', 'fronts are the page headings');
ok((await backs())[0].includes('Mitosis - cell division into two identical cells') && (await backs())[0].includes('Meiosis'), 'a page\'s text is the back (lines not split apart)');
ok(await page.isVisible('#pasteBox') && (await page.inputValue('#pasteBox')).startsWith('Page 1\nMitosis'), 'the text is in the paste box, ready to edit');
ok(!(await page.textContent('#found')).includes('Tags come along'), 'as-is cards carry no ai-made tag');
await noHScroll('as-is preview');
await page.screenshot({ path: SP + '/doc-raw.png', fullPage: true });

// ---- a scanned PDF ----
await openFile();
await page.setInputFiles('#fileIn', SP + '/files/doc-scanned.pdf');
await page.waitForSelector('#loadErr:not([hidden])', { timeout: 60000 });
ok((await page.textContent('#loadErr')) === "This PDF has no text in it (it's probably scanned). Try a PDF with selectable text.", 'scanned PDF message');
ok(await page.isHidden('#docBox') && await page.isHidden('#preview'), 'nothing offered for a scanned PDF');
// then a good file clears the message
await page.setInputFiles('#fileIn', SP + '/files/doc-text.pdf');
await ready();
ok(await page.isHidden('#loadErr'), 'the message goes away with the next file');

// ---- the size limit ----
fs.writeFileSync(SP + '/files/huge.pdf', Buffer.alloc(51 * 1024 * 1024));
await page.setInputFiles('#fileIn', SP + '/files/huge.pdf');
await page.waitForSelector('#loadErr:not([hidden])');
ok((await page.textContent('#loadErr')).includes('over 50 MB') && await page.isHidden('#docBox'), 'a file over 50 MB is refused: ' + await page.textContent('#loadErr'));
await page.setInputFiles('#fileIn', { name: 'junk.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf') });
await page.waitForSelector('#loadErr:not([hidden])', { timeout: 30000 });
ok((await page.textContent('#loadErr')).startsWith("Couldn't read junk.pdf"), 'a broken PDF is explained: ' + await page.textContent('#loadErr'));

// ---- slides ----
await openFile();
await page.setInputFiles('#fileIn', SP + '/files/doc-slides.pptx');
await ready();
ok((await page.textContent('#docInfo')).includes('3 slides'), 'slides read: ' + await page.textContent('#docInfo'));
ok(await page.isVisible('#docNotesRow'), 'speaker-notes switch shown (one slide has notes)');
// (a) AI
await page.click('#docAi');
await page.waitForSelector('#aiView:not([hidden])');
ok((await page.locator('#aiParts li').count()) === 1, 'one part for a short deck');
ok((await page.textContent('#aiParts li')).includes('Part 1 of 1'), 'part label');
await page.click('#aiParts [data-part="0"]');
let clip = await page.evaluate(() => navigator.clipboard.readText());
ok(clip.startsWith('Turn the study material below into flashcards for an exam.'), 'prompt copied');
ok(clip.includes('Source: "the sentence from the material"') && !clip.includes('part 1 of 1'), 'source line asked for, no part line for one part');
ok(clip.indexOf('Slide 1: Cell cycle') < clip.indexOf('Slide 2: Photosynthesis') && clip.indexOf('Slide 2: Photosynthesis') < clip.indexOf('Slide 3: Genetics'), 'slides are in show order');
ok(clip.includes('red & blue light') && clip.includes('Notes: Remember the Calvin cycle') && !clip.includes('\n2\n'), 'text, entity, notes in; slide number out');
await page.uncheck('#docNotes');
await page.click('#aiParts [data-part="0"]');
clip = await page.evaluate(() => navigator.clipboard.readText());
ok(!clip.includes('Calvin cycle'), 'notes can be left out');
ok((await page.textContent('#docInfo')).includes('3 slides'), 'info line after the switch');
await page.screenshot({ path: SP + '/doc-ai.png', fullPage: true });
await noHScroll('AI view');
// the AI sites: link, copy first
await page.evaluate(() => document.addEventListener('click', e => { if (e.target.closest('[data-site]')) e.preventDefault(); }, true));
const hrefs = await page.$$eval('#aiSites a', a => a.map(x => x.href + '|' + x.target + '|' + x.rel));
ok(hrefs.join(' ') === 'https://claude.ai/new|_blank|noopener https://chatgpt.com/|_blank|noopener https://gemini.google.com/app|_blank|noopener', 'Claude, ChatGPT and Gemini links open in a new tab');
await page.evaluate(() => navigator.clipboard.writeText('old'));
await page.click('#aiSites [data-site="gemini"]');
await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith('Turn the study material'));
ok(true, 'the site buttons copy the prompt');
// back with the answer
await page.click('#aiBack');
ok(await page.isVisible('#pasteBox') && await page.isVisible('#aiNote'), 'back to the paste box with a note about the answer');
await page.fill('#pasteBox', 'Interphase | The phase before mitosis. Source: "Interphase comes before mitosis"\nAllele | A version of a gene. Source: "An allele is a version of a gene"');
await page.waitForSelector('#preview:not([hidden])');
ok((await page.textContent('#found')).includes('Found 2 cards') && (await page.textContent('#found')).includes('Tags come along too'), 'AI answer read, tags mentioned: ' + await page.textContent('#found'));
ok((await backs())[0] === 'The phase before mitosis. Source: "Interphase comes before mitosis"', 'the source sentence stays on the back');
await page.selectOption('#deckSel', '__new'); await page.fill('#newName', 'Slides');
await page.click('#saveBtn'); await page.waitForSelector('.crow');
const tags = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.front === 'Allele').map(c => c.tags));
ok(JSON.stringify(tags) === '[["ai-made"]]', 'saved cards have the ai-made tag: ' + JSON.stringify(tags));

// the same slides, as-is: heading with the slide's title, no tag
await openFile();
await page.setInputFiles('#fileIn', SP + '/files/doc-slides.pptx');
await ready();
await page.click('#docRaw');
await page.waitForSelector('#preview:not([hidden])');
ok((await fronts()).join('|') === 'Slide 1: Cell cycle|Slide 2: Photosynthesis|Slide 3: Genetics', 'slide titles are the fronts');
ok((await backs())[1].includes('Notes: Remember the Calvin cycle'), 'notes come along as a Notes: line');

// ---- a long file: parts ----
await openFile();
await page.setInputFiles('#fileIn', SP + '/files/doc-long.pptx');
await ready();
await page.click('#docAi');
await page.waitForSelector('#aiView:not([hidden])');
const nParts = await page.locator('#aiParts li').count();
ok(nParts === 3, 'a long deck is split in parts: ' + nParts);
ok((await page.textContent('#aiParts li:nth-child(2)')).includes('Part 2 of 3'), '"Part 2 of 3"');
await page.click('#aiParts [data-part="1"]');
clip = await page.evaluate(() => navigator.clipboard.readText());
ok(clip.includes('This is part 2 of 3 of the same material. Make cards for this part only.') && clip.length < 13500, 'part 2 prompt: ' + clip.length + ' characters');
ok(/Slide \d+: Topic \d+/.test(clip) && !clip.includes('Slide 1: Topic 1\n'), 'part 2 holds later slides');
ok((await page.textContent('#aiParts [data-part="1"]')) === 'Copied', 'the copied part is marked');
await page.click('#aiSites [data-site="claude"]');
await page.waitForTimeout(300);
ok((await page.evaluate(() => navigator.clipboard.readText())).includes('part 2 of 3'), 'the open buttons copy the chosen part');
await noHScroll('three parts');
await page.screenshot({ path: SP + '/doc-parts.png', fullPage: true });

// ---- Share → Study Sprint ----
// What the service worker keeps for the screen, read by the screen (the worker's own part is checked below).
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async () => {
  const c = await caches.open('study-sprint-share');
  await c.put(new URL('share-target/text', document.baseURI), new Response(JSON.stringify({ title: '', text: 'Cell - the unit of life\nAtom - the unit of matter', url: '' })));
});
await page.goto('http://localhost:8123/#/import/share'); await page.waitForSelector('#pasteBox');
await page.waitForSelector('#preview:not([hidden])');
ok((await fronts()).join('|') === 'Cell|Atom', 'shared text lands in the paste box and preview');
ok((await page.evaluate(async () => (await (await caches.open('study-sprint-share')).keys()).length)) === 0, 'and the saved share is cleared');
await page.evaluate(async () => { await (await caches.open('study-sprint-share')).put(new URL('share-target/text', document.baseURI), new Response(JSON.stringify({ title: 'Page', text: '', url: 'https://example.com/page' }))); });
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.goto('http://localhost:8123/#/import/share'); await page.waitForSelector('#loadErr:not([hidden])');
ok((await page.textContent('#loadErr')).includes("That's a link"), 'a shared link alone is explained');

// The worker itself: a real POST from a form, as Android sends it.
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async () => { await navigator.serviceWorker.ready; });
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
if (!controlled) await page.reload();
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controls the page');
await page.evaluate(() => {
  const f = document.createElement('form');
  f.method = 'POST'; f.action = 'share-target'; f.enctype = 'multipart/form-data'; f.id = 'fakeShare';
  f.innerHTML = '<input type="file" name="files"><input name="title" value="Slides"><input name="text" value=""><input name="url" value="">';
  document.body.append(f);
});
await page.setInputFiles('#fakeShare input[type=file]', SP + '/files/doc-slides.pptx');
await Promise.all([page.waitForURL(/#\/import\/share$/, { timeout: 30000 }), page.evaluate(() => document.getElementById('fakeShare').submit())]);
await ready();
ok((await page.textContent('#docInfo')).includes('3 slides'), 'a shared .pptx arrives through the worker and is read: ' + await page.textContent('#docInfo'));
ok(await page.isVisible('#pane-file') && (await page.textContent('#fileName')).includes('doc-slides.pptx'), 'on the File tab with its name');
// a text share through the worker
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(() => {
  const f = document.createElement('form');
  f.method = 'POST'; f.action = 'share-target'; f.enctype = 'multipart/form-data'; f.id = 'fakeShare2';
  f.innerHTML = '<input name="title" value=""><textarea name="text">Axon - the long fibre\nDendrite - the short input</textarea><input name="url" value="">';
  document.body.append(f);
});
await Promise.all([page.waitForURL(/#\/import\/share$/, { timeout: 30000 }), page.evaluate(() => document.getElementById('fakeShare2').submit())]);
await page.waitForSelector('#preview:not([hidden])');
ok((await fronts()).join('|') === 'Axon|Dendrite', 'shared text arrives through the worker');

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' || ') : ''));
await browser.close();
