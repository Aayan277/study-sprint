// Typing cards: which cards Review asks you to type the answer of, and which it flips. Pure functions (no page, no
// database), tested by tests/type-in.test.js. Review, Browse (the badge and filter) and Export all use answerMode.
//
// A card has its own `typeIn`: true (always type it), false (always flip it) or missing (follow the deck). A deck has
// `typeAnswers` (true, false or missing: inherit; see deck-tree.js effectiveDeck). Nothing is stamped onto cards when a
// deck changes: the default is applied when the card is read.

import { canType, TYPE_MAX } from './match.js';
import { answerText } from './format.js';
import { hasBlank } from './cloze.js';
import { hasMasks, occLabel } from './occlusion.js';
import { isStructured } from './reverse.js';
import { cleanTypeIn } from './card-checks.js';
export { cleanTypeIn };      // lives in card-checks.js (no imports) so db.js can load it at start-up

export const TYPE_HARD_MAX = 500;      // the answer box's maxlength: a longer answer can't be typed

// The card's own choice: true, false, or null (follows its deck). Anything else counts as unset.
export const ownTypeIn = card => (card?.typeIn === true || card?.typeIn === false ? card.typeIn : null);

// What decides whether a card can be typed: { structured, answer, picture }.
//   structured  a step-by-step or elements card (never typed)
//   picture     an image-occlusion card (the answer is the box's label)
//   answer      the plain text to type ('' when there is nothing to type)
export function typeFacts(card) {
  const picture = hasMasks(card);
  const structured = !hasBlank(card) && !picture && isStructured(card);
  const answer = picture ? answerText(occLabel(card.occlusion.masks, card.occlusion.n)) : answerText(card?.back);
  return { structured, answer: answer.trim(), picture };
}

// How Review asks this card. → { type, wanted, why }
//   type    true when the answer box shows
//   wanted  true when typing was asked for (by the card, its deck or the Today switch), even if the card can't be typed
//   why     when wanted but not typed: 'structured', 'nolabel', 'empty' or 'long'; when not wanted: 'card' (set to flip) or 'off'
export function answerMode(card, facts, deckDefault = false, session = false) {
  const own = ownTypeIn(card);
  const wanted = own === true || (own === null && !!(deckDefault || session));
  if (!wanted) return { type: false, wanted: false, why: own === false ? 'card' : 'off' };
  if (facts.structured) return { type: false, wanted, why: 'structured' };
  if (!facts.answer) return { type: false, wanted, why: facts.picture ? 'nolabel' : 'empty' };
  const fits = own === true ? facts.answer.length <= TYPE_HARD_MAX : canType(facts.answer);
  return fits ? { type: true, wanted, why: '' } : { type: false, wanted, why: 'long' };
}

// Is this a typing card by its own value and its deck's default (not the Today switch)? Browse's badge and Export use it.
export const isTypingCard = (card, deckDefault = false, facts = typeFacts(card)) => answerMode(card, facts, deckDefault, false).type;

// The cards `value` (true, false or null for "same as the deck") changes. A cloze or picture note changes all its cards;
// a reverse partner is not touched. Typing is not set on step-by-step or elements cards (counted in skipped).
// → { changed: [cards to save], skipped: number }
export function setTypeIn(selected, value, all = selected) {
  const noteIds = new Set(selected.filter(c => c.noteId && (c.cloze !== undefined || c.occlusion)).map(c => c.noteId));
  const ids = new Set(selected.map(c => c.id));
  const targets = [...selected, ...all.filter(c => noteIds.has(c.noteId) && !ids.has(c.id) && (c.cloze !== undefined || c.occlusion))];
  const changed = [];
  let skipped = 0;
  for (const c of targets) {
    if (value === true && typeFacts(c).structured) { skipped++; continue; }
    if (ownTypeIn(c) === value && (value !== null || !Object.hasOwn(c, 'typeIn'))) continue;
    if (value === null) { const { typeIn, ...rest } = c; changed.push(rest); } else changed.push({ ...c, typeIn: value });
  }
  return { changed, skipped };
}

// The note under the editor's "Answer by" choice. → text ('' for none)
//   kind        'basic', 'cloze' or 'occlusion'
//   value       true, false or null (the choice)
//   length      characters in the answer as typed (basic cards)
//   typeable    canType(answer): short enough to type (alternatives are judged one by one); follows length when not given
//   structured  Answer is Steps or Elements
//   deckDefault the deck types its short answers
//   both        a reverse card goes with this card
export function typeNote({ kind = 'basic', value = null, length = 0, typeable = length <= TYPE_MAX, structured = false, deckDefault = false, both = false } = {}) {
  if (structured) return 'Step-by-step and elements cards are always flipped.';
  if (kind === 'cloze') return 'You type the hidden words. Blanks with the same number are typed together, separated by commas.';
  if (kind === 'occlusion') return 'You type the label of the hidden box. Boxes without a label are flipped.';
  const parts = [];
  if (value === true && length > TYPE_HARD_MAX) parts.push('Too long to type: Review will flip this card.');
  else if (value === true && !typeable) parts.push("Long answer: you'll type all of it. Typing works best for a word or a short phrase.");
  else if (value === null && deckDefault && !typeable) parts.push(`The deck only types answers of ${TYPE_MAX} characters or less. Pick Typing the answer to type this one anyway.`);
  if (both) parts.push('Applies to this direction only.');
  return parts.join(' ');
}
