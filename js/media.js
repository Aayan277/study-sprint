// Pictures on cards: one on the front (card.frontImage) and one on the back (card.backImage), each the id
// of a picture in the database's media store (db.js). Pictures sync through Supabase Storage (sync.js).
//
//   addImage(file)   shrink a picked photo (longest side 1280px, JPEG) and save it; returns its id
//   imgHTML(id)      an <img> for a picture; it fills itself in (see the watcher at the bottom), downloading
//                    the picture from your account first if this device doesn't have it yet

import * as db from './db.js';

const MAX_SIDE = 1280;     // pixels: plenty for a phone or laptop screen, and keeps files ~100–250 KB
const QUALITY = 0.82;

// Shrink and re-save a picture as JPEG. (Transparent areas, e.g. in a PNG diagram, become white.)
export async function processImage(file) {
  const img = await decode(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  img.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not save the picture');
  return { type: 'image/jpeg', data: await blob.arrayBuffer(), width: w, height: h };
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

export async function addImage(file) {
  const { type, data } = await processImage(file);
  return saveImage(type, data);
}
// Save picture bytes as they are (e.g. from an Anki deck). Returns the new id.
export async function saveImage(type, data) {
  const id = db.newId();
  await db.putMedia({ id, type, data, size: data.byteLength, created: Date.now(), uploaded: false });
  return id;
}

// ---------- showing pictures ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const imgHTML = (id, cls = 'card-img') => (id ? `<img class="${cls}" data-media="${esc(id)}" alt="Picture">` : '');

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
