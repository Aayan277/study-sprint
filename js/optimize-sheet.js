// "Optimize FSRS parameters": the sheet opened from Settings → Study → Advanced scheduling → Personal parameters.
// It fits your own FSRS-6 weights to your review history (js/fsrs-fit.js, in a background worker), keeps them only if they
// predict your answers better than the ones in use, and saves them as the synced setting `fsrsParams`.
// Design, wording and reasons: docs/design/fsrs-optimizer-plan.md (sections 5 to 8 and 14).
//
// The pieces here:
//   runFit      runs a fit in a module Worker (or on the main thread in small slices if workers are not available),
//               with a time limit and a way to cancel. Nothing is saved by it.
//   fitChecked  (in fsrs-fit.js, run by the worker) fits on the first 80% of your days, judges the new weights against the ones in use
//               on the last 20% (each deck's weights clipped for its relearning steps, as the scheduler does), and only if they win
//               fits again on everything.
//   startRun    reads the log, runs that, re-reads the setting (a sync may have changed it) and saves.
//   openOptimizeSheet   the sheet. A run goes on if the sheet is closed.

import * as db from './db.js';
import { buildHistories, MIN_REVIEWS } from './fsrs-data.js';
import { fitChecked, judge, splitHistories, HOLDOUT_SHARE, HOLDOUT_MIN } from './fsrs-fit.js';
import { deckSchedulerOptions, FSRS_VERSION, rowsFrom } from './sched-settings.js';
import { effectiveDeck } from './deck-tree.js';
import { $, esc, openSheet, closeSheet, toast } from './ui.js';

export const TIME_LIMIT_MS = 120000;
const SLICE_MS = 30;                 // the main-thread fallback works this long, then lets the page breathe

const num = n => Math.round(n).toLocaleString('en');
const word = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

// ---------- running a fit ----------
// runFit(input, { onProgress, onFallback, timeoutMs, useWorker }) → { promise, cancel }.
// The promise always resolves (never rejects) with one of:
//   { status: 'done', result, inWorker }   result is what fitChecked() returned
//   { status: 'cancelled' }   { status: 'timeout' }   { status: 'error', message }
// Typed arrays are copied into the worker (not moved), because the page needs the histories again to judge the result.
export function runFit(input, { onProgress = () => {}, onFallback = () => {}, timeoutMs = TIME_LIMIT_MS, useWorker = true } = {}) {
  let finish, worker = null, timer = 0, stopped = false;
  const promise = new Promise(resolve => {
    finish = outcome => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (worker) { worker.terminate(); worker = null; }
      resolve(outcome);
    };
  });
  const cancel = () => finish({ status: 'cancelled' });
  timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

  // The same generator, in slices, on the page itself.
  const runOnPage = () => {
    onFallback();
    let it;
    try { it = fitChecked(input); } catch (err) { finish({ status: 'error', message: String(err?.message || err) }); return; }
    const step = () => {
      if (stopped) return;
      const end = performance.now() + SLICE_MS;
      try {
        for (;;) {
          const r = it.next();
          if (r.done) { finish({ status: 'done', result: r.value, inWorker: false }); return; }
          onProgress(r.value);
          if (performance.now() >= end) break;
        }
      } catch (err) { finish({ status: 'error', message: String(err?.message || err) }); return; }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);              // (not at once: the caller gets its Cancel handle first)
  };

  if (!useWorker || typeof Worker === 'undefined') { runOnPage(); return { promise, cancel }; }
  let heard = false;
  try {
    worker = new Worker(new URL('./fsrs-optimize-worker.js', import.meta.url), { type: 'module' });
  } catch { worker = null; runOnPage(); return { promise, cancel }; }
  worker.onmessage = e => {
    heard = true;
    const m = e.data || {};
    if (m.type === 'progress') onProgress({ phase: m.phase, progress: m.progress });
    else if (m.type === 'done') finish({ status: 'done', result: m.result, inWorker: true });
    else if (m.type === 'error') finish({ status: 'error', message: m.message });
  };
  // A module worker that can't start (old Safari, a private mode that blocks workers) fires `error` before anything arrives:
  // do the same work on the page instead.
  worker.onerror = e => {
    e.preventDefault?.();
    if (stopped) return;
    const w = worker; worker = null; w?.terminate();
    if (!heard) runOnPage(); else finish({ status: 'error', message: e.message || 'The worker stopped.' });
  };
  try { worker.postMessage({ type: 'fit', input }); } catch (err) { worker.onerror({ message: String(err) }); }
  return { promise, cancel };
}

// ---------- one run ----------
// The state of the current run lives here, so closing the sheet does not stop it and reopening shows where it is.
//   status: 'reading' | 'running' | 'result'
//   result: { kind: 'better' | 'same' | 'other-device' | 'not-enough' | 'cancelled' | 'failed', ... }
let run = null;
let token = 0;                       // each run has its own; a cancelled one stops touching the page
let cancelledToken = 0;              // the run whose Cancel was pressed (checked again right before saving)
let onChange = () => {};

const pctText = x => `${(x * 100).toFixed(1)}%`;

function setRun(patch) {
  run = { ...run, ...patch };
  draw();
}

async function startRun() {
  if (run?.status === 'reading' || run?.status === 'running') return;
  const mine = ++token;
  const startedAt = Date.now();
  run = { status: 'reading', progress: 0, phase: 'reading', note: '' };
  draw();
  let handle = null;
  try {
    const srs = await import('./srs.js');                       // ts-fsrs: the standard weights, their ranges, and the clipping
    const [settings, decks, cards, rows] = await Promise.all([db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAllInPieces('reviewLog')]);
    if (mine !== token) return;
    const hist = buildHistories(rowsFrom(rows, settings.ignoreBefore));       // ("Ignore reviews before" in Advanced scheduling)
    const started = settings.fsrsParams;                        // to notice a sync that changes it while we work
    const current = started?.w || srs.default_w.slice();
    const deckOf = new Map(cards.map(c => [c.id, c.deckId]));
    const steps = hist.cards.map(h => deckSchedulerOptions(settings, effectiveDeck(decks, deckOf.get(h.cardId))).relearningSteps.length);
    const clip = (w, n) => srs.clipParameters(w, n, true);
    if (hist.reviews < MIN_REVIEWS) { setRun({ status: 'result', result: { kind: 'not-enough', reviews: hist.reviews, ignoring: settings.ignoreBefore } }); return; }
    run.counts = { reviews: hist.reviews, cards: hist.cardsUsed };
    paintLive();
    const input = { cards: hist.cards, steps, current, defaults: srs.default_w.slice(), bounds: srs.CLAMP_PARAMETERS(srs.W17_W18_Ceiling, true) };
    let lastKey = '';
    handle = runFit(input, {
      onFallback: () => { if (mine === token && run) { run.note = 'This may make the app slower until it\'s done.'; draw(); } },
      onProgress: p => {
        const key = p.phase + Math.floor(p.progress * 100);
        if (mine !== token || key === lastKey || run?.status !== 'running') return;
        lastKey = key;
        run.phase = p.phase === 'check' ? 'check' : 'finding';
        run.progress = p.progress;
        paintProgress();
      }
    });
    run = { ...run, status: 'running', phase: 'finding', progress: 0, cancel: handle.cancel };
    draw();
    const out = await handle.promise;
    if (mine !== token) return;
    if (out.status === 'cancelled') { setRun({ status: 'result', result: { kind: 'cancelled' } }); return; }
    if (out.status === 'timeout') { setRun({ status: 'result', result: { kind: 'failed', slow: true } }); return; }
    if (out.status === 'error') { console.error(out.message); setRun({ status: 'result', result: { kind: 'failed' } }); return; }
    const res = out.result;
    if (res.status === 'not-enough') { setRun({ status: 'result', result: { kind: 'not-enough', reviews: res.reviews } }); return; }
    // (The new weights were judged on your latest reviews, which the fit never saw, with each deck's weights clipped for its steps.)
    if (res.status === 'same') { setRun({ status: 'result', result: { kind: 'same' } }); return; }
    let { before, after } = res;
    // A sync may have changed the setting while we worked (section 7): score the new current weights against the weights the check used.
    const latest = (await db.getSettings()).fsrsParams;
    // Reset to default pressed while this was running (a reset is saved as { w: null } with a newer time): don't undo it.
    if (latest && latest.w === null && latest.at >= startedAt && JSON.stringify(latest) !== JSON.stringify(started)) {
      setRun({ status: 'result', result: { kind: 'reset' } }); return;
    }
    if (JSON.stringify(latest) !== JSON.stringify(started)) {
      const { test } = splitHistories(hist.cards, HOLDOUT_SHARE);
      const v = judge(test, steps, latest?.w || srs.default_w.slice(), res.headFitted, clip);
      if (v.before.n < HOLDOUT_MIN || !v.better) { setRun({ status: 'result', result: { kind: 'other-device' } }); return; }
      ({ before, after } = v);
    }
    const saved = {
      w: clip(res.w, 0),                                        // plain limits; each deck's own step count is applied again when it schedules
      at: Date.now(), reviews: hist.reviews, cards: hist.cardsUsed,
      logLoss: { before: before.logLoss, after: after.logLoss },
      rmse: { before: before.rmse, after: after.rmse },
      version: FSRS_VERSION
    };
    if (cancelledToken === mine || mine !== token) { setRun({ status: 'result', result: { kind: 'cancelled' } }); return; }     // Cancel pressed during the last checks
    await db.setSetting('fsrsParams', saved);
    setRun({ status: 'result', result: { kind: 'better', saved } });
    onChange();
  } catch (err) {
    console.error(err);
    handle?.cancel();
    if (mine === token) setRun({ status: 'result', result: { kind: 'failed' } });
  }
}

function cancelRun() {
  if (!run) return;
  cancelledToken = token;
  if (run.status === 'running') run.cancel?.();
  else if (run.status === 'reading') { token++; setRun({ status: 'result', result: { kind: 'cancelled' } }); }
}

// ---------- the sheet ----------
const PHASE_TEXT = {
  reading: 'Reading your reviews…',
  finding: 'Finding your settings…',
  check: 'Checking they predict better…'
};
const INTRO = `Fit the scheduler to your own review history so it predicts more accurately when you'll forget. It runs on this device and takes up to a minute. Your cards keep their dates; the new settings apply from each card's next review. Only cards you rate in Review (and Anki history) are used, not game answers.`;

function phaseLine() {
  let t = PHASE_TEXT[run.phase] || PHASE_TEXT.reading;
  if (run.phase === 'reading' && run.counts) t += ` ${word(run.counts.reviews, 'review', 'reviews')} of ${word(run.counts.cards, 'card', 'cards')}`;
  return t;
}
const pct = () => Math.round((run.progress || 0) * 100);

// The line a screen reader follows changes only when the phase changes or the progress passes 25%, 50%, 75%.
function paintLive() {
  const live = $('optLive');
  if (!live || !run) return;
  const quarter = Math.floor(pct() / 25);
  if (live.dataset.phase !== run.phase || (run.phase === 'finding' && live.dataset.quarter !== String(quarter)) || (run.phase === 'reading' && live.textContent !== phaseLine())) {
    live.dataset.phase = run.phase; live.dataset.quarter = String(quarter);
    live.textContent = phaseLine();
  }
}
// What the bar and the percentage show is updated in place (the rest of the sheet is drawn once per state).
function paintProgress() {
  const bar = $('optBar');
  if (!bar || !run) return;
  const p = pct();
  bar.setAttribute('aria-valuenow', String(p));
  bar.firstElementChild.style.width = p + '%';
  $('optPct').textContent = run.phase === 'finding' ? p + '%' : '';
  paintLive();
}

function resultHTML(r) {
  switch (r.kind) {
    case 'better': {
      const s = r.saved;
      return `<p class="opt-result good"><b>Done.</b> Your new settings predict your answers better, so they're now in use.</p>
        <p class="opt-note">Run this again every month or so as you review more.</p>
        <details class="opt-fold"><summary>Details</summary>
          <p class="opt-detail">Checked on your newest 20% of reviews, which the fit did not see: prediction error (log loss) <b class="mono">${s.logLoss.before.toFixed(3)} → ${s.logLoss.after.toFixed(3)}</b> · RMSE <b class="mono">${pctText(s.rmse.before)} → ${pctText(s.rmse.after)}</b></p>
          <p class="opt-note">Used ${word(s.reviews, 'review', 'reviews')} of ${word(s.cards, 'card', 'cards')}. Those error numbers are for that check. The 21 numbers, in the same format as Anki's:</p>
          <code class="opt-w" id="optW">${esc(s.w.map(x => +x.toFixed(4)).join(', '))}</code></details>`;
    }
    case 'same':
      return `<p class="opt-result"><b>Done.</b> Your current settings already predict your answers as well as the new ones, so nothing changed.</p>`;
    case 'reset':
      return `<p class="opt-result">You reset your parameters while this was running, so nothing changed.</p>`;
    case 'other-device':
      return `<p class="opt-result">Your other device already updated your parameters; they predict as well, so nothing changed.</p>`;
    case 'not-enough':
      return `<p class="opt-result">Not enough reviews yet: ${num(r.reviews)} of ${MIN_REVIEWS} count. Game answers and cards whose history is incomplete aren't used.${r.ignoring ? ` Reviews before ${esc(r.ignoring)} are ignored (Advanced scheduling).` : ''}</p>`;
    case 'cancelled':
      return `<p class="opt-result">Stopped. Nothing changed.</p>`;
    default:
      return `<p class="opt-result bad">Couldn't finish on this device. Nothing changed.${r.slow ? ' It took longer than two minutes.' : ''}</p>`;
  }
}

// Draw the run into the sheet. `force` opens the sheet if it is closed (a click on Optimize…); otherwise a closed sheet stays closed.
function draw(force = false) {
  const d = $('sheet');
  if (!run) return;
  const showing = d.open && !!d.querySelector('[data-opt]');
  if (!showing && !force) {
    // A finished run says so with a toast; a running one keeps going quietly.
    if (run.status === 'result') toast({ better: 'Your own settings are now in use.', cancelled: 'Stopped. Nothing changed.', failed: "Couldn't finish on this device. Nothing changed." }[run.result.kind] || 'Optimize finished. Nothing changed.');
    return;
  }
  if (run.status === 'reading' || run.status === 'running') {
    openSheet(`
      <h2 id="sheetTitle">Optimize parameters</h2>
      <div data-opt class="opt-run">
        <div class="opt-bar" id="optBar" role="progressbar" aria-label="Optimizing" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct()}"><i style="width:${pct()}%"></i></div>
        <p class="opt-phase"><span id="optLive" aria-live="polite" data-phase="${run.phase}" data-quarter="${Math.floor(pct() / 25)}">${esc(phaseLine())}</span> <span id="optPct" class="mono" aria-hidden="true">${run.phase === 'finding' ? pct() + '%' : ''}</span></p>
        ${run.note ? `<p class="opt-note" id="optNote">${esc(run.note)}</p>` : ''}
        <p class="opt-note">You can close this; it keeps going.</p>
        <div class="sheet-actions"><button type="button" class="btn ghost" id="optCancel">Cancel</button></div>
      </div>`);
    $('optCancel').addEventListener('click', cancelRun);
  } else {
    const retry = !['better', 'same', 'other-device', 'reset'].includes(run.result.kind);
    openSheet(`
      <h2 id="sheetTitle">Optimize parameters</h2>
      <div data-opt class="opt-run" id="optDone">
        ${resultHTML(run.result)}
        <div class="sheet-actions">
          ${retry ? '<button type="button" class="btn ghost" id="optAgain">Try again</button>' : ''}
          <button type="button" class="btn primary" id="optClose">Close</button>
        </div>
      </div>`);
    $('optClose').addEventListener('click', closeSheet);
    $('optAgain')?.addEventListener('click', () => { run = null; startRun(); });
    $('optClose').focus();
  }
}

function onClose() {
  if (run?.status === 'result') run = null;           // seen: the next opening starts fresh
}

// Opens the sheet. `changed` runs when new settings have been saved (the Settings row redraws).
export function openOptimizeSheet({ changed = () => {} } = {}) {
  onChange = changed;
  const d = $('sheet');
  d.removeEventListener('close', onClose);
  d.addEventListener('close', onClose);
  if (run) { draw(true); return; }
  openSheet(`
    <h2 id="sheetTitle">Optimize parameters</h2>
    <div data-opt class="opt-run">
      <p class="opt-intro">${esc(INTRO)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" id="optClose">Close</button>
        <button type="button" class="btn primary" id="optGo">Optimize</button>
      </div>
    </div>`);
  $('optClose').addEventListener('click', closeSheet);
  $('optGo').addEventListener('click', startRun);
  $('optGo').focus();
}
