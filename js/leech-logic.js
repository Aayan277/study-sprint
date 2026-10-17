// Pure helpers for the leech coach (js/leech-coach.js); no DOM, tested by tests/leech-coach.test.js.

export const MAX_PARTS = 4;

// Split a back into 2 to 4 pieces on ";", line breaks and bullets (• · ▪ - – * and "1." numbering at a line start).
// Always returns at least 2 entries (padded with ''); more than 4 pieces: the extras join the last one.
export function splitBack(back) {
  const parts = String(back ?? '').split(/\r?\n|;/)
    .map(s => s.replace(/^\s*element\s*\d+\s*[:.)]\s*/i, '').replace(/^\s*(?:[•·▪●◦*\-–—]|\d+[.)])\s+/, '').trim())      // (an elements card's "Element 1:" lines lose their prefix)
    .filter(Boolean);
  while (parts.length > MAX_PARTS) { const last = parts.pop(); parts[parts.length - 1] += '; ' + last; }
  while (parts.length < 2) parts.push('');
  return parts;
}
// Can this card be split? Only a plain Basic card: a cloze note's cards, a note's cards and picture-occlusion cards have
// structure (the note text, the masks) that a split would lose.
export const canSplit = card => !(card.noteId || card.cloze || card.occlusion);
// The cards a split makes: same deck, the original's tags without "leech". rows: [{ front, back }], blank rows left out.
// The first new card also gets the original's back picture and memory hook (noteExtra), so nothing is lost when it is deleted.
export function splitCards(card, rows, { newId, now = Date.now() }) {
  const tags = (card.tags || []).filter(t => t !== 'leech');
  return rows.filter(r => r.front.trim() && r.back.trim()).map((r, i) => ({
    id: newId(), deckId: card.deckId, front: r.front.trim(), back: r.back.trim(), ...(card.frontImage ? { frontImage: card.frontImage } : {}),
    ...(i === 0 && card.backImage ? { backImage: card.backImage } : {}), ...(i === 0 && card.noteExtra ? { noteExtra: card.noteExtra } : {}),
    tags: [...tags], created: now + i
  }));
}
// The card as the editor should see it: no "leech" tag, so saving an edit can't hand the tag to a cloze note's siblings.
export const withoutLeechTag = card => ({ ...card, tags: (card.tags || []).filter(t => t !== 'leech') });
// "Forgotten 3 times"
export const forgottenText = n => `Forgotten ${n} ${n === 1 ? 'time' : 'times'}`;
// A leech that has been dealt with: back in reviews, schedule untouched.
export const unleeched = card => ({ ...card, suspended: false, tags: (card.tags || []).filter(t => t !== 'leech') });
export const parked = card => ({ ...card, suspended: true, tags: (card.tags || []).filter(t => t !== 'leech') });

