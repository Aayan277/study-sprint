// Extra panels on the finish screens (Review and Play): leeches caught this session and pairs that got mixed up.
// Loaded lazily by the finish screen. Both panels are stubs until their batches land (2D leech coach, 2C pairs).

const leechPanel = (/* { leechIds } */) => '';
const pairsPanel = (/* { entries } */) => '';

// Fills `slot` with the panels, or hides it when there is nothing to show.
// source: 'review' | 'play'. cardIds: cards answered. leechIds: leeches hit. entries: Play's answer log.
export const drawFinishExtras = (slot, { source, cardIds = [], leechIds = [], entries = [] } = {}) => {
  if (!slot) return;
  // Cards can be deleted (or synced away) mid-session: panels must skip ids that no longer have a card, and a panel
  // that fails leaves the finish screen as it was.
  const safe = fn => { try { return fn() || ''; } catch (err) { console.warn('finish extras:', err); return ''; } };
  const html = safe(() => leechPanel({ source, leechIds })) + safe(() => pairsPanel({ source, cardIds, entries }));
  slot.innerHTML = html;
  slot.hidden = !html;
};
