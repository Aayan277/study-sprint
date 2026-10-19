// Round 2, coder 1E (A6): Settings sections with a sticky jump row, and Stats polish (search box, Retention (i), calendar
// start, Hardest occlusion thumbnail, forecast wording, shared empty state).
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
  await p.clock.setFixedTime(new Date(2026, 9, 14, 12));
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return p;
};
const noHScroll = async (p, w) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll: ' + w);
const go = async (p, hash, sel) => { await p.goto('about:blank'); await p.goto(URL + hash); await p.waitForSelector(sel); };
const setTheme = (p, mode) => p.evaluate(async mode => { const th = (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode }); await (await import('./js/db.js')).setSetting('theme', th); }, mode);

// ---------------- Settings ----------------
for (const [w, h, mode] of [[375, 780, 'dark'], [375, 780, 'light'], [1440, 900, 'dark'], [1440, 900, 'light']]) {
  const tag = `${w} ${mode}`;
  const p = await newPage(w, h, mode);
  await go(p, '#/settings', '#skins');
  await setTheme(p, mode); await go(p, '#/settings', '#skins');
  ok(await p.locator('.eyebrow').count() === 0, `${tag}: Settings has no SETTINGS eyebrow`);
  const links = await p.$$eval('#setNav a', a => a.map(x => x.textContent));
  ok(links.join('|') === 'Appearance|Study|Sync|Your data', `${tag}: jump row is ${links.join(' · ')}`);
  ok(await p.evaluate(() => { const a = document.getElementById('appearTitle').closest('section'); return !!(a.querySelector('#skins') && a.querySelector('input[name=mode]') && a.querySelector('#oled') && a.querySelector('#alignChips')); }), `${tag}: Theme, Light/dark, OLED and card alignment are inside Appearance`);
  ok(await p.evaluate(() => getComputedStyle(document.getElementById('setNav')).position === 'sticky'), `${tag}: jump row is sticky`);
  await p.click('#setNav a[data-sec=studyTitle]');
  await p.waitForFunction(() => document.getElementById('studyTitle').getBoundingClientRect().top < innerHeight / 2, null, { timeout: 4000 });
  await p.waitForTimeout(700);
  const stuck = await p.evaluate(() => { const r = document.getElementById('setNav').getBoundingClientRect(); const t = document.getElementById('studyTitle').getBoundingClientRect(); return { navTop: r.top, navBottom: r.bottom, titleTop: t.top }; });
  ok(stuck.navTop < 80 && stuck.titleTop >= stuck.navBottom - 1, `${tag}: after a jump the row stays at the top and the heading sits below it (${JSON.stringify(stuck)})`);
  ok(await p.evaluate(() => location.hash) === '#/settings', `${tag}: the route is still #/settings`);
  if (w >= 1024) {
    const tops = await p.$$eval('#skins .skin', b => b.map(x => Math.round(x.getBoundingClientRect().top)));
    ok(tops.length === 5 && new Set(tops).size === 1, `${tag}: 5 theme tiles on one row`);
  }
  const txt = await p.evaluate(() => document.querySelector('main').textContent);
  ok(!/old list|used to|no longer|previously|now also|for the old/i.test(txt), `${tag}: no history wording`);
  for (const id of ['skins', 'oled', 'alignChips', 'compactDecks', 'ratingFeedback', 'smoothMotion', 'statsReadiness', 'npd', 'rpd', 'ret', 'advanced', 'syncBox', 'installRow', 'exportBtn', 'importIn', 'dangerZone', 'resetBtn']) {
    if (!(await p.$('#' + id))) ok(false, `${tag}: #${id} is still there`);
  }
  await noHScroll(p, tag);
  await p.evaluate(() => scrollTo(0, 0));
  await p.screenshot({ path: `${SHOTS}/r2-1e-settings-${w}-${mode}.png` });
  await p.close();
}

// ---------------- Stats ----------------
const seed = async p => p.evaluate(async () => {
  const db = await import('./js/db.js'); const media = await import('./js/media.js');
  const DAY = 86400000, now = Date.now();
  const cs = (await db.getAll('cards')).sort((a, b) => a.created - b.created);
  // a picture for an occlusion card
  const cv = document.createElement('canvas'); cv.width = 80; cv.height = 60; const g = cv.getContext('2d'); g.fillStyle = '#39c'; g.fillRect(0, 0, 80, 60); g.fillStyle = '#fc3'; g.fillRect(20, 15, 30, 25);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const mid = await media.saveImage('image/png', await blob.arrayBuffer());
  const deckId = cs[0].deckId;
  const occ = { id: 'occ1', deckId, noteId: 'n-occ', front: 'Diagram: hidden part 1 of 2', back: 'Mitochondria', backImage: mid, created: now,
    occlusion: { n: 1, w: 80, h: 60, masks: [{ id: 'm1', n: 1, shape: 'rect', x: .25, y: .25, w: .4, h: .4, label: 'Mitochondria' }, { id: 'm2', n: 2, shape: 'rect', x: .1, y: .1, w: .1, h: .1, label: 'Nucleus' }] } };
  await db.saveCards([occ]);
  const st = (c, lapses) => ({ cardId: c.id, due: now - DAY, stability: 5, difficulty: 6, elapsedDays: 1, scheduledDays: 1, learningSteps: 0, reps: 4, lapses, state: 2, lastReview: now - 2 * DAY });
  await db.putMany('cardStates', [st(occ, 9), st(cs[0], 3), st(cs[1], 1)]);
  // answers only in the last ~10 weeks
  const logs = [];
  for (let d = 0; d < 70; d++) if (d % 3 !== 1) for (let k = 0; k < 3; k++) logs.push({ cardId: cs[k % 3].id, timestamp: now - d * DAY - k * 60000, source: 'review', rating: 3, correct: true, state: 2 });
  await db.putMany('reviewLog', logs);
});

for (const [w, h, mode] of [[375, 780, 'dark'], [375, 780, 'light'], [1440, 900, 'dark'], [1440, 900, 'light']]) {
  const tag = `${w} ${mode}`;
  const p = await newPage(w, h, mode);
  await go(p, '#/stats', '.pgrid');
  await setTheme(p, mode);
  await seed(p);
  await go(p, '#/stats', '#calGrid');
  ok(await p.locator('.eyebrow').count() === 0, `${tag}: Stats has no PROGRESS eyebrow`);
  const sb = await p.$eval('#sDeckBtn', b => { const r = b.getBoundingClientRect(), c = document.querySelector('#editBtn').getBoundingClientRect();
    return { search: !!b.querySelector('svg'), w: r.width, h: r.height, rowW: c.right - r.left, sameRow: Math.abs(c.top - r.top) < 4 }; });
  if (w < 600) {
    // On a phone the box shares its row with the Edit button; together they span the width.
    ok(sb.search && sb.h >= 44 && sb.sameRow && sb.rowW > w - 40 && sb.w > 150, `${tag}: the deck search is a box with a search icon, beside Edit, filling the row (${Math.round(sb.w)}px of ${Math.round(sb.rowW)}px)`);
  } else ok(sb.search && sb.h >= 44 && sb.w > 400, `${tag}: the deck search is a full-size box with a search icon (${Math.round(sb.w)}px)`);
  ok(await p.locator('.info-fold').count() === 1 && !(await p.locator('.info-fold > span').isVisible()), `${tag}: Retention fine print is behind an (i)`);
  await p.click('.info-fold summary');
  ok(await p.locator('.info-fold > span').isVisible() && /Multiple choice/.test(await p.textContent('.info-fold')), `${tag}: the (i) opens the fine print`);
  // answers start 70 days before 14 Oct 2026 (6 Aug), so the calendar starts in August
  const cal = await p.evaluate(() => ({ cells: document.querySelectorAll('#calGrid i').length, firstMonth: [...document.querySelectorAll('.cal-m')].find(m => m.textContent)?.textContent }));
  ok(cal.cells < 53 * 7 && cal.cells >= 9 * 7 && cal.cells <= 14 * 7 && cal.cells % 7 === 0, `${tag}: the calendar starts at the first month with answers (${cal.cells / 7} weeks)`);
  const first = await p.$eval('#calGrid i[data-t]', i => new Date(+i.dataset.t));
  ok(first.getMonth() === 6 && first.getDate() >= 27 || first.getMonth() === 7 && first.getDate() <= 3, `${tag}: its first column is the week that holds 1 Aug (${first.toDateString()})`);
  const hard = await p.$eval('.hard-list li', li => ({ f: li.querySelector('.f').textContent, img: li.querySelector('img.hard-thumb') && { w: li.querySelector('img').getBoundingClientRect().width, h: li.querySelector('img').getBoundingClientRect().height } }));
  ok(hard.f === 'Mitochondria' && hard.img && Math.round(hard.img.w) === 40 && Math.round(hard.img.h) === 40, `${tag}: Hardest shows the occlusion label and a 40px thumbnail (${JSON.stringify(hard)})`);
  await p.waitForFunction(() => document.querySelector('.hard-thumb')?.naturalWidth > 0, null, { timeout: 4000 }).then(() => ok(true, `${tag}: the thumbnail loads`), () => ok(false, `${tag}: the thumbnail loads`));
  await p.locator('#forecast .col').first().click();
  ok((await p.textContent('#forecast .chart-tip span')) === 'Scheduled for today (before daily limits)', `${tag}: forecast tooltip reads "Scheduled for today (before daily limits)"`);
  await noHScroll(p, tag);
  await p.screenshot({ path: `${SHOTS}/r2-1e-stats-${w}-${mode}.png`, fullPage: true });
  await p.close();
}

// empty Stats uses the shared start block
{
  const p = await newPage(375, 780);
  await go(p, '#/stats', '.pgrid');
  await p.evaluate(async () => { const db = await import('./js/db.js'); for (const d of await db.getDecks()) await db.deleteDeck(d.id); });
  await go(p, '#/stats', '.empty-first');
  ok(await p.locator('.empty-first #trySample').count() === 1 && await p.locator('.empty-first a:has-text("Add cards")').count() === 1 && /Nothing to study yet/.test(await p.textContent('.empty-first')), 'empty Stats shows the shared "Nothing to study yet" block');
  ok(await p.locator('.eyebrow').count() === 0, 'empty Stats: no eyebrow');
  await noHScroll(p, 'empty stats 375');
  await p.screenshot({ path: `${SHOTS}/r2-1e-stats-empty-375.png` });
  await p.click('#trySample'); await p.waitForFunction(() => location.hash.startsWith('#/welcome/review'));
  ok(true, 'Try sample cards works from Stats');
  await p.close();
}

ok(errors.length === 0, errors.length ? 'page errors: ' + errors.join(' | ') : 'no page errors');
await browser.close();
