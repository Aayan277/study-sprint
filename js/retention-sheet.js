// "Help me choose" a target retention. A sheet (Settings → Study → Target retention) and an inline panel (Edit deck → Target
// retention) that show, for each target from 75% to 97%, about how many reviews a day your own cards would need and how much
// you would remember, using your own memory settings. The maths is js/retention-sim.js (run in the optimizer's worker through
// js/worker-job.js); this file reads your cards, draws the chart and sets the target when you pick one.
//
//   openRetentionSheet({ deckId, current, onPick })     a sheet. deckId '' = all decks, else that deck and the decks inside it.
//   mountRetentionHelper(root, { deckId, current, onPick })   the same, inside an element (the deck editor can't open a second sheet)
//     current()  the target now, as a whole percent (Settings: the saved one; the deck editor: the slider)
//     onPick(pct)  called with a whole percent when the person presses "Use N%"
//   Both return/offer stop(): cancels the work (the sheet does it when it closes; the deck editor when it closes).

import * as db from './db.js';
import { runJob } from './worker-job.js';
import { ratingProbs, HORIZONS, RETENTION_MIN, RETENTION_MAX, SIM_CAP, suggestion, marginalCost, pickSelected, KNEE_MIN, EXAM_TOLERANCE, EXAM_LOAD_TOLERANCE } from './retention-sim.js';
import { TRAIN_SOURCES } from './fsrs-data.js';
import { effectiveDeck, subtreeIds } from './deck-tree.js';
import { examInfo, FINAL_DAYS } from './exam.js';
import { deckSchedulerOptions, schedulerOptions } from './sched-settings.js';
import { dayStart } from './days.js';
import { niceMax } from './stats-calc.js';
import { $, esc, openSheet, closeSheet, plural } from './ui.js';

const DAY = 86400000;
const HORIZON_NAMES = { 30: '30 days', 90: '90 days', 365: 'a year' };
const HORIZON_SHORT = { 30: '30 days', 90: '90 days', 365: '1 year' };
// A number is only suggested once there is something to base it on: this many started cards and this many reviews in the last 90 days.
export const MIN_STARTED = 20, MIN_REVIEWS = 50;
export const enoughData = info => (info?.started || 0) >= MIN_STARTED && (info?.reviews || 0) >= MIN_REVIEWS;

// ---------- what to simulate ----------
// Reads the cards in scope and builds the input for simulateAll(). Returns { input, info } or { empty: true }.
//   info: { started, unseen, skipped, groups: [{ exam, names, date }], usingOwnWeights, ownProbs, reviewLimit }
export async function gatherInput({ deckId = '', now = Date.now(), current = null } = {}) {
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
  // The weights as the scheduler will use them (clipped for the number of relearning steps), like everywhere else the weights are used.
  const w = srs.clipParameters(params ? params.slice() : srs.default_w.slice(), opts.relearningSteps.length, true);
  const probs = ratingProbs(rows);
  // "Reviews in the last 90 days" counts only answers that would train it: not Play answers, and only the cards in scope (the chosen
  // deck and the decks inside it; for all decks, not those with their own settings, which are left out above).
  const inScope = new Map(cards.map(c => [c.id, inside ? inside.has(c.deckId) : !effectiveDeck(decks, c.deckId).options]));
  const usable = rows.filter(l => TRAIN_SOURCES.includes(l.source) && l.rating >= 1 && l.rating <= 4 && inScope.get(l.cardId)).length;
  const deckRow = deckId ? decks.find(d => d.id === deckId) : null;
  const newPerDay = Number.isFinite(deckRow?.newPerDay) ? deckRow.newPerDay : settings.newPerDay;
  return {
    input: {
      w, existing, unseen: Int16Array.from(unseen), groups: groups.map(g => ({ exam: g.exam })),
      newPerDay: Math.max(0, newPerDay || 0), learnSteps: opts.learningSteps.length, relearnSteps: opts.relearningSteps.length,
      maxInterval: opts.maxInterval, reviewProbs: probs.review, firstProbs: probs.first, seed: 1,
      current: Number.isFinite(current) ? current / 100 : undefined          // worked out first, so it is always there
    },
    info: {
      started: existing.length, reviews: usable, unseen: unseen.length, skipped, groups, usingOwnWeights: !!params, ownProbs: probs.own,
      reviewLimit: Number.isFinite(settings.reviewLimit) && settings.reviewLimit > 0 ? settings.reviewLimit : null
    }
  };
}

// ---------- the chart ----------
// One line (a single series, so no legend: the caption names it), drawn as inline SVG. Axes are labelled, the grid is faint, the
// markers differ by shape as well as by place (ring = your target now, diamond = suggested, filled dot = the one picked).
// The chart is a slider as far as the keyboard and screen readers are concerned (arrow keys move the pick), and the same numbers
// are in a table under it. Picking moves the pick marker and the aria text in place (movePick), the chart is not drawn again.
const W = 360, H = 250, M = { l: 48, r: 14, t: 44, b: 48 };
const pct = r => Math.round(r * 100);

// The vertical axis runs from yMin (0 unless given) to yMax (a round number above the largest value unless given).
export function chartGeom(points, value, yMax, yMin = 0) {
  const top = yMax ?? niceMax(Math.max(...points.map(p => value(p)), 0.0001));
  const xs = r => M.l + (r - RETENTION_MIN / 100) / ((RETENTION_MAX - RETENTION_MIN) / 100) * (W - M.l - M.r);
  const ys = v => H - M.b - ((Math.min(Math.max(v, yMin), top) - yMin) / (top - yMin)) * (H - M.t - M.b);
  return { top, xs, ys };
}

export function chartSVG({ points, value, format, yLabel, id, selected, current, suggested, yMax, yMin = 0 }) {
  const { top, xs, ys } = chartGeom(points, value, yMax, yMin);
  const ticks = [0, 1, 2, 3, 4].map(i => yMin + (top - yMin) * i / 4);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xs(p.retention).toFixed(1)} ${ys(value(p)).toFixed(1)}`).join('');
  const at = r => (r === null || r === undefined ? undefined : points.find(p => Math.abs(p.retention - r) < 1e-9));
  const mid = (M.l + W - M.r) / 2;
  // the labels sit on two rows above the plot, so "Now" and "Suggested" never run into each other
  const marker = (r, cls, label, row) => {
    const p = at(r);
    if (!p) return '';
    const x = xs(r), y = ys(value(p));
    return `<g class="rc-mark ${cls}"><line x1="${x}" x2="${x}" y1="${M.t - 8}" y2="${H - M.b}" class="rc-guide"/>` +
      (cls === 'sug' ? `<path d="M${x} ${y - 7}L${x + 7} ${y}L${x} ${y + 7}L${x - 7} ${y}Z" class="rc-diamond"/>` : `<circle cx="${x}" cy="${y}" r="6.5" class="rc-ring"/>`) +
      `<text x="${Math.min(Math.max(x, M.l + 40), W - M.r - 40)}" y="${M.t - 26 + row * 15}" text-anchor="middle" class="rc-lab">${esc(label)}</text></g>`;
  };
  const sel = at(selected);
  const same = suggested !== null && suggested !== undefined && Math.abs(current - suggested) < 1e-9;
  const xTicks = [75, 80, 85, 90, 95];
  return `<svg class="rc-svg" viewBox="0 0 ${W} ${H}" id="${id}" role="slider" tabindex="0" aria-valuemin="${RETENTION_MIN}" aria-valuemax="${RETENTION_MAX}" aria-valuenow="${pct(selected)}" aria-valuetext="${esc(sel ? `${pct(selected)}% target: ${format(value(sel))}` : '')}" aria-label="${esc(yLabel)} for each target retention. Use the left and right arrow keys, or tap the chart, to pick a target.">
    ${ticks.map(t => `<line x1="${M.l}" x2="${W - M.r}" y1="${ys(t)}" y2="${ys(t)}" class="rc-grid"/><text x="${M.l - 6}" y="${ys(t) + 4}" text-anchor="end" class="rc-tick">${esc(format(t, true))}</text>`).join('')}
    ${xTicks.map(t => `<text x="${xs(t / 100)}" y="${H - M.b + 17}" text-anchor="middle" class="rc-tick">${t}%</text>`).join('')}
    <line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}" class="rc-axis"/>
    <text x="${mid}" y="${H - 6}" text-anchor="middle" class="rc-axis-title">Target retention</text>
    <text x="13" y="${(M.t + H - M.b) / 2}" text-anchor="middle" transform="rotate(-90 13 ${(M.t + H - M.b) / 2})" class="rc-axis-title">${esc(yLabel)}</text>
    <path d="${line}" class="rc-line" fill="none"/>
    ${points.map(p => `<circle cx="${xs(p.retention)}" cy="${ys(value(p))}" r="2.2" class="rc-dot"/>`).join('')}
    ${marker(current, 'now', same ? `Now = suggested ${pct(current)}%` : `Now ${pct(current)}%`, 0)}
    ${suggested !== null && suggested !== undefined && !same ? marker(suggested, 'sug', `Suggested ${pct(suggested)}%`, 1) : ''}
    <line class="rc-pick-line" x1="${sel ? xs(sel.retention) : 0}" x2="${sel ? xs(sel.retention) : 0}" y1="${M.t - 8}" y2="${H - M.b}"/><circle class="rc-pick" cx="${sel ? xs(sel.retention) : 0}" cy="${sel ? ys(value(sel)) : 0}" r="5"/>
  </svg>`;
}

// Move the pick marker and the aria text of an already drawn chart.
export function movePick(svg, { points, value, format, yMax, yMin }, selected) {
  const sel = points.find(p => Math.abs(p.retention - selected) < 1e-9);
  if (!sel) return;
  const { xs, ys } = chartGeom(points, value, yMax, yMin);
  const line = svg.querySelector('.rc-pick-line'), dot = svg.querySelector('.rc-pick');
  line.setAttribute('x1', xs(selected)); line.setAttribute('x2', xs(selected));
  dot.setAttribute('cx', xs(selected)); dot.setAttribute('cy', ys(value(sel)));
  svg.setAttribute('aria-valuenow', String(pct(selected)));
  svg.setAttribute('aria-valuetext', `${pct(selected)}% target: ${format(value(sel))}`);
}

// (The axis labels keep decimals when the numbers are small, so a short axis reads 0, 0.8, 1.5, 2.3, 3 and not 0, 1, 1, 2, 3.)
export const fmtReviews = (v, tick) => (tick ? (v >= 10 ? String(Math.round(v)) : String(+v.toFixed(2))) : `${v < 10 ? v.toFixed(1) : Math.round(v)} reviews a day`);
const fmtRecall = (v, tick) => `${Math.round(v * 100)}${tick ? '%' : '% expected recall'}`;
const num1 = v => (v < 10 ? v.toFixed(1) : String(Math.round(v)));

// ---------- the sheet content ----------
const INTRO = 'This estimates how many reviews a day each target would give you, and how much you would remember, by replaying your own cards forward with your memory settings. It is an estimate, not a promise: real days vary, and it assumes you do every review that is due.';

// The wording of the suggestion, from suggestion()'s result. Every sentence says what it is based on.
export const NOT_ENOUGH = 'Not enough reviews yet to suggest a number.';
export function suggestionText(s, { current, reviewLimit }) {
  const lines = [];
  const knee = s.knee !== null ? `${pct(s.knee)}%` : '';
  if (s.kind === 'none' && reviewLimit && !s.limitFits && s.curve) {
    lines.push(`Even ${pct(KNEE_MIN)}% needs about ${num1(s.curve.values[0])} reviews a day, more than your limit of ${reviewLimit}. With a limit that low, some reviews will wait.`);
  } else if (s.target !== null) {
    if (s.kind === 'limit') {
      lines.push(`Suggested: ${pct(s.target)}%, the highest target whose reviews fit your limit of ${reviewLimit} a day.${s.examTarget !== null && s.examTarget > s.target ? ` For the exam alone ${pct(s.examTarget)}% would be better.` : ''}`);
    } else if (s.kind === 'exam') {
      lines.push(`Suggested: ${pct(s.target)}%, the lowest target that keeps your expected recall on exam day within ${Math.round(EXAM_TOLERANCE * 100)} points of the best before the final pass, with a final pass within ${Math.round(EXAM_LOAD_TOLERANCE * 100)}% of the lightest.`);
    } else lines.push(`Suggested: ${pct(s.target)}%, where the workload curve bends.`);
    if (s.exam) lines.push(`At ${pct(s.target)}%: about ${Math.round(s.exam.preRecall * 100)}% expected recall on exam day before the final pass; last ${FINAL_DAYS} days: about ${Math.round(s.exam.passLoad)} reviews a day.`);
  }
  if (knee && s.kind !== 'none') lines.push(`Above about ${knee}, each extra point costs many more reviews.`);
  const m = s.curve ? marginalCost(s.curve, current) : null;
  if (m) lines.push(`At your ${pct(current)}% now, +1 point costs about ${num1(m.perDay)} more reviews a day (+${Math.round(m.pct * 100)}%).`);
  return lines;
}

export function mountRetentionHelper(root, { deckId = '', current, onPick }) {
  let handle = null, closed = false;
  let horizon = 90, selected = null, run = null, examIx = 0, drawn = [];
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
    try { data = await gatherInput({ deckId, current: current() }); } catch (err) { console.error(err); showError("Couldn't read your cards."); return; }
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
    selected = pickSelected(out.result.points, current() / 100);          // always starts on your own target
    draw();
  }

  const examGroups = () => run.info.groups.map((g, i) => ({ ...g, i })).filter(g => g.exam !== null && run.result.points.some(p => p.exams.some(e => e.grp === g.i)));
  const nowR = () => current() / 100;
  const examOf = p => { const ex = examGroups()[examIx]; return ex ? p.exams.find(e => e.grp === ex.i) : null; };

  // The parts that depend on which target is picked: the readout, the button and the table row.
  function readoutHTML() {
    const { info } = run;
    const sel = run.result.points.find(p => Math.abs(p.retention - selected) < 1e-9);
    const h = sel.horizons[horizon];
    const cur = run.result.points.find(p => Math.abs(p.retention - nowR()) < 1e-9);
    const diff = cur && cur !== sel ? h.reviewsPerDay - cur.horizons[horizon].reviewsPerDay : null;
    const ex = examGroups()[examIx], e = examOf(sel);
    const over = info.reviewLimit && h.reviewsPerDay > info.reviewLimit;
    return `<p><b class="mono">${pct(selected)}%</b> target: about <b class="mono">${num1(h.reviewsPerDay)}</b> reviews a day. By the end of ${HORIZON_NAMES[horizon]} you would remember about <b class="mono">${Math.round(h.recall * 100)}%</b> of the cards you have started.${diff !== null && Math.abs(diff) >= 0.5 ? ` That is ${Math.abs(Math.round(diff))} ${diff > 0 ? 'more' : 'fewer'} a day than your ${pct(nowR())}% now.` : ''}</p>
      ${over ? `<p>That is more than your limit of ${info.reviewLimit} reviews a day, so some reviews would wait for the next day.</p>` : ''}
      ${e ? `<p>Exam day (${esc(ex.date)}), ${esc(ex.names.slice(0, 2).join(', ') + (ex.names.length > 2 ? ` and ${ex.names.length - 2} more` : ''))}: if you stopped reviewing ${FINAL_DAYS} days before, you would remember about <b class="mono">${Math.round(e.preRecall * 100)}%</b> of these cards on average, and <b class="mono">${Math.round(e.preShare * 100)}%</b> would be ready (90% or better). The exam’s final pass then makes the last ${FINAL_DAYS} days busy: about <b class="mono">${Math.round(e.passLoad)}</b> reviews a day. After it, about <b class="mono">${Math.round(e.share * 100)}%</b> are ready.</p>` : ''}`;
  }
  const useLabel = () => (Math.abs(selected - nowR()) < 1e-9 ? `${pct(selected)}% is your target` : `Use ${pct(selected)}%`);

  function draw() {
    const { result, info } = run;
    const pts = result.points;
    const exams = examGroups();
    const ex = exams[Math.min(examIx, exams.length - 1)];
    const enough = enoughData(info);
    // Too little to go on: no suggested number (and none of the sentences that lean on one); the chart still shows the estimates.
    const s = enough ? suggestion(pts, horizon, { reviewLimit: info.reviewLimit, examGroup: ex ? ex.i : null }) : { target: null, kind: 'none', knee: null, curve: null };
    run.suggested = s;
    const lines = enough ? suggestionText(s, { current: nowR(), reviewLimit: info.reviewLimit })
      : [`${NOT_ENOUGH} Come back after you have studied more: this needs at least ${MIN_STARTED} started cards and ${MIN_REVIEWS} reviews in the last 90 days (you have ${info.started} and ${info.reviews}).`];
    const workload = p => p.horizons[horizon].reviewsPerDay;
    const preRecall = p => (p.exams.find(e => e.grp === ex.i)?.preRecall ?? 0);
    drawn = [{ id: `${uid}c1`, points: pts, value: workload, format: fmtReviews, yLabel: 'Reviews a day' }];
    if (ex) {
      // (the axis starts below the lowest value, not at 0, with a span that gives whole-percent ticks: 8, 12, 16, 20, 40, 60, 80 or 100 points)
      const lowest = Math.min(...pts.map(preRecall));
      const span = [0.08, 0.12, 0.16, 0.2, 0.4, 0.6, 0.8, 1].find(x => x >= 1 - lowest + 0.02) ?? 1;
      drawn.push({ id: `${uid}c2`, points: pts, value: preRecall, format: fmtRecall, yLabel: 'Recall before pass', yMax: 1, yMin: Math.round((1 - span) * 100) / 100 });
    }
    const chart = d => chartSVG({ ...d, selected, current: nowR(), suggested: s.target });
    const rowHTML = p => {
      const e = ex ? p.exams.find(x => x.grp === ex.i) : null;
      return `<tr data-r="${p.retention}"${Math.abs(p.retention - selected) < 1e-9 ? ' class="sel"' : ''}><th scope="row">${pct(p.retention)}%</th><td>${Math.round(workload(p))}</td><td>${Math.round(p.horizons[horizon].recall * 100)}%</td>${e ? `<td>${Math.round(e.preRecall * 100)}%</td><td>${Math.round(e.preShare * 100)}%</td><td>${Math.round(e.passLoad)}</td><td>${Math.round(e.share * 100)}%</td>` : ''}</tr>`;
    };
    root.innerHTML = `<div class="rc">
      <p class="opt-intro">${esc(INTRO)}</p>
      <div class="chips rc-h" role="radiogroup" aria-label="Look ahead">
        ${HORIZONS.map(d => `<label class="chip"><input type="radio" name="${uid}h" value="${d}" ${d === horizon ? 'checked' : ''}><span>${HORIZON_SHORT[d]}</span></label>`).join('')}
      </div>
      <figure class="rc-fig">
        <figcaption class="rc-cap">Average reviews a day over the next ${HORIZON_NAMES[horizon]}</figcaption>
        ${chart(drawn[0])}
      </figure>
      <div class="rc-detail" data-rc="detail" aria-live="polite">${readoutHTML()}</div>
      ${ex ? `<figure class="rc-fig">
        ${exams.length > 1 ? `<label class="rc-exam-pick">Exam <select class="select" data-rc="exam">${exams.map((g, k) => `<option value="${k}" ${k === examIx ? 'selected' : ''}>${esc(g.names[0])} · ${esc(g.date)}</option>`).join('')}</select></label>` : ''}
        <figcaption class="rc-cap">Recall on exam day (${esc(ex.date)}), before the final pass: the average chance of remembering a card if you stopped reviewing ${FINAL_DAYS} days before</figcaption>
        ${chart(drawn[1])}
        <p class="rc-note">The exam’s own rules are included: the target rises over the last two weeks, and cards you would remember at under 99% on exam day get one more review in the last ${FINAL_DAYS} days, spread over those days. That final pass lifts every target to about the same readiness, so the chart shows recall before it, and the numbers show how busy the last ${FINAL_DAYS} days get.</p>
      </figure>` : ''}
      <div class="rc-sugg">${lines.map(l => `<p class="rc-note">${esc(l)}</p>`).join('')}</div>
      <details class="opt-fold"><summary>See the numbers</summary>
        <div class="rc-table-wrap"><table class="rc-table"><caption class="sr-only">Estimate for each target over ${HORIZON_NAMES[horizon]}</caption>
          <thead><tr><th scope="col">Target</th><th scope="col">Reviews a day</th><th scope="col">Remembered at the end</th>${ex ? `<th scope="col">Recall before last pass</th><th scope="col">Ready (90%+) before last pass</th><th scope="col">Last ${FINAL_DAYS} days, reviews a day</th><th scope="col">Ready on exam day</th>` : ''}</tr></thead>
          <tbody>${pts.map(rowHTML).join('')}</tbody></table></div>
      </details>
      <p class="rc-note">Based on ${plural(info.started, 'started card')}${info.unseen ? ` and ${plural(info.unseen, 'card')} not started yet (introduced at your new-cards limit)` : ''}, with ${info.usingOwnWeights ? 'your own FSRS settings' : 'the standard FSRS settings'}${info.ownProbs.review ? ' and your own Hard/Good/Easy habits' : ''}.${result.sampled ? ` Your collection is large, so a sample of about ${SIM_CAP.toLocaleString('en')} cards was replayed and scaled up.` : ''}${result.complete ? '' : ` To keep this quick, ${plural(result.missing, 'target')} between the ones shown ${result.missing === 1 ? 'was' : 'were'} skipped.`}${info.skipped ? ` ${plural(info.skipped, 'card')} in decks with their own settings ${info.skipped === 1 ? 'is' : 'are'} not included.` : ''} Not modelled: learning steps in detail, spreading due dates, daily limits.</p>
      <div class="rc-actions" data-rc="actions">
        <button type="button" class="btn primary small" data-rc="use" ${Math.abs(selected - nowR()) < 1e-9 ? 'disabled' : ''}>${useLabel()}</button>
        ${s.target !== null && Math.abs(s.target - selected) > 1e-9 ? `<button type="button" class="btn ghost small" data-rc="pickSug">Pick the suggested ${pct(s.target)}%</button>` : ''}
      </div></div>`;
    wire();
  }

  // The picked target changed: move the markers, the readout, the button and the table row; nothing is drawn again.
  function update() {
    root.querySelectorAll('svg.rc-svg').forEach(svg => { const d = drawn.find(x => x.id === svg.id); if (d) movePick(svg, d, selected); });
    root.querySelector('[data-rc=detail]').innerHTML = readoutHTML();
    const use = root.querySelector('[data-rc=use]');
    use.textContent = useLabel();
    use.disabled = Math.abs(selected - nowR()) < 1e-9;
    root.querySelectorAll('.rc-table tbody tr').forEach(tr => tr.classList.toggle('sel', Math.abs(+tr.dataset.r - selected) < 1e-9));
    const sug = run.suggested.target;
    let btn = root.querySelector('[data-rc=pickSug]');
    const want = sug !== null && Math.abs(sug - selected) > 1e-9;
    if (!want && btn) btn.remove();
    if (want && !btn) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn ghost small'; btn.dataset.rc = 'pickSug';
      btn.addEventListener('click', () => { selected = run.suggested.target; update(); });
      root.querySelector('[data-rc=actions]').append(btn);
    }
    if (btn) btn.textContent = `Pick the suggested ${pct(sug)}%`;
  }

  function wire() {
    root.querySelectorAll(`input[name="${uid}h"]`).forEach(i => i.addEventListener('change', () => { horizon = +i.value; draw(); root.querySelector('.rc-h input:checked')?.focus(); }));
    root.querySelector('[data-rc=exam]')?.addEventListener('change', e => { examIx = +e.target.value; draw(); });
    root.querySelector('[data-rc=use]').addEventListener('click', () => { onPick(Math.round(selected * 100)); draw(); });          // (drawn again: the "Now" marker moves)
    root.querySelector('[data-rc=pickSug]')?.addEventListener('click', () => { selected = run.suggested.target; update(); });
    const choose = r => { selected = pickSelected(run.result.points, Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, r)) / 100); update(); };
    root.querySelectorAll('svg.rc-svg').forEach(svg => {
      svg.addEventListener('click', ev => {
        const box = svg.getBoundingClientRect();
        const x = (ev.clientX - box.left) / box.width * W;
        choose(Math.round(((x - M.l) / (W - M.l - M.r)) * (RETENTION_MAX - RETENTION_MIN) + RETENTION_MIN));
      });
      svg.addEventListener('keydown', ev => {
        const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, Home: -99, End: 99 }[ev.key];
        if (!step) return;
        ev.preventDefault();
        choose(Math.round(selected * 100) + step);
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
  const helper = mountRetentionHelper($('rcRoot'), { deckId, current, onPick });
  $('sheet').addEventListener('close', () => helper.stop(), { once: true });
  $('rcClose').addEventListener('click', closeSheet);
}
