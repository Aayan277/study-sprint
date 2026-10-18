// Customise Stats: which cards the Stats page shows, in what order and how wide. Pure functions (no page, no database),
// tested by tests/stats-layout.test.js. The sheet that edits it is js/stats-layout-sheet.js; js/stats.js draws the page from it.
//
// The saved setting `statsLayout` (synced, newest wins) is { order: [ids], hidden: [ids], size: { id: 'half' | 'full' } }, or
// null for the default. normaliseLayout() cleans anything it is given: unknown ids are ignored, a card added by a later version
// shows up beside the card it follows in the default order, and a corrupt value gives the default.

// The cards, in their default order. size is the default width on a wide screen (a phone always shows every card full width).
// more: the card sits under "More stats" on a phone.
export const CARDS = [
  { id: 'streak', name: 'Day streak', size: 'half' },
  { id: 'retention', name: 'Retention', size: 'half' },
  { id: 'rs', name: 'Retention vs target', size: 'full' },
  { id: 'cal', name: 'Study calendar', size: 'full' },
  { id: 'perDay', name: 'Reviews per day', size: 'half' },
  { id: 'forecast', name: 'Due in the next 7 days', size: 'half' },
  { id: 'buttons', name: 'Answer buttons', size: 'half', more: true },
  { id: 'hours', name: 'Time of day', size: 'half', more: true },
  { id: 'difficulty', name: 'Difficulty', size: 'half', more: true },
  { id: 'hardest', name: 'Hardest cards', size: 'half' },
  { id: 'mastery', name: 'Mastery', size: 'full', more: true }
];
export const IDS = CARDS.map(c => c.id);
const BY_ID = new Map(CARDS.map(c => [c.id, c]));
export const cardInfo = id => BY_ID.get(id);
export const SIZES = ['half', 'full'];
const isSize = v => v === 'half' || v === 'full';

export function defaultLayout() {
  return { order: [...IDS], hidden: [], size: Object.fromEntries(CARDS.map(c => [c.id, c.size])) };
}

// Any value in, a complete clean layout out.
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
  if (raw.size && typeof raw.size === 'object') for (const id of IDS) if (isSize(raw.size[id])) out.size[id] = raw.size[id];
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
  return BY_ID.has(id) && isSize(size) ? { ...l, size: { ...l.size, [id]: size } } : l;
}
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

// A synced value from outside (sync, backup): { ok, value }. null is the default; anything else that is not an object is junk.
export function acceptStatsLayout(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  return { ok: true, value: toSaved(value) };
}
