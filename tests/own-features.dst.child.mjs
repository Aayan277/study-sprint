// Run by tests/own-features.test.js with TZ=Europe/London: the study day (and so the same-day flag and "answers today")
// turns over at 4am local time, also on the days the clocks change (29 Mar and 25 Oct 2026).
import assert from 'node:assert/strict';
import { OwnFeatures } from '../js/own-features.js';

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/London', 'the time zone was not set');
const at = (m, d, h, min = 0) => new Date(2026, m, d, h, min).getTime();
const mk = (card, t) => ({ logId: t, cardKey: 'c:' + card, noteKey: 'c:' + card, deckKey: 'd:1', t, rating: 3, ms: 4000, kind: 'train' });   // no day: it comes from the time
for (const [m, d] of [[2, 29], [9, 25], [5, 10]]) {
  const b = new OwnFeatures();
  b.commit(mk('a', at(m, d, 3, 0)));
  assert.equal(b.features(mk('a', at(m, d, 3, 59)))[2], 1, `3:59 is still the same study day on ${m + 1}/${d}`);
  assert.equal(b.features(mk('a', at(m, d, 4, 0)))[2], 0, `4:00 starts a new study day on ${m + 1}/${d}`);
  assert.ok(Math.abs(b.features(mk('b', at(m, d, 3, 59)))[9] - Math.log1p(1) / 4) < 1e-6, 'one answer so far today');
  assert.equal(b.features(mk('b', at(m, d, 4, 0)))[9], 0, 'a new day has no answers yet');
}
console.log('ok tz=Europe/London');
