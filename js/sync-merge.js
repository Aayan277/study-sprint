// How records travel between this device and the server, and which version wins.
// Pure functions (no database, no network), tested by tests/sync.test.js. sync.js does the actual syncing.
//
// On the server every record is one row: { store, id, data, deleted, updated_at, seq } (see supabase/setup.sql).
// The rule is simple: the newest change wins. A delete is a change too, so a card deleted on one device
// is deleted everywhere, unless it was edited somewhere else after it was deleted.

import { SYNC_ID } from './sync-data.js';

// Fields that only make sense on this device, so they're never sent:
//   updatedAt  sent separately as updated_at
//   syncedAt   "this version came from the server", so it doesn't need sending back
//   id         on review-log rows: a local counter (the uid is what identifies them across devices)
export function rowFromRecord(storeName, record) {
  const { updatedAt, syncedAt, ...data } = record;
  if (storeName === 'reviewLog') delete data.id;
  return { store: storeName, id: String(record[SYNC_ID[storeName]]), data, deleted: false, updated_at: updatedAt };
}

export const rowFromTombstone = t => ({ store: t.store, id: String(t.id), data: null, deleted: true, updated_at: t.deletedAt });

export const rowFromSetting = (key, value, time) => ({ store: 'settings', id: key, data: { value }, deleted: false, updated_at: time });

// A record as saved on this device after it arrives from the server. It's marked as already synced
// (syncedAt = updatedAt) so it isn't sent straight back.
export function recordFromRow(row) {
  return { ...row.data, updatedAt: row.updated_at, syncedAt: row.updated_at };
}

// What to do with a row from the server, given when this device last changed (or deleted) that record.
//   'skip'    this device's version is the same or newer (a newer one gets sent on the next push)
//   'put'     save the server's version
//   'delete'  delete it here too
export function decide(row, localTime = 0) {
  if (!(row.updated_at > localTime)) return 'skip';
  return row.deleted ? 'delete' : 'put';
}

// Has this record changed here since the last push, and not just arrived from the server?
export const needsPush = (record, since) => record.updatedAt > since && record.syncedAt !== record.updatedAt;
export const tombstoneNeedsPush = (t, since) => t.deletedAt > since && !t.synced;

// A record and its delete marker can both be waiting (e.g. a starter deck deleted, then added again).
// Send only the newest of each, since the server can't take the same row twice in one request.
export function newestOnly(rows) {
  const best = new Map();
  for (const r of rows) {
    const key = `${r.store}:${r.id}`;
    if (!best.has(key) || r.updated_at > best.get(key).updated_at) best.set(key, r);
  }
  return [...best.values()];
}

// Split a list into chunks (for sending many rows a few hundred at a time).
export function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// A sign-in link from a Supabase email (forgot password) opens the app with the sign-in after the #:
//   #access_token=…&refresh_token=…&expires_at=…&type=recovery
// or, if the link expired: #error=access_denied&error_code=otp_expired&error_description=…
// Returns { session } (without the user, which is looked up afterwards), { error }, or null for a normal address.
export function parseAuthLink(hash) {
  const text = String(hash || '').replace(/^#/, '');
  if (!/(^|&)(access_token|error)=/.test(text)) return null;
  const p = new URLSearchParams(text);
  if (p.get('error')) {
    const code = p.get('error_code') || p.get('error');
    return { error: code === 'otp_expired' ? 'That reset link has expired or was already used. Ask for a new one.' : (p.get('error_description') || 'That link didn’t work.').replace(/\+/g, ' ') };
  }
  if (p.get('type') !== 'recovery') return null;
  const expiresIn = Number(p.get('expires_in')) || 3600;
  return { session: {
    access_token: p.get('access_token'),
    refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + expiresIn
  } };
}
