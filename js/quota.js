// Limits on what one account can hold, and the plain-words messages about them. Pure logic, no network:
// sync-quota.js fetches the numbers (supabase/limits.sql my_usage()), this decides what to do and say.
//
//   - Pictures and sounds: each account has a space limit (180 MB unless the owner raised it). At the limit,
//     new pictures and sounds wait on the device and everything else keeps syncing.
//   - One picture: refused if it is still over 1.5 MB after being shrunk (3 MB for image occlusion).
//   - Imports: warn on a deck whose media is over 200 MB, or an Anki history of more than 50,000 reviews.

export const MB = 1024 * 1024;
export const DEFAULT_MEDIA_LIMIT = 180 * MB;        // keep in step with supabase/limits.sql
export const WARN_AT = 0.8;                         // the bar turns amber from here
export const MAX_PICTURE = 1.5 * MB;
export const MAX_OCCLUSION_PICTURE = 3 * MB;        // also the bucket's file size limit
export const IMPORT_MEDIA_WARN = 200 * MB;
export const IMPORT_REVIEWS_WARN = 50000;
export const REVIEW_BYTES = 530;                    // about what one review takes on the server (docs/design/scale-and-backend.md)

// "12 MB", "0.4 MB", "2 GB": whole numbers from 10 up, one decimal below that.
export function fmtSize(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * MB) { const g = n / (1024 * MB); return `${g >= 10 ? Math.round(g) : Math.round(g * 10) / 10} GB`; }
  const mb = n / MB;
  if (mb === 0) return '0 MB';
  if (mb < 0.1) return '<0.1 MB';
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

// What my_usage() said, cleaned up: { data, media, limit } in bytes, or null when it isn't usable.
export function readUsage(raw) {
  const u = Array.isArray(raw) ? raw[0] : raw;
  if (!u || typeof u !== 'object') return null;
  const data = Number(u.data_bytes), media = Number(u.media_bytes), limit = Number(u.media_limit);
  if (![data, media, limit].every(Number.isFinite) || limit < 0) return null;
  const dataLimit = u.data_limit == null ? null : Number(u.data_limit);       // older servers don't say
  return { data, media, limit, dataLimit: Number.isFinite(dataLimit) ? dataLimit : null };
}

// 'ok', 'warn' (from 80%) or 'full' (at or over the limit).
export function level(usage) {
  if (!usage) return 'ok';
  if (usage.media >= usage.limit) return 'full';
  return usage.media >= usage.limit * WARN_AT ? 'warn' : 'ok';
}

// The same for the synced data (cards, reviews, settings): 'ok', 'warn' or 'full'.
export function dataLevel(usage) {
  if (!usage || usage.dataLimit == null) return 'ok';
  if (usage.data >= usage.dataLimit) return 'full';
  return usage.data >= usage.dataLimit * WARN_AT ? 'warn' : 'ok';
}

export const SERVER_FULL_MESSAGE = "The sync server is full right now. Everything is safe on this device and will sync when there's room.";
export const dataFullMessage = usage =>
  `Your account's synced data is full${usage?.dataLimit != null ? ` (${fmtSize(usage.data)} of ${fmtSize(usage.dataLimit)})` : ''}. New changes are saved on this device and will sync when there's room. Delete some cards or old decks, or ask the account owner for more space.`;

export const fullMessage = usage =>
  `Your account is full: pictures and sounds use ${fmtSize(usage.media)} of ${fmtSize(usage.limit)}. New ones are saved on this device and will sync when there's room. Remove some, or ask the account owner for more space.`;
export const warnMessage = usage => `Pictures and sounds: ${fmtSize(usage.media)} of ${fmtSize(usage.limit)}.`;

// The line under Settings → Your data: { text, level }.
export function usageLine(usage) {
  if (!usage) return null;
  const mediaLv = level(usage), dataLv = dataLevel(usage);
  const lv = mediaLv === 'full' || dataLv === 'full' ? 'full' : mediaLv === 'warn' || dataLv === 'warn' ? 'warn' : 'ok';
  const details = [];
  if (dataLv === 'full') details.push(dataFullMessage(usage));
  else if (dataLv === 'warn') details.push(`Synced data: ${fmtSize(usage.data)} of ${fmtSize(usage.dataLimit)}.`);
  if (mediaLv === 'full') details.push(fullMessage(usage));
  else if (mediaLv === 'warn') details.push(warnMessage(usage));
  return {
    level: lv,
    text: `In your account: data ${fmtSize(usage.data)}${usage.dataLimit != null ? ` of ${fmtSize(usage.dataLimit)}` : ''} · pictures and sounds ${fmtSize(usage.media)} of ${fmtSize(usage.limit)}`,
    detail: lv === 'warn' && mediaLv === 'warn' && dataLv === 'ok' ? `Getting full. ${details.join(' ')}` : details.join(' ')
  };
}

// Which waiting pictures and sounds to send now, and which to keep on the device. Like the server, a file is
// sent only if it fits: what the account uses plus the file is at most the limit. A smaller one later in the list may still fit.
// pending: [{ data: ArrayBuffer, size? }, …]. usage null (unknown) sends everything: the server still decides.
export function planUploads(pending, usage) {
  if (!usage) return { send: [...pending], held: [], usage: null };
  const send = [], held = [];
  let used = usage.media;
  for (const m of pending) {
    const size = m.data?.byteLength ?? m.size ?? 0;
    if (used >= usage.limit || used + size > usage.limit) { held.push(m); continue; }
    send.push(m);
    used += size;
  }
  return { send, held, usage: { ...usage, media: used } };
}

// ---------- one picture ----------
export const pictureLimit = occlusion => (occlusion ? MAX_OCCLUSION_PICTURE : MAX_PICTURE);
// null if the (shrunk) picture is fine, else the message to show.
export function pictureTooBig(bytes, { occlusion = false } = {}) {
  const max = pictureLimit(occlusion);
  if (bytes <= max) return null;
  return `That picture is still ${fmtSize(bytes)} after shrinking it, and the limit is ${fmtSize(max)}. Try a smaller picture, or crop it first.`;
}

// ---------- imports ----------
// Warnings to show before an import, as plain sentences. mediaBytes: size of the deck's pictures and sounds
// (0 if unknown); reviews: how many Anki reviews would come along.
export function importWarnings({ mediaBytes = 0, reviews = 0 } = {}) {
  const out = [];
  if (mediaBytes > IMPORT_MEDIA_WARN) {
    out.push(`This deck's pictures and sounds take about ${fmtSize(mediaBytes)}. That's a lot for a phone and for your account (${fmtSize(DEFAULT_MEDIA_LIMIT)} for pictures and sounds unless your account owner gave you more). Pictures are shrunk as they come in.`);
  }
  if (reviews > IMPORT_REVIEWS_WARN) {
    out.push(`This deck has ${reviews.toLocaleString()} reviews of history. Keeping all of them uses about ${fmtSize(reviews * REVIEW_BYTES)} in your account and makes the first sync on a new device slower. If you don't need the history, turn off “Bring over my Anki progress”.`);
  }
  return out;
}

// ---------- records too big for the server, and what to do when a push is refused ----------
export const MAX_ROW_BYTES = 60000;                 // the server's own limit is 64 KB (supabase/limits.sql); this leaves room for how it counts
export const DAY_MS = 86400000;

// How big a row is on the server, about: its data as the database writes it as text. Postgres puts a space after every
// ":" and "," (so [1,2,3] is 9 bytes there, not 7), and the server's 64 KB check counts that text, so we count it too.
const enc = new TextEncoder();
function jsonbTextBytes(v) {
  if (v === null || v === undefined) return 4;
  if (Array.isArray(v)) return 2 + v.reduce((n, x) => n + jsonbTextBytes(x === undefined ? null : x), 0) + Math.max(0, v.length - 1) * 2;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    return 2 + keys.reduce((n, k) => n + enc.encode(JSON.stringify(k)).length + 2 + jsonbTextBytes(v[k]), 0) + Math.max(0, keys.length - 1) * 2;
  }
  return enc.encode(JSON.stringify(v) ?? 'null').length;
}
export const rowBytes = row => jsonbTextBytes(row?.data ?? null);

// A short name for a row, to point at it: a card's front, a deck's name.
export function rowLabel(row) {
  const raw = row?.data?.front ?? row?.data?.name ?? '';
  const text = String(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 40 ? text.slice(0, 40).trimEnd() + '…' : text;
}

// Rows that fit, and rows that are too big to send (each as { store, id, label, bytes }).
export function splitOversized(rows, max = MAX_ROW_BYTES) {
  const ok = [], big = [];
  for (const r of rows) {
    const bytes = r.deleted ? 0 : rowBytes(r);
    if (bytes > max) big.push({ store: r.store, id: r.id, label: rowLabel(r), bytes }); else ok.push(r);
  }
  return { ok, big };
}

// "1 card is too large to sync: “Cell…”. Shorten it to sync."
export function bigRowsNote(list) {
  if (!list?.length) return '';
  const kinds = new Set(list.map(r => r.store));
  const one = kinds.size === 1 && kinds.has('cards') ? 'card' : kinds.size === 1 && kinds.has('decks') ? 'deck' : 'item';
  const label = list[0].label ? `“${list[0].label}”` : `a ${one}`;
  return list.length === 1
    ? `1 ${one} is too large to sync: ${label}. Shorten it to sync.`
    : `${list.length} ${one}s are too large to sync, for example ${label}. Shorten them to sync.`;
}

// Why a push failed, if it's one we can work around: 'size' (a record over the server's size limit), 'data' (the
// account's synced-data limit), 'server' (the whole project is full). null = any other error.
export function pushErrorKind(err) {
  const text = `${err?.code || ''} ${err?.message || ''}`;
  if (/sync_data_full/.test(text)) return 'data';
  if (/sync_server_full/.test(text)) return 'server';
  if (/\b23514\b|sync_items_data_size/.test(text)) return 'size';
  return null;
}

// Rows with a time from a clock that is ahead are sent as at most a day ahead, like the server will keep them.
export const capTimes = (rows, now = Date.now()) => rows.map(r => (r.updated_at > now + DAY_MS ? { ...r, updated_at: now + DAY_MS } : r));
