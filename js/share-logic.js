// The pure parts of sharing a deck (js/share-deck.js): the wording and the share-or-save decision.
// Tested by tests/share-deck.test.js.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// An .apkg is a zip file. "application/zip" is a type phones' share sheets accept for files (the generic
// "octet-stream" is often refused) and one the receiving side's Share target lists too.
export const APKG_TYPE = 'application/zip';
export const CSV_TYPE = 'text/csv';

export const SAVED_NOTE = 'Saved the deck file. Send it to a friend; they open it in Study Sprint with Add cards → File.';
export const shareText = (name, count) => `“${name}”, ${plural(count, 'card')} for Study Sprint. Open the file in Study Sprint with Add cards → File.`;

export const makeFile = (blob, name, type) => new File([blob], name, { type });

// Can this browser hand this file to a share sheet?
export function canShareFile(nav, file) {
  try { return typeof nav?.share === 'function' && typeof nav.canShare === 'function' && !!nav.canShare({ files: [file] }); } catch { return false; }
}

// Share the file, or save it. Returns what happened:
//   'shared'   the share sheet took it
//   'cancelled' the person closed the share sheet (nothing to say)
//   'needs-tap' the browser wants a fresh tap before it opens the share sheet (iOS Safari, after a slow build)
//   'saved'    sharing files isn't possible here, so save() was called
export async function deliver(nav, file, { title, text }, save) {
  if (!canShareFile(nav, file)) { save(file); return 'saved'; }
  try { await nav.share({ files: [file], title, text }); return 'shared'; }
  catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
    if (e?.name === 'NotAllowedError') return 'needs-tap';
    save(file); return 'saved';          // some other failure (a file type the app refuses, say): the file is saved so nothing is lost
  }
}

