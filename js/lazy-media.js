// Pictures and sounds are downloaded when they are first needed, not all at once while syncing (backlog 16: the Free plan
// allows 5 GB of downloads a month, and a new device used to fetch every file in the account).
// Pure decisions only, no database or network: sync.js does the fetching, media.js and audio.js ask for a file when a card
// shows it, tests/lazy-media.test.js checks the rules.
//
// How it works:
//   - A sync downloads nothing in bulk. It fetches at most a few dozen files for the cards that are due today (and the next few
//     new cards), so studying offline right after a sync mostly works (planPrefetch). Settings → Sync → "Keep all pictures and
//     sounds on this device" turns the old behaviour back on for one device (keepAll).
//   - A card that shows a file this device doesn't have asks for it then (media.js, audio.js → sync.downloadMedia), with a
//     placeholder meanwhile, and a quiet message if it can't (mediaMessage).
//   - A file that failed isn't asked for again at once (retryWait).
//   - "This device doesn't hold the file" never means "nobody uses it": the sweep, the re-upload and the unused-file clean-up only
//     look at cards (usedMediaIds) and at the files this device holds (media-sweep.js planSweep.held, db.cleanMedia).

import { splitCards } from './queue.js';

export const PREFETCH_FILES = 40;                   // at most this many files fetched ahead per sync
export const PREFETCH_BYTES = 6 * 1024 * 1024;      // and about this many bytes (a pool of 4 can overshoot by a few files)
export const NEW_AHEAD = 20;                        // new cards looked ahead at, as many as a normal day's limit

const list = v => (Array.isArray(v) ? v : []);
// The pictures and sounds one card uses.
export function cardFiles(card) {
  return {
    pictures: [card.frontImage, card.backImage].filter(Boolean),
    sounds: [...list(card.frontSounds), ...list(card.backSounds)].filter(Boolean)
  };
}

// The ids that cards use and `have` (a Set of the ids on this device) lacks: { pictures, sounds }, each without repeats.
export function wantedMedia(cards, have) {
  const pictures = new Set(), sounds = new Set();
  for (const c of cards) {
    const f = cardFiles(c);
    for (const id of f.pictures) if (!have.has(id)) pictures.add(id);
    for (const id of f.sounds) if (!have.has(id)) sounds.add(id);
  }
  return { pictures: [...pictures], sounds: [...sounds] };
}

// What to fetch ahead during a sync: ids this device lacks, for the cards you are about to study, most urgent first.
//   cards, statesById, now   as for buildQueue (queue.js); suspended and buried cards are left out
//   have       Set of the ids on this device
//   keepAll    the "keep everything" switch: every missing file, in card order, no limit
//   limit      at most this many files (not with keepAll)
//   newAhead   how many new cards to look at after the due ones
//   skip       (id) => true for a file that failed lately (retryWait): left out for now
// Returns { ids }: the rest loads when a card shows it.
export function planPrefetch({ cards, statesById = new Map(), have = new Set(), now = Date.now(), keepAll = false, limit = PREFETCH_FILES, newAhead = NEW_AHEAD, skip = () => false } = {}) {
  let order;
  if (keepAll) order = cards;
  else {
    const visible = cards.filter(c => !c.suspended && !(c.buriedUntil > now));
    const { reviews, waiting, fresh } = splitCards(visible, statesById, now);
    const firstNew = [...fresh].sort((a, b) => (a.created || 0) - (b.created || 0)).slice(0, newAhead);
    order = [...reviews.map(x => x.card), ...waiting.map(x => x.card), ...firstNew];
  }
  const ids = [], seen = new Set();
  for (const c of order) {
    const f = cardFiles(c);
    for (const id of [...f.pictures, ...f.sounds]) {
      if (have.has(id) || seen.has(id)) continue;
      seen.add(id);
      if (skip(id)) continue;
      if (keepAll || ids.length < limit) ids.push(id);
    }
  }
  return { ids };
}

// ---------- when to try again ----------
// A failed download is remembered for the rest of the time the app is open: { at, reason, tries }.
//   reason  'offline' (no connection, or the server didn't answer), 'signed-out', 'missing' (the account doesn't have the file),
//           'error' (anything else)
//   kind    'view' (a card is showing it: soon again), 'prefetch' (a sync is filling up ahead: much later), 'force' (the person
//           asked, e.g. an export: always try)
export function retryWait(entry, kind) {
  if (kind === 'force') return 0;
  const tries = Math.max(1, entry?.tries || 1);
  if (kind === 'prefetch') {
    if (entry.reason === 'missing') return 6 * 3600000;
    if (entry.reason === 'offline') return 10 * 60000;
    return Math.min(6 * 3600000, 2 * 60000 * 2 ** (tries - 1));
  }
  if (entry.reason === 'missing') return 2 * 60000;
  if (entry.reason === 'error') return 15000;
  return 3000;                 // offline / signed out: only so a card drawn twice in a row doesn't ask twice
}
export const canTry = (entry, now, kind) => !entry || now - entry.at >= retryWait(entry, kind);
// The next remembered failure for a file.
export const failedAgain = (prev, reason, now) => ({ at: now, reason, tries: (prev?.reason === reason ? prev.tries || 1 : 0) + 1 });

// A rough size for a number of files, to say "about 12 MB" before a big download (pictures are 100 to 250 KB, sounds up to 1 MB).
export const estimateBytes = ({ pictures = 0, sounds = 0 } = {}) => pictures * 150 * 1024 + sounds * 300 * 1024;

// ---------- words ----------
// What a card shows where a file couldn't be loaded. `sound` is true for a sound.
export function mediaMessage(reason, sound = false) {
  const what = sound ? 'Sound' : 'Picture';
  if (reason === 'signed-out') return `${what} not downloaded yet. Sign in to load it.`;
  if (reason === 'missing') return `${what} isn't in your account any more.`;
  if (reason === 'error') return `Couldn't load this ${what.toLowerCase()}.`;
  return `${what} not downloaded yet. It will load when you're online.`;
}
// The line in Settings → Your data: files cards use that this device hasn't downloaded yet.
export function notDownloadedLine({ pictures = 0, sounds = 0 } = {}) {
  const parts = [];
  if (pictures) parts.push(`${pictures.toLocaleString()} ${pictures === 1 ? 'picture' : 'pictures'}`);
  if (sounds) parts.push(`${sounds.toLocaleString()} ${sounds === 1 ? 'sound' : 'sounds'}`);
  return parts.length ? `${parts.join(' and ')} will download when a card needs ${pictures + sounds === 1 ? 'it' : 'them'}.` : '';
}
// After an export that couldn't fetch everything: how many pictures and sounds are not in the file, and what to do about it.
//   n files; reason: why the first one failed (see retryWait); gone: how many of them the account no longer has
export function leftOutNote(n, reason = 'offline', gone = 0) {
  const them = n === 1 ? 'it' : 'them';
  const what = `${n.toLocaleString()} ${n === 1 ? 'picture or sound isn' : 'pictures and sounds aren'}'t on this device`;
  if (n > 0 && gone === n) return `${what} and ${n === 1 ? "isn't" : "aren't"} in your account any more, so ${n === 1 ? "it isn't" : "they aren't"} included.`;
  const fix = reason === 'signed-out' ? `Sign in to download ${them}` : reason === 'error' ? `Try again in a moment to download ${them}` : `Connect to the internet to download ${them}`;
  return `${what} yet, so ${n === 1 ? "it isn't" : "they aren't"} included. ${fix}.`;
}
