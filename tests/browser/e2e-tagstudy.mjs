// Round 3, batch 2: Study by tag or question ID (item 1) and tags shown as folders (item D).
// An AnKing-style deck: tags like #ak_step1_v12::#uworld::step::12345, most of its cards suspended.
import { chromium } from './pw.mjs';
const SP = process.argv[2] || '/tmp';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const open = async ({ w = 375, h = 800, scheme = 'dark' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', isMobile: w < 600, hasTouch: w < 600, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck, .empty');
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), scheme);
  return p;
};
const UW = '#ak_step1_v12::#uworld::step', AM = '#ak_step1_v12::#amboss';
const seed = p => p.evaluate(async ([UW, AM]) => {
  const db = await import('./js/db.js');
  const c = (id, tags, extra = {}) => ({ id, deckId: 'ak', front: 'Q ' + id, back: 'A ' + id, tags, created: Number(id.slice(1)) + 1, ...extra });
  await db.addDeckWithCards({ id: 'ak', name: 'AnKing', color: '#3E63DD', created: Date.now() }, [
    c('a0', [`${UW}::12345`, '#ak_step1_v12::#subject::cardio'], { suspended: true }),
    c('a1', [`${UW}::12345`, '#ak_step1_v12::#subject::cardio'], { suspended: true }),
    c('a2', [`${UW}::23456`, 'leech'], { suspended: true }),
    c('a3', [`${UW}::00789`]),
    c('a4', [`${AM}::12345`], { buriedUntil: Date.now() + 3 * 3600000 }),
    c('a5', ['#ak_step1_v12::#subject::renal']),
    c('a6', ['plain'])
  ]);
}, [UW, AM]);
const suspended = p => p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.suspended).map(c => c.id).sort());
const noHScroll = async (p, w, what) => ok(await p.evaluate(x => document.documentElement.scrollWidth <= x, w), 'no sideways scroll: ' + what);
const openSheetFromToday = async p => {
  await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#optBtn');
  await p.click('#optBtn'); await p.click('#customBtn'); await p.waitForSelector('#csTagBtn');
  await p.click('#csTagBtn'); await p.waitForSelector('#tsText');
};

// ----- Today > Custom study > By tag or question ID -----
let p = await open();
await seed(p);
await p.evaluate(() => { location.hash = '#/today'; }); await p.waitForSelector('#optBtn');
await p.click('#optBtn'); await p.click('#customBtn'); await p.waitForSelector('#csTagBtn');
const firstOpt = await p.$eval('#sheet .cs-opt', d => d.textContent.replace(/\s+/g, ' '));
ok(/By tag or question ID/.test(firstOpt) && !/question bank/.test(firstOpt), 'Custom study starts with By tag or question ID: ' + firstOpt);
ok(/Postpone reviews/.test(await p.textContent('#sheet')), 'Custom study has Postpone reviews');
await p.click('#csTagBtn'); await p.waitForSelector('#tsText');
ok((await p.textContent('#sheetTitle')).trim() === 'Study by tag or question ID', 'the sheet opens');
ok((await p.textContent('#sheet')).includes('In all decks'), 'it says it looks in all decks');
ok((await p.getAttribute('#tsText', 'placeholder')).startsWith('e.g. 12345, 23456 34567'), 'placeholder shows an example');
ok(await p.isDisabled('#tsStudy') && await p.isDisabled('#tsUnsus'), 'buttons are off before anything is found');

// paste IDs: 789 (leading zeros in the tag), 12345 (in two question banks), 23456, one missing
await p.fill('#tsText', 'Step 789, 12345\n23456 99999 99999');
await p.waitForFunction(() => document.querySelector('#tsResult')?.textContent.includes('Found'));
let res = (await p.textContent('#tsResult')).replace(/\s+/g, ' ').trim();
ok(res.startsWith('Found 3 of 4 IDs · 4 cards (3 suspended, 1 is a leech)') && res.endsWith('Ignored: Step'), 'result line, with the plain word listed as ignored: ' + res);
ok(await p.isVisible('#tsLookWrap'), 'a "Look in" choice appears when two banks share an ID');
const looks = await p.$$eval('#tsLook option', o => o.map(x => x.textContent));
ok(looks[0] === '#ak_step1_v12 › #uworld › step (3 IDs)' && looks[1] === '#ak_step1_v12 › #amboss (1 ID)', 'Look in lists the folders, most IDs first: ' + looks.join(' | '));
ok((await p.textContent('#tsMissing')).includes('Not found: 99999'), 'missing IDs are listed: ' + (await p.textContent('#tsMissing')).trim());
ok((await p.textContent('#tsStudy')).trim() === 'Study 4 now' && (await p.textContent('#tsUnsus')).trim() === 'Unsuspend 3', 'footer buttons: ' + (await p.textContent('#tsUnsus')).trim() + ' / ' + (await p.textContent('#tsStudy')).trim());
await noHScroll(p, 375, 'tag study sheet at 375');
await p.screenshot({ path: SP + '/ts-ids-375-dark.png' });

// choosing the other bank changes the cards
await p.selectOption('#tsLook', '#ak_step1_v12::#amboss');
res = (await p.textContent('#tsResult')).replace(/\s+/g, ' ').trim();
ok(res.startsWith('Found 1 of 4 IDs · 1 card'), 'AMBOSS only: ' + res);
await p.selectOption('#tsLook', UW);

// Unsuspend only
await p.click('#tsUnsus');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Unsuspended 3 cards'));
ok((await p.textContent('#toast')).includes('New ones join your daily new cards.'), 'toast: ' + (await p.textContent('#toast')));
ok((await suspended(p)).length === 0, 'the cards are no longer suspended');
ok(await p.isDisabled('#tsUnsus'), 'nothing left to unsuspend');
await p.screenshot({ path: SP + '/ts-after-unsuspend-375-dark.png' });

// Study now: re-suspend two of them first, then check it unsuspends and starts with the cards in the order of the IDs
await p.evaluate(async () => { const db = await import('./js/db.js'); const cs = (await db.getAll('cards')).filter(c => ['a0', 'a1', 'a2'].includes(c.id)); await db.saveCards(cs.map(c => ({ ...c, suspended: true }))); });
await p.evaluate(() => { location.hash = '#/decks'; }); await p.waitForSelector('.deck');
await openSheetFromToday(p);
await p.fill('#tsText', '789 12345 23456');
await p.waitForFunction(() => document.querySelector('#tsResult')?.textContent.includes('Found'));
await p.selectOption('#tsLook', UW);
ok((await p.textContent('#tsStudy')).trim() === 'Study 4 now', 'Study 4 now');
await p.click('#tsStudy');
await p.waitForFunction(() => location.hash.startsWith('#/review') && document.querySelector('.flash-front'));
ok((await suspended(p)).length === 0, 'Study now unsuspended the cards (and started the session)');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('started a session'));      // (shown once Review has drawn)
const toastTxt = (await p.textContent('#toast')).trim();
ok(toastTxt === 'Unsuspended 3 cards and started a session.', 'toast: ' + toastTxt);
ok((await p.textContent('.flash-deck')).includes('Question IDs'), 'the session is named: ' + (await p.textContent('.flash-deck')).trim());
const seen = [];
for (let i = 0; i < 4; i++) {
  await p.waitForSelector('.flash-front'); seen.push((await p.textContent('.flash-front')).trim().replace(/\s+/g, ' '));
  await p.keyboard.press('Space'); await p.waitForSelector('.rates');
  await p.keyboard.press('3');
  await p.waitForFunction(t => (document.querySelector('.flash-front')?.textContent.trim().replace(/\s+/g, ' ') !== t) || document.querySelector('.finish'), seen[i]).catch(() => {});
}
ok(seen.join(',') === 'Q a3,Q a0,Q a1,Q a2', 'the cards came in the order of the IDs: ' + seen.join(','));
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).find(c => c.id === 'a4').buriedUntil > Date.now()), 'a buried card keeps its burial');

// ----- the Tag tab -----
p = await open({ w: 375 });
await seed(p);
await openSheetFromToday(p);
await p.click('[data-tab=tag]');
await p.waitForSelector('#tsTreeBox .tag-folder');
ok(await p.isHidden('#tsIds') && await p.isVisible('#tsTag'), 'the Tag tab shows the tree');
const roots = await p.$$eval('#tsTreeBox > .tag-tree > li', li => li.map(x => x.querySelector('.tag-name').textContent));
ok(roots.join('|') === '#ak_step1_v12|leech|plain', 'folders and plain tags: ' + roots.join('|'));
ok(await p.locator('#tsTreeBox .tf-kids .tag-folder').count() === 0, 'a folder\'s insides are drawn only when it is opened');
await p.click('#tsTreeBox li[data-path="#ak_step1_v12"] > .tf-row .tf-toggle');
ok(await p.locator('#tsTreeBox li[data-path="#ak_step1_v12::#uworld"]').count() === 1, 'opening a folder shows its children');
await p.click('#tsTreeBox li[data-path="#ak_step1_v12::#uworld"] > .tf-row .tf-toggle');
await p.click(`#tsTreeBox li[data-path="${UW}"] > .tf-row .tf-toggle`);
await p.click(`#tsTreeBox li[data-path="${UW}"] > .tf-row [data-tf-pick]`);
res = (await p.textContent('#tsResult')).replace(/\s+/g, ' ').trim();
ok(res === '#ak_step1_v12 › #uworld › step · 4 cards (3 suspended, 1 is a leech)'.replace('#ak_step1_v12 › #uworld › step', '#ak_step1_v12 › #uworld › step'), 'picking a folder: ' + res);
ok((await p.textContent('#tsStudy')).trim() === 'Study 4 now', 'Study 4 now for the folder');
await p.screenshot({ path: SP + '/ts-tag-375-dark.png' });
// search narrows the tree to matching tags
await p.fill('#tsSearch', 'renal');
await p.waitForFunction(() => document.querySelectorAll('#tsTreeBox li').length === 1);
ok((await p.textContent('#tsTreeBox li')).includes('#ak_step1_v12 › #subject › renal'), 'search lists the matching tag: ' + (await p.textContent('#tsTreeBox li')).replace(/\s+/g, ' ').trim());
await p.click('#tsTreeBox [data-tf-pick]');
ok((await p.textContent('#tsResult')).includes('1 card') && (await p.textContent('#tsStudy')).trim() === 'Study 1 now', 'picking a searched tag');
await p.keyboard.press('Escape');

// no tags at all
const q = await open();
await q.evaluate(() => { location.hash = '#/today'; }); await q.waitForSelector('#optBtn');
await q.click('#optBtn'); await q.click('#customBtn'); await q.click('#csTagBtn');
await q.waitForSelector('#tsClose');
ok((await q.textContent('#sheet')).includes('No cards have tags yet. Anki decks like AnKing bring their tags.'), 'no tags: friendly message');
await q.context().close();

// ----- Browse > Tools: tags as folders -----
p = await open({ w: 375 });
await seed(p);
await p.evaluate(() => { location.hash = '#/browse'; }); await p.waitForSelector('#brTags');
await p.click('#brTags'); await p.waitForSelector('#toolTagStudy');
ok((await p.textContent('#sheet')).includes('Find by tag or question ID'), 'Tools has "Find by tag or question ID"');
await p.waitForSelector('#tagTreeBox .tag-folder');
const tRoots = await p.$$eval('#tagTreeBox > .tag-tree > li', li => li.map(x => x.querySelector('.tag-name').textContent));
ok(tRoots.join('|') === '#ak_step1_v12|leech|plain', 'tags with :: are a tree, the others stay at the top: ' + tRoots.join('|'));
ok((await p.textContent('#tagTreeBox li[data-path="#ak_step1_v12"] > .tf-row .muted')).trim() === '6 cards', 'a folder shows how many cards: ' + (await p.textContent('#tagTreeBox li[data-path="#ak_step1_v12"] > .tf-row .muted')).trim());
ok(await p.locator('#tagTreeBox li[data-path="plain"] [data-tf-rename]').count() === 1, 'a plain tag has Rename and Remove');
await noHScroll(p, 375, 'Tools with the tag tree at 375');
await p.screenshot({ path: SP + '/tools-tree-375-dark.png' });
await p.click('#tagTreeBox li[data-path="#ak_step1_v12"] > .tf-row .tf-toggle');
await p.click('#tagTreeBox li[data-path="#ak_step1_v12::#uworld"] > .tf-row .tf-toggle');
ok(await p.locator('#tagTreeBox li[data-path="#ak_step1_v12::#uworld::step"]').count() === 1, 'folders open level by level');
await p.screenshot({ path: SP + '/tools-tree-open-375-dark.png' });
// Show cards puts tag:<path> in the search box
await p.click('#tagTreeBox li[data-path="#ak_step1_v12::#uworld"] > .tf-row [data-tf-show]');
await p.waitForSelector('#sheet', { state: 'hidden' });
ok(await p.inputValue('#brQuery') === 'tag:#ak_step1_v12::#uworld', 'Show cards fills the search: ' + await p.inputValue('#brQuery'));
await p.waitForFunction(() => document.querySelectorAll('#brList .crow').length === 4);
ok(true, 'the list shows the 4 cards of the folder');
// a search with a tag and a word
await p.fill('#brQuery', 'tag:#ak_step1_v12 renal');
await p.waitForFunction(() => document.querySelectorAll('#brList .crow').length === 1);
ok(true, 'tag: combines with words');
await p.fill('#brQuery', '');

// Rename a folder: #subject → #topic (merges nothing here), Remove a folder
await p.click('#brTags'); await p.waitForSelector('#tagTreeBox .tag-folder');
await p.click('#tagTreeBox li[data-path="#ak_step1_v12"] > .tf-row .tf-toggle');
await p.click('#tagTreeBox li[data-path="#ak_step1_v12::#subject"] > .tf-row [data-tf-rename]');
await p.waitForSelector('#tagNew');
ok((await p.textContent('#tagForm .field span')).trim() === 'Rename the folder “#subject” to', 'rename prompt: ' + (await p.textContent('#tagForm .field span')).trim());
await p.fill('#tagNew', '#ak_step1_v12::#topic');
await p.click('#tagForm button[type=submit]');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Renamed the folder'));
ok((await p.textContent('#toast')).includes('Renamed the folder “#subject” on 3 cards'), 'toast: ' + (await p.textContent('#toast')));
const tags = await p.evaluate(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cards')).map(c => [c.id, c.tags])));
ok(tags.a0.includes('#ak_step1_v12::#topic::cardio') && tags.a5.join() === '#ak_step1_v12::#topic::renal' && !JSON.stringify(tags).includes('#subject'), 'every tag under the folder moved: ' + JSON.stringify([tags.a0, tags.a5]));
await p.click('#brTags'); await p.waitForSelector('#tagTreeBox .tag-folder');
await p.click('#tagTreeBox li[data-path="#ak_step1_v12"] > .tf-row .tf-toggle');
await p.click('#tagTreeBox li[data-path="#ak_step1_v12::#amboss"] > .tf-row [data-tf-remove]');
await p.waitForSelector('#cfYes');
ok((await p.textContent('.confirm p')).trim() === 'Remove the folder “#amboss” and its 1 tag from every card in all decks? The cards stay.', 'remove prompt: ' + (await p.textContent('.confirm p')).trim());
await p.click('#cfYes');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Removed the folder'));
ok(await p.evaluate(async () => (await (await import('./js/db.js')).get('cards', 'a4')).tags.length) === 0, 'Remove took the folder\'s tags off the card (the card stays)');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' // ') : ''));

// ----- 1440 light -----
const w = await open({ w: 1440, h: 900, scheme: 'light' });
await seed(w);
await openSheetFromToday(w);
await w.fill('#tsText', '789 12345 23456 99999');
await w.waitForFunction(() => document.querySelector('#tsResult')?.textContent.includes('Found'));
await w.screenshot({ path: SP + '/ts-ids-1440-light.png' });
await w.click('[data-tab=tag]'); await w.waitForSelector('#tsTreeBox .tag-folder');
await w.click('#tsTreeBox li[data-path="#ak_step1_v12"] > .tf-row .tf-toggle');
await w.screenshot({ path: SP + '/ts-tag-1440-light.png' });
await w.keyboard.press('Escape');
await w.evaluate(() => { location.hash = '#/browse'; }); await w.waitForSelector('#brTags');
await w.click('#brTags'); await w.waitForSelector('#tagTreeBox .tag-folder');
await w.click('#tagTreeBox li[data-path="#ak_step1_v12"] > .tf-row .tf-toggle');
await w.screenshot({ path: SP + '/tools-tree-1440-light.png' });
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' // ') : ''));
await browser.close();
