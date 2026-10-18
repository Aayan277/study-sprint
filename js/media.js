// Pictures and sounds on cards. A picture: one on the front (card.frontImage) and one on the back (card.backImage), each the
// id of a picture in the database's media store (db.js). A sound: up to 4 on each side (card.frontSounds / card.backSounds,
// arrays of ids in the same store). Both sync through Supabase Storage (sync.js).
//
//   addImage(file)   shrink a picked photo (longest side 1280px, JPEG) and save it; returns its id
//   addImageInfo(file, opts)  the same, but returns { id, width, height } (image occlusion needs the size)
//   saveSound(file)  keep a picked or imported sound as it is (never converted); returns { id, size, type }
//   cardMediaHTML(card, side, textHTML)   one side of a card: its picture, the text, then its sound buttons (audio.js)
//   imgHTML(id)      an <img> for a picture; it fills itself in (see the watcher at the bottom), downloading
//                    the picture from your account first if this device doesn't have it yet

import * as db from './db.js';
import { pictureTooBig } from './quota.js';
import { soundsHTML } from './audio.js';
import { soundType, soundExt, sniffAudioType } from './audio-type.js';

const MAX_SIDE = 1280;     // pixels: plenty for a phone or laptop screen, and keeps files ~100–250 KB
export const OCCLUSION_SIDE = 2048;     // image-occlusion pictures are kept larger, so small diagram text stays readable
const QUALITY = 0.82;

// Shrink and re-save a picture as JPEG. (Transparent areas, e.g. in a PNG diagram, become white.)
// Returns the saved size (width, height) and the size the picture had before (srcWidth, srcHeight).
export async function processImage(file, { maxSide = MAX_SIDE } = {}) {
  const img = await decode(file);
  const srcWidth = img.width, srcHeight = img.height;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  img.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not save the picture');
  // Still too big after shrinking (a very detailed picture): refuse it, with a message to show (quota.js).
  const tooBig = pictureTooBig(blob.size, { occlusion: maxSide > MAX_SIDE });
  if (tooBig) throw Object.assign(new Error(tooBig), { code: 'too_big' });
  return { type: 'image/jpeg', data: await blob.arrayBuffer(), width: w, height: h, srcWidth, srcHeight };
}
async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older browsers */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error("That file isn't a picture this browser can open.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function addImage(file, opts) {
  const { type, data } = await processImage(file, opts);
  return saveImage(type, data);
}
export async function addImageInfo(file, opts) {
  const { type, data, width, height } = await processImage(file, opts);
  return { id: await saveImage(type, data), width, height };
}
// Save picture bytes as they are (e.g. from an Anki deck). Returns the new id.
export async function saveImage(type, data) {
  const id = db.newId();
  await db.putMedia({ id, type, data, size: data.byteLength, created: Date.now(), uploaded: false });
  return id;
}

// ---------- sounds ----------
export const MAX_SOUND_BYTES = 1024 * 1024;       // 1 MB per sound: longer ones are skipped (and reported), so a deck can't fill a phone
export const MAX_SOUNDS = 4;                       // per side of a card
export { soundType, soundExt };
// "3.4 MB", "24 KB".
export const sizeText = n => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Save a sound's bytes as they are. file: a File/Blob (with a name) or { name, type, data }.
// Throws an Error with a plain message when it is too big or not a sound the app keeps.
export async function saveSound(file) {
  const name = file.name || '';
  const data = file.data || await file.arrayBuffer();
  // The file's own first bytes say what it is more honestly than its name or the type the picker guessed.
  const type = sniffAudioType(data) || soundType(file.type, name);
  if (!type) throw new Error("That isn't a sound file the app can keep (use .mp3, .m4a, .ogg, .wav or .flac).");
  if (data.byteLength > MAX_SOUND_BYTES) throw Object.assign(new Error(`That sound is ${sizeText(data.byteLength)}. Sounds can be up to 1 MB: shorten it or save it at a lower quality.`), { code: 'too_big' });
  const id = db.newId();
  await db.putMedia({ id, type, data, size: data.byteLength, name: name.slice(0, 120), created: Date.now(), uploaded: false });
  persistOnce();
  return { id, size: data.byteLength, type, name };
}
// Ask the browser to keep this site's data (it shows no prompt in Chrome or Safari). Done once, after the first sound.
let asked = false;
function persistOnce() {
  if (asked) return;
  asked = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* fine */ }
}

// ---------- showing pictures ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const imgHTML = (id, cls = 'card-img') => (id ? `<img class="${cls}" data-media="${esc(id)}" alt="Picture">` : '');

// One side of a card: its picture, the text (already HTML), then a row of play buttons when it has sounds.
export const cardMediaHTML = (card, side, textHTML) =>
  `${imgHTML(card[side + 'Image'])}${textHTML}${soundsHTML(card[side + 'Sounds'])}`;

const urls = new Map();      // media id → a blob: address for <img>, made once per picture
export async function mediaURL(id) {
  if (urls.has(id)) return urls.get(id);
  let m = await db.getMedia(id);
  if (!m) {
    // Not on this device yet (added on another device): download it from the account, if signed in.
    try { m = await (await import('./sync.js')).downloadMedia(id); } catch { m = null; }
  }
  if (!m) return null;
  const url = URL.createObjectURL(new Blob([m.data], { type: m.type }));
  urls.set(id, url);
  return url;
}
async function fill(img) {
  img.dataset.loading = '1';
  const url = await mediaURL(img.dataset.media);
  if (url) img.src = url;
  else { img.alt = 'Picture not available on this device yet'; img.classList.add('missing'); }
}
// Fill in every picture as soon as it appears on the page, wherever it is.
function fillAll(root) {
  root.querySelectorAll?.('img[data-media]:not([data-loading])').forEach(fill);
  if (root.matches?.('img[data-media]:not([data-loading])')) fill(root);
}
new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && fillAll(n))))
  .observe(document.documentElement, { childList: true, subtree: true });
