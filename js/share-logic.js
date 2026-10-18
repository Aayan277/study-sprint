// The pure parts of sharing a deck (js/share-deck.js): the wording and the share-or-save decision.
// Tested by tests/share-deck.test.js.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// An .apkg is a zip file. "application/zip" is a type phones' share sheets accept for files (the generic
// "octet-stream" is often refused) and one the receiving side's Share target lists too.
export const APKG_TYPE = 'application/zip';
export const CSV_TYPE = 'text/csv';

export const SAVED_NOTE = 'Saved the deck file to your downloads. Send it to a friend from there; they open it in Study Sprint with Add cards → File.';
export const MAX_SHARE_BYTES = 50 * 1024 * 1024;     // as the Add cards screen's limit for a file: a bigger one couldn't be opened by a friend
export const shareText = (name, count) => `“${name}”, ${plural(count, 'card')} for Study Sprint. Open the file in Study Sprint with Add cards → File.`;

export const makeFile = (blob, name, type) => new File([blob], name, { type });

// Can this browser hand this file to a share sheet? (canShare() only checks that files can be shared at all, not their type.)
export function canShareFile(nav, file) {
  try { return typeof nav?.share === 'function' && typeof nav.canShare === 'function' && !!nav.canShare({ files: [file] }); } catch { return false; }
}

// Chromium browsers (Chrome, Edge, Samsung Internet…) refuse deck files in their share sheet: their list of file types that may be
// shared has no .apkg, .zip or generic files. Safari (and every browser on iOS, which is Safari inside) takes them.
export const isChromium = nav => { const ua = String(nav?.userAgent || ''); return /Chrome\/|Chromium\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua); };
export const isIOS = nav => /iPhone|iPad|iPod/.test(String(nav?.userAgent || ''));

// What goes with the file. iOS shows text beside a file as a second item (and some apps turn it into a stray .txt), so it gets the title only.
export const shareData = (nav, file, title, text) => ({ files: [file], title, ...(isIOS(nav) ? {} : { text }) });

// Share the file, or save it. Returns what happened:
//   'shared'    the share sheet took it
//   'cancelled' the person closed the share sheet (nothing to say)
//   'needs-tap' the browser wants a fresh tap before it opens the share sheet (iOS Safari, after a slow build)
//   'busy'      a share sheet is already open: nothing to do
//   'saved'     sharing this file isn't possible, so save() was called
// again = this is the tap that was asked for: a refusal now means the browser won't take the file, so it is saved.
export async function deliver(nav, file, { title, text }, save, { again = false } = {}) {
  const saveIt = () => { save(file); return 'saved'; };
  if (!canShareFile(nav, file) || file.size > MAX_SHARE_BYTES) return saveIt();
  const ua = nav.userActivation;
  if (ua && isChromium(nav) && /\.apkg$/i.test(file.name)) return saveIt();
  if (ua && ua.isActive === false) return again ? saveIt() : 'needs-tap';      // not called: it would only be refused
  try { await nav.share(shareData(nav, file, title, text)); return 'shared'; }
  catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
    if (e?.name === 'InvalidStateError') return 'busy';
    // Refused. With a tap that was fresh, the browser doesn't take this file. Without a way to tell (no userActivation), ask for a tap once.
    if (e?.name === 'NotAllowedError' && !ua && !again) return 'needs-tap';
    return saveIt();                     // refused, or some other failure: the file is saved so nothing is lost
  }
}

// What a file shared to the app is, from its name, type and first bytes: 'anki' | 'excel' | 'json' | 'text' | 'unknown'.
// (The Share target also accepts zip and generic files so a deck file can arrive, so other files come too.)
export function sharedKind({ name = '', type = '' }, head = []) {
  if (/\.(apkg|colpkg)$/i.test(name)) return 'anki';
  if (/\.xlsx?$/i.test(name)) return 'excel';
  if (/\.json$/i.test(name)) return 'json';
  if (/^text\//.test(type) || /\.(txt|csv|tsv)$/i.test(name)) return 'text';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return 'anki';      // a zip file with no known name: tried as a deck
  return 'unknown';
}
