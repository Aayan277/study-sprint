// Tests for js/sched-settings.js (advanced scheduling settings). Run with: node tests/sched.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, formatSteps, parseMaxInterval, schedulerOptions, SCHED_DEFAULTS, stepWords, stepShort, sortSteps, explainSteps } from '../js/sched-settings.js';

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
  assert.equal(stepShort('10m'), '10 min');
  assert.equal(stepShort('1h'), '1 h');
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
