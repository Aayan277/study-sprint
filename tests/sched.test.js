// Tests for js/sched-settings.js (advanced scheduling settings). Run with: node tests/sched.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, formatSteps, parseMaxInterval, schedulerOptions, SCHED_DEFAULTS } from '../js/sched-settings.js';

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
