// The first-run start: what a brand-new install opens on instead of a filled-in sample deck.
//
//   1. Pitch          one screen on what the app is
//   2. Name your course   a name (plus an optional course code and exam date). This makes the first deck.
//   3. Add cards      paste notes, import a file or Anki deck, or try the sample deck
//   4. Guided review  about 3 cards, with short hints (a real review: the answers are saved)
//
// Every step can be skipped, and once it has been finished or skipped it never shows again (the `onboarded`
// setting, on this device only: see checkFirstRun() in app.js). Existing installs never see it.
// It lives at #/welcome (the guided review at #/welcome/review/<deck id>).
//
// app.js passes in two things so this file doesn't need app.js's private state:
//   seedSample()  adds the sample deck          finish()  remembers that the first-run start is done

import * as db from './db.js';
import { DECK_COLORS } from './decks.js';
import { deckPath, subtreeIds, effectiveDeck } from './deck-tree.js';
import { deckSchedulerOptions } from './sched-settings.js';
import { examOptions } from './exam.js';
import { isHidden } from './browse-logic.js';
import { formatInterval } from './queue.js';
import { formatHTML, plainText } from './format.js';
import { imgHTML } from './media.js';
import { $, esc, plural, toast, icon, setFocusMode } from './ui.js';

const GUIDE_CARDS = 3;
// Handed to the Import screen: after it saves cards into this deck, it offers the guided review (see import-screen.js).
export const FIRST_REVIEW_KEY = 'study-sprint-first-review';

// The three steps so far. Kept while the page is open, so Back from step 3 returns to what you typed.
let flow = { step: 'pitch', deckId: null, name: '', course: '', exam: '' };

// The logo from the page header.
const MARK = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="3" width="22" height="24" rx="4" fill="var(--accent-line)"/><rect x="3" y="6" width="22" height="24" rx="4" fill="var(--accent)"/><path d="M15.5 10l-6 9h4.5l-1 6 6-9h-4.5z" fill="var(--on-accent)"/></svg>';

const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export async function renderWelcome(el, arg, api) {
  // #/welcome/review/<deck id>: the guided review.
  const m = /^review\/(.+)$/.exec(arg || '');
  if (m) return renderGuide(el, m[1], api);
  flow = arg === 'again' ? { step: 'pitch', deckId: null, name: '', course: '', exam: '' } : flow;
  draw(el, api);
}

// Leave the first-run start for good and go to the Today screen.
async function leave(api, hash = '#/today') {
  await api.finish();
  location.hash = hash;
}

// The little "Step 2 of 3" bar at the top of each step.
const stepBar = n => `<div class="wl-bar" role="img" aria-label="Step ${n} of 3">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;

function draw(el, api) {
  setFocusMode(false);
  const { step } = flow;
  if (step === 'pitch') drawPitch(el, api);
  else if (step === 'name') drawName(el, api);
  else drawAdd(el, api);
  el.querySelector('h1')?.focus({ preventScroll: true });
  scrollTo(0, 0);
}

// ----- 1. the pitch -----
function drawPitch(el, api) {
  el.innerHTML = `
    <div class="welcome">
      <div class="wl-top"><span class="brand">${MARK} Study Sprint</span><button class="link" type="button" id="wlSkip">Skip</button></div>
      ${stepBar(1)}
      <h1 tabindex="-1">Remember it for the exam, not just the night before.</h1>
      <p class="lede">Study Sprint is a flashcard app for your university courses. It shows each card right before you would forget it, and it has quick game rounds for cramming.</p>
      <ul class="wl-points">
        <li>${icon('clock')}<span><b>Spaced repetition.</b> A few minutes a day, and the app works out what to show you.</span></li>
        <li>${icon('bolt')}<span><b>Game rounds.</b> Timed Classic, Survival and Lightning rounds for cramming.</span></li>
        <li>${icon('calendar')}<span><b>Exam dates.</b> Set one, and every card in that course comes back before the exam.</span></li>
      </ul>
      <button class="btn primary wide cta" type="button" id="wlNext">Get started</button>
      <p class="wl-foot">Already use Study Sprint? <a href="#/settings" id="wlSignIn">Sign in or restore a backup</a></p>
    </div>`;
  $('wlNext').addEventListener('click', () => { flow.step = 'name'; draw(el, api); });
  $('wlSkip').addEventListener('click', () => leave(api));
  $('wlSignIn').addEventListener('click', () => api.finish());       // the link goes to Settings
}

// ----- 2. name your course -----
function drawName(el, api) {
  el.innerHTML = `
    <div class="welcome">
      <div class="wl-top"><button class="back" type="button" id="wlBack">‹ Back</button><button class="link" type="button" id="wlSkip">Skip</button></div>
      ${stepBar(2)}
      <h1 tabindex="-1">Name your course</h1>
      <p class="lede">Each course gets its own deck of cards. You can add more later.</p>
      <form id="wlForm" novalidate>
        <label class="field"><span>Course name</span>
          <input id="wlName" maxlength="80" required placeholder="e.g. Cell Biology" autocomplete="off" value="${esc(flow.name)}"></label>
        <label class="field"><span>Course code (optional)</span>
          <input id="wlCourse" maxlength="20" placeholder="e.g. BIOL 201" autocomplete="off" autocapitalize="characters" value="${esc(flow.course)}"></label>
        <label class="field"><span>Exam date (optional)</span>
          <input id="wlExam" type="date" min="${todayISO()}" value="${esc(flow.exam)}">
          <small class="note" style="margin:4px 0 0">With a date, every card comes back before the exam and Exam prep goes over what you have not seen lately.</small></label>
        <p class="err" id="wlErr" role="alert" hidden></p>
        <button class="btn primary wide cta" type="submit">Create deck</button>
      </form>
    </div>`;
  $('wlBack').addEventListener('click', () => { flow.step = 'pitch'; draw(el, api); });
  $('wlSkip').addEventListener('click', () => leave(api));
  $('wlForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('wlName').value.trim(), exam = $('wlExam').value;
    const err = $('wlErr');
    const fail = (msg, field) => { err.textContent = msg; err.hidden = false; $(field).focus(); };
    if (!name) return fail('Give the course a name, or tap Skip.', 'wlName');
    if (exam && exam < todayISO()) return fail('That exam date has already passed.', 'wlExam');
    Object.assign(flow, { name, course: $('wlCourse').value.trim(), exam });
    // Going Back and then forward again updates the same deck instead of making a second one.
    const old = flow.deckId && await db.getDeck(flow.deckId);
    const deck = { ...(old || { id: db.newId(), color: DECK_COLORS[Math.floor(Math.random() * DECK_COLORS.length)], parentId: '', created: Date.now() }),
      name, course: flow.course, examDate: exam || null };
    await db.saveDeck(deck);
    flow.deckId = deck.id;
    flow.step = 'add';
    draw(el, api);
  });
}

// ----- 3. add cards -----
function drawAdd(el, api) {
  const deck = flow.deckId;
  el.innerHTML = `
    <div class="welcome">
      <div class="wl-top"><button class="back" type="button" id="wlBack">‹ Back</button><button class="link" type="button" id="wlSkip">Skip</button></div>
      ${stepBar(3)}
      <h1 tabindex="-1">Add cards to ${esc(flow.name)}</h1>
      <p class="lede">Pick the quickest way in. You can do all of them later.</p>
      <div class="wl-opts">
        <button class="wl-opt" type="button" id="wlPaste">
          <span class="wl-opt-t">Paste your notes</span>
          <span class="wl-opt-d">Copy from your notes, Quizlet or a table. The format is worked out for you.</span>${icon('chevron')}</button>
        <button class="wl-opt" type="button" id="wlFile">
          <span class="wl-opt-t">Import a file or Anki deck</span>
          <span class="wl-opt-d">A spreadsheet (.csv, .xlsx) or an Anki deck (.apkg).</span>${icon('chevron')}</button>
        <button class="wl-opt" type="button" id="wlSample">
          <span class="wl-opt-t">Try the sample deck</span>
          <span class="wl-opt-d">12 psychology cards, so you can see how studying feels. Delete it whenever you like.</span>${icon('chevron')}</button>
      </div>
      <p class="wl-foot"><button class="link" type="button" id="wlLater">I will add cards later</button></p>
    </div>`;
  $('wlBack').addEventListener('click', () => { flow.step = 'name'; draw(el, api); });
  $('wlSkip').addEventListener('click', () => leave(api, '#/today'));
  $('wlLater').addEventListener('click', () => leave(api, `#/deck/${deck}`));
  // Paste and file go to Import with this deck chosen. After the cards are saved, Import offers the guided review.
  const toImport = async tab => {
    try { sessionStorage.setItem(FIRST_REVIEW_KEY, deck); } catch { /* fine without */ }
    await leave(api, `#/import/${deck}${tab ? '/' + tab : ''}`);
  };
  $('wlPaste').addEventListener('click', () => toImport(''));
  $('wlFile').addEventListener('click', () => toImport('file'));
  $('wlSample').addEventListener('click', async () => {
    $('wlSample').disabled = true;
    await api.seedSample();
    await api.finish();
    location.hash = '#/welcome/review/sample';
  });
}

// ----- 4. the guided review -----
// A real first review of a few cards: each rating is saved (so the cards are scheduled), with hints on what to do.
let G = null;

async function renderGuide(el, deckId, api) {
  const [settings, decks, allCards, states] = await Promise.all([db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAll('cardStates')]);
  if (!el.isConnected) return;
  try { sessionStorage.removeItem(FIRST_REVIEW_KEY); } catch { /* fine */ }
  const inside = subtreeIds(decks, deckId);
  const studied = new Set(states.filter(s => s.state !== 0).map(s => s.cardId));
  const cards = allCards.filter(c => inside.has(c.deckId) && !isHidden(c) && !studied.has(c.id)).sort((a, b) => a.created - b.created).slice(0, GUIDE_CARDS);
  if (!cards.length) { location.hash = '#/today'; return; }
  G = { el, api, settings, decks, cards, i: 0, flipped: false, shownAt: Date.now(), done: 0, saved: 0, srs: null, deckId };
  // The scheduler library comes from the internet the first time; if that fails the walk-through still works, it just can't save.
  try { G.srs = await import('./srs.js'); } catch (err) { console.error(err); }
  if (!el.isConnected) return;
  drawGuide();
}

// The scheduling options for a card, like Review uses (the deck's own settings and exam limits).
function optsFor(card, now = Date.now()) {
  const deck = effectiveDeck(G.decks, card.deckId);
  return examOptions(deckSchedulerOptions(G.settings, deck), deck, now);
}

function drawGuide() {
  const { el, cards, i, flipped } = G;
  if (i >= cards.length) return drawGuideDone();
  const card = cards[i];
  const size = plainText(card.front).length > 120 ? ' xlong' : plainText(card.front).length > 50 ? ' long' : '';
  const front = `${imgHTML(card.frontImage)}${formatHTML(card.front)}`;
  const ivl = G.srs ? G.srs.previewIntervals(null, optsFor(card)) : null;
  const deckLabel = `<span class="flash-deck">${esc(deckPath(G.decks, card.deckId))}</span>`;
  el.innerHTML = `
    <div class="welcome guide">
      <div class="wl-top"><span class="wl-count mono">Card ${i + 1} of ${cards.length}</span><button class="link" type="button" id="gSkip">Skip the walk-through</button></div>
      <p class="coach" id="coach" role="status">${flipped
        ? '<b>2</b> Now rate how well you knew it. This tells the app when to show the card again.'
        : '<b>1</b> Read the question, try to recall the answer, then tap the card to flip it.'}</p>
      <article class="flash rv-card${flipped ? ' flipped' : ''}" id="flash" ${flipped ? '' : 'role="button" tabindex="0" aria-label="Show answer"'}>
        <div class="rv-turn">
          <div class="rv-face rv-front" ${flipped ? 'aria-hidden="true"' : ''}>${deckLabel}
            <div class="flash-front${size}">${front}</div>
            <p class="flash-hint">Tap to flip</p></div>
          <div class="rv-face rv-back" ${flipped ? '' : 'aria-hidden="true"'}>${deckLabel}
            <div class="flash-recap">${front}</div>
            <div class="flash-ans"><div class="flash-back">${imgHTML(card.backImage)}${formatHTML(card.back)}</div></div></div>
        </div>
      </article>
      <div class="ratebar" id="ratebar">${flipped ? `
        <div class="rates">${[[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']].map(([r, label]) => `
          <button type="button" class="rate r${r}" data-rate="${r}"><b>${label}</b>${ivl ? `<span class="mono">${formatInterval(ivl[r])}</span>` : ''}</button>`).join('')}</div>`
        : '<button class="btn primary wide" type="button" id="showBtn">Show answer</button>'}</div>
    </div>`;
  setFocusMode(true);
  $('gSkip').addEventListener('click', () => { const api = G.api; G = null; setFocusMode(false); leave(api); });
  const flip = () => { G.flipped = true; G.answerMs = Date.now() - G.shownAt; drawGuide(); $('ratebar').querySelector('.rate')?.focus({ preventScroll: true }); };
  $('showBtn')?.addEventListener('click', flip);
  $('flash').addEventListener('click', () => { if (!G.flipped) flip(); });
  $('flash').addEventListener('keydown', e => { if (!G.flipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(); } });
  el.querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => rateGuide(+b.dataset.rate)));
}

async function rateGuide(rating) {
  if (G.busy) return;
  G.busy = true;
  const card = G.cards[G.i], now = Date.now();
  if (G.srs) {
    try {
      const next = G.srs.rate(card.id, null, rating, optsFor(card, now), now);
      await db.saveReview(next, { cardId: card.id, timestamp: now, source: 'review', mode: 'flip', correct: rating !== 1, ms: G.answerMs || now - G.shownAt, rating, state: 0 });
      G.saved++;
    } catch (err) { console.error(err); }
  }
  G.i++; G.flipped = false; G.shownAt = Date.now(); G.busy = false;
  drawGuide();
}

function drawGuideDone() {
  const { el, saved, cards } = G;
  const api = G.api, deckId = G.deckId;
  G = null;
  setFocusMode(false);
  el.innerHTML = `
    <div class="welcome">
      <div class="wl-top"><span class="brand">${MARK} Study Sprint</span></div>
      <div class="wl-done" aria-hidden="true">${icon('check')}</div>
      <h1 tabindex="-1">You are set</h1>
      <p class="lede">${saved ? `You reviewed ${plural(saved, 'card')}, and the app has scheduled them.` : `That is how a review works.`}
        Come back each day: <b>Today</b> shows what is due, and you rate each card the same way.</p>
      ${saved < cards.length ? '<p class="note">The scheduler could not load, so nothing was saved. Connect to the internet and review these cards from Today.</p>' : ''}
      <ul class="wl-points">
        <li>${icon('play')}<span><b>Today</b> has one Start button for everything due.</span></li>
        <li>${icon('bolt')}<span><b>Play</b> turns your cards into timed rounds for cramming.</span></li>
      </ul>
      <button class="btn primary wide cta" type="button" id="wlGo">Go to Today</button>
      <p class="wl-foot"><a href="#/deck/${esc(deckId)}">See the deck</a></p>
    </div>`;
  el.querySelector('h1').focus({ preventScroll: true });
  $('wlGo').addEventListener('click', () => leave(api));
}
