// The Play tab: timed game rounds, ported from Kanji Sprint and adapted for any deck.
//   Formats:   Classic (set number of questions), Survival (3 lives, shrinking timer), Lightning (60s total)
//   Questions: Front → pick the back, Back → pick the front, Typing
//   Extras:    Hard (6 options, lookalike traps, −50 for wrong, ×1.25), Flash (prompt vanishes, ×1.2)
// The rules themselves (scoring, timers, wrong options) live in game.js.
// Play is practice only by default: nothing is saved to the review log or the schedule. With the synced setting
// "Count Play answers as reviews" on, every answer is saved to the log (source 'play') and feeds the review
// schedule following the auto-grading rules in autograde.js.

import * as db from './db.js';
import { loneIds, unpaired } from './reverse.js';
import {
  questionFor, isFrontOnly, playableCards, canMultipleChoice, pickDistractors, weightedQueue, timeLimit, scoreAnswer,
  gradeFor, bestKey, shuffle, defaultQuestionType, canOverride, overrideEntry, roundStats, LIGHTNING_MS, PENALTY_MS, LIVES, TYPING_TIME
} from './game.js';
import { autoRating, scheduleDecision, applies, appliedRating, speedProfiles, speedKey, playCountsAsReviews, playLogRow } from './autograde.js';
import { daysAgoStart } from './stats-calc.js';
import { deckSchedulerOptions, usesFsrs7 } from './sched-settings.js';
import { loadByDay } from './balance.js';
import { loadAll } from './study-data.js';
import { examOptions, examInfo, pickPlayDeck } from './exam.js';
import { newRoomFor, takeNewFor, giveBackNewFor } from './queue.js';
import { subtreeIds, deckChoices, deckPath, effectiveDeck } from './deck-tree.js';
import { isNewLeechCounted, markLeech } from './browse-logic.js';
import { openCardPanel } from './browse.js';
import { checkTyped, buildAnswerIndex, indexedMixup } from './match.js';
import { withAccepted, canAccept, addAccepted } from './accept.js';
import { plainText, mathHTML, answerText, answerTargets } from './format.js';
import { diffAgainstBack, diffHTML, hasMarks } from './answer-diff.js';
import { imgHTML, warmCards } from './media.js';
import { soundsHTML, stopSound } from './audio.js';
import { occlusionHTML } from './occlusion.js';
import { drawSidebar } from './sidebar.js';
import { refreshBadge } from './badge.js';
import { emptyStartHTML, wireEmptyStart } from './empty-state.js';
import { holdBack, releaseBack } from './nav.js';
import { $, esc, plural, toast, onControl, setFocusMode, openSheet, closeSheet, icon, foldOpen, saveFold } from './ui.js';
import * as fx from './fx.js';

const FORMATS = { classic: 'Classic', survival: 'Survival', lightning: 'Lightning' };
const QTYPES = { front: 'Front → back', back: 'Back → front', typing: 'Typing' };
// qtypeByDeck remembers the question type you picked for each deck. Play is one deck (and its subdecks) per game: no 'all'.
const DEFAULT_PREFS = { deckId: '', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20, qtypeByDeck: {} };

let G = null;      // the round in progress
let data = null;   // decks, cards and settings loaded for the setup screen
// Has the deck been picked in this visit? Until it has, Play opens on the deck with the nearest exam (see defaultDeck).
let deckChosen = false;
let customOpen = null;     // is the "Customise" fold open? (read from this device's saved choice the first time)

const fmtClock = ms => { const s = Math.ceil(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sizeClass = text => { const n = answerText(text).length; return n > 120 ? ' xlong' : n > 50 ? ' long' : ''; };      // measured as words, not as LaTeX

// Stop timers when a round is abandoned (leaving the tab, or quitting).
function stopRound() {
  setFocusMode(false);
  releaseBack('session');
  if (!G) return;
  cancelAnimationFrame(G.raf); clearTimeout(G.autoTimer); clearTimeout(G.flashTimer);
  G = null;
}

// Quit or Esc during a round: with answers to keep, ask first (Esc again or Enter ends it, and the results show the score so far).
// A round with no answers yet has nothing to keep, so it just closes.
function askEnd() {
  if (!G) return;
  if (!G.log.length) { const el = G.el; stopRound(); renderPlay(el); return; }
  $('endAsk').hidden = false;
  $('endYes').focus({ preventScroll: true });
}
function keepPlaying() {
  if (!G) return;
  $('endAsk').hidden = true;
  (G.qtype === 'typing' && !G.answered ? $('pInput') : $('pCard'))?.focus?.({ preventScroll: true });
}

// ---------- setup ----------
const playCopy = c => ({ ...c, front: plainText(c.front), back: plainText(c.back) });

export async function renderPlay(el) {
  stopRound();
  // Same data as Today and Review, so the exam's final pass (examCaps) and the new-card limits match theirs.
  const [{ settings, decks, cards: visible, logs, statesById, exam, newLeft }, everyCard, speedLogs] = await Promise.all([loadAll(), db.getAll('cards'), db.getLogsSince(daysAgoStart(60))]);
  // Your usual answer times per question type (speed relative to you, not the timer): the last 60 days of Play.
  // (Read before the check below: every wait comes first, so nothing can change the screen between the check and the drawing.)
  const speed = speedProfiles(speedLogs);
  // You already moved to another screen: don't draw (or start a round) there. Quit and Esc call this directly, so no router
  // catches it; drawing into a box that left the page would wire $('customBtn') & co. to elements that are not there.
  if (!el.isConnected) return;
  // Play works on plain-text copies (no bold or list marks), so options and typed answers compare cleanly.
  // Anything saved back (leeches, Card ⋯) uses the real card from the database instead.
  // (loadAll leaves out suspended cards, and cards buried until tomorrow.)
  // A card with a pair's noteId but no partner plays as an ordinary card (reverse.js loneIds; suspended partners still count).
  const lone = loneIds(everyCard);
  const cards = visible.map(c => playCopy(lone.has(c.id) ? unpaired(c) : c));
  data = {
    settings, decks, cards, statesById,
    // Cards that an exam's final pass brings forward count as due today (see exam.js).
    examCaps: exam.caps,
    // Cards whose schedule Play already changed today (Play only changes each card once a day).
    playedToday: new Set(logs.filter(l => l.source === 'play' && l.applied).map(l => l.cardId)),
    // New cards still allowed today (overall and per deck), for decks with an exam, where Play starts new cards.
    // Only new cards really started today count (newLimits ignores Play answers that were only logged).
    newLeft,
    speed
  };
  const prefs = { ...DEFAULT_PREFS, ...(settings.playPrefs || {}) };
  // One deck per game. Opening Play: the deck with the nearest exam, else the one you used last, else the first deck.
  // A saved "All decks" (older versions) or a deleted deck becomes a real deck here, and is saved.
  const wanted = prefs.deckId;
  prefs.deckId = pickPlayDeck(decks, cards, prefs.deckId, { chosen: deckChosen });
  delete prefs.qtypeByDeck.all;
  if (settings.playPrefs && (wanted !== prefs.deckId && (wanted === 'all' || !decks.some(d => d.id === wanted)))) db.setSetting('playPrefs', { ...prefs });
  if (customOpen === null) customOpen = foldOpen('play-custom');
  let pace = settings.timer;

  const draw = () => {
    // A deck includes its subdecks.
    const inside = subtreeIds(decks, prefs.deckId);
    const pool = cards.filter(c => inside.has(c.deckId));
    // Your pick for this deck, or a sensible start: Back → front for definition-style decks.
    const picked = prefs.qtypeByDeck[prefs.deckId];
    prefs.qtype = picked || defaultQuestionType(pool);
    const suggested = !picked && prefs.qtype === 'back';
    // Cloze and image-occlusion cards can't be asked back → front, so with some in the deck that choice only needs the other cards to fit.
    const hasCloze = pool.some(isFrontOnly);
    const mcFront = canMultipleChoice(pool, 'front'), mcBack = canMultipleChoice(pool, 'back');
    const mcOk = mcFront && (mcBack || hasCloze);
    if (hasCloze && !mcBack && prefs.qtype === 'back') prefs.qtype = 'front';
    const typeCount = playableCards(pool, 'typing').length;
    if (!mcOk && prefs.qtype !== 'typing') prefs.qtype = 'typing';
    const best = settings.playBest?.[bestKey(prefs)];
    const typing = prefs.qtype === 'typing';
    const notes = [];
    if (prefs.fmt === 'survival') notes.push('Timer shrinks 3% a question, 2s floor.');
    if (typing) notes.push(`Typing gets ${TYPING_TIME}× time: ${Math.round(pace * TYPING_TIME)}s${prefs.fmt === 'survival' ? ' to start' : ''}.`);
    const paceName = pace <= 4 ? 'Sprint' : pace <= 7 ? 'Quick' : pace <= 10 ? 'Standard' : pace <= 14 ? 'Relaxed' : 'Easy';
    const radio = (name, value, label, checked, extra = '') =>
      `<label class="chip"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} ${extra}><span>${label}</span></label>`;

    // One line saying what's in "Customise", so the folded part is still visible at a glance.
    const timeText = prefs.fmt === 'lightning' ? '60 s clock' : `${pace}s ${prefs.fmt === 'survival' ? 'to start' : 'each'}`;
    const summary = [typing ? 'Typing' : QTYPES[prefs.qtype], prefs.hard ? 'Hard' : 'Normal', prefs.flash ? `Flash ${prefs.flash / 1000}s` : null,
      prefs.fmt === 'classic' ? `${prefs.len} questions` : null, timeText].filter(Boolean).join(' · ');
    const fmtDesc = { classic: 'Set length', survival: '3 lives', lightning: '60s clock' };

    el.innerHTML = `
      <div class="screen-head"><div><h1>Play</h1></div></div>

      ${!cards.length ? emptyStartHTML() : `
      <fieldset><legend>Deck</legend>
        <select id="pDeck" class="select" aria-label="Deck">
          ${deckChoices(decks).map(d => { const ids = subtreeIds(decks, d.id); return `<option value="${esc(d.id)}" ${d.id === prefs.deckId ? 'selected' : ''}>${esc(d.label)} (${cards.filter(c => ids.has(c.deckId)).length})</option>`; }).join('')}
        </select>
      </fieldset>

      <fieldset><legend>Format</legend>
        <div class="modes three">
          ${[['classic', `${prefs.len} Q`], ['survival', '<span class="hearts" aria-hidden="true">●●●</span>'], ['lightning', '<span class="clock">1:00</span>']].map(([v, ex]) => `
            <label class="mode"><input type="radio" name="fmt" value="${v}" ${prefs.fmt === v ? 'checked' : ''}>
              <span class="mode-ex">${ex}</span><span class="mode-name">${FORMATS[v]}</span><span class="mode-desc">${fmtDesc[v]}</span></label>`).join('')}
        </div>
      </fieldset>

      <div class="start-row">
        <button class="btn primary" type="button" id="startBtn">Start round</button>
        <span class="mode-best">${best ? `Best for this setup <b class="mono">${best.toLocaleString()}</b>` : 'No score for this setup yet'}</span>
      </div>

      <button class="fold-toggle" type="button" id="customBtn" aria-expanded="${customOpen}" aria-controls="customBody">
        <span>Customise</span><span class="muted small">${esc(summary)}</span>${icon('chevron')}</button>
      <div id="customBody" ${customOpen ? '' : 'hidden'}>
      <fieldset><legend>Question</legend>
        <div class="chips">
          ${radio('qtype', 'front', 'Front → pick the back', prefs.qtype === 'front', mcOk ? '' : 'disabled')}
          ${radio('qtype', 'back', 'Back → pick the front', prefs.qtype === 'back', mcOk && mcBack ? '' : 'disabled')}
          ${radio('qtype', 'typing', 'Typing', typing, typeCount ? '' : 'disabled')}
        </div>
        ${(!mcOk || typing || suggested || (hasCloze && prefs.qtype !== 'front')) ? `<p class="note">${!mcOk ? 'Multiple choice needs 4+ cards with different answers.'
          : hasCloze && !typing && !suggested ? 'Cloze cards are always asked front → back.'
          : typing ? `${typeCount} of ${pool.length} cards fit typing (40 characters max).`
          : suggested ? 'Back → front suits this deck’s long answers.'
          : ''}</p>` : ''}
      </fieldset>

      <div class="settings">
        <fieldset><legend>Difficulty</legend>
          <div class="chips">${radio('diff', 'normal', 'Normal', !prefs.hard)}${radio('diff', 'hard', 'Hard', prefs.hard)}</div>
          ${prefs.hard ? '<p class="note">6 options, −50 per miss, ×1.25 points, no typo forgiveness.</p>' : ''}
        </fieldset>
        <fieldset><legend>Flash</legend>
          <div class="chips">${[0, 1200, 800, 500].map(f => radio('flash', f, f ? `${f / 1000}s` : 'Off', prefs.flash === f)).join('')}</div>
          ${prefs.flash ? `<p class="note">Question hides after ${prefs.flash / 1000}s. Points ×1.2.</p>` : ''}
        </fieldset>
      </div>

      <div class="settings">
        ${prefs.fmt === 'classic' ? `<fieldset><legend>Questions</legend>
          <div class="chips">${[10, 20, 40].map(n => radio('len', n, n, prefs.len === n)).join('')}</div></fieldset>` : ''}
        ${prefs.fmt === 'lightning' ? `<fieldset><legend>Clock</legend>
          <p class="lightning-note"><b>60 seconds</b> in all. A wrong answer costs <b>3s</b>.</p></fieldset>` : `
        <fieldset><legend id="paceLegend">${prefs.fmt === 'survival' ? 'Starting time per question' : 'Time per question'}</legend>
          <div class="slider-row">
            <input type="range" id="pace" min="3" max="20" step="1" value="${pace}" aria-labelledby="paceLegend">
            <output for="pace" class="mono" id="paceOut"><b>${pace}s</b> ${paceName}</output>
          </div>
          ${notes.length ? `<p class="note">${notes.join(' ')}</p>` : ''}
        </fieldset>`}
      </div>
      </div>

      <details class="how-score"><summary>ⓘ How scoring works</summary>
        <p>Right answer: <b>100</b> plus up to <b>100</b> for speed, times your streak (up to <b>×1.5</b>). Lightning’s clock pauses while you read an answer.</p>
        <p>${countsAsReviews() ? 'Answers on due cards count as their review, and so do new cards in a deck with an exam.' : "Practice only: answers here don't change when cards are due or your stats. Turn on 'Count Play answers as reviews' in Settings to change that."}</p></details>
      <p class="hint keys mono">Number keys to answer · Enter for next · Esc to quit</p>`}`;

    if (!cards.length) { wireEmptyStart(el); return; }
    const save = () => db.setSetting('playPrefs', { ...prefs });
    $('customBtn').addEventListener('click', () => {
      customOpen = $('customBtn').getAttribute('aria-expanded') !== 'true';
      $('customBtn').setAttribute('aria-expanded', String(customOpen));
      $('customBody').hidden = !customOpen;
      saveFold('play-custom', customOpen);
    });
    $('pDeck').addEventListener('change', e => { prefs.deckId = e.target.value; deckChosen = true; save(); draw(); });
    el.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener('change', () => {
      if (r.name === 'fmt') prefs.fmt = r.value;
      if (r.name === 'qtype') { prefs.qtype = r.value; prefs.qtypeByDeck = { ...prefs.qtypeByDeck, [prefs.deckId]: r.value }; }
      if (r.name === 'diff') prefs.hard = r.value === 'hard';
      if (r.name === 'flash') prefs.flash = +r.value;
      if (r.name === 'len') prefs.len = +r.value;
      save(); draw();
    }));
    $('pace')?.addEventListener('input', e => {
      pace = +e.target.value;
      const name = pace <= 4 ? 'Sprint' : pace <= 7 ? 'Quick' : pace <= 10 ? 'Standard' : pace <= 14 ? 'Relaxed' : 'Easy';
      $('paceOut').innerHTML = `<b>${pace}s</b> ${name}`;
    });
    $('pace')?.addEventListener('change', () => { db.setSetting('timer', pace); settings.timer = pace; draw(); });
    $('startBtn').addEventListener('click', () => { deckChosen = true; save(); start(el, { ...prefs, pace, pool }); });
  };
  draw();
}

// ---------- the round ----------
// opts: deckId, fmt, qtype, hard, flash, len, pace, pool (all cards in the chosen decks),
//       drill (optional list of cards to drill instead of the whole pool)
function start(el, opts) {
  const all = playableCards(opts.pool, opts.qtype);         // every card that works for this question type
  const pool = opts.drill ? playableCards(opts.drill, opts.qtype) : all;
  const fmt = opts.drill ? 'classic' : opts.fmt;
  const total = fmt === 'classic' ? (opts.drill ? Math.max(pool.length * 2, 6) : opts.len) : null;
  // Cards you've forgotten before (lapses) come up more often.
  const weightOf = c => { const s = data.statesById.get(c.id); return 1 + 2 * Math.min(s?.lapses || 0, 5); };
  G = {
    ...opts, fmt, all, pool, total, weightOf, source: opts.pool,
    queue: weightedQueue(pool, total || 30, weightOf), i: 0,
    score: 0, streak: 0, bestStreak: 0, log: [], leeches: [], lives: LIVES, clock: LIGHTNING_MS, over: false,
    answered: false, raf: 0, autoTimer: 0, flashTimer: 0,
    saving: Promise.resolve()          // answers are saved one after another in the background
  };
  G.mixIndex = buildAnswerIndex(all, c => { const a = questionFor(c, 'typing')?.answer; return a ? answerTargets(a) : []; }, MIX_SCAN_MAX);
  setFocusMode(true);
  holdBack('session', askQuit);        // Back (an edge swipe) asks before leaving a running round
  el.innerHTML = `
    <div class="hud mono">
      <span id="hudA"></span>
      <span>Score <b id="score">0</b></span>
      <span id="streakWrap">Streak <b id="streak">0</b></span>
      <button class="link" id="quitBtn" type="button">Quit</button>
    </div>
    <div class="end-ask" id="endAsk" role="alertdialog" aria-labelledby="endAskT" hidden>
      <p id="endAskT">End this round? Your score so far is kept in the results.</p>
      <div class="end-ask-b"><button class="btn primary small" id="endYes" type="button">End round</button><button class="btn ghost small" id="endNo" type="button">Keep playing</button></div>
    </div>
    <p class="prompt" id="pLabel"></p>
    <div class="flash play-card" id="pCard">
      <div class="flash-front" id="pPrompt"></div>
      <span class="flash-q mono" id="flashQ" hidden>gone</span>
    </div>
    <div class="timer" aria-hidden="true"><div class="timer-fill" id="pTimer"></div></div>
    <div class="options" id="options"></div>
    <form class="typeform" id="pType" hidden autocomplete="off">
      <input id="pInput" type="text" maxlength="500" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Your answer" placeholder="Type the answer">
      <button class="btn primary" type="submit">Check</button>
      <button class="btn ghost" type="button" id="skipBtn">Skip</button>
    </form>
    <div class="feedback" id="feedback" aria-live="polite"></div>`;
  $('quitBtn').addEventListener('click', askEnd);
  $('endYes').addEventListener('click', finish);
  $('endNo').addEventListener('click', keepPlaying);
  $('options').addEventListener('click', e => { const b = e.target.closest('.opt'); if (b && !G.answered) answer(+b.dataset.i); });
  $('pType').addEventListener('submit', e => { e.preventDefault(); if (!G.answered) answer($('pInput').value); });
  $('skipBtn').addEventListener('click', () => { if (!G.answered) answer(''); });
  G.el = el;
  showQuestion();
}

function updateHud(penalty) {
  let a;
  if (G.fmt === 'classic') a = `Q <b>${Math.min(G.i + 1, G.total)}</b>/${G.total}`;
  else if (G.fmt === 'survival') a = `<span class="lives" aria-label="${G.lives} of ${LIVES} lives left">${'●'.repeat(G.lives)}<span class="lost">${'●'.repeat(LIVES - G.lives)}</span></span>Q <b>${G.i + 1}</b>`;
  else a = `<span id="clockWrap">Time <b id="hudClock">${fmtClock(G.clock)}</b></span>${penalty ? '<span class="penalty">−3s</span>' : ''}`;
  $('hudA').innerHTML = a + (G.hard ? ' <span class="hardtag">Hard</span>' : '') + (G.flash ? ` <span class="hardtag">Flash ${G.flash / 1000}s</span>` : '');
  const shown = +$('score').textContent.replace(/\D/g, '') || 0;
  $('score').textContent = G.score.toLocaleString();
  $('streak').textContent = G.streak;
  $('streakWrap').classList.toggle('streak-on', G.streak >= 3);
  fx.combo($('streakWrap'), G.streak);                  // flame tiers at x3, x5 and x10
  fx.score($('score'), shown, G.score);                 // the score counts up (the text is already the new total)
}

function showQuestion() {
  clearTimeout(G.autoTimer);
  if (G.i >= G.queue.length) G.queue.push(...weightedQueue(G.pool, 30, G.weightOf, Math.random, G.queue[G.i - 1]));
  const card = G.queue[G.i];
  if (!card) { finish(); return; }      // every card in the round was suspended, buried or deleted
  const q = questionFor(card, G.qtype);
  Object.assign(G, { card, q, answered: false });
  warmCards(G.queue.slice(G.i + 1, G.i + 4));        // the next cards' pictures, if this device lacks them
  updateHud();
  $('feedback').innerHTML = '';
  $('pCard').classList.remove('ok', 'no');
  if ($('pCard').getBoundingClientRect().top < 0) scrollTo(0, 0);   // scrolled down to Next last time
  $('pLabel').textContent = { front: 'Pick the matching answer', back: 'Which card is this?', typing: 'Type the answer' }[G.qtype];
  const p = $('pPrompt');
  p.className = `flash-front${sizeClass(q.prompt)}`;
  // The prompt side's picture, if it has one. An image-occlusion question is the picture with its highlighted box.
  stopSound();
  p.innerHTML = (q.occ ? occlusionHTML(card, 'front', { zoom: false }) : imgHTML(q.image)) + mathHTML(q.prompt) + soundsHTML(q.sounds);
  clearTimeout(G.flashTimer);
  $('flashQ').hidden = true;
  if (G.flash) G.flashTimer = setTimeout(() => { if (!G?.answered) { $('pPrompt')?.classList.add('gone'); $('flashQ').hidden = false; } }, G.flash);

  const typing = G.qtype === 'typing';
  $('options').hidden = typing; $('pType').hidden = !typing;
  G.optIds = [];
  if (typing) {
    const inp = $('pInput');
    inp.value = ''; inp.disabled = false;
    inp.focus();
  } else {
    // Each option remembers which card it is the answer of, so picking another card's answer can be recorded as a
    // mix-up (log.mixedWith).
    const wrong = pickDistractors(card, G.all, G.qtype, { hard: G.hard, withIds: true });
    const items = shuffle([{ label: q.answer, id: card.id }, ...wrong]);
    G.opts = items.map(o => o.label); G.optIds = items.map(o => o.id);
    const long = G.opts.some(o => o.length > 28);
    $('options').className = `options${G.opts.length > 4 ? ' six' : ''}${long ? ' long' : ''}`;
    $('options').innerHTML = G.opts.map((o, i) =>
      `<button type="button" class="opt" data-i="${i}"><span class="key">${i + 1}</span><span class="lbl">${mathHTML(o, { inline: true })}</span></button>`).join('');
  }
  G.limit = timeLimit({ fmt: G.fmt, pace: G.pace, typing, i: G.i });
  G.qStart = performance.now();
  $('pTimer').classList.remove('low');
  cancelAnimationFrame(G.raf);
  G.raf = requestAnimationFrame(tick);
}

function tick(now) {
  const fill = $('pTimer');
  if (!G || !fill) return;               // left the screen
  if (G.fmt === 'lightning') {
    const rem = G.clock - (now - G.qStart);
    const f = Math.max(0, rem) / LIGHTNING_MS;
    fill.style.transform = `scaleX(${f})`;
    fill.classList.toggle('low', f < 0.3);          // the last 30%: the bar thickens and throbs (styles.css)
    const c = $('hudClock'); if (c) c.textContent = fmtClock(rem);
    $('clockWrap')?.classList.toggle('clock-low', rem < 10000);
    if (rem <= 0) { timeUp(); return; }
  } else {
    const f = Math.min(1, (now - G.qStart) / G.limit);
    fill.style.transform = `scaleX(${1 - f})`;
    fill.classList.toggle('low', f > 0.7);
    if (f >= 1) { answer(null); return; }
  }
  G.raf = requestAnimationFrame(tick);
}

// Lightning clock ran out mid-question: that question doesn't count.
function timeUp() {
  if (G.answered) return;
  G.answered = true; G.over = true; G.clock = 0;
  cancelAnimationFrame(G.raf); reveal();
  $('pInput').disabled = true;
  document.querySelectorAll('#options .opt').forEach(b => { b.disabled = true; b.classList.add('dim'); });
  updateHud();
  $('feedback').innerHTML = `<div class="fb no"><span class="fb-mark">Time's up</span></div><p class="fb-info">${G.log.filter(l => l.ok).length} right in 60 seconds.</p>`;
  later(finish, 1100);
}

// Run fn after ms, unless the round is paused meanwhile (askQuit puts the wait back when you keep playing).
function later(fn, ms) {
  clearTimeout(G.autoTimer);
  G.autoFn = fn; G.autoAt = performance.now() + ms;
  G.autoTimer = setTimeout(() => { if (G) G.autoFn = null; fn(); }, ms);
}

function reveal() {
  clearTimeout(G.flashTimer);
  $('pPrompt').classList.remove('gone');
  $('flashQ').hidden = true;
}

// choice: an option number, typed text, '' for skip, or null for out of time.
function answer(choice) {
  if (!G || G.answered) return;
  G.answered = true;
  cancelAnimationFrame(G.raf);
  reveal();
  const elapsed = performance.now() - G.qStart;
  const lightning = G.fmt === 'lightning';
  const seconds = (lightning ? elapsed : Math.min(elapsed, G.limit)) / 1000;
  let ok = false, given = '', exact = true, target = '', mixedWith;
  if (G.qtype === 'typing') {
    $('pInput').disabled = true;
    // Answers the person asked to accept ("Accept this answer from now on") count too, when the question asks for the card's back.
    const targets = answerTargets(G.q.answer);
    if (choice !== null) { given = choice; const res = checkTyped(choice, G.q.answer === G.card.back ? withAccepted(targets, G.card) : targets, { forgiving: !G.hard }); ok = res.correct; exact = res.exact; target = res.target; if (!ok) mixedWith = typedMixup(choice); }
  } else {
    if (choice !== null) {
      given = G.opts[choice]; ok = given === G.q.answer;
      const other = G.optIds[choice];
      if (!ok && other && other !== G.card.id) mixedWith = other;       // the answer of another card
    }
    document.querySelectorAll('#options .opt').forEach((b, j) => {
      b.disabled = true;
      if (G.opts[j] === G.q.answer) b.classList.add('correct');
      else if (j === choice) b.classList.add('wrong');
      else b.classList.add('dim');
    });
  }

  const { pts, speed, mult } = scoreAnswer({ ok, seconds, limitMs: G.limit, fmt: G.fmt, streak: G.streak, hard: G.hard, flash: G.flash, score: G.score });
  G.score += pts;
  if (ok) { G.streak++; G.bestStreak = Math.max(G.bestStreak, G.streak); } else G.streak = 0;

  let extra = '';
  if (lightning) {
    G.clock -= elapsed;                  // the clock only runs while a question is showing
    if (!ok) G.clock -= PENALTY_MS;
    if (G.clock <= 0) { G.clock = 0; G.over = true; }
  } else if (G.fmt === 'survival' && !ok) {
    G.lives--;
    extra = G.lives > 0 ? ` · ${G.lives} ${G.lives === 1 ? 'life' : 'lives'} left` : ' · Out of lives';
    if (G.lives <= 0) G.over = true;
  } else if (G.fmt === 'classic' && G.i >= G.total - 1) G.over = true;

  // Typing: which letters were wrong (for a wrong answer, and for a right one that needed forgiving). Lightning stays quick.
  let diff = G.qtype === 'typing' && given.trim() && !exact && !(lightning && ok) ? diffAgainstBack(given, target) : null;
  if (diff && ok && !hasMarks(diff)) diff = null;
  const entry = { card: G.card, q: G.q, ok, seconds, mixedWith, at: Date.now(), ms: Math.round(elapsed), limitMs: G.limit, speed, given: choice === null ? null : given,
    typed: diff ? given : undefined, target: diff ? target : undefined,
    chars: answerText(G.q.prompt).length + (G.qtype === 'typing' ? 0 : G.opts.reduce((n, o) => n + answerText(o).length, 0)) + (G.q.occ ? 60 : 0) };     // text read, for speed relative to you (a picture question gets a fixed allowance)
  G.log.push(entry);
  // Save in the background so the game never waits for the database.
  const round = G;
  G.saving = G.saving.then(() => record(round, entry)).catch(err => console.error('Could not save answer', err));
  updateHud(lightning && !ok);
  $('pCard').classList.add(ok ? 'ok' : 'no');

  const head = ok
    ? `<div class="fb ok"><span class="fb-mark">${icon('check')} Correct</span><span class="fb-pts mono">+${pts}</span><span class="fb-detail mono">${seconds.toFixed(1)}s${mult > 1 ? ' · ×' + mult.toFixed(1) + ' streak' : ''}</span></div>`
    : `<div class="fb no"><span class="fb-mark">${choice === null ? 'Out of time' : choice === '' ? 'Skipped' : 'Not quite'}${lightning ? ' · −3s' : ''}${extra}</span>${pts < 0 ? `<span class="fb-minus mono">${pts}</span>` : ''}</div>`;
  const yours = !ok && given && !diff ? `<span class="given">You answered: ${esc(given)}</span>` : '';
  const info = ok || diff ? '' : `<p class="fb-info"><b>${mathHTML(G.q.answer)}</b>${yours}</p>`;
  // A wrong typed answer can be corrected: "I was right" (Lightning moves on by itself, so it has these on the results instead).
  const fixable = !lightning && canOverride(round, entry);
  $('feedback').innerHTML = `${head}${info}${diff ? diffHTML(diff) : ''}<div class="fb-btns">
    <button type="button" class="btn ${ok ? 'ghost' : 'primary'}" id="nextBtn">${G.over ? 'See results' : 'Next'} <span class="mono">${icon('enter')}</span></button>
    ${fixable ? '<button type="button" class="btn ghost" id="rightBtn">I was right</button>' : ''}
    <button type="button" class="btn ghost" id="cardBtn" aria-label="Card actions: edit, flag, suspend, bury and more">Card ${icon('more')}</button></div>`;
  $('nextBtn').addEventListener('click', next);
  $('cardBtn').addEventListener('click', openCardMenu);
  $('rightBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const fixed = await markRight(round, entry);
    if (!fixed) { btn.disabled = false; return; }
    if (G !== round || !$('rightBtn')) return;                     // moved on while it saved
    const fb = $('feedback').querySelector('.fb');
    fb.className = 'fb ok'; fb.innerHTML = `<span class="fb-mark">${icon('check')} Counted as right</span>`;
    $('pCard').classList.replace('no', 'ok');
    const acc = canAcceptTyped(fixed) ? `<button type="button" class="btn ghost" id="acceptBtn">Accept “${esc(fixed.given.trim())}” from now on</button>` : '';
    btn.outerHTML = acc;
    $('acceptBtn')?.addEventListener('click', async e2 => { e2.currentTarget.disabled = true; if (await acceptTyped(round, fixed)) $('acceptBtn')?.remove(); else $('acceptBtn') && ($('acceptBtn').disabled = false); });
  });
  if (lightning) later(next, ok ? 280 : 900);
  else if (ok) later(next, G.over ? 900 : diff ? 1600 : 750);
  else {
    $('nextBtn').focus({ preventScroll: true });
    // Long answers can push the Next button below the screen, so bring it into view.
    $('nextBtn').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// A wrong typed answer that is exactly (no typo forgiveness) the answer of another card of this round's pool: that card's
// id. Siblings of the same note don't count (their answers are on this card's front). The look-through is capped.
// The index is built once when the round starts (G.mixIndex), so a wrong answer is one lookup.
const MIX_SCAN_MAX = 2000;
function typedMixup(typed) {
  if (!String(typed).trim()) return undefined;          // a skip
  return indexedMixup(G.mixIndex, typed, G.card);
}

// Does Play count as reviews? (Settings, synced; off by default: Play is practice only.)
const countsAsReviews = () => playCountsAsReviews(data?.settings);

// Save one answer (only when Play counts as reviews, see above): always to the review log (source 'play', so stats and a
// future FSRS optimizer can tell it from a Review), and to the review schedule when the auto-grading rules allow it (see autograde.js).
async function record(round, entry) {
  // Practice only (the default, Settings > "Count Play answers as reviews" off): nothing is saved. No schedule or FSRS
  // change, no review-log row (so no stats, heatmap, streak, readiness or Today ring), no new card started, no leech.
  // The round's own score, bests and results come from the round itself, not from the log.
  if (!countsAsReviews()) { entry.decision = 'practice'; return; }
  const id = entry.card.id;
  const now = Date.now();
  const chars = entry.chars ?? 0;
  let rating = autoRating({ ok: entry.ok, ms: entry.ms, limitMs: entry.limitMs, typing: round.qtype === 'typing',
    speed: data.speed.get(speedKey(round.qtype, round.hard)), chars });
  const prev = data.statesById.get(id);
  // A new card in a deck with an exam coming up (its own or a parent's) is started by Play: this answer is its
  // first review. That uses up one of today's new cards. Over the deck's new-card limit (overall, the deck's own
  // and its parents'), it's only logged and starts in Review as before.
  const examDeck = !!examInfo(effectiveDeck(data.decks, entry.card.deckId), now);
  const newRoom = newRoomFor(data.newLeft, entry.card.deckId);
  const cap = data.examCaps.get(id);
  const dueState = prev && cap !== undefined ? { ...prev, due: Math.min(prev.due, cap) } : prev;
  // Out of time (not a wrong answer) with Survival's timer at under 3 seconds is logged only.
  let decision = scheduleDecision({ state: dueState, rating, alreadyToday: data.playedToday.has(id), now, examDeck, newRoom,
    timedOut: entry.given === null, limitMs: entry.limitMs, fmt: round.fmt });
  rating = appliedRating({ decision, rating, mc: round.qtype !== 'typing', overridden: !!entry.overridden });
  if (decision === 'first') takeNewFor(data.newLeft, entry.card.deckId);
  const log = playLogRow({ cardId: id, now, qtype: round.qtype, fmt: round.fmt, hard: round.hard, ok: entry.ok, ms: entry.ms, rating, chars,
    prevState: prev ? prev.state : 0, decision, mixedWith: entry.mixedWith, overridden: entry.overridden });
  entry.prev = prev;                      // kept with the log row's id, so "I was right" can take this answer back (see rerecord)
  if (applies(decision)) {
    let next = null;
    try {
      const { rate, prepare7 } = await import('./srs.js');     // the FSRS library, loaded on demand
      if (usesFsrs7(data.settings)) await prepare7([prev], db.getCardLogs);     // FSRS-7 (beta): the card's memory, rebuilt from its history the first time
      const deck = effectiveDeck(data.decks, entry.card.deckId);     // with what it inherits from its parent decks
      // The deck's own settings (or the overall ones), its exam limits, and evening out the reviews.
      data.balance ||= { load: loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays };
      next = rate(id, prev, rating, { ...examOptions(deckSchedulerOptions(data.settings, deck), deck, now), balance: data.balance }, now);
    } catch (err) {
      // Scheduling library not available (e.g. offline before it was ever downloaded): keep the answer for stats.
      console.error(err);
      if (decision === 'first') { giveBackNewFor(data.newLeft, entry.card.deckId); decision = 'new'; }    // not started: slot back
      else decision = 'not-due';
      log.reason = decision;
      entry.logId = await db.addLog(log);
    }
    // Saving is outside the try, so an error after the review is saved can't add the same answer a second time.
    if (next) {
      log.applied = true;
      entry.logId = await db.saveReview(next, log);
      entry.applied = true;
      data.statesById.set(id, next);
      data.playedToday.add(id);
      entry.leeched = await checkLeech(round, entry.card, prev, next, log);       // what it changed, so "I was right" can undo a leech
    }
  } else {
    entry.logId = await db.addLog(log);
  }
  entry.rating = rating;
  entry.decision = decision;
}

// ---------- "I was right" and "Accept this answer from now on" ----------
// Is the card as it was when the question was asked? (Edited or deleted from Card ⋯ meanwhile: then nothing is fixed.)
async function sameCard(entry) {
  const card = await db.get('cards', entry.card.id);
  if (!card || plainText(card.front) !== entry.card.front || plainText(card.back) !== entry.card.back) { toast('That card changed; nothing to fix.'); return null; }
  return card;
}

// A typed answer the check marked wrong was right: count it right in the round (accuracy, grade, Missed list). The score,
// streak, lives and clock stay as they were. With "Count Play answers as reviews" on, the schedule and the stats are fixed too.
// Returns the corrected entry, or null when nothing changed.
async function markRight(round, entry) {
  if (!canOverride(round, entry) || !(await sameCard(entry))) return null;
  const i = round.log.indexOf(entry);
  if (i < 0) return null;
  const fixed = overrideEntry(round, entry);
  round.log[i] = fixed;
  round.saving = round.saving.then(() => rerecord(round, entry, fixed)).catch(err => console.error('Could not fix the answer', err));
  await round.saving;
  return fixed;
}

// Take the saved wrong answer back and save it again as a right one (with overridden: true on its log row). Runs after the
// answer was saved (round.saving is a queue). In practice mode (the default) nothing was saved, so there is nothing to do.
async function rerecord(round, old, fixed) {
  for (const k of ['logId', 'prev', 'applied', 'decision', 'rating']) delete fixed[k];       // (the copy still carries the old save)
  if (old.decision === 'practice' || old.decision === undefined) { if (old.decision) fixed.decision = old.decision; return; }
  const id = old.card.id;
  if (old.logId !== undefined) {
    if (old.applied) {
      await db.undoReview(id, old.prev, old.logId);          // the old schedule back, and the log row gone
      if (old.prev) data.statesById.set(id, old.prev); else data.statesById.delete(id);
      data.playedToday.delete(id);
      if (old.decision === 'first') giveBackNewFor(data.newLeft, old.card.deckId);
    } else {
      await db.deleteLogRow(old.logId);                      // it was only logged
    }
  }
  if (old.leeched) await undoLeech(round, old);
  await record(round, fixed);
}

// The wrong answer made the card a leech: put its tags and suspended flag back as they were, and take it off the round's leech list.
async function undoLeech(round, old) {
  const was = old.leeched, cur = await db.get('cards', old.card.id);
  if (cur && (cur.tags || []).includes('leech')) {
    const { suspended, ...rest } = cur;
    const back = { ...rest, tags: was.tags || [], ...(was.suspended ? { suspended: true } : {}) };
    if (!was.tags) delete back.tags;
    await db.saveCards([back]);
    replaceInRound(round, playCopy(back));
    if (!round.all.some(c => c.id === back.id)) { round.all.push(playCopy(back)); round.pool.push(playCopy(back)); }      // a suspended leech had been dropped from the round
  }
  if (!was.wasListed) round.leeches = round.leeches.filter(id => id !== old.card.id);
}

// Can "Accept “…” from now on" be offered for this entry? The typed text must fit, not be accepted yet, and the question must
// ask for the card's back (an answer to the front of a reverse card, or to a step card's last step, is not the back).
const canAcceptTyped = entry => typeof entry.given === 'string' && entry.q.answer === entry.card.back && canAccept(entry.card, entry.given);

// Save the typed text on the card as an accepted answer. Returns true when it was saved.
async function acceptTyped(round, entry) {
  const card = await sameCard(entry);
  if (!card) return false;
  if (!canAccept(card, entry.given)) { toast('That answer is already accepted.'); return true; }
  const saved = addAccepted(card, entry.given);
  await db.saveCards([saved]);
  replaceInRound(round, playCopy(saved));              // the rest of the round (and "Play again") accepts it
  entry.card = round.card?.id === saved.id ? round.card : playCopy(saved);
  toast('Accepted for this card');
  return true;
}

// Forgotten too many times? Same as Review: tag it "leech", and suspend it unless Settings says tag only.
async function checkLeech(round, card, prev, next, log) {
  // A miss on a card that wasn't due still brings it back, but doesn't count toward the leech limit.
  if (log.reason === 'again' || next.lapses <= (prev?.lapses || 0)) return null;
  if (!isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(card.id), data.settings.leechThreshold)) return null;
  const before = (await db.get('cards', card.id)) || card;
  const leech = markLeech(before, data.settings.leechAction);
  await db.saveCards([leech]);
  const wasListed = round.leeches.includes(card.id);
  if (!wasListed) round.leeches.push(card.id);
  if (leech.suspended) dropFromRound(round, card.id); else replaceInRound(round, playCopy(leech));
  toast(leech.suspended ? 'Leech: you keep forgetting this card, so it’s been suspended' : 'Leech: you keep forgetting this card (tagged “leech”)');
  return { tags: before.tags, suspended: before.suspended, wasListed };      // the card as it was before it became a leech
}

// Take a card out of the rest of the round (suspended, buried or deleted), or swap in its edited version.
function dropFromRound(round, id) {
  const keep = c => c.id !== id;
  round.queue = [...round.queue.slice(0, round.i + 1), ...round.queue.slice(round.i + 1).filter(keep)];
  round.pool = round.pool.filter(keep);
  round.all = round.all.filter(keep);
}
function replaceInRound(round, card) {
  const swap = c => (c.id === card.id ? card : c);
  round.queue = round.queue.map(swap); round.pool = round.pool.map(swap); round.all = round.all.map(swap);
  if (round.source) round.source = round.source.map(swap);        // (what "Play again" starts from)
  if (round.card?.id === card.id) round.card = card;
}

// The "Card ⋯" button after answering: the same card panel as the card list. Pauses the auto "Next".
async function openCardMenu() {
  if (!G?.answered) return;
  clearTimeout(G.autoTimer);
  const round = G;
  openCardPanel((await db.get('cards', round.card.id)) || round.card, {
    decks: data.decks, statesById: data.statesById, mode: 'actions',
    closeAfter: ['suspend', 'bury', 'delete', 'reset', 'due', 'edit', 'flag', 'move', 'unsuspend', 'unbury'],
    onAction: (act, fresh) => {
      if (['suspend', 'bury', 'delete'].includes(act) || !fresh) dropFromRound(round, round.card.id);
      else replaceInRound(round, playCopy(fresh));
    }
  });
}

function next() {
  if (!G || !G.answered || !$('pCard')) return;
  clearTimeout(G.autoTimer);
  if (G.over) { finish(); return; }
  G.i++;
  showQuestion();
}

// ---------- results ----------

// One line on the results screen saying how the round changed the review schedule.
async function scheduleSummary(round) {
  await round.saving;                          // wait for the last answers to finish saving
  const count = d => new Set(round.log.filter(l => l.decision === d).map(l => l.card.id)).size;
  const graded = count('due'), sentBack = count('again'), started = count('first'), fresh = count('new'), over = count('new-limit');
  if (!round.log.length) return '';
  if (!countsAsReviews()) return '<p class="sched-note">Practice only: your schedule and stats are unchanged.</p>';
  const parts = [];
  if (graded) parts.push(`<b>${plural(graded, 'due card')}</b> graded`);
  if (sentBack) parts.push(`<b>${plural(sentBack, 'missed card')}</b> brought back`);
  // New cards in a deck with an exam are started by Play (autograde.js).
  if (started) parts.push(`<b>${plural(started, 'new card')}</b> started (exam deck)`);
  const text = parts.length
    ? `Schedule updated: ${parts.join(', ')}.`
    : 'No cards were due: schedule unchanged.';
  const extra = (fresh ? ` ${plural(fresh, 'new card')} ${fresh === 1 ? 'starts' : 'start'} in Review.` : '')
    + (over ? ` ${plural(over, 'new card')} over today’s new-card limit ${over === 1 ? 'starts' : 'start'} in Review.` : '');
  return `<p class="sched-note">${text}${extra}</p>`;
}

async function finish() {
  if (!G || !$('pCard')) return;
  clearTimeout(G.autoTimer); cancelAnimationFrame(G.raf); clearTimeout(G.flashTimer);
  const el = G.el, round = G;
  G = null;
  releaseBack('session');
  setFocusMode(false);
  drawSidebar();          // the sidebar's counts and ring, now the round is done
  refreshBadge();         // and the number on the app icon (badge.js)
  let isBest = false, firstScore = false;
  if (!round.drill && round.log.length) {
    const settings = await db.getSettings();
    const bests = { ...(settings.playBest || {}) };
    const k = bestKey(round);
    if (round.score > (bests[k] || 0)) { firstScore = !bests[k]; bests[k] = round.score; isBest = true; await db.setSetting('playBest', bests); }
  }
  await drawResults(el, round, { isBest, firstScore, fixed: new Set(), all: false });
}

// The results screen. ctx: { isBest, firstScore, fixed (answers corrected with "I was right" on this screen, which stay in
// the Missed list so they can be accepted), all (the whole Missed list is open) }. Drawn again after each correction.
async function drawResults(el, round, ctx, { again = false } = {}) {
  const { total, correct, accuracy: acc, avgSpeed, avgTime } = roundStats(round.log);
  const { letter, label } = gradeFor(acc, avgSpeed);
  const { isBest, firstScore } = ctx;
  const seen = new Set();
  const listed = round.log.filter(l => (!l.ok || ctx.fixed.has(l)) && !seen.has(l.card.id) && seen.add(l.card.id));
  const missed = listed.filter(l => !l.ok);
  const deckName = deckPath(data.decks, round.deckId);
  const schedule = await scheduleSummary(round);
  // You may have switched to another screen while that saved: don't draw over it.
  // (The box must still be on the page too: Play may have been left and opened again, which draws into a new box.)
  if (!el.isConnected || !location.hash.startsWith('#/play')) return;
  const line = round.fmt === 'survival' ? `Survived ${plural(total, 'question')}.`
    : round.fmt === 'lightning' ? `${plural(correct, 'right answer')} in 60 seconds.` : '';

  const strong = 'SAB'.includes(letter);          // the big stamp is for S, A and B; a C or D gets a quiet one
  const gradeText = isBest ? `Grade ${letter}` : label;
  // Under a wrong typed answer: "I was right"; after it, "Counted as right" and Accept (shown when the typed text can be added).
  const fixRow = l => {
    const i = round.log.indexOf(l);
    if (canOverride(round, l)) return `<div class="miss-fix"><button class="btn ghost small" type="button" data-right="${i}">I was right</button></div>`;
    if (!ctx.fixed.has(l)) return '';
    return `<div class="miss-fix"><span class="miss-ok">${icon('check')} Counted as right</span>${canAcceptTyped(l) ? `<button class="btn ghost small" type="button" data-accept="${i}">Accept “${esc(l.given.trim())}” from now on</button>` : ''}</div>`;
  };
  const missedRow = l => { const diff = l.typed ? diffAgainstBack(l.typed, l.target) : null; return `
        <div class="miss">
          <div class="m">${mathHTML(l.q.prompt)}</div>
          ${l.q.occ ? `<div class="occ-mini">${occlusionHTML(l.card, 'back', { zoom: false })}</div>` : ''}
          <div class="r">${mathHTML(l.q.answer)}</div>
          ${hasMarks(diff) ? diffHTML(diff, { small: true })
            : `<div class="y">${l.given === null ? 'Out of time' : l.given === '' ? 'Skipped' : `You answered: ${esc(l.given)}`}</div>`}
          ${fixRow(l)}
        </div>`; };
  const SHOWN = 3;
  const open = ctx.all ? Infinity : SHOWN;
  el.innerHTML = `
    <div class="res-head">
      <div class="stamp${again ? '' : ' press'}${strong ? '' : ' quiet'}" aria-label="Grade ${letter}"><span>${letter}</span></div>
      <div style="min-width:0">
        <p class="res-grade">${gradeText} · ${round.drill ? 'Drill' : FORMATS[round.fmt]}${round.hard ? ' (Hard)' : ''}${round.flash ? ` · Flash ${round.flash / 1000}s` : ''} · ${esc(deckName)}</p>
        <p class="res-score mono"><span class="res-n">${round.score.toLocaleString()}</span> <small>pts</small></p>
        ${line ? `<p class="res-line">${line}</p>` : ''}
        ${isBest ? `<p class="newbest">${firstScore ? 'First score for this setup' : 'New best for this setup'}</p>` : ''}
      </div>
    </div>
    <div class="stats4">
      <div><div class="v">${Math.round(acc * 100)}%</div><div class="l">Accuracy</div></div>
      <div><div class="v">${avgTime.toFixed(1)}s</div><div class="l">Avg answer time</div></div>
      <div><div class="v">${round.bestStreak}</div><div class="l">Best streak</div></div>
      <div><div class="v">${correct}/${total}</div><div class="l">Correct</div></div>
    </div>
    <div class="res-actions">
      <button class="btn primary" id="againBtn" type="button">Play again</button>
      ${missed.length ? '<button class="btn ghost" id="drillBtn" type="button">Drill missed</button>' : ''}
      <button class="btn ghost" id="menuBtn" type="button">Change setup</button>
    </div>
    ${schedule}
    <div id="resultsMore" class="finish-more" hidden></div>
    <section class="missed">
      <h2>Missed</h2>
      ${listed.length ? listed.map((l, i) => i < open ? missedRow(l) : `<div class="miss-extra" hidden>${missedRow(l)}</div>`).join('')
        + (listed.length > open ? `<button class="btn ghost" id="showAllMiss" type="button">Show all ${listed.length}</button>` : '')
      : `<p class="muted">${total ? 'Clean round. Nothing to review.' : 'No answers this round.'}</p>`}
    </section>`;
  $('showAllMiss')?.addEventListener('click', e => {
    ctx.all = true;
    el.querySelectorAll('.miss-extra').forEach(x => { x.hidden = false; });
    e.currentTarget.remove();
  });
  // Corrections: draw the screen again with the new numbers, staying where the page was.
  const redraw = async focusSel => {
    const y = scrollY;
    await drawResults(el, round, ctx, { again: true });
    scrollTo(0, y);
    if (focusSel) el.querySelector(focusSel)?.focus({ preventScroll: true });
  };
  el.querySelectorAll('[data-right]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    const fixed = await markRight(round, round.log[+b.dataset.right]);
    if (!fixed) { b.disabled = false; return; }
    ctx.fixed.add(fixed);
    redraw(`[data-accept="${b.dataset.right}"]`);
  }));
  el.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    if (await acceptTyped(round, round.log[+b.dataset.accept])) redraw(); else b.disabled = false;
  }));
  const slot = $('resultsMore'), cardIds = [...new Set(round.log.map(l => l.card.id))], leechIds = [...round.leeches], entries = round.log;
  if (!again) import('./finish-extras.js').then(m => m.drawFinishExtras(slot, { source: 'play', cardIds, leechIds, entries })).catch(err => console.error(err));
  const base = { deckId: round.deckId, fmt: round.fmt, qtype: round.qtype, hard: round.hard, flash: round.flash, len: round.len, pace: round.pace, pool: round.source };
  $('againBtn').addEventListener('click', () => start(el, round.drill ? { ...base, drill: round.drill } : base));
  $('drillBtn')?.addEventListener('click', () => start(el, { ...base, drill: missed.map(l => l.card) }));
  $('menuBtn').addEventListener('click', () => renderPlay(el));
  if (!again) { $('againBtn').focus({ preventScroll: true }); fx.result(el); }
}

// The back gesture during a round: ask, and keep playing unless they say Quit.
function askQuit() {
  if (!G || !$('pCard') || document.getElementById('sheet')?.open) return;
  // The round waits while the question is up: the clock (and a question's timer) stop, and so does an automatic "Next".
  const round = G, t0 = performance.now();
  cancelAnimationFrame(round.raf); clearTimeout(round.autoTimer);
  const wait = round.autoFn ? Math.max(0, round.autoAt - t0) : 0, fn = round.autoFn;
  openSheet(`
    <h2 id="sheetTitle">Quit this round?</h2>
    <p>Your score so far will be lost.</p>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="keepOn">Keep playing</button>
      <button class="btn primary" type="button" id="quitNow">Quit round</button>
    </div>`);
  // However the question closes (Keep playing, ×, Back, Esc), the round carries on from where it stopped.
  $('sheet').addEventListener('close', () => {
    if (G !== round || !$('pCard')) return;
    if (!round.answered) {
      round.qStart += performance.now() - t0;           // the time spent asking doesn't count
      round.raf = requestAnimationFrame(tick);
    } else if (fn) later(fn, wait);
  }, { once: true });
  $('keepOn').addEventListener('click', closeSheet);
  $('quitNow').addEventListener('click', () => { closeSheet(); if (G) { const el = G.el; stopRound(); renderPlay(el); } });
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if (!G || !$('pCard') || e.ctrlKey || e.metaKey || e.altKey || document.getElementById('sheet')?.open) return;
  if ($('endAsk') && !$('endAsk').hidden) {
    // The question "End this round?" is open: Esc again or Enter ends it (Enter on "Keep playing" presses that button instead).
    if (e.key === 'Escape' || (e.key === 'Enter' && !onControl(e))) { e.preventDefault(); finish(); }
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); askEnd(); return; }
  if (G.answered) {
    if ((e.key === 'Enter' || e.key === ' ') && !onControl(e)) { e.preventDefault(); next(); }
    return;
  }
  if (G.qtype !== 'typing' && /^[1-6]$/.test(e.key) && +e.key <= G.opts.length) { e.preventDefault(); answer(+e.key - 1); }
});
