# Study Sprint at scale: limits, capacity and backend issues

I measured sizes from the code on origin/main (v4.14) and origin/claude/round3-sounds. I built rows with the app's own `stamp()` and `rowFromRecord()`, loaded 20,000 of each kind into a real Postgres 16 table that copies `supabase/setup.sql` (same columns, primary key, seq index and trigger) and measured table plus index size. I re-encoded real pictures the way `media.js` does (JPEG, quality 0.82, 1280px, or 2048px for occlusion) and encoded test sounds with ffmpeg. I didn't edit any repo files. My scripts are in /tmp/claude-0/-home-user-study-sprint/b156d69a-a765-5609-999d-2835cc7accb8/scratchpad/work/.

## Short answers

1. **Can we set limits?** Yes. You can set a limit per picture, per sound and per account. The server can enforce them too, not just the app. I wouldn't set a hard per-deck MB limit: warn at import instead (details below).
2. **How much fits?** About 1.5 KB per studied card and about 0.55 KB per review. A picture is about 170 KB and a sound about 30 KB. Card text is small. The review history and media are what fill things up.
3. **Other backend issues:** two need fixing before you invite more people. "Forgot password" email doesn't work for anyone but you, and nothing on the server stops one account from filling the whole project.

## Capacity

Free plan: 500 MB database (the project goes read-only above that), 1 GB file storage, 5 GB egress a month. I count about 450 MB of the database as usable.

| Per account, after 1 year | Cards | Reviews per day | Database | Accounts that fit in 450 MB |
|---|---|---|---|---|
| Light | 1,000 | 30 | about 7.5 MB | about 60 |
| Moderate | 3,000 | 150 | about 34 MB | about 13 |
| Heavy (med student) | 15,000 | 500 | about 120 MB | about 3–4 |
| Heavy + full Anki history imported (300k reviews) | 15,000 | 500 | about 280 MB | 1 |

The database grows every year as reviews pile up (about 6 / 29 / 97 MB per year for light / moderate / heavy). So 10 moderate users fill the free database in about 16 months.

| Media, 1 GB free storage | Typical size | Fits in 1 GB |
|---|---|---|
| Picture card (1280px) | 100–250 KB, about 170 KB | about 6,000 |
| Occlusion picture (2048px) | 260–540 KB | about 2,800 |
| Sound: a word (1–2 s) | 6–25 KB | about 60,000 |
| Sound: a sentence (4 s) | 16–63 KB | about 25,000 |

A text-only account could hold about 300,000 cards before the database is full. Media runs out much sooner.

**When you need Pro ($25 a month):** with more than about 10 active users, any heavy user, or more than 1 GB of media. Pro also matters if you want backups or no pausing. Pro gives 8 GB of database, 100 GB of storage and 250 GB of egress, and extra space is cheap.

**Egress:**
- A new device downloads everything: about 20 MB of data for a moderate account (about 6 MB compressed) plus every picture and sound. A 1,000-picture account is about 170 MB, so 5 GB covers about 29 such downloads a month.
- Daily syncing is tiny: about 0.1–0.5 MB per device per day.

## Recommended limits

| What | Now | Recommend |
|---|---|---|
| Picture | Shrunk to 1280/2048px; bucket allows 5 MB | Keep the shrink. Refuse anything still over 1.5 MB after it (3 MB for occlusion). Lower the bucket limit to 3 MB. |
| Sound | 1 MB (about 1 minute at 128 kbps), bucket allows 5 MB | Keep 1 MB. The bucket limit above (3 MB) is the backstop. |
| Deck | none | No hard limit. At import, warn above 200 MB: "This deck's pictures and sounds take 340 MB. That's a lot for a phone and your account. Import without sounds?" (the switch already exists). |
| Media per account | none | 50 MB by default (eighteen accounts fit in the free 1 GB); for open sign-ups lower it with one SQL line (`docs/sync-setup.md`), raise it per person in `quotas`. 2 GB on Pro. |
| Synced data per account | none | 80 MB by default (`quotas.data_bytes_limit`), kept by a trigger with a per-person byte and row counter. Deleting and "deleted" markers are always allowed. |
| Whole project | none | Safety ceilings in `global_limits`: new pictures and sounds are refused when the bucket passes 900 MB, new synced data when everyone's data passes 300 MB (the totals are exact, kept by the database). Reviews and cards are never blocked by the picture ceiling. |
| Cards per account | none | Warn at 50,000; don't block. |
| One record on the server | unlimited | Hard cap of 64 KB (stops abuse; real cards are under 1 KB). |
| Review history | kept forever | Keep it all. The optimizer needs each card's full history from "new" (rule 4 in `js/fsrs-data.js`), and stats use it too. Add a size warning when an Anki import has more than 50,000 reviews. |

**What happens at the limit:** reviews, cards and progress **always** keep syncing. Only new pictures and sounds wait on the device. The message: *"Your account is full: pictures and sounds use 50 MB of 50 MB. New ones are saved on this device and will sync when there's room. Remove some, or ask the account owner for more space."* At 80% the bar turns amber: *"Pictures and sounds: 40 MB of 50 MB."* Synced data has its own message: *"Your account's synced data is full (X of Y MB)…"*, and a full project says *"The sync server is full right now. Everything is safe on this device and will sync when there's room."*

**Showing usage:** Settings → Your data already has "On this device: pictures … · sounds …" on the sounds branch. Add a line: "In your account: data 34 MB of 40 MB · pictures and sounds 40 MB of 50 MB". It comes from a small server function, `my_usage()`.

**How it's enforced:**
- The app checks before upload and at import.
- On the server: the bucket's file size limit; a check on `sync_items` (each record's data must be under 64 KB); and a `quotas` table with storage rules for adding **and replacing** a file (`media_may_store()`), which run under a per-person lock so parallel uploads can't both squeeze in. If Supabase tells the rule the file's size, the rule enforces `used + size <= limit`; if not, it enforces `used < limit` and a person can go over by at most one file (3 MB). A trigger on `sync_items` keeps the per-person counters and refuses growth over the data limit. The scripts were checked on a local Postgres 16 with stand-ins for `auth.uid()`, `storage.objects` and Storage's delete protection.
- A record the server refuses never blocks a batch: the app measures each row first (leaving a margin under 64 KB), leaves oversized ones out and names the card in Settings → Sync, and if the server still refuses a batch (error 23514) it splits it until the bad row is alone.

## Backend issues, ranked

1. **Password reset email doesn't work for other users (S).** Supabase's built-in email only sends to members of the project's team, and only 2 emails an hour. Fix: connect custom SMTP under Authentication → Emails. With no domain, a dedicated Gmail account with an App password works (about 500 emails a day, may land in spam); Resend is the later option if a domain is bought. Steps: `docs/sync-setup.md` step 4.
2. **No server limits (M).** There's no per-account cap on storage or rows. The publishable key is public by design, so any signed-in user can push data until the project goes read-only, and then it's read-only for everyone. Fix: the quotas above. Keep sign-ups off until the limits, a working email service and the captcha (after its live check) are in place, as `docs/sync-setup.md` says.
3. **Slow row rules (S).** The `sync_items` rules call `auth.uid()` directly, which Supabase runs once per row. Change them to `(select auth.uid())`, as `media.sql` already does.
4. **Re-sending everything makes every device download everything again (S).** The trigger only ignores changes that are *older* (`<`), not equal ones. After a sign-out with "forget" and sign-in, the whole account is re-sent, and every other device re-downloads all of it. Change the check to `<=`.
5. **A device with a wrong clock can win every conflict (S).** `updated_at` comes from the device's clock, and a future date wins forever. Fix: the trigger caps it at the server's time plus 1 day.
6. **No account deletion (GDPR) (S).** "Delete my synced data" removes rows and files but not the account itself. Add a `delete_my_account()` function: delete files first (the account's files aren't removed with it), then the account. Data export is already covered by Back up (a JSON file with media).
7. **No backups (S/M).** Free has no automatic backups, and database backups never include Storage files on any plan. The real copies are each user's devices and backup files. Add a "Re-upload everything from this device" button for recovery. After losing the server, devices won't re-send, because they think the server already has their data.
8. **Pausing (S).** Free projects pause after about a week without database activity. Daily use prevents it, but a summer break won't. Fix: a daily GitHub Actions ping (note that GitHub switches scheduled workflows off after 60 days without repository activity), or Pro. The app already explains a paused project.
9. **Pictures deleted too early (S/M).** Device B removes a picture from a card, and `cleanMedia` deletes the file from the account straight away. If device A edits the same card later, its version (still with the picture) wins, but the file is gone for every other device. Fix: wait 30 days before deleting server files.
10. **Deleted rows pile up (M).** A deleted record stays on the server as an empty row (about 240 B each). Deleting a deck leaves one for every review too. Prune empty rows older than 180 days with a monthly pg_cron job. Devices that haven't synced in 180 days must then do a full re-sync, or deleted cards could come back.
11. **Rare missed changes (M).** With 3 or more of one person's devices syncing at once, a device can skip past a change from a transaction that commits late (the change counter `seq` isn't in commit order). Fix: re-read a short overlap window on each pull.
12. **First sync for big accounts (M).** A heavy account is about 210,000 rows: 210 requests of 1,000 rows, several minutes on a phone. It works and shows progress. Later improvement: skip deleted rows on a fresh device.

Checked and fine: the rules on rows and files (each account only reaches its own folder and rows); indexes `(user_id, seq)` and the primary key, which cover every query; `sync-config.js` holds only the publishable key, and I found no other secrets in the code; CORS is open by design (the row rules protect the data).

## Decisions for you (recommended defaults)

1. **Who can join:** keep sign-ups off and add people by hand. *(Default: yes, until items 1–2 are done.)*
2. **Media quota per account:** *(Default: 50 MB; lower it for open sign-ups, 2 GB on Pro.)*
3. **When to go Pro:** *(Default: when the database passes 300 MB, or before you invite more than about 10 regular users or anyone importing big Anki decks with audio.)*
4. **Review history:** *(Default: keep all of it. Warn on big Anki history imports.)*

## Detailed numbers

**Server cost per row** (data + table + indexes, measured): basic card 568 B, Anki-style card 743 B, cloze 901 B, picture card 613 B, sound card 614 B, schedule 612 B (about 810 B with update churn), review 529 B, Play answer 608 B, Anki review 530 B, deck 441 B, deleted row 239 B. The two indexes take about 155 B per row (random IDs leave index pages about 70% full). JSON data: basic 261 B, cloze 537 B, schedule 241 B, review 198 B. On the network: about 330–650 B per row, about 3–5x smaller compressed.

**Review history per year** at 530 B a review: 30/day → 11k rows → 5.8 MB; 150/day → 55k → 29 MB; 500/day → 183k → 97 MB; 1,000/day → 194 MB.

**Pictures** (quality 0.82): 1280px gave 46–251 KB (photos 150–251, diagrams 134–160, slide 181); 2048px gave 262–543 KB.

**Sounds** (mp3): 1.5 s gave 6 / 12 / 24 KB at 32 / 64 / 128 kbps; 4 s gave 16 / 31 / 63 KB; 60 s at 128 kbps gave 938 KB.

**Sources** (all read 2026-10-17):
- [Supabase pricing](https://supabase.com/pricing): Free 500 MB database / 1 GB storage / 5 GB egress / 50k MAU / 50 MB file / 2 projects / no backups; Pro $25, 8 GB / 100 GB / 250 GB / 100k MAU, $0.125 per extra database GB, $0.09 per extra egress GB; unlimited API requests.
- [Database size](https://supabase.com/docs/guides/platform/database-size): Free goes read-only above 500 MB.
- [File limits](https://supabase.com/docs/guides/storage/uploads/file-limits): 50 MB Free, 500 GB Pro.
- [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits): 2 emails an hour; 30 sign-ups or resets per 5 minutes per IP; 150 sign-ins per 5 minutes.
- [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp): built-in email sends only to team members.
- [Pausing](https://supabase.com/docs/guides/platform/free-project-pausing): 7-day window. The page says a project can be restored for 1 year, but a [June 2024 changelog](https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days) says 90 days.
- [Backups](https://supabase.com/docs/guides/platform/backups): Pro keeps 7 days; Storage files are never included.
- [Compute](https://supabase.com/docs/guides/platform/compute-and-disk): Free is Nano (0.5 GB RAM).

### Critical Files for Implementation
- /home/user/study-sprint/supabase/setup.sql
- /home/user/study-sprint/supabase/media.sql
- /home/user/study-sprint/js/sync.js
- /home/user/study-sprint/js/db.js
- /home/user/study-sprint/js/media.js
