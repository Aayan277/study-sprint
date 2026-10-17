// Run by tests/postpone.test.js with TZ=Europe/London: a postponed card is not due until its day, across the clocks going forward.
import assert from 'node:assert/strict';
import { postponeStates } from '../js/postpone.js';
import { splitCards } from '../js/queue.js';
import { dayStart } from '../js/days.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
const now = new Date(2026, 2, 27, 15, 0).getTime();            // Fri 27 Mar 2026; the clocks go forward at 1am on Sun 29 Mar
const st = { cardId: 'a', state: 2, stability: 30, lastReview: now - 10 * 86400000, due: now, scheduledDays: 10 };
const noonOf = k => { const d = new Date(dayStart(now)); d.setDate(d.getDate() + k); d.setHours(12, 0, 0, 0); return d.getTime(); };
for (const days of [1, 2, 3, 7]) {
  const [next] = postponeStates([{ state: st }], days, now);
  const d = new Date(next.due);
  assert.equal(d.getHours(), 6, `${days} day(s): hour`);
  const queued = k => splitCards([{ id: 'a', deckId: 'd' }], new Map([['a', next]]), noonOf(k)).reviews.length === 1;
  for (let k = 0; k < days; k++) assert.equal(queued(k), false, `${days} day(s): not due on day ${k}`);
  assert.equal(queued(days), true, `${days} day(s): due on day ${days}`);
}
console.log('ok tz=Europe/London');
