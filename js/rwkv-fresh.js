// RWKV lab: is the saved memory still in step with the review log? Pure.
//   state  the lab's saved state: { modelSha, stateFormat, featureVersion, rebuilding, totalLogRows, idSum, lastTs, lastLogId } or null
//            totalLogRows and idSum are what the lab has been told about: it counts up by the rows it receives, never from the log itself
//   now    { sha, stateFormat, featureVersion, count, newRows }
//            count    how many rows the review log holds now
//            idSum    the ids of all those rows added up (so a row swapped for another, with the same count, is noticed)
//            newRows  the log rows from the bookmark's time on (the one already handled may be among them), in any order
// -> { status, reason?, rows? }
//   status 'none'          nothing was ever built
//   status 'fresh'         nothing happened since
//   status 'catching-up'   only new answers were added; `rows` are the ones to feed in
//   status 'stale'         something else changed (rows deleted or added in the past, another model): rebuild. reason says why.
export function freshness(state, now) {
  if (!state || state.rows === undefined) return { status: 'none' };
  if (state.rebuilding) return { status: 'stale', reason: 'interrupted' };
  if (state.modelSha !== now.sha) return { status: 'stale', reason: 'model' };
  if (state.stateFormat !== now.stateFormat || state.featureVersion !== now.featureVersion) return { status: 'stale', reason: 'format' };
  if (state.idSum === undefined || now.idSum === undefined) return { status: 'stale', reason: 'format' };
  const later = r => r.timestamp > state.lastTs || (r.timestamp === state.lastTs && r.id > state.lastLogId);
  const fresh = (now.newRows || []).filter(later);
  const grew = now.count - state.totalLogRows;
  const added = fresh.reduce((a, r) => a + r.id, 0);
  if (now.idSum - state.idSum !== added) return { status: 'stale', reason: 'changed' };      // something was deleted, replaced or imported
  if (grew === 0 && fresh.length === 0) return { status: 'fresh' };
  if (grew === fresh.length && grew > 0) return { status: 'catching-up', rows: fresh.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id) };
  return { status: 'stale', reason: 'changed' };
}
