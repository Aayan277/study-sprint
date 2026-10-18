// Waiting 30 days before a picture or sound is deleted from the account (backlog 3). Pure logic, no database or network:
// sync.js does the saving and the deleting, tests/media-sweep.test.js checks the rules.
//
// The problem: when no card on THIS device uses a file any more, deleting it from the account at once breaks it for another
// device that still has a card using it (it has not synced yet, or the card was restored). So the file is only marked first.
//
// How it works:
//   - The mark is a synced setting per file, "mdel:<media id>" = the time it was marked (milliseconds), or null for "not marked".
//     It travels like a glossary term: the newest copy of each key wins, so every device ends up with the same mark.
//     (Marks are left out of backups: they belong to the account's files, not to your study data.)
//   - When this device drops a file nothing uses, it marks it with today's time (unless it is already marked: the first mark keeps its date).
//   - A device that still has a card using a marked file un-marks it (null, newer than the mark, so it wins everywhere).
//   - Any device sweeps a file that is marked for 30 days or more and that none of its own cards use: it deletes it from the
//     account, then sets the mark to 'gone'. The sweep runs right after the device has synced its cards, so it knows about
//     every card the account has. The 30 days count from the later of the mark's time and the time THIS device first saw
//     the mark ("mseen:<id>", kept on the device only), so one device with a wrong clock cannot cut the wait short.
//   - A device that was offline for over 30 days and still has a card using a swept file sees 'gone' when it syncs: it sends its
//     own copy again (reupload), then sets the mark to null.
//   - Every write of a mark is stamped later than the copy this device already knows (db.setSettings), because the server ignores
//     a row that is not newer: a device whose clock is behind could otherwise never un-mark.
//   - The protection only holds once every device runs a version with this; older versions delete at once.
//   - Older versions of the app ignore "mdel:" settings, so they simply never mark or sweep.

export const MARK_PREFIX = 'mdel:';
export const WAIT_DAYS = 30;
export const WAIT_MS = WAIT_DAYS * 86400000;

export const markKey = id => MARK_PREFIX + id;
export const isMarkKey = key => typeof key === 'string' && key.startsWith(MARK_PREFIX);
export const markId = key => key.slice(MARK_PREFIX.length);
export const SEEN_PREFIX = 'mseen:';       // this device only: when it first saw the mark (the clock here, not the marker's)
export const seenKey = id => SEEN_PREFIX + id;
export const isSeenKey = key => typeof key === 'string' && key.startsWith(SEEN_PREFIX);
export const GONE = 'gone';                // the file was deleted from the account
// A mark's value from outside (the server, a backup): a real time, null (not marked) or 'gone'; anything else is junk.
export const validMark = v => v === null || v === GONE || (typeof v === 'number' && Number.isFinite(v) && v > 0);

// What to do after a sync, given:
//   marks    { id: time } for the files that are marked now (unmarked ones are left out). The time is the later of the mark's time
//            and when this device first saw it (db.mediaMarks).
//   gone     ids whose mark says the account's copy was deleted
//   removed  ids this device just dropped because no card uses them (and the account has a copy)
//   used     Set of the ids that some card on this device uses
//   held     Set of the ids whose file this device has
//   now      the time in milliseconds
// Returns { mark: [ids to mark now], unmark: [ids], sweep: [ids to delete from the account now],
//           reupload: [ids a card here uses and this device has, but the account lost: send them again] }.
export function planSweep({ marks = {}, gone = [], removed = [], used = new Set(), held = new Set(), now = Date.now() } = {}) {
  const mark = [], unmark = [], sweep = [];
  const lost = new Set(gone);                                 // never mark over 'gone': a device holding the file must still see it
  for (const id of removed) if (!used.has(id) && !Object.hasOwn(marks, id) && !lost.has(id)) mark.push(id);
  for (const [id, at] of Object.entries(marks)) {
    if (used.has(id)) unmark.push(id);                        // used again: it stays
    else if (now - at >= WAIT_MS) sweep.push(id);
  }
  const reupload = gone.filter(id => used.has(id) && held.has(id));
  return { mark, unmark, sweep, reupload };
}
