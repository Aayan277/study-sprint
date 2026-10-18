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
//     account, then sets the mark to null. The sweep runs right after the device has synced its cards, so it knows about
//     every card the account has. (A device that stays offline for over 30 days with a card using the file is the one case
//     this cannot protect: the file is gone from the account, though that device keeps its own copy.)
//   - Older versions of the app ignore "mdel:" settings, so they simply never mark or sweep.

export const MARK_PREFIX = 'mdel:';
export const WAIT_DAYS = 30;
export const WAIT_MS = WAIT_DAYS * 86400000;

export const markKey = id => MARK_PREFIX + id;
export const isMarkKey = key => typeof key === 'string' && key.startsWith(MARK_PREFIX);
export const markId = key => key.slice(MARK_PREFIX.length);
// A mark's value from outside (the server, a backup): a real time or null; anything else is junk.
export const validMark = v => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);

// What to do after a sync, given:
//   marks    { id: time } for the files that are marked now (unmarked ones are left out)
//   removed  ids this device just dropped because no card uses them (and the account has a copy)
//   used     Set of the ids that some card on this device uses
//   now      the time in milliseconds
// Returns { mark: [ids to mark now], unmark: [ids], sweep: [ids to delete from the account now] }.
export function planSweep({ marks = {}, removed = [], used = new Set(), now = Date.now() } = {}) {
  const mark = [], unmark = [], sweep = [];
  for (const id of removed) if (!used.has(id) && !(id in marks)) mark.push(id);
  for (const [id, at] of Object.entries(marks)) {
    if (used.has(id)) unmark.push(id);                        // used again: it stays
    else if (now - at >= WAIT_MS) sweep.push(id);
  }
  return { mark, unmark, sweep };
}
