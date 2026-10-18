// Run by tests/idle-days.test.js with TZ=Europe/London: a "nothing due" day across the daylight-saving change.
import assert from 'node:assert/strict';
import { dayKey, daysAgoStart, streakFromDays } from '../js/stats-calc.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
const now = new Date(2026, 2, 29, 12).getTime();          // Sun 29 Mar 2026 (the clocks go forward at 1am)
const keyAt = n => dayKey(daysAgoStart(n, now));
// Studied today, 2, 3, 5, 6 and 7 days back; Sat 28 Mar (1 day ago) and Wed 25 Mar (4 days ago) were quiet days with nothing due.
const studied = new Set([0, 2, 3, 5, 6, 7].map(keyAt));
const quiet = new Set([1, 4].map(keyAt));
assert.ok(streakFromDays(studied, now).days < 6, 'without the quiet days the run is broken');
const r = streakFromDays(studied, now, { idle: quiet });
assert.equal(r.days, 6);                                    // the six studied days: the quiet days add nothing
assert.deepEqual(r.frozen, []);                              // and no freeze was used
assert.deepEqual([6, 5, 4, 3, 2, 1, 0].map(keyAt), ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']);
console.log('ok tz=Europe/London');
