// Run by tests/fsrs-data.test.js with TZ=Europe/London: day gaps across the daylight-saving changes.
import assert from 'node:assert/strict';
import { deltaDays, buildHistories } from '../js/fsrs-data.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
// Clocks go forward on Sun 29 Mar 2026 (that night is 23 hours long) and back on Sun 25 Oct 2026 (25 hours).
// The gap is the difference of the UTC dates (ts-fsrs dateDiffInDays), so the local clock changes do not matter.
const t = (m, d, h, min = 0) => new Date(2026, m, d, h, min).getTime();
const utcRule = (a, b) => { const u = x => Date.UTC(new Date(x).getUTCFullYear(), new Date(x).getUTCMonth(), new Date(x).getUTCDate()); return Math.floor((u(b) - u(a)) / 864e5); };
assert.equal(deltaDays(t(2, 28, 12), t(2, 29, 12)), 1);
assert.equal(deltaDays(t(2, 28, 20), t(2, 29, 19)), 1);           // 23 hours apart
assert.equal(deltaDays(t(9, 24, 12), t(9, 25, 12)), 1);
assert.equal(deltaDays(t(9, 24, 22), t(9, 25, 22)), 1);           // 25 hours apart
assert.equal(deltaDays(t(9, 24, 23), t(9, 25, 0, 30)), 0);        // 00:30 BST on the 25th is 23:30 UTC on the 24th: the same date
assert.equal(deltaDays(t(2, 29, 0, 30), t(2, 29, 1, 30)), 0);     // (that local hour does not exist; still the same date)
assert.equal(deltaDays(t(2, 20, 12), t(3, 20, 12)), 31);          // across the whole change
for (let day = 20; day < 31; day++) for (const [h1, h2] of [[0, 23], [3, 4], [12, 1], [23, 0]]) {
  assert.equal(deltaDays(t(2, day, h1), t(2, day + 1, h2)), utcRule(t(2, day, h1), t(2, day + 1, h2)));
  assert.equal(deltaDays(t(9, day, h1), t(9, day + 1, h2)), utcRule(t(9, day, h1), t(9, day + 1, h2)));
}
const rows = [t(2, 28, 21), t(2, 29, 20), t(2, 29, 21)].map((timestamp, i) => ({ id: i + 1, cardId: 'D', timestamp, source: 'review', rating: 3, state: i ? 2 : 0 }));
assert.deepEqual([...buildHistories(rows).cards[0].deltas], [0, 1, 0]);
console.log('ok tz=Europe/London');
