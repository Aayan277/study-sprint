// The "Catch-up plan" sheet (opened from Today; loaded when first needed, it is in the service worker's CORE list).
// Two ways in:
//   openRescueSheet({ offer: { n, ... } })   confirm a new plan spread over n days
//   openRescueSheet({ plan })                 look after the running plan: pause new cards on or off, or show everything now
// The plan itself is the synced setting `rescue` = { start, days, backlog, pauseNew, at } (queue.js rescueToday does the arithmetic).

import * as db from './db.js';
import { dayStart } from './days.js';
import { rescueBacklog } from './queue.js';
import { dismissRescueToday } from './study-data.js';
import { openSheet, closeSheet, esc, plural, toast, $ } from './ui.js';

// The warning text for a review limit that is lower than the plan needs ('' when it is fine).
//   quota  overdue cards a day the plan asks for       usual  your usual reviews a day
export function limitWarning(reviewLimit, quota, usual) {
  if (!Number.isFinite(reviewLimit)) return '';
  const need = Math.ceil(quota + usual);
  if (reviewLimit >= need) return '';
  return `Your limit of ${plural(reviewLimit, 'review')} a day is lower than the ${need} this plan needs, so it will take longer. Raise "Reviews per day" in Settings, or clear it.`;
}

// The plan a new "Start" saves. The backlog is counted again now: Today may have been open past the new day's start,
// and the plan counts cards due before its own start.
export function newPlan(data, days, pauseNew, now = Date.now()) {
  const start = dayStart(now);
  return { start, days, backlog: rescueBacklog(data.cards, data.statesById, data.exempt, start), pauseNew, at: now };
}

// data: from loadAll (needs data.settings, data.rescue). state: { backlog, typical } from rescueState.
// onChange runs after the plan is started, changed or cancelled (the caller redraws).
export function openRescueSheet({ data, state, offer = null, onChange = () => {}, returnFocus = '' }) {
  const saved = data.settings.rescue;
  const running = !offer && saved ? { ...saved } : null;
  const days = offer ? offer.n : running.days;
  let pauseNew = running ? running.pauseNew !== false : true;
  const quota = offer ? Math.ceil(state.backlog / days) : Math.ceil((data.rescue?.remaining ?? 0) / Math.max(1, days - (data.rescue?.k ?? 1) + 1));
  const warn = limitWarning(data.settings.reviewLimit, quota, state.typical);
  openSheet(`
    <h2 id="sheetTitle">${offer ? 'Catch up over ' + days + ' days' : 'Catch-up plan'}</h2>
    ${offer
      ? `<p>You have <b>${plural(state.backlog, 'overdue card')}</b>. Instead of all at once, you get about <b>${quota} overdue</b> cards a day, most overdue first, on top of your usual ${state.typical} or so. Cards for an exam are never held back.</p>`
      : `<p>Day <b>${data.rescue?.k ?? '?'} of ${days}</b>${data.rescue ? ` · ${plural(data.rescue.remaining, 'overdue card')} left` : ''}. Cards you skip are not lost: a missed day just means more the next day.</p>`}
    <label class="adv-row switch-row"><span><b>Pause new cards until caught up</b>
      <span>No new cards start while the plan runs, so the overdue ones come first. Decks with an exam still get theirs.</span></span>
      <input id="rsPause" type="checkbox" class="switch" ${pauseNew ? 'checked' : ''}></label>
    <p class="rs-warn" id="rsWarn" role="status" ${warn ? '' : 'hidden'}>${esc(warn)}</p>
    <div class="sheet-actions ${offer ? '' : 'stack'}">
      ${offer ? '<button class="btn ghost" type="button" id="rsCancel">Cancel</button><button class="btn primary" type="button" id="rsStart">Start the plan</button>'
        : '<button class="btn primary" type="button" id="rsDone">Done</button><button class="btn ghost" type="button" id="rsAll">Show everything now</button>'}
    </div>`);
  const sheet = $('sheet');
  if (returnFocus) sheet.addEventListener('close', () => $(returnFocus)?.focus(), { once: true });
  $('rsPause').addEventListener('change', async e => {
    pauseNew = e.target.checked;
    if (!running) return;                                              // a new plan reads the switch when it starts
    await db.setSetting('rescue', { ...running, pauseNew, at: Date.now() });
    onChange();
  });
  $('rsCancel')?.addEventListener('click', closeSheet);
  $('rsDone')?.addEventListener('click', closeSheet);
  $('rsStart')?.addEventListener('click', async () => {
    await db.setSetting('rescue', newPlan(data, days, pauseNew));
    closeSheet();
    toast(`Catch-up plan started: ${days} days`);
    onChange();
  });
  $('rsAll')?.addEventListener('click', async () => {
    await db.setSetting('rescue', null);
    dismissRescueToday();                                                // or the banner would offer a new plan straight away
    closeSheet();
    toast('Catch-up plan stopped. Everything is back.');
    onChange();
  });
}
