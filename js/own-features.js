// Own model: turning Study Sprint's review log into the 18 numbers the model reads for each answer.
// Pure functions and one class; no DOM, no storage, no network. Design: docs/design/own-model.md.
//
// Numbers 0 to 11 are CONTEXT: they are known before you answer, and the prediction may read only these.
// Numbers 12 to 17 are OUTCOME: which button, how long, whether it was a Play replay. Only the memory update reads them.
// Rows are the ones modelRows() makes. A row may also carry two overrides for data that has no wall clock:
//   row.day     the study-day number to use instead of studyDay(row.t)
//   row.gapSec  seconds since this card's previous answer, instead of (row.t - previous t) / 1000
// The app's own rows never set them, so in the app everything comes from timestamps.
import { modelRows, studyDay, fnv1a } from './rwkv-features.js';
import { F, F_CONTEXT } from './own-spec.js';

export { modelRows, studyDay, fnv1a, F, F_CONTEXT };

const DAY_MS = 86400000;
const L = x => Math.log1p(x > 0 ? x : 0);
const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const dayOf = row => (Number.isFinite(row.day) ? row.day : studyDay(row.t));
const copy = o => (o ? { ...o } : o);

export class OwnFeatures {
  constructor() {
    this.cards = new Map();   // cardKey -> { prevT, prevDay, firstDay, answers, lapses }
    this.notes = new Map();   // noteKey -> time of its last answer (ms)
    this.decks = new Map();   // deckKey -> time of its last answer
    this.userT = null;        // time of your last answer
    this.today = { day: null, answers: 0, again: 0, newCards: 0 };
  }

  // Days (fractional) since the last answer of this card, note, deck and you; null where there was none. Changes nothing.
  gaps(row) {
    const c = this.cards.get(row.cardKey);
    const since = last => (last === undefined || last === null ? null : Math.max(0, (row.t - last) / DAY_MS));
    let card = null;
    if (c) card = Number.isFinite(row.gapSec) ? Math.max(0, row.gapSec) / 86400 : Math.max(0, (row.t - c.prevT) / DAY_MS);
    return { card, note: since(this.notes.get(row.noteKey)), deck: since(this.decks.get(row.deckKey)), user: since(this.userT) };
  }

  // Float32Array(18). Changes nothing. A query row ("the card is asked now") hides the answer: outcome numbers stay 0.
  features(row, isQuery = false) {
    const f = new Float32Array(F);
    const c = this.cards.get(row.cardKey);
    const day = dayOf(row);
    const g = this.gaps(row);
    f[0] = c ? L(g.card) / 5 : 0;
    f[1] = c ? 0 : 1;
    f[2] = c && c.prevDay === day ? 1 : 0;
    f[3] = g.note === null ? 0 : L(g.note) / 5;
    f[4] = g.deck === null ? 0 : L(g.deck) / 5;
    f[5] = g.user === null ? 0 : L(g.user) / 5;
    f[6] = L(c ? c.answers : 0) / 3;
    f[7] = L(c ? c.lapses : 0) / 2;
    f[8] = c ? L(day - c.firstDay) / 6 : 0;
    const t = this.today.day === day ? this.today : null;
    f[9] = L(t ? t.answers : 0) / 4;
    f[10] = t && t.answers > 0 ? t.again / t.answers : 0;
    f[11] = L(t ? t.newCards : 0) / 3;
    if (!isQuery) {
      f[11 + row.rating] = 1;                                                   // 12..15: Again, Hard, Good, Easy
      f[16] = clip(Math.log(Math.max(1, Number.isFinite(row.ms) ? row.ms : 8000) / 8000), -3, 3) / 3;
      f[17] = row.kind === 'replay' ? 1 : 0;
    }
    return f;
  }

  // Record that this answer happened. Returns a token for undo().
  commit(row) {
    const day = dayOf(row);
    const c = this.cards.get(row.cardKey);
    const token = {
      card: copy(c), cardKey: row.cardKey,
      noteKey: row.noteKey, note: this.notes.get(row.noteKey),
      deckKey: row.deckKey, deck: this.decks.get(row.deckKey),
      userT: this.userT, today: { ...this.today }
    };
    if (this.today.day !== day) this.today = { day, answers: 0, again: 0, newCards: 0 };
    if (!c) this.today.newCards++;
    this.today.answers++;
    if (row.rating === 1) this.today.again++;
    this.cards.set(row.cardKey, {
      prevT: row.t, prevDay: day, firstDay: c ? c.firstDay : day,
      answers: (c ? c.answers : 0) + 1, lapses: (c ? c.lapses : 0) + (row.rating === 1 ? 1 : 0)
    });
    this.notes.set(row.noteKey, row.t);
    this.decks.set(row.deckKey, row.t);
    this.userT = row.t;
    return token;
  }

  undo(token) {
    if (token.card) this.cards.set(token.cardKey, token.card); else this.cards.delete(token.cardKey);
    if (token.note === undefined) this.notes.delete(token.noteKey); else this.notes.set(token.noteKey, token.note);
    if (token.deck === undefined) this.decks.delete(token.deckKey); else this.decks.set(token.deckKey, token.deck);
    this.userT = token.userT;
    this.today = { ...token.today };
  }

  toJSON() {
    return { cards: [...this.cards], notes: [...this.notes], decks: [...this.decks], userT: this.userT, today: this.today };
  }

  static fromJSON(j) {
    const b = new OwnFeatures();
    b.cards = new Map(j.cards); b.notes = new Map(j.notes); b.decks = new Map(j.decks); b.userT = j.userT; b.today = { ...j.today };
    return b;
  }
}
