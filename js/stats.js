// The Stats tab: day streak, retention, reviews per day, due forecast, hardest cards and the
// mastery grid. The numbers come from stats-calc.js; this file draws them.
// Charts are plain HTML columns (not images), so they stay sharp and readable on a phone,
// work with the keyboard, and pick up the theme's colors.

import * as db from './db.js';
import { cardLevel } from './decks.js';
import { dayStreak, retention, reviewsPerDay, dueForecast, hardestCards, niceMax, dayKey, isAnswerLog, studyCalendar, buttonCounts, hourly, difficultyBands } from './stats-calc.js';
import { formatInterval } from './queue.js';
import { plainText } from './format.js';
import { $, esc, plural } from './ui.js';

// Where an answer came from, for tooltips.
const SOURCE_NAMES = { review: 'Review', play: 'Play', anki: 'Anki' };

const LEVELS = [['mature', 'Mature'], ['young', 'Young'], ['learning', 'Learning'], ['new', 'New']];
const LEVEL_NOTE = {
  new: 'Not studied yet',
  learning: 'Still learning (short steps)',
  young: 'Remembered for less than 21 days',
  mature: 'Remembered for 21 days or more'
};

let deckFilter = 'all';    // kept while the app is open
let selected = null;       // card shown in the mastery detail panel

const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const weekday = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short' });

// ---------- study calendar ----------
// A year of study days as a grid of squares (darker = more answers). Tap or hover a day to see it.
const longDate = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const dayText = d => `${longDate(d.time)}: ${d.count ? plural(d.count, 'answer') : 'no studying'}`;
function calendarHTML(cal, now) {
  const todayKey = dayKey(now);
  let lastMonth = -1;
  const cols = cal.weeks.map(week => {
    // A month's name over the first week that starts in it.
    const m = new Date(week[0].time).getMonth();
    const label = m !== lastMonth ? new Date(week[0].time).toLocaleDateString(undefined, { month: 'short' }) : '';
    lastMonth = m;
    return `<span class="cal-m">${esc(label)}</span>` + week.map(d => d.future ? '<i class="fut"></i>'
      : `<i class="lv${d.level}${dayKey(d.time) === todayKey ? ' today' : ''}" data-t="${d.time}" data-n="${d.count}" title="${esc(dayText(d))}"></i>`).join('');
  }).join('');
  return `
    <section class="card section cal-card" aria-labelledby="calTitle">
      <div class="mhead"><h2 id="calTitle">Study calendar</h2>
        <span class="muted small">Studied ${plural(cal.daysStudied, 'day')} in the past year · best streak ${plural(cal.longest, 'day')}</span></div>
      <div class="cal-scroll" id="calScroll">
        <div class="cal" role="img" aria-label="${esc(`Studied on ${cal.daysStudied} of the last ${cal.daysShown} days, ${plural(cal.answers, 'answer')} in all. Longest streak ${plural(cal.longest, 'day')}.`)}">
          <span class="cal-wd" aria-hidden="true"><b></b><b>Mon</b><b></b><b>Wed</b><b></b><b>Fri</b><b></b><b></b></span>
          <div class="cal-grid" id="calGrid" aria-hidden="true">${cols}</div>
        </div>
      </div>
      <div class="cal-foot">
        <span class="muted small" id="calInfo" aria-live="polite">Tap a day to see it.</span>
        <span class="cal-key muted small" aria-hidden="true">Less <i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i> More</span>
      </div>
    </section>`;
}
function wireCalendar() {
  const box = $('calScroll');
  if (!box) return;
  box.scrollLeft = box.scrollWidth;            // newest weeks are on the right
  $('calGrid').addEventListener('click', e => {
    const cell = e.target.closest('i[data-t]');
    if (!cell) return;
    $('calGrid').querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
    cell.classList.add('sel');
    $('calInfo').textContent = dayText({ time: +cell.dataset.t, count: +cell.dataset.n });
  });
}

export async function renderStats(el) {
  const [decks, allCards, states, allLogs] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getAll('reviewLog')]);
  decks.sort((a, b) => a.created - b.created);
  if (deckFilter !== 'all' && !decks.some(d => d.id === deckFilter)) deckFilter = 'all';
  const statesById = new Map(states.map(s => [s.cardId, s]));
  const now = Date.now();

  // Everything below the filter uses the chosen deck. The streak counts studying in any deck.
  const cards = deckFilter === 'all' ? allCards : allCards.filter(c => c.deckId === deckFilter);
  const ids = new Set(cards.map(c => c.id));
  const logs = allLogs.filter(l => ids.has(l.cardId));
  const streak = dayStreak(allLogs.filter(isAnswerLog), now);
  const ret = retention(logs, now);
  const perDay = reviewsPerDay(logs, now);
  const forecast = dueForecast(cards.map(c => statesById.get(c.id)), now);
  const hardest = hardestCards(cards, statesById, logs, now);
  const counts = { new: 0, learning: 0, young: 0, mature: 0 };
  cards.forEach(c => counts[cardLevel(statesById.get(c.id))]++);
  const total30 = perDay.reduce((n, d) => n + d.total, 0);
  const cal = studyCalendar(logs.filter(isAnswerLog), now);
  const buttons = buttonCounts(logs, now);
  const hours = hourly(logs, now);
  const bands = difficultyBands(cards.map(c => statesById.get(c.id)));
  const hourName = h => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">PROGRESS</span><h1>Stats</h1></div></div>
    ${!allCards.length ? `<div class="empty"><b>No cards yet.</b><br>Add a deck and study it to see your stats here.<br><a class="btn primary" href="#/import">Import cards</a></div>` : `
    <div class="filter-row">
      <select id="sDeck" class="select" aria-label="Show stats for">
        <option value="all">All decks</option>
        ${decks.map(d => `<option value="${esc(d.id)}" ${d.id === deckFilter ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
    </div>

    <div class="pgrid">
      <div class="card">
        <h2>Day streak</h2>
        <div class="big">${streak.days}<small>${streak.days === 1 ? 'day' : 'days'}</small></div>
        <p>${streak.days === 0 ? 'Review or play today to start a streak.' : streak.studiedToday ? 'You studied today.' : 'Study today to keep it going.'} Any deck counts.</p>
        <div class="week" aria-label="Last 7 days">${streak.week.map(d => `
          <div class="wd${d.on ? ' on' : ''}${d.today ? ' today' : ''}" title="${esc(shortDate(d.time))}${d.on ? ', studied' : ''}">
            <i></i><span>${esc(weekday(d.time).slice(0, 2))}</span></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h2>Retention</h2>
        <div class="big">${ret.rate === null ? '–' : Math.round(ret.rate * 100)}<small>${ret.rate === null ? '' : '%'}</small></div>
        <p>${ret.total ? `You remembered ${ret.remembered} of ${plural(ret.total, 'due review')} in the last 30 days.` : 'Shows how often you remember cards when they come due. Nothing has come due in the last 30 days yet.'}</p>
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
        tip: (d, i) => [plural(d.count, 'card'), i === 0 ? 'Due today (including overdue)' : `Due ${weekday(d.time)} ${shortDate(d.time)}`],
        tableHead: ['Day', 'Cards due'],
        tableRow: (d, i) => [i === 0 ? 'Today' : `${weekday(d.time)} ${shortDate(d.time)}`, d.count],
        label: 'Cards due on each of the next 7 days'
      })}
    </section>

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

    <section class="card section" aria-labelledby="hardTitle">
      <div class="mhead"><h2 id="hardTitle">Hardest cards</h2>
        ${hardest.length ? '<button class="btn ghost small" type="button" id="drillBtn">Drill these</button>' : ''}</div>
      ${hardest.length ? `<ol class="hard-list">${hardest.map(h => `
        <li><div class="f">${esc(plainText(h.card.front))}</div>
          <div class="b">${esc(plainText(h.card.back))}</div>
          <div class="n mono">${h.lapses ? `Forgotten ${h.lapses}×` : ''}${h.lapses && h.misses ? ' · ' : ''}${h.misses ? `missed ${h.misses}× in 30 days` : ''}</div></li>`).join('')}</ol>`
      : '<p class="muted">Cards you forget or miss show up here, so you can drill them in Play.</p>'}
    </section>

    <section class="card section" aria-labelledby="mTitle">
      <div class="mhead"><h2 id="mTitle">Mastery</h2><span class="muted small">${counts.mature} of ${plural(cards.length, 'card')} mature</span></div>
      <div class="mbar" aria-hidden="true">${LEVELS.map(([k]) => counts[k] ? `<span class="lv-${k}" style="width:${(counts[k] / cards.length * 100).toFixed(2)}%"></span>` : '').join('')}</div>
      <div class="legend">${LEVELS.map(([k, name]) => `<span><i class="sw lv-${k}"></i>${name} <b>${counts[k]}</b></span>`).join('')}</div>
      <div class="mdetail" id="mDetail" aria-live="polite"></div>
      <div id="mGrid">${(deckFilter === 'all' ? decks : decks.filter(d => d.id === deckFilter)).map(d => {
        const dc = cards.filter(c => c.deckId === d.id).sort((a, b) => a.created - b.created);
        if (!dc.length) return '';
        return `<div class="mdeck">${deckFilter === 'all' ? `<h3>${esc(d.name)}</h3>` : ''}<div class="mtiles">${dc.map(c => {
          const lvl = cardLevel(statesById.get(c.id));
          return `<button type="button" class="mtile lv-${lvl}" data-card="${esc(c.id)}" aria-pressed="${selected === c.id}" aria-label="${esc(plainText(c.front))}: ${lvl}"></button>`;
        }).join('')}</div></div>`;
      }).join('')}</div>
      <p class="note">Levels come from the review schedule: Young means remembered for under 21 days, Mature 21 days or more.</p>
    </section>`}`;

  if (!allCards.length) return;
  $('sDeck').addEventListener('change', e => { deckFilter = e.target.value; selected = null; renderStats(el); });
  el.querySelectorAll('.chart').forEach(wireChart);
  wireCalendar();
  $('drillBtn')?.addEventListener('click', async () => (await import('./play.js')).drillCards(hardest.map(h => h.card.id)));

  // Mastery grid: tap a card to see its details and recent answers.
  const logsByCard = new Map();
  for (const l of logs) { if (!logsByCard.has(l.cardId)) logsByCard.set(l.cardId, []); logsByCard.get(l.cardId).push(l); }
  const showDetail = () => {
    const c = cards.find(x => x.id === selected);
    if (!c) { $('mDetail').innerHTML = '<p class="muted">Tap a square to see that card.</p>'; return; }
    const st = statesById.get(c.id);
    const lvl = cardLevel(st);
    const recent = (logsByCard.get(c.id) || []).filter(isAnswerLog).sort((a, b) => a.timestamp - b.timestamp).slice(-10);
    const due = !st || st.state === 0 ? '' : st.due <= now ? 'Due now' : `Due in ${formatInterval(st.due - now)}`;
    $('mDetail').innerHTML = `
      <div class="f">${esc(plainText(c.front))}</div>
      <div class="b">${esc(plainText(c.back))}</div>
      <div class="meta"><span><i class="sw lv-${lvl}"></i>${LEVEL_NOTE[lvl]}</span>${due ? `<span>${due}</span>` : ''}
        ${st && st.state !== 0 ? `<span>${plural(st.reps, 'review')}, forgotten ${st.lapses}×</span>` : ''}</div>
      <div class="meta">${recent.length ? `<span aria-label="Last ${recent.length} answers, oldest first: ${recent.map(l => l.correct ? 'right' : 'wrong').join(', ')}">Last answers ${recent.map(l =>
        `<i class="hd ${l.correct ? 'y' : 'n'}" title="${SOURCE_NAMES[l.source] || 'Review'}, ${l.correct ? 'right' : 'wrong'}"></i>`).join('')}</span>` : '<span>No answers yet</span>'}</div>`;
  };
  $('mGrid').addEventListener('click', e => {
    const b = e.target.closest('.mtile'); if (!b) return;
    selected = selected === b.dataset.card ? null : b.dataset.card;
    el.querySelectorAll('.mtile').forEach(t => t.setAttribute('aria-pressed', String(t.dataset.card === selected)));
    showDetail();
  });
  showDetail();
}

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
