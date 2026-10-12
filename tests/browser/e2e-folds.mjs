// Folded long screens: Settings (Advanced scheduling, Danger zone), Stats on a computer (nothing folded),
// and the card filter's groups. (Stats on a phone and Play's Customise are checked in e2e-stats and e2e-play-exam.)
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const open = async (w, h) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return p;
};

for (const [w, h, name] of [[375, 812, 'phone'], [1440, 900, 'computer']]) {
  const p = await open(w, h);
  await p.goto('http://localhost:8123/#/settings'); await p.waitForSelector('#advanced');
  const vis = async sel => p.isVisible(sel);
  // always shown
  const shown = { theme: '#skins', mode: 'input[name=mode] >> nth=0', oled: '#oled', retention: '#ret', newPerDay: '#npd', reviewsPerDay: '#rpd', sync: '#syncBox', backup: '#exportBtn', restore: 'label.file-btn' };
  for (const [k, sel] of Object.entries(shown)) ok(k === 'mode' ? await p.locator('.chip').first().isVisible() : await vis(sel), `${name}: ${k} is shown without opening anything`);
  // folded
  ok(!(await p.getAttribute('#advanced', 'open') !== null) && !(await vis('#leech')) && !(await vis('#timerSec')) && !(await vis('#lsteps')), `${name}: leeches, Play timer and steps are folded inside Advanced scheduling`);
  ok(!(await vis('#resetBtn')) && (await p.textContent('#dangerZone > summary')).trim() === 'Danger zone', `${name}: Reset all data is behind "Danger zone"`);
  ok(await p.evaluate(() => { const d = document.getElementById('dangerZone'); return d.closest('section').querySelector('h2').textContent === 'Your data' && d.nextElementSibling === null; }), `${name}: Danger zone is the last thing in Your data`);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no sideways scroll`);
  await p.screenshot({ path: `${SP}/folds-settings-${name}.png`, fullPage: true });
  // open Advanced: leeches and the timer are in it
  await p.click('#advanced summary');
  ok(await vis('#leech') && await vis('#timerSec') && await vis('[data-leech=tag]') && await vis('#lsteps') && await vis('#maxDays') && await vis('#fuzz') && await vis('[data-easy="1"]'), `${name}: Advanced scheduling holds steps, max interval, easy days, spread, timer and leeches`);
  await p.click('#timerPlus'); await p.click('#timerPlus'); await p.click('#timerMinus');
  ok(await p.inputValue('#timerSec') === '9' && (await p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).timer)) === 9, `${name}: the Play timer default can be changed there`);
  await p.click('#leechPlus'); await p.click('[data-leech=tag]');
  const s = await p.evaluate(async () => (await import('./js/db.js')).getSettings());
  ok(s.leechThreshold === 9 && s.leechAction === 'tag', `${name}: leech settings still save`);
  await p.reload(); await p.waitForSelector('#advanced');
  ok(await p.getAttribute('#advanced', 'open') !== null && await vis('#timerSec'), `${name}: Advanced stays open after a reload (remembered)`);
  ok(await p.evaluate(() => { try { return localStorage.getItem('study-sprint-fold-settings-advanced') === '1'; } catch { return false; } }), `${name}: remembered in localStorage`);
  // danger zone: still reaches the old confirmation
  await p.click('#dangerZone > summary'); ok(await vis('#resetBtn'), `${name}: tapping Danger zone shows Reset`);
  await p.click('#resetBtn'); await p.waitForSelector('#rsYes'); ok(true, `${name}: Reset still asks for confirmation`); await p.click('#rsNo');
  await p.reload(); await p.waitForSelector('#advanced');
  ok(!(await vis('#resetBtn')), `${name}: the Danger zone closes again on a new visit`);
  // storage blocked: the page still draws
  await p.context().close();
}

// Stats on a computer: everything is shown, with no fold
{
  const p = await open(1440, 900);
  await p.goto('http://localhost:8123/#/stats'); await p.waitForSelector('.pgrid, .empty');
  await p.evaluate(async () => { const db = await import('./js/db.js'); const cs = await db.getAll('cards'); const now = Date.now();
    await db.putMany('cardStates', cs.slice(0, 4).map(c => ({ cardId: c.id, due: now, stability: 5, difficulty: 5, elapsedDays: 1, scheduledDays: 1, learningSteps: 0, reps: 3, lapses: 1, state: 2, lastReview: now - 86400000 })));
    await db.putMany('reviewLog', cs.slice(0, 4).map((c, i) => ({ cardId: c.id, timestamp: now - i * 60000, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: 2 }))); });
  await p.reload(); await p.waitForSelector('.chart');
  ok(!(await p.isVisible('#moreBtn')), 'computer: there is no "More stats" button');
  ok(await p.isVisible('#btnTitle') && await p.isVisible('#hours') && await p.isVisible('#difficulty') && await p.isVisible('#mTitle') && await p.isVisible('#hardTitle') && await p.isVisible('#calTitle'), 'computer: every stats section is shown');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'computer: no sideways scroll');
  const box = id => p.locator(id).boundingBox();
  const [bt, hrs] = [await box('#btnTitle'), await box('#hours')];
  ok(Math.abs(bt.y - hrs.y) < 80 && hrs.x > bt.x, 'computer: the cards are still laid out in two columns');
  await p.screenshot({ path: SP + '/folds-stats-computer.png', fullPage: true });
  await p.context().close();
}

// Card filters: grouped, nothing removed
{
  const p = await open(375, 812);
  await p.goto('http://localhost:8123/#/browse'); await p.waitForSelector('#brFilter');
  const groups = await p.$$eval('#brFilter optgroup', g => g.map(x => x.label));
  ok(JSON.stringify(groups) === '["Status","Flags","Problems"]', 'card filters are grouped: ' + groups);
  const opts = await p.$$eval('#brFilter option', o => o.map(x => x.value));
  ok(opts.length === 14 && opts[0] === 'all' && opts.includes('leech') && opts.includes('dupes') && opts.includes('flag4') && opts.includes('buried'), 'every filter is still there (' + opts.length + ')');
  await p.selectOption('#brFilter', 'new'); ok(await p.inputValue('#brFilter') === 'new', 'a grouped filter still works');
  await p.screenshot({ path: SP + '/folds-filter.png' });
  await p.context().close();
}
await browser.close();
if (errors.length) { console.log('ERRORS\n' + errors.join('\n')); process.exitCode = 1; }
