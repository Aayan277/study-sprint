// The health check ("Check how well it fits you"), "Ignore reviews before", the retention helper ("Help me choose") and the
// Retention vs target rows in Stats. At 375 and 1440 wide, in Original dark and light and in Clinical dark and light.
// Screenshots: retention-<w>-<look>-{health,helper,stats}.png (helper chart on desktop light, health check on a phone in dark).
// Run with: node tests/browser/run.mjs e2e-retention
import { chromium, deckMenu, sheetSettled } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

const open = async (w, h, ui, mode) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: mode, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  await ctx.addInitScript(([ui, mode]) => { try { localStorage.setItem('study-sprint-theme', JSON.stringify({ ui, skin: ui === 'clinical' ? 'ocean' : 'violet', mode })); localStorage.setItem('study-sprint-rail', '0'); } catch { /* fine */ } }, [ui, mode]);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async ([ui, mode]) => { const db = await import('./js/db.js'); await db.setSetting('theme', (await import('./js/themes.js')).applyTheme({ ui, skin: ui === 'clinical' ? 'ocean' : 'violet', mode, oled: false })); }, [ui, mode]);
  return p;
};
const sideways = (p, tag) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth).then(v => ok(v, `${tag}: no sideways scroll`));
const sheetFits = (p, tag) => p.evaluate(() => { const s = document.getElementById('sheet'); return s.scrollWidth <= s.clientWidth + 1; }).then(v => ok(v, `${tag}: the sheet does not scroll sideways`));

// A history from the model itself (someone who forgets a little faster than the defaults), cards with schedules, and a deck with an exam in 30 days.
const seed = p => p.evaluate(async () => {
  const db = await import('./js/db.js');
  const { initState, nextState, forgettingCurve, mulberry32 } = await import('./js/fsrs-fit.js');
  const W = [0.15, 1.0, 1.9, 7.0, 6.6, 0.85, 3.0, 0.002, 1.6, 0.25, 0.75, 1.7, 0.065, 0.28, 1.5, 0.58, 1.85, 0.57, 0.1, 0.07, 0.2];
  const DAY = 86400000, now = Date.now(), today = Math.floor(now / DAY);
  const rng = mulberry32(11);
  const decks = [{ id: 'A', name: 'Biology', color: '#5B48E8', created: 1 }, { id: 'EX', name: 'Chemistry', color: '#22C4E0', created: 2, examDate: new Date(now + 30 * DAY).toISOString().slice(0, 10) }];
  const cards = [], states = [], log = [];
  for (const [id, n] of [['A', 320], ['EX', 90]]) {
    for (let c = 0; c < n; c++) {
      const cardId = `${id}-${c}`;
      cards.push({ id: cardId, deckId: id, front: 'Q ' + cardId, back: 'A', tags: [], created: c });
      let g = rng() < 0.2 ? 1 : 3;
      let { s, d } = initState(W, g);
      let day = today - 160 + Math.floor(rng() * 100);
      log.push({ cardId, timestamp: day * DAY + 12 * 3600000, source: 'review', mode: 'flip', correct: g > 1, ms: 3000, rating: g, state: 0 });
      let last = day;
      for (let i = 1; i < 14; i++) {
        const t = Math.max(1, Math.round(s * Math.exp((rng() - 0.5) * 1.4)));
        if (day + t >= today) break;
        const r = forgettingCurve(W, t, s);
        g = rng() < r ? (rng() < 0.12 ? 2 : rng() < 0.9 ? 3 : 4) : 1;
        day += t; last = day;
        log.push({ cardId, timestamp: day * DAY + 12 * 3600000 + i * 1000, source: 'review', mode: 'flip', correct: g > 1, ms: 3000, rating: g, state: 2 });
        ({ s, d } = nextState(W, s, d, t, g, true, r));
      }
      if (c % 9 !== 0) states.push({ cardId, due: (last + Math.max(1, Math.round(s))) * DAY + 12 * 3600000, stability: s, difficulty: d, reps: 5, lapses: 0, state: 2, lastReview: last * DAY + 12 * 3600000, elapsedDays: 5, scheduledDays: Math.round(s), learningSteps: 0 });
    }
  }
  await db.addImport({ decks, cards, reviewLog: log, cardStates: states });
  await db.setSetting('fuzz', false);
  return log.length;
});

const settingsPage = async p => {
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.goto(URL + '#/settings'); await p.waitForSelector('#advanced');
  await p.evaluate(() => { document.getElementById('advanced').open = true; });
  await p.waitForSelector('#healthOpen');
};

const LOOKS = [[375, 780, 'original', 'dark'], [1440, 900, 'original', 'light'], [375, 780, 'clinical', 'light'], [1440, 900, 'clinical', 'dark']];
for (const [w, h, ui, mode] of LOOKS) {
  const tag = `${w} ${ui} ${mode}`;
  const look = `${w}-${ui}-${mode}`;
  const p = await open(w, h, ui, mode);
  const rows = await seed(p);
  ok(rows > 800, `${tag}: a history to look at (${rows} rows)`);
  await settingsPage(p);

  // ---------- the new controls in Settings ----------
  ok((await p.getAttribute('#ret', 'min')) === '75', `${tag}: the target slider reaches 75%`);
  ok((await p.textContent('#retHelp')).trim() === 'Help me choose', `${tag}: Help me choose sits by Target retention`);
  ok((await p.textContent('#healthOpen')).trim() === 'Check how well it fits you', `${tag}: the health check sits by Personal parameters`);
  ok(await p.evaluate(() => document.getElementById('healthOpen').closest('#optRow') !== null), `${tag}: ...inside the Personal parameters row`);
  ok(await p.locator('#ignoreHint, #ignoreHint2').count() === 0 && !(await p.getAttribute('#ignoreBefore', 'aria-describedby')), `${tag}: no hint text under Ignore reviews before, and no dangling aria-describedby`);
  ok((await p.getAttribute('#ignoreBefore', 'type')) === 'date' && await p.isHidden('#ignoreClear'), `${tag}: a date picker, and no Clear while it is empty`);
  ok((await p.getAttribute('#ignoreBefore', 'max')) === await p.evaluate(async () => (await import('./js/sched-settings.js')).todayISO()), `${tag}: the date picker stops at today`);
  await p.fill('#ignoreBefore', '2020-02-03');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).ignoreBefore === '2020-02-03');
  ok(await p.isVisible('#ignoreClear'), `${tag}: the date is saved (a synced setting) and Clear appears`);
  await p.click('#ignoreClear');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).ignoreBefore === null);
  ok((await p.inputValue('#ignoreBefore')) === '', `${tag}: Clear puts it back to none`);
  await sideways(p, `${tag} settings`);

  // ---------- the health check ----------
  await p.click('#healthOpen');
  await p.waitForSelector('#sheet[open] .hc-sec', { timeout: 20000 });
  const text = await p.textContent('#hcBody');
  ok(/Fit quality/.test(text) && /Retention, last 30 days/.test(text) && /Hard button/.test(text), `${tag}: the three checks are there`);
  const fitBadge = (await p.textContent('#hcFit .hc-badge')).replace(/[^A-Za-z ]/g, '').trim();
  ok(['Good', 'OK', 'Poor'].includes(fitBadge), `${tag}: fit quality is judged in words (${fitBadge})`);
  ok(/log loss/.test(text) && /RMSE/.test(text) && /Young cards/.test(text) && /Mature cards/.test(text), `${tag}: log loss, RMSE, young and mature are shown`);
  ok((await p.locator('.hc-sug').count()) === 3, `${tag}: one line of advice for each check`);
  ok(/Nothing was changed/.test(text), `${tag}: it says it changes nothing`);
  await sheetFits(p, `${tag} health`);
  await p.screenshot({ path: `${SP}/retention-${look}-health.png` });
  if (w === 375 && mode === 'dark' && ui === 'original') await p.screenshot({ path: `${SP}/health-check-phone-dark.png` });
  await p.click('#hcClose');

  // "Ignore reviews before" is respected: everything ignored → not enough to judge
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('ignoreBefore', (await import('./js/sched-settings.js')).todayISO()); });
  await p.reload(); await p.waitForSelector('#advanced'); await p.evaluate(() => { document.getElementById('advanced').open = true; });
  await p.click('#healthOpen'); await p.waitForSelector('#sheet[open] .hc-sec', { timeout: 20000 });
  ok(/Not enough yet/.test(await p.textContent('#hcFit')), `${tag}: with every review ignored the fit says "Not enough yet"`);
  ok(/ignores reviews before/.test(await p.textContent('#hcBody')), `${tag}: ...and says which date is ignored`);
  await p.click('#hcClose');
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('ignoreBefore', null); });

  // Hard overuse is flagged
  await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const rows = Array.from({ length: 1500 }, (_, i) => ({ cardId: 'A-' + (i % 50), timestamp: Date.now() - (1 + i % 60) * 3600000 * 5, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: i % 10 ? 2 : 3, state: 2 }));
    await db.addImport({ reviewLog: rows });
  });
  await p.reload(); await p.waitForSelector('#advanced'); await p.evaluate(() => { document.getElementById('advanced').open = true; });
  await p.click('#healthOpen'); await p.waitForSelector('#sheet[open] .hc-sec', { timeout: 20000 });
  ok(/about twice the usual/.test(await p.textContent('#hcHard').then(() => p.textContent('#hcBody'))), `${tag}: Hard overuse is flagged: ${(await p.textContent("#hcBody")).slice(0, 40)}`);
  ok(/Used a lot/.test(await p.textContent('#hcHard')), `${tag}: ...with a badge`);
  await p.keyboard.press('Escape');

  // ---------- the retention helper ----------
  await sheetSettled(p); await p.reload(); await p.waitForSelector('#advanced');
  await p.click('#retHelp');
  const t0 = Date.now();
  await p.waitForSelector('#sheet[open] svg.rc-svg', { timeout: 15000 });
  const took = Date.now() - t0;
  ok(took < 4500, `${tag}: the estimate is ready within about 3 seconds (${took} ms)`);
  ok((await p.locator('svg.rc-svg').count()) === 2, `${tag}: a workload chart and, because a deck has an exam, a readiness chart`);
  ok((await p.locator('svg.rc-svg').first().locator('.rc-dot').count()) === 23, `${tag}: a point for every target from 75% to 97%`);
  const sheetText = await p.textContent('#sheet');
  ok(/estimate/i.test(sheetText) && /not a promise/.test(sheetText), `${tag}: it says it is an estimate`);
  ok(/Reviews a day/.test(sheetText) && /Target retention/.test(sheetText) && /Ready on exam day/.test(sheetText), `${tag}: the axes and the exam chart are labelled`);
  ok(/Now (=|90%)/.test(sheetText) && /Suggested \d\d%/.test(sheetText), `${tag}: the current and suggested targets are marked on the chart`);
  ok(+(await p.getAttribute('svg.rc-svg', 'aria-valuenow')) === 90, `${tag}: the pick starts on your own target`);
  ok(/Above about \d\d%, each extra point costs many more reviews/.test(sheetText), `${tag}: the knee is explained`);
  ok(/\+1 point costs about [\d.]+ more reviews a day \(\+\d+%\)/.test(sheetText), `${tag}: the cost of one more point at your target is shown: ${(sheetText.match(/At your[^.]*\./) || ["none"])[0]}`);
  ok(/Recall before last pass/.test(sheetText) && /before the final pass/.test(sheetText) && /last 3 days: about \d+ reviews a day/.test(sheetText), `${tag}: exam: recall before the final pass and the load of the last 3 days`);
  ok(/Suggested: \d\d%, the lowest target that keeps your expected recall on exam day/.test(sheetText), `${tag}: the exam deck's suggestion is based on them`);
  ok(await p.evaluate(() => document.querySelector('.rc-table') !== null), `${tag}: the same numbers are in a table`);
  ok((await p.locator('.rc-table tbody tr').count()) === 23, `${tag}: ...23 rows`);
  ok((await p.locator('.rc-table thead th').count()) === 7, `${tag}: ...with the final-pass columns for the exam deck`);
  await sheetFits(p, `${tag} helper`);
  await p.locator('.rc-sugg').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${SP}/retention-${look}-suggestion.png` });
  await p.locator('svg.rc-svg').first().scrollIntoViewIfNeeded();
  // arrow keys move the pick; the readout follows
  await p.focus('svg.rc-svg');
  await p.evaluate(() => { window.__svg = document.querySelector('svg.rc-svg'); });
  const v0 = +(await p.getAttribute('svg.rc-svg', 'aria-valuenow'));
  await p.keyboard.press('ArrowRight');
  ok(+(await p.getAttribute('svg.rc-svg', 'aria-valuenow')) === v0 + 1, `${tag}: the right arrow picks the next target`);
  ok(await p.evaluate(() => window.__svg === document.querySelector('svg.rc-svg') && document.activeElement === window.__svg), `${tag}: ...updating the chart in place (same element, still focused)`);
  ok((await p.getAttribute('svg.rc-svg', 'aria-valuetext')).startsWith(`${v0 + 1}%`), `${tag}: ...and its spoken value follows`);
  // a tap on the chart picks the nearest target
  const box = await p.locator('svg.rc-svg').first().boundingBox();
  await p.mouse.click(box.x + box.width * ((44 + (0.85 - 0.75) / 0.22 * (360 - 44 - 14)) / 360), box.y + box.height * 0.5);
  ok(+(await p.getAttribute('svg.rc-svg', 'aria-valuenow')) === 85, `${tag}: a tap on the chart picks 85%`);
  ok(/85%<\/b> target|85%/.test(await p.textContent('.rc-detail')), `${tag}: the readout says what 85% means`);
  await p.click('.rc-h label:has-text("30 days")');
  ok(/30 days/.test(await p.textContent('.rc-cap')), `${tag}: the horizon switch changes the chart`);
  if (w === 1440 && mode === 'light' && ui === 'original') await p.screenshot({ path: `${SP}/retention-helper-desk-light.png` });
  await p.screenshot({ path: `${SP}/retention-${look}-helper.png` });
  await p.click('[data-rc=use]');
  await p.waitForFunction(async () => (await (await import('./js/db.js')).getSettings()).targetRetention === 0.85);
  ok((await p.inputValue('#ret')) === '85' && (await p.textContent('#retOut')) === '85%', `${tag}: "Use 85%" sets the target and the slider`);
  ok(await p.isDisabled('[data-rc=use]'), `${tag}: ...and the button then says it is the target`);
  await p.click('#rcClose');
  ok(!(await p.isVisible('#sheet')), `${tag}: the sheet closes`);

  // a review limit: the suggestion fits it and says so
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewLimit', 12); });
  await sheetSettled(p); await p.reload(); await p.waitForSelector('#advanced');
  await p.click('#retHelp'); await p.waitForSelector('#sheet[open] svg.rc-svg', { timeout: 15000 });
  const limText = await p.textContent('#sheet');
  ok(/your limit of 12/.test(limText), `${tag}: with a review limit the suggestion mentions it (${(limText.match(/[^.]*limit of 12[^.]*\./) || [''])[0].trim().slice(0, 90)})`);
  await p.click('#rcClose');
  await p.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewLimit', null); });

  // ---------- the deck editor: the same helper, inline ----------
  await sheetSettled(p); await p.goto(URL + '#/deck/A'); await deckMenu(p); await p.click('#editDeck');
  await p.waitForSelector('#deckOpts');
  await p.evaluate(() => { document.getElementById('deckOpts').open = true; });
  await p.uncheck('#deckOwnOff');
  await p.click('#deckRetHelp');
  await p.waitForSelector('#deckRetPanel svg.rc-svg', { timeout: 15000 });
  ok((await p.locator('#deckRetPanel svg.rc-svg').count()) === 1, `${tag}: the deck editor shows the estimate for this deck (no exam chart)`);
  await p.focus('#deckRetPanel svg.rc-svg');
  for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft');
  const want = await p.getAttribute('#deckRetPanel svg.rc-svg', 'aria-valuenow');
  await p.click('#deckRetPanel [data-rc=use]');
  ok((await p.inputValue('#deckRet')) === want, `${tag}: the deck slider takes the picked ${want}%`);
  await sheetFits(p, `${tag} deck editor`);
  await p.keyboard.press('Escape');

  // ---------- Stats: retention vs target ----------
  await sheetSettled(p); await p.goto(URL + '#/stats'); await p.waitForSelector('#retSplit .rs-group', { timeout: 15000 });
  ok((await p.locator('#retSplit .rs-group').count()) === 3, `${tag}: Stats shows 7, 30 and 90 days`);
  const st = await p.textContent('#retSplit');
  ok(/Last 7 days/.test(st) && /Last 30 days/.test(st) && /Last 90 days/.test(st) && /Young/.test(st) && /Mature/.test(st) && /target \d\d%/.test(st), `${tag}: young and mature against the target, per period`);
  ok((await p.locator('#retSplit .rs-dot').count()) >= 4, `${tag}: a dot for each group with reviews`);
  await sideways(p, `${tag} stats`);
  await p.screenshot({ path: `${SP}/retention-${look}-stats.png` });
  await p.context().close();
}

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
await browser.close();
