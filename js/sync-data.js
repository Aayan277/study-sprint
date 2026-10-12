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

// The stores that sync, and which field is each record's id across devices.
export const SYNC_ID = { decks: 'id', cards: 'id', cardStates: 'cardId', reviewLog: 'uid' };

// Settings that follow you between devices. Theme, light/dark and screen choices stay per device.
export const SYNCED_SETTINGS = [
  'targetRetention', 'newPerDay', 'learningSteps', 'relearningSteps', 'maxInterval', 'fuzz',
  'leechThreshold', 'leechAction', 'reviewLimit', 'easyDays'
];
export const SETTING_TIMES = '_times';

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
