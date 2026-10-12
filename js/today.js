// The Today screen: the app's home. What to study right now, in one tap.
//   - daily goal ring, day streak, and one big Start button for everything due
//   - a row per course (top-level deck) with its due and new cards, and one tap to study just that deck
//   - upcoming exams
//   - Options (a sheet): which decks, how to answer (flip or type) and Custom study. Nothing from the old
//     Review setup screen was removed; it all lives there now.
// Starting a session hands over to review.js through setLaunch() (see study-data.js).

import * as db from './db.js';
import { dayStart } from './days.js';
import { loadAll, countFor, answeredToday, nextDueText, typicalCardMs, loadStreak, minutesText, launchStudy, customQueue, live } from './study-data.js';
import { examInfo, countdown } from './exam.js';
import { extraNewToday, NEW } from './queue.js';
import { subtreeIds, deckPath } from './deck-tree.js';
import { $, esc, plural, toast, openSheet, closeSheet, icon, ring } from './ui.js';

const launch = launchStudy;

export async function renderToday(el) {
  const data = await loadAll({ history: true });        // with the last 60 days of the log, not all of it
  const streak = await loadStreak(data.history);
  if (!el.isConnected) return;
  const cardMs = typicalCardMs(data.history);
  const allIds = data.decks.map(d => d.id);
  let chosen = data.settings.reviewDecks.filter(id => allIds.includes(id));
  let typing = data.settings.reviewTyping;
  const top = data.decks.filter(d => !data.depth.get(d.id));       // courses: decks not inside another deck

  // ----- the screen -----
  const draw = () => {
    const ids = chosen.length ? chosen : allIds;
    const c = countFor(data, ids);
    const day = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    const answered = answeredToday(data, chosen);          // the same decks as the cards still to go
    const goal = answered + c.total;
    const resume = live.resume && live.resume.day === dayStart() && live.resume.version === db.scheduleVersion() ? live.resume : null;
    const exams = data.decks.map(deck => ({ deck, info: examInfo(deck) })).filter(e => e.info).sort((a, b) => a.info.daysLeft - b.info.daysLeft).slice(0, 3);
    el.innerHTML = `
      <div class="screen-head">
        <div><span class="eyebrow mono">${esc(day.toUpperCase())}</span><h1>Today</h1></div>
        ${data.decks.length ? `<div class="head-actions"><button class="btn ghost small" type="button" id="optBtn">${icon('sliders')} Options</button></div>` : ''}
      </div>
      ${!data.cards.length && !data.hiddenCount ? `
        <div class="empty"><b>${data.decks.length ? 'No cards yet.' : 'No decks yet.'}</b><br>Add some cards to start studying.<br><a class="btn primary" href="#/import">Import cards</a></div>`
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
            <span class="th-sub mono"><b data-count="due">${c.due}</b> due · <b data-count="new">${c.fresh}</b> new</span>
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
      ${chosen.length ? `<p class="note filtered">Showing ${chosen.length} of ${plural(allIds.length, 'deck')}. <button class="link" type="button" id="allDecksBtn">Show all</button></p>` : ''}
      ${exams.length ? `
      <section class="section" aria-labelledby="exTitle">
        <h2 id="exTitle">Upcoming exams</h2>
        <div class="exams">${exams.map(({ deck, info }) => `
          <div class="exam-row" style="--deck:${esc(deck.color)}">
            <a href="#/deck/${esc(deck.id)}" class="exam-link">${icon('calendar')}<span class="exam-name">${esc(deckPath(data.decks, deck.id))}</span></a>
            <span class="exam-badge">${esc(countdown(info))}</span>
            <button class="btn ghost small" type="button" data-prep="${esc(deck.id)}">Exam prep</button>
          </div>`).join('')}</div>
      </section>` : ''}
      <section class="section" aria-labelledby="tdTitle">
        <div class="sec-head"><h2 id="tdTitle">Your decks</h2><a class="link" href="#/decks">All decks</a></div>
        <div class="tdecks">${top.map(deckRow).join('')}</div>
      </section>`}`;
    wire(c);
  };

  // One course: counts for the deck and its subdecks. A tap starts it (or opens it, when nothing is due).
  const deckRow = deck => {
    const c = countFor(data, [deck.id]);
    const info = examInfo(deck);
    const inner = `
      <span class="td-main">
        ${deck.course ? `<span class="deck-code">${esc(deck.course)}</span>` : ''}
        <span class="td-name">${esc(deck.name)}</span>
        <span class="td-counts"><span class="due"><b>${c.due}</b> due</span> <span><b>${c.fresh}</b> new</span>
          ${info ? `<span class="exam-badge">${esc(countdown(info))}</span>` : ''}</span>
      </span>
      <span class="td-go">${c.total ? `<span class="td-min mono">${minutesText(c.total, cardMs)}</span>${icon('play')}` : icon('check')}</span>`;
    return c.total
      ? `<button class="tdeck" type="button" data-start="${esc(deck.id)}" style="--deck:${esc(deck.color)}" aria-label="Study ${esc(deck.name)}: ${plural(c.total, 'card')}">${inner}</button>`
      : `<a class="tdeck done" href="#/deck/${esc(deck.id)}" style="--deck:${esc(deck.color)}" aria-label="${esc(deck.name)}: all done. Open deck">${inner}</a>`;
  };

  const wire = c => {
    $('startBtn')?.addEventListener('click', () => launch({ deckIds: chosen }));
    $('optBtn')?.addEventListener('click', () => openOptions());
    $('allDecksBtn')?.addEventListener('click', () => { chosen = []; db.setSetting('reviewDecks', chosen); draw(); });
    el.querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => launch({ deckIds: [b.dataset.start], deckId: b.dataset.start })));
    el.querySelectorAll('[data-prep]').forEach(b => b.addEventListener('click', async () => (await import('./review.js')).examPrep(b.dataset.prep)));
  };

  // ----- Options (a sheet): decks, answer by, custom study -----
  const openOptions = (focusSel) => {
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
    // Decks here with an exam coming up (subdecks use their parent's date unless they set one)
    const exams = data.decks.map(deck => ({ deck, info: examInfo(deck) }))
      .filter(e => e.info && cards.some(c => subtreeIds(data.decks, e.deck.id).has(c.deckId)));

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
      <button class="btn ghost" type="button" id="csClose">Close</button>`);

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
    $('csClose').addEventListener('click', closeSheet);
  }

  draw();
  // Get Review's code (and the scheduling library it loads) ready in the background, so Start is instant.
  import('./review.js').catch(() => {});
}
