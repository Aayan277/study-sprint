// A small reader for numpy .npz files (a zip of .npy arrays), for outside predictions kept next to the data. Untrusted input:
// size caps, plain 1-d (or single-number) arrays of little-endian floats and integers only, no zip64, no pickles, nothing is run.
import { inflateRawSync } from 'node:zlib';

export const NPZ_LIMITS = { maxBytes: 256 * 1024 * 1024, maxEntries: 16, maxArrayBytes: 256 * 1024 * 1024 };
export class NpzError extends Error {}
const bad = why => { throw new NpzError(why); };

const DTYPES = { '<f8': [Float64Array, 8], '<f4': [Float32Array, 4], '<i8': [BigInt64Array, 8], '<i4': [Int32Array, 4], '|u1': [Uint8Array, 1], '|b1': [Uint8Array, 1] };

function parseNpy(buf) {
  if (buf.length < 12 || buf[0] !== 0x93 || buf.toString('latin1', 1, 6) !== 'NUMPY') bad('not a .npy array');
  const major = buf[6];
  let hlen, at;
  if (major === 1) { hlen = buf.readUInt16LE(8); at = 10; } else if (major === 2 || major === 3) { hlen = buf.readUInt32LE(8); at = 12; } else bad('unknown .npy version');
  if (at + hlen > buf.length || hlen > 4096) bad('bad .npy header');
  const h = buf.toString('latin1', at, at + hlen);
  const descr = /'descr'\s*:\s*'([^']{1,8})'/.exec(h)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(h)?.[1];
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(h)?.[1];
  if (!descr || !DTYPES[descr] || fortran === undefined || shapeText === undefined) bad('unsupported array type');
  const dims = shapeText.split(',').map(s => s.trim()).filter(Boolean).map(Number);
  if (dims.length > 1 || dims.some(d => !Number.isInteger(d) || d < 0)) bad('only 1-d arrays are supported');
  const count = dims.length ? dims[0] : 1, [Type, size] = DTYPES[descr];
  const start = at + hlen;
  if (count * size > NPZ_LIMITS.maxArrayBytes || start + count * size !== buf.length) bad('array size does not match its header');
  const copy = new Uint8Array(buf.subarray(start)).buffer;       // aligned copy
  let data = new Type(copy);
  if (Type === BigInt64Array) data = Float64Array.from(data, Number);
  return { shape: dims, data };
}

// buffer -> { name: { shape, data } }
export function readNpz(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length > NPZ_LIMITS.maxBytes) bad('file too large');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) bad('not a zip file');
  const entries = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdAt = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdAt === 0xffffffff) bad('zip64 is not supported');
  if (entries > NPZ_LIMITS.maxEntries || cdAt + cdSize > buf.length) bad('bad zip directory');
  const out = {};
  let p = cdAt;
  for (let k = 0; k < entries; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) bad('bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lat = buf.readUInt32LE(p + 42);
    const name = buf.toString('latin1', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (usize > NPZ_LIMITS.maxArrayBytes + 4096) bad('entry too large');
    if (lat + 30 > buf.length || buf.readUInt32LE(lat) !== 0x04034b50) bad('bad zip entry');
    const dataAt = lat + 30 + buf.readUInt16LE(lat + 26) + buf.readUInt16LE(lat + 28);
    if (dataAt + csize > buf.length) bad('zip entry runs past the end of the file');
    const raw = buf.subarray(dataAt, dataAt + csize);
    let body;
    if (method === 0) body = raw; else if (method === 8) { try { body = inflateRawSync(raw, { maxOutputLength: usize + 16 }); } catch { bad('could not unpack an entry'); } } else bad('unsupported zip compression');
    if (body.length !== usize) bad('entry size does not match');
    if (!/^[A-Za-z0-9_.-]{1,64}\.npy$/.test(name)) bad('unexpected entry name');
    out[name.slice(0, -4)] = parseNpy(Buffer.from(body));
  }
  return out;
}
