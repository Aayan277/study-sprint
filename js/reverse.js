// Cards that work in both directions (item 5). A "pair" is two cards of one note: the forward card (front asks, back
// answers) and a reverse card (the back asks, the front answers). Each has its own schedule, so you can know a term
// but not its definition. They share a noteId, the same way the cards of a cloze note do, and the reverse one has
// `reverse: true`. Pure functions (no page, no database), tested by tests/reverse.test.js.
//
// The reverse card keeps a full ordinary front and back (the forward card's, swapped, with their pictures and
// sounds), like cloze cards do, so search, CSV, backups and older versions of the app all keep working.
//   Shared by both cards: deckId, tags, noteExtra, noteFields (edited together, saved together by db.saveNote)
//   Each card's own:      suspended, buriedUntil, flag and the schedule
// The queue needs nothing new: cards that share a noteId already show one a day (queue.js limitSiblings).

import { parseSteps } from './steps.js';
import { maskMath } from './math.js';

// Is this card one of a pair? (A card with a noteId that is not a cloze or image-occlusion card, nor one of the several cards an Anki note
// type with several card templates makes: those carry `templateOrd`, their Anki card number, and share a noteId only so Review shows
// one of them a day.)
export const isPair = card => !!card && typeof card.noteId === 'string' && card.noteId !== ''
  && card.cloze === undefined && !card.occlusion && card.noteText === undefined && card.templateOrd === undefined;

const hasSide = (text, image, sounds) => !!String(text ?? '').trim() || !!image || (Array.isArray(sounds) && sounds.length > 0);
// An elements card lists "Element 1: …" lines (like a step card's "Step 1: …").
const ELEMENTS = /^\s*Element\s+\d+\s*:/m;
export const isStructured = card => !!parseSteps(card.back, { mask: maskMath }) || ELEMENTS.test(String(card.back ?? ''));

// Can this card get a reverse card? Not cloze, image-occlusion, step-by-step or elements cards, and both sides need
// something on them (text, a picture or a sound).
export function canReverse(card) {
  if (!card || card.cloze !== undefined || card.noteText !== undefined || card.occlusion) return false;
  if (isStructured(card)) return false;
  return hasSide(card.front, card.frontImage, card.frontSounds) && hasSide(card.back, card.backImage, card.backSounds);
}

// A card's front and back, swapped (with their pictures and sounds). The fields a side doesn't have stay off.
export function swappedSides(card) {
  const out = { front: card.back ?? '', back: card.front ?? '' };
  const pairs = [['frontImage', 'backImage'], ['frontSounds', 'backSounds']];
  for (const [f, b] of pairs) {
    if (card[b]) out[f] = card[b];
    if (card[f]) out[b] = card[f];
  }
  return out;
}
const SIDE_FIELDS = ['front', 'back', 'frontImage', 'backImage', 'frontSounds', 'backSounds'];
const withoutSides = card => { const out = { ...card }; for (const k of SIDE_FIELDS) delete out[k]; return out; };

// The reverse card of a forward card. The new card starts new: no schedule. `id` is its id, `created` goes just after the
// forward card's, so the two sit side by side in the new-card order.
export function reverseOf(card, id, created = (card.created || 0) + 0.5) {
  const out = { ...withoutSides(card), ...swappedSides(card), id, created, reverse: true };
  for (const k of ['suspended', 'buriedUntil', 'flag', 'updatedAt', 'syncedAt', 'uid', 'typeIn']) delete out[k];      // the card's own state is not copied
  return out;
}

// Editing one card of a pair: `edits` are the changes to `card` (front, back, pictures, sounds…). Returns [card', partner']
// with the partner's sides rewritten to match (swapped), so one db.saveNote saves both.
export function pairPlan(card, partner, edits = {}) {
  const a = { ...card, ...edits };
  for (const k of ['frontImage', 'backImage', 'frontSounds', 'backSounds']) if (a[k] === null || a[k] === '' || (Array.isArray(a[k]) && !a[k].length)) delete a[k];
  if (Array.isArray(a.acceptAnswers) && !a.acceptAnswers.length) delete a.acceptAnswers;
  if (typeof a.typeIn !== 'boolean') delete a.typeIn;
  const b = { ...withoutSides(partner), ...swappedSides(a) };
  return [a, b];
}

// After a sync, the two cards of a pair can disagree (each device edited a different card). The one saved last wins and
// rewrites the other, the way cloze.js healNotes does for cloze notes: the newer noteEditedAt (the time the note was last
// edited; db.saveNote writes it on both cards) wins; cards saved before that existed compete by updatedAt; a tie goes to the
// forward card, so every device picks the same. The rewritten card gets the winner's noteEditedAt (never "now").
// A card whose partner is not there is left exactly as it is: the partner may be on its way (a split push, a card made offline),
// and a lone card with a noteId is harmless, because every place that reads a pair treats it as an ordinary card (loneIds below).
// Deleting a card on purpose turns its partner into an ordinary card at once (browse.js, leech-coach.js).
// A tie in noteEditedAt goes to the card saved last (updatedAt), then to the forward card.
// Returns the cards to save.
export function healPairs(cards) {
  const notes = new Map();
  for (const c of cards) if (isPair(c)) (notes.get(c.noteId) || notes.set(c.noteId, []).get(c.noteId)).push(c);
  const out = [];
  for (const members of notes.values()) {
    if (members.length === 1) continue;
    const fwd = members.filter(c => !c.reverse), rev = members.filter(c => c.reverse);
    if (fwd.length !== 1 || rev.length !== 1) continue;           // not a clean pair: leave it alone
    const [f] = fwd, [r] = rev;
    const sig = c => JSON.stringify([c.front || '', c.back || '', c.frontImage || '', c.backImage || '', c.frontSounds || [], c.backSounds || [], c.noteExtra || '', c.noteFields || []]);
    if (sig(f) === sig({ ...swappedSides(r), noteExtra: r.noteExtra, noteFields: r.noteFields })) continue;      // they agree
    const stamped = f.noteEditedAt !== undefined || r.noteEditedAt !== undefined;
    const time = c => (stamped ? c.noteEditedAt ?? -1 : c.updatedAt || 0);
    const win = time(r) > time(f) || (time(r) === time(f) && (r.updatedAt || 0) > (f.updatedAt || 0)) ? r : f, lose = win === f ? r : f;
    const fixed = { ...withoutSides(lose), ...swappedSides(win) };
    if (win.noteExtra) fixed.noteExtra = win.noteExtra; else delete fixed.noteExtra;
    if (win.noteFields?.length) fixed.noteFields = win.noteFields; else delete fixed.noteFields;
    if (win.noteEditedAt !== undefined) fixed.noteEditedAt = win.noteEditedAt;
    out.push(fixed);
  }
  return out;
}

// ---------- Play ----------
// Play asks a pair's cards in the direction each one stands for, so that with "Count Play answers as reviews" on, the
// right schedule is graded:
//   front → back and typing   the forward card (front asks); the reverse card sits out
//   back → front              the reverse card, asked front → back (its front is the forward card's back); the forward card sits out
// Returns the question type to use for this card in a round of `qtype`, or null when the card sits out.
export function playRole(card, qtype) {
  if (!isPair(card)) return qtype;          // (a card whose partner is missing is made ordinary first: see loneIds)
  if (qtype === 'back') return card.reverse ? 'front' : null;
  return card.reverse ? null : qtype;
}
// The cards of `cards` that take part in a round of `qtype`.
export const playPool = (cards, qtype) => cards.filter(c => playRole(c, qtype) !== null);

// ---------- the editor ----------
// The "Both directions" switch for the Add card and Edit card forms (inserted after the basic fields). p is the form's
// id prefix. The note under it shows instead while "Answer in steps" is on.
export function reverseSwitchHTML(p, { on = false, blocked = false } = {}) {
  return `<label class="adv-row switch-row rev-switch" id="${p}RevRow" ${blocked ? 'hidden' : ''}><span><b id="${p}RevLbl">Both directions</b>
        <span id="${p}RevHelp">Also asks the back and expects the front. Each direction has its own schedule; Review shows one of the two a day.</span></span>
        <input type="checkbox" class="switch" id="${p}RevOn" aria-labelledby="${p}RevLbl" aria-describedby="${p}RevHelp" ${on ? 'checked' : ''}></label>
      <p class="note" id="${p}RevNote" ${blocked ? '' : 'hidden'}>Step-by-step and elements cards can't be reversed.</p>`;
}

// ---------- other places that change cards ----------
// A card as an ordinary one again (its partner is gone).
export const unpaired = ({ noteId, reverse, noteEditedAt, templateOrd, ...rest }) => rest;

// Find and replace changes cards one at a time (browse-logic.js replaceInCards), which would leave a pair disagreeing, and
// healPairs can't fix that (both have the same noteEditedAt). This takes the changed cards and returns the cards to save: ordinary
// cards as they are, and for each pair with a change, both cards, the forward card holding the changes and the reverse card
// swapped to match. A change to the reverse card's front is a change to the forward card's back, and the other way round.
//   changed  the cards replaceInCards returned      all  every card, to find the partners
export function syncPairChanges(changed, all, now = Date.now()) {
  const byId = new Map(changed.map(c => [c.id, c]));
  const out = [], seen = new Set();
  for (const c of changed) {
    if (!isPair(c)) { out.push(c); continue; }
    if (seen.has(c.noteId)) continue;
    seen.add(c.noteId);
    const members = all.filter(x => isPair(x) && x.noteId === c.noteId);
    const f0 = members.find(x => !x.reverse), r0 = members.find(x => x.reverse);
    if (!f0 || !r0 || members.length !== 2) { out.push(c); continue; }        // not a clean pair: change the card as it is
    const f = { ...f0 };
    const fc = byId.get(f0.id), rc = byId.get(r0.id);
    if (fc) { if (fc.front !== f0.front) f.front = fc.front; if (fc.back !== f0.back) f.back = fc.back; }
    if (rc) { if (rc.front !== r0.front) f.back = rc.front; if (rc.back !== r0.back) f.front = rc.back; }
    const r = { ...r0, front: f.back, back: f.front };
    if (f.front !== f0.front || f.back !== f0.back) out.push({ ...f, noteEditedAt: now });
    if (r.front !== r0.front || r.back !== r0.back) out.push({ ...r, noteEditedAt: now });
  }
  return out;
}

// The ids of cards that carry a pair's noteId but have no partner (or that are not one clean pair): they behave as ordinary cards.
// Pass every card (not only the ones Play or Review can see: a suspended partner is still a partner).
export function loneIds(all) {
  const notes = new Map();
  for (const c of all) if (isPair(c)) (notes.get(c.noteId) || notes.set(c.noteId, []).get(c.noteId)).push(c);
  const out = new Set();
  for (const members of notes.values()) {
    const clean = members.length === 2 && members.filter(c => c.reverse).length === 1;
    if (!clean) members.forEach(c => out.add(c.id));
  }
  return out;
}
