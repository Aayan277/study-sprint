# "Recently deleted" for 30 days: design plan (not implemented)

## 0. How deleting works today

**Cards** (`deleteCards`, db.js:608). Each card goes through `deleteCardIn` (db.js:451-464). It removes the card row, its `cardStates` row (`deleteStateIn`, 466-477) and every `reviewLog` row for it, all in one transaction. Each removed row leaves a delete marker in the local `deleted` store: `{key, store, id, deletedAt}` (sync-data.js `tombstone`; `markDeleted`, db.js:256). Review rows are marked by `uid`. The removed rows are collected in a snapshot `{decks, cards, cardStates, reviewLog}`, returned to the caller and kept only in memory.

**Decks** (`deleteDeck`, db.js:379-397). Removes the deck row and runs `deleteCardIn` for each of its cards, in one transaction.
- "Delete everything" (decks.js:731-735) calls `deleteDeck` once per deck in the tree. Each call is its own transaction with its own `now`, and the snapshots are joined with `mergeSnapshots`.
- "Delete, keep subdecks" (decks.js:736-742) first moves the child decks up a level, then pushes their old rows into `snap.decks` so Undo can put them back inside.

**Undo** is a 10-second toast (`undoOpts`, ui.js:74). It calls `restoreSnapshot` (db.js:416-446): rows go back stamped `updatedAt = now` and the local delete markers are removed, so the restore beats the delete on every device. Cards whose deck is gone are skipped without a word.
- Places that use it: browse.js:646-649 (`deleted()`), :657-658 (pair delete), :826-835 (bulk delete), decks.js:719-742, leech-coach.js:26-33, :113 and :204 (split).
- `holdMedia` (db.js:413) stops `cleanMedia` for 2 minutes so the Undo still finds its pictures.

**Import Undo** (`undoImport`, db.js:321-365, called from import-screen.js:1552-1560) deletes what the import added (with delete markers) and puts back the rows it changed. It keeps no snapshot of what it deleted.

**Other deletes with no Undo:**
- `saveNote({remove})`: a cloze blank removed, or "Remove reverse card" (browse.js:628).
- `deleteEverything` (db.js:1011), `resetAll` (db.js:721) and `importAll` (db.js:941).
- card-editor.js deletes no cards. It only takes pictures and sounds off a card.

**Sync.**
- Delete markers are pushed as `{deleted: true, data: null}` (`rowFromTombstone`, sync-merge.js). Deletes are sent first (sync-push.js `pushSafely`).
- Pulling uses `decide()` (sync-merge.js:83): a row wins only if it is newer than the later of the local copy and the local delete marker. Applied in `applyRemote`, db.js:1176-1187.
- The server keeps the newer row only (setup.sql:60-63, `<=` is ignored) and caps `updated_at` at server time + 1 day. The server keeps delete rows as empty data, so the content of deleted rows exists only on the device that deleted them.

**Review history and schedules of deleted cards.** They are physically removed and marked deleted on every device. Today they survive only in the in-memory Undo snapshot. The snapshot keeps the review rows' local `id`, which matters for the Own model (see 5g).

**Pictures and sounds.**
- `cleanMedia` (db.js:1363-1380) removes local files no card in the `cards` store uses, once they are an hour old.
- When signed in, `sweepMedia` (sync.js:547-569) marks dropped files with `mdel:<id>`. Any device sweeps a file after it has been marked 30 days, unless some device's cards use it, which un-marks it (media-sweep.js `planSweep`).
- `reupload` covers the case where the account lost a file that a card here still uses and this device holds.

## 1. What is kept, and where

**Recommended: a separate small IndexedDB database, `study-sprint-trash`.** This follows the Own model's precedent (own-db.js:8, its own database that is never synced or backed up).
- No `DB_VERSION` bump in the main database (db.js:21 stays 3).
- Older app copies simply ignore it.
- Easy to undo: delete the database and the feature is gone, with the main data untouched.
- The main database's format does not change at all.

Stores:
- `entries` (key `id`). One row per delete action: `{ id, kind: 'cards'|'deck', title, deckId, deckPath, counts: {cards, reviews}, deletedAt, settledAt, userId|null, mediaIds: [...], bytes, parts }`. The Recently deleted list reads only this store.
- `parts` (key `[entryId, n]`). The snapshot rows in pieces of about 2,000 rows, split into `gone: {decks, cards, cardStates, reviewLog}` and `before: {decks, cards}`.
  - `gone` holds rows the delete really removed.
  - `before` holds rows the delete only changed: the partner that was unpaired at browse.js:658 or leech-coach.js:28-31, and the subdecks moved up at decks.js:737-740.
  - Today these are mixed into `snap.cards` / `snap.decks`. A late restore must treat them differently (see 2).

Order of writes: the main-database delete runs exactly as today, then the entry is written. Two databases cannot share one transaction. If the app dies between the two writes, the item is deleted with no entry, which is exactly today's behaviour, so nothing is lost compared with now.

**Alternative (owner's choice): a `trash` store in the main database, `DB_VERSION` 3 → 4.**
- Gain: the delete and the entry are saved in one transaction.
- Hard to undo: once a phone has opened version 4, any older app copy fails `indexedDB.open(name, 3)` with VersionError. A rollback release would then have to keep version 4 forever. An old tab that is still open also blocks the upgrade (db.js:124).

**Rejected: a "trashed" flag on existing rows.**
- Every reader of `cards`, `cardStates` and `reviewLog` (queue, stats, the optimizer, Own, export, counts, deck tree, search) would have to filter it.
- Older app versions on other devices would show and review "deleted" cards.
- The rows would count against account space (next section).

## 2. Sync

**Recommended: per device. The list syncs nothing new; only the restore goes through sync.**
- A restore puts the rows back as ordinary new changes, the same mechanism Undo already uses (db.js:398-404 comment). Every device takes them back through `decide()`.
- A synced list is not practical:
  - The server allows only five stores (setup.sql:28), so a new one means the owner runs SQL.
  - Each row is capped at 64 KB (limits.sql:283).
  - A deck's history counts against the 40 MB data limit (limits.sql:25) at about 530 bytes per review (quota.js `REVIEW_BYTES`). A deck with 100,000 reviews is about 53 MB, which would not fit at all.
- **setup.sql, media.sql and limits.sql need no change.**

Plain-language trade-offs:
- **Deleted on phone A, want it back on tablet B:** B can't. Restore from A, and B gets it back on its next sync. The help answer says "Recently deleted is on the device where you deleted it."
- **Restore after B already got the delete:** works. A's restored rows are newer than the delete marker, so the server takes them and B's `decide()` puts them back, removing B's marker (db.js:1176-1187).
- **B edited the card before it heard about the delete:** B's edit is newer, so the card already came back to A by sync. Restore must not overwrite it.

Restore rules, per row, in a new `db.restoreDeleted(part, entry)`:
1. **Skip a row that exists here now.** It came back another way: Undo, sync, "Try sample cards" again.
2. **Skip a row whose delete marker is newer than `entry.settledAt`.** Another device deleted it again later, or changed it later. Restore when there is no marker, or the marker is this device's own delete (its time is at or before `settledAt`, including when the server echoes it back).
3. **Restore a schedule or review row only if its card is here now, or is being restored in the same run.** So a card that came back by sync without history gets its history back.
4. **`before` rows** (unpaired partner, moved subdecks) go back only if the row is unchanged since the delete (`current.updatedAt <= entry.settledAt`). Otherwise the newer row stays.
   - If a partner can't be re-paired, the restored card is restored unpaired too (`unpaired()` from reverse.js).
5. **Restore time:** `max(Date.now(), tombstone.deletedAt + 1)`, not plain `now`. Today `restoreSnapshot` uses `now` (db.js:420). If the clock went back after the delete, the pushed row is ignored by the server (`<=`), the next pull's delete wins (`decide`) and the restore is silently lost. The same technique is already used for `mdel:` marks (db.js:688-690). Fix `restoreSnapshot` the same way.

Why a restore can't be lost:
- Restored rows have `updatedAt` later than the last push bookmark, so `localChangesSince` (db.js:1075) sends them. If the account is full, `pushSafely` holds them (`full: 'data'`) and resends later. They are never dropped.
- The trash entry is removed only after the main-database restore has saved.
- A restore cut off half-way can be run again, because rule 1 makes it safe to repeat.

Known limit, same as today's Undo: a device whose clock is more than a day ahead when it deletes gets its delete time capped by the server. In that case the restore might not reach the other devices.

**Accounts.** An entry stores the `userId` that was signed in when it was made, or `null`. An entry made under another account is hidden and can't be restored, so account X's cards are never pushed into account Y. The whole list is emptied whenever this device's data is wiped:
- `wipeThisDevice` (settings.js:1266): Reset, sign-out with Remove, "Remove them and sign in"
- Delete everywhere (settings.js:736)
- Restore backup (`importAll`)

## 3. Purging after 30 days

**When it runs:**
- When the app starts, when the browser is idle, at most once a day, next to `tidyMediaWhenIdle` (app.js:363, :453).
- Each time the Recently deleted sheet opens.

An entry goes when `now - deletedAt >= 30 days`. An entry dated more than a day in the future (clock trouble) is purged at the next check. Purging deletes `entries` + `parts` only. The main database already holds the delete markers.

**Pictures and sounds.** Files used by entries count as "in use":
- `cleanMedia(now, { keep })` (db.js:1363) gets the union of every entry's `mediaIds`. The app.js:358 and sync.js:547 callers pass it.
- `sweepMedia` (sync.js:556) adds the same ids to `used`, which `planSweep` uses for un-mark and `reupload`, and to the `mediaRefs` snapshot.
- So for 30 days this device un-marks any mark another device puts on those files. If the account lost one anyway (the device was offline and another swept it), `reupload` sends this device's copy again.
- After the purge they become unused: `cleanMedia` removes them locally and marks them, and the existing sweep deletes them from the account 30 days later. At most 60 days on the server.
- Known gap: a file this device never downloaded (lazy loading) and another device swept can't come back. The card restores with the existing "isn't in your account any more" line.

`holdMedia` stays as it is for the Undo toast.

## 4. The UI

**Where:** Settings → Your data, a new row "Recently deleted" with a count and an Open button. It opens a sheet in a new lazy-loaded js/trash-sheet.js. No caption text. The explanation goes in js/help.js as a new answer `recently-deleted`, with a "?" `helpLink` on the row (it needs an aria-label). Browse is not the place, because deck deletes don't belong to a card list.

**Each row:**
- An icon for a deck or cards.
- The title: the deck name, or the first card's plain front text, or "12 cards from Biology › Unit 1".
- A count line, "340 cards · 5,120 reviews".
- "Deleted 3 days ago", and "2 days left" in the last 3 days.
- Buttons **Restore** and **Delete now**. Delete now asks first: "Delete for good? This can't be undone." This is a data-loss note, which CLAUDE.md allows.
- The sheet header has **Empty**, with a confirm.
- An empty list shows the shared empty-state, with no tagline.
- For a big entry, a progress line while restoring.

**Restore results:**
- A toast: "Restored “Biology”". If anything was skipped: "Restored 48 cards. 2 changed on another device and were left as they are."
- Then refresh the sidebar and go to the deck.
- Call `ownSynced()` (own-gate.js:26) after a restore that put reviews back, as sync.js:404 does.

**Interaction with Undo:**
- Every delete path also makes an entry. The toast's Undo stays exactly as it is (`restoreSnapshot` from memory, already tested by e2e-undo.mjs) and then removes the entry, so nothing shows twice.
- Change `UNDO_NOTE` (browse.js:1180) and decks.js:698 from "You can undo this for a few seconds." to "You can restore it from Recently deleted for 30 days." This is a data-loss note.
- If saving the entry fails (no space), the toast says "Deleted. It was too big to keep in Recently deleted." The Undo link still works.

**Not added to the list:**
- import Undo (a deliberate tap, and the file still exists)
- duplicate Undo (browse.js:746)
- removing a blank or a reverse card while editing a note (later, if wanted)
- Reset / Delete everywhere (these empty the list)

## 5. Edge cases

**a. A card whose deck still exists:** restored into it.

**b. A card whose deck was also deleted:**
- If that deck is in Recently deleted, ask: "Its deck “X” was deleted too." [Restore “X” too] or [Choose a deck].
  - Restore “X” too restores the deck entry first. Rule 1 makes the order safe.
  - Choose a deck uses `openDeckPicker` from deck-picker.js and changes `deckId`.
- If the deck is gone for good, go straight to Choose a deck.
- Never skip silently, as `restoreSnapshot` does today.

**c. A subdeck whose parent is gone:**
- Parent in Recently deleted: keep `parentId`, so restoring the parent later puts the tree back together.
- Parent gone for good: set `parentId: ''`.
- A dangling parent already shows at the top level (deck-tree.js:9-13), but it should be cleaned anyway.

**d. Device storage:**
- The rows move from the live stores into the trash, so the space they take doesn't grow much. The 30-day wait is the cost.
- On QuotaExceededError while saving an entry: purge the oldest entries, try once more, then give up with the toast in 4.
- The row in Your data shows the trash size.

**e. A deck with 10,000 cards:**
- The snapshot is already built in memory today.
- The entry is written in pieces of about 2,000 rows.
- Restore works piece by piece: decks, then cards and schedules, then reviews. Each piece is one main-database transaction with batched lookups (`Promise.all`, as in `applyRemote`). Today's `restoreSnapshot` does one `getKey` per row, which is slow at this size.
- Progress is shown. An interrupted restore can be resumed.
- The push afterwards is about 400 requests of 500 rows for 200,000 rows, handled by the existing `pushSafely`. If the account's data space is full, rows wait.

**f. The sample deck:** it has fixed ids (sample.js). If "Try sample cards" re-added it, rule 1 skips the rows that exist. A restored sample row is stamped now, not the `at: 1` used by sample.js, so it syncs like any edit.

**g. Import Undo:** not added to the list. Rows it put back are newer than any trash entry, so rule 2 protects them.

**h. The Own model:**
- Its records are keyed by the review log's local `id` (own-db.js:10-11; own-core.js:266, :278).
- A restore puts the review rows back with their old `id` (the snapshot keeps it, and IndexedDB never reuses an autoIncrement number), so Own's records line up again.
- While a card sits in the trash, its reviews are missing from `reviewLog`, so Own, the FSRS optimizer and Stats ignore them, as they should.
- After a restore, Own's check `fingerprintOf` (own-shadow.js:20, row count + sum of ids) no longer matches, so it rebuilds. `ownSynced()` makes that happen now rather than at the next session.

**i. The schedule after a restore:** the `cardStates` row comes back exactly (due date, stability, difficulty, `lastReview`, `fsrs7`). A card restored after 20 days is simply overdue, and FSRS uses the real time since the last review.

## 6. Files and steps

**[SYNC/DB]** marks steps that touch sync or the database. Those need the owner's PR, a 3-line phone test checklist, and the owner's OK before merge.

1. **New js/trash-logic.js (pure functions).**
   - `buildEntry(snap, {kind, title, before, now, userId})`: splits gone and before rows, works out media ids, counts and size, and cuts the pieces.
   - `restoreRow({live, tomb, entry})`, implementing rules 1-4.
   - `restoreStamp(now, tomb)`, rule 5.
   - `expired(entries, now)`.
   - `deckFate(entry, liveDeckIds, trashDeckIds)`, for 5b and 5c.
   - Test: tests/trash.test.js.
2. **New js/trash-db.js.** The separate database, on the own-db.js pattern, with an `idb` parameter so tests can pass a stand-in: `add`, `list`, `parts`, `remove`, `purge`, `clear`, `mediaIds`, and `onversionchange` → close. Test: tests/trash-db.test.js using tests/own-idb-fake.mjs.
3. **[SYNC/DB] js/db.js.**
   - New `restoreDeleted(part, entry)`.
   - `restoreSnapshot` stamps with `restoreStamp`.
   - `cleanMedia(now, {keep})`.
4. **New js/trash.js (glue).**
   - `keepDeleted(snap, meta)`.
   - `restoreEntry(id, {onProgress, pickDeck})`, which calls `ownSynced()`.
   - `purgeDaily()`, and the account check.
5. **Delete call sites.** Make an entry, and Undo removes it.
   - browse.js:646-649, :657-658, :826-835 and :1180
   - decks.js:698, :719-742
   - leech-coach.js:26-33, :113, :204
6. **[SYNC/DB] Media protection.**
   - sync.js:547-569: `used` includes trash media, `cleanMedia` gets `keep`.
   - app.js:352-361: tidy with `keep`, plus the daily purge.
7. **[SYNC/DB] Empty the list on wipes.** settings.js:1266 (`wipeThisDevice`), :736 (Delete everywhere), and the Restore backup confirm (~:650).
8. **UI.** js/trash-sheet.js, the Your data row in settings.js:230-261, the CSS, and a `recently-deleted` answer in js/help.js.
9. **Release.** Add the new files to the sw.js precache list (sw.js:17), bump `CACHE`, and update the hash (release skill). Add a js/whats-new.js entry and a CHANGELOG line.

**Tests to add:**
- **tests/trash.test.js:**
  - the rule matrix: live → skip; newer marker → skip; own marker or none → restore; history without a card → skip; before row changed → keep the newer
  - `restoreStamp` is later than the marker when the clock went back
  - 30-day boundary
  - a pair partner can't be re-paired → the card comes back unpaired
  - subdeck parent in the trash or gone
  - pieces of 2,000 rows
- **tests/trash-db.test.js:** add, list, purge, clear, two connections, failed writes (`failWrites`).
- **tests/media-sweep.test.js:** files used by the trash un-mark and re-upload.
- **tests/sync.test.js:** a restored row beats the delete marker through `decide` and `newestOnly`.
- **tests/browser/e2e-trash.mjs**, reusing the dump/same helpers from e2e-undo.mjs:
  - card, bulk, deck-with-subdecks and leech deletes show up, restore exactly (ids, states, logs), Delete now, Empty
  - a card whose deck is in the trash; a subdeck whose parent is gone
  - purge with a moved clock, and its picture cleaned
  - Reset and sign-out empty the list; another account's entries are hidden
  - with `fakeSupabase` and two devices: A deletes, B syncs (gone), A restores, B syncs (back with its schedule and history)
  - B edits before the delete arrives: A's restore leaves B's version
  - a 3,000-card deck, with progress
- **Update e2e-undo.mjs:** after Undo, no entry is left.
- **Update e2e-media-sweep.mjs:** a trashed card's picture isn't swept within 30 days.

## 7. For the owner (plain language)

- What you get: anything you delete (cards, a deck with its subdecks, a leech card) waits 30 days in Settings → Your data → Recently deleted. Restore brings it back with its schedule and review history, and your other devices get it back when they sync.
- Pictures and sounds stay as long as their card is in Recently deleted, then go 30 days later as now.
- No SQL to run, and the sync format doesn't change.
- Decision 1: is a per-device list OK? You can only restore on the device where you deleted it. A synced list would need SQL and wouldn't fit big decks into account space.
- Decision 2: where to keep it on the device.
  - Recommended: a separate small database. Easy to remove later, no upgrade.
  - The alternative is a new table inside the main database. That is a little safer if the app closes mid-delete, but it can't be rolled back to an older app.

### Critical Files for Implementation
- /home/user/study-sprint/js/db.js
- /home/user/study-sprint/js/sync.js
- /home/user/study-sprint/js/browse.js
- /home/user/study-sprint/js/decks.js
- /home/user/study-sprint/js/own-db.js (pattern for the new trash database)
