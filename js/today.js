// The Today screen: the app's home. What to study right now, in one tap.
//   - daily goal ring, day streak, and one big Start button for everything due
//   - a row per course (top-level deck) with its due and new cards, and one tap to study just that deck
//   - upcoming exams
//   - Options (a sheet): which decks, how to answer (flip or type) and Custom study. Nothing from the old
//     Review setup screen was removed; it all lives there now.
// Starting a session hands over to review.js through setLaunch() (see study-data.js).

import * as db from './db.js';
import { dayStart } from './days.js';
import { loadAll, countFor, answeredToday, nextDueText, typicalCardMs, loadStreak, minutesText, launchStudy, scopeKey, customQueue, live } from './study-data.js';
import { examInfo, countdown, badgeClass, newPerDayToFinish } from './exam.js';
import { extraNewToday, NEW } from './queue.js';
import { subtreeIds, ancestors, deckPath, effectiveDeck } from './deck-tree.js';
import { $, esc, plural, toast, openSheet, closeSheet, icon, ring } from './ui.js';
import { addSampleDeck } from './sample.js';
import { drawCard as drawInstallCard } from './install.js';
import { openExamSheet } from './exam-sheet.js';
import * as fx from './fx.js';
import { drawSidebar } from './sidebar.js';

// Start a study session (see launchStudy in study-data.js), with two things first:
//   - if a session is in progress, Start carries on with it when it covers the same decks, and otherwise asks,
//     because a new session replaces it (its answers are saved, but they could no longer be undone)
//   - Review's code is loaded before leaving this screen, so a failed load (offline on a first visit) shows a message here
//     instead of a broken screen
// Also used by the Decks screen and deck pages.
export async function startStudy(spec = {}) {
  try { await import('./review.js'); } catch {
    toast("Couldn't open Review. Check your connection and try again.");
    return;
  }
  const r = live.resume;
  const going = r && r.day === dayStart() && r.version === db.scheduleVersion() ? r : null;
  if (!going) return launchStudy(spec);
  if (going.scope === scopeKey(spec.deckIds, spec.kind, spec.days)) { location.hash = `#/review${going.deckId ? '/' + encodeURIComponent(going.deckId) : ''}`; return; }
  openSheet(`
    <h2 id="sheetTitle">Start over?</h2>
    <p>You have a session in progress (${plural(going.left, 'card')} left). Starting a new one replaces it: your answers so far are saved, but you'll lose this session's undo.</p>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="soKeep">Keep going</button>
      <button class="btn primary" type="button" id="soNew">Start over</button>
    </div>`);
  $('soKeep').addEventListener('click', () => { closeSheet(); location.hash = `#/review${going.deckId ? '/' + encodeURIComponent(going.deckId) : ''}`; });
  $('soNew').addEventListener('click', () => { closeSheet(); launchStudy(spec); });
}
const launch = startStudy;
const EXAM_CHIPS = 4;            // how many courses the "Add exam date" row offers; the rest are one tap away in Decks

export async function renderToday(el) {
  const data = await loadAll({ history: true });        // with the last 60 days of the log, not all of it
  const streak = await loadStreak(data.history);
  if (!el.isConnected) return;
  const cardMs = typicalCardMs(data.history);
  const allIds = data.decks.map(d => d.id);
  let chosen = data.settings.reviewDecks.filter(id => allIds.includes(id));
  let typing = data.settings.reviewTyping;
  const top = data.decks.filter(d => !data.depth.get(d.id));       // courses: decks not inside another deck

  // Nothing to study at all (after Skip in the first-run start, or after deleting everything): not a dead end.
  // Paste notes (into the course, when there is just one), try the sample cards, or read how it works again.
  const emptyToday = () => {
    const courses = top.filter(d => d.id !== 'sample');
    const art = '<svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true"><rect x="34" y="10" width="62" height="74" rx="10" fill="none" stroke="var(--line-strong)" stroke-width="2" transform="rotate(8 65 47)"/><rect x="24" y="14" width="62" height="74" rx="10" fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="2"/><path d="M58 30l-12 18h9l-2 14 12-18h-9z" fill="var(--accent)" style="filter:drop-shadow(0 0 6px var(--glow))"/><circle cx="96" cy="20" r="2.5" fill="var(--accent-text)"/><circle cx="104" cy="34" r="1.8" fill="var(--accent-text)"/><circle cx="14" cy="70" r="2" fill="var(--accent-text)"/></svg>';
    return `<div class="empty empty-first">${art}<b>Nothing to study yet</b>
      <p>Paste your lecture notes and Study Sprint turns them into cards. Or try 12 sample cards first.</p>
      <div class="empty-btns"><a class="btn primary" href="#/import${courses.length === 1 ? '/' + encodeURIComponent(courses[0].id) : ''}">${icon('paste')} Paste notes</a>
        <button class="btn ghost" type="button" id="trySample">Try sample cards</button></div>
      <a class="fr-how" href="#/welcome/again">How it works ›</a></div>`;
  };

  // ----- the screen -----
  const draw = () => {
    const ids = chosen.length ? chosen : allIds;
    const c = countFor(data, ids);
    drawSidebar({ data, streak, chosen });          // the sidebar shows the same count as Start, from the data loaded here
    const day = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    const answered = answeredToday(data, chosen);          // the same decks as the cards still to go
    const goal = answered + c.total;
    const resume = live.resume && live.resume.day === dayStart() && live.resume.version === db.scheduleVersion() ? live.resume : null;
    const exams = data.decks.map(deck => ({ deck, info: examInfo(deck) })).filter(e => e.info).sort((a, b) => a.info.daysLeft - b.info.daysLeft).slice(0, 3);
    const noExam = coursesWithoutExam();
    el.innerHTML = `
      <div class="screen-head">
        <div><span class="eyebrow mono">${esc(day.toUpperCase())}</span><h1>Today</h1></div>
        ${data.decks.length ? `<div class="head-actions"><button class="btn ghost small" type="button" id="optBtn">${icon('sliders')} Options</button></div>` : ''}
      </div>
      ${!data.cards.length && !data.hiddenCount ? emptyToday()
      : `
      ${resume ? `<div class="resume">
        <span>${icon('clock')} Session in progress · ${plural(resume.left, 'card')} left</span>
        <a class="btn small primary" id="resumeBtn" href="#/review${resume.deckId ? '/' + encodeURIComponent(resume.deckId) : ''}">Resume</a></div>` : ''}
      <section class="today-hero" aria-label="Today's goal">
        <div class="th-main">
          ${ring(goal ? answered / goal : 0, 84, 8, c.total || !answered ? `<b class="mono">${answered}</b><small class="mono">/${goal}</small>` : icon('check', 'ring-check'))}
          <div class="th-text">
            <span class="th-label mono">DAILY GOAL</span>
            <b class="th-big">${c.total ? `${c.total} to go` : 'All done'}</b>
            <span class="th-sub"><b data-count="due">${c.due}</b> due · <b data-count="new">${c.fresh}</b> new</span>
            <span class="th-sub">${plural(answered, 'answer')} today</span>
          </div>
        </div>
        <p class="streak ${streak.studiedToday ? 'kept' : ''}">${icon('flame')}<b class="mono">${streak.days}</b> day streak
          <span>${streak.studiedToday ? 'Kept for today' : streak.days ? 'Study today to keep it' : 'Study today to start one'}</span></p>
        ${c.total
          ? `<button class="btn primary wide big" type="button" id="startBtn">${icon('play')} Start · ${plural(c.total, 'card')} · ${minutesText(c.total, cardMs)}</button>`
          : `<div class="th-done"><b>All done for today</b>
              <p>Nothing is due right now. ${nextDueText(data, c.cards)}${data.hiddenCount ? ` ${plural(data.hiddenCount, 'card')} ${data.hiddenCount === 1 ? 'is' : 'are'} suspended or buried.` : ''}</p>
              <a class="btn primary wide big" href="#/play">${icon('bolt')} Play a round</a></div>`}
      </section>
      <div id="installSlot"></div>
      ${chosen.length ? `<p class="note filtered">Showing ${chosen.length} of ${plural(allIds.length, 'deck')}. <button class="link" type="button" id="allDecksBtn">Show all</button></p>` : ''}
      ${exams.length ? `
      <section class="section" aria-labelledby="exTitle">
        <h2 id="exTitle">Upcoming exams</h2>
        <div class="exams">${exams.map(({ deck, info }) => `
          <div class="exam-row" style="--deck:${esc(deck.color)}">
            <a href="#/deck/${esc(deck.id)}" class="exam-link">${icon('calendar')}<span class="exam-name">${esc(deckPath(data.decks, deck.id))}</span><span class="${badgeClass(info)}">${esc(countdown(info))}</span></a>
            <button class="btn ghost small" type="button" data-prep="${esc(deck.id)}">Exam prep</button>
            ${newPlanHTML(deck, info)}
          </div>`).join('')}</div>
      </section>` : ''}
      ${noExam.length ? `
      <div class="exam-add" role="group" aria-label="Add an exam date">
        <span>Add exam date</span>
        ${noExam.slice(0, EXAM_CHIPS).map(d => `<button type="button" class="exam-chip" data-addexam="${esc(d.id)}" aria-label="Add exam date for ${esc(d.name)}"><i style="background:${esc(d.color)}"></i>${esc(d.name)} ${icon('plus')}</button>`).join('')}
        ${noExam.length > EXAM_CHIPS ? `<a class="link" href="#/decks">${noExam.length - EXAM_CHIPS} more in Decks</a>` : ''}
      </div>` : ''}
      <section class="section" aria-labelledby="tdTitle">
        <div class="sec-head"><h2 id="tdTitle">Your decks</h2><a class="link" href="#/decks">All decks</a></div>
        <div class="tdecks">${top.map(deckRow).join('')}</div>
      </section>`}`;
    wire(c);
    fx.goalRing(el, answered, goal);
    drawInstallCard($('installSlot'));        // only after a finished Review session, see install.js
  };

  // Courses (top-level decks with cards) that have no exam coming up, the biggest first. The sample deck is left out.
  const coursesWithoutExam = () => {
    const size = new Map();
    for (const c of data.cards) size.set(c.deckId, (size.get(c.deckId) || 0) + 1);
    const cardsIn = d => [...subtreeIds(data.decks, d.id)].reduce((n, id) => n + (size.get(id) || 0), 0);
    return top.filter(d => d.id !== 'sample' && !examInfo(d)).map(d => [d, cardsIn(d)]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  };
  // "24 new a day to finish by 6 Nov", with a button to set the deck's limit to that (it asks first).
  // Cards not started yet are counted in the deck and its subdecks. Nothing shows when there are none left.
  const newPlan = (deck, info) => {
    const inside = subtreeIds(data.decks, deck.id);
    const unstarted = data.cards.filter(c => inside.has(c.deckId) && !(data.statesById.get(c.id)?.state > NEW)).length;
    const n = newPerDayToFinish(unstarted, info.daysLeft);
    // What a day allows: the lowest of the limits that apply, each raised by today's Custom study extra.
    // Limits other than the deck's own are listed in `others`; the deck's own limit is the one the button sets.
    const own = d => (Number.isFinite(d.newPerDay) ? d.newPerDay + data.extra : Infinity);
    const left = new Map();                                 // deck id → unstarted cards sitting directly in it
    for (const c of data.cards) if (!(data.statesById.get(c.id)?.state > NEW)) left.set(c.deckId, (left.get(c.deckId) || 0) + 1);
    // How many new cards a day a deck and its subdecks can start: its own limit, or what its cards and subdecks allow.
    const startable = (d, ownToo = true) =>
      Math.min(ownToo ? own(d) : Infinity, (left.get(d.id) || 0) + data.decks.filter(k => k.parentId === d.id).reduce((t, k) => t + startable(k), 0));
    const others = [
      { limit: data.settings.newPerDay + data.extra, text: `Raise New cards per day in Settings to ${n}.` },
      ...ancestors(data.decks, deck.id).slice(1).filter(d => Number.isFinite(d.newPerDay))
        .map(d => ({ limit: own(d), text: `${d.name} limits it to ${own(d)} a day: raise that in its Edit deck.` })),
      { limit: startable(deck, false), text: 'A subdeck\'s own limit holds it back: raise that in its Edit deck.' }
    ];
    const lowest = others.reduce((a, b) => (b.limit < a.limit ? b : a));
    return { unstarted, n, now: Math.min(own(deck), lowest.limit), blocked: lowest.limit < n ? lowest.text : '' };
  };
  const newPlanHTML = (deck, info) => {
    const { unstarted, n, now, blocked } = newPlan(deck, info);
    if (!unstarted || info.daysLeft < 1) return '';
    const by = new Date(info.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    // A button only when setting this deck's limit is enough; otherwise say which limit holds it back.
    return `<p class="exam-new" data-newplan="${esc(deck.id)}">
      <span><b>${n} new a day</b> to start all ${plural(unstarted, 'unstarted card')} by ${esc(by)}${n > 60 ? ' (that is a lot: start sooner if you can)' : ''}.</span>
      ${now >= n ? `<span class="on-track small">${icon('check')} On track</span>`
        : blocked ? `<span class="small" data-blocked>${esc(blocked)}</span>`
        : `<button class="btn ghost small" type="button" data-setnew="${esc(deck.id)}">Set to ${n} a day</button>`}</p>`;
  };
  // The confirm is a sheet in the page (not the browser's confirm box).
  const askSetNew = deckId => {
    const deck = data.decks.find(d => d.id === deckId);
    const info = examInfo(deck);
    if (!deck || !info) return;
    const { n } = newPlan(deck, info);
    openSheet(`
      <h2 id="sheetTitle">Set ${n} new cards a day?</h2>
      <p><b>${esc(deck.name)}</b> will give you up to ${n} new cards a day, enough to start every card with ${info.daysLeft === 1 ? '1 day' : info.daysLeft + ' days'} to go. Now it allows ${Number.isFinite(deck.newPerDay) ? deck.newPerDay : 'the overall limit of ' + data.settings.newPerDay}. You can change it any time in Edit deck.</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="snNo">Cancel</button>
        <button class="btn primary" type="button" id="snYes">Set ${n} a day</button>
      </div>`);
    $('snNo').addEventListener('click', closeSheet);
    $('snYes').addEventListener('click', async () => {
      await db.saveDeck({ ...deck, newPerDay: n });
      closeSheet();
      toast(`${deck.name}: ${n} new cards a day`);
      renderToday(el);
    });
  };

  // One course: counts for the deck and its subdecks. A tap starts it (or opens it, when nothing is due).
  const deckRow = deck => {
    const c = countFor(data, [deck.id]);
    const info = examInfo(deck);
    // A course with no cards at all is not "done": it says so and offers Add cards (instead of a green tick).
    const inside = subtreeIds(data.decks, deck.id);
    const empty = !c.total && ![...data.deckOf.values()].some(id => inside.has(id));
    if (empty) return `<a class="tdeck fr-emptydeck" href="#/import/${esc(deck.id)}" style="--deck:${esc(deck.color)}" aria-label="${esc(deck.name)}: no cards yet. Add cards">
      <span class="td-main">
        ${deck.course ? `<span class="deck-code">${esc(deck.course)}</span>` : ''}
        <span class="td-name">${esc(deck.name)}</span>
        <span class="td-counts"><span>No cards yet</span>${info ? ` <span class="${badgeClass(info)}">${esc(countdown(info))}</span>` : ''}</span>
      </span>
      <span class="td-go"><span class="fr-add">${icon('plus')} Add cards</span></span></a>`;
    const inner = `
      <span class="td-main">
        ${deck.course ? `<span class="deck-code">${esc(deck.course)}</span>` : ''}
        <span class="td-name">${esc(deck.name)}</span>
        <span class="td-counts"><span class="due${c.due ? "" : " zero"}"><b>${c.due}</b> due</span> <span><b>${c.fresh}</b> new</span>
          ${info ? `<span class="${badgeClass(info)}">${esc(countdown(info))}</span>` : ''}</span>
      </span>
      <span class="td-go">${c.total ? `<span class="td-min">${minutesText(c.total, cardMs)}</span>${icon('play')}` : icon('check')}</span>`;
    return c.total
      ? `<button class="tdeck" type="button" data-start="${esc(deck.id)}" style="--deck:${esc(deck.color)}" aria-label="Study ${esc(deck.name)}: ${plural(c.total, 'card')}">${inner}</button>`
      : `<a class="tdeck done" href="#/deck/${esc(deck.id)}" style="--deck:${esc(deck.color)}" aria-label="${esc(deck.name)}: all done. Open deck">${inner}</a>`;
  };

  const wire = c => {
    $('trySample')?.addEventListener('click', async e => {
      e.currentTarget.disabled = true;
      await addSampleDeck();
      location.hash = '#/welcome/review/sample';          // three guided cards, then "Add your own cards"
    });
    $('startBtn')?.addEventListener('click', () => launch({ deckIds: chosen }));
    $('optBtn')?.addEventListener('click', () => openOptions());
    $('allDecksBtn')?.addEventListener('click', () => { chosen = []; db.setSetting('reviewDecks', chosen); draw(); });
    el.querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => launch({ deckIds: [b.dataset.start], deckId: b.dataset.start })));
    el.querySelectorAll('[data-setnew]').forEach(b => b.addEventListener('click', () => askSetNew(b.dataset.setnew)));
    el.querySelectorAll('[data-addexam]').forEach(b => b.addEventListener('click', () => openExamSheet(b.dataset.addexam, () => renderToday(el))));
    el.querySelectorAll('[data-prep]').forEach(b => b.addEventListener('click', () => launch({ deckIds: [b.dataset.prep], deckId: b.dataset.prep, kind: 'prep' })));
  };

  // ----- Options (a sheet): decks, answer by, custom study -----
  const openOptions = (focusSel) => {
    const first = !$('sheet').open;
    openSheet(`
      <h2 id="sheetTitle">Study options</h2>
      <section class="section">
        <h3 class="label" id="optDecksLbl">Decks</h3>
        <div class="chips" id="deckChips" role="group" aria-labelledby="optDecksLbl">
          <button type="button" class="tchip" data-all aria-pressed="${!chosen.length}">All decks</button>
          ${data.decks.map(d => {
            const dc = countFor(data, [d.id]);
            const depth = data.depth.get(d.id);
            return `<button type="button" class="tchip" data-deck="${esc(d.id)}" aria-pressed="${chosen.includes(d.id)}" ${depth ? `title="${esc(deckPath(data.decks, d.id))}"` : ''}>
              ${depth ? `<span class="sub-mark" aria-hidden="true">${icon('sub')}</span>` : ''}<i class="dot" style="background:${esc(d.color)}"></i>${esc(d.name)} <small class="mono">${dc.due}·${dc.fresh}</small></button>`;
          }).join('')}
        </div>
        <p class="note">Numbers show due · new for each deck (with its subdecks). You get up to ${data.settings.newPerDay}${data.extra ? ` + ${data.extra} extra` : ''} new cards a day (change it in Settings, or for one deck with its Edit button).</p>
      </section>
      <section class="section">
        <h3 class="label" id="optModeLbl">Answer by</h3>
        <div class="chips" id="modeChips" role="group" aria-labelledby="optModeLbl">
          <button type="button" class="tchip" data-typing="0" aria-pressed="${!typing}">Flipping the card</button>
          <button type="button" class="tchip" data-typing="1" aria-pressed="${typing}">Typing the answer</button>
        </div>
        <p class="note">Typing is used for answers of 40 characters or less. Longer ones are flipped.</p>
      </section>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="customBtn">Custom study…</button>
        <button class="btn primary" type="button" id="optDone">Done</button>
      </div>`);
    const sheet = $('sheet');
    // The screen behind is redrawn when a deck is picked, so the Options button it opened from is a new one: when
    // the sheet closes, put focus back on it (otherwise it would fall to the top of the page).
    if (first) sheet.addEventListener('close', () => $('optBtn')?.focus(), { once: true });
    sheet.querySelector('[data-all]').addEventListener('click', () => { chosen = []; pick(); openOptions('[data-all]'); });
    sheet.querySelectorAll('[data-deck]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.deck;
      chosen = chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id];
      pick(); openOptions(`[data-deck="${CSS.escape(id)}"]`);
    }));
    sheet.querySelectorAll('[data-typing]').forEach(b => b.addEventListener('click', () => {
      typing = b.dataset.typing === '1';
      db.setSetting('reviewTyping', typing);
      openOptions(`[data-typing="${b.dataset.typing}"]`);
    }));
    $('customBtn').addEventListener('click', () => openCustomStudy());
    $('optDone').addEventListener('click', closeSheet);
    if (focusSel) sheet.querySelector(focusSel)?.focus();
  };
  // Remember the deck choice, and update the Today screen behind the sheet.
  const pick = () => { db.setSetting('reviewDecks', chosen); draw(); };

  // ----- Custom study: extra study beyond today's cards (like Anki's Custom study) -----
  function openCustomStudy() {
    const cards = countFor(data, chosen.length ? chosen : allIds).cards;
    const forgot = customQueue('forgot', data, cards);
    const prep = customQueue('prep', data, cards);
    const isNew = c => { const st = data.statesById.get(c.id); return !st || st.state === NEW; };
    const newAvail = cards.filter(isNew).length;
    let days = 3, extra = 10;
    // Decks here with an exam coming up (subdecks use their parent's date unless they set one): only those with cards
    // that Exam prep would cover.
    const examOf = new Map(data.decks.map(d => [d.id, examInfo(effectiveDeck(data.decks, d.id))]));
    const exams = data.decks.map(deck => ({ deck, info: examInfo(deck) }))
      .filter(e => e.info && cards.some(c => subtreeIds(data.decks, e.deck.id).has(c.deckId) && examOf.get(c.deckId)));

    openSheet(`
      <h2 id="sheetTitle">Custom study</h2>
      <p class="note" style="margin-top:0">For the decks chosen in Options.</p>
      <div class="cs-opt">
        <b>More new cards today</b>
        <p>Raises today's new card limit (each deck's own limit too). It goes back to normal tomorrow. ${plural(newAvail, 'new card')} available.</p>
        <div class="cs-row">
          <div class="stepper">
            <button type="button" class="icon-btn" id="csMinus" aria-label="Fewer">−</button>
            <input id="csNew" type="number" inputmode="numeric" min="1" max="999" value="${extra}" aria-label="Extra new cards">
            <button type="button" class="icon-btn" id="csPlus" aria-label="More">+</button>
          </div>
          <button class="btn primary small" type="button" id="csNewBtn" ${newAvail ? '' : 'disabled'}>Add</button>
        </div>
      </div>
      <div class="cs-opt">
        <b id="csAheadLbl">Review ahead</b>
        <p>Study cards that aren't due yet, for example before an exam. Each one is rescheduled from today.</p>
        <div class="chips" role="group" aria-labelledby="csAheadLbl">
          ${[[1, 'Tomorrow'], [3, '3 days'], [7, '1 week'], [14, '2 weeks']].map(([d, l]) =>
            `<button type="button" class="tchip" data-days="${d}" aria-pressed="${d === days}">${l}</button>`).join('')}
        </div>
        <button class="btn primary small" type="button" id="csAheadBtn"></button>
      </div>
      ${exams.length ? `<div class="cs-opt">
        <b>Exam prep</b>
        <p>${esc(exams.map(e => `${e.deck.name}: ${countdown(e.info).toLowerCase()}`).join(' · '))}. Go over every card you haven't seen in the last 3 days, weakest first, then any you haven't started.</p>
        <button class="btn primary small" type="button" id="csPrepBtn" ${prep.queue.length ? '' : 'disabled'}>${prep.queue.length ? `Review ${plural(prep.queue.length, 'card')}` : 'All seen recently'}</button>
      </div>` : ''}
      <div class="cs-opt">
        <b>Cards I forgot today</b>
        <p>Go over every card you pressed Again on, or got wrong in Play, today.</p>
        <button class="btn primary small" type="button" id="csForgotBtn" ${forgot.queue.length ? '' : 'disabled'}>${forgot.queue.length ? `Review ${plural(forgot.queue.length, 'card')}` : 'None today'}</button>
      </div>
      `);

    const drawAhead = () => {
      const n = customQueue('ahead', data, cards, days).queue.length;
      $('csAheadBtn').textContent = n ? `Review ${plural(n, 'card')}` : 'Nothing due then';
      $('csAheadBtn').disabled = !n;
    };
    drawAhead();
    document.querySelectorAll('#sheet [data-days]').forEach(b => b.addEventListener('click', () => {
      days = +b.dataset.days;
      document.querySelectorAll('#sheet [data-days]').forEach(x => x.setAttribute('aria-pressed', x === b));
      drawAhead();
    }));
    const setExtra = v => { extra = Math.max(1, Math.min(999, Math.round(Number(v) || 1))); $('csNew').value = extra; };
    $('csNew').addEventListener('change', e => setExtra(e.target.value));
    $('csMinus').addEventListener('click', () => setExtra(extra - 5));
    $('csPlus').addEventListener('click', () => setExtra(extra + 5));
    $('csNewBtn').addEventListener('click', async () => {
      setExtra($('csNew').value);
      const n = extraNewToday(data.settings.extraNew) + extra;       // adds to any extras from earlier today
      await db.setSetting('extraNew', { day: dayStart(), n });
      closeSheet();
      toast(`${plural(extra, 'extra new card')} for today`);
      renderToday(el);
    });
    const go = (kind) => { closeSheet(); launch({ deckIds: chosen, kind, days }); };
    $('csAheadBtn').addEventListener('click', () => go('ahead'));
    $('csPrepBtn')?.addEventListener('click', () => go('prep'));
    $('csForgotBtn').addEventListener('click', () => go('forgot'));
  }

  draw();
  // The browser may announce that the app can be installed a moment after this screen is drawn, or the card may be closed.
  const onInstall = () => { if (el.isConnected) drawInstallCard($('installSlot')); else window.removeEventListener('install-change', onInstall); };
  window.addEventListener('install-change', onInstall);
  // Get Review's code (and the scheduling library it loads) ready in the background, so Start is instant.
  import('./review.js').catch(() => {});
}
