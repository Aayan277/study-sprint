// The "Your streak" sheet (opened from Today's streak and from Stats): how the streak freeze works, the last
// 7 days, and the days off you have planned. Loaded when first opened (it is in the service worker's CORE list).
//
// Days off live in the synced setting `restDays` ({ 'YYYY-MM-DD': { on, at } }, merged per day: see sync-merge.js).
// Rules: a day off starts tomorrow, at most 60 days ahead, at most 14 days in the future at once. It can be
// removed again (on:false with a newer `at`); days that have passed are kept as they were.

import * as db from './db.js';
import { loadStreak } from './study-data.js';
import { daysAgoStart, dayKey, restDaySet } from './stats-calc.js';
import { mergeDayFlags, MAX_AHEAD_DAYS } from './sync-merge.js';
import { examInfo } from './exam.js';
import { openSheet, closeSheet, esc, icon, streakHTML, weekDotsHTML, $, toast } from './ui.js';

export { MAX_AHEAD_DAYS };             // how far ahead a day off can be planned (defined in sync-merge.js)
export const MAX_FUTURE_DAYS = 14;     // how many planned days off there can be at once

const LONG = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const niceDay = key => LONG.format(new Date(`${key}T12:00:00`));
// The key of the study day `n` days from today (negative = past).
const keyIn = (n, now = Date.now()) => dayKey(daysAgoStart(-n, now));

// Why a day can't be added as a day off ('' when it can). `future` is the planned days off that already exist.
export function restDayError(key, future, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return 'Pick a date.';
  if (key <= keyIn(0, now)) return 'Days off start tomorrow. Pick a later day.';
  if (key > keyIn(MAX_AHEAD_DAYS, now)) return `Pick a day within the next ${MAX_AHEAD_DAYS} days.`;
  if (future.includes(key)) return `${niceDay(key)} is already a day off.`;
  if (future.length >= MAX_FUTURE_DAYS) return `You can plan up to ${MAX_FUTURE_DAYS} days off ahead. Remove one first.`;
  return '';
}

// onChange runs after a day off is added or removed (the caller redraws); returnFocus is the id of the button to focus on close.
export async function openStreakSheet({ onChange = () => {}, returnFocus = '' } = {}) {
  let first = true;
  const draw = async () => {
    const [settings, decks] = await Promise.all([db.getSettings(), db.getDecks()]);
    const streak = await loadStreak(null, { settings });
    const now = Date.now();
    const today = keyIn(0, now);
    const rest = restDaySet(settings);
    const upcoming = [...rest].filter(k => k >= today).sort();
    const future = upcoming.filter(k => k > today);
    // Exam days still ahead (and within reach): one tap makes one a day off.
    const exams = new Map();
    for (const d of decks) {
      const info = examInfo(d, now);
      if (!info || info.daysLeft < 1 || info.daysLeft > MAX_AHEAD_DAYS) continue;
      const key = keyIn(info.daysLeft, now);
      if (!exams.has(key)) exams.set(key, []);
      exams.get(key).push(d.name);
    }
    openSheet(`
      <h2 id="sheetTitle">Your streak</h2>
      <div class="ys">
        ${streakHTML(streak)}
        ${weekDotsHTML(streak.week)}
        <ul class="ys-key">
          <li><i class="k-on"></i>Studied</li><li><i class="k-frz">${icon('snow')}</i>Streak freeze</li><li><i class="k-rest">${icon('moon')}</i>Day off</li>
        </ul>
        <section aria-labelledby="ysFrz">
          <h3 id="ysFrz">Streak freeze</h3>
          <p>One missed day a week is covered for you, so a single slip doesn’t end your streak. It is automatic and not saved up. A covered day keeps the streak alive but doesn’t add to the count, and two missed days in a row still break it.</p>
        </section>
        <section aria-labelledby="ysRest">
          <h3 id="ysRest">Days off</h3>
          <p>A planned day off never breaks your streak and doesn’t add to it. You can plan up to ${MAX_FUTURE_DAYS} days, starting tomorrow and up to ${MAX_AHEAD_DAYS} days ahead.</p>
          ${upcoming.length ? `<ul class="ys-list" aria-label="Days off planned">${upcoming.map(k => `
            <li><span>${icon('moon')}${esc(niceDay(k))}${k === today ? ' <small>today</small>' : ''}</span>
              ${k > today ? `<button class="link" type="button" data-rm="${esc(k)}" aria-label="Remove the day off on ${esc(niceDay(k))}">Remove</button>` : ''}</li>`).join('')}</ul>`
            : '<p class="muted small" id="ysNone">No days off planned.</p>'}
          ${exams.size ? `<div class="ys-exams" role="group" aria-label="Day off on exam day">${[...exams].map(([k, names]) => {
            // Already a day off: a plain label (not a pressed button), "Day off planned".
            if (rest.has(k)) return `<span class="tchip on">${icon('check')}Day off planned: exam day (${esc(niceDay(k))})<small>${esc(names.join(', '))}</small></span>`;
            return `<button type="button" class="tchip" data-exam-day="${esc(k)}">${icon('moon')}Day off on exam day (${esc(niceDay(k))})<small>${esc(names.join(', '))}</small></button>`;
          }).join('')}</div>` : ''}
          <form id="ysForm" class="ys-add" novalidate>
            <label class="field"><span>Add a day off</span>
              <input id="ysDate" type="date" min="${keyIn(1, now)}" max="${keyIn(MAX_AHEAD_DAYS, now)}" aria-describedby="ysErr"></label>
            <button class="btn primary" type="submit">Add</button>
          </form>
          <p class="err" id="ysErr" role="alert" hidden></p>
        </section>
      </div>
      <div class="sheet-actions"><button class="btn primary" type="button" id="ysDone">Done</button></div>`);
    const sheet = $('sheet');
    if (first) {
      first = false;
      if (returnFocus) sheet.addEventListener('close', () => $(returnFocus)?.focus(), { once: true });
    }
    $('ysDone').addEventListener('click', closeSheet);

    // Save a change to the days off: always built from what is stored now, so a day added on another tab is kept.
    const save = async (key, on) => {
      const current = (await db.getSettings()).restDays;
      const at = Math.max(Date.now(), (current?.[key]?.at || 0) + 1);
      await db.setSetting('restDays', mergeDayFlags(current, { [key]: { on, at } }));
      onChange();
      await draw();
    };
    const fail = text => { const e = $('ysErr'); e.textContent = text; e.hidden = false; };
    $('ysForm').addEventListener('submit', async e => {
      e.preventDefault();
      const key = $('ysDate').value;
      const problem = restDayError(key, future);
      if (problem) { fail(problem); return; }
      await save(key, true);
      toast(`Day off added: ${niceDay(key)}`);
      $('ysDate')?.focus();
    });
    $('ysDate').addEventListener('input', () => { $('ysErr').hidden = true; });
    sheet.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
      await save(b.dataset.rm, false);
      toast(`Day off removed: ${niceDay(b.dataset.rm)}`);
      $('ysDate')?.focus();
    }));
    sheet.querySelectorAll('[data-exam-day]').forEach(b => b.addEventListener('click', async () => {
      const key = b.dataset.examDay;
      const problem = restDayError(key, future);
      if (problem) { fail(problem); return; }
      await save(key, true);
      toast(`Day off added: ${niceDay(key)}`);
    }));
  };
  await draw();
}
