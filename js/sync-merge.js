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
// The record's key (id, cardId or uid) always comes from the row's own id, never from inside the data: a row whose data
// names another record's id can't overwrite that record.
// (Only a key that doesn't match is replaced: a number id, which backups allow, keeps its type, so it stays the same record.)
export function recordFromRow(row) {
  const key = SYNC_ID[row.store];
  const fix = key && String(row.data?.[key]) !== row.id ? { [key]: row.id } : {};
  return { ...row.data, ...fix, updatedAt: row.updated_at, syncedAt: row.updated_at };
}

// Is this row from the server unusable? Returns a short reason (for the local log) or null when it is fine. One bad row must
// never stop a whole page from being saved, so db.applyRemote skips what this names, counts it, and carries on.
//   - a row with no id, or no store, is not a record
//   - unless it is a delete, `data` must be an object (not null, a string, a number or a list)
//   - a card, deck, schedule or review needs its own key inside the data (id, cardId, uid)
// Stores this app doesn't know are ignored elsewhere, not damaged.
export function badRow(row) {
  if (!row || typeof row !== 'object') return 'not a row';
  if (typeof row.store !== 'string' || !row.store) return 'no store';
  if (typeof row.id !== 'string' || !row.id) return 'no id';
  if (row.deleted) return null;
  if (row.store !== 'settings' && !(row.store in SYNC_ID)) return null;
  if (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)) return 'data is not an object';
  const key = SYNC_ID[row.store];
  if (key) {
    const v = row.data[key];
    if (!((typeof v === 'string' && v) || (typeof v === 'number' && Number.isFinite(v)))) return `data has no ${key}`;
  }
  return null;
}

// The small local log of skipped rows (the local-only setting "syncDamaged"): { count, seen, items: [the last 20] }.
// `seen` is how many the person has already been told about (Settings → Sync shows the difference once, and Dismiss sets it).
export const DAMAGED_KEEP = 20;
const DAMAGED_REMEMBER = 200;
// A pull starts a little behind the bookmark (pullStart), so a skipped row is read again by the next few syncs: it is counted once,
// by remembering the store, id and change number of the last 200 (`keys`).
export function addDamaged(prev, bad, now = Date.now()) {
  const old = prev && typeof prev === 'object' ? prev : {};
  const keys = Array.isArray(old.keys) ? old.keys : [];
  const known = new Set(keys);
  const fresh = bad.filter(b => { const k = `${b.store}|${b.id}|${b.seq || 0}`; if (known.has(k)) return false; known.add(k); return true; });
  return {
    count: (Number(old.count) || 0) + fresh.length,
    seen: Number(old.seen) || 0,
    items: [...(Array.isArray(old.items) ? old.items : []), ...fresh.map(b => ({ ...b, at: now }))].slice(-DAMAGED_KEEP),
    keys: [...known].slice(-DAMAGED_REMEMBER)
  };
}
export function damagedNote(log) {
  const n = (Number(log?.count) || 0) - (Number(log?.seen) || 0);
  return n > 0 ? `${n.toLocaleString()} synced ${n === 1 ? 'record was' : 'records were'} damaged and skipped. Everything else synced normally.` : null;
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
export function capDayFlags(out) {
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
// What to send for a merged setting: days off are trimmed to the entry limit (capDayFlags) even when the stored value is already over it,
// as when a single-device account got there before the limit existed; nothing else is touched.
export function trimForPush(key, value) {
  return key === 'restDays' && value && typeof value === 'object' && !Array.isArray(value) ? mergeDayFlags(value, null) : value;     // (cleaned first: a junk entry must not break the trim)
}
// The stored days off, trimmed, if there are more than the limit; else null (nothing to do). A value that big was set aside as too large
// and its change is already marked as sent, so sync.js saves the trimmed copy: that makes it a new change, which is sent.
export function overLimitDayFlags(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > MAX_FLAG_ENTRIES ? mergeDayFlags(value, null) : null;
}
// The merge and the comparison for each merged setting.
export const MERGERS = { restDays: [mergeDayFlags, sameDayFlags], idleDays: [mergeIdleDays, sameIdleDays] };

// One page of changes from the server. A page that times out (rows can be 60 KB each: a 1,000-row page may be 20 MB, too much for a slow
// connection) is asked for again half as big, down to `min`; after that the timeout is thrown. Returns { rows, size, at }: the size that worked and when that request was sent (sync.js logs it),
// which the caller keeps using for the rest of the sync.
export async function getPageSafely(get, afterSeq, size, min = 50) {
  for (;;) {
    const at = Date.now();
    try { return { rows: await get(afterSeq, size), size, at }; } catch (err) {
      if (err?.code !== 'timeout' || size <= min) throw err;
      size = Math.max(min, size >> 1);
    }
  }
}

// ---------- taking turns between tabs ----------
// Runs fn() while holding the sync lock, so two tabs can't mix up the bookmarks. A tab frozen while it holds the lock (a backgrounded
// iPhone app, mid-request) would block the others for good, so nobody waits for ever:
//   skipIfBusy  a routine sync does nothing when another tab is syncing: fn is not run and SKIPPED comes back (the caller tries again later)
//   otherwise   wait up to waitMs for the lock, then give up with an error whose code is 'lock-timeout' (and not an AbortError: a
//               database transaction that is cut short, such as a full disk, also ends in one). onWait() is called if the wait lasts over a second.
// Where the browser has no Web Locks, fn just runs.
export const LOCK_NAME = 'study-sprint-sync';
export const LOCK_WAIT = 60000;
export const SKIPPED = Symbol('skipped');
export function withSyncLock(fn, { skipIfBusy = false, waitMs = LOCK_WAIT, onWait, locks = globalThis.navigator?.locks } = {}) {
  if (!locks) return fn();
  if (skipIfBusy) return locks.request(LOCK_NAME, { ifAvailable: true }, lock => (lock ? fn() : SKIPPED));
  const ctl = new AbortController();
  let granted = false;
  const timer = setTimeout(() => ctl.abort(), waitMs), hint = onWait && setTimeout(onWait, 1000);
  return locks.request(LOCK_NAME, { signal: ctl.signal }, () => { granted = true; clearTimeout(timer); clearTimeout(hint); return fn(); })
    .catch(err => {
      if (!granted && ctl.signal.aborted) throw Object.assign(new Error('Another window is still syncing. Try again in a moment.'), { code: 'lock-timeout' });
      throw err;
    })
    .finally(() => { clearTimeout(timer); clearTimeout(hint); });
}

// ---------- pictures and sounds (files in Supabase Storage) ----------
export const isSoundRow = m => String(m?.type || '').startsWith('audio/');
// Problems with the whole storage setup (not one file): sending more files would only fail the same way.
const WHOLE_STORAGE_ERRORS = ['bucket_missing', 'media_policy', 'media_server_full', 'network', 'timeout'];
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
  let serverErrors = 0;          // answers in a row from a server having trouble (5xx): after two, stop, whatever file is next
  const ordered = [...rows.filter(m => !isSoundRow(m)), ...rows.filter(isSoundRow)];
  for (const [i, m] of ordered.entries()) {
    const kind = isSoundRow(m) ? 'sound' : 'picture';
    if (rejected.has(kind)) { blocked.push(m.id); continue; }
    onProgress?.(i, ordered.length, kind);
    try {
      await upload(m);
      sent.push(m.id);
      serverErrors = 0;
      await onSent?.(m);
    } catch (err) {
      if (err?.code === 'media_type') { rejected.add(kind); blocked.push(m.id); continue; }
      if (isWholeStorageError(err)) throw err;
      if (err?.status >= 500 && ++serverErrors >= 2) throw err;
      if (!(err?.status >= 500)) serverErrors = 0;
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
// Second limit, so a big download isn't read again: the start is not more than MAX_BACK rows behind the bookmark
// (counted from the log's n), except that it never skips the requests of the last SAFE_MS (a save can take several
// seconds, so a change that a request missed was numbered just before it; it is only lost if the pull then goes on
// to download MAX_BACK more rows, and that must have outrun the save by SAFE_MS). So for up to OVERLAP_MS after a big
// pull, every quick sync reads again max(MAX_BACK, the rows of the last SAFE_MS) rows. A request stops being protected
// once it has been read again at least SAFE_MS later (see logPull), so a pull that keeps being cut off moves forward.
// Not covered: a change that a page of a download longer than OVERLAP_MS could not see yet, numbered below that page's
// end, on a device with no log (first sync): by the end of such a download the anchor is later than it. The same for
// a change still unsaved after SAFE_MS while this device downloads more than MAX_BACK rows after the page that missed it.
// (The "mdel:" picture marks are synced settings like the others, so they are read again the same way.)
export const OVERLAP_MS = 2 * 60 * 1000;      // far longer than the few seconds one batch of changes needs to be saved
export const MAX_BACK = 3000;                 // rows (a batch is 500 rows; a few devices at once)
export const SAFE_MS = 30 * 1000;             // requests this recent are always read again (several times the server's statement timeout)
const MAX_LOG = 20;                          // entries kept from the older part of the log
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
  for (let i = log.length - 1; i >= 0; i--) {                                // the second limit: MAX_BACK rows...
    rows += Number(log[i].n) || 0;
    if (rows >= MAX_BACK && Number.isFinite(log[i].from)) {
      const recent = log.find(e => !e.ok && e.t >= log[log.length - 1].t - SAFE_MS && Number.isFinite(e.from));   // ...but not past the last SAFE_MS
      start = Math.max(start, Math.min(log[i].from, recent ? recent.from : Infinity));
      break;
    }
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

// Add a request ({ t, seq, from, to, n }) to the log, and forget entries older than the one pullStart() will use.
// Entries are "ok" (no longer protected by the SAFE_MS rule) when nothing they could have missed is left:
//   * cover = { t0, from, reach }: this pull started at t0, asked after `from`, and has now read everything up to `reach`
//     (Infinity once a page came back short). A request that missed a change was sent less than SAFE_MS before the change
//     was saved, so an entry sent at least SAFE_MS before t0 is settled once this pull has read its whole stretch.
//   * A request whose stretch ends at or below a bookmark that was already SAFE_MS old when it was sent could not have missed
//     anything (those changes were all saved): it is ok straight away. So a re-read of settled rows never needs a re-read.
// That is what lets a pull that is cut off every few seconds still move forward: each attempt settles the one before.
export function logPull(log, entry, cover) {
  let list = entries(log).map(e => ({ ...e }));
  const { t } = entry;
  if (list.length && t < list[list.length - 1].t) {
    // The clock went backwards. Start the log over in the new time, keeping the bookmark the old one pointed to.
    const seq = pullStart({ lastSeq: Infinity, seqLog: list });
    list = [{ t: t - OVERLAP_MS, seq, from: seq, n: 0 }];
  }
  const settled = Math.max(-1, ...list.filter(e => e.t <= t - SAFE_MS).map(e => e.seq));
  if (cover && cover.t0 <= t) for (const e of list) if (!e.ok && cover.t0 >= e.t + SAFE_MS && cover.from <= e.from && cover.reach >= (Number.isFinite(e.to) ? e.to : e.seq)) e.ok = true;
  list.push({ ...entry, ok: (Number.isFinite(entry.to) ? entry.to : entry.seq) <= settled });
  const limit = t - OVERLAP_MS;
  let keep = 0;
  list.forEach((e, i) => { if (e.t <= limit) keep = i; });
  const out = list.slice(keep);
  // A burst of requests: thin out the old part (keep its oldest entry), but never the last SAFE_MS (still protected) nor the
  // newest entry at least SAFE_MS old (where "settled" comes from), however fast the pages come.
  const recentFrom = Math.max(0, out.reduce((k, e, i) => (e.t <= t - SAFE_MS ? i : k), 0));
  if (recentFrom > MAX_LOG) {
    const head = out.slice(0, recentFrom), step = head.length / MAX_LOG;
    return [...Array.from({ length: MAX_LOG }, (_, i) => head[Math.floor(i * step)]), ...out.slice(recentFrom)];
  }
  return out;
}

// ---------- pulling the pages ----------
// The pull loop of sync.js: page after page until a short one. `st` is the state from startPull(), `from` the number to ask
// after first (pullStart), `size` the page size to start with.
//   get(after, size)  one page: { rows, size, at } (getPageSafely: the size that worked, and when that request was sent)
//   apply(rows)       saves a page here (db.applyRemote, plus sync.js's counting)
//   save(st)          keeps the bookmark and the log (together, once per page, after the page is saved)
// The next request is sent as soon as a full page has ARRIVED, while it is being saved (saving 1,000 rows takes about as long as
// asking for them, so a first download of 200,000 rows takes about the longer of the two instead of both). That changes nothing the
// invariants above rest on:
//   * the request asks after the highest number on the page before it (known on arrival, before saving), as it did one by one;
//   * `at` is still when that request was sent (it is later than the page before it was sent, so the log stays in order);
//   * a page is logged, and the bookmark moves, only after it is saved, and in order; a page that arrived but whose
//     saving failed is never logged (its successor's answer is dropped, so the next pull asks after the old bookmark);
//   * the page size used for a request is the one the page before it ended with (after any halving), and the short-page
//     check uses the size of the request that page really came from.
// Returns { st, pages }.
export async function pullPages(st, from, size, { get, apply, save, now = Date.now }) {
  const t0 = now(), from0 = from;
  const fetchPage = after => get(after, size);
  let upcoming = fetchPage(from), pages = 0;
  for (;;) {
    const after = from;
    const page = await upcoming;
    const rows = page.rows, at = page.at;
    size = page.size;
    const top = rows.length ? Math.max(...rows.map(r => Number(r.seq))) : after;     // (the highest number on this page)
    const more = rows.length >= size;
    if (more) { upcoming = fetchPage(Math.max(after, top)); upcoming.catch(() => {}); }     // (if saving below fails, this answer is not used)
    if (rows.length) { await apply(rows); from = Math.max(from, top); }
    pages++;
    const lastSeq = Math.max(st.lastSeq, from);
    st = { ...st, lastSeq, seqLog: logPull(st.seqLog, { t: at, seq: lastSeq, from: after, to: top, n: rows.length }, { t0, from: from0, reach: more ? from : Infinity }) };
    await save(st);
    if (!more) return { st, pages };
  }
}
