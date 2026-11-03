// RWKV lab: turning Study Sprint's review log into the 92 numbers the memory model reads for each review.
// Pure functions and one class; no DOM, no storage, no network. The rules follow the model's published description;
// how Study Sprint's own data maps onto them is written in docs/design/rwkv-lab.md.
import { rowKind } from './fsrs-data.js';
import { ROLLOVER_HOUR } from './days.js';
import { F, NORM, PERIODS, CODE_DIMS } from './rwkv-spec.js';

const DAY_MS = 86400000;
const TWO_PI = 2 * Math.PI;

// ---------- entity codes: a fixed random-looking vector per entity (our own hash, not the model authors') ----------
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// tag 'c' | 'n' | 'd' | 'p'; key e.g. 'c:abc'. -> array of 12 (card, note) or 8 (deck, preset) values in {-1.5,-0.5,0.5,1.5}
export function entityCode(tag, key) {
  const rand = mulberry32(fnv1a(tag + '|' + key));
  return Array.from({ length: CODE_DIMS[tag] }, () => Math.floor(rand() * 4) - 1.5);
}

// ---------- which day a time belongs to (new day at 4am local time) ----------
export function studyDay(t) {
  const d = new Date(t);
  const back = d.getHours() < ROLLOVER_HOUR ? 1 : 0;       // before 4am still belongs to yesterday
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() - back) / DAY_MS);
}

// ---------- rows for the model ----------
// logs: review-log rows; cards: [{ id, deckId, noteId }]; decks: [{ id, options? }]
// -> [{ logId, cardKey, noteKey, deckKey, presetKey, t, day, rating, ms, kind }] in time order
export function modelRows(logs, cards, decks) {
  const cardOf = new Map(cards.map(c => [c.id, c]));
  const ownPreset = new Set(decks.filter(d => d && d.options).map(d => d.id));
  const rows = [];
  for (const log of logs) {
    const kind = rowKind(log);
    if (kind !== 'train' && kind !== 'replay') continue;
    const card = cardOf.get(log.cardId);
    const cardKey = 'c:' + log.cardId;
    const row = {
      logId: log.id, cardKey, t: log.timestamp, day: studyDay(log.timestamp), rating: log.rating,
      ms: Math.min(600000, Math.max(0, Number.isFinite(log.ms) ? log.ms : 0)), kind
    };
    if (card) {
      row.noteKey = typeof card.noteId === 'string' && card.noteId !== '' ? 'n:' + card.noteId : cardKey;
      row.deckKey = 'd:' + card.deckId;
      row.presetKey = ownPreset.has(card.deckId) ? 'p:' + card.deckId : 'p:default';
    } else {
      row.noteKey = cardKey; row.deckKey = 'd:?'; row.presetKey = 'p:default';
    }
    rows.push(row);
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  rows.sort((a, b) => a.t - b.t || cmp(a.logId, b.logId));
  return rows;
}

// ---------- the feature builder ----------
const L = x => (x === -1 ? 0 : Math.log(1 + 1e-5 + x));       // the "first review" quirk: a value of exactly -1 counts as nothing
const scaled = (v, [mean, spread]) => (v - mean) / spread;
const cycle = (x, period) => { const m = ((x % period) + period) % period; return TWO_PI * m / period; };

export class FeatureBuilder {
  constructor() {
    this.firstDay = null;     // day of the user's first review
    this.prevDay = null;      // day of the user's previous review
    this.th = 0;              // reviews so far
    this.cumNew = 0;          // cards first reviewed so far
    this.today = { day: null, new: 0, reviews: 0 };
    this.cards = new Map();   // cardKey -> { prevT, prevDay, prevTh, cumNewAtPrev, sumDays, sumSecs, firstDay }
  }

  // seconds and days since this card's previous review (-1 / -1 for its first)
  elapsed(row) {
    const c = this.cards.get(row.cardKey);
    if (!c) return { seconds: -1, days: -1, first: true };
    return { seconds: Math.floor((row.t - c.prevT) / 1000 + 0.5), days: row.day - c.prevDay, first: false };
  }

  // Float32Array(92). Changes nothing. A query row ("the card is asked now") hides the answer: no rating, no time taken.
  features(row, isQuery = false) {
    const f = new Float32Array(F);
    const c = this.cards.get(row.cardKey);
    const e = this.elapsed(row);
    const firstDay = this.firstDay ?? row.day;
    const off = row.day - firstDay;
    const sumDays = (c ? c.sumDays : 0) + e.days, sumSecs = (c ? c.sumSecs : 0) + e.seconds;
    f[0] = scaled(L(e.days), NORM.days);
    f[1] = scaled(L(sumDays), NORM.daysCum);
    f[2] = scaled(L(e.seconds), NORM.secs);
    const a = cycle(e.seconds, 86400), b = cycle(sumSecs, 86400);
    f[3] = Math.sin(a); f[4] = Math.cos(a);
    f[5] = scaled(L(sumSecs), NORM.secsCum);
    f[6] = Math.sin(b); f[7] = Math.cos(b);
    if (!isQuery) {
      f[8] = scaled(Math.log(10 + row.ms), NORM.duration);
      f[8 + row.rating] = 1;
    }
    // 13..15: always 0
    const dayStep = this.prevDay === null ? 0 : row.day - this.prevDay;
    f[16] = Math.log(Math.log(Math.E + dayStep));
    f[17] = ((off % 7) - 3) / 3;
    const newSince = e.first ? 0 : this.cumNew - c.cumNewAtPrev;
    f[18] = scaled(Math.log(3 + newSince), NORM.newSince);
    const reviewsSince = e.first ? 0 : Math.max(0, (this.th + 1) - c.prevTh - 1);
    f[19] = scaled(Math.log(3 + reviewsSince), NORM.reviewsSince);
    const sameDay = this.today.day === row.day;
    f[20] = scaled(Math.log(3 + (sameDay ? this.today.new : 0) + (e.first ? 1 : 0)), NORM.newToday);
    f[21] = scaled(Math.log(3 + (sameDay ? this.today.reviews : 0)), NORM.reviewsToday);
    // 22 stays 0 (the model ignores it)
    f[23] = isQuery ? 1 : 0;
    let o = 24;
    for (const [tag, key] of [['c', row.cardKey], ['n', row.noteKey], ['d', row.deckKey], ['p', row.presetKey]]) {
      for (const v of entityCode(tag, key)) f[o++] = v;
    }
    const cardFirst = c ? c.firstDay - firstDay : off;
    for (const p of PERIODS) {
      const w = TWO_PI / p;
      f[o++] = Math.sin(w * (((off % p) + p) % p)); f[o++] = Math.cos(w * (((off % p) + p) % p));
      const q = ((cardFirst % p) + p) % p;
      f[o++] = Math.sin(w * q); f[o++] = Math.cos(w * q);
    }
    return f;
  }

  // Record that this review happened. Returns a token for undo().
  commit(row) {
    const c = this.cards.get(row.cardKey);
    const token = {
      key: row.cardKey, card: c ? { ...c } : null, firstDay: this.firstDay, prevDay: this.prevDay, th: this.th, cumNew: this.cumNew, today: { ...this.today }
    };
    const e = this.elapsed(row);
    if (this.firstDay === null) this.firstDay = row.day;
    if (this.today.day !== row.day) this.today = { day: row.day, new: 0, reviews: 0 };
    if (e.first) { this.cumNew++; this.today.new++; }
    this.today.reviews++;
    this.th++;
    this.prevDay = row.day;
    this.cards.set(row.cardKey, {
      prevT: row.t, prevDay: row.day, prevTh: this.th, cumNewAtPrev: this.cumNew,
      sumDays: (c ? c.sumDays : 0) + e.days, sumSecs: (c ? c.sumSecs : 0) + e.seconds, firstDay: c ? c.firstDay : row.day
    });
    return token;
  }

  undo(token) {
    if (token.card) this.cards.set(token.key, token.card); else this.cards.delete(token.key);
    this.firstDay = token.firstDay; this.prevDay = token.prevDay; this.th = token.th; this.cumNew = token.cumNew; this.today = token.today;
  }

  toJSON() {
    return { firstDay: this.firstDay, prevDay: this.prevDay, th: this.th, cumNew: this.cumNew, today: this.today, cards: [...this.cards] };
  }

  static fromJSON(j) {
    const b = new FeatureBuilder();
    b.firstDay = j.firstDay; b.prevDay = j.prevDay; b.th = j.th; b.cumNew = j.cumNew; b.today = j.today; b.cards = new Map(j.cards);
    return b;
  }
}
