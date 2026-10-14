// Extra panels on the finish screens (Review and Play): leeches caught this session and pairs that got mixed up.
// Loaded lazily by the finish screen. Both panels are stubs until their batches land (2D leech coach, 2C pairs).

const leechPanel = (/* { leechIds } */) => '';
const pairsPanel = (/* { entries } */) => '';

// Fills `slot` with the panels, or hides it when there is nothing to show.
// source: 'review' | 'play'. cardIds: cards answered. leechIds: leeches hit. entries: Play's answer log.
export const drawFinishExtras = (slot, { source, cardIds = [], leechIds = [], entries = [] } = {}) => {
  if (!slot) return;
  const html = leechPanel({ source, leechIds }) + pairsPanel({ source, cardIds, entries });
  slot.innerHTML = html;
  slot.hidden = !html;
};
