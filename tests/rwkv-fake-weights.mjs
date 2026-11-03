// Test helper: a made-up weights file with the right names and shapes and small random numbers. Built in memory, never saved.
import { expectedTensors } from '../js/rwkv-spec.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// -> { buffer: ArrayBuffer, values: Map(name -> { shape, data }) }  (values = what a correct reader should return)
export function fakeWeights({ seed = 1, format = 'int8', scale = 0.1, only = null, mutate = null } = {}) {
  const rand = rng(seed);
  const list = [];
  for (const [name, spec] of expectedTensors()) {
    const n = spec.count;
    let data = Float32Array.from({ length: n }, () => (rand() * 2 - 1) * scale);
    list.push({ name, shape: spec.shape, data });
  }
  if (mutate) mutate(list);
  const chunks = [];
  const magic = format === 'int8' ? 'ARWKVWEIGHTS8PC1' : 'ARWKVWEIGHTS1';
  const bytes = x => chunks.push(x instanceof Uint8Array ? x : new Uint8Array(x));
  const enc = new TextEncoder();
  bytes(enc.encode(magic));
  const u32 = v => { const b = new ArrayBuffer(4); new DataView(b).setUint32(0, v, true); bytes(b); };
  const u16 = v => { const b = new ArrayBuffer(2); new DataView(b).setUint16(0, v, true); bytes(b); };
  const values = new Map();
  const written = only ? list.filter(t => only(t.name)) : list;
  u32(written.length);
  for (const t of written) {
    const nm = enc.encode(t.name);
    u16(nm.length); bytes(nm);
    const asInt8 = format === 'int8' && t.shape.length === 2 && t.name.endsWith('.weight');
    if (format === 'int8') bytes(Uint8Array.of(asInt8 ? 1 : 0));
    bytes(Uint8Array.of(t.shape.length));
    for (const d of t.shape) u32(d);
    if (asInt8) {
      const [rows, cols] = t.shape;
      const scales = new Float32Array(rows), codes = new Int8Array(rows * cols), deq = new Float32Array(rows * cols);
      for (let r = 0; r < rows; r++) {
        let mx = 0;
        for (let c = 0; c < cols; c++) mx = Math.max(mx, Math.abs(t.data[r * cols + c]));
        const s = mx === 0 ? 1 : Math.fround(mx / 127);
        scales[r] = s;
        for (let c = 0; c < cols; c++) { const q = Math.max(-127, Math.min(127, Math.round(t.data[r * cols + c] / s))) || 0; codes[r * cols + c] = q; deq[r * cols + c] = q * s; }
      }
      bytes(new Uint8Array(scales.buffer)); bytes(new Uint8Array(codes.buffer));
      values.set(t.name, { shape: t.shape, data: deq });
    } else {
      bytes(new Uint8Array(t.data.buffer.slice(0)));
      values.set(t.name, { shape: t.shape, data: t.data });
    }
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { buffer: out.buffer, values };
}
