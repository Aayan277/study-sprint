// RWKV lab scheduling (Stage 3): the plan hook in srs.js rate(). Run with: node --test tests/rwkv-sched.test.js
// Needs ts-fsrs locally (`npm install`), like tests/preview-labels.test.js; skipped, with a loud warning, without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';

const local = process.env.TS_FSRS_PATH || new URL('../node_modules/ts-fsrs/dist/index.mjs', import.meta.url).pathname;
const skip = existsSync(local) ? false : 'ts-fsrs 5.4.2 is not installed';
if (skip) console.warn('\n*** ts-fsrs not installed: the tests in rwkv-sched.test.js are SKIPPED. Run `npm install`. ***\n');
if (!skip) register('./sim/loader.mjs', import.meta.url);
const load = async () => ({ ...(await import('../js/srs.js')), ...(await import('../js/sched-settings.js')), ...(await import('../js/queue.js')) });
const { recentMs } = await import('../js/rwkv-lab.js').catch(() => ({}));

const DAY = 86400000;
const NOW = new Date(2026, 9, 12, 10).getTime();
const review = id => ({ cardId: id, state: 2, stability: 12, difficulty: 5.5, reps: 6, lapses: 0, lastReview: NOW - 12 * DAY, due: NOW, scheduledDays: 12, elapsedDays: 12, learningSteps: 0 });
const learning = id => ({ cardId: id, state: 1, stability: 1.2, difficulty: 6, reps: 1, lapses: 0, lastReview: NOW - 60000, due: NOW, scheduledDays: 0, elapsedDays: 0, learningSteps: 1 });
const relearning = id => ({ ...review(id), state: 3, lapses: 1, learningSteps: 0 });
const planFor = (id, state, over = {}) => ({ cardId: id, lastReview: state.lastReview, at: NOW, days: { 2: 20, 3: 45, 4: 90 }, modelSha: 'x', ...over });
const FSRS_FIELDS = ['state', 'stability', 'difficulty', 'reps', 'lapses', 'learningSteps', 'lastReview'];
const pick = (s, keys = FSRS_FIELDS) => Object.fromEntries(keys.map(k => [k, s[k]]));

// Research branch: js/srs.js is main's, which has no rwkvPlan hook, so the two tests that call rate()/previewIntervals() with a plan are skipped.
const NO_SRS_HOOK = 'js/srs.js is main\'s: no rwkvPlan hook';
test('a valid plan sets the Hard, Good and Easy gaps of a review card', { skip: NO_SRS_HOOK }, async () => {
  const { rate, schedulerOptions } = await load();
  const opts = { ...schedulerOptions({ fuzz: false }) };
  const st = review('a');
  for (const [rating, days] of [[2, 20], [3, 45], [4, 90]]) {
    const out = rate('a', st, rating, { ...opts, rwkvPlan: planFor('a', st) }, NOW);
    assert.equal(out.scheduledDays, days);
    assert.equal(out.due, NOW + days * DAY);
  }
});

test('Again, learning and relearning cards ignore the plan', { skip }, async () => {
  const { rate, schedulerOptions } = await load();
  const opts = { ...schedulerOptions({ fuzz: false }) };
  const st = review('a');
  const again = rate('a', st, 1, { ...opts, rwkvPlan: planFor('a', st, { days: { 1: 50, 2: 50, 3: 50, 4: 50 } }) }, NOW);
  assert.deepEqual(again, rate('a', st, 1, opts, NOW), 'Again is FSRS');
  for (const make of [learning, relearning]) {
    const s = make('b');
    for (const rating of [1, 2, 3, 4]) {
      assert.deepEqual(rate('b', s, rating, { ...opts, rwkvPlan: planFor('b', s) }, NOW), rate('b', s, rating, opts, NOW), `${make.name} rating ${rating}`);
    }
  }
  // a brand-new card has no state at all
  assert.deepEqual(rate('n', null, 3, { ...opts, rwkvPlan: planFor('n', { lastReview: null }) }, NOW), rate('n', null, 3, opts, NOW));
});

test('a plan for another card, an old plan, another lastReview, or numbers that are not real is ignored', { skip }, async () => {
  const { rate, schedulerOptions } = await load();
  const opts = { ...schedulerOptions({ fuzz: false }) };
  const st = review('a'), plain = rate('a', st, 3, opts, NOW);
  const ignored = [
    planFor('a', st, { cardId: 'other' }),
    planFor('a', st, { at: NOW - 3600000 }),
    planFor('a', st, { at: NOW + 3600000 }),
    planFor('a', st, { lastReview: st.lastReview - 1 }),
    planFor('a', st, { lastReview: null }),
    planFor('a', st, { days: { 2: 20, 3: NaN, 4: 90 } }),
    planFor('a', st, { days: { 2: 20, 3: 0, 4: 90 } }),
    planFor('a', st, { days: { 2: 20, 3: -4, 4: 90 } }),
    planFor('a', st, { days: { 2: 20, 4: 90 } }),
    planFor('a', st, { days: null }),
    null
  ];
  for (const p of ignored) assert.deepEqual(rate('a', st, 3, { ...opts, rwkvPlan: p }, NOW), plain, JSON.stringify(p));
  const inf = rate('a', st, 3, { ...opts, rwkvPlan: planFor('a', st, { days: { 2: 20, 3: Infinity, 4: 90 } }) }, NOW);
  assert.deepEqual(inf, plain, 'Infinity is ignored too');
});

test('the card\'s FSRS fields equal those of a plain FSRS rate(), so switching back loses nothing', { skip }, async () => {
  const { rate, schedulerOptions } = await load();
  const opts = { ...schedulerOptions({ fuzz: false }) };
  const st = review('a');
  for (const rating of [1, 2, 3, 4]) {
    const withPlan = rate('a', st, rating, { ...opts, rwkvPlan: planFor('a', st) }, NOW);
    const plain = rate('a', st, rating, opts, NOW);
    assert.deepEqual(pick(withPlan), pick(plain), `rating ${rating}`);
  }
});

test('previewIntervals matches rate() with and without a plan, with fuzz and with evening out', { skip: NO_SRS_HOOK }, async () => {
  const { rate, previewIntervals, schedulerOptions, formatInterval } = await load();
  const st = review('a');
  for (const base of [schedulerOptions({ fuzz: false }), schedulerOptions({ fuzz: true }), { ...schedulerOptions({ fuzz: true }), balance: { load: new Map(), easyDays: ['normal', 'reduced', 'normal', 'minimum', 'normal', 'normal', 'normal'] } }]) {
    for (const rwkvPlan of [undefined, planFor('a', st)]) {
      const opts = { ...base, rwkvPlan };
      const ivl = previewIntervals(st, opts, NOW, 'a');
      for (const rating of [1, 2, 3, 4]) {
        const o = opts.balance ? { ...opts, balance: { ...opts.balance, load: new Map(opts.balance.load) } } : { ...opts, fuzz: false };
        assert.equal(formatInterval(ivl[rating]), formatInterval(rate('a', st, rating, o, NOW).due - NOW), `rating ${rating}${rwkvPlan ? ' with plan' : ''}`);
      }
    }
  }
  const ivl = previewIntervals(st, { ...schedulerOptions({ fuzz: true }), rwkvPlan: planFor('a', st) }, NOW, 'a');
  assert.equal(ivl[3], 45 * DAY, 'the Good label is the plan\'s Good gap, with no fuzz');
});

test('the max interval, evening out and the exam limit still apply after the plan', { skip }, async () => {
  const { rate, schedulerOptions } = await load();
  const st = review('a');
  const capped = rate('a', st, 4, { ...schedulerOptions({ fuzz: false, maxInterval: 30 }), rwkvPlan: planFor('a', st) }, NOW);
  assert.equal(capped.scheduledDays, 30); assert.equal(capped.due, NOW + 30 * DAY);
  const maxDue = NOW + 20 * DAY;                                 // an exam in 20 days
  const exam = rate('a', st, 3, { ...schedulerOptions({ fuzz: false }), maxDue, rwkvPlan: planFor('a', st) }, NOW);
  assert.ok(exam.due < maxDue, 'a 45-day gap is pulled in front of the exam: ' + (exam.due - NOW) / DAY);
  // evening out moves the plan's day only inside its usual window (never by more than a few days at 45)
  const busy = new Map();
  const balanced = rate('a', st, 3, { ...schedulerOptions({ fuzz: true }), balance: { load: busy, easyDays: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal'] }, rwkvPlan: planFor('a', st) }, NOW);
  assert.ok(Math.abs(balanced.scheduledDays - 45) <= 5, 'evening out stays near the plan: ' + balanced.scheduledDays);
});

test('the scheduler cache key is not affected by the plan', { skip }, async () => {
  const { rate, schedulerOptions } = await load();
  const st = review('a');
  const opts = schedulerOptions({ fuzz: false });
  const first = rate('a', st, 3, opts, NOW);
  // different plans in between must not change what the plain options give (they would if the plan leaked into the cache key and a wrong scheduler were reused)
  for (let i = 0; i < 6; i++) rate('a', st, 3, { ...opts, rwkvPlan: planFor('a', st, { days: { 2: 10 + i, 3: 20 + i, 4: 30 + i } }) }, NOW);
  assert.deepEqual(rate('a', st, 3, opts, NOW), first);
  assert.deepEqual(rate('a', st, 3, { ...opts, rwkvPlan: undefined }, NOW), first);
});

test('the median of the last five answer times (8 seconds when there are none)', { skip: skip || !recentMs }, () => {
  const row = (t, ms, source = 'review') => ({ timestamp: t, ms, source });
  assert.equal(recentMs([]), 8000);
  assert.equal(recentMs([row(1, 0), row(2, NaN), row(3, 5000, 'play')]), 8000);
  assert.equal(recentMs([row(1, 9000), row(2, 3000), row(3, 5000)]), 5000);
  assert.equal(recentMs([row(1, 100000), row(2, 1000), row(3, 2000), row(4, 3000), row(5, 4000), row(6, 9000)]), 3000, 'only the last five count');
  assert.equal(recentMs([row(1, 2000), row(2, 4000)]), 3000);
});
