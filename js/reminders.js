// Reminders, phase 1 (no server, no cost): a daily reminder as a calendar file, the exam dates as a calendar file,
// the "Remind me to study?" card on Today and the Settings → Study → Reminders rows. The file itself is built in ics.js,
// the app-icon number in badge.js.
//
//   - "Add to my calendar" gives the file to the phone's Share sheet when there is one (iPhone opens it in Calendar),
//     otherwise it downloads. Nothing is stored except the time you picked (`reminderTime`, this device only).
//   - The card on Today shows once, after the first finished Review session, and only when the install card is not
//     showing. "Not now", the × and adding the reminder all hide it for good (localStorage, this device only).

import * as db from './db.js';
import { dailyReminderICS, examsICS, DEFAULT_TIME } from './ics.js';
import { sessionFinished, shouldShowCard as installCardShows } from './install.js';
import { badgeRow, needsPermission, askPermission, refreshBadgeNow } from './badge.js';
import { icon, toast, esc, plural } from './ui.js';

const DISMISSED = 'study-sprint-remind-dismissed';
const get = k => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const set = k => { try { localStorage.setItem(k, '1'); } catch { /* the card may come back; fine */ } };

// The app's own address, without the "#/..." part.
export const appUrl = () => `${location.origin}${location.pathname}`;

// Give a calendar file to the person: the Share sheet on a phone, a download elsewhere.
// Returns 'shared', 'saved' or 'cancelled'.
export async function saveCalendar(text, name, title) {
  const file = new File([text], name, { type: 'text/calendar' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return 'shared'; }
    catch (err) { if (err?.name === 'AbortError') return 'cancelled'; /* any other failure: download it instead */ }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'saved';
}

// This device's own event id (so two devices' reminders don't overwrite each other, while adding again here replaces).
// It is read from the settings when Settings or the card is drawn, so it is known by the time of the tap.
let uid = null;
const deviceUid = () => {
  if (!uid) { uid = `daily-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)}@study-sprint`; db.setSetting('reminderUid', uid).catch(() => {}); }
  return uid;
};
export const rememberUid = saved => { if (typeof saved === 'string' && saved) uid = saved; };

// Make and hand over the daily reminder. Remembers the time. Returns what saveCalendar returns.
// (No await before the Share sheet is opened: iPhone only allows it right after a tap.)
export async function addDailyReminder(time) {
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? time : DEFAULT_TIME;
  db.setSetting('reminderTime', t).catch(() => {});
  const out = await saveCalendar(dailyReminderICS({ time: t, url: appUrl(), uid: deviceUid() }), 'study-sprint-daily-reminder.ics', 'Study Sprint daily reminder');
  if (out !== 'cancelled') set(DISMISSED);                  // they have what they asked for: the card on Today can go
  if (out === 'saved') toast('Calendar file saved. Open it to add the reminder.');
  return out;
}

// decks are already loaded (Settings has them), so nothing is awaited before the Share sheet opens.
export async function addExams(decks) {
  const text = examsICS({ decks, url: appUrl() });
  if (!text) { toast('No exam dates yet. Set one on a course first.'); return 'none'; }
  const out = await saveCalendar(text, 'study-sprint-exams.ics', 'Study Sprint exam dates');
  if (out === 'saved') toast('Calendar file saved. Open it to add your exams.');
  return out;
}

// ----- the card on Today -----
const timeInput = (id, value) => `<input id="${id}" type="time" class="remind-time" value="${esc(value)}" aria-label="Reminder time">`;

export const shouldShowPrompt = () => sessionFinished() && !get(DISMISSED) && !installCardShows();

export async function drawPrompt(slot) {
  if (!slot?.isConnected) return;
  if (!shouldShowPrompt()) { slot.innerHTML = ''; return; }
  const saved = await db.getSettings();
  rememberUid(saved.reminderUid);
  const time = saved.reminderTime || DEFAULT_TIME;
  if (!slot.isConnected || !shouldShowPrompt()) return;
  slot.innerHTML = `<section class="inst remind" aria-label="Daily reminder">
    <span class="remind-icon" aria-hidden="true">${icon('clock')}</span>
    <div class="inst-txt"><b>Remind me to study?</b>
      <p>Get a calendar alert at a time you pick. A few minutes a day keeps the streak going.</p>
      <label class="remind-pick">${timeInput('remindTime', time)}</label>
      <div class="inst-btns"><button class="btn primary small" type="button" data-remind="go">${icon('calendar')} Add to calendar</button>
        <button class="btn ghost small" type="button" data-remind="no">Not now</button></div></div>
    <button class="inst-x" type="button" data-remind="no" aria-label="Dismiss">${icon('x')}</button></section>`;
  slot.querySelectorAll('[data-remind="no"]').forEach(b => b.addEventListener('click', () => { set(DISMISSED); slot.innerHTML = ''; }));
  slot.querySelector('[data-remind="go"]').addEventListener('click', async () => {
    const out = await addDailyReminder(slot.querySelector('#remindTime').value);
    if (out !== 'cancelled') slot.innerHTML = '';
  });
}

// The install card can turn up after Today was drawn (the browser announces it late): then this card steps aside.
export function stepAside(slot) { if (slot && installCardShows()) slot.innerHTML = ''; }

// ----- Settings → Study → Reminders -----
export function settingsHTML({ time, exams, badgeOn }) {
  const row = badgeRow();
  return `
      <h3 class="set-sub" id="remTitle">Reminders</h3>
      <div class="set-row" id="remRow">
        <div><b><label for="remTime">Daily reminder</label></b>
          <p id="remHelp">Calendar alert at this time</p></div>
        <div class="steps-input rem-actions">${timeInput('remTime', time).replace('aria-label="Reminder time"', 'aria-describedby="remHelp"')}
          <button class="btn ghost small" type="button" id="remAdd">${icon('calendar')} Add to my calendar</button></div>
      </div>
      ${exams ? `<div class="set-row" id="examRemRow">
        <div><b>Exam dates</b><p>${plural(exams, 'exam')} on your courses, each with an alert 3 days before and one on the day.</p></div>
        <button class="btn ghost small" type="button" id="examAdd">${icon('calendar')} Add exams to my calendar</button>
      </div>` : ''}
      ${row === 'switch' ? `<label class="adv-row switch-row" id="badgeRow"><span><b>Cards due on the app icon</b>
        ${needsPermission() ? '<span>On iPhone this needs notifications allowed. Study Sprint sends none.</span>' : ''}</span>
        <input id="appBadge" type="checkbox" class="switch" ${badgeOn ? 'checked' : ''}></label>
        <p class="note" id="badgeNote" role="status" hidden></p>`
      : row === 'install' ? `<div class="set-row" id="badgeRow"><div><b>Cards due on the app icon</b>
        <p>Works in the installed app. Add Study Sprint to your Home Screen or install it, then open it from there to show today's card count on its icon.</p></div></div>` : ''}`;
}

// root: the Settings screen. getDecks: () => decks (for the exam file).
export function wireSettings(root, { decks, settings }) {
  const $ = id => root.querySelector('#' + id);
  rememberUid(settings.reminderUid);
  $('remAdd')?.addEventListener('click', () => addDailyReminder($('remTime').value));
  $('remTime')?.addEventListener('change', e => { if (e.target.value) db.setSetting('reminderTime', e.target.value); });
  $('examAdd')?.addEventListener('click', () => addExams(decks));
  $('appBadge')?.addEventListener('change', async e => {
    const box = e.target, note = $('badgeNote');
    if (note) note.hidden = true;
    if (box.checked && needsPermission()) {
      const r = await askPermission();
      if (r !== 'granted') {
        box.checked = false;
        if (note) { note.textContent = 'iPhone only shows the number when notifications are allowed (Study Sprint sends none). Switch this on again and tap Allow, or turn them on in Settings → Notifications → Study Sprint.'; note.hidden = false; }
        return;
      }
    }
    settings.appBadge = box.checked;
    await db.setSetting('appBadge', box.checked);
    refreshBadgeNow();      // fresh: the setting just changed
  });
}
