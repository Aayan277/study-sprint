# Plan: prune deleted rows (backlog item 4)

*Design only, nothing built. Written 18 Oct 2026 against v4.32. Decision: parked until it's needed (see "When to build it").*

## Why and how much it saves
- A deleted record stays on the server as a delete marker: 272 bytes of quota (about 220 B on disk) and one row of the 300,000-row cap. `mdel:` rows that are `null` or `'gone'` are about 300 B each.
- A typical heavy account (about 210k rows, 5% markers) carries about 10,500 markers: 2.9 MB, about 3.5% of the 80 MB per-person limit.
- Deck churn is where it matters: deleting a 1,000-card deck with about 15 reviews per card leaves about 17,000 markers (4.6 MB). Three such decks a year is about 14 MB a year, growing forever (about 42 MB after 3 years). With pruning it levels off at 7 months' worth (about 8 MB).

## When to build it
When the storage alert (fuse-watch) shows the data total past about 50% of its fuse, or a heavy user nears the per-person data limit, or before moving many users onto the project.

## Server
- **Time base:** a monthly job records `(now(), last_value of sync_seq)` in `private.sync_seq_marks`; rows with `seq <=` the newest mark at least 180 days old are prunable. `updated_at` can't be used: it is the device clock, and Re-upload re-sends old markers with their old times.
- **`public.sync_prune` (per user):** `pruned_seq` (highest seq pruned), `pruned_until` (highest `updated_at` pruned), `pruned_at`, `rows`. Read-own RLS. Per user, because the pull bookmark is per account.
- **`private.prune_sync_items()`:** in one statement with data-modifying CTEs, delete delete-markers and null/'gone' `mdel:` rows at or below the cutoff, subtract per-user totals from `sync_usage` once, and raise `sync_prune`. The quota trigger skips row-by-row accounting when `app.pruning` is on (clients can't set it). Clear `usage_cache` 'sync'. Log to `private.prune_runs`. No new index.
- **Quota trigger:** when a user's row count reaches 0 outside a prune (Delete my synced data), delete their `sync_prune` row, so a later re-upload isn't refused.
- **Resurrection guard (own trigger, BEFORE INSERT):** refuse a live row in decks/cards/cardStates/reviewLog or an `mdel:` setting whose `updated_at <= pruned_until` when no row exists for that key. The `not exists` check keeps updates through `ON CONFLICT` working. It protects against Re-upload, first sign-in, old app versions, restored backups and the sample deck.
- **`public.sync_missing(store, ids[])`:** returns the ids the caller has no row for at all; max 5,000 ids per call.
- **The job:** pg_cron, 3rd of each month at 04:41 UTC (check on the live project's Extensions page that pg_cron is available on Free); fallback a monthly GitHub Action like fuse-watch. fuse-watch opens an issue if no successful prune ran in 40 days.
- **Files:** `limits.sql` (the table, the trigger changes), new `prune.sql` (marks, runs, guard, `sync_missing`, the function, the schedule; refuses to run before the new `limits.sql`), `owner.sql` column, `docs/sync-setup.md` step 2d.

## Client
- **`syncState.cleanSeq`:** "this device has read every row up to here with new code". Only new code raises it; old code keeps the field. Needed because an old-code sync (a device unopened for 180+ days runs one before the service worker updates it) moves `lastSeq` past pruned rows without seeing them.
- **Stale test:** after each pull, read `sync_prune`; the device is stale when `pruned_seq > cleanSeq`. A 404/empty answer means no pruning.
- **Catch-up (a targeted merge, not wipe-and-pull):** collect local live records with `updatedAt <= pruned_until` (skip `tooBig`, and on a full pull skip records the pull just wrote), ask `sync_missing` in chunks of 2,000, 4 at a time, then:
  - was on the server → deleted elsewhere: remove locally (a local marker, not pushed);
  - never pushed and `updatedAt <= 1` (sample deck): remove;
  - never pushed otherwise → the person's own unsent work: restamp it so it's sent and passes the guard;
  - `mdel:` keys: remove locally.
  - Children (states, reviews) of removed cards that are on the server get normal delete markers. Then `cleanMedia`, mark held used files not-uploaded, and check them with one listing (replaces a pruned 'gone'). One transaction; a note: "Removed N cards and reviews deleted on your other devices while this one was away."
- **Re-upload everything:** a stale device catches up first and starts over on the next run; `startOverFromHere` keeps `cleanSeq`.
- **Item 5 overlap rules:** unchanged. Pruned seqs are far below the overlap window, gaps never shorten a page, the bookmark never moves back.
- **Wrong clock:** if the device clock is at or before `pruned_until`, say "check this device's date".

## Rollout
1. Client release first (works with no server SQL).
2. Owner runs `limits.sql` again, then `prune.sql`. The guard is on at once but does nothing until the first prune, which is at least 180 days later, by when every active device has the new client.
3. No minimum-version gate (it would break old clients during rollout); the guard plus the 180-day lag cover old versions.

## Tests
- Unit: stale test, `cleanSeq`, candidates, the four outcomes, child cascade, deferred start-over, overlap equality with pruned gaps, `run()` order.
- SQL against a local postgres:17: what's deleted and kept, `sync_usage` matches a recount, `sync_prune` grows, the guard (refuses old live inserts, allows markers, new rows and updates), Delete-all clears the horizon, `sync_missing` limits.
- Fake server + `e2e-prune.mjs`: a quiet device catches up after a prune; unsent old work is restamped; Re-upload on a stale device; old-client pushes refused; sample deck on a pruned account; Delete my synced data then re-upload; a pruned 'gone'; no SQL installed; a prune between pages.

## Risks
Out-of-date copies pushed back (the guard); a stale device studying out-of-date copies (catch-up removes them and their children); old-code sync moving `lastSeq` (`cleanSeq`); an old-code sweep using a pruned null mark (rare; option: delay pruning null marks a cycle); unsent old work refused (restamp); a prune mid-sync (atomic commit + read after pull); Delete-all then re-upload (horizon cleared at 0 rows); oversized records (excluded); a silent job failure (fuse-watch check); re-running setup SQL (guard in its own file); restore to a new project (only delays pruning); bulk-delete load (one statement, monthly); a stale heavy device's catch-up (about 8 MB, 10–30 s, once); A→B→A account switching (very rare).

## Steps
1. Client release (sync-prune.js, supa/db/sync changes, fake server, tests).
2. Server SQL (owner runs it) + SQL tests + docs.
3. Monitoring (fuse-watch check, optional prune.yml) and PLAN/release notes.
