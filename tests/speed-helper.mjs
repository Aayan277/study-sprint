// One shared way to time code on hostile input, used by every *-speed test (and the other tests that time hostile text).
//
// Why it looks like this: a limit of 300 ms on 50 KB failed on a busy computer and also let some old quadratic regexes pass
// (they took only 125 to 400 ms at 50 KB). At 200 KB the old code took 2 to 70 s and the fixed code at most about 40 ms,
// so 1500 ms separates the two with room on both sides. Two checks:
//   1. the run at 200 KB must finish within LIMIT_MS (the first run fails at once, so slow old code does not take minutes);
//   2. 4x the input must take less than 8x the time (best of 3 runs each). Because of check 1 and the floor below, this only
//      bites when 200 KB takes 800 to 1500 ms; the limit in 1 does the real work. Runs under FLOOR_MS are too small to compare (a few ms of noise or a busy computer swings them 10x), so they count as FLOOR_MS.
//      Old quadratic code took 125 to 400 ms at 50 KB, above the floor, and seconds at 200 KB, so the limit in 1 catches it too.
import assert from 'node:assert/strict';
import { test } from 'node:test';

export const BASE_BYTES = 50000;           // the size the old tests used; every size in a test is a multiple of this
export const BYTES = 200000;               // the size the limit is checked at
export const GROWTH = BYTES / BASE_BYTES;  // 4
export const LIMIT_MS = 1500;
export const MAX_RATIO = 8;                // 4x the input must take less than 8x the time (quadratic gives 16x)
export const FLOOR_MS = 100;
export const RUNS = 3;

let scale = 1;
// A size in bytes (or repeats) at the current scale: size(50000) is 50 KB for the small run and 200 KB for the big one.
export const size = n => Math.round(n * scale);
// s repeated up to `bytes` (a 50 KB default) at the current scale. Use this, not String.repeat, for every hostile input.
export const rep = (s, bytes = BASE_BYTES) => s.repeat(Math.ceil(size(bytes) / s.length));

const timeOnce = fn => { const t = performance.now(); fn(); return performance.now() - t; };

// Times fn() at the given scale and gives back the best of `runs` (stops at the first run over `limit`, which already fails).
export function bestAt(factor, fn, { runs = RUNS, limit = Infinity } = {}) {
  const before = scale;
  scale = factor;
  try {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      best = Math.min(best, timeOnce(fn));
      if (best >= limit) break;
    }
    return best;
  } finally { scale = before; }
}

// The shared check. fn builds its hostile input with rep()/size() and runs the code under test on it.
export function assertFast(name, fn) {
  const big = bestAt(GROWTH, fn, { limit: LIMIT_MS });
  assert.ok(big < LIMIT_MS, `${name} took ${big.toFixed(0)} ms on ${BYTES / 1000} KB (limit ${LIMIT_MS} ms)`);
  const small = bestAt(1, fn);
  assert.ok(big < MAX_RATIO * Math.max(small, FLOOR_MS),
    `${name}: ${GROWTH}x the input took ${big.toFixed(1)} ms against ${small.toFixed(1)} ms (limit ${MAX_RATIO}x), so it is not linear`);
}

// test(`fast on hostile text: ${name}`, ...) around assertFast, for the files that list many cases.
export const fast = (name, fn) => test(`fast on hostile text: ${name}`, () => assertFast(name, fn));
