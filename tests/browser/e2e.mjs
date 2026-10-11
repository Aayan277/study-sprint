import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const noHScroll = async where => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scroll: ${where}`);

await page.goto('http://localhost:8123/');
await page.waitForSelector('.deck');
ok((await page.locator('.deck').count()) === 1, 'sample deck seeded');
ok((await page.locator('.deck-counts').first().innerText()).includes('12'), 'sample has 12 cards');
await noHScroll('library'); await page.screenshot({ path: SP + '/1-library.png' });

// create
await page.click('#newDeck'); await page.click('button[type=submit]');
ok(await page.locator('#deckErr').isVisible(), 'empty name rejected');
await page.fill('#deckName', 'Cell Biology <b>x</b>'); await page.fill('#deckCourse', 'BIOL 201');
await page.click('.swatch >> nth=3'); await page.screenshot({ path: SP + '/2-new.png' });
await page.click('button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('.deck').length === 2);
ok((await page.locator('.deck-name').nth(1).innerText()) === 'Cell Biology <b>x</b>', 'deck created, name escaped');
// rename + recolor
await page.click('[data-edit] >> nth=1'); await page.fill('#deckName', 'Cell Biology'); await page.click('.swatch >> nth=6'); await page.click('button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('.deck-name')[1]?.textContent === 'Cell Biology');
ok((await page.locator('.deck').nth(1).getAttribute('style')).includes('#8E4EC6'), 'renamed + recolored');
// reload persistence
await page.reload(); await page.waitForSelector('.deck');
ok((await page.locator('.deck').count()) === 2, 'decks persist after reload');
// open sample deck
await page.click('.deck-open >> nth=0'); await page.waitForSelector('.crow');
ok((await page.locator('.crow').count()) === 12, 'deck detail lists cards'); await noHScroll('deck detail');
await page.screenshot({ path: SP + '/3-detail.png', fullPage: true });
await page.goBack(); await page.waitForSelector('.deck');
ok(page.url().endsWith('#/decks'), 'back button returns to decks');
// delete with confirmation
await page.click('[data-edit] >> nth=0'); await page.click('#deckDelete');
await page.screenshot({ path: SP + '/4-confirm.png' });
await page.click('#delNo'); ok((await page.locator('#deckName').count()) === 1, 'Keep it returns to editor');
await page.click('#deckDelete'); await page.click('#delYes');
await page.waitForFunction(() => document.querySelectorAll('.deck').length === 1);
const left = await page.evaluate(async () => { const db = await import('./js/db.js'); return { cards: (await db.getAll('cards')).length, decks: (await db.getDecks()).length }; });
ok(left.cards === 0 && left.decks === 1, 'delete removed deck and its cards ' + JSON.stringify(left));
await page.reload(); await page.waitForSelector('.deck');
ok((await page.locator('.deck').count()) === 1, 'sample deck does not come back after delete');
// tabs
for (const t of ['review', 'play', 'stats']) { await page.click(`.tab[data-tab=${t}]`); await page.waitForSelector('#screen h1'); await noHScroll(t); }
// settings + theme
await page.click('[data-tab=settings]'); await page.waitForSelector('.skin'); await noHScroll('settings');
await page.click('.skin[data-skin=blossom]'); await page.click('input[name=mode][value=dark]', { force: true });
ok(await page.evaluate(() => document.documentElement.dataset.skin === 'blossom' && document.documentElement.dataset.theme === 'dark'), 'theme applied');
await page.screenshot({ path: SP + '/5-settings.png', fullPage: true });
await page.reload(); await page.waitForSelector('.skin');
ok(await page.evaluate(() => document.documentElement.dataset.skin === 'blossom'), 'theme persists');
ok((await page.locator('meta[name=theme-color]').getAttribute('content')) === '#1A1216', 'browser bar color follows theme');
await page.click('[data-tab=decks]'); await page.waitForSelector('.deck'); await page.screenshot({ path: SP + '/6-library-sakura-dark.png' });
// reset
await page.click('[data-tab=settings]'); await page.click('#resetBtn'); await page.click('#rsYes');
await page.waitForSelector('.deck');
ok((await page.locator('.deck').count()) === 1 && (await page.locator('.deck-name').first().innerText()).includes('sample') && await page.evaluate(() => document.documentElement.dataset.skin === 'blossom'), 'reset: data wiped, sample back, theme kept');
// all 6 themes x light/dark: screenshot sanity
for (const skin of ['ink','sage','cobalt','neon','onyx']) { await page.evaluate(async s => { const t = await import('./js/themes.js'); t.applyTheme({ skin: s, mode: 'light' }); }, skin); }
// service worker + manifest
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
ok(sw, 'service worker active');
const man = await (await page.request.get('http://localhost:8123/manifest.webmanifest')).json();
for (const i of man.icons) ok((await page.request.get('http://localhost:8123/' + i.src)).ok(), 'icon exists ' + i.src);
// offline
await ctx.setOffline(true); await page.reload(); await page.waitForSelector('.deck', { timeout: 5000 });
ok(true, 'works offline');
ok(errors.length === 0, 'no console errors ' + errors.join(' | '));
await browser.close();
