// What the Practice test remembers (the rules for it are in mock-exam-logic.js).
//   the test in progress   localStorage, written at every change (it is synchronous, so a reload right after an answer keeps it)
//   last choices per deck, results history   the settings "testPrefs" and "testHistory": kept on this device and in backup
//                          files, but not synced (see PLAN.md, v4.37: two devices would overwrite each other's lists)
// Every storage call is wrapped: private windows and blocked storage must not break the test (it just can't be resumed).

import * as db from './db.js';
import { parseRun, cleanPrefs, cleanHistory, cleanCfg, addResult } from './mock-exam-logic.js';

const RUN = 'study-sprint-test-run', STATE = 'study-sprint-test-state';

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };

// The saved test { run, state }, or null. A finished one is kept (state.done) until another test starts, so a reload on the results
// screen shows them again.
export const loadSaved = (now = Date.now()) => parseRun(read(RUN), read(STATE), now);
// A test that is still being taken for this deck (not one that is finished).
export const inProgress = (deckId, now = Date.now()) => { const s = loadSaved(now); return s && !s.state.done && (!deckId || s.run.deckId === deckId) ? s : null; };
export function saveRun(run, state) { return write(RUN, JSON.stringify(run)) && write(STATE, JSON.stringify(state)); }
export const saveState = state => write(STATE, JSON.stringify(state));
export function clearSaved() { try { localStorage.removeItem(RUN); localStorage.removeItem(STATE); } catch { /* nothing to clear */ } }

// Last choices for a deck (the default choices when it has none yet).
export async function prefsFor(deckId) {
  const all = cleanPrefs((await db.getSettings()).testPrefs);
  return cleanCfg(all[deckId]);
}
export async function savePrefs(deckId, cfg) {
  const all = cleanPrefs((await db.getSettings()).testPrefs);
  all[deckId] = cleanCfg(cfg);
  await db.setSetting('testPrefs', all);
}
export async function getHistory() { return cleanHistory((await db.getSettings()).testHistory); }
export async function saveResult(deckId, result) { await db.setSetting('testHistory', addResult((await db.getSettings()).testHistory, deckId, result)); }
