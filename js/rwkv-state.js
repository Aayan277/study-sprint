// RWKV lab: saving one entity's memory state compactly. Card and note states use int8 rows plus half-precision shifts;
// deck, preset and user states stay float32. Pure code (no DOM, no storage).
import { STREAMS, D, H, K } from './rwkv-spec.js';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

// float32 -> half-precision bits, rounding to nearest even
export function f32ToF16(v) {
  f32[0] = v;
  const x = u32[0], sign = (x >>> 16) & 0x8000, e = (x >>> 23) & 0xff;
  let m = x & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  const he = e - 127 + 15;
  if (he >= 31) return sign | 0x7c00;
  if (he <= 0) {
    if (he < -10) return sign;
    m |= 0x800000;
    const shift = 14 - he, rem = m & ((1 << shift) - 1), mid = 1 << (shift - 1);
    let half = m >>> shift;
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = (he << 10) | (m >>> 13);
  const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return sign | half;
}

export function f16ToF32(h) {
  const sign = (h & 0x8000) ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * (1 + m / 1024) * 2 ** (e - 15);
}

export function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

const ROWS = H * K;                          // 64 rows of 16 per layer
const quantised = streamIdx => streamIdx === 0 || streamIdx === 2;

export function encodedSize(streamIdx) {
  const s = STREAMS[streamIdx];
  const mixers = s.mixer.length;
  if (quantised(streamIdx)) return s.layers * (D * 2 + ROWS * (4 + K)) + mixers * D * 2;
  return (s.layers * (D + ROWS * K) + mixers * D) * 4;
}

// st = { layers: [{ shift, S, cshift? }] }  ->  ArrayBuffer
export function encodeEntity(streamIdx, st) {
  const s = STREAMS[streamIdx];
  const buf = new ArrayBuffer(encodedSize(streamIdx));
  const dv = new DataView(buf);
  let pos = 0;
  const q = quantised(streamIdx);
  const putShift = a => {
    if (q) for (let i = 0; i < D; i++, pos += 2) dv.setUint16(pos, f32ToF16(a[i]), true);
    else for (let i = 0; i < D; i++, pos += 4) dv.setFloat32(pos, a[i], true);
  };
  for (let l = 0; l < s.layers; l++) {
    const ly = st.layers[l];
    putShift(ly.shift);
    if (q) {
      for (let r = 0; r < ROWS; r++) {
        const o = r * K;
        let mx = 0;
        for (let j = 0; j < K; j++) mx = Math.max(mx, Math.abs(ly.S[o + j]));
        const scale = mx === 0 ? 1 : Math.fround(mx / 127);
        dv.setFloat32(pos, scale, true); pos += 4;
        for (let j = 0; j < K; j++, pos++) dv.setInt8(pos, Math.max(-127, Math.min(127, roundHalfEven(Math.fround(ly.S[o + j] / scale)))));
      }
    } else for (let i = 0; i < ROWS * K; i++, pos += 4) dv.setFloat32(pos, ly.S[i], true);
    if (s.mixer.includes(l)) putShift(ly.cshift);
  }
  return buf;
}

export function decodeEntity(streamIdx, buf) {
  const s = STREAMS[streamIdx];
  if (buf.byteLength !== encodedSize(streamIdx)) throw new Error('Saved memory state has the wrong size.');
  const dv = new DataView(buf);
  let pos = 0;
  const q = quantised(streamIdx);
  const getShift = () => {
    const a = new Float32Array(D);
    if (q) for (let i = 0; i < D; i++, pos += 2) a[i] = f16ToF32(dv.getUint16(pos, true));
    else for (let i = 0; i < D; i++, pos += 4) a[i] = dv.getFloat32(pos, true);
    return a;
  };
  const layers = [];
  for (let l = 0; l < s.layers; l++) {
    const ly = { shift: getShift(), S: new Float32Array(ROWS * K) };
    if (q) {
      for (let r = 0; r < ROWS; r++) {
        const scale = dv.getFloat32(pos, true); pos += 4;
        for (let j = 0; j < K; j++, pos++) ly.S[r * K + j] = dv.getInt8(pos) * scale;
      }
    } else for (let i = 0; i < ROWS * K; i++, pos += 4) ly.S[i] = dv.getFloat32(pos, true);
    if (s.mixer.includes(l)) ly.cshift = getShift();
    layers.push(ly);
  }
  return { layers };
}
