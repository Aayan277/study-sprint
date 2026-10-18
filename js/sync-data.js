// Groundwork for syncing between devices. Pure functions (no database), tested by tests/sync.test.js.
// db.js uses them on every save, so each record says when it last changed, and deletions leave a marker.
//
// What's added to the saved data:
//   decks, cards, cardStates   updatedAt   when this record last changed (ms)
//   reviewLog                  uid         a random id that's the same on every device (the local id is only
//                                          a counter, so two devices would both have a row 1, row 2, ...)
//                              updatedAt   when it was saved
//   deleted (new store)        { key, store, id, deletedAt }: "this record was deleted", so other devices
//                                          delete their copy too instead of sending it back
//   settings '_times'          { setting: when it last changed } for the settings that sync

import { cleanFsrsParams, cleanIgnoreBefore } from './sched-settings.js';
import { isMarkKey, validMark } from './media-sweep.js';
import { acceptStatsLayout } from './stats-layout.js';

// The stores that sync, and which field is each record's id across devices.
export const SYNC_ID = { decks: 'id', cards: 'id', cardStates: 'cardId', reviewLog: 'uid' };

// Settings that follow you between devices. Theme, light/dark and screen choices stay per device.
export const SYNCED_SETTINGS = [
  'targetRetention', 'newPerDay', 'learningSteps', 'relearningSteps', 'maxInterval', 'fuzz',
  'leechThreshold', 'leechAction', 'reviewLimit', 'easyDays', 'restDays', 'idleDays', 'rescue', 'dailyGoal', 'playCountsAsReviews',
  'fsrsParams',         // your own FSRS weights from the optimizer (null = the standard ones); newest wins
  'ignoreBefore',       // 'YYYY-MM-DD' or null: the optimizer and health check ignore reviews before this day; newest wins
  'statsLayout',        // which Stats cards show, their order and width (js/stats-layout.js); null = the default; newest wins
  'fsrsVersion'         // 6 (FSRS-6, standard) or 7 (FSRS-7, beta); newest wins. Older app versions ignore it (docs/design/fsrs7-plan.md)
];
// Synced settings that are merged instead of "the newest copy wins": two devices that each add a day off
// keep both. restDays is { 'YYYY-MM-DD': { on, at } }, merged per day (mergeDayFlags in sync-merge.js).
export const MERGED_SETTINGS = ['restDays', 'idleDays'];
// idleDays is { 'YYYY-MM-DD': true }, a union (mergeIdleDays), pruned to 200 days.
// The glossary (js/glossary.js): each term is its own synced setting, "gloss:<id>", so the newest copy of each term wins.
// "mdel:<id>" marks a picture or sound for deletion from the account (media-sweep.js): a time, or null; newest wins.
export const isSyncedSetting = key => SYNCED_SETTINGS.includes(key) || (typeof key === 'string' && (key.startsWith('gloss:') || isMarkKey(key)));
export const SETTING_TIMES = '_times';

// A synced setting that came in from outside (the server or a backup): { ok: true, value } with the value cleaned, or
// { ok: false } when it is junk and must be ignored. fsrsParams is checked; null is a real value (the standard settings).
export function acceptSetting(key, value) {
  if (key === 'ignoreBefore') return value === null || value === undefined ? { ok: true, value: null } : cleanIgnoreBefore(value) ? { ok: true, value } : { ok: false };
  if (key === 'statsLayout') return acceptStatsLayout(value);
  if (key === 'fsrsVersion') return value === 6 || value === 7 ? { ok: true, value } : { ok: false };
  if (isMarkKey(key)) return validMark(value) ? { ok: true, value } : { ok: false };
  if (key !== 'fsrsParams') return { ok: true, value };
  if (value === null || value === undefined) return { ok: true, value: null };
  const clean = cleanFsrsParams(value);
  return clean ? { ok: true, value: clean } : { ok: false };
}

export function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// A record about to be saved by this device: mark when it changed. Review-log rows also get their uid.
export function stamp(storeName, value, now = Date.now()) {
  if (!(storeName in SYNC_ID)) return value;
  if (storeName === 'reviewLog') return { ...value, uid: value.uid || randomId(), updatedAt: now };
  return { ...value, updatedAt: now };
}

// The marker left behind when a record is deleted.
export const tombstoneKey = (storeName, id) => `${storeName}:${id}`;
export const tombstone = (storeName, id, now = Date.now()) => ({ key: tombstoneKey(storeName, id), store: storeName, id, deletedAt: now });

// Upgrading data saved before sync existed (database version 1 → 2), and restoring old backups:
// fill in what's missing, keeping anything already there.
//   decks and cards: changed when created; schedules: when last reviewed; logs: when answered
export function upgradeRecord(storeName, value, now = Date.now()) {
  if (storeName === 'reviewLog') {
    return { ...value, uid: value.uid || randomId(), updatedAt: value.updatedAt || value.timestamp || now };
  }
  if (!(storeName in SYNC_ID) || value.updatedAt) return value;
  const when = storeName === 'cardStates' ? value.lastReview : value.created;
  return { ...value, updatedAt: when > 0 && when <= now ? when : now };
}
