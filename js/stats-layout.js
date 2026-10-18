// Customise Stats: which cards the Stats page shows, in what order and how wide. Pure functions (no page, no database),
// tested by tests/stats-layout.test.js. The sheet that edits it is js/stats-layout-sheet.js; js/stats.js draws the page from it.
//
// The saved setting `statsLayout` (synced, newest wins) is { order: [ids], hidden: [ids], size: { id: 'half' | 'full' } }, or
// null for the default. normaliseLayout() cleans anything it is given: unknown ids are ignored, a card added by a later version
// shows up beside the card it follows in the default order, and a corrupt value gives the default.

// The cards, in their default order. size is the default width on a wide screen (a phone always shows every card full width).
// sizes: the widths the card really works at (checked at 1024, 1280, 1440 and 1920 wide, in both styles). A card that lists only
// 'full' has no size control anywhere and always shows full width: the Study calendar needs the whole row to show its year (a half
// card drops the older weeks), and Retention vs target is a three-column table whose labels and tracks do not fit in half a row.
// desc: the line shown in "Add widget". more: on a phone the cards of this kind that come after the last other card sit under
// "More stats" (a fold); the default order has Hardest cards before them, so the default phone page keeps its fold.
const BOTH = ['half', 'full'];
export const CARDS = [
  { id: 'streak', name: 'Day streak', size: 'half', sizes: BOTH, desc: 'How many days in a row you have studied, with this week.' },
  { id: 'retention', name: 'Retention', size: 'half', sizes: BOTH, desc: 'How often you remembered cards in the last 30 days.' },
  { id: 'rs', name: 'Retention vs target', size: 'full', sizes: ['full'], desc: 'Young and mature cards against your retention target.' },
  { id: 'cal', name: 'Study calendar', size: 'full', sizes: ['full'], desc: 'A year of study days as a grid of squares.' },
  { id: 'perDay', name: 'Reviews per day', size: 'half', sizes: BOTH, desc: 'Answers per day over the last 30 days.' },
  { id: 'forecast', name: 'Due in the next 7 days', size: 'half', sizes: BOTH, desc: 'How many cards come due each day this week.' },
  { id: 'hardest', name: 'Hardest cards', size: 'half', sizes: BOTH, desc: 'The cards you forget most, with a way to review them.' },
  { id: 'buttons', name: 'Answer buttons', size: 'half', sizes: BOTH, more: true, desc: 'How often you press Again, Hard, Good and Easy.' },
  { id: 'hours', name: 'Time of day', size: 'half', sizes: BOTH, more: true, desc: 'When in the day you study and how well it goes.' },
  { id: 'difficulty', name: 'Difficulty', size: 'half', sizes: BOTH, more: true, desc: 'How hard your studied cards are, from easy to hard.' },
  { id: 'mastery', name: 'Mastery', size: 'full', sizes: BOTH, more: true, desc: 'Every card as a square, coloured by how well you know it.' }
];
export const IDS = CARDS.map(c => c.id);
const BY_ID = new Map(CARDS.map(c => [c.id, c]));
export const cardInfo = id => BY_ID.get(id);
export const SIZES = ['half', 'full'];
const isSize = v => v === 'half' || v === 'full';
// Can this card be made half or full width? Only a card that works at both has a size control.
export const canResize = id => (BY_ID.get(id)?.sizes.length || 0) > 1;
const allowed = (id, size) => isSize(size) && !!BY_ID.get(id)?.sizes.includes(size);

export function defaultLayout() {
  return { order: [...IDS], hidden: [], size: Object.fromEntries(CARDS.map(c => [c.id, c.size])) };
}

// Any value in, a complete clean layout out.
// (Versions: an older device that receives a layout with ids it does not know drops them, and its next save sends the shorter
// list back, so a card added by a newer version can lose its place in the order. Its hidden/size choice is lost the same way.)
export function normaliseLayout(raw) {
  const out = defaultLayout();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  // Order: the saved ids that exist (each once), then each missing card right after the card before it in the default order.
  const seen = new Set();
  const order = Array.isArray(raw.order) ? raw.order.filter(id => typeof id === 'string' && BY_ID.has(id) && !seen.has(id) && seen.add(id)) : [];
  for (let i = 0; i < IDS.length; i++) {
    const id = IDS[i];
    if (seen.has(id)) continue;
    const prev = i ? order.indexOf(IDS[i - 1]) : -1;       // (the card before it is already in `order`, saved or just added)
    order.splice(prev + 1, 0, id);
    seen.add(id);
  }
  out.order = order;
  if (Array.isArray(raw.hidden)) out.hidden = order.filter(id => raw.hidden.includes(id));
  if (raw.size && typeof raw.size === 'object') for (const id of IDS) if (allowed(id, raw.size[id])) out.size[id] = raw.size[id];
  return out;
}

export function isDefaultLayout(layout) {
  const l = normaliseLayout(layout), d = defaultLayout();
  return l.order.join() === d.order.join() && !l.hidden.length && IDS.every(id => l.size[id] === d.size[id]);
}

// What to save: null for the default, so a reset is one small value.
export const toSaved = layout => (isDefaultLayout(layout) ? null : normaliseLayout(layout));

// The changes. Each returns a new layout and leaves its input alone.
export function moveCard(layout, id, dir) {
  const l = normaliseLayout(layout), i = l.order.indexOf(id), j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= l.order.length) return l;
  const order = [...l.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { ...l, order };
}
export function setHidden(layout, id, hide) {
  const l = normaliseLayout(layout);
  if (!BY_ID.has(id)) return l;
  return { ...l, hidden: l.order.filter(x => (x === id ? !!hide : l.hidden.includes(x))) };
}
export function setSize(layout, id, size) {
  const l = normaliseLayout(layout);
  return allowed(id, size) ? { ...l, size: { ...l.size, [id]: size } } : l;
}
// Drag and drop: `ids` is the new order of the cards that are shown. The hidden cards keep their places in the saved order and the
// shown ones fill the other places in the new order. Anything that is not exactly the shown cards leaves the layout alone.
export function reorderVisible(layout, ids) {
  const l = normaliseLayout(layout), shown = l.order.filter(id => !l.hidden.includes(id));
  if (ids.length !== shown.length || new Set(ids).size !== ids.length || !ids.every(id => shown.includes(id))) return l;
  let k = 0;
  return { ...l, order: l.order.map(id => (l.hidden.includes(id) ? id : ids[k++])) };
}
// "Add widget": a hidden card comes back at the end of the page.
export function addWidget(layout, id) {
  const l = normaliseLayout(layout);
  if (!BY_ID.has(id)) return l;
  return { ...l, order: [...l.order.filter(x => x !== id), id], hidden: l.hidden.filter(x => x !== id) };
}
export const hiddenCards = layout => normaliseLayout(layout).hidden.map(id => BY_ID.get(id));
export const resetLayout = () => defaultLayout();

// The cards shown, in order (skip: ids the page places itself).
export function visibleOrder(layout, skip = []) {
  const l = normaliseLayout(layout);
  return l.order.filter(id => !l.hidden.includes(id) && !skip.includes(id));
}

// Pairing on a wide screen (two columns). Two half cards that follow each other share a row; a half card with no half card
// beside it takes the whole row, so there is never a hole. Returns rows of ids: [[a, b], [c], ...]. A row of two is half
// width each; a row of one is full width.
export function pairRows(layout, ids = visibleOrder(layout)) {
  const l = normaliseLayout(layout), rows = [];
  for (let i = 0; i < ids.length; i++) {
    if (l.size[ids[i]] === 'half' && i + 1 < ids.length && l.size[ids[i + 1]] === 'half') { rows.push([ids[i], ids[i + 1]]); i++; }
    else rows.push([ids[i]]);
  }
  return rows;
}
// The width each card really gets on a wide screen: id → 'half' | 'full'.
export function widths(layout, ids) {
  const w = new Map();
  for (const row of pairRows(layout, ids)) for (const id of row) w.set(id, row.length === 2 ? 'half' : 'full');
  return w;
}

// The true grid while editing: id → { w: 'half' | 'full', lone }. A half card with no half partner stays half width (lone: true) and the
// page shows an empty slot beside it, so the size button visibly does something. Outside editing it stretches (see widths()).
export function editPlan(layout, ids) {
  const plan = new Map();
  for (const row of pairRows(layout, ids)) for (const id of row) {
    const half = row.length === 2 || normaliseLayout(layout).size[id] === 'half';
    plan.set(id, { w: half ? 'half' : 'full', lone: row.length === 1 && half });
  }
  return plan;
}

// A synced value from outside (sync, backup): { ok, value }. null is the default; anything else that is not an object is junk.
export function acceptStatsLayout(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  return { ok: true, value: toSaved(value) };
}
