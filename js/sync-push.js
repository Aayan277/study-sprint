// Sending rows to the server so that one bad row can't hold up the rest.
//
// The server takes a batch in one go: if one row in it is refused, the whole batch is. Rows can be refused because
// the record is over the server's size limit ('size'), its id is too long ('id'), the account's synced-data space is full ('data'), or the
// whole project is full ('server') (supabase/limits.sql). pushSafely() sends batches, and when one is refused for
// one of those reasons it splits it in halves, and again, until the rows that were refused are alone. The rest go.
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
  const attempt = async part => {
    try {
      await put(part);
      out.sent.push(...part);
      return;
    } catch (err) {
      // A slow connection: the batch didn't get through in time. Send it in halves (rows already there are ignored by the server).
      if (err?.code === 'timeout' && part.length > MIN_PART && spare > 0) {
        spare--;
        const mid = part.length >> 1;
        await attempt(part.slice(0, mid));
        await attempt(part.slice(mid));
        return;
      }
      const kind = pushErrorKind(err);
      if (!kind) throw err;
      const rowProblem = kind === 'size' || kind === 'id';
      if (!rowProblem) out.full = out.full === 'server' ? 'server' : kind;
      if (part.length === 1) {
        if (rowProblem) out.bad.push({ row: part[0], kind, message: err.message });
        else out.held.push(part[0]);
        return;
      }
      if (spare <= 0) { out.held.push(...part); return; }          // out of requests for this sync: try again next time
      spare--;
      const mid = part.length >> 1;
      await attempt(part.slice(0, mid));
      await attempt(part.slice(mid));
    }
  };
  for (let i = 0; i < rows.length; i += batch) {
    onProgress?.(i, rows.length);
    await attempt(rows.slice(i, i + batch));
  }
  return out;
}
