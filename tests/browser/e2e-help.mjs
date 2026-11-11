// The Help page: reachable from Settings, closed answers, one opened by #/help/<id>, big tap targets, no sideways scroll,
// the labels it quotes exist in the app, and it works offline (js/help.js is in the service worker's CORE list).
import { chromium } from './pw.mjs';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const APP = 'http://localhost:8123/';
const errors = [];
const browser = await chromium.launch();
const open = async (w, h, { sw = 'block', scheme } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: sw, ...(scheme ? { colorScheme: scheme } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  return p;
};
const noHScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const [w, h] of [[375, 740], [1280, 800]]) {
  const p = await open(w, h);
  const tag = `${w}px: `;
  await p.goto(APP + '#/help'); await p.waitForSelector('h1:has-text("Help")');
  ok(await p.getAttribute('a[data-tab="settings"]', 'aria-current') === 'page', tag + 'the Settings tab is highlighted');
  const n = await p.locator('details.help-q').count();
  ok(n >= 12, tag + `at least 12 questions (${n})`);
  ok(await p.locator('details.help-q[open]').count() === 0, tag + 'all start closed');
  ok(await p.locator('section.help-sec h2').count() === 4, tag + 'four sections with headings');
  const heights = await p.$$eval('details.help-q > summary', els => els.map(e => e.getBoundingClientRect().height));
  ok(Math.min(...heights) >= 44, tag + 'every question is at least 44px tall: ' + Math.min(...heights));
  await p.goto(APP + '#/help/ratings');
  await p.waitForFunction(() => document.activeElement?.matches('#h-ratings > summary'));
  ok(await p.locator('details.help-q[open]').count() === 1 && await p.locator('#h-ratings[open]').count() === 1, tag + '#/help/ratings opens only that answer and focuses its question');
  const top = await p.evaluate(() => document.getElementById('h-ratings').getBoundingClientRect().top);
  ok(top >= 0 && top < h, tag + 'and scrolls it into view');
  // every answer has a unique id and opens from its deep link
  const ids = await p.$$eval('details.help-q', els => els.map(e => e.id.slice(2)));
  ok(new Set(ids).size === ids.length, tag + 'every Help id is unique');
  for (const id of ['cloze', 'maths', 'typing', 'steps', 'subdecks', 'deck-options', 'read-aloud', 'export', 'deck-ring', 'exam-date', 'adding', 'tags', 'play-scoring', 'stats-terms', 'stats-calendar', 'fit-check', 'stats-layout', 'device-only', 'shortcuts', 'accuracy', 'advanced', 'reminders', 'glossary', 'custom-study', 'review-counts', 'compare', 'tools', 'reverse', 'anki-import', 'health-check', 'optimize', 'streak-freeze', 'readiness', 'retention-planner', 'sheets'])
    ok(ids.includes(id), tag + `Help has "${id}"`);
  await p.goto(APP + '#/help/device-only'); await p.waitForSelector('#h-device-only[open]');
  ok(await p.locator('details.help-q[open]').count() === 1, tag + '#/help/device-only opens only that answer');
  // a bad id just shows the page
  await p.goto(APP + '#/help/nope'); await p.waitForSelector('h1:has-text("Help")');
  ok(await p.locator('details.help-q[open]').count() === 0, tag + 'an unknown id opens nothing');
  // entry points
  await p.goto(APP + '#/settings'); await p.waitForSelector('#helpTop');
  await p.click('#helpTop'); await p.waitForSelector('h1:has-text("Help")');
  ok(p.url().endsWith('#/help'), tag + 'the top of Settings has a Help button');
  await p.goto(APP + '#/settings'); await p.waitForSelector('#helpTop');
  ok(await p.locator('#helpRow').count() === 0 && await p.locator('#screen a[href="#/help"]').count() === 1, tag + 'Settings has just one Help button (none in About)');
  await p.click('#helpTop'); await p.waitForSelector('h1:has-text("Help")');
  await p.goBack(); await p.waitForSelector('#helpTop');
  ok(p.url().endsWith('#/settings'), tag + 'Back returns to Settings');
  await p.goto(APP + '#/help'); await p.waitForSelector('h1:has-text("Help")');
  await p.click('.back'); await p.waitForSelector('#helpTop');
  ok(p.url().endsWith('#/settings'), tag + 'the ‹ Settings link goes to Settings');
  await p.goto(APP + '#/help'); await p.waitForSelector('h1:has-text("Help")');
  ok(await p.locator('a[href="#/welcome/again"]').count() === 1 && await p.locator('.help-foot a[href="privacy.html"]').count() === 1, tag + 'footer: welcome tour, Privacy, Terms');
  // the answers hold what the shortened screen lines used to say
  const ans = async id => (await p.textContent('#h-' + id)).replace(/\s+/g, ' ');
  ok(/Anyone with the link/.test(await ans('sheets')) && /column A|Column A/.test(await ans('sheets')) && /back/.test(await ans('sheets')), tag + 'sheets: Anyone with the link, column A front and B back');
  ok(/Daily limits are shared/.test(await ans('subdecks')) && /sync/.test(await ans('anki-import')) && /backups/.test(await ans('anki-import')) && /60 new cards/.test(await ans('exam-date')) && /right now/.test(await ans('readiness')), tag + 'subdecks, anki-import, exam-date and readiness hold the sentences moved off the screens');
  // search: type a word, only matching answers stay, sections without a match hide, the empty state says so
  ok(await p.locator('#helpQ').getAttribute('aria-label') === 'Search help' && await p.locator('#helpQ').isVisible(), tag + 'Help has a labelled search box');
  await p.fill('#helpQ', 'streak');
  const shown = await p.locator('details.help-q:not([hidden])').count();
  ok(shown >= 2 && shown < n, tag + `"streak" keeps only the matching answers (${shown} of ${n})`);
  ok(await p.locator('details.help-q:not([hidden]):not([open])').count() === 0, tag + 'matches are open');
  ok(await p.locator('#h-streak-freeze:not([hidden])').count() === 1, tag + 'the streak freeze answer matches');
  await p.fill('#helpQ', 'sheet');
  ok(await p.locator('#h-sheets:not([hidden])').count() === 1, tag + '"sheet" finds the Google Sheets answer');
  await p.fill('#helpQ', 'zzzzqq');
  ok(await p.locator('details.help-q:not([hidden])').count() === 0 && await p.locator('section.help-sec:not([hidden])').count() === 0, tag + 'no match hides every answer and section');
  ok(await p.locator('#helpNone[role=status]').isVisible() && /No answers match/.test(await p.textContent('#helpNone')), tag + 'and says "No answers match"');
  ok(await noHScroll(p), tag + 'search results have no sideways scroll');
  await p.fill('#helpQ', '');
  ok(await p.locator('details.help-q:not([hidden])').count() === n && !(await p.locator('#helpNone').isVisible()) && await p.locator('details.help-q[open]').count() === 0, tag + 'clearing the box shows all answers, closed');
  await p.goto(APP + '#/help/ratings'); await p.waitForSelector('#h-ratings[open]');
  ok((await p.inputValue('#helpQ')) === '', tag + 'a deep link opens with an empty search box');
  await p.context().close();
}

// No sideways scroll at 320px, both styles, with every answer open
for (const [ui, mode] of [['original', 'light'], ['clinical', 'dark']]) {
  const p = await open(320, 640);
  await p.evaluate(async ([ui, mode]) => { const t = await import('./js/themes.js'); const db = await import('./js/db.js'); const th = { ui, skin: 'violet', mode, oled: false }; await db.setSetting('theme', th); t.applyTheme(th); }, [ui, mode]);
  await p.goto(APP + '#/help'); await p.waitForSelector('h1:has-text("Help")');
  await p.$$eval('details.help-q', els => els.forEach(e => { e.open = true; }));
  ok(await noHScroll(p), `320px ${ui} ${mode}: no sideways scroll with every answer open`);
  const sb = await p.evaluate(() => { const i = document.getElementById('helpQ'), c = getComputedStyle(i); return { bg: c.backgroundColor, fg: c.color, h: i.getBoundingClientRect().height }; });
  ok(sb.bg !== sb.fg && sb.h >= 40, `320px ${ui} ${mode}: the search box has its own background (${sb.bg}) and is tall enough (${sb.h}px)`);
  await p.context().close();
}

// The labels the answers quote exist in the app
{
  const p = await open(375, 740);
  await p.goto(APP + '#/settings'); await p.waitForSelector('#helpTop');
  const s = await p.textContent('main, #screen');
  for (const label of ['Target retention', 'New cards per day', 'Count Play and test answers as reviews', 'Export backup', 'Import backup', 'Your data', 'Sync', 'Single-key shortcuts', 'Glossary', 'Glossary underlines', 'Card text alignment', 'Compact deck list', 'Rating feedback', 'Smooth transitions', 'Exam readiness in Stats', 'Learning steps', 'Relearning steps', 'Maximum interval', 'Spread out due dates', 'Easy days', 'Play timer', 'Leech after', 'Scheduler', 'Check how well it fits you', 'Ignore reviews before', 'Add to my calendar']) ok(s.includes(label), `Settings has "${label}"`);
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  ok(await p.locator('a:has-text("Import")').count() > 0, 'the Decks screen has Import');
  await p.goto(APP + '#/import'); await p.waitForSelector('#claudeBtn');
  ok((await p.textContent('#tab-file')) === 'File' && (await p.textContent('#claudeBtn')) === 'Make cards with Claude' && (await p.textContent('h1')).includes('Add cards'), 'the Add cards screen has File and Make cards with Claude');
  await p.goto(APP + '#/today'); await p.waitForSelector('#startBtn');
  ok((await p.textContent('#startBtn')).includes('Start'), 'Today has Start');
  await p.goto(APP + '#/deck/sample'); await p.waitForSelector('#testBtn');
  ok(await p.locator('#testBtn:has-text("Practice test")').count() === 1, 'a deck page has Practice test');
  await p.click('#deckMore'); await p.waitForSelector('#shareDeck');
  ok((await p.textContent('#shareDeck')).includes('Share'), 'and ⋯ → Share');
  await p.context().close();
}

// Offline: the page and its file come from the saved copy
{
  const p = await open(375, 740, { sw: 'allow' });
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  await p.context().setOffline(true);
  await p.goto(APP + '#/help'); await p.reload(); await p.waitForSelector('h1:has-text("Help")', { timeout: 15000 });
  ok(await p.locator('details.help-q').count() >= 12, 'offline: #/help still renders (js/help.js is in the service worker list)');
  await p.context().close();
}
// Desktop sidebar: a Help link, and the signed-out sync line goes straight to the Sync form
{
  const p = await open(1280, 800);
  ok(await p.locator('#sideHelp[href="#/help"]').isVisible() && !!(await p.getAttribute('#sideHelp', 'aria-label')), 'sidebar: a Help link at 1280px');
  ok(await p.getAttribute('#sideSync', 'href') === '#/settings/sync', 'sidebar: "Sign in to sync" goes to #/settings/sync');
  await p.click('#sideHelp'); await p.waitForSelector('h1:has-text("Help")');
  ok(p.url().endsWith('#/help'), 'sidebar Help opens the Help page');
  await p.goto(APP + '#/settings'); await p.waitForSelector('#newBtn');
  await p.click('#newBtn'); await p.waitForSelector('#sheet[open] h2');
  const ver = await p.evaluate(async () => { const t = await (await fetch('js/app.js')).text(); return t.match(/const APP_VERSION = '([^']+)'/)[1]; });
  const sheet = await p.textContent('#sheet');
  ok(/What’s new/.test(sheet) && sheet.includes('Version ' + ver), 'Settings → About → What’s new lists the current version (' + ver + ')');
  await p.context().close();
}
await browser.close();
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
