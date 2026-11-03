import { test } from 'node:test';
import assert from 'node:assert/strict';
import { f32ToF16, f16ToF32, roundHalfEven, encodeEntity, decodeEntity, encodedSize } from '../js/rwkv-state.js';
import { STREAMS } from '../js/rwkv-spec.js';

test('half precision: exact cases', () => {
  const cases = [[0, 0x0000], [1, 0x3c00], [-2, 0xc000], [0.5, 0x3800], [65504, 0x7bff], [65520, 0x7c00], [1e9, 0x7c00], [2 ** -24, 0x0001], [2 ** -25, 0x0000],
    [1.5 * 2 ** -24, 0x0002], [2 ** -14, 0x0400], [1 + 2 ** -11, 0x3c00], [1 + 3 * 2 ** -11, 0x3c02], [Infinity, 0x7c00], [-Infinity, 0xfc00]];
  for (const [v, bits] of cases) assert.equal(f32ToF16(v), bits, `f32ToF16(${v})`);
  assert.ok(Number.isNaN(f16ToF32(f32ToF16(NaN))));
  assert.equal(f16ToF32(0x3c00), 1);
  assert.equal(f16ToF32(0x0001), 2 ** -24);
});

test('every half-precision number survives a round trip', () => {
  for (let h = 0; h < 65536; h++) {
    if ((h & 0x7c00) === 0x7c00 && (h & 0x3ff)) continue;       // NaN
    assert.equal(f32ToF16(f16ToF32(h)), h, '0x' + h.toString(16));
  }
});

test('half precision rounds to the nearest representable value', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 20000; i++) {
    const v = Math.fround((rnd() * 2 - 1) * 2 ** Math.floor(rnd() * 30 - 15));
    const back = f16ToF32(f32ToF16(v));
    if (Math.abs(v) < 65504 && Math.abs(v) > 2 ** -14) assert.ok(Math.abs(back - v) <= Math.abs(v) * 2 ** -11 * 1.0001, `${v} -> ${back}`);
  }
});

test('round half to even', () => {
  for (const [x, want] of [[0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [-0.5, 0], [-1.5, -2], [-2.5, -2], [2.4, 2], [2.6, 3], [-2.6, -3], [126.5, 126], [127.5, 128]]) {
    assert.equal(roundHalfEven(x) + 0, want, String(x));
  }
});

function randomState(streamIdx, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
  return { layers: Array.from({ length: STREAMS[streamIdx].layers }, (_, l) => {
    const ly = { shift: Float32Array.from({ length: 64 }, () => rnd() * 3), S: Float32Array.from({ length: 1024 }, (_, i) => rnd() * (1 + (i >> 4) % 5)) };
    if (STREAMS[streamIdx].mixer.includes(l)) ly.cshift = Float32Array.from({ length: 64 }, () => rnd() * 2);
    return ly;
  }) };
}

test('byte sizes: a card is about 2.9 KB and a note about 1.5 KB', () => {
  assert.equal(encodedSize(0), 2 * (128 + 64 * 20) + 128);
  assert.equal(encodedSize(0), 2944);
  assert.equal(encodedSize(2), 1536);
  assert.equal(encodedSize(1), 17920);
  assert.equal(encodedSize(3), 13056);
  assert.equal(encodedSize(4), 13056);
  for (const i of [0, 1, 2, 3, 4]) assert.equal(encodeEntity(i, randomState(i, 5)).byteLength, encodedSize(i));
});

test('card and note states: each number is within half a step of the original', () => {
  for (const i of [0, 2]) {
    const st = randomState(i, 11), back = decodeEntity(i, encodeEntity(i, st));
    st.layers.forEach((ly, l) => {
      for (let r = 0; r < 64; r++) {
        let mx = 0;
        for (let j = 0; j < 16; j++) mx = Math.max(mx, Math.abs(ly.S[r * 16 + j]));
        const step = Math.fround(mx / 127);
        for (let j = 0; j < 16; j++) assert.ok(Math.abs(back.layers[l].S[r * 16 + j] - ly.S[r * 16 + j]) <= step / 2 * 1.0001 + 1e-9);
      }
      for (let c = 0; c < 64; c++) assert.ok(Math.abs(back.layers[l].shift[c] - ly.shift[c]) <= Math.abs(ly.shift[c]) * 2 ** -11 + 1e-7);
      assert.equal(!!back.layers[l].cshift, !!ly.cshift);
    });
  }
});

test('an all-zero row is stored with scale 1 and comes back as zeros', () => {
  const st = randomState(0, 3);
  st.layers[0].S.fill(0, 0, 16);
  const back = decodeEntity(0, encodeEntity(0, st));
  assert.deepEqual(Array.from(back.layers[0].S.subarray(0, 16)), new Array(16).fill(0));
});

test('deck, preset and user states are kept exactly', () => {
  for (const i of [1, 3, 4]) {
    const st = randomState(i, 21), back = decodeEntity(i, encodeEntity(i, st));
    st.layers.forEach((ly, l) => { assert.deepEqual(back.layers[l].S, ly.S); assert.deepEqual(back.layers[l].shift, ly.shift); });
  }
});

test('a saved state of the wrong size is refused', () => {
  assert.throws(() => decodeEntity(0, new ArrayBuffer(100)), /wrong size/);
});
