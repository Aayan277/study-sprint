// The Play tab: timed game rounds, ported from Kanji Sprint and adapted for any deck.
//   Formats:   Classic (set number of questions), Survival (3 lives, shrinking timer), Lightning (60s total)
//   Questions: Front → pick the back, Back → pick the front, Typing
//   Extras:    Hard (6 options, lookalike traps, −50 for wrong, ×1.25), Flash (prompt vanishes, ×1.2)
// The rules themselves (scoring, timers, wrong options) live in game.js.
// Every answer is saved to the review log, and feeds the review schedule following the
// auto-grading rules in autograde.js.

import * as db from './db.js';
import {
  questionFor, isFrontOnly, playableCards, canMultipleChoice, pickDistractors, weightedQueue, timeLimit, scoreAnswer,
  gradeFor, bestKey, shuffle, defaultQuestionType, LIGHTNING_MS, PENALTY_MS, LIVES, TYPING_TIME
} from './game.js';
import { autoRating, scheduleDecision, applies, appliedRating, speedProfiles, speedKey } from './autograde.js';
import { daysAgoStart } from './stats-calc.js';
import { deckSchedulerOptions } from './sched-settings.js';
import { loadByDay } from './balance.js';
import { loadAll } from './study-data.js';
import { examOptions, examInfo, pickPlayDeck } from './exam.js';
import { newRoomFor, takeNewFor, giveBackNewFor } from './queue.js';
import { subtreeIds, deckChoices, deckPath, effectiveDeck } from './deck-tree.js';
import { isNewLeechCounted, markLeech } from './browse-logic.js';
import { openCardPanel } from './browse.js';
import { checkTyped, buildAnswerIndex, indexedMixup } from './match.js';
import { plainText, mathHTML, answerText, answerTargets } from './format.js';
import { diffAgainstBack, diffHTML, hasMarks } from './answer-diff.js';
import { imgHTML } from './media.js';
import { occlusionHTML } from './occlusion.js';
import { drawSidebar } from './sidebar.js';
import { emptyStartHTML, wireEmptyStart } from './empty-state.js';
import { $, esc, plural, toast, onControl, setFocusMode, icon, foldOpen, saveFold } from './ui.js';
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
  if (!G) return;
  cancelAnimationFrame(G.raf); clearTimeout(G.autoTimer); clearTimeout(G.flashTimer);
  G = null;
}

// ---------- setup ----------
const playCopy = c => ({ ...c, front: plainText(c.front), back: plainText(c.back) });

export async function renderPlay(el) {
  stopRound();
  // Same data as Today and Review, so the exam's final pass (examCaps) and the new-card limits match theirs.
  const { settings, decks, cards: visible, logs, statesById, exam, newLeft } = await loadAll();
  if (!el.isConnected) return;           // you already moved to another screen: don't draw (or start a round) there
  // Play works on plain-text copies (no bold or list marks), so options and typed answers compare cleanly.
  // Anything saved back (leeches, Card ⋯) uses the real card from the database instead.
  // (loadAll leaves out suspended cards, and cards buried until tomorrow.)
  const cards = visible.map(playCopy);
  data = {
    settings, decks, cards, statesById,
    // Cards that an exam's final pass brings forward count as due today (see exam.js).
    examCaps: exam.caps,
    // Cards whose schedule Play already changed today (Play only changes each card once a day).
    playedToday: new Set(logs.filter(l => l.source === 'play' && l.applied).map(l => l.cardId)),
    // New cards still allowed today (overall and per deck), for decks with an exam, where Play starts new cards.
    // Only new cards really started today count (newLimits ignores Play answers that were only logged).
    newLeft,
    // Your usual answer times per question type (speed relative to you, not the timer): the last 60 days of Play.
    speed: speedProfiles(await db.getLogsSince(daysAgoStart(60)))
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
        <p>Answers on due cards count as their review, and so do new cards in a deck with an exam.</p></details>
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
  const total = fmt === 'classic' ? (opts.drill ? opts.drillTotal || Math.max(pool.length * 2, 6) : opts.len) : null;
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
  el.innerHTML = `
    <div class="hud mono">
      <span id="hudA"></span>
      <span>Score <b id="score">0</b></span>
      <span id="streakWrap">Streak <b id="streak">0</b></span>
      <button class="link" id="quitBtn" type="button">Quit</button>
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
  $('quitBtn').addEventListener('click', () => { stopRound(); renderPlay(el); });
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
  updateHud();
  $('feedback').innerHTML = '';
  $('pCard').classList.remove('ok', 'no');
  if ($('pCard').getBoundingClientRect().top < 0) scrollTo(0, 0);   // scrolled down to Next last time
  $('pLabel').textContent = { front: 'Pick the matching answer', back: 'Which card is this?', typing: 'Type the answer' }[G.qtype];
  const p = $('pPrompt');
  p.className = `flash-front${sizeClass(q.prompt)}`;
  // The prompt side's picture, if it has one. An image-occlusion question is the picture with its highlighted box.
  p.innerHTML = (q.occ ? occlusionHTML(card, 'front', { zoom: false }) : imgHTML(q.image)) + mathHTML(q.prompt);
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
    // A drill from "You mix these up" always offers the partner's answer. Each option remembers which card it is the
    // answer of, so picking another card's answer can be recorded as a mix-up (log.mixedWith).
    const partner = G.mix?.get(card.id);
    const include = partner ? G.all.filter(c => c.id === partner).map(c => questionFor(c, G.qtype).answer) : [];
    const wrong = pickDistractors(card, G.all, G.qtype, { hard: G.hard, withIds: true, include });
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
  G.autoTimer = setTimeout(finish, 1100);
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
    if (choice !== null) { given = choice; const res = checkTyped(choice, answerTargets(G.q.answer), { forgiving: !G.hard }); ok = res.correct; exact = res.exact; target = res.target; if (!ok) mixedWith = typedMixup(choice); }
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
  const entry = { card: G.card, q: G.q, ok, seconds, mixedWith, ms: Math.round(elapsed), limitMs: G.limit, speed, given: choice === null ? null : given,
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
  $('feedback').innerHTML = `${head}${info}${diff ? diffHTML(diff) : ''}<div class="fb-btns">
    <button type="button" class="btn ${ok ? 'ghost' : 'primary'}" id="nextBtn">${G.over ? 'See results' : 'Next'} <span class="mono">${icon('enter')}</span></button>
    <button type="button" class="btn ghost" id="cardBtn" aria-label="Card actions: edit, flag, suspend, bury and more">Card ${icon('more')}</button></div>`;
  $('nextBtn').addEventListener('click', next);
  $('cardBtn').addEventListener('click', openCardMenu);
  if (lightning) G.autoTimer = setTimeout(next, ok ? 280 : 900);
  else if (ok) G.autoTimer = setTimeout(next, G.over ? 900 : diff ? 1600 : 750);
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

// Save one answer: always to the review log (for stats), and to the review schedule when the
// auto-grading rules allow it (see autograde.js).
async function record(round, entry) {
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
  rating = appliedRating({ decision, rating, mc: round.qtype !== 'typing' });
  if (decision === 'first') takeNewFor(data.newLeft, entry.card.deckId);
  const log = {
    cardId: id, timestamp: now, source: 'play',
    mode: round.qtype, format: round.fmt,
    correct: entry.ok, ms: entry.ms, rating, chars, hard: !!round.hard,
    state: prev ? prev.state : 0,      // the card's state before this answer
    applied: false,                    // did it change the schedule?
    reason: decision                   // why or why not: 'due', 'again', 'first', 'not-due', 'new', 'new-limit', 'already' or 'short-time'
  };
  if (entry.mixedWith) log.mixedWith = entry.mixedWith;     // the card whose answer was given instead (confusion.js)
  if (applies(decision)) {
    let next = null;
    try {
      const { rate } = await import('./srs.js');     // the FSRS library, loaded on demand
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
      await db.addLog(log);
    }
    // Saving is outside the try, so an error after the review is saved can't add the same answer a second time.
    if (next) {
      log.applied = true;
      await db.saveReview(next, log);
      data.statesById.set(id, next);
      data.playedToday.add(id);
      await checkLeech(round, entry.card, prev, next, log);
    }
  } else {
    await db.addLog(log);
  }
  entry.rating = rating;
  entry.decision = decision;
}

// Forgotten too many times? Same as Review: tag it "leech", and suspend it unless Settings says tag only.
async function checkLeech(round, card, prev, next, log) {
  // A miss on a card that wasn't due still brings it back, but doesn't count toward the leech limit.
  if (log.reason === 'again' || next.lapses <= (prev?.lapses || 0)) return;
  if (!isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(card.id), data.settings.leechThreshold)) return;
  const leech = markLeech((await db.get('cards', card.id)) || card, data.settings.leechAction);
  await db.saveCards([leech]);
  if (!round.leeches.includes(card.id)) round.leeches.push(card.id);
  if (leech.suspended) dropFromRound(round, card.id); else replaceInRound(round, playCopy(leech));
  toast(leech.suspended ? 'Leech: you keep forgetting this card, so it’s been suspended' : 'Leech: you keep forgetting this card (tagged “leech”)');
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
  setFocusMode(false);
  drawSidebar();          // the sidebar's counts and ring, now the round is done
  const total = round.log.length, correct = round.log.filter(l => l.ok).length;
  const acc = total ? correct / total : 0;
  const oks = round.log.filter(l => l.ok);
  const avgSpeed = oks.length ? oks.reduce((a, l) => a + l.speed, 0) / oks.length : 0;
  const { letter, label } = gradeFor(acc, avgSpeed);
  const avgTime = total ? round.log.reduce((a, l) => a + l.seconds, 0) / total : 0;

  let isBest = false, firstScore = false;
  if (!round.drill && total) {
    const settings = await db.getSettings();
    const bests = { ...(settings.playBest || {}) };
    const k = bestKey(round);
    if (round.score > (bests[k] || 0)) { firstScore = !bests[k]; bests[k] = round.score; isBest = true; await db.setSetting('playBest', bests); }
  }
  const seen = new Set();
  const missed = round.log.filter(l => !l.ok && !seen.has(l.card.id) && seen.add(l.card.id));
  const deckName = deckPath(data.decks, round.deckId);
  const schedule = await scheduleSummary(round);
  // You may have switched to another screen while that saved: don't draw over it.
  if (!location.hash.startsWith('#/play')) return;
  const line = round.fmt === 'survival' ? `Survived ${plural(total, 'question')}.`
    : round.fmt === 'lightning' ? `${plural(correct, 'right answer')} in 60 seconds.` : '';

  const strong = 'SAB'.includes(letter);          // the big stamp is for S, A and B; a C or D gets a quiet one
  const gradeText = isBest ? `Grade ${letter}` : label;
  const missedRow = l => { const diff = l.typed ? diffAgainstBack(l.typed, l.target) : null; return `
        <div class="miss">
          <div class="m">${mathHTML(l.q.prompt)}</div>
          ${l.q.occ ? `<div class="occ-mini">${occlusionHTML(l.card, 'back', { zoom: false })}</div>` : ''}
          <div class="r">${mathHTML(l.q.answer)}</div>
          ${hasMarks(diff) ? diffHTML(diff, { small: true })
            : `<div class="y">${l.given === null ? 'Out of time' : l.given === '' ? 'Skipped' : `You answered: ${esc(l.given)}`}</div>`}
        </div>`; };
  const SHOWN = 3;
  el.innerHTML = `
    <div class="res-head">
      <div class="stamp press${strong ? '' : ' quiet'}" aria-label="Grade ${letter}"><span>${letter}</span></div>
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
      ${missed.length ? missed.map((l, i) => i < SHOWN ? missedRow(l) : `<div class="miss-extra" hidden>${missedRow(l)}</div>`).join('')
        + (missed.length > SHOWN ? `<button class="btn ghost" id="showAllMiss" type="button">Show all ${missed.length}</button>` : '')
      : `<p class="muted">${total ? 'Clean round. Nothing to review.' : 'No answers this round.'}</p>`}
    </section>`;
  $('showAllMiss')?.addEventListener('click', e => {
    el.querySelectorAll('.miss-extra').forEach(x => { x.hidden = false; });
    e.currentTarget.remove();
  });
  const slot = $('resultsMore'), cardIds = [...new Set(round.log.map(l => l.card.id))], leechIds = [...round.leeches], entries = round.log;
  import('./finish-extras.js').then(m => m.drawFinishExtras(slot, { source: 'play', cardIds, leechIds, entries })).catch(err => console.error(err));
  const base = { deckId: round.deckId, fmt: round.fmt, qtype: round.qtype, hard: round.hard, flash: round.flash, len: round.len, pace: round.pace, pool: round.source };
  $('againBtn').addEventListener('click', () => start(el, round.drill ? { ...base, drill: round.drill, mix: round.mix, drillTotal: round.drillTotal } : base));
  $('drillBtn')?.addEventListener('click', () => start(el, { ...base, drill: missed.map(l => l.card) }));
  $('menuBtn').addEventListener('click', () => renderPlay(el));
  $('againBtn').focus({ preventScroll: true });
  fx.result(el);
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if (!G || !$('pCard') || e.ctrlKey || e.metaKey || e.altKey || document.getElementById('sheet')?.open) return;
  if (e.key === 'Escape') { e.preventDefault(); const el = G.el; stopRound(); renderPlay(el); return; }
  if (G.answered) {
    if ((e.key === 'Enter' || e.key === ' ') && !onControl(e)) { e.preventDefault(); next(); }
    return;
  }
  if (G.qtype !== 'typing' && /^[1-6]$/.test(e.key) && +e.key <= G.opts.length) { e.preventDefault(); answer(+e.key - 1); }
});
