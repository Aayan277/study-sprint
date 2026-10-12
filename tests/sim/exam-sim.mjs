// Simulation: what the exam does to your daily reviews, before and after the "final pass" (v3.1).
//   npm install --no-save ts-fsrs@5.4.2      (once; the app loads it from a CDN, Node can't)
//   node tests/sim/exam-sim.mjs
//
// 300 cards, 20 new a day for 15 days, an exam on day 30, always answering like a student who remembers a card
// with the chance FSRS predicts. Runs the app's real scheduling code (srs.js, queue.js, exam.js) twice:
//   before  every card whose next review would be after the exam is put on the evening before it (the v3.0 rule)
//   none    (for comparison) no exam rule at all: cards are scheduled as if there were no exam
//   after   cards likely to be remembered at 99% on exam day are left alone; the rest are spread over the
//           last 3 days, the weakest closest to the exam
// Prints the reviews per day, and how well the cards should be remembered at the start of exam day.
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);

const { rate } = await import('../../js/srs.js');
const { examOptions, examSchedule, examStart } = await import('../../js/exam.js');
const { splitCards } = await import('../../js/queue.js');
const { schedulerOptions } = await import('../../js/sched-settings.js');
const { loadByDay } = await import('../../js/balance.js');
const { dayKey } = await import('../../js/stats-calc.js');
const { dayEnd } = await import('../../js/days.js');
const { fsrs } = await import('https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs');

const DAY = 86400000;
const DAYS = 30, NEW_DAYS = 15, NEW_PER_DAY = 20;
const t0 = new Date(2026, 9, 12, 10).getTime();
const deck = { id: 'd', examDate: '2026-11-11' };                         // 30 days after t0
const examT = examStart(deck.examDate);
const base = schedulerOptions({});
const F = fsrs();

// The chance FSRS gives of remembering the card at a time, from its saved state.
const recallAtTime = (st, when) => F.get_retrievability({ due: new Date(st.due), stability: st.stability, difficulty: st.difficulty, elapsed_days: 0,
  scheduled_days: 0, learning_steps: 0, reps: st.reps, lapses: st.lapses, state: st.state, last_review: new Date(st.lastReview) }, new Date(when), false);

function run(mode) {
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const states = new Map(), cards = [], perDay = [];
  // Rate a card; "before" puts a card that would come after the exam on the evening before (the old rule).
  const give = (id, st, rating, balance, now) => {
    const opts = { ...examOptions(base, deck, now), balance };
    if (mode !== 'after') delete opts.maxDue;
    let s = rate(id, st, rating, opts, now);
    if (mode === 'before' && s.due > examT && now < examT) s = { ...s, due: examT };
    return s;
  };
  for (let d = 0; d < DAYS; d++) {
    const now = t0 + d * DAY;
    const balance = { load: loadByDay([...states.values()]), random };
    const exam = mode === 'after' ? examSchedule([deck], cards, states, now) : null;
    const due = splitCards(cards, states, now, exam).reviews.filter(x => x.kind === 'review');
    for (const { card } of due) {
      let st = states.get(card.id);
      const ok = recallAtTime(st, now) > random();
      st = give(card.id, st, ok ? 3 : 1, balance, now);
      for (let k = 0; st.state !== 2 && k < 5; k++) st = give(card.id, st, 3, balance, st.due);     // relearning steps, same session
      states.set(card.id, st);
    }
    let fresh = 0;
    if (d < NEW_DAYS) for (let i = 0; i < NEW_PER_DAY; i++) {
      const card = { id: `c${d}_${i}`, deckId: 'd' }; cards.push(card); fresh++;
      let st = give(card.id, null, 3, balance, now);
      for (let k = 0; st.state !== 2 && k < 5; k++) st = give(card.id, st, 3, balance, st.due);
      states.set(card.id, st);
    }
    perDay.push({ day: dayKey(now), reviews: due.length, fresh });
  }
  const r = [...states.values()].map(st => recallAtTime(st, examT));
  return { perDay, mean: r.reduce((a, b) => a + b, 0) / r.length, sure: r.filter(x => x >= 0.95).length / r.length, weak: r.filter(x => x < 0.9).length / r.length, total: r.length };
}

const before = run('before'), after = run('after'), none = run('none');
console.log('day         new  reviews: before -> after   (no exam rule)');
before.perDay.forEach((b, i) => console.log(`${b.day}  ${String(b.fresh).padStart(3)}  ${String(b.reviews).padStart(7)} ${String(after.perDay[i].reviews).padStart(8)}   ${String(none.perDay[i].reviews).padStart(8)}`));
const sum = r => r.perDay.reduce((n, d) => n + d.reviews, 0);
const peak = r => Math.max(...r.perDay.map(d => d.reviews));
const eve = r => r.perDay[DAYS - 1].reviews;
const last5 = r => r.perDay.slice(-5).map(d => d.reviews).join(' ');
const pct = x => (x * 100).toFixed(1) + '%';
console.log('');
console.log(`reviews in total          ${sum(before)} -> ${sum(after)}   (no exam rule: ${sum(none)})`);
console.log(`busiest day               ${peak(before)} -> ${peak(after)}   (no exam rule: ${peak(none)})`);
console.log(`the evening before        ${eve(before)} -> ${eve(after)}   (no exam rule: ${eve(none)})`);
console.log(`last 5 days               ${last5(before)} -> ${last5(after)}   (no exam rule: ${last5(none)})`);
console.log(`exam-day recall, average  ${pct(before.mean)} -> ${pct(after.mean)}   (no exam rule: ${pct(none.mean)})   (predicted by FSRS at the start of exam day, ${before.total} cards)`);
console.log(`cards at 95% or better    ${pct(before.sure)} -> ${pct(after.sure)}   (no exam rule: ${pct(none.sure)})`);
console.log(`cards under 90%           ${pct(before.weak)} -> ${pct(after.weak)}   (no exam rule: ${pct(none.weak)})`);
