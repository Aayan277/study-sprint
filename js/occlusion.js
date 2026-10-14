// Image occlusion: a picture with boxes (masks) over the parts to learn, like "hide all, guess one".
// Every group of boxes (masks that share a number n) is one card. The cards of one picture are "siblings": they share
// a noteId and carry the full list of masks, like cloze cards carry the full text (see cloze.js).
// A card keeps an ordinary front and back too (the picture is in backImage), so older versions of the app, CSV
// export and search keep working.
//
//   card.occlusion = { n, w, h, header?, masks: [{ id, n, shape, x, y, w, h, points?, label? }] }
//   x, y, w, h are fractions (0 to 1) of the picture, so they survive resizing. w and h in the occlusion itself are
//   the saved picture's size in pixels (so the box has the right shape before the picture has loaded).
//
// Pure functions (no page, no database, and NO imports, so db.js can load this at start-up), tested by
// tests/occlusion.test.js. The part that touches the page (zoom, pinch) is in occlusion-view.js.

export const MAX_MASKS = 300;     // boxes in one picture
export const MAX_POINTS = 200;    // corners of one polygon
export const MAX_LABEL = 200;
export const MAX_HEADER = 300;
const SHAPES = ['rect', 'ellipse', 'polygon'];
const EPS = 1e-6;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clamp01 = v => Math.min(1, Math.max(0, v));
const round5 = v => Math.round(v * 1e5) / 1e5;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- cards and groups ----------

// Is this one of the cards of an image-occlusion picture? (Looks at the shape of the data only.)
export const isOcclusion = card => !!card?.noteId && isPlain(card.occlusion) && Array.isArray(card.occlusion.masks) && Number.isInteger(card.occlusion.n);

// The groups of a list of masks: their numbers, smallest first. [{n:3},{n:1},{n:3}] → [1, 3]
export const groupsOf = masks => [...new Set((masks || []).map(m => m?.n).filter(Number.isInteger))].sort((a, b) => a - b);

// Does this card still have its group among the masks? (If not, it is shown as an ordinary card.)
export const hasMasks = card => isOcclusion(card) && groupsOf(card.occlusion.masks).includes(card.occlusion.n);

// The number people see: group n is "part k of G" (k counts from 1 in order of n). n itself is only an identity that
// keeps a card's schedule, so it can have gaps. { k: 0 } when n is not in the list.
export function groupIndex(masks, n) {
  const groups = groupsOf(masks);
  return { k: groups.indexOf(n) + 1, total: groups.length };
}

// A group's label: the different labels of its masks, joined. '' when it has none.
export function occLabel(masks, n) {
  const labels = (masks || []).filter(m => m?.n === n).map(m => String(m.label ?? '').trim()).filter(Boolean);
  return [...new Set(labels)].join(', ');
}

// The ordinary front and back for a card (what older versions of the app show).
export function occFrontBack({ header, masks }, n) {
  const { k, total } = groupIndex(masks, n);
  return { front: `${String(header ?? '').trim() || 'Diagram'}: hidden part ${k} of ${total}`, back: occLabel(masks, n) };
}

// ---------- checking data ----------
// Boxes end up in style attributes (and in backups and sync), so only plain numbers in range are allowed.
function validMask(m) {
  if (!isPlain(m) || typeof m.id !== 'string' || !Number.isInteger(m.n) || m.n < 1 || !SHAPES.includes(m.shape)) return false;
  if (![m.x, m.y, m.w, m.h].every(isNum) || m.x < 0 || m.y < 0 || m.w <= 0 || m.h <= 0 || m.x + m.w > 1 + EPS || m.y + m.h > 1 + EPS) return false;
  if (m.label !== undefined && typeof m.label !== 'string') return false;
  if (m.points !== undefined) {
    if (!Array.isArray(m.points) || m.points.length < 3 || m.points.length > MAX_POINTS) return false;
    if (!m.points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => isNum(v) && v >= 0 && v <= 1))) return false;
  }
  return true;
}
export const validMasks = masks => Array.isArray(masks) && masks.length >= 1 && masks.length <= MAX_MASKS && masks.every(validMask);

// Is this a good card.occlusion?
export const validOcclusion = o =>
  isPlain(o) && Number.isInteger(o.n) && o.n >= 1 && isNum(o.w) && o.w > 0 && isNum(o.h) && o.h > 0 &&
  (o.header === undefined || typeof o.header === 'string') && validMasks(o.masks);

// Tidy one box from outside (Number(), clamp into the picture, round). null when nothing is left of it.
export function cleanMask(m) {
  if (!m || typeof m !== 'object') return null;
  const shape = SHAPES.includes(m.shape) ? m.shape : 'rect';
  let points;
  if (Array.isArray(m.points)) {
    points = m.points.map(p => [Number(p?.[0]), Number(p?.[1])]).filter(p => p.every(Number.isFinite)).map(p => [round5(clamp01(p[0])), round5(clamp01(p[1]))]);
    if (points.length > MAX_POINTS) points = Array.from({ length: MAX_POINTS }, (_, i) => points[Math.floor(i * points.length / MAX_POINTS)]);
    if (points.length < 3) points = undefined;
  }
  let x = Number(m.x), y = Number(m.y), w = Number(m.w), h = Number(m.h);
  if (points) {
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    x = Math.min(...xs); y = Math.min(...ys); w = Math.max(...xs) - x; h = Math.max(...ys) - y;
  }
  if (![x, y, w, h].every(Number.isFinite)) return null;
  x = clamp01(x); y = clamp01(y);
  w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
  x = round5(x); y = round5(y); w = round5(w); h = round5(h);
  if (w <= 0 || h <= 0) return null;
  const n = Number.isInteger(Number(m.n)) && Number(m.n) >= 1 ? Number(m.n) : 1;
  const label = typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, MAX_LABEL) : undefined;
  return { id: String(m.id ?? ''), n, shape: points ? 'polygon' : shape === 'polygon' ? 'rect' : shape, x, y, w, h, ...(points ? { points } : {}), ...(label ? { label } : {}) };
}

// ---------- Anki's image-occlusion notes ----------
// Anki 23.10+ keeps the boxes in a cloze-style field:
//   {{c1::image-occlusion:rect:left=.23:top=.1:width=.4:height=.5:oi=1}}
// (ellipse: left, top, rx, ry; polygon: points=x,y x,y …; text: skipped). A ":" inside a value is written "\:".
// Older versions wrote pixels instead of fractions.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plainField = html => String(html ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const SHAPE_CODE = /\{\{c(\d+)::image-occlusion:(rect|ellipse|polygon|text)((?:\\.|[^}\\])*)\}\}/g;

// "left=.1:top=.2" → { left: '.1', top: '.2' }, splitting on ":" that is not escaped.
function properties(text) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) { cur += text[i + 1]; i++; }
    else if (text[i] === ':') { parts.push(cur); cur = ''; }
    else cur += text[i];
  }
  parts.push(cur);
  const out = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) out[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return out;
}
const num = v => (v === undefined || String(v).trim() === '' ? NaN : Number(v));

// The field's shapes: { shapes: [{ n, shape, x, y, w, h, points? }], pixels }. pixels is true when any number is
// above 1: the whole note is in pixels (decided per note), and toFractions needs the picture's size.
export function parseAnkiOcclusion(fieldHtml) {
  const shapes = [];
  for (const m of plainField(fieldHtml).matchAll(SHAPE_CODE)) {
    const n = +m[1], kind = m[2], p = properties(m[3]);
    if (kind === 'text' || n < 1) continue;
    let s = null;
    if (kind === 'rect') s = { n, shape: 'rect', x: num(p.left), y: num(p.top), w: num(p.width), h: num(p.height) };
    else if (kind === 'ellipse') {
      const w = p.rx !== undefined ? num(p.rx) * 2 : num(p.width), h = p.ry !== undefined ? num(p.ry) * 2 : num(p.height);
      s = { n, shape: 'ellipse', x: num(p.left), y: num(p.top), w, h };
    } else {
      const points = String(p.points ?? '').replace(/["']/g, '').trim().split(/\s+/).map(pair => pair.split(',').map(num)).filter(pt => pt.length === 2 && pt.every(Number.isFinite));
      if (points.length < 3) continue;
      // Anki's editor moves a polygon by changing left/top and leaves the points alone, so shift the points to left/top.
      const left = num(p.left), top = num(p.top);
      const dx = Number.isFinite(left) ? left - Math.min(...points.map(pt => pt[0])) : 0;
      const dy = Number.isFinite(top) ? top - Math.min(...points.map(pt => pt[1])) : 0;
      if (dx || dy) points.forEach(pt => { pt[0] += dx; pt[1] += dy; });
      const xs = points.map(pt => pt[0]), ys = points.map(pt => pt[1]);
      s = { n, shape: 'polygon', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), points };
    }
    if (![s.x, s.y, s.w, s.h].every(Number.isFinite) || s.w <= 0 || s.h <= 0) continue;
    shapes.push(s);
  }
  const biggest = Math.max(0, ...shapes.flatMap(s => [s.x, s.y, s.w, s.h, ...(s.points || []).flat()]));
  return { shapes, pixels: biggest > 1 };
}

// Parsed shapes → boxes in fractions of the picture, with ids m1, m2, … Pixels are divided by the original size of the
// picture (srcW, srcH). Boxes with nothing left after clamping are dropped.
export function toFractions(shapes, pixels, srcW, srcH) {
  const fx = pixels ? 1 / srcW : 1, fy = pixels ? 1 / srcH : 1;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return [];
  const masks = [];
  for (const s of shapes) {
    const m = cleanMask({
      id: 'm' + (masks.length + 1), n: s.n, shape: s.shape, label: s.label, x: s.x * fx, y: s.y * fy, w: s.w * fx, h: s.h * fy,
      points: s.points?.map(([px, py]) => [px * fx, py * fy])
    });
    if (m) masks.push(m);
  }
  return masks;
}

// Boxes → Anki's field text, for export. 4 decimals and no leading zero, like Anki writes them.
const ank = v => (+v).toFixed(4).replace(/^0\./, '.');
export function ankiOcclusionText(masks) {
  return masks.map(m => {
    const props = m.shape === 'polygon' && m.points
      ? [`left=${ank(m.x)}`, `top=${ank(m.y)}`, `points=${m.points.map(([x, y]) => `${ank(x)},${ank(y)}`).join(' ')}`]
      : m.shape === 'ellipse'
        ? [`left=${ank(m.x)}`, `top=${ank(m.y)}`, `rx=${ank(m.w / 2)}`, `ry=${ank(m.h / 2)}`]
        : [`left=${ank(m.x)}`, `top=${ank(m.y)}`, `width=${ank(m.w)}`, `height=${ank(m.h)}`];
    return `{{c${m.n}::image-occlusion:${m.shape === 'polygon' && m.points ? 'polygon' : m.shape === 'ellipse' ? 'ellipse' : 'rect'}:${props.join(':')}:oi=1}}`;
  }).join('');
}

// ---------- saving a note ----------
// Work out what saving a picture's boxes does to the note's existing cards (like planNoteSave in cloze.js).
//   oldSiblings  the note's cards now
//   note         { masks, header, w, h, image (a media id), extra? }
//   score        of two cards with one n, the higher score(card) stays
// Returns { update, add, remove, duplicates, error }:
//   update  cards whose group is still there: same id (so the schedule stays), new boxes, front and back
//   add     groups that are new
//   remove  cards whose group is gone (deleted or joined into another), and duplicates
//   duplicates  the part of remove that is not a gone group: a second card with the same n, or one without boxes
//   error   set (and nothing else to do) with the message to show
export function planOcclusionSave(oldSiblings, note, score = () => 0) {
  const none = error => ({ update: [], add: [], remove: [], duplicates: [], error });
  const masks = note?.masks;
  if (!Array.isArray(masks) || !masks.length) return none('Draw at least one box over the part to hide.');
  if (!note.image) return none('Choose a picture first.');
  const header = String(note.header ?? '').trim().slice(0, MAX_HEADER);
  if (!validOcclusion({ n: 1, w: note.w, h: note.h, header, masks })) return none("Those boxes aren't right. Please draw them again.");
  const byN = new Map(), duplicates = [];
  for (const card of oldSiblings) {
    const n = isOcclusion(card) ? card.occlusion.n : undefined;
    if (n === undefined) duplicates.push(card);
    else if (!byN.has(n)) byN.set(n, card);
    else if (score(card) > score(byN.get(n))) { duplicates.push(byN.get(n)); byN.set(n, card); }
    else duplicates.push(card);
  }
  const remove = [...duplicates], update = [], add = [];
  const groups = groupsOf(masks);
  for (const n of groups) {
    const { front, back } = occFrontBack({ header, masks }, n);
    const occlusion = { n, w: note.w, h: note.h, ...(header ? { header } : {}), masks };
    const old = byN.get(n);
    if (old) update.push({ ...old, front, back, backImage: note.image, occlusion });
    else add.push({ front, back, backImage: note.image, occlusion });
  }
  for (const [n, card] of byN) if (!groups.includes(n)) remove.push(card);
  return { update, add, remove, duplicates };
}

// What the editor says before it deletes cards: "Box 3 was removed: its card and review history go too."
// The numbers are the positions the boxes had (part k), counted in the old picture.
export function occRemovalText({ remove, duplicates = [] }) {
  const place = c => (isOcclusion(c) ? groupIndex(c.occlusion.masks, c.occlusion.n).k : 0);
  const byPlace = (a, b) => place(a) - place(b);
  const gone = remove.filter(c => !duplicates.includes(c)).sort(byPlace).map(place);
  const extra = duplicates.slice().sort(byPlace).map(c => (place(c) ? 'duplicate box ' + place(c) : 'an extra card without a box'));
  const join = list => (list.length < 3 ? list.join(' and ') : list.slice(0, -1).join(', ') + ' and ' + list.at(-1));
  const parts = [];
  if (gone.length) parts.push(`${gone.length === 1 ? 'Box' : 'Boxes'} ${join(gone)} ${gone.length === 1 ? 'was' : 'were'} removed`);
  if (extra.length) {
    const text = join(extra);
    parts.push(`${parts.length ? text : text[0].toUpperCase() + text.slice(1)} removed`);
  }
  const one = remove.length === 1;
  return `${parts.join(' and ')}: ${one ? 'its card and review history go' : 'their cards and review history go'} too.`;
}

// Two devices can edit different cards of one picture while offline, so the siblings can end up with different boxes.
// Make them agree again, the way cloze.healNotes does: the card with the latest noteEditedAt (else updatedAt, ties to
// the larger id) wins, and the others get its boxes, header and picture with their own n. A sibling whose n is gone
// from the winner is left alone. The fixed cards get the winner's noteEditedAt (never "now"). Returns the cards to save.
export function healOcclusion(cards) {
  const notes = new Map();
  for (const c of cards) if (isOcclusion(c)) (notes.get(c.noteId) || notes.set(c.noteId, []).get(c.noteId)).push(c);
  // A signature that doesn't depend on key order (a database may reorder the keys of the boxes).
  const maskSig = m => [m?.id, m?.n, m?.shape, m?.x, m?.y, m?.w, m?.h, m?.label ?? null, m?.points ?? null];
  const sigOf = c => JSON.stringify([c.occlusion.header ?? null, c.occlusion.w, c.occlusion.h, c.occlusion.masks.map(maskSig), c.backImage || '', c.noteExtra || '']);
  const fixed = [];
  for (const sibs of notes.values()) {
    if (sibs.every(s => sigOf(s) === sigOf(sibs[0]))) continue;
    const stamped = sibs.filter(s => s.noteEditedAt !== undefined);
    const time = stamped.length ? s => s.noteEditedAt : s => s.updatedAt || 0;
    // Prefer a winner that still has its picture; ties go to the later updatedAt, then the larger id.
    const pool = stamped.length ? stamped : sibs;
    const withPic = pool.filter(s => s.backImage);
    const newest = (withPic.length ? withPic : pool).reduce((a, b) => {
      const later = time(b) - time(a) || (b.updatedAt || 0) - (a.updatedAt || 0) || (b.id > a.id ? 1 : -1);
      return later > 0 ? b : a;
    });
    const { header, masks, w, h } = newest.occlusion;
    const groups = groupsOf(masks);
    for (const s of sibs) {
      if (!groups.includes(s.occlusion.n)) continue;
      const { front, back } = occFrontBack({ header, masks }, s.occlusion.n);
      const occlusion = { n: s.occlusion.n, w, h, ...(header ? { header } : {}), masks };
      if (sigOf(s) === sigOf(newest) && s.front === front && s.back === back) continue;
      const card = { ...s, front, back, backImage: newest.backImage || s.backImage, occlusion };
      if (newest.noteExtra) card.noteExtra = newest.noteExtra; else delete card.noteExtra;
      if (newest.noteEditedAt !== undefined) card.noteEditedAt = newest.noteEditedAt;
      fixed.push(card);
    }
  }
  return fixed;
}

// ---------- showing a card ----------
// Only numbers get into style attributes: a percentage with 3 decimals.
const pct = v => (clamp01(Number(v)) * 100).toFixed(3) + '%';
const ZOOM_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>';

// The boxes that can be drawn: a known shape and finite numbers (anything else is dropped).
const drawable = masks => (Array.isArray(masks) ? masks : []).filter(m => isPlain(m) && SHAPES.includes(m.shape) && Number.isInteger(m.n) && [m.x, m.y, m.w, m.h].every(isNum) && m.w > 0 && m.h > 0);

// The picture with its boxes, as HTML, for one card.
//   side 'front'  every box grey, this card's group in the accent colour with a "?"
//   side 'back'   only this card's group uncovered (with its label), the others stay covered
//   side 'all'    every box as an outline with a number (the editor's preview); this card's group is highlighted
//   zoom          add the Zoom button (not wanted in Play or in small lists)
//   shortcut      say the button has the Z key (Review does; the walk-through doesn't)
export function occlusionHTML(card, side = 'front', { zoom = true, shortcut = true } = {}) {
  const o = card?.occlusion || {};
  const masks = drawable(o.masks);
  const groups = groupsOf(masks), total = groups.length;
  const name = String(o.header ?? '').trim() || 'Diagram';
  const active = o.n;
  const { k } = groupIndex(masks, active);
  const W = Number(o.w), H = Number(o.h);
  const sized = isNum(W) && isNum(H) && W > 0 && H > 0;
  const label = occLabel(masks, active);
  const box = m => `left:${pct(m.x)};top:${pct(m.y)};width:${pct(m.w)};height:${pct(m.h)}`;
  const shapeStyle = m => {
    let s = box(m);
    if (m.shape === 'ellipse') s += ';border-radius:50%';
    if (m.shape === 'polygon' && Array.isArray(m.points) && m.points.length >= 3 && m.points.every(p => Array.isArray(p) && isNum(p[0]) && isNum(p[1])) && m.w > 0 && m.h > 0) {
      const rel = (v, from, size) => (Math.min(1, Math.max(0, (v - from) / size)) * 100).toFixed(2) + '%';
      s += `;clip-path:polygon(${m.points.map(([px, py]) => `${rel(px, m.x, m.w)} ${rel(py, m.y, m.h)}`).join(',')})`;
    }
    return s;
  };
  const divs = masks.map(m => {
    const mine = m.n === active;
    const style = shapeStyle(m);
    if (side === 'all') {
      const at = groupIndex(masks, m.n).k;
      return `<div class="occ-mask occ-all${mine ? ' occ-ask' : ''}" style="${style}" aria-hidden="true"><span class="occ-num">${at}</span></div>`;
    }
    if (side === 'back' && mine) {
      return `<div class="occ-mask occ-reveal" style="${style}" role="img" aria-label="${esc(label ? 'Answer: ' + label : `Uncovered part ${k} of ${total}`)}"></div>`;
    }
    if (side === 'front' && mine) {
      return `<div class="occ-mask occ-ask" style="${style}" role="img" aria-label="Hidden part ${k} of ${total}: name this part"></div>`;
    }
    return `<div class="occ-mask" style="${style}" aria-hidden="true"></div>`;
  }).join('');
  // The label of the uncovered group sits under it (or above it, near the bottom edge).
  let tag = '';
  if (side === 'back' && label) {
    const mine = masks.filter(m => m.n === active);
    const left = Math.min(...mine.map(m => m.x)), right = Math.max(...mine.map(m => m.x + m.w));
    const top = Math.min(...mine.map(m => m.y)), bottom = Math.max(...mine.map(m => m.y + m.h));
    const where = bottom <= 0.82 ? `top:${pct(bottom)}` : top >= 0.18 ? `top:${pct(top)}` : 'bottom:6px';
    const cls = bottom <= 0.82 ? '' : top >= 0.18 ? ' occ-tag-up' : ' occ-tag-in';
    // Centred on the boxes (15% to 85%), but pulled back by its own width so it stays inside the figure.
    const c = (Math.min(0.85, Math.max(0.15, (left + right) / 2)) * 100).toFixed(3);
    tag = `<span class="occ-tag${cls}" aria-hidden="true" style="left:${c}%;transform:${cls === ' occ-tag-up' ? `translate(-${c}%,-100%)` : `translateX(-${c}%)`};${where}">${esc(label)}</span>`;
  }
  const style = sized ? ` style="aspect-ratio:${Math.round(W)} / ${Math.round(H)};--ar:${(W / H).toFixed(4)}"` : '';
  return `<figure class="occ occ-${side}${sized ? '' : ' occ-flow'}"${style} role="group" aria-label="${esc(name)}: ${total} hidden ${total === 1 ? 'part' : 'parts'}">`
    + `<img class="occ-img" data-media="${esc(card?.backImage ?? '')}" alt="${esc(name)}">${divs}${tag}`
    + `${zoom ? `<button type="button" class="occ-zoom" aria-label="Zoom picture"${shortcut ? ' aria-keyshortcuts="Z"' : ''}>${ZOOM_ICON}</button>` : ''}</figure>`;
}

// What read-aloud says. Front: "Heart anatomy. What is hidden part 2 of 5?" Back: the label, or "Part 2 of 5".
export function occSpeech(card, flipped) {
  const o = card.occlusion, { k, total } = groupIndex(o.masks, o.n);
  if (flipped) return occLabel(o.masks, o.n) || `Part ${k} of ${total}`;
  const head = String(o.header ?? '').trim();
  return `${head ? head + '. ' : ''}What is hidden part ${k} of ${total}?`;
}

// ---------- geometry (zoom now, the drawing editor later) ----------
// The picture sits on a "canvas" of cw × ch pixels (the picture fitted into its frame). A view is where that canvas
// is: { s: zoom (1 to 8), x, y: where its top-left corner is, in frame pixels }.
export const MIN_SCALE = 1, MAX_SCALE = 8;

// The canvas size that fits an iw × ih picture in a vw × vh frame, centred at zoom 1.
export function fitView(vw, vh, iw, ih) {
  const f = Math.min(vw / iw, vh / ih);
  const cw = iw * f, ch = ih * f;
  return { cw, ch, s: 1, x: (vw - cw) / 2, y: (vh - ch) / 2 };
}
// Zoom to scale s (1 to 8) keeping the point (cx, cy) of the frame where it is.
export function zoomAt(view, s, cx, cy) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  return { ...view, s: next, x: cx - (cx - view.x) * (next / view.s), y: cy - (cy - view.y) * (next / view.s) };
}
// Keep at least 40% of the picture (in each direction) inside the frame, so it can't be lost.
export function clampView(view, vw, vh, cw, ch) {
  const sw = cw * view.s, sh = ch * view.s;
  const keepX = 0.4 * Math.min(sw, vw), keepY = 0.4 * Math.min(sh, vh);
  return { ...view, x: Math.min(vw - keepX, Math.max(keepX - sw, view.x)), y: Math.min(vh - keepY, Math.max(keepY - sh, view.y)) };
}
// A point of the frame → a point of the picture, as fractions (0 to 1; outside the picture it is beyond that).
export const toImage = (view, px, py, cw, ch) => ({ x: (px - view.x) / (view.s * cw), y: (py - view.y) / (view.s * ch) });
// The box between two points of the picture (any corner first), kept inside the picture.
export function rectFrom(a, b) {
  const x1 = clamp01(Math.min(a.x, b.x)), x2 = clamp01(Math.max(a.x, b.x));
  const y1 = clamp01(Math.min(a.y, b.y)), y2 = clamp01(Math.max(a.y, b.y));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Is the point (x, y) inside this mask? Rectangles by their box, ellipses by their equation, polygons by a ray.
function inside(m, x, y) {
  if (x < m.x || y < m.y || x > m.x + m.w || y > m.y + m.h) return false;
  if (m.shape === 'ellipse') {
    const dx = (x - (m.x + m.w / 2)) / (m.w / 2), dy = (y - (m.y + m.h / 2)) / (m.h / 2);
    return dx * dx + dy * dy <= 1;
  }
  if (m.shape === 'polygon' && m.points?.length >= 3) {
    let hit = false;
    for (let i = 0, j = m.points.length - 1; i < m.points.length; j = i++) {
      const [xi, yi] = m.points[i], [xj, yj] = m.points[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  return true;
}
// The mask under a point: the topmost one (the last in the list) wins. null when none.
export function hitTest(masks, x, y) {
  for (let i = masks.length - 1; i >= 0; i--) if (isPlain(masks[i]) && inside(masks[i], x, y)) return masks[i];
  return null;
}
// Which corner of the mask's box is the point on? 'nw' | 'ne' | 'sw' | 'se' | null. tolX/tolY: how close, in picture fractions.
export function handleAt(m, x, y, tolX, tolY) {
  const corners = { nw: [m.x, m.y], ne: [m.x + m.w, m.y], sw: [m.x, m.y + m.h], se: [m.x + m.w, m.y + m.h] };
  let best = null, bestD = Infinity;
  for (const [name, [cx, cy]] of Object.entries(corners)) {
    const dx = Math.abs(x - cx) / tolX, dy = Math.abs(y - cy) / tolY;
    if (dx <= 1 && dy <= 1 && dx + dy < bestD) { best = name; bestD = dx + dy; }
  }
  return best;
}
// The mask moved by (dx, dy), kept inside the picture.
export function moveMask(m, dx, dy) {
  const mx = Math.min(1 - m.w, Math.max(0, m.x + dx)) - m.x, my = Math.min(1 - m.h, Math.max(0, m.y + dy)) - m.y;
  return { ...m, x: round5(m.x + mx), y: round5(m.y + my), ...(m.points ? { points: m.points.map(([px, py]) => [round5(px + mx), round5(py + my)]) } : {}) };
}
// Drag a corner to (x, y): the opposite corner stays, and dragging past it swaps the sides. No smaller than minW × minH.
export function resizeMask(m, corner, x, y, minW = 0, minH = 0) {
  const fixedX = corner.includes('w') ? m.x + m.w : m.x, fixedY = corner.includes('n') ? m.y + m.h : m.y;
  const side = (fixed, to, min) => {
    let end = clamp01(to);
    if (Math.abs(end - fixed) < min) end = fixed + (end >= fixed ? min : -min);
    if (end > 1) end = fixed - min; else if (end < 0) end = fixed + min;
    return [Math.min(fixed, end), Math.abs(end - fixed)];
  };
  const [nx, nw] = side(fixedX, x, minW), [ny, nh] = side(fixedY, y, minH);
  const out = { ...m, x: round5(nx), y: round5(ny), w: round5(nw), h: round5(nh) };
  if (m.points) out.points = m.points.map(([px, py]) => [round5(nx + (px - m.x) / m.w * nw), round5(ny + (py - m.y) / m.h * nh)]);
  return out;
}

// ---------- editing the list of boxes ----------
// The next free group number (never one used before: floor is the highest n the picture has ever had).
export const nextN = (masks, floor = 0) => Math.max(floor, 0, ...masks.map(m => m?.n).filter(Number.isInteger)) + 1;
// Put the masks with these ids into one group. It keeps the number of the FIRST id (the box picked first), or
// preferN when one of them has it: joining a new box to a reviewed card must not drop the reviewed card.
export function groupMasks(masks, ids, preferN = null) {
  const set = new Set(ids), mine = masks.filter(m => set.has(m?.id) && Number.isInteger(m.n));
  const first = ids.map(id => mine.find(m => m.id === id)).find(Boolean);
  const n = mine.some(m => m.n === preferN) ? preferN : first?.n;
  return Number.isInteger(n) ? masks.map(m => (set.has(m?.id) ? { ...m, n } : m)) : masks;
}
// Take one mask out of its group, into a group of its own.
export function splitMask(masks, id, floor = 0) {
  const n = nextN(masks, floor);
  return masks.map(m => (m?.id === id ? { ...m, n } : m));
}
export const deleteMasks = (masks, ids) => masks.filter(m => !ids.includes(m?.id));

// Undo and redo: { past, present, future }, at most 100 steps back.
export const newH = present => ({ past: [], present, future: [] });
export const pushH = (h, present) => ({ past: [...h.past, h.present].slice(-100), present, future: [] });
export const undoH = h => (h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1), future: [h.present, ...h.future] } : h);
export const redoH = h => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h);
