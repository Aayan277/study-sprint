// Sending rows to the server so that one bad row can't hold up the rest.
//
// The server takes a batch in one go: if one row in it is refused, the whole batch is. Two kinds of refusal are about ONE row:
// the record is over the server's size limit ('size'), or its id is too long ('id') (supabase/limits.sql). For those, pushSafely()
// splits the batch in halves, and again, until the rows that were refused are alone. The rest go.
// The other two are about the whole account or server: the account's synced-data space is full ('data'), or the whole project is
// full or read-only ('server'). Splitting can't help there (every half is refused too, which used to cost hundreds of requests a
// sync), so the first such refusal stops the sending: the rest is held for a later sync. Deletes are sent first, because they free space.
//
//   put(rows)   sends one batch (supa.putRows); throws on a refusal
// Returns { sent: [rows that went], held: [rows to try again next time], bad: [{ row, kind: 'size' | 'id', message }] (over the size or id limit),
//           full: 'data' | 'server' | null (why rows were held) }.
// Other errors (offline, signed out, a server problem) are thrown, as before.

import { pushErrorKind } from './quota.js';

const BATCH = 500;           // rows per request
const MIN_PART = 50;         // a batch that keeps timing out is split down to this many rows
const BUDGET = 150;          // extra requests allowed per sync for splitting; what's left over waits for the next sync

export async function pushSafely(put, rows, { batch = BATCH, budget = BUDGET, onProgress } = {}) {
  const out = { sent: [], held: [], bad: [], full: null };
  let spare = budget;
  let halted = false;       // the account or server is full: nothing more is sent this sync
  // The batch size for the rest of this sync: halved when a request times out (a slow connection), so the next batches don't each
  // wait out the full timeout first, like the pull's page size (getPageSafely); it doesn't grow back, so a link that always times out at 500 doesn't pay the timeout again.
  let size = batch;
  const attempt = async part => {
    if (halted) { out.held.push(...part); return; }
    try {
      await put(part);
      out.sent.push(...part);
      return;
    } catch (err) {
      // A slow connection: the batch didn't get through in time. Send it in halves (rows already there are ignored by the server).
      if (err?.code === 'timeout' && part.length > MIN_PART && spare > 0) {
        spare--;
        const mid = part.length >> 1;
        size = Math.max(MIN_PART, Math.min(size, mid));
        await attempt(part.slice(0, mid));
        await attempt(part.slice(mid));
        return;
      }
      const kind = pushErrorKind(err);
      if (!kind) throw err;
      if (kind === 'data' || kind === 'server') {          // everything is refused alike: stop, don't split
        out.full = out.full === 'server' ? 'server' : kind;
        halted = true;
        out.held.push(...part);
        return;
      }
      if (part.length === 1) { out.bad.push({ row: part[0], kind, message: err.message }); return; }
      if (spare <= 0) { out.held.push(...part); return; }          // out of requests for this sync: try again next time
      spare--;
      const mid = part.length >> 1;
      await attempt(part.slice(0, mid));
      await attempt(part.slice(mid));
    }
  };
  // Deletes first: they only shrink what the account holds, so they go through even when it is full (and may make room for the rest).
  const ordered = [...rows.filter(r => r.deleted), ...rows.filter(r => !r.deleted)];
  for (let i = 0; i < ordered.length;) {
    onProgress?.(i, ordered.length);
    const n = size;                  // (size may change while this batch is sent)
    // (A batch is all deletes or all puts, so a refusal of the puts never holds a delete back.)
    const end = Math.min(i + n, ordered.length);
    let cut = end;
    if (ordered[i].deleted) { while (cut > i && !ordered[cut - 1].deleted) cut--; }
    else { for (let j = i; j < end; j++) if (ordered[j].deleted) { cut = j; break; } }
    await attempt(ordered.slice(i, cut));
    i = cut;
  }
  return out;
}

// ---------- backing off while the account or server is full ----------
// After a refusal for space, automatic syncs stop pushing for a while (they still pull): 15 minutes, then 30, 60... up to 6 hours
// while it keeps being refused. Sync now (a person's tap) pushes anyway, once; a push that goes through clears it. It is kept in the
// local-only setting "pushBackoff", { userId, until, wait, kind, note }, so closing the app doesn't reset it.
export const BACKOFF_FIRST = 15 * 60 * 1000;
export const BACKOFF_MAX = 6 * 60 * 60 * 1000;
export function nextBackoff(prev, { userId, kind, note, now = Date.now() }) {
  const wait = prev?.userId === userId && prev.wait ? Math.min(BACKOFF_MAX, prev.wait * 2) : BACKOFF_FIRST;
  return { userId, until: now + wait, wait, kind, note: note || null };
}
// Deletes already on the server need not be sent again while puts are held (the bookmark can't move). `deletedThrough` is the time up
// to which that holds. It moves up only when NO delete was held: a deck's delete markers all share one time, so with some sent and
// some held, "newest sent" would also cover the held ones and they would never be sent. (Then it stays where it was.)
export function deletedThroughAfter(prev, sent, held) {
  if (held.some(r => r.deleted)) return prev || 0;
  return Math.max(prev || 0, ...sent.filter(r => r.deleted).map(r => r.updated_at));
}
// The saved backoff if it still applies to this account right now, else null.
export function activeBackoff(b, userId, now = Date.now()) {
  return b && typeof b === 'object' && b.userId === userId && Number(b.until) > now && now + BACKOFF_MAX >= Number(b.until) ? b : null;
}
