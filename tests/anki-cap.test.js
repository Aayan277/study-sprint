// The Anki reader refuses a "zip bomb" (js/anki-read.js): the zstd unpacker's output is counted as it comes out.
// (That a whole .apkg bomb is refused with a message is tests/browser/e2e-anki-cap.mjs.) Run with: node tests/anki-cap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzstd, MAX_UNPACKED, ankiTooBigMessage } from '../js/anki-read.js';

// A stand-in for fzstd's streaming Decompress: pushes `chunks` blocks of `size` bytes to the handler.
const fake = (chunks, size) => ({
  Decompress: class { constructor(ondata) { this.ondata = ondata; } push() { for (let i = 0; i < chunks; i++) this.ondata(new Uint8Array(size).fill(i + 1), i === chunks - 1); } }
});

test('unzstd joins the blocks in order', () => {
  const out = unzstd(fake(3, 4), new Uint8Array(1));
  assert.deepEqual([...out], [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
});

test('unzstd stops at the cap, with a message that says why', () => {
  assert.equal(MAX_UNPACKED, 100 * 1024 * 1024);
  assert.doesNotThrow(() => unzstd(fake(2, 50), new Uint8Array(1), 100));
  assert.throws(() => unzstd(fake(3, 50), new Uint8Array(1), 100), e => e.code === 'too-big' && e.message === ankiTooBigMessage());
  assert.match(ankiTooBigMessage(), /more than 100 MB/);
});

test('unzstd stops counting at the cap, it does not unpack the rest first', () => {
  let pushed = 0;
  const z = { Decompress: class { constructor(f) { this.f = f; } push() { for (let i = 0; i < 1000; i++) { pushed++; this.f(new Uint8Array(10), false); } } } };
  assert.throws(() => unzstd(z, new Uint8Array(1), 95), e => e.code === 'too-big');
  assert.equal(pushed, 10);
});
