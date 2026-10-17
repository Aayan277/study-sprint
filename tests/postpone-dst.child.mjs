// Run by tests/postpone.test.js with TZ=Europe/London: a postponed card is still due at 4am across the clocks going forward.
import assert from 'node:assert/strict';
import { postponeStates } from '../js/postpone.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
const now = new Date(2026, 2, 27, 15, 0).getTime();            // Fri 27 Mar 2026; the clocks go forward at 1am on Sun 29 Mar
const st = { cardId: 'a', state: 2, stability: 30, lastReview: now - 10 * 86400000, due: now, scheduledDays: 10 };
for (const [days, date] of [[1, 28], [2, 29], [3, 30], [7, 3]]) {
  const [next] = postponeStates([{ state: st }], days, now);
  const d = new Date(next.due);
  assert.equal(d.getHours(), 4, `${days} day(s): hour`);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), date, `${days} day(s): date`);
}
// the days count is whole: a card due on the 30th is 3 days from the 27th by the calendar, 71 hours by the clock
const [three] = postponeStates([{ state: st }], 3, now);
assert.equal(Math.round((three.due - new Date(2026, 2, 27, 4).getTime()) / 3600000), 71);
console.log('ok tz=Europe/London');
