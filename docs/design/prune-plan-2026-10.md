# Prune deleted rows: plan (Opus planner, 2026-10-21)

## Verdict: too early to build. Do the small Step 0 now and park the rest.

On a small group of users on Supabase Free, the full feature costs about 2–3 days of work. It touches the riskiest code in the app (the sync merge, plus a server trigger on every insert). Even after it ships, nothing is removed for at least 180 days, by design. If one person runs short of space, giving them a bigger allowance in `quotas` is a one-line fix.

**Numbers** (checked against `private.row_bytes` = 200 + 2×len(id) + data size):
- **One delete marker:** 272 B counted, about 220 B on disk (record ids are 36-character UUIDs).
- **One `mdel:` row that is null or `'gone'`:** about 303–307 B.
- **Current limits per person:** 40 MB of data and 300,000 rows. `prune-plan.md` still says 80 MB.
- **Deleting one 1,000-card deck** (about 15 reviews per card) leaves 17,001 markers: 4.6 MB, 11% of the 40 MB limit and 5.7% of the row cap.
  - Markers do not free rows: a delete updates the existing row in place.
  - They also keep about 272 B of each review row (my estimate is roughly 450 B per review row; the builder should measure it). So deleting a deck frees well under half of its bytes.
- **Heavy deck churn** (three such decks a year): about 51,000 markers and 14 MB a year, which is 35% of the data limit and 17% of the row cap each year.
  - With pruning at 180 days, run monthly, the total levels off at about 7 months' worth: roughly 8 MB and 30,000 rows.
- **Ordinary use** (deleting single cards): a few hundred markers a year, under 0.2 MB.
- **`mdel:` rows:** about 300 deleted pictures a year is about 90 KB. Pruning them is cosmetic.
- **Whole project:** five heavy churners add about 70 MB a year, about 23% of the 300 MB limit.

**Step 0 (build now):**
- Add three read-only columns to `supabase/owner.sql`:
  - `marker_rows` = count where `deleted`
  - `dead_mdel_rows` = settings rows where `id like 'mdel:%'` and `data->'value' in ('null','"gone"')`
  - and `marker_mb`.
- Fix the outdated facts in `docs/design/prune-plan.md`:
  - the 80 MB limit (now 40 MB)
  - `usage_cache` (`limits.sql` drops it)
  - the `app.pruning` setting and the `limits.sql` changes, which are no longer needed (see below).
- **When to build the rest:** owner.sql shows anyone's markers at 15% or more of their row cap or data limit, or the sync fuse passes 50%, or the user base is about to grow a lot.

## How the existing design holds up against the code

The core of `prune-plan.md` is sound and I kept it:
- a server horizon per user (`pruned_seq` / `pruned_until`)
- a client "clean bookmark" (`cleanSeq`)
- a targeted catch-up through `sync_missing`, rather than wiping the device and downloading everything
- a server guard that refuses stale inserts
- a time base made of sequence marks, because `updated_at` comes from the device clock.

Corrections:
1. **`usage_cache` is gone.** `limits.sql` line 110 drops it, so there is nothing to clear.
2. **No `app.pruning` setting and no change to the space-counting trigger.** The existing `sync_items_quota` already gives back rows and bytes, row by row, on a real DELETE, so the counters stay exact for free. A 17,000-row delete takes a few seconds, while it holds the `usage_totals` row lock. That cost is accepted, and runs are capped with `max_rows`.
3. **No `limits.sql` change.** "Delete my synced data clears the horizon" becomes a statement-level AFTER DELETE trigger inside `prune.sql`. So `prune.sql` is self-contained, and re-running `limits.sql` cannot undo it.
4. **Guard detail.** A stale delete marker should be silently skipped (`return null`), not refused and not stored. Otherwise Re-upload would recreate thousands of markers that use up the row cap. The same goes for stale `mdel:` settings.
5. **Prune in the middle of a pull.** Staleness must be judged against the `cleanSeq` from *before* this pull: the device is stale if `pruned_seq > cleanSeq_before`. Then set `cleanSeq = lastSeq`. One read after the pull is then enough.
6. **Restore danger (new).** Restoring a backup restores `sync_seq` to an older value. The marks in `private` are not in the backup, but in the same project they survive. A mark whose seq is above the restored sequence would make brand-new markers prunable at once. Fix: before working out the cutoff, the prune deletes marks with `seq > (select last_value from public.sync_seq)`.
7. **Re-upload runs before the pull.** `tryStartOver` runs before the pull in `sync.js` `run()`, and it clears `syncedAt`, which is the "was on the server" signal the catch-up needs. On a stale device the start-over must wait one run.
8. **Unsent old edits to records whose parent was pruned** should be removed (with the cascade), not restamped. Otherwise a card comes back pointing at a deck that no longer exists. This also matches today's rule that the newer delete wins.
9. **Old app versions.** A device unopened for 180+ days may run one sync on old code before it updates (`cachedMinClient` is stale until `checkMinClient` answers). The server guard covers its pushes, and `cleanSeq` covers its bookmark. The owner should also raise `min_client` to the prune-aware release before the first prune.
10. **How it runs.** A GitHub Action can't do the prune: `SUPABASE_DB_URL` may be the read-only `study_sprint_ci` login, and adding a writer secret would be a step backwards. So it runs from pg_cron, with "the owner calls the function by hand monthly" as the fallback.

## Server: new `supabase/prune.sql` (the owner runs it after `limits.sql`; it logs `('prune.sql', 1)`)

1. **Order check:** raise an error unless `private.schema_log` has `limits.sql` version ≥ 2.
2. **`private.sync_seq_marks`:** columns `id` (identity), `marked_at timestamptz default now()`, `seq bigint`. Row security on, all access revoked.
3. **`public.sync_prune`:**
   - Columns: `user_id uuid pk references auth.users on delete cascade`, `pruned_seq bigint`, `pruned_until bigint`, `pruned_at timestamptz`, `rows bigint`.
   - Row security with a "read own" policy. `select` granted to `authenticated`, everything else revoked.
4. **`public.sync_prune_runs`:** started, finished, cutoff_seq, rows, users, note.
   - Row security on and no policy, so the app can't read it. The ci login can, through the default privileges.
5. **`private.sync_items_prune_guard()`,** a BEFORE INSERT trigger named `sync_items_prune_guard`. The name sorts after `sync_items_on_change`, so it sees the already-capped `updated_at`. Logic:
   - If the user has no `pruned_until`, or `new.updated_at > pruned_until`: accept (`return new`).
   - If a row already exists for (user, store, id): accept (`return new`). This keeps updates through `ON CONFLICT` working.
   - If `new.deleted`, or it is an `mdel:` setting: skip it (`return null`).
   - If it is a live row in decks, cards, cardStates or reviewLog: `raise exception 'sync_pruned'`.
   - Any other setting: accept (`return new`).
6. **`sync_prune_reset`,** an AFTER DELETE trigger, statement level, `referencing old table as gone`: delete the `sync_prune` row of every user in `gone` who now has 0 rows.
7. **`public.sync_missing(p_store text, p_ids text[]) returns text[]`:**
   - Security invoker, so row security applies.
   - Refuses more than 5,000 ids and any store name not on the list.
   - Execute granted to `authenticated` only.
8. **`private.mark_sync_seq()`:** inserts `(now(), last_value of public.sync_seq)` and drops marks older than 400 days.
9. **`private.prune_sync_items(keep_days int default 180, max_rows int default 200000) returns jsonb`:**
   - Starts with `pg_try_advisory_xact_lock`, so two runs can't overlap.
   - Deletes marks with seq above the current sequence value (see correction 6), then records a new mark.
   - `cutoff` = the largest mark seq with `marked_at <= now() - keep_days`. If there is none, log "nothing old enough yet" and return.
   - In one statement with data-modifying CTEs:
     - select the doomed rows: `seq <= cutoff` and (`deleted`, or (`store='settings'` and `id like 'mdel:%'` and `data->'value'` is `'null'::jsonb` or `'"gone"'::jsonb`)), ordered by seq, `limit max_rows`;
     - delete them, re-checking `s.seq = d.seq` so a row changed in the meantime survives;
     - upsert `sync_prune` per user with `greatest()` for both values, so they only ever rise.
   - Insert a line into the runs table.
   - Execute revoked from public, anon and authenticated.
10. **Schedule:**
    - Try `create extension if not exists pg_cron`; on an exception, warn and carry on.
    - If `to_regnamespace('cron')` exists, run `cron.schedule('study-sprint-prune', '41 4 3 * *', 'select private.prune_sync_items()')` and `cron.schedule('study-sprint-seq-mark', '11 4 * * 1', 'select private.mark_sync_seq()')`.
    - `cron.schedule` updates an existing job with the same name, so re-running is safe.
11. **Status table** (each line should say ok):
    - the guard is on
    - the function exists
    - the cron jobs are present, or "NO: enable pg_cron, run again (or run the prune by hand monthly)"
    - the oldest mark, and the "first prune possible on" date
    - the last run.

**Repeat runs:** everything uses if-not-exists, create-or-replace, drop-and-recreate triggers, and cron upsert by name. A second prune deletes nothing new, and `sync_prune` never goes down. The marks need 180 days of history, so the first prune happens at least 180 days after install. By then every active device has the new app.

**`seq` and the overlap window:**
- No change to `pullStart`, `logPull` or `pullPages`.
- Pruned seqs are at least 180 days old, far below the 2-minute overlap and the 3,000-row look-back. Gaps never shorten a page, and the bookmark never moves back.

**Backups:**
- `backup.yml` dumps `public`, which now includes `sync_prune` and the runs table. `private` (the marks) is not dumped, so a restore into a new project only delays pruning.
- The same-project restore case is guarded by correction 6.
- Pruned markers stay in the backups for 30 days, which matches the privacy page.
- Deleted space is reused but not handed back: no `VACUUM FULL`. The fuse-watch "database" total drops only slowly.

**Row cap:** the per-row quota trigger lowers `sync_usage.rows`/`bytes` and `usage_totals`. Skipped stale markers are never counted.

## Client (release before any server SQL; does nothing without it)

**New `js/sync-prune.js`** (pure functions):
- `isStale(info, cleanSeqBefore)`
- `pruneCandidates({ records, settingsTimes, prunedUntil, tooBig, justPulled })`
- `classifyMissing({ candidates, missing, pushedUntil, liveParents })`, which returns `{ removeLocal, restamp, removeSettings, childTombstones }`. The rules:
  - was synced (`syncedAt === updatedAt`, or `updatedAt <= pushedUntil`) and is now missing → remove here, with a local marker set to `synced: true`;
  - never sent and `updatedAt <= 1` (the sample deck) → remove;
  - never sent, parent alive → restamp;
  - never sent, parent gone → remove;
  - `mdel:` keys → remove the local setting;
  - children of removed cards that are still on the server → normal (pushed) delete markers.
- `clockBehind(info, now)`
- `catchUpNote(n)`: "Removed N cards and reviews deleted on your other devices while this one was away."

**`js/supa.js`:**
- `getPruneInfo(token)`: GET `/rest/v1/sync_prune?select=pruned_seq,pruned_until,pruned_at`. Returns null on 404, PGRST205 or an empty answer.
- `syncMissing(token, store, ids)`: POST `/rest/v1/rpc/sync_missing`. Sent in chunks of 2,000, 4 at a time with `runPool`.

**`js/db.js`:**
- `localLiveBefore(prunedUntil)`: uses the `updatedAt` index with an upper bound, plus `mdel:` keys by `_times`.
- `applyPruneCatchUp({ remove, restamp, removeSettings, childTombstones, now })`: one transaction.

**`js/sync.js` `run()`:**
- Record `cleanBefore = st.cleanSeq || 0` before `startPull`.
- When the pull started from 0, collect the keys it pulled.
- After `pullPages`, if `isStale(await getPruneInfo(), cleanBefore)`, run `catchUpAfterPrune(...)` before `healNotes`, the media step and the push. Then:
  - call `db.cleanMedia()`;
  - mark held files that cards use as not uploaded, and check them with one `listMedia` (this replaces a pruned `'gone'`);
  - add the note.
- If `clockBehind`: no restamp, and show the note "check this device's date".
- Then set `st.cleanSeq = st.lastSeq` and save.
- **Re-upload:** if `resendPending`, call `getPruneInfo` first. If the device is stale, skip `tryStartOver` this run; the catch-up runs after the pull and the start-over happens next run. `startOverFromHere` keeps `cleanSeq`.

**`js/quota.js`:** `pushErrorKind` returns `'pruned'` for `/sync_pruned/`.

**`js/sync-push.js`:** treat `'pruned'` like `'size'`/`'id'` (split the batch down to the single bad row).

**`sync.js`:** bad rows of kind `'pruned'` do not go into `tooBig`. Instead set `st.cleanSeq = 0`, so the next sync runs the catch-up and heals itself.

**`signedIn` and `startOverFromHere` (old code):** both leave `cleanSeq` undefined, which reads as 0, so a catch-up runs. That is the correct behaviour.

## Tests

**Local PostgreSQL is available.** A PostgreSQL server is installed (the version and bin directory vary; check `tests/sql/run.mjs`), with a `postgres` OS user and `runuser`. `npm run test:sql` (`tests/sql/run.mjs`) already starts a throwaway server as root through `runuser`. pg_cron is not installed and Docker has no daemon, so the shim needs a fake `cron` schema: a `cron.job` table plus `cron.schedule` / `cron.unschedule` upsert-by-name functions, created only in the cron tests.

**SQL** (new `await test(...)` blocks in `tests/sql/run.mjs`; add `prune.sql` to a `runPrune(db)` helper):

| Test | What it asserts |
|---|---|
| `prune.sql refuses before limits.sql v2` | the script fails with a clear message if `limits.sql` v2 hasn't run |
| `prune.sql twice changes nothing` | the snapshot is equal after a second run |
| `prune deletes only old markers and dead mdel rows` | backdated marks; deleted: old markers and old null/'gone' mdel rows; kept: live rows, new markers, numeric mdel, other settings, other users' rows above the cutoff |
| `counters stay exact after a prune` | `assertExact`; `sync_usage.rows` goes down |
| `sync_prune only rises; second run deletes 0` | idempotent |
| `no mark old enough → nothing deleted` | |
| `sequence restored lower → future marks dropped, nothing deleted` | |
| `guard` | old live insert fails with /sync_pruned/; old marker skipped and no row counted; newer row allowed; ON CONFLICT update of an existing row allowed; an unpruned user unaffected |
| `Delete my synced data clears the horizon` | the re-upload is accepted |
| `sync_missing` | own rows only (B's rows count as missing for A); 5,001 ids refused; bad store refused; anon refused |
| `only the owner can prune` | authenticated can't execute `private.prune_sync_items` and reads only its own `sync_prune` |
| `concurrent update survives` (`psqlAsync`) | a row updated during the prune is kept |
| `cron jobs scheduled once` | with the fake cron schema |

**Unit** (`tests/sync-prune.test.js`, plus additions to `tests/quota.test.js` and `tests/sync.test.js`):

| Test | What it asserts |
|---|---|
| `isStale` | null info, equal values, above, and below; uses the cleanSeq from before the pull |
| `pruneCandidates` | the cut-off is ≤ pruned_until; tooBig and just-pulled keys are skipped; mdel keys are picked by time |
| `classifyMissing` | the five outcomes plus the child cascade |
| `clockBehind` | |
| `pushErrorKind sync_pruned` | returns `'pruned'` |
| `pushSafely splits pruned rows` | |
| `overlap unchanged with pruned gaps` | `pullPages` over seqs with gaps gives the same bookmark and log as without gaps |

**Browser** (`tests/browser/e2e-prune.mjs`). Extend `tests/browser/fake-supabase.mjs` with: `prune({ cutoffSeq })`, GET `/rest/v1/sync_prune`, POST `/rpc/sync_missing`, and the guard on POST `sync_items`.
- A quiet device catches up: B deletes a deck, the server prunes, A syncs. The deck is gone on A, the note is shown, nothing is pushed back, and the server row count is unchanged.
- An unsent old edit with a live parent is restamped and sent; one whose parent is gone is removed.
- Re-upload on a stale device: no resurrection, and the start-over happens on the next run.
- A raw push of an old live row is refused, and the next sync heals it.
- A fresh device signing in to a pruned account loses the deleted sample deck.
- Delete my synced data, then re-upload, is accepted.
- A pruned `'gone'`: the device holding the file uploads it again.
- No `prune.sql` installed (404): sync is normal.
- A prune between pages of a full pull: the catch-up runs.

The browser tests use route stubs only; nothing touches the live project.

## Owner steps (when built)

1. Release the new app and wait until it is live.
2. Turn on pg_cron in the Supabase dashboard (Integrations → Cron, or Database → Extensions → pg_cron).
3. In the SQL Editor, run `supabase/prune.sql` after `limits.sql`. Every status line should say ok; note the "first prune possible on" date. Without pg_cron, run `select private.prune_sync_items();` by hand once a month.
4. Before that date, raise `min_client` to the prune-aware version (`docs/sync-setup.md` 8f).
5. After the first run, look at `select * from public.sync_prune_runs order by id desc limit 3;` and at owner.sql.
6. To turn it off:
   - `select cron.unschedule('study-sprint-prune');`
   - `drop trigger sync_items_prune_guard on public.sync_items;`

**Documentation to update:**
- `docs/sync-setup.md`: new step 2d, and a line in the SQL changes log.
- `docs/owner-launch-checklist.md`: section 1 (the item to run `prune.sql`) and the monthly routine (check the last prune run).
- `PLAN.md` item 4: update its status.
- `docs/design/prune-plan.md`: the corrections above.

**Optional monitoring:** fuse-watch opens an issue if `sync_prune_runs` exists and has had no run in 40 days.

### Critical files for implementation
- supabase/limits.sql (the quota trigger and `row_bytes` that the prune relies on; not changed)
- js/sync.js (`run()`, `startOverFromHere`, `signedIn`)
- js/db.js (`applyRemote`, `localChangesSince`, `forgetSyncedMarks`, `deleteCardIn`)
- tests/sql/run.mjs and tests/sql/shim.sql
- tests/browser/fake-supabase.mjs
- supabase/owner.sql (Step 0)
