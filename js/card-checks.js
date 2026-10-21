// Tiny pure checks that db.js and study-data.js need at start-up. NO imports on purpose: the bigger files they came from
// (browse-logic.js, type-in.js, accept.js, occlusion.js) pull in a lot of code that nothing needs before Today is drawn.
// Those files re-export these names, so there is one copy of each rule and every other importer is unchanged.
// Tested through tests/occlusion.test.js, tests/match.test.js and tests/type-in.test.js.

// ---------- hidden cards (from browse-logic.js) ----------
export const isSuspended = card => !!card.suspended;
export const isBuried = (card, now = Date.now()) => !!card.buriedUntil && card.buriedUntil > now;
// Cards Review and Play should skip right now.
export const isHidden = (card, now = Date.now()) => isSuspended(card) || isBuried(card, now);

// ---------- typing cards (from type-in.js) ----------
// A card from a backup or another device: keep a boolean `typeIn`, drop anything else (same pattern as cleanAccept).
export function cleanTypeIn(card) {
  if (!card || !Object.hasOwn(card, 'typeIn') || typeof card.typeIn === 'boolean') return card;
  const { typeIn, ...rest } = card;
  return rest;
}

// ---------- accepted answers (from accept.js) ----------
export const ACCEPT_MAX = 10;
export const ACCEPT_LEN = 60;

// A card from a backup or another device: keep a good `acceptAnswers`, drop a bad one (the rest of the card is left alone).
// Same pattern as cleanMixedWith in db.js. An empty list is dropped too.
export function cleanAccept(card) {
  if (!card || !Object.hasOwn(card, 'acceptAnswers')) return card;
  const v = card.acceptAnswers;
  const good = Array.isArray(v) ? v.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim().slice(0, ACCEPT_LEN)).slice(0, ACCEPT_MAX) : [];
  const { acceptAnswers, ...rest } = card;
  return good.length ? { ...rest, acceptAnswers: good } : rest;
}

// ---------- image occlusion (from occlusion.js) ----------
export const MAX_MASKS = 300;     // boxes in one picture
export const MAX_POINTS = 200;    // corners of one polygon
export const SHAPES = ['rect', 'ellipse', 'polygon'];
const EPS = 1e-6;

export const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);

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
