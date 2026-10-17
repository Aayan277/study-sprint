// The Stats tab: day streak, retention, reviews per day, due forecast, hardest cards and the
// mastery grid. The numbers come from stats-calc.js; this file draws them.
// Charts are plain HTML columns (not images), so they stay sharp and readable on a phone,
// work with the keyboard, and pick up the theme's colors.

import * as db from './db.js';
import { dayStart } from './days.js';
import { subtreeIds, deckChoices, deckPath, effectiveDeck } from './deck-tree.js';
import { examInfo, countdown, badgeClass, readiness } from './exam.js';
import { personalW20, cleanFsrsParams } from './sched-settings.js';
import { openDeckPicker } from './deck-picker.js';
import { startStudy } from './today.js';
import { openExamSheet } from './exam-sheet.js';
import { cardLevel } from './decks.js';
import { emptyStartHTML, wireEmptyStart } from './empty-state.js';
import { isOcclusion, occLabel } from './occlusion.js';
import { imgHTML } from './media.js';
import { isHidden } from './browse-logic.js';
import { readyEstimateText, streakFromDays, restDaySet, calendarFromDays, firstAnswerTime, answerDays, daysAgoStart, retention, reviewsPerDay, dueForecast, hardestCards, niceMax, dayKey, isAnswerLog, buttonCounts, hourly, difficultyBands } from './stats-calc.js';
import { formatInterval } from './queue.js';
import { plainText, mathHTML } from './format.js';
import { esc, plural, icon, foldOpen, saveFold, ring, weekDotsHTML } from './ui.js';

// Where an answer came from, for tooltips.
const SOURCE_NAMES = { review: 'Review', play: 'Play', anki: 'Anki' };

const LEVELS = [['mature', 'Mature'], ['young', 'Young'], ['learning', 'Learning'], ['new', 'New']];
const LEVEL_NOTE = {
  new: 'Not studied yet',
  learning: 'Still learning (short steps)',
  young: 'Remembered for less than 21 days',
  mature: 'Remembered for 21 days or more'
};

// The fold only exists on phones; from 1024px wide everything is shown (styles.css hides the button).
const PHONE = matchMedia('(max-width:1023px)');
// The listener is added once; each render points onPhoneChange at its own screen.
let onPhoneChange = null;
PHONE.addEventListener('change', () => { try { onPhoneChange?.(); } catch { /* screen is gone */ } });

let deckFilter = 'all';    // kept while the app is open
let selected = null;       // card shown in the mastery detail panel

// The review log is big, so Stats avoids reading all of it. The streak and calendar only need how many answers
// each day had (counted by the database, no rows read), and the charts only need the last 30 days.
// The whole log is read only when a deck is picked (to know which answers belong to its cards).
// What was read is kept until the data changes (db.dataVersion goes up: an answer here, or changes from sync).
let cache = null;       // { day, version, days, recent, full }: each a promise, filled in as needed
async function loadLogs(needAll) {
  // A new day moves "the last 30 days"; a new data version means the log changed.
  if (cache && (cache.day !== dayStart() || cache.version !== db.dataVersion())) cache = null;
  const mine = cache = cache || { day: dayStart(), version: db.dataVersion() };
  const keep = (name, read) => {
    if (!mine[name]) mine[name] = read().catch(err => { mine[name] = null; throw err; });
    return mine[name];
  };
  const [days, recent, full] = await Promise.all([
    keep('days', async () => new Map((await db.getDayCounts()).map(([t, n]) => [dayKey(t), n]))),
    keep('recent', () => db.getLogsSince(daysAgoStart(29))),
    needAll ? keep('full', () => db.getAll('reviewLog')) : null
  ]);
  return { days, recent, full };
}

// The mastery grid draws at most this many squares up front; "Show more" adds the rest of a deck.
const TILE_BUDGET = 500, TILE_STEP = 500;

// One formatter each, made once: building a new one per date is slow (the calendar formats hundreds of days).
const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const LONG = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short' });
const HOUR = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const shortDate = t => SHORT.format(t);
const weekday = t => WEEKDAY.format(t);

// ---------- study calendar ----------
// A year of study days as a grid of squares (darker = more answers). Tap or hover a day to see it.
const longDate = t => LONG.format(t);
const dayText = d => `${longDate(d.time)}: ${d.count ? plural(d.count, 'answer') : 'no studying'}${d.frozen ? ' · streak freeze' : d.rest ? ' · day off' : ''}`;
function calendarHTML(cal, now) {
  const todayKey = dayKey(now);
  let lastMonth = -1;
  const cols = cal.weeks.map((week, wi) => {
    // A month's name over the first week that starts in it.
    const m = new Date(week[0].time).getMonth();
    // (The first column is left unnamed when the next week starts a new month: two names would run together.)
    const nextM = cal.weeks[wi + 1] ? new Date(cal.weeks[wi + 1][0].time).getMonth() : m;
    const label = m !== lastMonth && !(wi === 0 && nextM !== m) ? MONTH.format(week[0].time) : '';
    lastMonth = m;
    return `<span class="cal-m">${esc(label)}</span>` + week.map(d => d.future ? '<i class="fut"></i>'
      : `<i class="lv${d.level}${d.frozen ? ' frz' : d.rest ? ' rest' : ''}${dayKey(d.time) === todayKey ? ' today' : ''}" data-t="${d.time}" data-n="${d.count}"${d.frozen ? ' data-f="1"' : d.rest ? ' data-r="1"' : ''} title="${esc(dayText(d))}"></i>`).join('');
  }).join('');
  return `
    <section class="card section cal-card" aria-labelledby="calTitle">
      <div class="mhead"><h2 id="calTitle">Study calendar</h2>
        <span class="muted small">Studied ${plural(cal.daysStudied, 'day')} in the past year · best streak ${plural(cal.longest, 'day')}</span></div>
      <div class="cal" role="img" aria-label="${esc(`Studied on ${cal.daysStudied} of the last ${cal.daysShown} days, ${plural(cal.answers, 'answer')} in all. Longest streak ${plural(cal.longest, 'day')}.${cal.weeks.some(w => w.some(d => d.frozen)) ? ' Days covered by a streak freeze have a diagonal hatch.' : ''}`)}">
        <span class="cal-wd" aria-hidden="true"><b></b><b>Mon</b><b></b><b>Wed</b><b></b><b>Fri</b><b></b><b></b></span>
        <div class="cal-scroll" id="calScroll">
          <div class="cal-grid" id="calGrid" aria-hidden="true">${cols}</div>
        </div>
      </div>
      <div class="cal-foot">
        <span class="muted small" id="calInfo" aria-live="polite">Tap a day to see it.</span>
        <span class="cal-key muted small" aria-hidden="true">Less <i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i> More</span>
        <span class="cal-key cal-key2 muted small" aria-hidden="true"><i class="lv0 frz"></i> Streak freeze <i class="lv0 rest"></i> Day off</span>
      </div>
    </section>`;
}
function wireCalendar(el) {
  const box = el.querySelector('#calScroll');
  if (!box) return;
  const grid = el.querySelector('#calGrid');
  // Start scrolled to the newest weeks (on the right). A month name that starts before the left edge would show
  // as a cut-off "un", so those are hidden until you scroll back to them.
  const hideCutLabels = () => grid.querySelectorAll('.cal-m').forEach(m => { m.style.visibility = m.offsetLeft - grid.offsetLeft < box.scrollLeft - 1 ? 'hidden' : ''; });
  box.scrollLeft = box.scrollWidth;
  hideCutLabels();
  box.addEventListener('scroll', hideCutLabels, { passive: true });
  grid.addEventListener('click', e => {
    const cell = e.target.closest('i[data-t]');
    if (!cell) return;
    grid.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
    cell.classList.add('sel');
    el.querySelector('#calInfo').textContent = dayText({ time: +cell.dataset.t, count: +cell.dataset.n, frozen: !!cell.dataset.f, rest: !!cell.dataset.r });
  });
}

// ---------- mastery grid ----------
// One square per card, but only the first TILE_BUDGET are drawn at once: ten thousand buttons would freeze a phone.
const tileHTML = (c, lvl) => `<button type="button" class="mtile lv-${lvl}" data-card="${esc(c.id)}" aria-pressed="${selected === c.id}" aria-label="${esc(plainText(c.front))}: ${lvl}"></button>`;
const moreText = left => `Show ${left > TILE_STEP ? `${TILE_STEP.toLocaleString()} more (${left.toLocaleString()} left)` : plural(left, 'more card')}`;
const deckCards = (cards, deckId) => cards.filter(c => c.deckId === deckId).sort((a, b) => a.created - b.created);
function masteryGridHTML(decks, inside, cards, statesById) {
  let budget = TILE_BUDGET;
  return deckChoices(decks, inside).map(({ id }) => decks.find(d => d.id === id)).map(d => {
    const dc = deckCards(cards, d.id);
    if (!dc.length) return '';
    const shown = Math.min(dc.length, budget);
    budget -= shown;
    return `<div class="mdeck" data-deck="${esc(d.id)}" data-shown="${shown}">${inside?.size === 1 ? '' : `<h3>${esc(deckPath(decks, d.id))}</h3>`}
      <div class="mtiles">${dc.slice(0, shown).map(c => tileHTML(c, cardLevel(statesById.get(c.id)))).join('')}</div>
      ${shown < dc.length ? `<button type="button" class="btn ghost small mmore">${moreText(dc.length - shown)}</button>` : ''}</div>`;
  }).join('');
}

export async function renderStats(el) {
  const [decks, allCards, states, logs, settings] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), loadLogs(deckFilter !== 'all'), db.getSettings()]);
  if (!el.isConnected) return;
  decks.sort((a, b) => a.created - b.created);
  if (deckFilter !== 'all' && !decks.some(d => d.id === deckFilter)) deckFilter = 'all';
  const statesById = new Map(states.map(s => [s.cardId, s]));
  const now = Date.now();

  // Everything below the filter uses the chosen deck. The streak counts studying in any deck.
  // A deck includes its subdecks.
  const inside = deckFilter === 'all' ? null : subtreeIds(decks, deckFilter);
  const cards = inside ? allCards.filter(c => inside.has(c.deckId)) : allCards;
  const ids = inside ? new Set(cards.map(c => c.id)) : null;
  // The streak counts every deck. The calendar and charts use the chosen deck's answers.
  const allDays = logs.days;
  const pickedDays = inside ? answerDays(logs.full, ids).picked : allDays;
  const recent = ids ? logs.recent.filter(l => ids.has(l.cardId)) : logs.recent;
  const rest = restDaySet(settings);
  const streak = streakFromDays(allDays, now, { rest });
  const ret = retention(recent, now);
  const perDay = reviewsPerDay(recent, now);
  const cardStates = cards.map(c => statesById.get(c.id));
  const forecast = dueForecast(cardStates, now);
  const hardest = hardestCards(cards, statesById, recent, now);
  const reviewable = hardest.filter(h => !isHidden(h.card, now));       // "Review these" skips suspended and buried cards
  const leechCount = cards.filter(c => (c.tags || []).includes('leech')).length;
  const counts = { new: 0, learning: 0, young: 0, mature: 0 };
  cards.forEach(c => counts[cardLevel(statesById.get(c.id))]++);
  const total30 = perDay.reduce((n, d) => n + d.total, 0);
  const cal = calendarFromDays(pickedDays, now, 53, { rest, from: firstAnswerTime(pickedDays) });
  const buttons = buttonCounts(recent, now);
  const hours = hourly(recent, now);
  const bands = difficultyBands(cardStates);
  // "More stats" is folded on phones; computers show everything (styles.css), so this only matters under 1024px.
  const moreOpen = foldOpen('stats-more');
  const hourName = h => HOUR.format(new Date(2000, 0, 1, h));
  // Settings → Appearance → "Exam readiness in Stats" (on by default, this device only). On: a searchable deck picker, and
  // when one course is picked, a readiness header with Mastery right below it. Off: the plain deck list and no header.
  const scoped = settings.statsReadiness !== false;
  const course = scoped && deckFilter !== 'all' ? decks.find(d => d.id === deckFilter) : null;
  const masteryHTML = `
    <section class="card section stats-mastery${course ? ' up' : ''}" aria-labelledby="mTitle">
      <div class="mhead"><h2 id="mTitle">Mastery</h2><span class="muted small">${counts.mature} of ${plural(cards.length, 'card')} mature</span></div>
      <div class="mbar" aria-hidden="true">${LEVELS.map(([k]) => counts[k] ? `<span class="lv-${k}" style="width:${(counts[k] / cards.length * 100).toFixed(2)}%"></span>` : '').join('')}</div>
      <div class="legend">${LEVELS.map(([k, name]) => `<span><i class="sw lv-${k}"></i>${name} <b>${counts[k]}</b></span>`).join('')}</div>
      <div class="mdetail" id="mDetail" aria-live="polite"></div>
      <div id="mGrid">${masteryGridHTML(decks, inside, cards, statesById)}</div>
      <p class="note">Levels come from the review schedule: Young means remembered for under 21 days, Mature 21 days or more.</p>
    </section>`;
  // The header for one course: how many of its cards you would still remember (90% or better) on exam day, or today
  // when there is no exam, if you stopped reviewing now.
  const exam = course ? examInfo(effectiveDeck(decks, course.id)) : null;
  const readyHTML = () => {
    const r = readiness(cards, statesById, exam ? exam.start : now, personalW20(settings));
    const pct = Math.round(r.share * 100);
    const seen = cards.length - counts.new;
    const share = k => `${(counts[k] / Math.max(1, cards.length) * 100).toFixed(2)}%`;
    return `
    <section class="card ready-card" aria-labelledby="readyTitle">
      ${ring(r.share, 76, 7, `<b>${pct}<small>%</small></b>`, 'ready-ring')}
      <div class="ready-txt">
        <div class="ready-row"><h2 id="readyTitle">${exam ? 'Exam readiness' : 'Readiness today'}</h2>${exam ? `<span class="${badgeClass(exam)}">${esc(countdown(exam))}</span>` : ''}</div>
        <p class="ready-line"><b>${seen}</b>/${cards.length} seen · <b>${counts.mature}</b> mature</p>
        <div class="mbar" aria-hidden="true"><span class="lv-mature" style="width:${share('mature')}"></span><span class="lv-young" style="width:${share('young')}"></span><span class="lv-learning" style="width:${share('learning')}"></span></div>
        <p class="note ready-note">${exam ? 'Cards you would still remember (90% or better) on exam day if you stopped reviewing now.' : 'Cards you remember right now (90% or better). Add an exam date to see it for exam day.'}</p>
        <details class="fine ready-fine"><summary>How sure is this?</summary><p>${esc(readyEstimateText(cleanFsrsParams(settings.fsrsParams)))}</p></details>
        <div class="ready-acts">
          ${exam ? '<button class="btn primary small" type="button" id="readyPrep">' + icon('target') + ' Exam prep</button>' : '<button class="btn primary small" type="button" id="readyExam">' + icon('calendar') + ' Add exam date</button>'}
          <a class="btn ghost small" href="#/deck/${esc(course.id)}">Open deck</a>
        </div>
      </div>
    </section>`;
  };
  const scopeHTML = scoped ? `
    <div class="stats-scope">
      <button type="button" class="pick-btn" id="sDeckBtn" aria-haspopup="dialog" aria-label="Show stats for: ${esc(deckFilter === 'all' ? 'All decks' : deckPath(decks, deckFilter))}. Change deck">
        ${icon('search')}${course ? `<i class="dot" style="background:${esc(course.color)}"></i>` : ''}<span>${esc(deckFilter === 'all' ? 'All decks' : deckPath(decks, deckFilter))}</span>${icon('down')}</button>
      <span class="pick-hint">Search ${plural(decks.length, 'deck')}</span>
    </div>` : `
    <div class="filter-row">
      <select id="sDeck" class="select" aria-label="Show stats for">
        <option value="all">All decks</option>
        ${deckChoices(decks).map(d => `<option value="${esc(d.id)}" ${d.id === deckFilter ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}
      </select>
    </div>`;

  el.innerHTML = `
    <div class="screen-head"><div><h1>Stats</h1></div></div>
    ${!allCards.length ? emptyStartHTML({ courseId: decks.length === 1 ? decks[0].id : '' }) : `
    ${scopeHTML}
    ${course ? readyHTML() + masteryHTML : ''}

    <div class="pgrid">
      <div class="card">
        <h2>${course ? 'Overall streak' : 'Day streak'}</h2>
        <div class="big">${streak.days}<small>${streak.days === 1 ? 'day' : 'days'}</small></div>
        <p>${streak.days === 0 ? 'Review or play today to start a streak.' : streak.studiedToday ? 'You studied today.' : 'Study today to keep it going.'} ${course ? 'All decks count.' : 'Any deck counts.'}</p>
        ${weekDotsHTML(streak.week)}
        <p class="frz-note">One freeze a week covers a missed day. It doesn’t add to the count. <button class="link" type="button" id="planRest">Plan a day off</button></p>
      </div>
      <div class="card">
        <h2>Retention</h2>
        <div class="big">${ret.rate === null ? '–' : Math.round(ret.rate * 100)}<small>${ret.rate === null ? '' : '%'}</small></div>
        <p>${ret.total ? `You remembered ${ret.remembered} of ${plural(ret.total, 'due review')} in the last 30 days.` : 'Shows how often you remember cards when they come due. Nothing has come due in the last 30 days yet.'}</p>
        <details class="info-fold"><summary aria-label="What counts as a review"><span aria-hidden="true">i</span></summary>
          <span class="muted">Counts flipping, typing and Anki answers. Multiple choice isn’t counted: you can guess it.</span></details>
      </div>
    </div>

    ${calendarHTML(cal, now)}

    <section class="card section">
      <div class="mhead"><h2>Reviews per day</h2><span class="muted small">${plural(total30, 'answer')} in 30 days</span></div>
      ${columnChart({
        id: 'perDay', rows: perDay, value: d => d.total,
        x: (d, i, all) => i === 0 ? shortDate(d.time) : i === all.length - 1 ? 'Today' : i === Math.floor(all.length / 2) ? shortDate(d.time) : '',
        tip: d => [`${plural(d.total, 'answer')}`, `${dayKey(d.time) === dayKey(now) ? 'Today' : shortDate(d.time)} · ${d.review} review, ${d.play} play`],
        tableHead: ['Day', 'Review', 'Play', 'Total'],
        tableRow: d => [shortDate(d.time), d.review, d.play, d.total],
        label: 'Answers per day for the last 30 days, from Review and Play'
      })}
    </section>

    <section class="card section">
      <div class="mhead"><h2>Due in the next 7 days</h2><span class="muted small">${plural(forecast.reduce((n, d) => n + d.count, 0), 'card')}</span></div>
      ${columnChart({
        id: 'forecast', rows: forecast, value: d => d.count,
        x: (d, i) => i === 0 ? 'Today' : weekday(d.time),
        tip: (d, i) => [plural(d.count, 'card'), i === 0 ? 'Scheduled for today (before daily limits)' : `Due ${weekday(d.time)} ${shortDate(d.time)}`],
        tableHead: ['Day', 'Cards due'],
        tableRow: (d, i) => [i === 0 ? 'Today' : `${weekday(d.time)} ${shortDate(d.time)}`, d.count],
        label: 'Cards due on each of the next 7 days'
      })}
    </section>

    <section class="card section stats-hardest" aria-labelledby="hardTitle">
      <div class="mhead"><h2 id="hardTitle">Hardest cards</h2>
        ${reviewable.length ? '<button class="btn ghost small" type="button" id="drillBtn">Review these</button>' : ''}</div>
      ${hardest.length ? `<ol class="hard-list" id="hardList">${hardest.map((h, i) => `
        <li${i >= HARD_SHOWN ? ' data-more hidden' : ''}>${hardRow(h.card)}
          <div class="n">${h.lapses ? `Forgotten ${h.lapses}×` : ''}${h.lapses && h.misses ? ' · ' : ''}${h.misses ? `missed ${h.misses}× in 30 days` : ''}</div></li>`).join('')}</ol>
        ${hardest.length > HARD_SHOWN ? `<button class="btn ghost small hard-all" type="button" id="hardAll" aria-expanded="false" aria-controls="hardList">Show all ${hardest.length}</button>` : ''}`
      : '<p class="muted">Cards you forget or miss show up here, so you can go over them again.</p>'}
      ${leechCount ? `<p class="hard-fix"><a class="link" href="#/browse/leech" id="leechFix">${plural(leechCount, 'card')} to fix</a> <span class="muted small">cards you keep forgetting</span></p>` : ''}
    </section>

    <section class="more-stats">
      <button class="more-toggle" type="button" id="moreBtn" aria-expanded="${moreOpen}" aria-controls="moreBody">
        <span>More stats</span><span class="muted small">Answer buttons, time of day, difficulty${course ? '' : ', mastery'}</span>${icon('chevron')}</button>
      <div class="more-body" id="moreBody" ${moreOpen || !PHONE.matches ? '' : 'hidden'}>
    <section class="card section" aria-labelledby="btnTitle">
      <div class="mhead"><h2 id="btnTitle">Answer buttons</h2><span class="muted small">Last 30 days</span></div>
      ${[['learning', 'Learning', buttons.learningRight], ['review', 'Reviews', buttons.reviewRight]].map(([k, name, right]) => {
        const row = buttons[k], n = row.reduce((a, b) => a + b, 0);
        return `<div class="btn-row"><div class="btn-row-head"><b>${name}</b><span class="muted small">${n ? `${right}% right · ${plural(n, 'answer')}` : 'No answers yet'}</span></div>
          <div class="btn-bar" role="img" aria-label="${esc(`${name}: ${['Again', 'Hard', 'Good', 'Easy'].map((b, i) => `${b} ${row[i]}`).join(', ')}`)}">
            ${n ? row.map((c, i) => c ? `<span class="b${i + 1}" style="width:${(c / n * 100).toFixed(2)}%" title="${['Again', 'Hard', 'Good', 'Easy'][i]}: ${c}">${c / n >= 0.12 ? c : ''}</span>` : '').join('') : ''}</div></div>`;
      }).join('')}
      <div class="legend"><span><i class="sw b1"></i>Again</span><span><i class="sw b2"></i>Hard</span><span><i class="sw b3"></i>Good</span><span><i class="sw b4"></i>Easy</span></div>
      <p class="note">Mostly Good is normal. Lots of Again on reviews means cards are coming back too late: try a higher retention in Settings.</p>
    </section>

    <section class="card section">
      <div class="mhead"><h2>Time of day</h2><span class="muted small">Last 30 days</span></div>
      ${columnChart({
        id: 'hours', rows: hours, value: d => d.total,
        x: d => (d.hour % 6 === 0 ? hourName(d.hour) : ''),
        tip: d => [plural(d.total, 'answer'), `${hourName(d.hour)}${d.total ? ` · ${Math.round(d.right / d.total * 100)}% right` : ''}`],
        tableHead: ['Hour', 'Answers', 'Right'],
        tableRow: d => [hourName(d.hour), d.total, d.total ? `${Math.round(d.right / d.total * 100)}%` : '–'],
        label: 'Answers in each hour of the day over the last 30 days'
      })}
      ${(() => {
        const best = hours.filter(h => h.total >= 10).sort((a, b) => b.right / b.total - a.right / a.total)[0];
        return best ? `<p class="note">You remember most around <b>${hourName(best.hour)}</b> (${Math.round(best.right / best.total * 100)}% right).</p>` : '';
      })()}
    </section>

    <section class="card section">
      <div class="mhead"><h2>Difficulty</h2><span class="muted small">${plural(bands.reduce((n, b) => n + b.count, 0), 'studied card')}</span></div>
      ${columnChart({
        id: 'difficulty', rows: bands, value: d => d.count,
        x: d => (d.band === 1 ? 'Easy' : d.band === 10 ? 'Hard' : d.band === 5 ? '5' : ''),
        tip: d => [plural(d.count, 'card'), `Difficulty ${d.band} of 10`],
        tableHead: ['Difficulty', 'Cards'],
        tableRow: d => [`${d.band} of 10`, d.count],
        label: 'How many studied cards are at each FSRS difficulty, from 1 (easiest) to 10 (hardest)'
      })}
      <p class="note">FSRS's difficulty for each card you've studied. Hard cards come back more often.</p>
    </section>

    ${course ? '' : masteryHTML}
      </div>
    </section>`}`;

  if (!allCards.length) { wireEmptyStart(el); return; }
  const q = id => el.querySelector('#' + id);
  q('moreBtn').addEventListener('click', () => {
    const open = q('moreBtn').getAttribute('aria-expanded') !== 'true';
    q('moreBtn').setAttribute('aria-expanded', String(open));
    q('moreBody').hidden = !open;
    saveFold('stats-more', open);
  });
  // Resizing across 1024px: show everything on a computer, and go back to the saved choice on a phone.
  const syncMore = () => { if (!q('moreBody')) return; q('moreBody').hidden = PHONE.matches && q('moreBtn').getAttribute('aria-expanded') !== 'true'; };
  onPhoneChange = syncMore;
  q('sDeck')?.addEventListener('change', e => { deckFilter = e.target.value; selected = null; renderStats(el); });
  q('sDeckBtn')?.addEventListener('click', () => openDeckPicker({
    decks, selected: deckFilter === 'all' ? '' : deckFilter, title: 'Show stats for',
    onPick: id => { deckFilter = id || 'all'; selected = null; renderStats(el); }
  }));
  q('readyPrep')?.addEventListener('click', () => startStudy({ deckIds: [course.id], deckId: course.id, kind: 'prep' }));
  q('readyExam')?.addEventListener('click', () => openExamSheet(course.id, () => renderStats(el)));
  el.querySelectorAll('.chart').forEach(wireChart);
  wireCalendar(el);
  q('planRest')?.addEventListener('click', async () => {
    (await import('./streak-sheet.js')).openStreakSheet({ onChange: () => renderStats(el), returnFocus: 'planRest' });
  });
  q('hardAll')?.addEventListener('click', e => {
    const open = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    el.querySelectorAll('#hardList [data-more]').forEach(li => { li.hidden = !open; });
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.textContent = open ? 'Show fewer' : `Show all ${hardest.length}`;
  });
  q('drillBtn')?.addEventListener('click', async () => (await import('./today.js')).startStudy({ kind: 'ids', cardIds: reviewable.map(h => h.card.id) }));

  // Mastery grid: tap a card to see its details and recent answers.
  const showDetail = async () => {
    const c = selected && cards.find(x => x.id === selected);
    if (!c) { q('mDetail').innerHTML = '<p class="muted">Tap a square to see that card.</p>'; return; }
    const st = statesById.get(c.id);
    const lvl = cardLevel(st);
    const last10 = (await db.getCardLogs(c.id)).filter(isAnswerLog).slice(-10);
    if (selected !== c.id || !el.isConnected) return;         // tapped something else while that loaded
    const due = !st || st.state === 0 ? '' : st.due <= now ? 'Due now' : `Due in ${formatInterval(st.due - now)}`;
    q('mDetail').innerHTML = `
      <div class="f">${mathHTML(plainText(c.front), { inline: true })}</div>
      <div class="b">${mathHTML(plainText(c.back), { inline: true })}</div>
      <div class="meta"><span><i class="sw lv-${lvl}"></i>${LEVEL_NOTE[lvl]}</span>${due ? `<span>${due}</span>` : ''}
        ${st && st.state !== 0 ? `<span>${plural(st.reps, 'review')}, forgotten ${st.lapses}×</span>` : ''}</div>
      <div class="meta">${last10.length ? `<span aria-label="Last ${last10.length} answers, oldest first: ${last10.map(l => l.correct ? 'right' : 'wrong').join(', ')}">Last answers ${last10.map(l =>
        `<i class="hd ${l.correct ? 'y' : 'n'}" title="${SOURCE_NAMES[l.source] || 'Review'}, ${l.correct ? 'right' : 'wrong'}"></i>`).join('')}</span>` : '<span>No answers yet</span>'}</div>`;
  };
  q('mGrid').addEventListener('click', e => {
    const more = e.target.closest('.mmore');
    if (more) {                                       // draw the next part of a deck
      const box = more.closest('.mdeck');
      const dc = deckCards(cards, box.dataset.deck);
      const from = +box.dataset.shown, to = Math.min(dc.length, from + TILE_STEP);
      box.querySelector('.mtiles').insertAdjacentHTML('beforeend', dc.slice(from, to).map(c => tileHTML(c, cardLevel(statesById.get(c.id)))).join(''));
      box.dataset.shown = to;
      if (to < dc.length) more.textContent = moreText(dc.length - to); else more.remove();
      return;
    }
    const b = e.target.closest('.mtile'); if (!b) return;
    // Only the square that was selected and the new one change.
    el.querySelector('.mtile[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
    selected = selected === b.dataset.card ? null : b.dataset.card;
    if (selected) b.setAttribute('aria-pressed', 'true');
    showDetail();
  });
  showDetail();
}

// One Hardest card. A picture-hiding card shows a 40px thumbnail of the picture and the label of the hidden part
// (its front is only "Diagram: hidden part 2 of 5"); other cards show their text.
function hardRow(card) {
  if (isOcclusion(card) && card.backImage) {
    const label = occLabel(card.occlusion.masks, card.occlusion.n);
    return `<div class="hard-occ">${imgHTML(card.backImage, 'hard-thumb')}<div class="hard-occ-t">
      <div class="f">${esc(label || 'Hidden part')}</div><div class="b">${esc(plainText(card.front))}</div></div></div>`;
  }
  return `<div class="f">${mathHTML(plainText(card.front), { inline: true })}</div>
          <div class="b">${mathHTML(plainText(card.back), { inline: true })}</div>`;
}

// The Hardest cards list shows this many until "Show all".
const HARD_SHOWN = 5;

// ---------- column chart ----------
// rows: data; value(row): bar height; x(row, i, rows): axis label ('' for none);
// tip(row, i): [value line, detail line] for the tooltip; tableHead/tableRow: the "Show as table" view.
function columnChart({ id, rows, value, x, tip, tableHead, tableRow, label }) {
  const max = niceMax(Math.max(0, ...rows.map(value)));
  const peak = rows.reduce((best, r, i) => (value(r) > value(rows[best]) ? i : best), 0);
  const ticks = Number.isInteger(max / 2) ? [max, max / 2, 0] : [max, 0];   // counts are whole numbers, so no "2.5" line
  return `
    <div class="chart" id="${id}" role="group" aria-label="${esc(label)}">
      <div class="chart-plot">
        ${ticks.map(t => `<div class="chart-line" style="bottom:${(t / max) * 100}%"><span class="mono">${t.toLocaleString()}</span></div>`).join('')}
        <div class="chart-cols">${rows.map((r, i) => {
          const v = value(r);
          const [main, detail] = tip(r, i);
          return `<button type="button" class="col" data-tip="${esc(main)}" data-detail="${esc(detail)}" aria-label="${esc(`${detail}: ${main}`)}">
            <span class="bar" style="height:${(v / max) * 100}%">${i === peak && v > 0 ? `<span class="cap mono">${v.toLocaleString()}</span>` : ''}</span></button>`;
        }).join('')}</div>
      </div>
      <div class="chart-x" aria-hidden="true">${rows.map((r, i) => `<span>${esc(x(r, i, rows))}</span>`).join('')}</div>
      <div class="chart-tip" role="status" hidden><b></b><span></span></div>
    </div>
    <details class="chart-table"><summary>Show as table</summary>
      <table><thead><tr>${tableHead.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr>${tableRow(r, i).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </details>`;
}

// Tooltip on hover, tap or keyboard focus. Values go in with textContent (card text is user data).
function wireChart(chart) {
  const tipEl = chart.querySelector('.chart-tip');
  const show = col => {
    tipEl.querySelector('b').textContent = col.dataset.tip;
    tipEl.querySelector('span').textContent = col.dataset.detail;
    tipEl.hidden = false;
    const c = chart.getBoundingClientRect(), r = col.getBoundingClientRect(), bar = col.querySelector('.bar').getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const left = Math.min(Math.max(r.left + r.width / 2 - c.left - w / 2, 0), c.width - w);
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${Math.max(bar.top - c.top - tipEl.offsetHeight - 6, 0)}px`;
  };
  const hide = () => { tipEl.hidden = true; };
  chart.querySelectorAll('.col').forEach(col => {
    col.addEventListener('pointerenter', () => show(col));
    col.addEventListener('focus', () => show(col));
    col.addEventListener('click', () => show(col));
    col.addEventListener('blur', hide);
  });
  chart.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
}
