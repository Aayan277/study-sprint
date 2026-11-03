// RWKV lab: is the saved memory still in step with the review log? Pure.
//   state  the lab's saved state: { modelSha, stateFormat, featureVersion, rebuilding, totalLogRows, hash, lastTs, lastLogId } or null
//            totalLogRows and hash are what the lab has been told about: it counts up by the rows it receives, never from the log itself
//   now    { sha, stateFormat, featureVersion, count, newRows }
//            count    how many rows the review log holds now
//            hash     the rows' (id, timestamp) pairs hashed and added up (rowHash), so a row swapped for another, even one with the same id
//                     (ids repeat across devices after a backup restore), is noticed
//            newRows  the log rows from the bookmark's time on (the one already handled may be among them), in any order
// -> { status, reason?, rows? }
//   status 'none'          nothing was ever built
//   status 'fresh'         nothing happened since
//   status 'catching-up'   only new answers were added; `rows` are the ones to feed in
//   status 'stale'         something else changed (rows deleted or added in the past, another model): rebuild. reason says why.
// A number for one log row, made from its id and its time. The lab adds these up (mod 2^32) over every row it has been told about; the same
// sum over the real log must match. Adding and taking away are exact, so undo and catch-up keep it in step.
export function rowHash(id, timestamp) {
  let h = 2166136261;
  for (const v of [id, Math.floor(timestamp / 4294967296), timestamp >>> 0]) {
    h = Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  }
  return h >>> 0;
}

export function freshness(state, now) {
  if (!state || state.rows === undefined) return { status: 'none' };
  if (state.rebuilding) return { status: 'stale', reason: 'interrupted' };
  if (state.modelSha !== now.sha) return { status: 'stale', reason: 'model' };
  if (state.stateFormat !== now.stateFormat || state.featureVersion !== now.featureVersion) return { status: 'stale', reason: 'format' };
  if (state.hash === undefined || now.hash === undefined) return { status: 'stale', reason: 'format' };
  const later = r => r.timestamp > state.lastTs || (r.timestamp === state.lastTs && r.id > state.lastLogId);
  const fresh = (now.newRows || []).filter(later);
  const grew = now.count - state.totalLogRows;
  const added = fresh.reduce((a, r) => (a + rowHash(r.id, r.timestamp)) >>> 0, 0);
  if (((now.hash - state.hash) >>> 0) !== added) return { status: 'stale', reason: 'changed' };      // something was deleted, replaced or imported
  if (grew === 0 && fresh.length === 0) return { status: 'fresh' };
  if (grew === fresh.length && grew > 0) return { status: 'catching-up', rows: fresh.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id) };
  return { status: 'stale', reason: 'changed' };
}
