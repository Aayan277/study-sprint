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
    // Fixed messages only: the text after "error_description=" can be written by anyone who makes the link.
    return { error: code === 'otp_expired' ? 'That link has expired or was already used. Ask for a new one (Forgot password, or Create account again).' : 'That link didn’t work. Ask for a new reset email.' };
  }
  if (p.get('type') === 'signup') return { confirmed: true };          // the "confirm your email" link: nothing to keep
  if (p.get('type') !== 'recovery') return null;
  const expiresIn = Number(p.get('expires_in')) || 3600;
  return { session: {
    access_token: p.get('access_token'),
    refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + expiresIn
  } };
}

// ---------- days off (the restDays setting) ----------
// { 'YYYY-MM-DD': { on, at } }: whether a day is a day off, and when that was last decided. Merged per day,
// so two devices that each add a day off keep both; for the same day the later decision wins (on a tie, "on").
// Junk keys and values are dropped, and so is anything over 3650 days old: the streak walk (stats-calc.js MAX_DAYS) reads that far back,
// so a shorter prune would cut a long streak at a day off.
const DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_FLAG_AGE_DAYS = 3650;     // = MAX_DAYS in stats-calc.js, how far back the streak is walked
export const MAX_AHEAD_DAYS = 60;      // how far ahead a day off can be planned (streak-sheet.js re-exports it)
const FUTURE_SLACK_DAYS = 2;           // time zones and the 4am rollover: a key can be a day or two beyond the limit
const MAX_FUTURE_ENTRIES = MAX_AHEAD_DAYS + FUTURE_SLACK_DAYS + 1;
const DAY = 86400000;
const keyOf = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Junk is dropped: bad keys, bad values, a decision time that is not a positive safe integer or lies more than a day
// in the future (a huge `at` would make a day off unremovable), keys older than 3650 days or further ahead than a
// day off can be planned, and (if there are still too many) the furthest-future keys.
// The cap on the number of entries is applied after merging (capDayFlags), never to one side before the comparison.
export const MAX_FLAG_ENTRIES = 1000;
function cleanDayFlags(flags, cutoff, now, latest) {
  const out = {};
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return out;
  for (const [k, v] of Object.entries(flags)) {
    if (!DAY_KEY.test(k) || k < cutoff || k > latest || !v || typeof v !== 'object' || typeof v.on !== 'boolean') continue;
    if (!Number.isSafeInteger(v.at) || v.at <= 0 || v.at > now + DAY) continue;
    out[k] = { on: v.on, at: v.at };
  }
  const today = keyOf(now);
  const future = Object.keys(out).filter(k => k > today).sort();
  for (const k of future.slice(MAX_FUTURE_ENTRIES)) delete out[k];
  return out;
}
// Keep the one synced settings row small (it must stay under the 60 KB push limit, about 42 bytes an entry): at most
// MAX_FLAG_ENTRIES entries. Switched-off days go first, oldest first (the streak only reads days that are on, so a past
// "off" means the same as no entry), then the oldest days that are on (a streak that long is hardly ever running through
// them). "Off" entries are never dropped for their age alone: the newer "off" must still beat an older "on" from a device
// that was offline for a long time. Done on the merged result, so the limit holds for what is stored and sent.
function capDayFlags(out) {
  const keys = Object.keys(out);
  let extra = keys.length - MAX_FLAG_ENTRIES;
  if (extra <= 0) return out;
  keys.sort();
  for (const k of keys) { if (extra <= 0) break; if (!out[k].on) { delete out[k]; extra--; } }
  for (const k of keys) { if (extra <= 0) break; if (k in out) { delete out[k]; extra--; } }
  return out;
}
const flagCutoff = now => keyOf(now - MAX_FLAG_AGE_DAYS * DAY);
const flagLatest = now => keyOf(now + (MAX_AHEAD_DAYS + FUTURE_SLACK_DAYS) * DAY);
export function mergeDayFlags(a, b, now = Date.now()) {
  const cutoff = flagCutoff(now), latest = flagLatest(now);
  const out = cleanDayFlags(a, cutoff, now, latest);
  for (const [k, v] of Object.entries(cleanDayFlags(b, cutoff, now, latest))) {
    const mine = out[k];
    if (!mine || v.at > mine.at || (v.at === mine.at && v.on)) out[k] = v;
  }
  return capDayFlags(out);
}
// Do two sets of day flags say the same thing? (Junk is ignored, as in the merge.)
export function sameDayFlags(a, b, now = Date.now()) {
  const cutoff = flagCutoff(now), latest = flagLatest(now);
  const x = cleanDayFlags(a, cutoff, now, latest), y = cleanDayFlags(b, cutoff, now, latest);
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => y[k] && y[k].on === x[k].on && y[k].at === x[k].at);
}

// ---------- days when nothing was due (the idleDays setting) ----------
// { 'YYYY-MM-DD': true }: study days when the ring said "Nothing due today" (study-data.js idleDaysToMark). Merged as a union, so a day
// either device noted counts on both. Nothing ever un-notes a day, so there is no "at". Junk is dropped, and so is anything older than
// 3650 days (the streak walk reads that far back, so a shorter prune would cut a long streak) or more than a day ahead (time zones).
export const MAX_IDLE_DAYS_AGE = MAX_FLAG_AGE_DAYS;
function cleanIdleDays(flags, now) {
  const out = {};
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return out;
  const cutoff = keyOf(now - MAX_IDLE_DAYS_AGE * DAY), latest = keyOf(now + DAY);
  for (const [k, v] of Object.entries(flags)) if (v === true && DAY_KEY.test(k) && k >= cutoff && k <= latest) out[k] = true;
  return out;
}
export function mergeIdleDays(a, b, now = Date.now()) {
  return { ...cleanIdleDays(a, now), ...cleanIdleDays(b, now) };
}
export function sameIdleDays(a, b, now = Date.now()) {
  const x = Object.keys(cleanIdleDays(a, now)), y = cleanIdleDays(b, now);
  return x.length === Object.keys(y).length && x.every(k => y[k]);
}
// The merge and the comparison for each merged setting.
export const MERGERS = { restDays: [mergeDayFlags, sameDayFlags], idleDays: [mergeIdleDays, sameIdleDays] };

// ---------- pictures and sounds (files in Supabase Storage) ----------
export const isSoundRow = m => String(m?.type || '').startsWith('audio/');
// Problems with the whole storage setup (not one file): sending more files would only fail the same way.
const WHOLE_STORAGE_ERRORS = ['bucket_missing', 'media_policy', 'network'];
export const isWholeStorageError = err => WHOLE_STORAGE_ERRORS.includes(err?.code) || err?.status === 401;

// Send files one at a time, pictures first and then sounds. A file that fails on its own never stops the others.
//   upload(m)    sends one file; throws SupaError (code 'media_type' = the server doesn't accept this kind of file yet)
//   onSent(m)    called after each file that went
// A type rejection stops only that kind (the rest of the sounds, say), so pictures always get their turn first and are never
// held up by sounds. A problem with the whole storage setup (not set up yet, offline, signed out) is thrown.
// Returns { sent: [ids], blocked: [ids] (type rejected), failed: [{ id, message }] }.
export async function uploadMediaFiles(rows, upload, { onSent, onProgress } = {}) {
  const sent = [], blocked = [], failed = [];
  const rejected = new Set();
  const ordered = [...rows.filter(m => !isSoundRow(m)), ...rows.filter(isSoundRow)];
  for (const [i, m] of ordered.entries()) {
    const kind = isSoundRow(m) ? 'sound' : 'picture';
    if (rejected.has(kind)) { blocked.push(m.id); continue; }
    onProgress?.(i, ordered.length, kind);
    try {
      await upload(m);
      sent.push(m.id);
      await onSent?.(m);
    } catch (err) {
      if (err?.code === 'media_type') { rejected.add(kind); blocked.push(m.id); continue; }
      if (isWholeStorageError(err)) throw err;
      failed.push({ id: m.id, message: err?.message || String(err) });
    }
  }
  return { sent, blocked, failed };
}

// Run work(item) for every item, a few at a time. A file that fails on its own is counted and skipped; a problem with the
// whole storage setup stops the rest and is thrown. Returns { done, failed } counts.
export async function runPool(items, work, { size = 4, onProgress } = {}) {
  let next = 0, done = 0, failed = 0, fatal = null;
  const worker = async () => {
    while (!fatal && next < items.length) {
      const item = items[next++];
      try { await work(item); done++; } catch (err) {
        if (isWholeStorageError(err)) { fatal = err; return; }
        failed++;
      }
      onProgress?.(done + failed, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (fatal) throw fatal;
  return { done, failed };
}

// The note under Settings → Sync when the server turns sounds away (the owner hasn't re-run supabase/media.sql yet).
export const SOUNDS_BLOCKED_NOTE = 'Sounds can’t sync yet: run the new supabase/media.sql in your Supabase project (see docs/sync-setup.md). Pictures and everything else are syncing.';
export const PICTURES_BLOCKED_NOTE = 'Some pictures can’t sync yet: the sync server doesn’t take that kind of picture (check supabase/media.sql was run, see docs/sync-setup.md). Everything else is syncing.';

// ---------- the overlap when pulling ----------
// The server numbers a change (seq) when the row is written, not when it is saved for good. With several devices
// sending at once, a change numbered 100 can become visible after one numbered 101 did. A device that pulled in
// between has 101 as its bookmark and would never see 100. So every pull starts a little behind the bookmark and
// reads that stretch again; rows already applied are skipped by decide() (same time = skip), so it costs a few
// rows of download and nothing else.
// "A little behind" is measured in time, not in numbers: the numbers are shared by every account on the server, so a
// count of them means nothing. After EVERY request (each page) we log { t: when it was sent, seq: the bookmark after
// it, from: what it asked "after", n: rows it got } next to the bookmark, in one save. The next pull starts at the
// bookmark that was current OVERLAP_MS before the previous pull's last request. A change that request could not see
// was numbered less than a few seconds before it, so it is numbered above that older bookmark, however much later
// this pull happens (the app may have been closed for days). A pull cut off midway has logged its pages, so the next
// one resumes near where it stopped, not from the start.
// Second limit, so a big download isn't read again: those unseen changes are among the last few hundred rows this
// account wrote, so the start is never more than MAX_BACK rows behind the bookmark (counted from the log's n).
// Not covered: a change that a page of a download longer than OVERLAP_MS could not see yet, numbered below that page's
// end, on a device with no log (first sync): by the end of such a download the anchor is later than it. The same for
// more than MAX_BACK rows written by other devices within the few seconds one save takes.
export const OVERLAP_MS = 2 * 60 * 1000;      // far longer than the few seconds one batch of changes needs to be saved
export const MAX_BACK = 3000;                 // rows (a batch is 500 rows; a few devices at once)
const MAX_LOG = 60;
const goodEntry = e => Number.isFinite(e?.t) && Number.isFinite(e?.seq);
const entries = log => (Array.isArray(log) ? log.filter(goodEntry) : []);

// The change number to ask "after" in the next pull. Never above the bookmark; no log means no overlap.
export function pullStart(st) {
  const bookmark = Number(st?.lastSeq) || 0;
  const log = entries(st?.seqLog);
  if (!log.length) return bookmark;
  const limit = log[log.length - 1].t - OVERLAP_MS;
  const anchor = [...log].reverse().find(e => e.t <= limit) || log[0];      // not enough history yet: the oldest entry we have
  let start = anchor.seq, rows = 0;
  for (let i = log.length - 1; i >= 0; i--) {                                // the second limit: MAX_BACK rows
    rows += Number(log[i].n) || 0;
    if (rows >= MAX_BACK && Number.isFinite(log[i].from)) { start = Math.max(start, log[i].from); break; }
  }
  return Math.max(0, Math.min(bookmark, start));
}

// The state to start a pull from. The log always ends at the bookmark (every page saves both together), so a log
// that is missing (first sync, a reset, an update from an older version) or doesn't end there (the bookmark was moved
// by an older version after a downgrade) is replaced by a fresh one: no overlap this time.
export function startPull(st, now) {
  const log = entries(st.seqLog);
  const bookmark = Number(st.lastSeq) || 0;
  if (log.length && log[log.length - 1].seq === bookmark) return st;
  return { ...st, seqLog: [{ t: now, seq: bookmark, from: bookmark, n: 0 }] };
}

// Add a request ({ t, seq, from, n }) to the log, and forget entries older than the one pullStart() will use.
export function logPull(log, entry) {
  let list = entries(log);
  const { t } = entry;
  if (list.length && t < list[list.length - 1].t) {
    // The clock went backwards. Start the log over in the new time, keeping the bookmark the old one pointed to.
    const seq = pullStart({ lastSeq: Infinity, seqLog: list });
    list = [{ t: t - OVERLAP_MS, seq, from: seq, n: 0 }];
  }
  list.push(entry);
  const limit = t - OVERLAP_MS;
  let keep = 0;
  list.forEach((e, i) => { if (e.t <= limit) keep = i; });
  const out = list.slice(keep);
  if (out.length > MAX_LOG) out.splice(1, out.length - MAX_LOG);   // a burst of requests: thin out the middle, keep the oldest and the newest
  return out;
}
