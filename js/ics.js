// Calendar files (.ics) for reminders. Pure functions, no page or database: tested by tests/ics.test.js.
//
//   dailyReminderICS   one event that repeats every day at a time you pick, with an alert at that time
//   examsICS           each course's exam day (all-day), with an alert 3 days before and one that morning
//
// (The reminder's UID is made once per device and kept in the settings (reminders.js), so two devices don't overwrite each other's time.)
// Choices (the file has to work in Apple Calendar, Google Calendar and Outlook):
//   - Times are FLOATING local times (DTSTART:20261019T190000, no "Z", no TZID). Every calendar reads that as
//     "7pm wherever this calendar is", so the reminder stays at 7pm after a trip or a clock change. A TZID would
//     also need a full VTIMEZONE block (Outlook ignores unknown zone names, Apple and Google disagree on the rest).
//   - The event has a fixed UID, so adding it again replaces the old one in Apple and Google Calendar (Outlook
//     may add a second copy). SEQUENCE and LAST-MODIFIED go up each time, which is what makes them accept the change.
//   - Lines are CRLF-ended and folded to 75 bytes, text is escaped, as RFC 5545 asks.

const enc = new TextEncoder();
export const DAILY_UID = 'daily-reminder@study-sprint';
export const REMINDER_TITLE = "Study Sprint: today's cards";
export const DEFAULT_TIME = '19:00';
const CRLF = '\r\n';

// Backslash, semicolon, comma and line breaks must be escaped in text values.
export const escapeText = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

// One content line, cut so that no line is over 75 bytes (UTF-8, never in the middle of a character).
// Each continuation line starts with a space, which counts toward its 75.
export function foldLine(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ' ' + l : l)).join(CRLF);
}

const p2 = n => String(n).padStart(2, '0');
// A local date and time without a zone ("floating"): 20261019T190000.
export const floating = d => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}00`;
export const dateOnly = d => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
const utcStamp = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`; };

// 'HH:MM' → { h, m }, or the default time when it is not a real time.
export function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (m && +m[1] < 24 && +m[2] < 60) return { h: +m[1], m: +m[2] };
  return { h: 19, m: 0 };
}

function wrap(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Study Sprint//Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events.flat(), 'END:VCALENDAR'];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

// The stamps that tell a calendar this is a newer copy of the same event. SEQUENCE is the number of minutes since 1970:
// it only has to go up with each file made, and a clock gives that without storing a counter.
const versioned = now => [`DTSTAMP:${utcStamp(now)}`, `LAST-MODIFIED:${utcStamp(now)}`, `SEQUENCE:${Math.floor(now / 60000)}`];

// time 'HH:MM' (local), url the app's address, now a time in ms. The first day is today, or tomorrow when the time has passed.
export function dailyReminderICS({ time = DEFAULT_TIME, url = '', now = Date.now(), uid = DAILY_UID } = {}) {
  const { h, m } = parseTime(time);
  const at = new Date(now);
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate(), h, m, 0);
  if (start.getTime() <= now) start.setDate(start.getDate() + 1);
  const end = new Date(start.getTime());
  end.setMinutes(end.getMinutes() + 10);
  const body = `Open Study Sprint and do today's cards.${url ? ' ' + url : ''}`;
  return wrap([[
    'BEGIN:VEVENT',
    `UID:${uid}`,
    ...versioned(now),
    `DTSTART:${floating(start)}`,
    `DTEND:${floating(end)}`,
    'RRULE:FREQ=DAILY',
    `SUMMARY:${escapeText(REMINDER_TITLE)}`,
    `DESCRIPTION:${escapeText(body)}`,
    ...(url ? [`URL:${url}`] : []),
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(REMINDER_TITLE)}`,
    'TRIGGER:PT0S',
    'END:VALARM',
    'END:VEVENT'
  ]]);
}

// Decks whose exam is today or later: [{ id, name, date: 'YYYY-MM-DD' }], soonest first.
export function examList(decks, now = Date.now()) {
  const today = new Date(now);
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const out = [];
  for (const d of decks || []) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d?.examDate || '');
    if (!m) continue;
    const day = new Date(+m[1], +m[2] - 1, +m[3]);
    if (day.getTime() >= t0) out.push({ id: d.id, name: d.name || d.course || 'Exam', date: d.examDate, day });
  }
  return out.sort((a, b) => a.day - b.day);
}

// All-day events for the exams, each with an alert at 9am three days before and one at 9am on the day. null when there are none.
export function examsICS({ decks, url = '', now = Date.now() } = {}) {
  const exams = examList(decks, now);
  if (!exams.length) return null;
  const events = exams.map(x => {
    const next = new Date(x.day.getFullYear(), x.day.getMonth(), x.day.getDate() + 1);
    const title = `Exam: ${x.name}`;
    return [
      'BEGIN:VEVENT',
      `UID:exam-${String(x.id).replace(/[^A-Za-z0-9_-]/g, '')}@study-sprint`,
      ...versioned(now),
      `DTSTART;VALUE=DATE:${dateOnly(x.day)}`,
      `DTEND;VALUE=DATE:${dateOnly(next)}`,
      `SUMMARY:${escapeText(title)}`,
      `DESCRIPTION:${escapeText(`Your Study Sprint exam day.${url ? ' ' + url : ''}`)}`,
      ...(url ? [`URL:${url}`] : []),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`${title} in 3 days`)}`, 'TRIGGER:-P2DT15H', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`${title} is today`)}`, 'TRIGGER:PT9H', 'END:VALARM',
      'END:VEVENT'
    ];
  });
  return wrap(events);
}
