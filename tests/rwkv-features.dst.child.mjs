// Run by tests/rwkv-features.test.js with TZ=Europe/London: the study day turns over at 4am local time, also on the days the clocks change.
// Clocks go forward on Sun 29 Mar 2026 and back on Sun 25 Oct 2026.
import assert from 'node:assert/strict';
import { studyDay } from '../js/rwkv-features.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
const t = (m, d, h, min = 0) => new Date(2026, m, d, h, min).getTime();
for (const [m, d] of [[2, 29], [9, 25], [5, 10]]) {
  assert.equal(studyDay(t(m, d, 4, 0)), studyDay(t(m, d, 3, 59)) + 1, `4am on ${m + 1}/${d}`);
  assert.equal(studyDay(t(m, d, 23, 59)), studyDay(t(m, d, 4, 0)));
  assert.equal(studyDay(t(m, d, 12)), studyDay(t(m, d - 1, 12)) + 1, `noon to noon into ${m + 1}/${d}`);
  assert.equal(studyDay(t(m, d + 1, 3, 30)), studyDay(t(m, d, 12)));
}
console.log('ok tz=Europe/London');
