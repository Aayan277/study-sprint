// Own model: loading a model file the owner picked. The file is untrusted: it is size-checked, read with the strict reader in
// own-file.js, fingerprinted (sha256) and only then saved, whole, in the Own database. A broken file saves nothing.
// Every function returns a plain result object and never throws: { ok: true, ... } or { ok: false, code, message } where
// the message is plain English for the owner. Codes: 'too-big', 'not-own', 'wrong-version', 'damaged', 'unreadable', 'storage', 'blocked'.
import { parseOwnFile, OwnFileError, OWN_FILE_LIMITS } from './own-file.js';
import { openOwnDb, deleteOwnDb, OwnDbError } from './own-db.js';

const fail = (code, message) => ({ ok: false, code, message });

export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new OwnDbError('This browser cannot check the model file (no crypto available).', 'unreadable');
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

const codeFor = message => /too big/.test(message) ? 'too-big' : /different app version/.test(message) ? 'wrong-version'
  : /isn't an Own model/.test(message) ? 'not-own' : 'damaged';
const dbFail = e => e instanceof OwnDbError ? fail(e.code, e.message) : fail('storage', 'The Own model could not be saved.');

// Checks bytes only (no saving). -> { ok, bytes (ArrayBuffer copy), header, params, sha256 } or a failure
export async function checkModelBytes(input) {
  let bytes;
  try { bytes = input instanceof Uint8Array ? input : new Uint8Array(input); } catch { return fail('unreadable', 'That file could not be read.'); }
  if (bytes.length > OWN_FILE_LIMITS.maxBytes) return fail('too-big', 'This file is too big to be an Own model.');
  let parsed;
  try { parsed = parseOwnFile(bytes); } catch (e) {
    if (e instanceof OwnFileError) return fail(codeFor(e.message), e.message);
    return fail('damaged', 'This model file could not be read.');
  }
  let sha256;
  try { sha256 = await sha256Hex(bytes); } catch (e) { return fail('unreadable', e.message || 'The model file could not be checked.'); }
  return { ok: true, bytes: bytes.slice().buffer, header: parsed.header, params: parsed.params, sha256 };
}

// The picked file (anything with size, name and arrayBuffer(), like a File) -> { ok: true, name, sha256, header } or a failure.
// A model already loaded is replaced. Settings are created (switch off) the first time.
export async function loadModelFile(file, { idb, now = Date.now } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') return fail('unreadable', 'That file could not be read.');
  if (file.size > OWN_FILE_LIMITS.maxBytes) return fail('too-big', 'This file is too big to be an Own model.'); // before reading it
  let buf;
  try { buf = await file.arrayBuffer(); } catch { return fail('unreadable', 'That file could not be read.'); }
  const checked = await checkModelBytes(buf);
  if (!checked.ok) return checked;
  const name = String(file.name || 'model.own').slice(0, 120);
  let h;
  try {
    h = await openOwnDb({ idb });
    const before = await h.get('model', 'current');
    const changed = !!before && before.sha256 !== checked.sha256;
    if (changed) {
      // A different model: nothing that belongs to the old one may carry over. Its memory, its records and its verdicts go, and the next
      // open starts watching from scratch (state is made fresh then). The owner's switch stays as it was; a lock on FSRS is lifted.
      await Promise.all(['cards', 'notes', 'shared', 'preds'].map(st => h.clear(st)));
      for (const k of ['state', 'fingerprint', 'builder']) await h.delete('meta', k);
      const s = await h.get('meta', 'settings');
      if (s) await h.put('meta', 'settings', { ...s, autoLocked: false });
    }
    await h.put('model', 'current', { bytes: checked.bytes, sha256: checked.sha256, header: checked.header, name, loadedAt: now() });
    await h.put('meta', 'modelSha', checked.sha256);          // (a small note other tabs can read cheaply to see the model changed)
    if (!(await h.get('meta', 'settings'))) await h.put('meta', 'settings', { on: false, autoLocked: false });
  } catch (e) { return dbFail(e); } finally { if (h) h.close(); }
  return { ok: true, name, sha256: checked.sha256, header: checked.header };
}

// The saved model, read again with the strict reader (and its sha256 re-checked). Creates nothing.
// -> { ok: true, loaded: false } | { ok: true, loaded: true, name, sha256, header, params, loadedAt } | failure
export async function getLoadedModel({ idb } = {}) {
  let h, rec;
  try {
    h = await openOwnDb({ idb, forbidCreate: true });
    if (!h) return { ok: true, loaded: false };
    rec = await h.get('model', 'current');
  } catch (e) { return dbFail(e); } finally { if (h) h.close(); }
  if (!rec) return { ok: true, loaded: false };
  const checked = await checkModelBytes(rec.bytes);
  if (!checked.ok) return checked;
  if (checked.sha256 !== rec.sha256) return fail('damaged', 'The saved model has changed since it was loaded. Remove it and load it again.');
  return { ok: true, loaded: true, name: rec.name, sha256: rec.sha256, header: checked.header, params: checked.params, loadedAt: rec.loadedAt };
}

// Deletes the whole Own database: model, memory and records. Cards, reviews and due dates are not touched.
export async function removeModel({ idb } = {}) {
  try { await deleteOwnDb({ idb }); } catch (e) { return dbFail(e); }
  return { ok: true };
}
