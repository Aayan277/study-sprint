// The Play tab: timed game rounds, ported from Kanji Sprint and adapted for any deck.
//   Formats:   Classic (set number of questions), Survival (3 lives, shrinking timer), Lightning (60s total)
//   Questions: Front → pick the back, Back → pick the front, Typing
//   Extras:    Hard (6 options, lookalike traps, −50 for wrong, ×1.25), Flash (prompt vanishes, ×1.2)
// The rules themselves (scoring, timers, wrong options) live in game.js.
// Every answer is saved to the review log, and feeds the review schedule following the
// auto-grading rules in autograde.js.

import * as db from './db.js';
import {
  questionFor, playableCards, canMultipleChoice, pickDistractors, weightedQueue, timeLimit, scoreAnswer,
  gradeFor, bestKey, shuffle, defaultQuestionType, LIGHTNING_MS, PENALTY_MS, LIVES, TYPING_TIME
} from './game.js';
import { autoRating, scheduleDecision, applies } from './autograde.js';
import { dayStart } from './days.js';
import { schedulerOptions } from './sched-settings.js';
import { examOptions } from './exam.js';
import { isHidden, isNewLeech, markLeech } from './browse-logic.js';
import { openCardPanel } from './browse.js';
import { checkAnswer } from './match.js';
import { plainText } from './format.js';
import { $, esc, plural, toast } from './ui.js';

const FORMATS = { classic: 'Classic', survival: 'Survival', lightning: 'Lightning' };
const QTYPES = { front: 'Front → back', back: 'Back → front', typing: 'Typing' };
// qtypeByDeck remembers the question type you picked for each deck ('all' = All decks).
const DEFAULT_PREFS = { deckId: 'all', fmt: 'classic', qtype: 'front', hard: false, flash: 0, len: 20, qtypeByDeck: {} };

let G = null;      // the round in progress
let data = null;   // decks, cards and settings loaded for the setup screen
let pendingDrill = null;   // card ids sent from another screen (Stats → "Drill these")

// Open Play and start a drill round on these cards straight away.
export function drillCards(cardIds) {
  pendingDrill = cardIds;
  if (location.hash === '#/play') renderPlay(document.getElementById('screen'));
  else location.hash = '#/play';
}

const fmtClock = ms => { const s = Math.ceil(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sizeClass = text => (text.length > 120 ? ' xlong' : text.length > 50 ? ' long' : '');

// Stop timers when a round is abandoned (leaving the tab, or quitting).
function stopRound() {
  if (!G) return;
  cancelAnimationFrame(G.raf); clearTimeout(G.autoTimer); clearTimeout(G.flashTimer);
  G = null;
}

// ---------- setup ----------
const playCopy = c => ({ ...c, front: plainText(c.front), back: plainText(c.back) });

export async function renderPlay(el) {
  stopRound();
  const [settings, decks, allCards, states, logs] = await Promise.all([
    db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getLogsSince(dayStart())
  ]);
  // Suspended cards, and cards buried until tomorrow, sit out of Play too.
  // Play works on plain-text copies (no bold or list marks), so options and typed answers compare cleanly.
  // Anything saved back (leeches, Card ⋯) uses the real card from the database instead.
  const cards = allCards.filter(c => !isHidden(c)).map(playCopy);
  decks.sort((a, b) => a.created - b.created);
  data = {
    settings, decks, cards,
    statesById: new Map(states.map(s => [s.cardId, s])),
    // Cards whose schedule Play already changed today (Play only changes each card once a day).
    playedToday: new Set(logs.filter(l => l.source === 'play' && l.applied).map(l => l.cardId))
  };
  const prefs = { ...DEFAULT_PREFS, ...(settings.playPrefs || {}) };
  if (prefs.deckId !== 'all' && !decks.some(d => d.id === prefs.deckId)) prefs.deckId = 'all';
  let pace = settings.timer;

  // Drill sent from Stats: use your usual question type when it works for these cards, otherwise
  // Back → front (shows the definition, you pick the term), then Typing.
  if (pendingDrill) {
    const ids = new Set(pendingDrill);
    pendingDrill = null;
    const drill = cards.filter(c => ids.has(c.id));
    const decksUsed = new Set(drill.map(c => c.deckId));
    const pool = cards.filter(c => decksUsed.has(c.deckId));   // wrong options come from the same decks
    const qtype = [prefs.qtype, 'back', 'typing'].find(q =>
      q === 'typing' ? playableCards(drill, q).length : canMultipleChoice(pool, q) && playableCards(drill, q).length);
    if (drill.length && qtype) return start(el, { ...prefs, deckId: decksUsed.size === 1 ? [...decksUsed][0] : 'all', qtype, pace, pool, drill });
  }

  const draw = () => {
    const pool = prefs.deckId === 'all' ? cards : cards.filter(c => c.deckId === prefs.deckId);
    // Your pick for this deck, or a sensible start: Back → front for definition-style decks.
    const picked = prefs.qtypeByDeck[prefs.deckId];
    prefs.qtype = picked || defaultQuestionType(pool);
    const suggested = !picked && prefs.qtype === 'back';
    const mcOk = canMultipleChoice(pool, 'front') && canMultipleChoice(pool, 'back');
    const typeCount = playableCards(pool, 'typing').length;
    if (!mcOk && prefs.qtype !== 'typing') prefs.qtype = 'typing';
    const best = settings.playBest?.[bestKey(prefs)];
    const typing = prefs.qtype === 'typing';
    const notes = [];
    if (prefs.fmt === 'survival') notes.push('Each question gets 3% less time, down to a 2s floor.');
    if (typing) notes.push(`Typing gets ${TYPING_TIME}× the time (${Math.round(pace * TYPING_TIME)}s${prefs.fmt === 'survival' ? ' to start' : ''}).`);
    const paceName = pace <= 4 ? 'Sprint' : pace <= 7 ? 'Quick' : pace <= 10 ? 'Standard' : pace <= 14 ? 'Relaxed' : 'Easy';
    const radio = (name, value, label, checked, extra = '') =>
      `<label class="chip"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} ${extra}><span>${label}</span></label>`;

    el.innerHTML = `
      <div class="screen-head"><div><span class="eyebrow mono">PLAY</span><h1>Play</h1>
        <p class="lede">A right answer scores <b>100</b>, plus up to <b>100</b> more for speed, multiplied by your streak (up to <b>×1.5</b>).
          Answers on cards that are due also count as their review.</p></div></div>

      ${!cards.length ? `<div class="empty"><b>No cards yet.</b><br>Add some to a deck first.<br><a class="btn primary" href="#/import">Import cards</a></div>` : `
      <fieldset><legend>Deck</legend>
        <select id="pDeck" class="select" aria-label="Deck">
          <option value="all" ${prefs.deckId === 'all' ? 'selected' : ''}>All decks (${plural(cards.length, 'card')})</option>
          ${decks.map(d => `<option value="${esc(d.id)}" ${d.id === prefs.deckId ? 'selected' : ''}>${esc(d.name)} (${cards.filter(c => c.deckId === d.id).length})</option>`).join('')}
        </select>
      </fieldset>

      <fieldset><legend>Format</legend>
        <div class="modes three">
          ${[['classic', `${prefs.len} Q`, 'A set number of questions, with a timer on each.'],
             ['survival', '<span class="hearts" aria-hidden="true">●●●</span>', '3 lives. The timer gets shorter every question.'],
             ['lightning', '<span class="clock">1:00</span>', '60 seconds on the clock. Wrong answers cost 3s.']].map(([v, ex, desc]) => `
            <label class="mode"><input type="radio" name="fmt" value="${v}" ${prefs.fmt === v ? 'checked' : ''}>
              <span class="mode-ex">${ex}</span><span class="mode-name">${FORMATS[v]}</span><span class="mode-desc">${desc}</span></label>`).join('')}
        </div>
      </fieldset>

      <fieldset><legend>Question</legend>
        <div class="chips">
          ${radio('qtype', 'front', 'Front → pick the back', prefs.qtype === 'front', mcOk ? '' : 'disabled')}
          ${radio('qtype', 'back', 'Back → pick the front', prefs.qtype === 'back', mcOk ? '' : 'disabled')}
          ${radio('qtype', 'typing', 'Typing', typing, typeCount ? '' : 'disabled')}
        </div>
        <p class="note">${!mcOk ? 'Multiple choice needs at least 4 cards with different answers. Use Typing, or Review.'
          : typing ? `You type the shorter side (40 characters or less). ${typeCount} of ${pool.length} cards can be typed.`
          : suggested ? 'Starting on Back → front because this deck has long answers: you read the definition and pick the term, which is closer to an exam.'
          : 'Wrong options come from other cards in the deck.'}</p>
      </fieldset>

      <div class="settings">
        <fieldset><legend>Difficulty</legend>
          <div class="chips">${radio('diff', 'normal', 'Normal', !prefs.hard)}${radio('diff', 'hard', 'Hard', prefs.hard)}</div>
          <p class="note">${prefs.hard ? 'Hard: 6 options with lookalike traps, −50 for each wrong answer, ×1.25 points. Typing gets no typo forgiveness.' : 'Normal: 4 options.'}</p>
        </fieldset>
        <fieldset><legend>Flash</legend>
          <div class="chips">${[0, 1200, 800, 500].map(f => radio('flash', f, f ? `${f / 1000}s` : 'Off', prefs.flash === f)).join('')}</div>
          <p class="note">${prefs.flash ? `The question disappears after ${prefs.flash / 1000}s, so read fast. Answers score ×1.2.` : 'Make the question vanish a moment after it appears.'}</p>
        </fieldset>
      </div>

      <div class="settings">
        ${prefs.fmt === 'classic' ? `<fieldset><legend>Questions</legend>
          <div class="chips">${[10, 20, 40].map(n => radio('len', n, n, prefs.len === n)).join('')}</div></fieldset>` : ''}
        ${prefs.fmt === 'lightning' ? `<fieldset><legend>Clock</legend>
          <p class="lightning-note">You get <b>60 seconds</b> total, with no timer per question. Each wrong answer takes <b>3 seconds</b> off. The clock pauses while you read the answer.</p></fieldset>` : `
        <fieldset><legend id="paceLegend">${prefs.fmt === 'survival' ? 'Starting time per question' : 'Time per question'}</legend>
          <div class="slider-row">
            <input type="range" id="pace" min="3" max="20" step="1" value="${pace}" aria-labelledby="paceLegend">
            <output for="pace" class="mono" id="paceOut"><b>${pace}s</b> ${paceName}</output>
          </div>
          ${notes.length ? `<p class="note">${notes.join(' ')}</p>` : ''}
        </fieldset>`}
      </div>

      <div class="start-row">
        <button class="btn primary" type="button" id="startBtn">Start round</button>
        <span class="mode-best mono">${best ? `Best for this setup <b>${best.toLocaleString()}</b>` : 'No score for this setup yet'}</span>
      </div>
      <p class="hint mono">Number keys to answer · Enter for next · Esc to quit</p>`}`;

    if (!cards.length) return;
    const save = () => db.setSetting('playPrefs', { ...prefs });
    $('pDeck').addEventListener('change', e => { prefs.deckId = e.target.value; save(); draw(); });
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
    $('startBtn').addEventListener('click', () => start(el, { ...prefs, pace, pool }));
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
    score: 0, streak: 0, bestStreak: 0, log: [], lives: LIVES, clock: LIGHTNING_MS, over: false,
    answered: false, raf: 0, autoTimer: 0, flashTimer: 0,
    saving: Promise.resolve()          // answers are saved one after another in the background
  };
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
      <input id="pInput" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Your answer" placeholder="Type the answer">
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
  $('score').textContent = G.score.toLocaleString();
  $('streak').textContent = G.streak;
  $('streakWrap').classList.toggle('streak-on', G.streak >= 3);
}

function showQuestion() {
  clearTimeout(G.autoTimer);
  if (G.i >= G.queue.length) G.queue.push(...weightedQueue(G.pool, 30, G.weightOf));
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
  p.textContent = q.prompt;
  clearTimeout(G.flashTimer);
  $('flashQ').hidden = true;
  if (G.flash) G.flashTimer = setTimeout(() => { if (!G?.answered) { $('pPrompt')?.classList.add('gone'); $('flashQ').hidden = false; } }, G.flash);

  const typing = G.qtype === 'typing';
  $('options').hidden = typing; $('pType').hidden = !typing;
  if (typing) {
    const inp = $('pInput');
    inp.value = ''; inp.disabled = false;
    inp.focus();
  } else {
    const wrong = pickDistractors(card, G.all, G.qtype, { hard: G.hard });
    G.opts = shuffle([q.answer, ...wrong]);
    const long = G.opts.some(o => o.length > 28);
    $('options').className = `options${G.opts.length > 4 ? ' six' : ''}${long ? ' long' : ''}`;
    $('options').innerHTML = G.opts.map((o, i) =>
      `<button type="button" class="opt" data-i="${i}"><span class="key">${i + 1}</span><span class="lbl">${esc(o)}</span></button>`).join('');
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
    fill.classList.toggle('low', f < 0.25);
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
  let ok = false, given = '';
  if (G.qtype === 'typing') {
    $('pInput').disabled = true;
    if (choice !== null) { given = choice; ok = checkAnswer(choice, G.q.answer, { forgiving: !G.hard }).correct; }
  } else {
    if (choice !== null) { given = G.opts[choice]; ok = given === G.q.answer; }
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

  const entry = { card: G.card, q: G.q, ok, seconds, ms: Math.round(elapsed), limitMs: G.limit, speed, given: choice === null ? null : given };
  G.log.push(entry);
  // Save in the background so the game never waits for the database.
  const round = G;
  G.saving = G.saving.then(() => record(round, entry)).catch(err => console.error('Could not save answer', err));
  updateHud(lightning && !ok);
  $('pCard').classList.add(ok ? 'ok' : 'no');

  const head = ok
    ? `<div class="fb ok"><span class="fb-mark">✓ Correct</span><span class="fb-pts mono">+${pts}</span><span class="fb-detail mono">${seconds.toFixed(1)}s${mult > 1 ? ' · ×' + mult.toFixed(1) + ' streak' : ''}</span></div>`
    : `<div class="fb no"><span class="fb-mark">${choice === null ? 'Out of time' : choice === '' ? 'Skipped' : 'Not quite'}${lightning ? ' · −3s' : ''}${extra}</span>${pts < 0 ? `<span class="fb-minus mono">${pts}</span>` : ''}</div>`;
  const yours = !ok && given ? `<span class="given">You answered: ${esc(given)}</span>` : '';
  const info = ok ? '' : `<p class="fb-info"><b>${esc(G.q.answer)}</b>${yours}</p>`;
  $('feedback').innerHTML = `${head}${info}<div class="fb-btns">
    <button type="button" class="btn ${ok ? 'ghost' : 'primary'}" id="nextBtn">${G.over ? 'See results' : 'Next'} <span class="mono">↵</span></button>
    <button type="button" class="btn ghost" id="cardBtn" aria-label="Card actions: edit, flag, suspend, bury and more">Card ⋯</button></div>`;
  $('nextBtn').addEventListener('click', next);
  $('cardBtn').addEventListener('click', openCardMenu);
  if (lightning) G.autoTimer = setTimeout(next, ok ? 280 : 900);
  else if (ok) G.autoTimer = setTimeout(next, G.over ? 900 : 750);
  else {
    $('nextBtn').focus({ preventScroll: true });
    // Long answers can push the Next button below the screen, so bring it into view.
    $('nextBtn').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// Save one answer: always to the review log (for stats), and to the review schedule when the
// auto-grading rules allow it (see autograde.js).
async function record(round, entry) {
  const id = entry.card.id;
  const now = Date.now();
  const rating = autoRating({ ok: entry.ok, ms: entry.ms, limitMs: entry.limitMs, typing: round.qtype === 'typing' });
  const prev = data.statesById.get(id);
  let decision = scheduleDecision({ state: prev, rating, alreadyToday: data.playedToday.has(id), now });
  const log = {
    cardId: id, timestamp: now, source: 'play',
    mode: round.qtype, format: round.fmt,
    correct: entry.ok, ms: entry.ms, rating,
    state: prev ? prev.state : 0,      // the card's state before this answer
    applied: false,                    // did it change the schedule?
    reason: decision                   // why or why not: 'due', 'again', 'not-due', 'new' or 'already'
  };
  if (applies(decision)) {
    try {
      const { rate } = await import('./srs.js');     // the FSRS library, loaded on demand
      const deck = data.decks.find(d => d.id === entry.card.deckId);     // exam date mode limits (exam.js)
      const next = rate(id, prev, rating, examOptions(schedulerOptions(data.settings), deck, now), now);
      log.applied = true;
      await db.saveReview(next, log);
      data.statesById.set(id, next);
      data.playedToday.add(id);
      await checkLeech(round, entry.card, prev, next);
    } catch (err) {
      // Scheduling library not available (e.g. offline before it was ever downloaded): keep the answer for stats.
      console.error(err);
      decision = 'not-due';
      log.applied = false;
      log.reason = 'not-due';
      await db.addLog(log);
    }
  } else {
    await db.addLog(log);
  }
  entry.rating = rating;
  entry.decision = decision;
}

// Forgotten too many times? Same as Review: tag it "leech", and suspend it unless Settings says tag only.
async function checkLeech(round, card, prev, next) {
  if (!isNewLeech(prev?.lapses || 0, next.lapses, data.settings.leechThreshold)) return;
  const leech = markLeech((await db.get('cards', card.id)) || card, data.settings.leechAction);
  await db.saveCards([leech]);
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
    decks: data.decks, statesById: data.statesById, closeAfter: ['suspend', 'bury', 'delete'],
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
  const graded = count('due'), sentBack = count('again'), fresh = count('new');
  if (!round.log.length) return '';
  const parts = [];
  if (graded) parts.push(`<b>${plural(graded, 'due card')}</b> graded from your answers`);
  if (sentBack) parts.push(`<b>${plural(sentBack, 'missed card')}</b> brought back for review`);
  const text = parts.length
    ? `Review schedule updated: ${parts.join(', ')}.`
    : 'No cards were due, so your review schedule didn’t change.';
  const extra = fresh ? ` ${plural(fresh, 'new card')} ${fresh === 1 ? 'starts' : 'start'} in Review, not here.` : '';
  return `<p class="sched-note">${text}${extra} Every answer counts toward your stats.</p>`;
}

async function finish() {
  if (!G || !$('pCard')) return;
  clearTimeout(G.autoTimer); cancelAnimationFrame(G.raf); clearTimeout(G.flashTimer);
  const el = G.el, round = G;
  G = null;
  const total = round.log.length, correct = round.log.filter(l => l.ok).length;
  const acc = total ? correct / total : 0;
  const oks = round.log.filter(l => l.ok);
  const avgSpeed = oks.length ? oks.reduce((a, l) => a + l.speed, 0) / oks.length : 0;
  const { letter, label } = gradeFor(acc, avgSpeed);
  const avgTime = total ? round.log.reduce((a, l) => a + l.seconds, 0) / total : 0;

  let isBest = false;
  if (!round.drill && total) {
    const settings = await db.getSettings();
    const bests = { ...(settings.playBest || {}) };
    const k = bestKey(round);
    if (round.score > (bests[k] || 0)) { bests[k] = round.score; isBest = true; await db.setSetting('playBest', bests); }
  }
  const seen = new Set();
  const missed = round.log.filter(l => !l.ok && !seen.has(l.card.id) && seen.add(l.card.id));
  const deckName = round.deckId === 'all' ? 'All decks' : data.decks.find(d => d.id === round.deckId)?.name || '';
  const schedule = await scheduleSummary(round);
  // You may have switched to another screen while that saved: don't draw over it.
  if (!location.hash.startsWith('#/play')) return;
  const line = round.fmt === 'survival' ? `Survived ${plural(total, 'question')}.`
    : round.fmt === 'lightning' ? `${plural(correct, 'right answer')} in 60 seconds.` : '';

  el.innerHTML = `
    <div class="res-head">
      <div class="stamp press" aria-label="Grade ${letter}"><span>${letter}</span></div>
      <div style="min-width:0">
        <p class="res-grade">${label} · ${round.drill ? 'Drill' : FORMATS[round.fmt]}${round.hard ? ' (Hard)' : ''}${round.flash ? ` · Flash ${round.flash / 1000}s` : ''} · ${QTYPES[round.qtype]} · ${esc(deckName)}</p>
        <p class="res-score mono">${round.score.toLocaleString()} <small>pts</small></p>
        ${line ? `<p class="res-line">${line}</p>` : ''}
        ${isBest ? '<p class="newbest">New best for this setup</p>' : ''}
      </div>
    </div>
    <div class="stats4">
      <div><div class="v">${Math.round(acc * 100)}%</div><div class="l">Accuracy</div></div>
      <div><div class="v">${avgTime.toFixed(1)}s</div><div class="l">Avg answer time</div></div>
      <div><div class="v">${round.bestStreak}</div><div class="l">Best streak</div></div>
      <div><div class="v">${correct}/${total}</div><div class="l">Correct</div></div>
    </div>
    ${schedule}
    <section class="missed">
      <h2>Missed</h2>
      ${missed.length ? missed.map(l => `
        <div class="miss">
          <div class="m">${esc(l.q.prompt)}</div>
          <div class="r">${esc(l.q.answer)}</div>
          <div class="y">${l.given === null ? 'Out of time' : l.given === '' ? 'Skipped' : `You answered: ${esc(l.given)}`}</div>
        </div>`).join('')
      : `<p class="muted">${total ? 'Clean round. Nothing to review.' : 'No answers this round.'}</p>`}
    </section>
    <div class="res-actions">
      <button class="btn primary" id="againBtn" type="button">Play again</button>
      ${missed.length ? '<button class="btn ghost" id="drillBtn" type="button">Drill missed</button>' : ''}
      <button class="btn ghost" id="menuBtn" type="button">Change setup</button>
    </div>`;
  const base = { deckId: round.deckId, fmt: round.fmt, qtype: round.qtype, hard: round.hard, flash: round.flash, len: round.len, pace: round.pace, pool: round.source };
  $('againBtn').addEventListener('click', () => start(el, round.drill ? { ...base, drill: round.drill } : base));
  $('drillBtn')?.addEventListener('click', () => start(el, { ...base, drill: missed.map(l => l.card) }));
  $('menuBtn').addEventListener('click', () => renderPlay(el));
  $('againBtn').focus({ preventScroll: true });
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if (!G || !$('pCard') || e.ctrlKey || e.metaKey || e.altKey || document.getElementById('sheet')?.open) return;
  if (e.key === 'Escape') { e.preventDefault(); const el = G.el; stopRound(); renderPlay(el); return; }
  if (G.answered) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); }
    return;
  }
  if (G.qtype !== 'typing' && /^[1-6]$/.test(e.key) && +e.key <= G.opts.length) { e.preventDefault(); answer(+e.key - 1); }
});
