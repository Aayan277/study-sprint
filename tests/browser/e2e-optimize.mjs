// "Optimize FSRS parameters" (Settings → Study → Advanced scheduling → Personal parameters, and the sheet behind it).
// Plan: docs/design/fsrs-optimizer-plan.md section 9. Covers: the row with too few reviews, the sheet's wording, a real run in the
// worker (proved by a busy-main-thread probe, relative to a baseline measured in the same page; see `responsive` below), the saved weights and what the Review buttons show,
// Reset to default with the in-page confirm, Cancel, a sync that changes the setting during a run, 375 and 1440 wide, dark and light.
// Run with: node tests/browser/run.mjs optimize
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

const open = async (w, h, scheme) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, serviceWorkers: 'block', isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async scheme => { const db = await import('./js/db.js'); await db.setSetting('theme', (await import('./js/themes.js')).applyTheme({ skin: 'violet', mode: scheme })); }, scheme);
  return p;
};
const sideways = (p, tag) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth).then(v => ok(v, `${tag}: no sideways scroll`));
const sheetFits = (p, tag) => p.evaluate(() => { const s = document.getElementById('sheet'); return s.scrollWidth <= s.clientWidth + 1; }).then(v => ok(v, `${tag}: the sheet does not scroll sideways`));
const saved = p => p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).fsrsParams);
const settingsPage = async p => {
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');                // (leave first, so Settings is drawn fresh)
  await p.goto(URL + '#/settings'); await p.waitForSelector('#advanced');
  await p.evaluate(() => { document.getElementById('advanced').open = true; });
  await p.waitForSelector('#optOpen');
};

// Review history made with a person's own weights (someone who forgets faster than the defaults say), by the model itself,
// from a fixed seed. `decks` = [[deckId, cards]], with one deck set to two relearning steps so the per-deck clipping is used.
const seed = (p, decks, plays) => p.evaluate(async ({ decks, plays }) => {
  const db = await import('./js/db.js');
  const { initState, nextState, forgettingCurve, mulberry32 } = await import('./js/fsrs-fit.js');
  const W = [0.12, 0.7, 1.4, 5.5, 6.8, 0.9, 3.0, 0.002, 1.35, 0.35, 0.7, 1.9, 0.07, 0.3, 1.3, 0.55, 1.9, 0.6, 0.12, 0.08, 0.3];
  const DAY = 86400000, today = Math.floor(Date.now() / DAY);
  const rng = mulberry32(7);
  const deckRows = [], cards = [], log = [];
  for (const [id, n, extra] of decks) {
    deckRows.push({ id, name: id, color: '#5B48E8', created: 1, ...(extra ? { options: extra } : {}) });
    for (let c = 0; c < n; c++) {
      const cardId = `${id}-${c}`;
      cards.push({ id: cardId, deckId: id, front: 'Q ' + cardId, back: 'A', tags: [], created: 1 });
      const u = rng();
      let g = u < 0.25 ? 1 : u < 0.4 ? 2 : u < 0.9 ? 3 : 4;
      let { s, d } = initState(W, g);
      let day = today - 450 + Math.floor(rng() * 150);
      log.push({ cardId, timestamp: day * DAY + 12 * 3600000, source: 'review', mode: 'flip', correct: g > 1, ms: 3000, rating: g, state: 0 });
      const len = 3 + Math.floor(rng() * 9);
      for (let i = 1; i < len; i++) {
        const t = ((g === 1 && rng() < 0.6) ? 0 : Math.max(1, Math.round(s * Math.exp((rng() - 0.5) * 1.6))));
        if (day + t >= today - 1) break;
        const r = forgettingCurve(W, t, s);
        g = t === 0 ? (rng() < 0.8 ? 3 : 1) : rng() < r ? (rng() < 0.1 ? 2 : rng() < 0.9 ? 3 : 4) : 1;
        day += t;
        log.push({ cardId, timestamp: day * DAY + 12 * 3600000 + i * 1000, source: 'review', mode: 'flip', correct: g > 1, ms: 3000, rating: g, state: 2 });
        ({ s, d } = nextState(W, s, d, t, g, true, r));
      }
    }
  }
  // Game answers that did not change any schedule: logged, never used.
  for (let i = 0; i < plays; i++) {
    log.push({ cardId: cards[i % cards.length].id, timestamp: (today - 5) * DAY + i * 1000, source: 'play', mode: 'classic', correct: true, ms: 2000, rating: 3, state: 2, applied: false, reason: 'not-due' });
  }
  const preview = [{ id: 'PV', name: 'Preview', color: '#5B48E8', created: 1 }];
  await db.addImport({ decks: [...deckRows, ...preview], cards: [...cards, { id: 'pv', deckId: 'PV', front: 'Preview card', back: 'x', tags: [], created: 1 }], reviewLog: log,
    cardStates: [{ cardId: 'pv', due: Date.now() - 3600000, stability: 20, difficulty: 5, reps: 6, lapses: 0, state: 2, lastReview: Date.now() - 20 * DAY, elapsedDays: 20, scheduledDays: 20, learningSteps: 0 }] });
  await db.setSetting('fuzz', false);
  return log.filter(r => r.source === 'review').length;
}, { decks, plays });

// Is the page free while a fit runs? An absolute frame-gap limit (the old "no gap over 200 ms") says more about how busy the machine
// is than about the app, and cannot tell the worker from the main-thread fallback anyway: the fallback works in 30 ms slices, so its
// frame gaps stay small. What does differ is how often the main thread gets to run other tasks. A probe re-queues itself with
// setTimeout(0) all the time and counts its turns:
//   - idle, a page gives it a turn every few ms; a fit on the page leaves one turn per 30 ms slice, a fit in a worker barely dents it;
//   - the same probe is read in the same page just before the run (baseline), so a loaded or CPU-throttled machine lowers both
//     numbers alike, and only the ratio between them is judged.
// A run also has to have used a Worker (counted by wrapping the constructor). The rAF gap is still read, for the message only.
// Measured: a Worker keeps 77-91% of the idle turns at 1-2x CPU throttle and 48-66% at 4x; the fit on the page 29-46% and 14-22%. A fixed
// limit cannot separate them at every speed, so the long run only has to stay above this floor, and the main-thread run is compared with the Worker runs.
const MIN_TURN_RATIO = 0.35;
const T = Number(process.env.CPU_THROTTLE) || 1;      // the CPU slowdown the run is under (see pw.mjs)
const MAX_FRAME_GAP = 1000 * T;                         // loose absolute limit: a long synchronous block on the page still fails
const instrument = p => p.evaluate(() => {
  window.__workers = 0;
  const W = window.Worker;
  if (W) window.Worker = class extends W { constructor(...a) { super(...a); window.__workers++; } };
});
const probeStart = p => p.evaluate(() => {
  const t0 = performance.now();
  const pr = window.__probe = { w0: window.__workers, on: true, turns: 0, t0, last: t0, maxGap: 0, frames: 0, maxFrame: 0, lastFrame: t0 };
  const tick = () => { if (!pr.on) return; const n = performance.now(); pr.maxGap = Math.max(pr.maxGap, n - pr.last); pr.last = n; pr.turns++; setTimeout(tick, 0); };
  const frame = t => { if (!pr.on) return; pr.maxFrame = Math.max(pr.maxFrame, t - pr.lastFrame); pr.lastFrame = t; pr.frames++; requestAnimationFrame(frame); };
  setTimeout(tick, 0); requestAnimationFrame(frame);
});
const probeStop = p => p.evaluate(() => {
  const pr = window.__probe; pr.on = false;
  const ms = performance.now() - pr.t0;
  return { rate: pr.turns / ms, ms, turns: pr.turns, maxGap: pr.maxGap, frames: pr.frames, maxFrame: pr.maxFrame, workers: window.__workers - pr.w0 };
});
// The baseline: the probe on the idle page for a fixed window (a measuring window, not a wait for anything to happen).
const baseline = async p => {
  await probeStart(p);
  await p.evaluate(() => new Promise(done => { const t = performance.now(); (function f() { performance.now() - t >= 1000 ? done() : setTimeout(f, 50); })(); }));
  return probeStop(p);
};
const ratioOf = (base, run) => run.rate / base.rate;
const responsive = (base, run) => run.workers > 0 && ratioOf(base, run) >= MIN_TURN_RATIO;
const describe = (base, run) => `main thread kept ${Math.round(ratioOf(base, run) * 100)}% of its idle turns (${run.turns} in ${Math.round(run.ms)} ms vs ${base.rate.toFixed(2)}/ms idle), ${run.workers} worker(s), longest frame gap ${Math.round(run.maxFrame)} ms over ${run.frames} frames`;
const goodButton = async p => {
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');                // (leave first, so the session is looked at again)
  await p.goto(URL + '#/review/PV'); await p.waitForSelector('#showBtn, .rate[data-rate="3"]');
  if (await p.locator('#showBtn').count()) await p.click('#showBtn');         // (a session left open shows the answer already)
  await p.waitForSelector('.rate[data-rate="3"]');
  return (await p.$$eval('.rate .mono', l => l.map(e => e.textContent.trim()))).join(' / ');
};


const INTRO = "Fit the scheduler to your own review history so it predicts more accurately when you'll forget. It runs on this device and takes up to a minute. Your cards keep their dates; the new settings apply from each card's next review. Only cards you rate in Review (and Anki history) are used, not game answers.";
// Remember what the sheet showed while a run was going: the bar, the phase lines, the longest gap between frames.
const watchSheet = p => p.evaluate(() => {
  const seen = window.__seen = { bar: false, now: [], lines: new Set(), note: '' };
  new MutationObserver(() => {
    const bar = document.querySelector('[role=progressbar]');
    if (bar) { seen.bar = true; seen.now.push(+bar.getAttribute('aria-valuenow')); }
    const live = document.getElementById('optLive');
    if (live) seen.lines.add(live.textContent);
    const n = document.getElementById('optNote');
    if (n) seen.note = n.textContent;
  }).observe(document.getElementById('sheet'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-valuenow'] });
});
const finished = p => p.waitForSelector('#optDone', { timeout: 150000 });
const openSheet = async p => {
  await p.click('#optOpen'); await p.waitForSelector('#sheet[open] [data-opt]');
};

const workerRatios = [];       // (the turn ratio of each long Worker run: the main-thread run below has to come out clearly under them)
for (const [w, h, scheme] of [[375, 780, 'dark'], [1440, 900, 'light']]) {
  const tag = `${w} ${scheme}`;
  const p = await open(w, h, scheme);

  // ---------- too few reviews: the button is off, with the reason ----------
  await seed(p, [['A', 25, null]], 0);
  const few = await p.evaluate(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length);
  await settingsPage(p);
  ok(few < 400, `${tag}: a small history (${few} rows)`);
  ok((await p.locator('#optRow b').first().textContent()) === 'Personal parameters', `${tag}: the Advanced scheduling row is called Personal parameters`);
  ok((await p.textContent('#optStatus')) === 'Using the standard FSRS settings.', `${tag}: it says the standard settings are in use`);
  ok(await p.isDisabled('#optOpen'), `${tag}: Optimize… is off`);
  ok((await p.textContent('#optWhy')) === `Available after 400 reviews (you have ${few}).`, `${tag}: the reason is shown: ` + await p.textContent('#optWhy'));
  ok(await p.locator('#optReset').count() === 0, `${tag}: no Reset link while the standard settings are in use`);
  ok((await p.getAttribute('#optOpen', 'aria-describedby')) === 'optStatus optWhy', `${tag}: the reason is attached to the button for screen readers`);
  await sideways(p, `${tag} settings (few)`);

  // ---------- enough reviews: the sheet ----------
  await seed(p, [['B', 250, null], ['C', 200, { relearningSteps: '10m 1h' }]], 80);
  const counted = await p.evaluate(async () => { const db = await import('./js/db.js'); const { buildHistories } = await import('./js/fsrs-data.js'); return buildHistories(await db.getAll('reviewLog')).reviews; });
  ok(counted >= 400, `${tag}: enough reviews count (${counted})`);
  ok(await p.evaluate(async () => {
    const db = await import('./js/db.js');
    const a = await db.getAll('reviewLog'), b = await db.getAllInPieces('reviewLog', 7);          // many small pieces
    return a.length > 400 && JSON.stringify(a) === JSON.stringify(b);
  }), `${tag}: reading the log in small pieces gives the same rows as reading it whole`);
  await instrument(p);
  const goodBefore = await goodButton(p);
  await settingsPage(p);
  ok(!(await p.isDisabled('#optOpen')) && (await p.locator('#optWhy').count()) === 0, `${tag}: Optimize… is on`);
  await sideways(p, `${tag} settings`);
  await p.screenshot({ path: `${SP}/opt-${w}-${scheme}-row.png` });
  await openSheet(p);
  ok((await p.textContent('#sheetTitle')) === 'Optimize parameters' && (await p.textContent('.opt-intro')) === INTRO, `${tag}: the sheet opens with the intro, word for word`);
  await sheetFits(p, `${tag} intro`); await p.screenshot({ path: `${SP}/opt-${w}-${scheme}-intro.png` });

  await watchSheet(p);
  const base = await baseline(p);
  await probeStart(p);
  await p.click('#optGo');
  await finished(p);
  const beat = await probeStop(p);
  const seen = await p.evaluate(() => ({ bar: window.__seen.bar, lines: [...window.__seen.lines], now: window.__seen.now }));
  ok(seen.bar, `${tag}: a progress bar showed while it ran`);
  ok(seen.now.every((v, i) => v >= 0 && v <= 100 && (i === 0 || v >= seen.now[i - 1])), `${tag}: its value only goes up (${seen.now.slice(-3)})`);
  ok(seen.lines.some(l => /^(Reading your reviews|Finding your settings|Checking they predict better)…/.test(l)), `${tag}: the phase line was announced: ${[...seen.lines].join(' | ')}`);
  ok(beat.workers === 1 && (await p.evaluate(() => window.__seen.note)) === '', `${tag}: the fit ran in a Worker (${beat.workers} started) and the slower-app note of the page fallback never showed`);
  ok(beat.maxFrame < MAX_FRAME_GAP, `${tag}: no frame gap over ${MAX_FRAME_GAP} ms (longest ${Math.round(beat.maxFrame)} ms)`);
  // (a short run is mostly the page reading and judging the history itself, so only the Worker is asserted here; the ratio is
  // judged on the long run below, where the fit dominates)
  ok(beat.frames > 3, `${tag}: the page kept drawing: ` + describe(base, beat));
  const done = await p.textContent('#optDone');
  ok(done.includes("Done. Your new settings predict your answers better, so they're now in use."), `${tag}: the "better" wording`);
  ok(/rediction error \(log loss\) \d\.\d{3} → \d\.\d{3} · RMSE \d+\.\d% → \d+\.\d%/.test(done), `${tag}: the details line: ` + (done.match(/Checked on.*?%\s*→\s*[\d.]+%/s) || [''])[0]);
  ok(done.includes('Checked on your newest 20% of reviews'), `${tag}: the numbers say what they were checked on`);
  ok(await p.locator('#optDone .opt-fold .opt-detail').count() === 1 && !(await p.textContent('#optDone .opt-result')).includes('log loss'), `${tag}: log loss and RMSE are in Details; the main line is plain words`);
  ok(done.includes('Run this again every month or so as you review more.'), `${tag}: the "run it again" line`);
  const first = await saved(p);
  const refit = await p.evaluate(async () => {
    // what the sheet should have saved: the refit on all the data (fitChecked's `w`), clipped with no extra relearning steps
    const db = await import('./js/db.js'), srs = await import('./js/srs.js');
    const { buildHistories } = await import('./js/fsrs-data.js'), { fitChecked } = await import('./js/fsrs-fit.js');
    const hist = buildHistories(await db.getAll('reviewLog'));
    const steps = hist.cards.map(h => (h.cardId.startsWith('C-') ? 2 : 1));
    const it = fitChecked({ cards: hist.cards, steps, current: srs.default_w.slice(), defaults: srs.default_w.slice(), bounds: srs.CLAMP_PARAMETERS(srs.W17_W18_Ceiling, true) });
    let r; do { r = it.next(); } while (!r.done);
    return r.value.status === 'better' ? srs.clipParameters(r.value.w, 0, true) : null;
  });
  ok(refit && refit.every((x, i) => Math.abs(x - first.w[i]) < 1e-9), `${tag}: what was saved is the refit on all the data`);
  ok(first && first.w.length === 21 && first.w.every(Number.isFinite) && first.version === 'fsrs-6', `${tag}: 21 numbers are saved`);
  ok(first.logLoss.after < first.logLoss.before && first.reviews === counted && first.cards > 0, `${tag}: with its metrics (${first.logLoss.before.toFixed(3)} → ${first.logLoss.after.toFixed(3)}) and ${first.reviews} reviews`);
  await p.click('.opt-fold summary');
  ok((await p.textContent('#optW')).split(',').length === 21, `${tag}: the Details fold lists the 21 numbers`);
  await sheetFits(p, `${tag} done`); await p.screenshot({ path: `${SP}/opt-${w}-${scheme}-done.png` });
  await p.click('#optClose');
  await p.waitForFunction(() => /^Using your own settings, from [\d,]+ reviews \(.+\)\.$/.test(document.getElementById('optStatus')?.textContent || ''));
  ok(true, `${tag}: Settings now says: ` + await p.textContent('#optStatus'));
  ok((await p.locator('#optReset').count()) === 1, `${tag}: Reset to default is there`);
  const goodAfter = await goodButton(p);
  ok(goodAfter !== goodBefore, `${tag}: the Review buttons follow the new weights (${goodBefore} → ${goodAfter})`);

  // ---------- Reset to default, confirmed inside the page ----------
  await settingsPage(p);
  await p.click('#optReset');
  ok(await p.isVisible('#optConfirm') && (await p.textContent('#optConfirmQ')) === 'Go back to the standard settings? Your cards keep their dates.', `${tag}: the confirm is in the page, with its wording`);
  ok((await p.textContent('#optConfirm .sheet-actions')).replace(/\s+/g, '') === 'CancelReset', `${tag}: with Cancel and Reset`);
  await sideways(p, `${tag} confirm`); await p.screenshot({ path: `${SP}/opt-${w}-${scheme}-confirm.png` });
  await p.click('#optNo');
  ok(!(await p.isVisible('#optConfirm')) && (await saved(p)).w !== null, `${tag}: Cancel keeps the weights`);
  await p.click('#optReset'); await p.click('#optYes');
  await p.waitForFunction(() => document.getElementById('optStatus')?.textContent === 'Using the standard FSRS settings.');
  const reset = await saved(p);
  ok(reset.w === null && reset.version === 'fsrs-6', `${tag}: Reset saves w: null`);
  ok((await goodButton(p)) === goodBefore, `${tag}: the Review button is back to ${goodBefore}`);

  // ---------- weights from another device (sync): an open Review session starts again with them ----------
  const open0 = await goodButton(p);                                                // a session is open, answer showing
  const bumped = await p.evaluate(async first => {
    const db = await import('./js/db.js'), v = db.scheduleVersion();
    await db.applyRemote([{ store: 'settings', id: 'fsrsParams', updated_at: Date.now() + 5000, data: { value: first } }]);
    return db.scheduleVersion() > v;
  }, first);
  ok(bumped, `${tag}: weights applied from the server bump the schedule version`);
  const open1 = await goodButton(p);
  ok(open1 !== open0 && open1 === goodAfter, `${tag}: the open Review session was planned again with them (${open0} → ${open1})`);
  await settingsPage(p); await p.click('#optReset'); await p.click('#optYes');
  await p.waitForFunction(() => document.getElementById('optStatus')?.textContent === 'Using the standard FSRS settings.');

  // ---------- Reset to default pressed while a run is going: the run does not undo it ----------
  await openSheet(p);
  await p.evaluate(() => {
    new MutationObserver((_, o) => {
      if (!/^Finding your settings/.test(document.getElementById('optLive')?.textContent || '')) return;
      o.disconnect();
      import('./js/db.js').then(db => db.setSetting('fsrsParams', { w: null, at: Date.now(), version: 'fsrs-6' }));
    }).observe(document.getElementById('sheet'), { subtree: true, childList: true, characterData: true });
  });
  await p.click('#optGo'); await finished(p);
  ok((await p.textContent('#optDone')).includes('You reset your parameters while this was running, so nothing changed.'), `${tag}: a reset during the run is noticed`);
  ok((await saved(p)).w === null, `${tag}: and the reset stands`);
  await p.click('#optClose');

  // ---------- another device saves its own result during a run ----------
  // (weights that are clearly good: the ones the history was made with, so a fresh fit cannot beat them on the held-out reviews)
  const rival = { w: [0.12, 0.7, 1.4, 5.5, 6.8, 0.9, 3.0, 0.002, 1.35, 0.35, 0.7, 1.9, 0.07, 0.3, 1.3, 0.55, 1.9, 0.6, 0.12, 0.08, 0.3], at: Date.now(), reviews: 1, cards: 1, version: 'fsrs-6' };
  await settingsPage(p); await openSheet(p);
  await p.evaluate(first => {
    new MutationObserver((_, o) => {
      if (!/^Finding your settings/.test(document.getElementById('optLive')?.textContent || '')) return;       // the run has started (the settings were read)
      o.disconnect();
      import('./js/db.js').then(db => db.setSetting('fsrsParams', first));
    }).observe(document.getElementById('sheet'), { subtree: true, childList: true, characterData: true });
  }, rival);
  await p.click('#optGo'); await finished(p);
  ok((await p.textContent('#optDone')).includes('Your other device already updated your parameters; they predict as well, so nothing changed.'), `${tag}: a sync during the run is noticed: ` + (await p.textContent('#optDone')).slice(0, 200));
  ok(JSON.stringify((await saved(p)).w) === JSON.stringify(rival.w), `${tag}: the other device's weights are kept`);
  await p.click('#optClose');
  await settingsPage(p); await p.click('#optReset'); await p.click('#optYes');
  await p.waitForFunction(() => document.getElementById('optStatus')?.textContent === 'Using the standard FSRS settings.');

  // ---------- a big history: Cancel, then a full run that must not freeze the page ----------
  const total = await seed(p, [['D', 5000, null]], 0);
  ok(total > 20000, `${tag}: a big history (${total} reviews)`);
  await settingsPage(p);
  const stamp = await saved(p);
  await openSheet(p);
  await p.click('#optGo');
  await p.waitForFunction(() => /^Finding your settings/.test(document.getElementById('optLive')?.textContent || '') && +document.querySelector('[role=progressbar]').getAttribute('aria-valuenow') > 5);
  await p.screenshot({ path: `${SP}/opt-${w}-${scheme}-running.png` });
  ok((await p.textContent('#optCancel')) === 'Cancel' && /^(Reading your reviews…|Finding your settings…|Checking they predict better…)/.test(await p.textContent('.opt-phase')), `${tag}: running shows the phase and a Cancel button: ` + await p.textContent('.opt-phase'));
  await sheetFits(p, `${tag} running`);
  await p.click('#optCancel'); await finished(p);
  ok((await p.textContent('#optDone')).includes('Stopped. Nothing changed.'), `${tag}: Cancel says it stopped`);
  await p.waitForTimeout(1500);
  ok(JSON.stringify(await saved(p)) === JSON.stringify(stamp) && stamp.w === null, `${tag}: nothing was saved after Cancel`);
  await p.click('#optClose');

  await openSheet(p);
  await watchSheet(p);
  const baseBig = await baseline(p);
  await probeStart(p); await p.click('#optGo');
  await finished(p);
  const big = await probeStop(p);
  ok(big.ms > 1000 && big.workers === 1 && (await p.evaluate(() => window.__seen.note)) === '', `${tag}: a ${total}-review run took a while (${Math.round(big.ms)} ms) and used a Worker (${big.workers} started, no page-fallback note)`);
  ok(big.maxFrame < MAX_FRAME_GAP, `${tag}: and no frame gap over ${MAX_FRAME_GAP} ms (longest ${Math.round(big.maxFrame)} ms)`);
  ok(responsive(baseBig, big), `${tag}: a ${total}-review run kept the page responsive: ` + describe(baseBig, big));
  workerRatios.push(ratioOf(baseBig, big));
  const bigSaved = await saved(p);
  ok(bigSaved.w && bigSaved.w.length === 21, `${tag}: and saved its weights`);
  await p.click('#optClose');

  await sideways(p, `${tag} end`);
  await p.context().close();
}

// ---------- no module worker: the same work on the page, with a note ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 780 }, colorScheme: 'dark', serviceWorkers: 'block', isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { delete window.Worker; });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  await p.goto(URL + '#/decks'); await p.waitForSelector('.deck');
  ok(await p.evaluate(() => typeof Worker === 'undefined'), 'no-worker: Worker is gone in this window');
  await instrument(p);
  await seed(p, [['B', 250, null], ['C', 200, { relearningSteps: '10m 1h' }], ['D', 4000, null]], 0);       // (long enough for the fit to dominate)
  await settingsPage(p); await openSheet(p);
  await watchSheet(p);
  const base = await baseline(p);
  await probeStart(p);
  await p.click('#optGo');
  await finished(p);
  const beat = await probeStop(p);
  // The checks must be able to fail: with the fit forced onto the page, the Worker checks above would fail, and the turn ratio
  // must still come out below every Worker run (so the measure itself tells the two apart).
  ok(beat.workers === 0, 'no-worker: no Worker was started, so the "fit ran in a Worker" checks above would FAIL for this run: ' + describe(base, beat));
  ok(workerRatios.length > 0 && ratioOf(base, beat) < Math.min(...workerRatios), `no-worker: and the busy-main-thread measure alone tells it from a Worker run (${Math.round(ratioOf(base, beat) * 100)}% of idle turns on the page, against ${workerRatios.map(r => Math.round(r * 100) + '%').join(' and ')} with a Worker)`);
  const note = await p.evaluate(() => window.__seen.note);
  ok(note === "This may make the app slower until it's done.", 'no-worker: the slower-app note is shown: ' + note);
  const r = await saved(p);
  ok(r && r.w && r.w.length === 21, 'no-worker: the fit still finishes and saves');
  await ctx.close();
}

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
