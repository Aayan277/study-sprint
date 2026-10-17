// "Help me choose" a target retention. A sheet (Settings → Study → Target retention) and an inline panel (Edit deck → Target
// retention) that show, for each target from 75% to 97%, about how many reviews a day your own cards would need and how much
// you would remember, using your own memory settings. The maths is js/retention-sim.js (run in the optimizer's worker through
// js/worker-job.js); this file reads your cards, draws the chart and sets the target when you pick one.
//
//   openRetentionSheet({ deckId, current, onPick })     a sheet. deckId '' = all decks, else that deck and the decks inside it.
//   mountRetentionHelper(root, { deckId, current, onPick })   the same, inside an element (the deck editor can't open a second sheet)
//     current()  the target now, as a whole percent (Settings: the saved one; the deck editor: the slider)
//     onPick(pct)  called with a whole percent when the person presses "Use N%"

import * as db from './db.js';
import { runJob } from './worker-job.js';
import { ratingProbs, HORIZONS, RETENTION_MIN, RETENTION_MAX, SIM_CAP, efficiency, suggestRetention, suggestFor, SUGGEST_FLOOR } from './retention-sim.js';
import { effectiveDeck, subtreeIds } from './deck-tree.js';
import { examInfo } from './exam.js';
import { deckSchedulerOptions, schedulerOptions } from './sched-settings.js';
import { dayStart } from './days.js';
import { niceMax } from './stats-calc.js';
import { $, esc, openSheet, closeSheet, plural } from './ui.js';

const DAY = 86400000;
const HORIZON_NAMES = { 30: '30 days', 90: '90 days', 365: 'a year' };
const HORIZON_SHORT = { 30: '30 days', 90: '90 days', 365: '1 year' };

// ---------- what to simulate ----------
// Reads the cards in scope and builds the input for simulateAll(). Returns { input, info } or { empty: true }.
//   info: { started, unseen, skipped, groups: [{ exam, names, date }], usingOwnWeights, ownProbs, scope }
export async function gatherInput({ deckId = '', now = Date.now() } = {}) {
  const srs = await import('./srs.js');
  const [settings, decks, cards, states, rows] = await Promise.all([db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getLogsSince(now - 90 * DAY)]);
  const inside = deckId ? subtreeIds(decks, deckId) : null;
  const stateOf = new Map(states.map(s => [s.cardId, s]));
  const opts = deckId ? deckSchedulerOptions(settings, effectiveDeck(decks, deckId)) : schedulerOptions(settings);
  const today = dayStart(now);
  const dayIndex = t => Math.round((dayStart(t) - today) / DAY);
  const groups = [{ exam: null, names: [], date: null }], groupOf = new Map([[null, 0]]);   // group 0 = no exam; then one per exam date inside the horizon
  const groupFor = card => {
    const deck = effectiveDeck(decks, card.deckId);
    const info = examInfo(deck, now);
    const key = info && info.daysLeft >= 1 && info.daysLeft < Math.max(...HORIZONS) ? info.daysLeft : null;
    if (key === null) return 0;
    if (!groupOf.has(key)) { groupOf.set(key, groups.length); groups.push({ exam: key, names: [], date: deck.examDate }); }
    const g = groups[groupOf.get(key)];
    if (!g.names.includes(deck.name)) g.names.push(deck.name);
    return groupOf.get(key);
  };
  const existing = [], unseen = [];
  let skipped = 0;
  for (const c of cards.slice().sort((a, b) => a.created - b.created)) {
    if (c.suspended || (inside && !inside.has(c.deckId))) continue;
    // Overall scope: a deck with its own scheduling settings does not follow the overall target, so it is left out.
    if (!deckId && effectiveDeck(decks, c.deckId).options) { skipped++; continue; }
    const st = stateOf.get(c.id);
    const grp = groupFor(c);
    if (st && st.state !== 0 && st.stability > 0) {
      const lastT = st.lastReview || st.due - (st.scheduledDays || 0) * DAY;
      existing.push({ s: st.stability, d: st.difficulty, last: Math.min(0, dayIndex(lastT)), due: Math.max(0, dayIndex(st.due)), grp });
    } else unseen.push(grp);
  }
  if (!existing.length && !unseen.length) return { empty: true };
  const params = settings.fsrsParams?.w;
  const w = params ? params.slice() : srs.default_w.slice();
  const probs = ratingProbs(rows);
  const deckRow = deckId ? decks.find(d => d.id === deckId) : null;
  const newPerDay = Number.isFinite(deckRow?.newPerDay) ? deckRow.newPerDay : settings.newPerDay;
  return {
    input: {
      w, existing, unseen: Int16Array.from(unseen), groups: groups.map(g => ({ exam: g.exam })),
      newPerDay: Math.max(0, newPerDay || 0), learnSteps: opts.learningSteps.length, relearnSteps: opts.relearningSteps.length,
      maxInterval: opts.maxInterval, reviewProbs: probs.review, firstProbs: probs.first, seed: 1
    },
    info: { started: existing.length, unseen: unseen.length, skipped, groups, usingOwnWeights: !!params, ownProbs: probs.own, scope: deckId ? 'deck' : 'all' }
  };
}

// ---------- the chart ----------
// One line (a single series, so no legend: the heading names it), drawn as inline SVG. Axes are labelled, the grid is faint,
// the markers differ by shape as well as colour (ring = your target now, diamond = suggested, filled dot = the one picked).
// The chart is a slider as far as the keyboard and screen readers are concerned (arrow keys move the pick), and the same
// numbers are in a table under it.
const W = 360, H = 232, M = { l: 44, r: 14, t: 26, b: 44 };

export function chartSVG({ points, value, format, yLabel, id, selected, current, suggested, yMax }) {
  const xs = r => M.l + (r - RETENTION_MIN / 100) / ((RETENTION_MAX - RETENTION_MIN) / 100) * (W - M.l - M.r);
  const top = yMax ?? niceMax(Math.max(...points.map(p => value(p)), 0.0001));
  const ys = v => H - M.b - (Math.min(v, top) / top) * (H - M.t - M.b);
  const ticks = [0, 1, 2, 3, 4].map(i => top * i / 4);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xs(p.retention).toFixed(1)} ${ys(value(p)).toFixed(1)}`).join('');
  const at = r => points.find(p => Math.abs(p.retention - r) < 1e-9);
  const pct = r => Math.round(r * 100);
  const marker = (r, cls, label, dy) => {
    const p = at(r);
    if (!p) return '';
    const x = xs(r), y = ys(value(p));
    return `<g class="rc-mark ${cls}"><line x1="${x}" x2="${x}" y1="${M.t - 6}" y2="${H - M.b}" class="rc-guide"/>` +
      (cls === 'sug' ? `<path d="M${x} ${y - 7}L${x + 7} ${y}L${x} ${y + 7}L${x - 7} ${y}Z" class="rc-diamond"/>` : `<circle cx="${x}" cy="${y}" r="6.5" class="rc-ring"/>`) +
      `<text x="${Math.min(Math.max(x, M.l + 28), W - M.r - 28)}" y="${M.t - 10 + dy}" text-anchor="middle" class="rc-lab">${esc(label)}</text></g>`;
  };
  const sel = at(selected);
  const sx = sel ? xs(sel.retention) : 0, sy = sel ? ys(value(sel)) : 0;
  const same = suggested !== null && Math.abs(current - suggested) < 1e-9;
  const xTicks = [75, 80, 85, 90, 95];
  return `<svg class="rc-svg" viewBox="0 0 ${W} ${H}" id="${id}" role="slider" tabindex="0" aria-valuemin="${RETENTION_MIN}" aria-valuemax="${RETENTION_MAX}" aria-valuenow="${pct(selected)}" aria-valuetext="${esc(sel ? `${pct(selected)}% target: ${format(value(sel))}` : '')}" aria-label="${esc(yLabel)} for each target retention. Use the left and right arrow keys, or tap the chart, to pick a target.">
    ${ticks.map(t => `<line x1="${M.l}" x2="${W - M.r}" y1="${ys(t)}" y2="${ys(t)}" class="rc-grid"/><text x="${M.l - 6}" y="${ys(t) + 4}" text-anchor="end" class="rc-tick">${esc(format(t, true))}</text>`).join('')}
    ${xTicks.map(t => `<text x="${xs(t / 100)}" y="${H - M.b + 16}" text-anchor="middle" class="rc-tick">${t}%</text>`).join('')}
    <line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}" class="rc-axis"/>
    <text x="${(M.l + W - M.r) / 2}" y="${H - 6}" text-anchor="middle" class="rc-axis-title">Target retention</text>
    <text x="12" y="${(M.t + H - M.b) / 2}" text-anchor="middle" transform="rotate(-90 12 ${(M.t + H - M.b) / 2})" class="rc-axis-title">${esc(yLabel)}</text>
    <path d="${line}" class="rc-line" fill="none"/>
    ${points.map(p => `<circle cx="${xs(p.retention)}" cy="${ys(value(p))}" r="2.2" class="rc-dot"/>`).join('')}
    ${marker(current, 'now', same ? `Now = suggested ${pct(current)}%` : `Now ${pct(current)}%`, 0)}
    ${suggested !== null && !same ? marker(suggested, 'sug', `Suggested ${pct(suggested)}%`, 0) : same ? '' : ''}
    ${sel ? `<line x1="${sx}" x2="${sx}" y1="${M.t}" y2="${H - M.b}" class="rc-pick-line"/><circle cx="${sx}" cy="${sy}" r="5" class="rc-pick"/>` : ''}
  </svg>`;
}

const fmtReviews = (v, tick) => (tick ? String(Math.round(v)) : `${v < 10 ? v.toFixed(1) : Math.round(v)} reviews a day`);
const fmtPct = (v, tick) => `${Math.round(v * 100)}${tick ? '%' : '% ready'}`;

// ---------- the sheet content ----------
const INTRO = 'This estimates how many reviews a day each target would give you, and how much you would remember, by replaying your own cards forward with your memory settings. It is an estimate, not a promise: real days vary, and it assumes you do every review that is due.';

function describeSuggestion(horizon, exam) {
  return exam
    ? `Suggested: the lowest-workload target that keeps you within 2 points of the best readiness on exam day (never below ${Math.round(SUGGEST_FLOOR * 100)}%).`
    : `Suggested: the lowest-workload target whose cards remembered per review is within 2% of the best, over ${HORIZON_NAMES[horizon]} (never below ${Math.round(SUGGEST_FLOOR * 100)}%).`;
}

export function mountRetentionHelper(root, { deckId = '', current, onPick }) {
  let handle = null, closed = false;
  let horizon = 90, selected = null, run = null, examIx = 0;
  const uid = `rc${Math.random().toString(36).slice(2, 7)}`;

  const stop = () => { closed = true; handle?.cancel(); };

  const showError = msg => { root.innerHTML = `<div class="rc"><p class="opt-result bad">${esc(msg)}</p><div class="rc-actions"><button type="button" class="btn ghost small" data-rc="retry">Try again</button></div></div>`; root.querySelector('[data-rc=retry]').addEventListener('click', start); };

  async function start() {
    closed = false;
    root.innerHTML = `<div class="rc"><p class="opt-intro">${esc(INTRO)}</p>
      <div class="opt-bar" role="progressbar" aria-label="Working it out" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-rc="bar"><i style="width:0"></i></div>
      <p class="opt-phase" aria-live="polite" data-rc="phase">Reading your cards…</p>
      <div class="rc-actions"><button type="button" class="btn ghost small" data-rc="cancel">Cancel</button></div></div>`;
    const bar = root.querySelector('[data-rc=bar]'), phase = root.querySelector('[data-rc=phase]');
    root.querySelector('[data-rc=cancel]').addEventListener('click', () => { handle?.cancel(); });
    let data;
    try { data = await gatherInput({ deckId }); } catch (err) { console.error(err); showError("Couldn't read your cards."); return; }
    if (closed) return;
    if (data.empty) { root.innerHTML = '<div class="rc"><p class="opt-result">There are no cards to look at yet. Add some cards and come back.</p></div>'; return; }
    phase.textContent = 'Trying each target…';
    handle = runJob('sim', data.input, {
      timeoutMs: 20000,
      onProgress: p => {
        const v = Math.round((p.progress || 0) * 100);
        bar.setAttribute('aria-valuenow', String(v));
        bar.firstElementChild.style.width = v + '%';
        phase.textContent = `Trying each target… ${v}%`;
      }
    });
    const out = await handle.promise;
    if (closed) return;
    if (out.status === 'cancelled') { root.innerHTML = '<div class="rc"><p class="opt-result">Stopped.</p><div class="rc-actions"><button type="button" class="btn ghost small" data-rc="retry">Run again</button></div></div>'; root.querySelector('[data-rc=retry]').addEventListener('click', start); return; }
    if (out.status !== 'done') { showError(out.status === 'timeout' ? 'That took too long on this device.' : "Couldn't work it out on this device."); return; }
    run = { result: out.result, info: data.info };
    examIx = 0;
    selected = Math.round(current()) / 100;
    draw();
  }

  function examGroups() { return run.info.groups.map((g, i) => ({ ...g, i })).filter(g => g.exam !== null && run.result.points.some(p => p.exams.some(e => e.grp === g.i))); }

  function draw() {
    const { result, info } = run;
    const pts = result.points;
    const nowR = Math.round(current()) / 100;
    const exams = examGroups();
    const ex = exams[Math.min(examIx, exams.length - 1)];
    const sugg = suggestFor(pts, horizon, ex ? ex.i : null);
    if (!pts.some(p => Math.abs(p.retention - selected) < 1e-9)) selected = pts[pts.length - 1].retention;
    const sel = pts.find(p => Math.abs(p.retention - selected) < 1e-9);
    const h = sel.horizons[horizon];
    const cur = pts.find(p => Math.abs(p.retention - nowR) < 1e-9);
    const workload = p => p.horizons[horizon].reviewsPerDay;
    const recall = p => p.horizons[horizon].recall;
    const exSel = ex ? sel.exams.find(e => e.grp === ex.i) : null;
    const diff = cur && cur !== sel ? workload(sel) - workload(cur) : null;
    const rowHTML = p => `<tr${p === sel ? ' class="sel"' : ''}><th scope="row">${Math.round(p.retention * 100)}%</th><td>${Math.round(workload(p))}</td><td>${Math.round(recall(p) * 100)}%</td>${ex ? `<td>${Math.round((p.exams.find(e => e.grp === ex.i)?.share ?? 0) * 100)}%</td>` : ''}</tr>`;
    root.innerHTML = `<div class="rc">
      <p class="opt-intro">${esc(INTRO)}</p>
      <div class="chips rc-h" role="radiogroup" aria-label="Look ahead">
        ${HORIZONS.map(d => `<label class="chip"><input type="radio" name="${uid}h" value="${d}" ${d === horizon ? 'checked' : ''}><span>${HORIZON_SHORT[d]}</span></label>`).join('')}
      </div>
      <figure class="rc-fig">
        <figcaption class="rc-cap">Average reviews a day over the next ${HORIZON_NAMES[horizon]}</figcaption>
        ${chartSVG({ points: pts, value: workload, format: fmtReviews, yLabel: 'Reviews a day', id: `${uid}c1`, selected, current: nowR, suggested: sugg })}
      </figure>
      <div class="rc-detail" aria-live="polite">
        <p><b class="mono">${Math.round(selected * 100)}%</b> target: about <b class="mono">${h.reviewsPerDay < 10 ? h.reviewsPerDay.toFixed(1) : Math.round(h.reviewsPerDay)}</b> reviews a day. By the end of ${HORIZON_NAMES[horizon]} you would remember about <b class="mono">${Math.round(h.recall * 100)}%</b> of the cards you have started.${diff !== null && Math.abs(diff) >= 0.5 ? ` That is ${Math.abs(Math.round(diff))} ${diff > 0 ? 'more' : 'fewer'} a day than your ${Math.round(nowR * 100)}% now.` : ''}</p>
        ${exSel ? `<p>On exam day (${esc(ex.date)}), about <b class="mono">${Math.round(exSel.share * 100)}%</b> of the cards in ${esc(ex.names.slice(0, 2).join(', ') + (ex.names.length > 2 ? ` and ${ex.names.length - 2} more` : ''))} would be ready (90% or better).</p>` : ''}
      </div>
      ${exams.length ? `<figure class="rc-fig">
        ${exams.length > 1 ? `<label class="rc-exam-pick">Exam <select class="select" data-rc="exam">${exams.map((g, k) => `<option value="${k}" ${k === examIx ? 'selected' : ''}>${esc(g.names[0])} · ${esc(g.date)}</option>`).join('')}</select></label>` : ''}
        <figcaption class="rc-cap">Ready on exam day (${esc(ex.date)}): cards you would remember at 90% or better</figcaption>
        ${chartSVG({ points: pts, value: p => p.exams.find(e => e.grp === ex.i)?.share ?? 0, format: fmtPct, yLabel: 'Ready on exam day', id: `${uid}c2`, selected, current: nowR, suggested: sugg, yMax: 1 })}
        <p class="rc-note">The exam’s own rules are included: reviews are kept before exam day, the target rises over the last two weeks, and a last pass covers the weakest cards. That is why most targets end up close.</p>
      </figure>` : ''}
      <p class="rc-note">${esc(describeSuggestion(horizon, !!ex))}${sugg === SUGGEST_FLOOR && !ex ? ' Lower targets need fewer reviews, so with typical settings the answer sits at that limit; weigh it against how much you want to remember.' : ''}</p>
      <details class="opt-fold"><summary>See the numbers</summary>
        <div class="rc-table-wrap"><table class="rc-table"><caption class="sr-only">Estimate for each target over ${HORIZON_NAMES[horizon]}</caption>
          <thead><tr><th scope="col">Target</th><th scope="col">Reviews a day</th><th scope="col">Remembered at the end</th>${ex ? '<th scope="col">Ready on exam day</th>' : ''}</tr></thead>
          <tbody>${pts.map(rowHTML).join('')}</tbody></table></div>
      </details>
      <p class="rc-note">Based on ${plural(info.started, 'started card')}${info.unseen ? ` and ${plural(info.unseen, 'card')} not started yet (introduced at your new-cards limit)` : ''}, with ${info.usingOwnWeights ? 'your own FSRS settings' : 'the standard FSRS settings'}${info.ownProbs.review ? ' and your own Hard/Good/Easy habits' : ''}.${result.sampled ? ` Your collection is large, so a sample of about ${SIM_CAP.toLocaleString('en')} cards was replayed and scaled up.` : ''}${result.complete ? '' : ` Stopped early at ${Math.round(result.stoppedAt * 100)}% to keep this quick.`}${info.skipped ? ` ${plural(info.skipped, 'card')} in decks with their own settings ${info.skipped === 1 ? 'is' : 'are'} not included.` : ''} Not modelled: learning steps in detail, spreading due dates, daily limits.</p>
      <div class="rc-actions">
        <button type="button" class="btn primary small" data-rc="use" ${Math.abs(selected - nowR) < 1e-9 ? 'disabled' : ''}>${Math.abs(selected - nowR) < 1e-9 ? `${Math.round(selected * 100)}% is your target` : `Use ${Math.round(selected * 100)}%`}</button>
        ${sugg !== null && Math.abs(sugg - selected) > 1e-9 ? `<button type="button" class="btn ghost small" data-rc="pickSug">Pick the suggested ${Math.round(sugg * 100)}%</button>` : ''}
      </div></div>`;
    wire(pts);
  }

  function wire(pts) {
    root.querySelectorAll(`input[name="${uid}h"]`).forEach(i => i.addEventListener('change', () => { horizon = +i.value; draw(); root.querySelector('.rc-h input:checked')?.focus(); }));
    root.querySelector('[data-rc=exam]')?.addEventListener('change', e => { examIx = +e.target.value; draw(); });
    root.querySelector('[data-rc=use]').addEventListener('click', () => { onPick(Math.round(selected * 100)); draw(); });
    root.querySelector('[data-rc=pickSug]')?.addEventListener('click', () => { selected = suggestFor(pts, horizon, examGroups()[examIx]?.i ?? null); draw(); });
    root.querySelectorAll('svg.rc-svg').forEach(svg => {
      const pick = ev => {
        const box = svg.getBoundingClientRect();
        const x = (ev.clientX - box.left) / box.width * W;
        const r = Math.round(((x - M.l) / (W - M.l - M.r)) * (RETENTION_MAX - RETENTION_MIN) + RETENTION_MIN);
        selected = Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, r)) / 100;
        const keep = svg.id;
        draw();
        $(keep)?.focus({ preventScroll: true });
      };
      svg.addEventListener('click', pick);
      svg.addEventListener('keydown', ev => {
        const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, Home: -99, End: 99 }[ev.key];
        if (!step) return;
        ev.preventDefault();
        selected = Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, Math.round(selected * 100) + step)) / 100;
        const keep = svg.id;
        draw();
        $(keep)?.focus({ preventScroll: true });
      });
    });
  }

  start();
  return { stop };
}

// The sheet version.
export function openRetentionSheet({ deckId = '', current, onPick }) {
  openSheet(`
    <h2 id="sheetTitle">Help me choose</h2>
    <div data-rc-root id="rcRoot"></div>
    <div class="sheet-actions"><button type="button" class="btn ghost" id="rcClose">Close</button></div>`);
  const root = $('rcRoot');
  const helper = mountRetentionHelper(root, { deckId, current, onPick: pct => { onPick(pct); } });
  const d = $('sheet');
  d.addEventListener('close', () => helper.stop(), { once: true });
  $('rcClose').addEventListener('click', closeSheet);
}
