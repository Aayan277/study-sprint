// Tests for the calendar files (js/ics.js). Run with: node tests/ics.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLine, escapeText, parseTime, dailyReminderICS, examsICS, examList, DAILY_UID, REMINDER_TITLE } from '../js/ics.js';

const bytes = s => new TextEncoder().encode(s).length;
const unfold = t => t.replace(/\r\n /g, '');
const NOW = new Date(2026, 9, 18, 10, 30, 0).getTime();          // 18 Oct 2026, 10:30 local

test('escapeText escapes backslash, semicolon, comma and newlines', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
});

test('foldLine keeps lines to 75 bytes, never splits a character, and unfolds back', () => {
  const long = 'DESCRIPTION:' + 'é'.repeat(100) + ' ' + '日本語'.repeat(30) + ' 😀'.repeat(20);
  const folded = foldLine(long);
  for (const l of folded.split('\r\n')) assert.ok(bytes(l) <= 75, `${bytes(l)} bytes: ${l}`);
  assert.ok(folded.split('\r\n').slice(1).every(l => l.startsWith(' ')));
  assert.equal(folded.replace(/\r\n /g, ''), long);
  assert.equal(foldLine('SHORT:line'), 'SHORT:line');
});

test('parseTime accepts HH:MM and falls back to 19:00', () => {
  assert.deepEqual(parseTime('07:05'), { h: 7, m: 5 });
  assert.deepEqual(parseTime('9:30'), { h: 9, m: 30 });
  assert.deepEqual(parseTime('25:00'), { h: 19, m: 0 });
  assert.deepEqual(parseTime(''), { h: 19, m: 0 });
});

test('daily reminder: CRLF, structure, RRULE, VALARM, UID, floating time, URL', () => {
  const url = 'https://example.github.io/study-sprint/';
  const ics = dailyReminderICS({ time: '19:30', url, now: NOW });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(ics), 'every line break is CRLF');
  for (const l of ics.split('\r\n')) assert.ok(bytes(l) <= 75, l);
  const t = unfold(ics);
  assert.ok(t.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(t.endsWith('END:VCALENDAR\r\n'));
  assert.match(t, /PRODID:-\/\/Study Sprint/);
  assert.ok(t.includes(`UID:${DAILY_UID}\r\n`));
  assert.ok(t.includes('RRULE:FREQ=DAILY\r\n'));
  assert.ok(t.includes('DTSTART:20261018T193000\r\n'), 'today, because 19:30 is still ahead');
  assert.ok(t.includes('DTEND:20261018T194000\r\n'));
  assert.ok(!/DTSTART[^:\r]*Z|TZID/.test(t), 'floating local time: no Z and no TZID');
  assert.ok(t.includes("SUMMARY:Study Sprint: today's cards\r\n") && REMINDER_TITLE === "Study Sprint: today's cards");
  assert.ok(t.includes(`URL:${url}\r\n`));
  assert.ok(t.includes(url) && /DESCRIPTION:Open Study Sprint/.test(t));
  assert.match(t, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:[^\r]+\r\nTRIGGER:PT0S\r\nEND:VALARM/);
  assert.match(t, /DTSTAMP:\d{8}T\d{6}Z/);
  // balanced
  const count = k => (t.match(new RegExp('^' + k + '$', 'gm')) || []).length;
  for (const k of ['VCALENDAR', 'VEVENT', 'VALARM']) assert.equal(count('BEGIN:' + k), count('END:' + k));
});

test('daily reminder starts tomorrow when the time has already passed, and crosses midnight for DTEND', () => {
  const t = unfold(dailyReminderICS({ time: '08:00', now: NOW }));
  assert.ok(t.includes('DTSTART:20261019T080000'));
  assert.ok(!t.includes('URL:'), 'no URL line without an address');
  const late = unfold(dailyReminderICS({ time: '23:55', now: NOW }));
  assert.ok(late.includes('DTSTART:20261018T235500') && late.includes('DTEND:20261019T000500'));
});

test('re-adding keeps the UID and raises SEQUENCE', () => {
  const seq = ics => +/SEQUENCE:(\d+)/.exec(ics)[1];
  const a = dailyReminderICS({ time: '19:00', now: NOW }), b = dailyReminderICS({ time: '20:00', now: NOW + 3600e3 });
  assert.equal(/UID:(.*)/.exec(a)[1], /UID:(.*)/.exec(b)[1]);
  assert.ok(seq(b) > seq(a));
});

test('exam file: all-day events, UID per deck, two alerts, escaping, nothing for past or missing dates', () => {
  const decks = [
    { id: 'a', name: 'Bio, part 1; "cells"', examDate: '2026-11-20' },
    { id: 'b', name: 'Old', examDate: '2026-10-01' },
    { id: 'c', name: 'None' },
    { id: 'd', name: 'Today', examDate: '2026-10-18' }
  ];
  assert.deepEqual(examList(decks, NOW).map(x => x.id), ['d', 'a']);
  const ics = examsICS({ decks, url: 'https://x.test/app/', now: NOW });
  const t = unfold(ics);
  assert.equal((t.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.ok(t.includes('DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121'));
  assert.ok(t.includes('UID:exam-a@study-sprint'));
  assert.ok(t.includes('SUMMARY:Exam: Bio\\, part 1\\; "cells"'));
  assert.equal((t.match(/BEGIN:VALARM/g) || []).length, 4);
  assert.ok(t.includes('TRIGGER:-P2DT15H') && t.includes('TRIGGER:PT9H'));
  for (const l of ics.split('\r\n')) assert.ok(bytes(l) <= 75);
  assert.equal(examsICS({ decks: [{ id: 'x', name: 'n' }], now: NOW }), null);
});

test('month and year rollover for the exam end date', () => {
  const t = unfold(examsICS({ decks: [{ id: 'z', name: 'Z', examDate: '2026-12-31' }], now: NOW }));
  assert.ok(t.includes('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101'));
});
