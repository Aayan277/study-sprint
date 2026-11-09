import './own-utc.mjs';
import { studyDay } from '../js/own-features.js';

export const DAY = 86400000;
export const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
export const mk = (card, note, deck, t, rating, ms = 8000, extra = {}) =>
  ({ logId: t + card, cardKey: 'c:' + card, noteKey: note ? 'n:' + note : 'c:' + card, deckKey: 'd:' + deck, presetKey: 'p:default', t, day: studyDay(t), rating, ms, kind: 'train', ...extra });

// 3 cards, 2 decks: cards 1 and 2 are two sides of note 1 (deck 1); card 3 is alone in deck 2. Same-day repeats, gaps of days.
export const miniRows = () => [
  mk(1, 1, 1, T0, 3, 9000), mk(2, 1, 1, T0 + 60e3, 1, 14000), mk(3, null, 2, T0 + 120e3, 4, 3000),
  mk(1, 1, 1, T0 + 600e3, 2, 12000), mk(2, 1, 1, T0 + 900e3, 3, 7000), mk(3, null, 2, T0 + 2 * 3600e3, 3, 5000),
  mk(1, 1, 1, T0 + DAY, 3, 6000), mk(3, null, 2, T0 + DAY + 100e3, 1, 20000), mk(2, 1, 1, T0 + DAY + 200e3, 3, 8000),
  mk(3, null, 2, T0 + DAY + 3600e3, 2, 9000), mk(1, 1, 1, T0 + 4 * DAY, 4, 2500), mk(2, 1, 1, T0 + 4 * DAY + 50e3, 1, 30000),
  mk(3, null, 2, T0 + 4 * DAY + 90e3, 3, 8000), mk(1, 1, 1, T0 + 9 * DAY, 3, 7000), mk(2, 1, 1, T0 + 9 * DAY + 60e3, 3, 8500)
];
