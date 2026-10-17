// Tests for js/sched-settings.js (advanced scheduling settings). Run with: node tests/sched.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, formatSteps, parseMaxInterval, schedulerOptions, deckSchedulerOptions, SCHED_DEFAULTS, stepWords, sortSteps, explainSteps, cleanFsrsParams, personalW20, FSRS_VERSION } from '../js/sched-settings.js';

test('steps: minutes, hours and days, with spaces or commas', () => {
  assert.deepEqual(parseSteps('1m 10m'), { steps: ['1m', '10m'] });
  assert.deepEqual(parseSteps(' 5m, 30m,1h '), { steps: ['5m', '30m', '1h'] });
  assert.deepEqual(parseSteps('1D 2days 15min 3hr'), { steps: ['1d', '2d', '15m', '3h'] });
  assert.deepEqual(parseSteps(''), { steps: [] });          // no steps: new cards graduate straight away
  assert.equal(formatSteps(['5m', '1h']), '5m 1h');
});

test('steps: clear messages for things that can\'t be read', () => {
  assert.match(parseSteps('10x').error, /"10x" isn't a step/);
  assert.match(parseSteps('10').error, /isn't a step/);
  assert.match(parseSteps('0m').error, /isn't a step/);
  assert.match(parseSteps('1.5h').error, /isn't a step/);
  assert.match(parseSteps('40d').error, /too long/);
  assert.match(parseSteps('1m '.repeat(11)).error, /10 steps or fewer/);
});

test('maximum interval: whole days from 1, capped at 36500', () => {
  assert.deepEqual(parseMaxInterval('30'), { days: 30 });
  assert.deepEqual(parseMaxInterval(99999), { days: 36500 });
  assert.ok(parseMaxInterval(0).error);
  assert.ok(parseMaxInterval('abc').error);
  assert.ok(parseMaxInterval(2.5).error);
});

test('scheduler options: defaults match how the app always worked', () => {
  assert.deepEqual(schedulerOptions({}), { retention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], maxInterval: 36500, fuzz: true });
  assert.deepEqual(SCHED_DEFAULTS, { learningSteps: '1m 10m', relearningSteps: '10m', maxInterval: 36500, fuzz: true });
});

test('scheduler options: your settings, with anything broken falling back to the default', () => {
  const o = schedulerOptions({ targetRetention: 0.85, learningSteps: '5m 1h', relearningSteps: 'nonsense', maxInterval: 90, fuzz: false });
  assert.deepEqual(o, { retention: 0.85, learningSteps: ['5m', '1h'], relearningSteps: ['10m'], maxInterval: 90, fuzz: false });
  assert.deepEqual(schedulerOptions({ learningSteps: '' }).learningSteps, []);
});

test('steps in plain words', () => {
  assert.equal(stepWords('1m'), '1 minute');
  assert.equal(stepWords('10m'), '10 minutes');
  assert.equal(stepWords('1h'), '1 hour');
  assert.equal(stepWords('2d'), '2 days');
  assert.deepEqual(sortSteps(['1h', '10m', '1d', '1m']), ['1m', '10m', '1h', '1d']);
});

test('what each button does with the steps', () => {
  assert.deepEqual(explainSteps(['1m', '10m'], 'learning'), [
    ['Again', 'back in 1 minute (step 1)'],
    ['Good', 'moves to the next step: 10 minutes (step 2)'],
    ['Good on the last step', 'moves on to normal reviews (days apart)'],
    ['Easy', 'skips the steps and moves on to normal reviews (days apart)']
  ]);
  assert.deepEqual(explainSteps(['5m', '30m', '1h'], 'learning')[1], ['Good', 'moves to the next step: 30 minutes (step 2), then 1 hour (step 3)']);
  assert.deepEqual(explainSteps(['10m'], 'relearning'), [
    ['Again', 'back in 10 minutes (step 1)'],
    ['Good', 'goes back to normal reviews'],
    ['Easy', 'skips the steps and goes back to normal reviews']
  ]);
  assert.deepEqual(explainSteps([], 'learning'), [['Any button', 'No steps: the card moves on to normal reviews (days apart) straight away.']]);
});

// ---------- your own FSRS parameters (fsrsParams) ----------
const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542].map((x, i) => (i === 20 ? 0.3 : x));
const MINE = { w: W, at: 1_800_000_000_000, reviews: 3412, cards: 611, logLoss: { before: 0.312, after: 0.298 }, rmse: { before: 0.041, after: 0.032 }, version: 'fsrs-6' };

test('cleanFsrsParams: a good value comes back as it is (a copy), a reset value too', () => {
  assert.deepEqual(cleanFsrsParams(MINE), MINE);
  assert.notEqual(cleanFsrsParams(MINE).w, MINE.w);
  const reset = { w: null, at: 5, version: 'fsrs-6' };
  assert.deepEqual(cleanFsrsParams(reset), reset);
  assert.equal(FSRS_VERSION, 'fsrs-6');
});

test('cleanFsrsParams: anything unusable is null (the standard settings)', () => {
  for (const bad of [undefined, null, 0, 'fsrs-6', [], [W], true,
    { ...MINE, version: 'fsrs-7' }, { ...MINE, version: undefined }, { w: W },
    { ...MINE, w: W.slice(0, 20) }, { ...MINE, w: [...W, 1] }, { ...MINE, w: undefined }, { ...MINE, w: 'x'.repeat(21) },
    { ...MINE, w: W.map((x, i) => (i === 3 ? NaN : x)) }, { ...MINE, w: W.map((x, i) => (i === 3 ? Infinity : x)) },
    { ...MINE, w: W.map((x, i) => (i === 3 ? '2' : x)) }, { ...MINE, w: W.map((x, i) => (i === 3 ? null : x)) }]) {
    assert.equal(cleanFsrsParams(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('cleanFsrsParams: unknown fields and unreadable details are dropped, the weights are kept', () => {
  const c = cleanFsrsParams({ ...MINE, evil: '<img src=x onerror=alert(1)>', at: 'yesterday', reviews: -3, cards: 2.5, logLoss: { before: 1 }, rmse: 'x' });
  assert.deepEqual(c, { w: W, version: 'fsrs-6' });
  assert.ok(!('evil' in c));
});

test('scheduler options: your own weights are passed on; without them there is no w at all', () => {
  assert.equal(schedulerOptions({}).w, undefined);
  assert.ok(!('w' in schedulerOptions({ fsrsParams: null })));
  assert.ok(!('w' in schedulerOptions({ fsrsParams: { w: null, at: 1, version: 'fsrs-6' } })));      // after "Reset to default"
  assert.ok(!('w' in schedulerOptions({ fsrsParams: { ...MINE, version: 'fsrs-7' } })));              // junk is ignored
  assert.deepEqual(schedulerOptions({ fsrsParams: MINE }).w, W);
  assert.deepEqual({ ...schedulerOptions({ fsrsParams: MINE }), w: undefined }, { ...schedulerOptions({}), w: undefined });
});

test('deck options never override your FSRS parameters: they are the same for every deck', () => {
  const settings = { targetRetention: 0.9, fsrsParams: MINE };
  const deck = { options: { targetRetention: 0.8, learningSteps: '5m', fsrsParams: { ...MINE, w: W.map(x => x * 2) } } };
  const o = deckSchedulerOptions(settings, deck);
  assert.deepEqual(o.w, W);
  assert.equal(o.retention, 0.8);                                        // the deck's own retention still applies
  assert.deepEqual(deckSchedulerOptions(settings, { id: 'plain' }).w, W);
  assert.ok(!('w' in deckSchedulerOptions({ targetRetention: 0.9 }, deck)));
});

test('personalW20: the decay of your weights, kept in the range the scheduler allows; none for the standard ones', () => {
  assert.equal(personalW20({ fsrsParams: MINE }), 0.3);
  assert.equal(personalW20({}), undefined);
  assert.equal(personalW20({ fsrsParams: { w: null, version: 'fsrs-6' } }), undefined);
  assert.equal(personalW20({ fsrsParams: { ...MINE, w: W.map((x, i) => (i === 20 ? 0 : x)) } }), 0.1);
  assert.equal(personalW20({ fsrsParams: { ...MINE, w: W.map((x, i) => (i === 20 ? 5 : x)) } }), 0.8);
  assert.equal(personalW20(undefined), undefined);
});
