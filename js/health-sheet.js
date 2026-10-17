// "Check how well it fits you": the health check sheet, opened from Settings → Study → Advanced scheduling, next to Personal parameters.
// It changes nothing. It reads your review history and shows, in plain words:
//   1. how well your CURRENT weights predicted your recent reviews (Good / OK / Poor),
//   2. how often you really remembered cards in the last 30 days, young and mature, against your target,
//   3. whether you press Hard far more than usual,
// each with one line of advice. The numbers and thresholds are in js/fit-health.js; the scoring runs in the worker (js/worker-job.js).
// "Ignore reviews before" (Advanced scheduling) is respected.

import * as db from './db.js';
import { buildHistories, MIN_REVIEWS } from './fsrs-data.js';
import { healthFit, classifyFit, fitAdvice, biasLine, GRADE_WORDS, retentionVerdict, retentionAdvice, hardUse, hardAdvice, HEALTH_MIN_N } from './fit-health.js';
import { runJob } from './worker-job.js';
import { retentionByAge, YOUNG_DAYS } from './stats-calc.js';
import { rowsFrom, deckSchedulerOptions, cleanFsrsParams } from './sched-settings.js';
import { effectiveDeck } from './deck-tree.js';
import { $, esc, openSheet, closeSheet, plural } from './ui.js';

const DAY = 86400000;
const pctText = x => `${(x * 100).toFixed(1)}%`;
const whole = x => `${Math.round(x * 100)}%`;
const ICON = { good: '✓', ok: '!', poor: '✕', unknown: '–', on: '✓', under: '▼', over: '▲', few: '–' };

// Everything the sheet shows, worked out from the database. Exported for the tests of the wiring.
export async function runHealthCheck({ now = Date.now(), onProgress = () => {} } = {}) {
  const srs = await import('./srs.js');
  const [settings, decks, cards, allRows] = await Promise.all([db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAllInPieces('reviewLog')]);
  const rows = rowsFrom(allRows, settings.ignoreBefore);
  const hist = buildHistories(rows);
  const own = cleanFsrsParams(settings.fsrsParams)?.w || null;
  const w = own || srs.default_w.slice();
  const deckOf = new Map(cards.map(c => [c.id, c.deckId]));
  const steps = hist.cards.map(h => deckSchedulerOptions(settings, effectiveDeck(decks, deckOf.get(h.cardId))).relearningSteps.length);
  const retOf = new Map();
  const targetOf = id => {
    const deckId = deckOf.get(id);
    if (!retOf.has(deckId)) retOf.set(deckId, deckSchedulerOptions(settings, effectiveDeck(decks, deckId)).retention);
    return retOf.get(deckId);
  };
  // The young/mature split needs each answer's previous answer, so it uses ALL rows: with "Ignore reviews before" the previous answer of
  // a card's first answer after the date may be before it, and would otherwise be missing (and the card counted as mature).
  const ret = retentionByAge(allRows, now, [30], { targetOf })[30];
  const hard = hardUse(rows, now);
  let fit = { status: 'not-enough', n: 0 };
  if (hist.reviews >= 1) {
    const job = runJob('health', { cards: hist.cards, steps, w, bounds: srs.CLAMP_PARAMETERS(srs.W17_W18_Ceiling, true), today: Math.floor(now / DAY) }, { onProgress, timeoutMs: 60000 });
    const out = await job.promise;
    if (out.status !== 'done') throw new Error(out.message || out.status);
    fit = out.result;
  }
  return { settings, own: !!own, ownInfo: cleanFsrsParams(settings.fsrsParams), reviews: hist.reviews, fit, ret, hard, canOptimize: hist.reviews >= MIN_REVIEWS, now };
}

const dateText = day => new Date(day * DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

// ---------- drawing ----------
function badge(kind, text) {
  return `<span class="hc-badge ${kind}"><span aria-hidden="true">${ICON[kind]}</span> ${esc(text)}</span>`;
}

function fitSection(r) {
  const f = r.fit;
  if (f.status !== 'ok') {
    return `<section class="hc-sec" aria-labelledby="hcFit"><h3 id="hcFit">Fit quality ${badge('unknown', GRADE_WORDS.unknown)}</h3>
      <p>We need at least ${HEALTH_MIN_N} recent reviews to judge this; you have ${f.n || 0}. Game answers and cards whose history is incomplete aren't used.</p>
      <p class="hc-sug">${esc(fitAdvice({ grade: 'unknown' }, {}))}</p></section>`;
  }
  const c = classifyFit(f);
  return `<section class="hc-sec" aria-labelledby="hcFit"><h3 id="hcFit">Fit quality ${badge(c.grade, GRADE_WORDS[c.grade])}</h3>
    <p>${r.own ? 'Your own settings' : 'The standard settings'} predicted your last ${plural(f.n, 'review')} (since ${esc(dateText(f.sinceDay))}) with a prediction error (log loss) of <b class="mono">${f.logLoss.toFixed(3)}</b> and RMSE <b class="mono">${pctText(f.rmse)}</b>. Lower is better.</p>
    ${c.rough ? '<p class="hc-rough">Only a few reviews, so treat this as rough.</p>' : ''}
    ${biasLine(c) ? `<p>${esc(biasLine(c))}</p>` : ''}
    <p class="hc-sug">${esc(fitAdvice(c, { usingOwn: r.own, canOptimize: r.canOptimize, retention: retentionVerdict(r.ret.all, r.ret.target).verdict }))}</p>
    <details class="opt-fold"><summary>How this is judged</summary>
      <p class="opt-note">Three checks, and the verdict is the worst of them. (1) Do the average predicted and the actual chance of remembering match? Poor if they differ by more than 3 points beyond chance. (2) How far off are the predictions in each band of confidence, with the part that is just luck on a small sample removed? Good up to 2 points, OK up to 4. (3) Do the predictions beat just guessing your own average (${whole(f.recall)}) every time? A model that is no better than that cannot be Good.</p></details></section>`;
}

function bucketLine(name, b, target) {
  const v = retentionVerdict(b, target);
  if (v.verdict === 'few') return `<li><span class="hc-name">${name}</span><span class="hc-val">${b.n ? `${b.n} reviews, too few to say` : 'No reviews'}</span></li>`;
  const pts = Math.round(Math.abs(v.gap) * 100);
  const word = v.verdict === 'on' ? 'on target' : `${pts} point${pts === 1 ? '' : 's'} ${v.verdict === 'under' ? 'under' : 'above'}`;
  return `<li><span class="hc-name">${name}</span><span class="hc-val"><b class="mono">${whole(v.rate)}</b> of ${b.n} <span class="hc-gap ${v.verdict}"><span aria-hidden="true">${ICON[v.verdict]}</span> ${esc(word)}</span></span></li>`;
}

function retentionSection(r) {
  const t = r.ret.target;
  const all = r.ret.all;
  const v = retentionVerdict(all, t);
  return `<section class="hc-sec" aria-labelledby="hcRet"><h3 id="hcRet">Retention, last 30 days ${badge(v.verdict === 'few' ? 'unknown' : v.verdict, { few: 'Not enough yet', on: 'On target', under: 'Under target', over: 'Above target' }[v.verdict])}</h3>
    <p>How often you remembered cards when they came due${Number.isFinite(t) ? `, against your target of <b class="mono">${whole(t)}</b>` : ''}.</p>
    <ul class="hc-list">${bucketLine(`Young cards <small>(gap under ${YOUNG_DAYS} days)</small>`, r.ret.young, t)}${bucketLine(`Mature cards <small>(${YOUNG_DAYS} days or more)</small>`, r.ret.mature, t)}</ul>
    <p class="hc-sug">${esc(retentionAdvice(all, r.ret.young, r.ret.mature, t, { canOptimize: r.canOptimize }))}</p></section>`;
}

function hardSection(r) {
  const h = r.hard;
  const kind = h.passes < 50 ? 'unknown' : h.overuse ? 'poor' : 'good';
  const word = h.passes < 50 ? 'Not enough yet' : h.overuse ? 'Used a lot' : 'Normal';
  return `<section class="hc-sec" aria-labelledby="hcHard"><h3 id="hcHard">Hard button ${badge(kind, word)}</h3>
    <p>${h.passes >= 50 ? `You pressed Hard on <b class="mono">${whole(h.share)}</b> of the ${plural(h.passes, 'review')} you remembered in the last 90 days.` : 'Over the last 90 days there are too few reviews to tell.'}</p>
    <p class="hc-sug">${esc(hardAdvice(h))}</p></section>`;
}

export async function openHealthSheet() {
  openSheet(`
    <h2 id="sheetTitle">How well it fits you</h2>
    <div data-health class="hc" id="hcBody"><p class="opt-phase" aria-live="polite">Checking your reviews…</p>
      <div class="opt-bar" role="progressbar" aria-label="Checking" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="hcBar"><i style="width:0"></i></div></div>
    <div class="sheet-actions"><button type="button" class="btn primary" id="hcClose">Close</button></div>`);
  $('hcClose').addEventListener('click', closeSheet);
  const d = $('sheet');
  let gone = false;
  d.addEventListener('close', () => { gone = true; }, { once: true });
  try {
    const r = await runHealthCheck({ onProgress: p => { const bar = $('hcBar'); if (bar) { const v = Math.round((p.progress || 0) * 100); bar.setAttribute('aria-valuenow', String(v)); bar.firstElementChild.style.width = v + '%'; } } });
    if (gone || !$('hcBody')) return;
    const ignore = r.settings.ignoreBefore;
    $('hcBody').innerHTML = `
      ${r.reviews < 1 ? '<p class="opt-result">No reviews to look at yet. Come back after you have studied for a while.</p>' : ''}
      ${fitSection(r)}${retentionSection(r)}${hardSection(r)}
      <p class="opt-note">It uses only reviews you rated in Review and imported Anki history${ignore ? `, and ignores reviews before ${esc(ignore)}` : ''}. Nothing was changed.</p>`;
  } catch (err) {
    console.error(err);
    if (!gone && $('hcBody')) $('hcBody').innerHTML = '<p class="opt-result bad">Couldn’t check on this device. Nothing changed.</p>';
  }
}
