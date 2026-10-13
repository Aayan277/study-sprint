// In-memory stand-in for js/db.js: only what study-data.js loadAll() (and the harness) needs.
// Same return shapes as the IndexedDB versions: arrays of plain records, logs sorted by time.
export const S = { settings: {}, decks: [], cards: new Map(), states: new Map(), logs: [], logsByCard: new Map() };

export const DEFAULT_SETTINGS = {
  targetRetention: 0.9, newPerDay: 20, learningSteps: '1m 10m', relearningSteps: '10m', maxInterval: 36500, fuzz: true,
  leechThreshold: 8, leechAction: 'suspend', reviewLimit: null,
  easyDays: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal'], extraNew: null
};

export function reset(settings = {}) {
  S.settings = { ...DEFAULT_SETTINGS, ...settings };
  S.decks = []; S.cards = new Map(); S.states = new Map(); S.logs = []; S.logsByCard = new Map();
}

export async function getSettings() { return { ...S.settings }; }
export async function getDecks() { return S.decks.map(d => ({ ...d })); }
export async function getAll(name) {
  if (name === 'cards') return [...S.cards.values()];
  if (name === 'cardStates') return [...S.states.values()];
  if (name === 'decks') return getDecks();
  throw new Error('memdb: ' + name);
}
export async function get(name, key) { return name === 'cards' ? S.cards.get(key) : name === 'cardStates' ? S.states.get(key) : undefined; }
// Logs are appended in time order, so a binary search finds the start.
export async function getLogsSince(ts) {
  let lo = 0, hi = S.logs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (S.logs[m].timestamp < ts) lo = m + 1; else hi = m; }
  return S.logs.slice(lo);
}
export async function getCardLogs(id) { return (S.logsByCard.get(id) || []).slice(); }
export function addLogSync(log) {
  S.logs.push(log);
  if (!S.logsByCard.has(log.cardId)) S.logsByCard.set(log.cardId, []);
  S.logsByCard.get(log.cardId).push(log);
}
export async function addLog(log) { addLogSync(log); }
export async function saveReview(state, log) { S.states.set(state.cardId, state); addLogSync(log); return S.logs.length; }
export async function putStates(states) { for (const s of states) S.states.set(s.cardId, s); }
export async function saveCards(cards) { for (const c of cards) S.cards.set(c.id, c); }
let v = 0;
export const scheduleVersion = () => v;
