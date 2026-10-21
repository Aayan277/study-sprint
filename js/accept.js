// "Accept this answer from now on": extra answers a card's typed check accepts (Play and typed Review).
// A card keeps them in `acceptAnswers`: up to 10 plain-text answers of up to 60 characters, for the card's back.
// Pure functions (no page, no database), tested by tests/match.test.js.

import { normalizeAnswer } from './match.js';

import { ACCEPT_MAX, ACCEPT_LEN, cleanAccept } from './card-checks.js';
export { ACCEPT_MAX, ACCEPT_LEN, cleanAccept };      // these live in card-checks.js (no imports) so db.js can load them at start-up

// The accepted answers a card has (a list of strings, however the card was saved).
export const acceptedOf = card => (Array.isArray(card?.acceptAnswers)
  ? card.acceptAnswers.filter(a => typeof a === 'string' && a.trim()).slice(0, ACCEPT_MAX).map(a => a.slice(0, ACCEPT_LEN)) : []);

// Every wording a typed answer to the card's back is checked against: the back's own wordings (given as `targets`) and then
// the accepted answers.
export const withAccepted = (targets, card) => [...targets, ...acceptedOf(card)];

// Can this typed text be added to the card? It must be 1 to 60 characters, not accepted yet, and there must be room.
export function canAccept(card, typed) {
  const t = String(typed ?? '').trim();
  if (!t || t.length > ACCEPT_LEN) return false;
  const have = acceptedOf(card);
  if (have.length >= ACCEPT_MAX) return false;
  const key = normalizeAnswer(t);
  return !have.some(a => normalizeAnswer(a) === key);
}

// The card with the typed text added, or the same card when it can't be (see canAccept).
export function addAccepted(card, typed) {
  if (!canAccept(card, typed)) return card;
  return { ...card, acceptAnswers: [...acceptedOf(card), String(typed).trim()] };
}

// Editor text "a, b, c" → a clean list (no blanks or repeats, 60 characters each, at most 10).
export function parseAccepted(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text ?? '').split(/[,\n]/)) {
    const t = raw.trim().slice(0, ACCEPT_LEN).trim(), k = normalizeAnswer(t);
    if (!t || seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length >= ACCEPT_MAX) break;
  }
  return out;
}
