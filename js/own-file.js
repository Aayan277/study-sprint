// Own model: the model file format (.own). Pure: bytes in, bytes out. No DOM, no storage, no network.
// Used by the training tools and, later, by the lab's file picker. The file is treated as untrusted input.
//
//   bytes 0..8     the marker  OWNMODEL1
//   bytes 9..12    header length, a whole number (u32, little-endian)
//   then           the header: JSON text (UTF-8)
//   then           the parameters: one 32-bit float (little-endian) per parameter, nothing after them
//
// Header: { arch, size, sizes, paramCount, featureVersion, trainedOn: [{ id, licence }], seed, gitStamp, createdAt, info? }
//   arch      'own-gru-v1'
//   size      's' or 'm' (the memory sizes in js/own-spec.js); `sizes` must be exactly that size's numbers
//   info      optional notes about the run (flat: names to text, numbers or true/false), for people to read
import { OWN_FEATURE_VERSION, SIZES, paramCount } from './own-spec.js';

export const OWN_MAGIC = 'OWNMODEL1';
export const OWN_ARCH = 'own-gru-v1';
export const OWN_FILE_LIMITS = { maxBytes: 2 * 1024 * 1024, maxHeaderBytes: 16 * 1024, maxInfoKeys: 60, maxText: 400 };

export class OwnFileError extends Error {}
const bad = why => { throw new OwnFileError(why); };

const MAGIC_BYTES = Array.from(OWN_MAGIC, c => c.charCodeAt(0));
const KEYS = ['arch', 'size', 'sizes', 'paramCount', 'featureVersion', 'trainedOn', 'seed', 'gitStamp', 'createdAt', 'info'];
const text = (v, max = OWN_FILE_LIMITS.maxText) => typeof v === 'string' && v.length <= max;

// Checks a header object (from JSON or from the writer's input). Returns a clean copy. Throws OwnFileError in plain English.
export function checkHeader(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) bad('This model file is damaged (its header is not readable).');
  for (const k of Object.keys(h)) if (!KEYS.includes(k)) bad('This model file is damaged (its header has something unexpected in it).');
  if (h.arch !== OWN_ARCH) bad('This model was made for a different app version.');
  if (h.featureVersion !== OWN_FEATURE_VERSION) bad('This model was made for a different app version.');
  if (typeof h.size !== 'string' || !Object.prototype.hasOwnProperty.call(SIZES, h.size)) bad('This model has a size this app does not know.');
  const want = SIZES[h.size], got = h.sizes;
  if (!got || typeof got !== 'object' || Object.keys(want).some(k => got[k] !== want[k]) || Object.keys(got).length !== Object.keys(want).length) bad('This model does not fit the app (its memory sizes are different).');
  if (h.paramCount !== paramCount(h.size)) bad('This model does not fit the app (it has the wrong number of parameters).');
  if (!Array.isArray(h.trainedOn) || h.trainedOn.length > 8) bad('This model file is damaged (it does not say what it was trained on).');
  for (const t of h.trainedOn) {
    if (!t || typeof t !== 'object' || !text(t.id, 64) || !text(t.licence) || Object.keys(t).some(k => k !== 'id' && k !== 'licence')) bad('This model file is damaged (it does not say what it was trained on).');
  }
  if (!Number.isInteger(h.seed) || Math.abs(h.seed) > 2 ** 53) bad('This model file is damaged (its seed is not a whole number).');
  if (!text(h.gitStamp, 80) || !text(h.createdAt, 40)) bad('This model file is damaged (its header is incomplete).');
  let info;
  if (h.info !== undefined) {
    const i = h.info;
    if (!i || typeof i !== 'object' || Array.isArray(i) || Object.keys(i).length > OWN_FILE_LIMITS.maxInfoKeys) bad('This model file is damaged (its notes are not readable).');
    info = {};
    for (const [k, v] of Object.entries(i)) {
      if (k.length > 64 || !(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || text(v))) bad('This model file is damaged (its notes are not readable).');
      info[k] = v;
    }
  }
  const out = {
    arch: h.arch, size: h.size, sizes: { ...want }, paramCount: h.paramCount, featureVersion: h.featureVersion,
    trainedOn: h.trainedOn.map(t => ({ id: t.id, licence: t.licence })), seed: h.seed, gitStamp: h.gitStamp, createdAt: h.createdAt
  };
  if (info) out.info = info;
  return out;
}

// { size, params (Float32Array or Float64Array), trainedOn, seed, gitStamp, createdAt, info } -> Uint8Array
export function writeOwnFile({ size, params, trainedOn, seed = 0, gitStamp = 'unknown', createdAt = new Date().toISOString(), info }) {
  if (typeof size !== 'string' || !Object.prototype.hasOwnProperty.call(SIZES, size)) bad('This model has a size this app does not know.');
  const header = checkHeader({
    arch: OWN_ARCH, size, sizes: SIZES[size] || null, paramCount: paramCount(size), featureVersion: OWN_FEATURE_VERSION,
    trainedOn, seed, gitStamp, createdAt, ...(info ? { info } : {})
  });
  if (!params || params.length !== header.paramCount) bad('The parameters do not match the model size.');
  for (let i = 0; i < params.length; i++) if (!Number.isFinite(params[i])) bad('The parameters hold a value that is not a number.');
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.length > OWN_FILE_LIMITS.maxHeaderBytes) bad('The header is too long.');
  const out = new Uint8Array(OWN_MAGIC.length + 4 + json.length + params.length * 4);
  out.set(MAGIC_BYTES, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(OWN_MAGIC.length, json.length, true);
  out.set(json, OWN_MAGIC.length + 4);
  let at = OWN_MAGIC.length + 4 + json.length;
  for (let i = 0; i < params.length; i++, at += 4) dv.setFloat32(at, params[i], true);
  if (out.length > OWN_FILE_LIMITS.maxBytes) bad('This model is too big.');
  return out;
}

// bytes (Uint8Array or ArrayBuffer) -> { header, params: Float32Array }. Throws OwnFileError with a plain-English message.
export function parseOwnFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > OWN_FILE_LIMITS.maxBytes) bad('This file is too big to be an Own model.');
  const head = OWN_MAGIC.length + 4;
  if (bytes.length < OWN_MAGIC.length || MAGIC_BYTES.some((b, i) => bytes[i] !== b)) bad("This isn't an Own model file.");
  if (bytes.length < head) bad('This model file is incomplete.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = dv.getUint32(OWN_MAGIC.length, true);
  if (hlen < 2 || hlen > OWN_FILE_LIMITS.maxHeaderBytes) bad('This model file is damaged (its header has a wrong length).');
  if (bytes.length < head + hlen) bad('This model file is incomplete.');
  let json;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(head, head + hlen))); } catch { bad('This model file is damaged (its header is not readable).'); }
  const header = checkHeader(json);
  const body = bytes.length - head - hlen, want = header.paramCount * 4;
  if (body < want) bad('This model file is incomplete.');
  if (body > want) bad('This model file has extra data at the end.');
  const params = new Float32Array(header.paramCount);
  for (let i = 0, at = head + hlen; i < params.length; i++, at += 4) {
    const v = dv.getFloat32(at, true);
    if (!Number.isFinite(v)) bad('This model file holds a value that is not a number.');
    params[i] = v;
  }
  return { header, params };
}
