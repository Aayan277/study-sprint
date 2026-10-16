// Pure helpers for the leech coach (js/leech-coach.js); no DOM, tested by tests/leech-coach.test.js.

export const MAX_PARTS = 4;

// Split a back into 2 to 4 pieces on ";", line breaks and bullets (• · ▪ - – * and "1." numbering at a line start).
// Always returns at least 2 entries (padded with ''); more than 4 pieces: the extras join the last one.
export function splitBack(back) {
  const parts = String(back ?? '').split(/\r?\n|;/)
    .map(s => s.replace(/^\s*(?:[•·▪●◦*\-–—]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
  while (parts.length > MAX_PARTS) { const last = parts.pop(); parts[parts.length - 1] += '; ' + last; }
  while (parts.length < 2) parts.push('');
  return parts;
}
// The cards a split makes: same deck, the original's tags without "leech". rows: [{ front, back }], blank rows left out.
export function splitCards(card, rows, { newId, now = Date.now() }) {
  const tags = (card.tags || []).filter(t => t !== 'leech');
  return rows.filter(r => r.front.trim() && r.back.trim()).map((r, i) => ({
    id: newId(), deckId: card.deckId, front: r.front.trim(), back: r.back.trim(), ...(card.frontImage ? { frontImage: card.frontImage } : {}),
    tags: [...tags], created: now + i
  }));
}
// A leech that has been dealt with: back in reviews, schedule untouched.
export const unleeched = card => ({ ...card, suspended: false, tags: (card.tags || []).filter(t => t !== 'leech') });
export const parked = card => ({ ...card, suspended: true, tags: (card.tags || []).filter(t => t !== 'leech') });

