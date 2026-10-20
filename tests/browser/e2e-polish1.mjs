// Polish pass 1 (visual fixes A1 to A6): fonts, exam colors, one empty state, chart scale, one content width.
import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const open = async (w, h) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.stack));
  return p;
};
const css = (p, sel, prop) => p.$eval(sel, (e, k) => getComputedStyle(e)[k], prop);
const go = async (p, hash, sel) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(sel); await p.waitForTimeout(250); };
const DAY = 86400000;

const p = await open(375, 812);
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now(), D = 86400000;
  // the study day starts at 4am (days.js), so before 4am "today" is still yesterday
  const iso = n => { const x = new Date(now - (new Date(now).getHours() < 4 ? D : 0) + n * D); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const cards = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, deckId: id, front: 'Q' + i, back: 'A' + i, tags: [], created: i }));
  await db.addDeckWithCards({ id: 'soon', name: 'Soon exam', color: '#E5484D', created: now + 1, examDate: iso(2) }, cards('soon', 3));
  await db.addDeckWithCards({ id: 'far', name: 'Far exam', color: '#46A758', created: now + 2, examDate: iso(20) }, cards('far', 3));
  await db.addDeckWithCards({ id: 'none', name: 'Empty deck', color: '#12A594', created: now + 3 }, []);
  // a plenty of answers so the charts have bars
  const logs = []; for (let d = 0; d < 20; d++) for (let i = 0; i < 6 + d % 5; i++) logs.push({ cardId: 'far0', timestamp: now - d * D - i * 20000 - 3600000, source: 'review', mode: 'flip', correct: i % 5 !== 0, ms: 3000, rating: i % 5 ? 3 : 1, state: 2 });
  await db.putMany('reviewLog', logs);
});

// ----- A1: Today -----
await go(p, '#/today', '.today-hero');
ok(!/Mono/i.test(await css(p, '#startBtn', 'fontFamily')), 'Start is in the app font, not Geist Mono: ' + await css(p, '#startBtn', 'fontFamily'));
ok(await css(p, '#startBtn', 'marginTop') === '0px', 'Start has no stray top margin');
ok(!/Mono/i.test(await css(p, '.th-sub', 'fontFamily')), 'the "due · new" line is not mono');
ok(!/Mono/i.test(await css(p, '.th-sub b', 'fontFamily')), 'its numbers share the text font');
ok(await p.$eval('.exam-row .on-track, .exam-row .exam-new', e => !!e), 'exam rows have their plan line');
const bars = await p.evaluate(() => { const bg = c => getComputedStyle(document.querySelector(c)).backgroundColor; return [bg('.tabs'), bg('.top')]; });
const alpha = c => +(c.match(/[\d.]+/g)[3] ?? 1);
ok(alpha(bars[0]) >= .9 && alpha(bars[1]) >= .85, 'tab bar and header are nearly solid: ' + bars.join(' | '));
// Stats keeps its mono numbers
await go(p, '#/stats', '.pgrid');
ok(!/Mono/i.test(await css(p, '.pgrid .big', 'fontFamily')) && await css(p, '.pgrid .big', 'fontSize') === '40px', 'Stats big numbers use Geist (no monospace) at 40px');

// ----- A3: exam colors -----
await go(p, '#/today', '.exam-row');
const badges = await p.$$eval('.exam-row .exam-badge', bs => bs.map(b => ({ t: b.textContent, soon: b.classList.contains('soon'), color: getComputedStyle(b).color })));
const soon = badges.find(b => /in 2 days/.test(b.t)), far = badges.find(b => /in 20 days/.test(b.t));
ok(soon && soon.soon && far && !far.soon, 'only the exam within 3 days is marked "soon": ' + JSON.stringify(badges.map(b => [b.t, b.soon])));
const rgb = c => c.match(/\d+/g).slice(0, 3).map(Number);
ok(rgb(far.color)[0] > rgb(far.color)[2] + 60 && rgb(far.color)[1] > 60, 'a far exam is amber: ' + far.color);
ok(rgb(soon.color)[0] > 150 && rgb(soon.color)[1] < 110 && rgb(soon.color)[2] < 140, 'a near exam is red: ' + soon.color);
// Again vs Ember's accent: far apart in hue (crimson, not orange)
const hueOf = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
for (const mode of ['dark', 'light']) {
  await p.evaluate(async m => { const t = await import('./js/themes.js'); t.applyTheme({ skin: 'ember', mode: m, oled: false }); }, mode);
  const [again, accent] = await p.evaluate(() => ['--again', '--accent'].map(n => { const i = document.createElement('i'); i.style.color = `var(${n})`; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; }));
  const dh = Math.abs(hueOf(rgb(again)) - hueOf(rgb(accent)));
  ok(Math.min(dh, 360 - dh) >= 20, `Ember ${mode}: Again (${again}) and the accent (${accent}) are ${Math.round(dh)} degrees apart`);
}
await p.evaluate(async () => { (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: 'dark', oled: false }); });

// ----- A4: deck page stripe and one empty state -----
await go(p, '#/deck/none', '.view h1');
ok(await p.$$eval('#brEmpty', e => e.length === 1) && await p.isVisible('#brEmpty'), 'an empty deck shows one empty state');
ok(!(await p.isVisible('#brQuery')) && !(await p.isVisible('#brList')) && !(await p.isVisible('.deck-summary')), 'no search box, list or summary over it');
ok(await p.$$eval('.view .empty:not([hidden])', e => e.filter(x => x.offsetParent).length) === 1, 'exactly one visible empty box');
await p.click('#brAddFirst'); await p.waitForSelector('#acFront');
await p.fill('#acFront', 'First'); await p.fill('#acBack', 'Card'); await p.click('button[type=submit][form=acForm]'); await p.waitForTimeout(300); await p.click('#acDone'); await p.waitForTimeout(400);
ok(!(await p.isVisible('#brEmpty')) && await p.isVisible('#brQuery') && await p.isVisible('.deck-summary'), 'adding the first card brings the list and summary back');
ok(await p.$eval('.deck-summary', e => e.style.borderLeft === '' && getComputedStyle(e, '::before').width === '3px'), 'the deck summary uses the 3px stripe, not an inline 6px border');

// ----- A5: stats -----
await go(p, '#/stats', '.chart');
const axis = await p.$$eval('#perDay .chart-line span', s => s.map(x => +x.textContent.replace(/,/g, '')));
const peak = await p.evaluate(() => Math.max(...[...document.querySelectorAll('#perDay .col')].map(c => +c.dataset.tip.split(' ')[0])));
ok(axis[0] >= peak && axis[0] <= peak * 1.5, `the axis top (${axis[0]}) hugs the tallest bar (${peak})`);
ok(await p.$eval('.bar', e => /color-mix\(in srgb, var\(--accent\) 70%|rgba?\(/.test(getComputedStyle(e).backgroundImage)), 'bars have a gradient');
// the Hardest list: 5 shown, then Show all
await p.evaluate(async () => {
  const db = await import('./js/db.js'); const now = Date.now();
  const cs = (await db.getAll('cards')).slice(0, 8);
  await db.putMany('cardStates', cs.map((c, i) => ({ cardId: c.id, due: now + 86400000, stability: 2, difficulty: 7, elapsedDays: 1, scheduledDays: 1, learningSteps: 0, reps: 4, lapses: 3 + i, state: 2, lastReview: now - 86400000 })));
});
await go(p, '#/browse', '.crow-btn'); await go(p, '#/stats', '.chart');
if (await p.$('#moreBtn') && await p.isVisible('#moreBtn') && (await p.getAttribute('#moreBtn', 'aria-expanded')) !== 'true') await p.click('#moreBtn');
ok(await p.$$eval('#hardList li:not([hidden])', l => l.length) === 5, 'Hardest cards shows 5 by default');
await p.click('#hardAll');
ok(await p.$$eval('#hardList li:not([hidden])', l => l.length) === 8, 'Show all shows them all');
ok(await p.$eval('.hard-list .n', e => !/Mono/i.test(getComputedStyle(e).fontFamily) && getComputedStyle(e, '::before').width === '6px'), 'the Forgotten line is plain text with a small dot');

// ----- A6: one content width on desktop -----
// (a deck's page is left out: from 1200px it is the three-column page, see e2e-polish2.mjs)
const d = await open(1440, 900);
await d.goto('http://localhost:8123/#/decks'); await d.waitForSelector('.deck');
const edges = {};
for (const [n, h, s] of [['today', '#/today', '.tdeck'], ['decks', '#/decks', '.deck'], ['stats', '#/stats', '.card'], ['play', '#/play', '#startBtn'], ['settings', '#/settings', '#skins'], ['browse', '#/browse', '.crow-btn']]) {
  await go(d, h, s);
  edges[n] = await d.evaluate(() => { const v = document.querySelector('main > .view'), r = v.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), Math.round(v.querySelector('h1').getBoundingClientRect().left)]; });
}
// (UI audit M9, intended change: the wide screens share one left edge and 1120px; the narrow columns (Play, Settings, Browse) are centred in the same space)
const wide = ['today', 'decks', 'stats'].map(n => edges[n]);
ok(wide.every(e => e[0] === edges.today[0] && e[1] === 1120 && e[2] === edges.today[0]), 'Today, Decks and Stats share one left edge and are 1120px wide: ' + JSON.stringify(wide));
const mainBox = await d.evaluate(() => { const m = document.querySelector('main').getBoundingClientRect(); return [Math.round(m.left), Math.round(m.right)]; });
ok(['play', 'settings', 'browse'].every(n => Math.abs((edges[n][0] - mainBox[0]) - (mainBox[1] - edges[n][0] - edges[n][1])) <= 2 && edges[n][1] <= 900), 'Play, Settings and Browse are narrow columns centred in the page: ' + JSON.stringify(['play', 'settings', 'browse'].map(n => edges[n])));
await go(d, '#/play', '#startBtn');
ok(await d.$eval('#startBtn', e => e.getBoundingClientRect().width <= 760), 'Play keeps a 760px reading column inside it');
await go(d, '#/today', '.today-hero');
ok(await css(d, '.th-big', 'fontSize') === '36px', "Today's hero heading is larger on desktop");
ok(await d.$eval('.today-hero .ring', e => e.getBoundingClientRect().width) > 100, "Today's ring is larger on desktop");
await d.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
const hasHScroll = await d.evaluate(() => document.documentElement.scrollWidth > innerWidth);
ok(!hasHScroll, 'no sideways scroll on desktop Today');
ok(errors.length === 0, 'no page errors' + (errors[0] ? ': ' + errors[0] : ''));
await browser.close();
