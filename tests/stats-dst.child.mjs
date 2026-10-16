// Run by tests/stats.test.js with TZ=Europe/London: the streak freeze across a daylight-saving change.
import assert from 'node:assert/strict';
import { dayKey, daysAgoStart, streakFromDays } from '../js/stats-calc.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
const now = new Date(2026, 2, 29, 12).getTime();          // Sun 29 Mar 2026 (the clocks go forward at 1am)
assert.equal(new Date(2026, 2, 29, 12).getTimezoneOffset(), -60);
const keyAt = n => dayKey(daysAgoStart(n, now));
const studied = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13];    // Wed 25 Mar (4 days ago) missed
const r = streakFromDays(new Set(studied.map(keyAt)), now);
assert.equal(r.days, 13);
assert.deepEqual(r.frozen, [keyAt(4)]);
// and the day keys across the change are 7 distinct, consecutive dates
assert.deepEqual([6, 5, 4, 3, 2, 1, 0].map(keyAt), ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']);
console.log('ok tz=Europe/London');
