// Run by tests/fsrs-data.test.js with TZ=Europe/London: day gaps across the daylight-saving changes.
import assert from 'node:assert/strict';
import { deltaDays, buildHistories } from '../js/fsrs-data.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
// Clocks go forward on Sun 29 Mar 2026 (that night is 23 hours long) and back on Sun 25 Oct 2026 (25 hours).
const t = (m, d, h) => new Date(2026, m, d, h).getTime();
assert.equal(deltaDays(t(2, 28, 12), t(2, 29, 12)), 1);
assert.equal(deltaDays(t(2, 28, 20), t(2, 29, 19)), 1);           // 23 hours apart, but the next day
assert.equal(deltaDays(t(2, 28, 5), t(2, 29, 3)), 0);             // 22 hours apart, before the 4am rollover: the same day
assert.equal(deltaDays(t(9, 24, 12), t(9, 25, 12)), 1);
assert.equal(deltaDays(t(9, 24, 22), t(9, 25, 22)), 1);           // 25 hours apart
assert.equal(deltaDays(t(9, 24, 5), t(9, 25, 5)), 1);
assert.equal(deltaDays(t(2, 20, 12), t(3, 20, 12)), 31);          // across the whole change
const rows = [t(2, 28, 21), t(2, 29, 20), t(2, 29, 21)].map((timestamp, i) => ({ id: i + 1, cardId: 'D', timestamp, source: 'review', rating: 3, state: i ? 2 : 0 }));
assert.deepEqual([...buildHistories(rows).cards[0].deltas], [0, 1, 0]);
console.log('ok tz=Europe/London');
