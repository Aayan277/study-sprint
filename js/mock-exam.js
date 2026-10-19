// The Practice test screen (#/test): taking a test, then the results. A calm mock exam: one question at a time, no feedback until you
// submit, Previous / Next, "Flag for review", a question navigator, an optional time limit, and a test you can leave and pick up again.
// The rules (building, grading, scores) are in mock-exam-logic.js; what is remembered is in mock-exam-store.js; the setup sheet is mock-exam-sheet.js.
// Reuse: Play's question builder and wrong options (game.js), typed-answer checking (match.js), and "Count answers as reviews" goes
// through the same code as Play (practice-save.js, source 'test').

import * as db from './db.js';
import {
  scoreRun, isAnswered, byTag, byDeck, tagLabel, missedIds, navState, clock, timeLeft, correctText, retakeRun, newState, UNTAGGED
} from './mock-exam-logic.js';
import { loadSaved, saveState, saveRun, clearSaved, saveResult, getHistory, KEYS } from './mock-exam-store.js';
import { savePracticeAnswer, markLeechIfDue, practicedToday, scheduleSummaryHTML } from './practice-save.js';
import { loadAll, launchStudy } from './study-data.js';
import { questionAnnouncement, spokenPrompt } from './game.js';
import { singleKeysOn, keyHint } from './shortcuts.js';
import { deckPath } from './deck-tree.js';
import { mathHTML, answerText } from './format.js';
import { imgHTML, warmCards } from './media.js';
import { soundsHTML, stopSound } from './audio.js';
import { occlusionHTML } from './occlusion.js';
import { holdBack, releaseBack, replace as navReplace } from './nav.js';
import { drawSidebar } from './sidebar.js';
import { refreshBadge } from './badge.js';
import { $, esc, plural, toast, setFocusMode, openSheet, closeSheet, icon, ring } from './ui.js';

const KIND_LABEL = { mc: 'Multiple choice', typing: 'Type the answer', cloze: 'Fill in the blank', tf: 'True or false' };
const PROMPT_LABEL = q => (q.kind === 'mc' ? (q.qtype === 'back' ? 'Which card is this?' : 'Pick the matching answer') : q.kind === 'tf' ? 'True or false: is this the right answer?' : q.kind === 'cloze' ? 'Fill in the blank' : 'Type the answer');
const sizeClass = text => { const n = answerText(text).length; return n > 120 ? ' xlong' : n > 50 ? ' long' : ''; };

let T = null;     // the test on screen: { el, run, state, decks, cards, since, base, ... }

// ---------- the screen ----------
export async function renderTest(el, deckId) {
  stopTest();
  const saved = loadSaved();
  if (!saved) { await noTest(el, deckId); return; }
  const [decks, cardList] = await Promise.all([db.getDecks(), db.getAllCached('cards')]);
  if (!el.isConnected) return;
  T = { el, owner: Math.random().toString(36).slice(2), frozen: false, run: saved.run, state: saved.state, decks, cards: new Map(cardList.map(c => [c.id, c])), asking: null, submitting: false, lastNav: '', said: new Set() };
  if (T.state.done) { await drawResults(); return; }
  startTaking();
}

// Nothing to take (the address was typed, or the test is gone): the setup sheet opens over a short page.
async function noTest(el, deckId) {
  el.innerHTML = `<div class="screen-head"><div><h1>Practice test</h1></div></div>
    <p class="note">There is no test in progress.</p>
    <button class="btn primary" type="button" id="tSetup">Set up a practice test</button>`;
  // (Start builds the test and draws it here: the address does not change, so there is no route change to do it.)
  const open = async () => (await import('./mock-exam-sheet.js')).openTestSheet(deckId || '', { onStart: id => renderTest(el, id) });
  $('tSetup').addEventListener('click', open);
  open();
}

function stopTest() {
  setFocusMode(false);
  releaseBack('session');
  if (!T) return;
  clearInterval(T.timer);
  stopSound();
  T = null;
}

const q = () => T.run.questions[T.state.i];
const total = () => T.run.questions.length;
const elapsedNow = () => T.base + (performance.now() - T.since);
function persist() {
  if (T.frozen) return;                 // another tab took the test over: this one must not write over it
  T.state.elapsed = Math.round(elapsedNow());
  T.state.saved = Date.now();
  T.state.owner = T.owner;
  saveState(T.state);
}

// ---------- taking the test ----------
function startTaking() {
  const { el, run, state } = T;
  T.base = state.elapsed; T.since = performance.now();
  setFocusMode(true);
  holdBack('session', backPressed);              // Back (an edge swipe) asks "Leave test?" instead of leaving
  const timed = run.cfg.limit > 0;
  el.innerHTML = `
    <div class="hud mono t-hud${timed ? ' t-timed' : ''}">
      <span id="tProg"></span>
      <span id="tDone" class="t-done"></span>
      ${timed ? '<span id="tClock" class="t-clock">Time left <b id="tClockV"></b></span>' : ''}
      <button class="link" id="tLeave" type="button">Leave</button>
    </div>
    <div class="t-bar" id="tBar" role="progressbar" aria-label="Test progress" aria-valuemin="1" aria-valuemax="${total()}"><i id="tBarFill"></i></div>
    <div class="end-ask t-ask" id="tAsk" role="alertdialog" aria-labelledby="tAskT" hidden></div>
    <h1 class="sr-only">Practice test: ${esc(deckLabel(run.deckId))}</h1>
    <div class="t-layout" id="tLayout">
      <div class="t-main">
        <p class="prompt" id="tLabel"></p>
        <div class="flash play-card t-card" id="tCard">
          <div class="flash-front" id="tPrompt" role="heading" aria-level="2" tabindex="-1"></div>
        </div>
        <div id="tAnswer" class="t-answer"></div>
        <div class="t-step">
          <button class="btn ghost" id="tPrev" type="button">‹ Previous${keyHint(' <kbd class="key-hint">P</kbd>')}</button>
          <button class="btn primary" id="tNext" type="button">Next ›</button>
        </div>
        <div class="t-tools">
          <button class="btn ghost small" id="tFlag" type="button" aria-pressed="false">${icon('flag')}<span>Flag for review</span>${keyHint(' <kbd class="key-hint">F</kbd>')}</button>
          <button class="btn ghost small t-navbtn" id="tNavBtn" type="button">${icon('grid')}<span>Questions</span></button>
          <button class="btn ghost small" id="tClear" type="button" hidden>Clear answer</button>
          <button class="btn ghost small t-submit" id="tSubmit" type="button">Submit test</button>
        </div>
      </div>
      <aside class="t-nav" aria-label="Question navigator">
        <h2 class="t-nav-h">Questions</h2>
        <div class="t-grid" role="group" aria-label="Jump to a question"></div>
        ${legendHTML()}
      </aside>
    </div>
    <div class="sr-only" id="tAnnounce" aria-live="polite"></div>`;
  $('tLeave').addEventListener('click', askLeave);
  $('tPrev').addEventListener('click', () => go(T.state.i - 1));
  $('tNext').addEventListener('click', () => (T.state.i >= total() - 1 ? askSubmit() : go(T.state.i + 1)));
  $('tFlag').addEventListener('click', toggleFlag);
  $('tClear').addEventListener('click', clearAnswer);
  $('tSubmit').addEventListener('click', askSubmit);
  $('tNavBtn').addEventListener('click', openNavSheet);
  el.querySelector('.t-grid').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) go(+b.dataset.q); });
  $('tAnswer').addEventListener('change', e => { if (e.target.matches('input[type=radio]')) setAnswer(T.state.i, q().kind === 'mc' ? +e.target.value : e.target.value === 'true'); });
  $('tAnswer').addEventListener('input', e => { if (e.target.id === 'tInput') setAnswer(T.state.i, e.target.value.trim() ? e.target.value : null); });
  $('tAnswer').addEventListener('submit', e => e.preventDefault());
  $('tAnswer').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'tInput') { e.preventDefault(); if (T.state.i < total() - 1) go(T.state.i + 1); } });
  lastSecond = -1;
  if (timed) { tickClock(); T.timer = setInterval(tickClock, 250); } else T.timer = setInterval(housekeeping, 1000);
  showQuestion(T.state.i, { first: true });
}

const legendHTML = () => `<ul class="t-legend" aria-label="Key">
  <li><i class="t-q answered" aria-hidden="true"></i>Answered</li><li><i class="t-q" aria-hidden="true"></i>Not answered</li>
  <li><i class="t-q flagged" aria-hidden="true"></i>Flagged</li></ul>`;

// Time: counted only while the test is open. The clock also saves the time used, so a reload gets it back.
let lastSecond = -1;
function tickClock() {
  if (!housekeeping()) return;
  const left = timeLeft(T.run, { elapsed: elapsedNow() });
  const sec = Math.ceil(left / 1000);
  if (sec !== lastSecond) {
    lastSecond = sec;
    const v = $('tClockV');
    if (v) v.textContent = clock(left);
    $('tClock')?.classList.toggle('clock-low', left <= 60000);
    for (const [at, text] of [[300, '5 minutes left'], [60, '1 minute left'], [30, '30 seconds left']]) {
      if (sec <= at && sec > at - 2 && !T.said.has(at) && T.run.cfg.limit * 60 > at) { T.said.add(at); announce(text); }
    }
  }
  if (left <= 0 && !T.submitting && !T.frozen) { announce('Time is up. Your test is being submitted.'); submit({ auto: true }); }
}
// Every second: stop if the screen was left (and keep the time used), else save the time.
function housekeeping() {
  if (!T) return false;
  if (!T.el.isConnected) { if (!T.submitting && !T.state.done) persist(); stopTest(); return false; }
  if (!T.submitting) persist();
  return true;
}
addEventListener('pagehide', () => { if (T && !T.submitting && !T.state.done && T.el.isConnected) persist(); });

const announce = text => { const a = $('tAnnounce'); if (a) a.replaceChildren(Object.assign(document.createElement('p'), { textContent: text })); };

// One question. first: the test just opened or resumed.
function showQuestion(i, { first = false } = {}) {
  if (!first) T.state.spent[T.state.i] += Math.round(performance.now() - T.qStart);
  T.state.i = i;
  T.qStart = performance.now();
  persist();
  const question = q(), card = T.cards.get(question.cardId);
  stopSound();
  $('tLabel').textContent = PROMPT_LABEL(question);
  const p = $('tPrompt');
  p.className = `flash-front${sizeClass(question.prompt)}`;
  p.innerHTML = (question.occ && card ? occlusionHTML(card, 'front', { zoom: false }) : imgHTML(question.image)) + mathHTML(question.prompt) + soundsHTML(question.sounds);
  if (question.prompt.includes('[…]') || question.occ) p.setAttribute('aria-label', spokenPrompt(question)); else p.removeAttribute('aria-label');
  drawAnswer(question, T.state.answers[i]);
  warmCards(T.run.questions.slice(i + 1, i + 4).map(x => T.cards.get(x.cardId)).filter(Boolean));
  updateChrome();
  if ($('tCard').getBoundingClientRect().top < 0) scrollTo(0, 0);
  // Focus goes to the question (a screen reader reads it from there); a typed question puts it in the box.
  const typed = question.kind === 'typing' || question.kind === 'cloze';
  (typed ? $('tInput') : p)?.focus({ preventScroll: true });
  announce(questionAnnouncement({ fmt: 'classic', total: total(), i }, question, { withText: typed }));
}

function drawAnswer(question, given) {
  const box = $('tAnswer');
  if (question.kind === 'mc') {
    const long = question.options.some(o => o.length > 28);
    box.innerHTML = `<div class="options t-options${question.options.length > 4 ? ' six' : ''}${long ? ' long' : ''}" role="radiogroup" aria-labelledby="tPrompt">
      ${question.options.map((o, j) => `<label class="opt t-opt"><input type="radio" name="tq" value="${j}" ${given === j ? 'checked' : ''}>${keyHint(`<span class="key" aria-hidden="true">${j + 1}</span>`)}<span class="lbl">${mathHTML(o, { inline: true })}</span></label>`).join('')}</div>`;
  } else if (question.kind === 'tf') {
    box.innerHTML = `<div class="t-claim"><span class="t-claim-l">Proposed answer</span><div class="t-claim-v" id="tClaim">${mathHTML(question.shown)}</div></div>
      <div class="options t-options" role="radiogroup" aria-labelledby="tPrompt tClaim">
        ${[['true', 'True'], ['false', 'False']].map(([v, label], j) => `<label class="opt t-opt"><input type="radio" name="tq" value="${v}" ${given === (v === 'true') ? 'checked' : ''}>${keyHint(`<span class="key" aria-hidden="true">${j + 1}</span>`)}<span class="lbl">${label}</span></label>`).join('')}</div>`;
  } else {
    box.innerHTML = `<form class="typeform t-type" id="tType" autocomplete="off">
      <input id="tInput" type="text" maxlength="500" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Your answer" placeholder="Type the answer" value="${esc(typeof given === 'string' ? given : '')}"></form>`;
  }
}

// Progress, counts, the navigator and the buttons: everything that follows the answers and flags.
function updateChrome() {
  const { state, run } = T, n = total(), i = state.i, question = q();
  const answered = run.questions.filter((x, k) => isAnswered(x, state.answers[k])).length;
  $('tProg').innerHTML = `Question <b>${i + 1}</b> of ${n}`;
  $('tDone').textContent = `${answered} answered`;
  $('tBar').setAttribute('aria-valuenow', String(i + 1));
  $('tBar').setAttribute('aria-valuetext', `Question ${i + 1} of ${n}`);
  $('tBarFill').style.width = `${((i + 1) / n) * 100}%`;
  $('tPrev').disabled = i === 0;
  $('tNext').textContent = i >= n - 1 ? 'Review and submit' : 'Next ›';
  if (i < n - 1) $('tNext').insertAdjacentHTML('beforeend', keyHint(' <kbd class="key-hint">N</kbd>'));
  const flagged = state.flags[i];
  $('tFlag').setAttribute('aria-pressed', String(flagged));
  $('tFlag').querySelector('span').textContent = flagged ? 'Flagged for review' : 'Flag for review';
  $('tClear').hidden = !isAnswered(question, state.answers[i]) || question.kind === 'typing' || question.kind === 'cloze';
  // The navigator (in the page on wide screens, in a sheet on phones): only the cells that changed are touched.
  document.querySelectorAll('.t-grid').forEach(syncGrid);
}
const deckLabel = id => deckPath(T.decks, id) || 'Deleted deck';

// How one navigator cell looks and is named, from the answers and flags.
function cellOf(k) {
  const s = navState(T.run.questions[k], T.state.answers[k], T.state.flags[k]), cur = k === T.state.i;
  const cls = `t-q${s.answered ? ' answered' : ''}${s.flagged ? ' flagged' : ''}${cur ? ' current' : ''}`;
  const label = `Question ${k + 1}, ${s.answered ? 'answered' : 'not answered'}${s.flagged ? ', flagged' : ''}`;
  return { cls, label, cur, sig: `${cls}|${label}` };
}
function syncGrid(g) {
  if (g.children.length !== total()) { g.innerHTML = gridHTML(); return; }
  for (const b of g.children) {
    const c = cellOf(+b.dataset.q);
    if (b.dataset.sig === c.sig) continue;
    b.className = c.cls; b.setAttribute('aria-label', c.label); b.dataset.sig = c.sig;
    if (c.cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  }
}

function gridHTML() {
  return T.run.questions.map((x, k) => {
    const c = cellOf(k);
    return `<button type="button" class="${c.cls}" data-q="${k}" data-sig="${esc(c.sig)}"${c.cur ? ' aria-current="true"' : ''} aria-label="${c.label}">${k + 1}</button>`;
  }).join('');
}

function setAnswer(i, value) {
  T.state.answers[i] = value;
  persist();
  updateChrome();
}
function clearAnswer() {
  setAnswer(T.state.i, null);
  drawAnswer(q(), null);
  $('tAnswer').querySelector('input')?.focus({ preventScroll: true });
  announce('Answer cleared');
}
function toggleFlag() {
  const i = T.state.i;
  T.state.flags[i] = !T.state.flags[i];
  persist();
  updateChrome();
  announce(T.state.flags[i] ? `Question ${i + 1} flagged for review` : `Question ${i + 1} unflagged`);
}
function go(i) {
  if (i < 0 || i >= total() || i === T.state.i) return;
  closeSheet();
  showQuestion(i);
}

// The navigator as a sheet (phones; on a wide screen it sits beside the question).
function openNavSheet() {
  openSheet(`
    <h2 id="sheetTitle">Questions</h2>
    <p class="note" style="margin-top:0" id="tNavNote"></p>
    <div class="t-grid" role="group" aria-label="Jump to a question"></div>
    ${legendHTML()}
    <div class="sheet-actions"><button class="btn primary" type="button" id="tNavSubmit">Submit test</button></div>`);
  const sheet = $('sheet');
  const fill = () => { sheet.querySelector('.t-grid').innerHTML = gridHTML(); $('tNavNote').textContent = counts(); };
  fill();
  sheet.querySelector('.t-grid').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) { closeSheet(); go(+b.dataset.q); } });
  $('tNavSubmit').addEventListener('click', () => { closeSheet(); askSubmit(); });
}
const counts = () => {
  const { run, state } = T;
  const un = run.questions.filter((x, k) => !isAnswered(x, state.answers[k])).length, fl = state.flags.filter(Boolean).length;
  return `${plural(total() - un, 'question')} answered, ${un} not answered${fl ? `, ${fl} flagged` : ''}.`;
};

// ---------- asking: leave, submit ----------
const PARTS = ['tLayout'];
const setInert = on => PARTS.forEach(id => { const e = $(id); if (e) e.inert = on; });
function showAsk(kind, html) {
  closeSheet();
  T.asking = kind;
  const box = $('tAsk');
  box.innerHTML = html;
  box.hidden = false;
  setInert(true);
}
function hideAsk() {
  if (!T?.asking) return;
  if (T.frozen) { if (T.asking !== 'tab') showTabAsk(); return; }       // another tab owns the test: only "Continue here" lifts that question
  T.asking = null;
  $('tAsk').hidden = true;
  setInert(false);
}
// Leave: the answers stay saved; the test can be resumed from the deck page.
function askLeave() {
  if (T.submitting) return;
  showAsk('leave', `<p id="tAskT"><b>Leave test?</b> Your answers are saved. You can carry on from the deck page.</p>
    <div class="end-ask-b"><button class="btn primary small" id="tAskNo" type="button">Keep testing</button><button class="btn ghost small" id="tAskYes" type="button">Leave test</button></div>`);
  $('tAskNo').addEventListener('click', keepTesting);
  $('tAskYes').addEventListener('click', leave);
  $('tAskNo').focus({ preventScroll: true });
}
function askSubmit() {
  if (T.submitting) return;
  const { run, state } = T;
  const open = run.questions.map((x, k) => k).filter(k => !isAnswered(run.questions[k], state.answers[k]));
  const flagged = state.flags.map((f, k) => (f ? k : -1)).filter(k => k >= 0);
  if (!open.length && !flagged.length) { submit({}); return; }
  const list = ks => (ks.length > 8 ? `${ks.slice(0, 8).map(k => k + 1).join(', ')} and ${ks.length - 8} more` : ks.map(k => k + 1).join(', '));
  const lines = [open.length ? `${plural(open.length, 'question')} not answered (${list(open)}). They count as wrong.` : '', flagged.length ? `${flagged.length} flagged for review (${list(flagged)}).` : ''].filter(Boolean);
  showAsk('submit', `<div class="t-ask-text"><p id="tAskT"><b>Submit your test?</b></p><p class="t-ask-d">${lines.join(' ')}</p></div>
    <div class="end-ask-b"><button class="btn primary small" id="tAskNo" type="button">${open.length ? 'Go to first unanswered' : 'Go to first flagged'}</button><button class="btn ghost small" id="tAskYes" type="button">Submit test</button></div>`);
  const target = open.length ? open[0] : flagged[0];
  $('tAskNo').addEventListener('click', () => { hideAsk(); if (target === T.state.i) keepTesting(); else go(target); });
  $('tAskYes').addEventListener('click', () => { hideAsk(); submit({}); });
  $('tAskYes').focus({ preventScroll: true });
}
function keepTesting() {
  hideAsk();
  const typed = q().kind === 'typing' || q().kind === 'cloze';
  (typed ? $('tInput') : $('tPrompt'))?.focus({ preventScroll: true });
}
function leave() {
  persist();
  const deckId = T.run.deckId;
  stopTest();
  navReplace(`#/deck/${encodeURIComponent(deckId)}`);
}
// Back (the back gesture): asks; a second Back while the question is up leaves (the way out where there is no Esc key).
function backPressed() {
  if (!T || T.state.done) return;
  if (T.asking === 'tab') return;
  if (T.asking === 'leave') leave(); else if (T.asking) hideAsk(); else askLeave();
}

addEventListener('keydown', e => {
  if (!T || T.state.done || T.submitting || !$('tLayout') || e.ctrlKey || e.metaKey || e.altKey || document.getElementById('sheet')?.open) return;
  if (T.asking === 'tab') return;
  if (T.asking) { if (e.key === 'Escape') { e.preventDefault(); if (T.asking === 'leave') keepTesting(); else hideAsk(); } return; }
  if (e.key === 'Escape') { e.preventDefault(); askLeave(); return; }
  const inField = e.target.matches?.('input[type=text], textarea, select');
  if (inField || !singleKeysOn()) return;
  const question = q();
  if (/^[1-6]$/.test(e.key) && (question.kind === 'mc' || question.kind === 'tf')) {
    const box = $('tAnswer').querySelectorAll('input[type=radio]')[+e.key - 1];
    if (box) { e.preventDefault(); box.checked = true; box.focus({ preventScroll: true }); box.dispatchEvent(new Event('change', { bubbles: true })); }
  } else if (/^[nN]$/.test(e.key)) { e.preventDefault(); if (T.state.i < total() - 1) go(T.state.i + 1); }
  else if (/^[pP]$/.test(e.key)) { e.preventDefault(); go(T.state.i - 1); }
  else if (/^[fF]$/.test(e.key)) { e.preventDefault(); toggleFlag(); }
});

// Two tabs: the "storage" event only fires in the other tab. When it changes the test, this tab stops writing (so neither silently overwrites
// the other) and asks; "Continue here" takes the test over and the other tab then asks the same.
addEventListener('storage', e => {
  if (!T || T.frozen || T.submitting || T.state.done || !KEYS.includes(e.key) || !$('tLayout')) return;
  T.frozen = true;
  showTabAsk();
});
function showTabAsk() {
  showAsk('tab', `<p id="tAskT"><b>This test is open in another tab.</b> Carry on there, or continue here (the other tab will stop).</p>
    <div class="end-ask-b"><button class="btn primary small" id="tAskYes" type="button">Continue here</button></div>`);
  $('tAskYes').addEventListener('click', () => {
    const el = T.el, mine = T.run, state = T.state;
    T.frozen = false;
    if (!loadSaved()) saveRun(mine, state);       // the other tab finished or discarded it: this copy goes back
    renderTest(el);
  });
  $('tAskYes').focus({ preventScroll: true });
}

// ---------- submitting ----------
async function submit({ auto = false }) {
  if (!T || T.submitting || T.frozen) return;
  T.submitting = true;
  clearInterval(T.timer);
  T.state.spent[T.state.i] += Math.round(performance.now() - T.qStart);
  hideAsk();
  closeSheet();
  const { run, state } = T;
  state.elapsed = Math.round(Math.min(elapsedNow(), run.cfg.limit > 0 ? run.cfg.limit * 60000 : Infinity));
  state.done = true; state.finished = Date.now(); state.auto = auto;
  // Counted as reviews: which answers are saved yet (0/1 each), so a reload in the middle of saving carries on where it stopped.
  state.rec = run.cfg.counts ? run.questions.map(() => 0) : null;
  state.hist = false;
  const history = await getHistory();
  const before = (history[run.deckId] || []).at(-1);
  state.prev = before ? before.pct : null;
  saveState(state);
  releaseBack('session');
  setFocusMode(false);
  await drawResults({ fresh: true });
}

// The result goes into the deck's history once (a reload right after submitting finds it not saved yet and does it).
async function ensureHistory(run, state, score) {
  if (state.hist) return;
  state.hist = true;
  await saveResult(run.deckId, { run: run.id, at: state.finished, pct: score.pct, correct: score.correct, total: score.total, secs: Math.round(state.elapsed / 1000) }).catch(err => { state.hist = false; console.error('Could not save the result', err); });
  keepState(run, state);
}
// Write the state back, but only while it is still the saved test (another one may have started since).
function keepState(run, state) { if (loadSaved()?.run.id === run.id) saveState(state); }
const pendingAnswers = (run, state) => (state.rec ? run.questions.map((x, i) => i).filter(i => state.rec[i] === 0 && isAnswered(run.questions[i], state.answers[i])) : []);

// "Count answers as reviews" on: each answered question goes through the same path as Play's counted answers (practice-save.js).
// Each saved answer is marked in state.rec, so doing it again after a reload only does what is left. A row the log already has (the
// answer was written just before the reload) is marked without writing it a second time. True or false answers are logged only:
// a coin flip says too little about memory to move a schedule.
// Returns { entries (what this run saved), failed (how many could not be saved) }.
async function recordAnswers(run, state) {
  const score = scoreRun(run.questions, state.answers);
  const data = await loadAll({ history: true, fullHistory: true });
  const env = { settings: data.settings, decks: data.decks, statesById: data.statesById, examCaps: data.exam.caps, playedToday: practicedToday(data.logs), newLeft: data.newLeft };
  const byId = new Map(data.allCards.map(c => [c.id, c]));
  const written = new Set(data.logs.filter(l => l.source === 'test' && l.timestamp >= state.finished - 1000).map(l => l.cardId));
  const entries = [];
  let leeches = 0, failed = 0;
  for (const i of pendingAnswers(run, state)) {
    const question = run.questions[i], res = score.per[i], card = byId.get(question.cardId);
    if (!card || written.has(question.cardId)) { state.rec[i] = 1; keepState(run, state); continue; }       // (a deleted card has nothing to save)
    const given = state.answers[i];
    const wrongPick = question.kind === 'mc' && !res.ok ? question.optIds?.[given] : undefined;
    const entry = { card, ok: res.ok, ms: state.spent[i] || 0, limitMs: Infinity, given: res.given,
      mixedWith: wrongPick && wrongPick !== card.id ? wrongPick : undefined, chars: answerText(question.prompt).length };
    try {
      await savePracticeAnswer(env, entry, {
        source: 'test', qtype: question.kind === 'mc' || question.kind === 'tf' ? question.qtype : 'typing', fmt: 'test', hard: false, untimed: true, logOnly: question.kind === 'tf',
        afterApply: async (c, prev, next, log) => { const hit = await markLeechIfDue(env.settings, c, prev, next, log); if (hit) leeches++; return hit ? { tags: hit.before.tags, suspended: hit.before.suspended } : null; }
      });
    } catch (err) { console.error('Could not save an answer', err); failed++; continue; }
    state.rec[i] = 1; keepState(run, state);
    entries.push(entry);
  }
  drawSidebar();          // the sidebar's counts and ring
  refreshBadge();         // and the number on the app icon
  if (leeches) toast(`${plural(leeches, 'card')} became ${leeches === 1 ? 'a leech' : 'leeches'}: you keep forgetting ${leeches === 1 ? 'it' : 'them'}`);
  return { entries, failed };
}

// Save what is left and say how it went in the results' status line.
async function saveAnswers(run, state) {
  const slot = () => { const e = $('tSched'); return e?.isConnected && T?.run.id === run.id ? e : null; };
  if (slot()) slot().innerHTML = '<p class="sched-note">Saving your answers to the schedule…</p>';
  const left = pendingAnswers(run, state).length;
  let res;
  try { res = await recordAnswers(run, state); } catch (err) { console.error('Could not save answers', err); res = { entries: [], failed: left }; }
  const e = slot();
  if (!e) return;
  if (res.failed) {
    e.innerHTML = `<p class="sched-note">Couldn’t save ${plural(res.failed, 'answer')} to the schedule. <button class="link" type="button" id="tRetry">Retry</button></p>`;
    $('tRetry').addEventListener('click', () => saveAnswers(run, state));
    return;
  }
  e.innerHTML = `<p class="sched-note">Saved to your schedule.</p>${res.entries.length ? scheduleSummaryHTML(res.entries) : ''}`;
}

// ---------- results ----------
async function drawResults({ fresh = false } = {}) {
  const { el, run, state, decks } = T;
  const qs = run.questions, score = scoreRun(qs, state.answers);
  const tags = byTag(qs, score.per), subdecks = byDeck(qs, score.per);
  const deckName = deckLabel(run.deckId);
  const times = state.spent.filter((ms, i) => score.per[i].answered && ms > 0);
  const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const flagged = state.flags.filter(Boolean).length;
  const missed = missedIds(qs, score.per);
  const limitMs = run.cfg.limit * 60000;
  const timeLine = state.auto ? 'Time ran out, so the test was submitted.' : limitMs ? `${clock(state.elapsed)} of ${clock(limitMs)} used.` : `Finished in ${clock(state.elapsed)}.`;
  const weakest = tags.length > 1 && tags[0].pct < 100 ? tags[0] : null;
  const trend = state.prev == null ? '' : score.pct === state.prev ? `Same as last time (${state.prev}%).` : `${score.pct > state.prev ? 'Up' : 'Down'} ${Math.abs(score.pct - state.prev)} points from last time (${state.prev}%).`;
  const root = deckPath(decks, run.deckId);
  const rel = id => { const p = deckPath(decks, id); return id === run.deckId ? `${decks.find(d => d.id === id)?.name || 'Deleted deck'} (cards in this deck)` : !p ? 'Deleted deck' : root && p.startsWith(root + ' › ') ? p.slice(root.length + 3) : p; };
  const bars = (list, label) => `<ul class="t-bars">${list.map(g => `<li class="t-bar-row"><span class="t-bar-l">${esc(label(g.key))}</span>
      <span class="t-bar-t" aria-hidden="true"><i class="${g.pct >= 80 ? 'hi' : g.pct >= 50 ? 'mid' : 'lo'}" style="width:${g.pct}%"></i></span>
      <span class="t-bar-v mono">${g.pct}% <small>${g.correct}/${g.total}</small></span></li>`).join('')}</ul>`;
  const SHOWN_TAGS = 8;
  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">Practice test · ${esc(deckName)}</span><h1 id="tResTitle" tabindex="-1">Your result</h1></div></div>
    <div class="res-head t-score">
      ${ring(score.pct / 100, 112, 10, `<b>${score.pct}%</b>`, 't-ring')}
      <div style="min-width:0">
        <p class="res-score mono"><span class="res-n">${score.correct}</span><small> of ${score.total} right</small></p>
        <p class="res-line">${esc(timeLine)}</p>
        ${trend ? `<p class="res-line muted">${esc(trend)}</p>` : ''}
        ${weakest ? `<p class="res-line muted">Weakest: ${esc(tagLabel(weakest.key))} (${weakest.pct}%).</p>` : ''}
      </div>
    </div>
    <div class="stats4">
      <div><div class="v">${clock(state.elapsed)}</div><div class="l">Time taken</div></div>
      <div><div class="v">${avgTime ? clock(avgTime) : '–'}</div><div class="l">Per answer</div></div>
      <div><div class="v">${score.unanswered}</div><div class="l">Not answered</div></div>
      <div><div class="v">${flagged}</div><div class="l">Flagged</div></div>
    </div>
    <div class="res-actions">
      ${missed.length ? `<button class="btn primary" id="tDrill" type="button">Drill missed (${missed.length})</button>` : ''}
      <button class="btn ${missed.length ? 'ghost' : 'primary'}" id="tRetake" type="button">Retake these questions</button>
      <button class="btn ghost" id="tNewSet" type="button">New set of questions</button>
      <button class="btn ghost" id="tSetup" type="button">Change setup</button>
      <button class="btn ghost" id="tDone2" type="button">Done</button>
    </div>
    <div id="tSched" aria-live="polite">${run.cfg.counts ? '<p class="sched-note">Saving your answers to the schedule…</p>' : '<p class="sched-note">Practice only: your schedule and stats are unchanged.</p>'}</div>
    ${tags.length ? `<section class="t-sec"><h2>Score by tag</h2>${bars(tags.slice(0, SHOWN_TAGS), tagLabel)}
      ${tags.length > SHOWN_TAGS ? `<details class="t-more"><summary>Show all ${tags.length} tags</summary>${bars(tags.slice(SHOWN_TAGS), tagLabel)}</details>` : ''}
      ${tags.length === 1 && tags[0].key === UNTAGGED ? '<p class="note">These cards have no tags. Add tags in Browse to see where you are weak.</p>' : ''}</section>` : ''}
    ${subdecks.length > 1 ? `<section class="t-sec"><h2>Score by subdeck</h2>${bars(subdecks, rel)}</section>` : ''}
    <section class="t-sec">
      <div class="t-sec-h"><h2>Your answers</h2>
        <div class="chips" role="group" aria-label="Show">
          <button type="button" class="tchip" id="tAll" aria-pressed="true">All <small>${score.total}</small></button>
          <button type="button" class="tchip" id="tWrong" aria-pressed="false">Wrong only <small>${score.wrong}</small></button>
          ${flagged ? `<button type="button" class="tchip" id="tFlagged" aria-pressed="false">Flagged <small>${flagged}</small></button>` : ''}
        </div></div>
      <ol class="t-review" id="tReview">${qs.map((x, k) => reviewRow(x, k, score.per[k], state.flags[k])).join('')}</ol>
      <p class="muted" id="tNone" hidden>Nothing to show here.</p>
    </section>`;
  const filter = which => {
    for (const [id, name] of [['tAll', 'all'], ['tWrong', 'wrong'], ['tFlagged', 'flagged']]) $(id)?.setAttribute('aria-pressed', String(name === which));
    let shown = 0;
    document.querySelectorAll('#tReview > li').forEach(li => { const keep = which === 'all' || (which === 'wrong' ? li.dataset.ok === '0' : li.dataset.flag === '1'); li.hidden = !keep; if (keep) shown++; });
    $('tNone').hidden = shown > 0;
  };
  $('tAll').addEventListener('click', () => filter('all'));
  $('tWrong').addEventListener('click', () => filter('wrong'));
  $('tFlagged')?.addEventListener('click', () => filter('flagged'));
  $('tDrill')?.addEventListener('click', () => { launchStudy({ deckIds: [run.deckId], kind: 'ids', cardIds: missed, label: 'Drill missed' }); });
  $('tRetake').addEventListener('click', () => { const r = retakeRun(run); saveRun(r, newState(r)); renderTest(el, r.deckId); });
  $('tNewSet').addEventListener('click', async () => { $('tNewSet').disabled = true; if (!(await (await import('./mock-exam-sheet.js')).beginTest(run.deckId, run.cfg, { stay: true }))) $('tNewSet').disabled = false; else renderTest(el, run.deckId); });
  // (Start builds the test and draws it here: the address does not change, so there is no route change to do it.)
  $('tSetup').addEventListener('click', async () => (await import('./mock-exam-sheet.js')).openTestSheet(run.deckId, { onStart: id => renderTest(el, id) }));
  $('tDone2').addEventListener('click', () => { const id = run.deckId; stopTest(); clearSaved(); navReplace(`#/deck/${encodeURIComponent(id)}`); });
  if (fresh) {
    $('tResTitle').focus({ preventScroll: true });
    scrollTo(0, 0);
    drawSidebar();
    refreshBadge();
  }
  ensureHistory(run, state, score);
  if (run.cfg.counts) { if (pendingAnswers(run, state).length) await saveAnswers(run, state); else $('tSched').innerHTML = '<p class="sched-note">Saved to your schedule.</p>'; }
}

function reviewRow(x, k, res, flag) {
  const card = T.cards.get(x.cardId);
  const status = res.ok ? 'Correct' : res.answered ? 'Wrong' : 'Not answered';
  const given = res.answered ? esc(res.given) : '<i>Not answered</i>';
  return `<li class="t-item ${res.ok ? 'ok' : 'no'}" data-ok="${res.ok ? 1 : 0}" data-flag="${flag ? 1 : 0}">
    <div class="t-item-h"><span class="t-n mono">${k + 1}</span>
      <span class="t-badge ${res.ok ? 'ok' : 'no'}">${icon(res.ok ? 'check' : 'x')}<span>${status}</span></span>
      ${flag ? `<span class="t-flagmark">${icon('flag')}<span>Flagged</span></span>` : ''}
      <span class="t-kindtag">${KIND_LABEL[x.kind]}</span></div>
    <div class="m">${mathHTML(x.prompt)}</div>
    ${x.occ && card ? `<div class="occ-mini">${occlusionHTML(card, 'back', { zoom: false })}</div>` : ''}
    ${x.kind === 'tf' ? `<div class="t-line"><span>Statement</span> <span>${mathHTML(x.shown)}</span></div>` : ''}
    <div class="t-line ${res.ok ? 'ok' : 'no'}"><span>Your answer</span> <span>${x.kind === 'tf' && res.answered ? esc(res.given) : res.answered && x.kind !== 'mc' ? esc(res.given) : res.answered ? mathHTML(res.given, { inline: true }) : given}</span></div>
    ${res.ok ? '' : `<div class="t-line r"><span>Correct answer</span> <span>${mathHTML(correctText(x))}</span></div>`}
  </li>`;
}
