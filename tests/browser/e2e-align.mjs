// Card face: the "Card text alignment" setting (Settings → Appearance), the calm deck label and long answers.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block', isMobile: true, colorScheme: 'dark', hasTouch: true });
const p = await ctx.newPage();
p.on('pageerror', e => errors.push(e.stack));
const align = sel => p.$eval(sel, e => getComputedStyle(e).textAlign);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');

// A deck three levels deep, with one short card and one long answer
const LONG = 'Action potential depolarises the presynaptic terminal, voltage-gated calcium channels open, calcium triggers vesicle fusion and the neurotransmitter is released into the cleft, where it binds receptors on the postsynaptic membrane.';
await p.evaluate(async LONG => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'top', name: 'Neuroscience', color: '#8F80FF', created: 5 }, []);
  await db.addDeckWithCards({ id: 'mid', name: 'Unit 2', parentId: 'top', color: '#8F80FF', created: 6 }, []);
  await db.addDeckWithCards({ id: 'low', name: 'Synapses and Neurotransmission', parentId: 'mid', color: '#8F80FF', created: 7 },
    [{ id: 'q1', deckId: 'low', front: 'Short?', back: 'Yes', tags: [], created: 1 }, { id: 'q2', deckId: 'low', front: 'Describe a chemical synapse', back: LONG, tags: [], created: 2 }]);
}, LONG);

// Default is Auto: it is the stored default and the page attribute
ok(await p.evaluate(() => document.documentElement.dataset.align) === 'auto', 'the page starts on Auto');
await p.goto('http://localhost:8123/#/review/low'); await p.waitForSelector('.flash');
const label = (await p.textContent('.rv-front .flash-deck')).trim();
ok(label === 'Unit 2 › Synapses and Neurotransmission', 'the deck label shows the last two levels only: ' + label);
ok(await p.$eval('.rv-front .flash-deck', e => getComputedStyle(e).textTransform === 'none' && getComputedStyle(e).whiteSpace === 'nowrap'), 'the deck label is one calm line');
ok(await align('.rv-front .flash-front') === 'center', 'Auto: a short question is centred');
await p.keyboard.press(' '); await p.waitForSelector('.rate'); await p.keyboard.press('3'); await p.waitForTimeout(500);
await p.waitForSelector('.flash-front');
ok((await p.textContent('.rv-front .flash-front')).includes('Describe'), 'the long card is next');
await p.keyboard.press(' '); await p.waitForSelector('.rate'); await p.waitForTimeout(450);
ok(await p.$eval('.flash-back', e => e.classList.contains('long')), 'a long answer gets the .long class');
ok(await align('.flash-back') === 'left', 'Auto: a long answer is left-aligned');

// Settings → Appearance
await p.goto('http://localhost:8123/#/settings'); await p.waitForSelector('#alignChips');
ok((await p.textContent('#appearTitle')) === 'Appearance', 'Settings has an Appearance section');
ok(await p.$eval('input[name=cardAlign][value=auto]', e => e.checked), 'Auto is selected by default');
await p.locator('#alignChips label', { hasText: 'Center' }).click();
ok(await p.evaluate(() => document.documentElement.dataset.align) === 'center', 'Center: applied at once');
ok(await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).cardAlign) === 'center', 'Center: saved');
// stored on this device only: not one of the synced settings, so sync never sends or overwrites it
ok(await p.evaluate(async () => !(await import('./js/sync-data.js')).SYNCED_SETTINGS.includes('cardAlign')), 'it is not a synced setting');

// Review: Center centres even the long answer, Left left-aligns even a short question
await p.goto('http://localhost:8123/#/review/low'); await p.waitForSelector('.flash');
await p.waitForSelector('.flash-front');
const frontText = async () => (await p.textContent('.rv-front .flash-front')).trim();
const flipOne = async () => { await p.waitForTimeout(300); await p.click('#flash'); await p.waitForSelector('.rate'); await p.waitForTimeout(450); };
// (the short card was answered above, so the long one comes first now)
await flipOne();
ok(await align('.flash-back') === 'center' && await align('.flash-recap') === 'center', 'Center: the long answer and its question are centred');
await p.keyboard.press('1'); await p.waitForTimeout(500);   // Again: it comes back later
await p.evaluate(async () => (await import('./js/db.js')).setSetting('cardAlign', 'left'));
await p.evaluate(async () => (await import('./js/themes.js')).applyCardAlign('left'));
ok(await p.evaluate(() => document.documentElement.dataset.align) === 'left', 'Left: the page attribute follows');
ok(await align('.rv-front .flash-front') === 'left', 'Left: the question is left-aligned');

// It survives a reload (the app applies the saved value when it opens)
await p.reload(); await p.waitForSelector('.flash, .empty, .today-hero', { timeout: 10000 }).catch(() => {});
ok(await p.evaluate(() => document.documentElement.dataset.align) === 'left', 'Left survives a reload');

// Play prompts follow the setting too
await p.evaluate(async () => (await import('./js/themes.js')).applyCardAlign('center'));
await p.goto('http://localhost:8123/#/play'); await p.waitForSelector('#startBtn');
await p.click('#startBtn'); await p.waitForSelector('#pPrompt');
ok(await align('#pPrompt') === 'center', 'Play: the prompt is centred with Center');
await p.evaluate(async () => (await import('./js/themes.js')).applyCardAlign('left'));
ok(await align('#pPrompt') === 'left', 'Play: the prompt is left-aligned with Left');

// The picture frame: a 1px edge, and dimmed on a dark card only
const img = await p.evaluate(() => { const i = document.createElement('img'); i.className = 'card-img'; document.body.appendChild(i); const s = getComputedStyle(i); const r = { shadow: s.boxShadow, filter: s.filter }; i.remove(); return r; });
ok(/0px 0px 0px 1px/.test(img.shadow) && /brightness\(0\.92\)/.test(img.filter), 'pictures have a 1px frame and are dimmed in dark mode');
await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
ok(await p.evaluate(() => { const i = document.createElement('img'); i.className = 'card-img'; document.body.appendChild(i); const f = getComputedStyle(i).filter; i.remove(); return f; }) === 'none', 'pictures are not dimmed in light mode');

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors[0] : ''));
await browser.close();
