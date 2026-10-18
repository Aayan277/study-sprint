# Setting up sync (Supabase)

Sync keeps your decks, cards, schedules, review history and study settings the same on every device.
It uses a free Supabase project that belongs to you. Anyone can make an account on it (each account only
ever sees its own data), so it also needs a few protections. This takes about an hour, once. Steps 1 to 4
are the basics; steps 5 to 9 are what makes it safe to let other people in.

**Already set up before an update?** Do steps 2, 2b and 2c again, **in that order** (they are safe to repeat and lose nothing: run
`setup.sql`, then `media.sql`, then `limits.sql`), then steps 3 to 9. The newest changes (exact space totals, lower defaults, the
version check) are listed under "SQL changes log" at the bottom. Step 8e (a read-only login for the GitHub jobs) is optional.

What you'll need: a Supabase account (free), a new Gmail account just for this app (free), a free Cloudflare
account, and your GitHub repository for this app.

## 1. Create the project

1. Go to [supabase.com](https://supabase.com) and sign up (signing in with GitHub is easiest).
2. Click **New project**.
   - **Name:** `study-sprint`
   - **Database password:** click *Generate*, and save it somewhere safe. The app doesn't need it.
   - **Region:** the one closest to you.
   - Plan: **Free**.
3. Wait a minute or two while it sets up.

## 2. Create the sync table

1. In the left sidebar, open **SQL Editor** and click **New query**.
2. Paste in everything from [`supabase/setup.sql`](../supabase/setup.sql).
3. Click **Run**. You should see *Success. No rows returned*.

This makes one table, and turns on rules so every account can only ever read or change its own data.
(Running it again is how an older project gets the newer rules: faster checks, ignoring a re-sent copy of the
same change, and not letting a device with a wrong clock win every conflict.)

## 2b. Storage for pictures and sounds

Pictures and sounds on cards sync through Supabase Storage. Run one more script, the same way as step 2:

1. **SQL Editor → New query**, paste in everything from [`supabase/media.sql`](../supabase/media.sql), and click **Run**.

It makes a private bucket called `media`, with one folder per account; every account can only see its own
pictures and sounds. Each file can be at most 3 MB. (Until this is done, everything else still syncs: Settings → Sync shows a note.)

**If you set this up before sounds were added to the app, run it once more.** The older copy of the script only
allowed pictures, so Supabase turns sounds away until you do (pictures keep syncing meanwhile, and Settings → Sync
says "Sounds can't sync yet"). Nothing is lost: the sounds wait on your device. The steps are the same as above:

1. Open your project on supabase.com, then **SQL Editor → New query**.
2. Paste in everything from the latest [`supabase/media.sql`](../supabase/media.sql) and click **Run**. It is safe to run again; it doesn't touch your pictures or any data.
3. In Study Sprint, open Settings → Sync and tap **Sync now**. The note goes away and the sounds are sent.

Each sound can be up to 1 MB (the app skips bigger ones when you import an Anki deck and tells you how many).

## 2c. Limits and "Delete my account"

Because anyone can join, one account must not be able to fill the whole project. Run a third script, the same way:

1. **SQL Editor → New query**, paste in everything from [`supabase/limits.sql`](../supabase/limits.sql), and click **Run**.

The three scripts go **in this order**: `setup.sql`, then `media.sql`, then `limits.sql`. `media.sql` puts back the plain
picture rules, so **whenever you run `media.sql` again, run `limits.sql` again straight after it**. All of them are safe
to run again on a project that already has an older copy: nothing is deleted, and your own settings are kept
(see "SQL changes log" at the bottom for what each version changed).

> **Read this if anyone can sign up.** The free plan has 1 GB of files and a 500 MB database for the whole
> project, and when either is full the project stops working for everybody. Out of the box each account may
> use **50 MB of pictures and sounds** and **40 MB of synced data**, and the project as a whole stops taking
> new pictures at 900 MB and new data at **300 MB**. The data ceiling is that low on purpose: the app counts
> about 500 bytes per record, but what Postgres really stores is 1.1 to 1.6 times that (plus indexes and the
> sign-in tables), so 300 MB counted is about 350 to 500 MB of the free 500 MB. Seven people at full size fill the
> data ceiling. Give more space by hand to the people you know (below).

It adds:

- **Space for pictures and sounds: 50 MB per account.** A new picture or sound is accepted only if it fits.
  When an account is full, its new pictures and sounds wait on the person's device and **everything else keeps
  syncing**. The app tells them. (Supabase's own check often doesn't know a file's size yet. Then the per-person check is only "is the account
  under its limit?", which can let one file of up to 3 MB go over; the exact total, kept by the database, catches it on the next upload.
  The project-wide ceiling assumes the full 3 MB in that case.)
- **Space for synced data (cards, reviews, settings): 40 MB per account.** Going over is refused, and the app
  keeps the changes on the device and says so. Deleting is always allowed.
- **Project-wide ceilings** (table `global_limits`: 900 MB of files, 300 MB of data). The totals are kept **exact**
  in a private table (`private.usage_totals`): every added, changed or deleted record or file adds or takes off its
  bytes in the same moment, and one that would pass the ceiling is refused on the spot, even when many people sync at
  once. When one is hit, everybody's new files or data wait, and the app says "The sync server is full
  right now. Everything is safe on this device and will sync when there's room." On the Pro plan, raise them.
- **3 MB per file** and **64 KB per card or other record**. Every record must be a JSON object (or a "deleted" marker): anything else is refused.
- The checks live in their own `private` schema so they can't be called from outside the app's rules. Please don't add `private` to the API's "Exposed schemas" in the Supabase settings.
- A **usage line** in the app (Settings → Your data → *In your account: …*).
- The **Delete my account** button in Settings → Sync (it needs this script). The app deletes the person's pictures and sounds
  first, through Supabase Storage, then asks the server to delete the account. If any files are left the server answers
  `media_left` and changes nothing (deleting file records with SQL would leave the files themselves behind, still using up space).
  **Delete my synced data** deletes the person's records (their bytes are given back to the project total) and their files through Storage.
- Only signed-in people can touch the tables, and only what the app needs: nothing for visitors who aren't signed in, and nobody can
  truncate a table. The only thing a visitor can call is `app_config()` (next section).

**Existing people.** Running the new script lowers the defaults and the data ceiling **only if they are still the old ones**
(180 MB / 80 MB / 420 MB). The 420 MB data ceiling is lowered to 300 MB only when the data stored today is under 280 MB
(otherwise lowering it would refuse everybody's new data at once): **before running the new `limits.sql`, run this in the SQL Editor:
`select round(coalesce(sum(bytes),0)/1048576.0,1) as sync_used_mb from public.sync_usage;` If it is over 300, free space first or expect the ceiling to stay at 420 MB**, and the status table at the bottom of `limits.sql` says so.
A default or ceiling you changed yourself is left alone, and anyone with their own row in the
`quotas` table keeps their own numbers. (A row that was made long ago just to change one thing still holds the old 180 MB / 80 MB
for the others; look at **Table Editor → quotas** and fix any that should be lower.) People who are over the new limit can still
read, change smaller and delete; they just can't add more until they are under.

**Giving one named person more (or less) space.** Everyone gets the default unless they have a row in the `quotas` table.
The quickest way is one query (change the email and the numbers, which are bytes; this one gives 200 MB of pictures and 100 MB of data):

```sql
insert into public.quotas (user_id, media_bytes_limit, data_bytes_limit)
select id, 209715200, 104857600 from auth.users where email = 'friend@example.com'
on conflict (user_id) do update
  set media_bytes_limit = excluded.media_bytes_limit, data_bytes_limit = excluded.data_bytes_limit
returning user_id;
```

It shows the person's `user_id` when it worked. **If no row comes back, the email was not found** (check for a typo).

Or by hand: open **Authentication → Users** and copy the person's **User UID**, open **Table Editor → quotas → Insert →
Insert row**, paste the UID into `user_id`, type the space in bytes into `media_bytes_limit` and `data_bytes_limit`, and click **Save**.
To go back to the default, delete that row. Useful numbers:

| Space | Bytes |
|---|---|
| 40 MB (the data default) | 41943040 |
| 50 MB (the pictures default) | 52428800 |
| 100 MB | 104857600 |
| 200 MB | 209715200 |
| 500 MB | 524288000 |
| 1 GB | 1073741824 |
| 2 GB (a sensible limit if you move to the Pro plan) | 2147483648 |

Someone's extra space still has to fit inside the project-wide ceilings, so don't hand out more than the project can hold.

**Changing the default for everybody.** For example, to make 30 MB the default for pictures and sounds, run this once in the SQL Editor
(for synced data the function is `default_data_limit()`). Running `limits.sql` again does not undo it:

```sql
create or replace function public.default_media_limit() returns bigint
language sql immutable as 'select 31457280::bigint';
```

**If you move to the Pro plan** ($25 a month: 100 GB of files, 8 GB database), run the line above with `2147483648` to make 2 GB
everyone's new default, and raise the project-wide ceilings in `global_limits` to match your plan (Table Editor → global_limits).
Anyone who has a row in `quotas` keeps their own number.

### Forcing an update: `app_config()`

`limits.sql` also adds a tiny function the app asks when it starts: `app_config()`. It answers `{"min_client": "4.36", "schema": 2}`.
`min_client` is the oldest version of the app that may sync (an older app is asked to update first); `schema` is the SQL version
your project has (the lowest of what `setup.sql`, `media.sql` and `limits.sql` last recorded; 0 means one of them was never run).
A project without the function means "no minimum", so nothing breaks if you never run it. To change the minimum, run (SQL Editor):

```sql
update private.app_config_values set value = '4.40' where key = 'min_client';
```

Running the scripts again never changes that value back. Only raise it to a version that is already released, or people can't sync.

### After running the scripts: check it yourself

Paste these in a new query, one at a time. The status table at the bottom of each script covers most of this already.

1. The pictures-total trigger exists (one row = yes, no row = no):
   `select tgname from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'media_total_track';`
2. The totals match the real sums (both lines should be equal):
   ```sql
   select (select bytes from private.usage_totals where name = 'sync') as sync_total,
          (select coalesce(sum(private.row_bytes(id, data)), 0) from public.sync_items) as sync_real,
          (select bytes from private.usage_totals where name = 'media') as media_total,
          (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects where bucket_id = 'media') as media_real;
   ```
3. **Before** running the new `limits.sql` on a live project: `select round(coalesce(sum(bytes),0)/1048576.0,1) as sync_used_mb from public.sync_usage;`
   should be under 300 (if it is not, the ceiling stays at 420 MB until you free space). After `limits.sql`, `supabase/owner.sql` shows the same totals per person and against the ceilings.
4. The record check covers every stored row (`t` = yes):
   `select convalidated from pg_constraint where conname = 'sync_items_data_object';`
5. After `ci-roles.sql`: `select rolbypassrls from pg_roles where rolname = 'study_sprint_ci';` should say `t`, and
   `select has_table_privilege('study_sprint_ci', 'auth.users', 'select'), has_table_privilege('study_sprint_ci', 'auth.identities', 'select'), has_column_privilege('study_sprint_ci', 'storage.objects', 'metadata', 'select');`
   should say `t, t, t`.

## 3. Let people sign up, with email confirmation

New accounts must prove their email address, so nobody can make accounts with other people's addresses
(or a thousand fake ones).

1. In the sidebar, open **Authentication → Sign In / Providers**.
2. Make sure **Allow new users to sign up** is **on**.
3. Click **Email**. Make sure **Enable Email provider** is on and **Confirm email** is **on**, then click **Save**.
4. While you're there: set **Minimum password length** to `8` and **Password requirements** to **Letters and
   digits** (the app asks for the same: at least 8 characters, with a letter and a number). Click **Save**.

Until step 4 below (your own email service) is done, Supabase's built-in email only reaches people on your
Supabase team and allows 2 emails an hour, so nobody else can confirm their account.

## 4. Send the sign-up emails from a Gmail address

Supabase's built-in email is only for trying things out: it reaches only people on your Supabase team and
sends 2 an hour. To email everybody, Supabase can send through a Gmail account. You need no domain name.

**Trade-offs:** the emails come from a `gmail.com` address, so the first ones may land in the spam folder
(tell new people to check spam), and Gmail sends about 500 emails a day, which is plenty for confirmations and
password resets. If you ever buy a domain, see "Later: your own domain (Resend)" below.

**In Google:**

1. Make a new Gmail account just for this, for example `studysprint.app@gmail.com`. Don't use your own
   address: the app password you create below can send email as the account.
2. Sign in to that account, go to [myaccount.google.com](https://myaccount.google.com) → **Security** and turn on
   **2-Step Verification** (it asks for a phone number). Google only offers app passwords once it is on.
3. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (if the page isn't found,
   search *App passwords* in the search box at the top of your Google account page). Type the name `Supabase`
   and click **Create**. Google shows a password of **16 letters**. Copy it now (spaces don't matter); you can't see it again.

**In Supabase:**

1. Open **Authentication → Emails** and then the **SMTP Settings** tab (on older projects:
   **Project Settings → Authentication → SMTP Settings**).
2. Turn on **Enable custom SMTP**.
3. Fill in:
   - **Sender email address:** the Gmail address, e.g. `studysprint.app@gmail.com`
   - **Sender name:** `Study Sprint`
   - **Host:** `smtp.gmail.com`
   - **Port number:** `465` (if that doesn't work, `587`)
   - **Minimum interval between emails being sent:** leave the default
   - **Username:** the full Gmail address
   - **Password:** the 16-letter app password
4. Click **Save**.
5. Open **Authentication → Rate Limits** and set **Rate limit for sending emails** to something sensible, like
   `60` an hour (Gmail's own limit is about 500 a day). The other limits there (sign-ups per hour from one
   network, and so on) protect you from abuse; the defaults are fine. The app shows people a clear message
   if they hit one.

**Test it:** in the app, make an account with a second email address (not the sender). The confirmation email
should arrive within a minute (check spam the first time). If nothing arrives, check **Authentication → Logs**
in Supabase for the error; a wrong app password is the usual cause.

### Later: your own domain (Resend)

If you buy a domain (about 10 dollars a year), you can send from `no-reply@mail.yourdomain.com` instead, which
lands in the inbox more reliably. Resend's free plan allows 3,000 emails a month. In Resend: **Domains → Add Domain**
(a sub-domain like `mail.yourdomain.com`), add the DNS records it shows at your registrar and click **Verify**,
then **API Keys → Create API Key** ("Sending access") and copy the `re_…` key. In Supabase SMTP Settings use host
`smtp.resend.com`, port `465`, username `resend`, password the `re_…` key, and a sender address on your domain.

## 5. Make the email links open the app

The confirmation link and the "Forgot password?" link in the emails must open Study Sprint:

1. Open **Authentication → URL Configuration**.
2. Set **Site URL** to `https://aayan277.github.io/study-sprint/` and click **Save**.
3. Under **Redirect URLs**, click **Add URL**, add `https://aayan277.github.io/study-sprint/` and save.

(If you ever try the app from your own computer too, add `http://localhost:8123/` as another Redirect URL.)

The confirmation link opens the app and says *Email confirmed*; the person then signs in once with their email
and password. A reset link opens a screen to set a new password.

## 6. Block robots: Cloudflare Turnstile (optional but recommended)

Without it, a robot can make thousands of accounts, and each one is a way to fill your project. Turnstile is
Cloudflare's free "are you a person?" box (it's usually invisible). **Do the steps in this order**, or sign-in
will stop working until the app is updated.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign up (free). In the left menu open **Turnstile**
   (under *Application security* on some accounts), then click **Add widget**.
2. **Widget name:** `Study Sprint`. Under **Hostname Management** click **Add hostnames** and add
   `aayan277.github.io` (just the host name, no `https://` and no path). **Widget Mode:** *Managed*.
   Click **Create**.
3. Copy the **Site Key** and the **Secret Key**.
4. In the app's code, open `js/sync-config.js` and fill in the site key:
   `export const CAPTCHA = { provider: 'turnstile', siteKey: 'PASTE-THE-SITE-KEY' };`
   Commit it and let the site publish (the version of the app people have must update before step 6).
   The site key is public by design. **Never put the secret key in the code.**
5. **Mandatory check, before you touch Supabase:** open the live site (after it has updated, and with a hard
   refresh), go to Settings → Sync, type your email and password and tap **Sign in**. A box should appear and
   you should be signed in a few seconds later: that proves a token comes back from Cloudflare. If the box never
   appears, or you see *"The bot check didn't load"*, **do not go to step 6**: set `siteKey` back to `''`, publish,
   and tell the developer (the check runs in a locked-down frame, and some setups may need a change). Turning on
   step 6 without this check would stop every sign-in, sign-up and password reset.
6. In Supabase open **Authentication → Attack Protection**, turn on **Enable Captcha protection**, choose
   **Cloudflare Turnstile**, paste the **Secret Key**, and click **Save**.

From then on, every sign-up, sign-in and password reset needs the check (Supabase insists on it for all
three), and the app shows it automatically. People who already signed in stay signed in.

If you ever want to switch it off: turn it off in Supabase first, then clear the site key in `sync-config.js`.
Cloudflare Turnstile is the only supported provider; set up and tested with it. (The code still has a hCaptcha path, but it is not
tested or supported: don't use it.)

## 7. Copy two values for the app

Open **Project Settings → API Keys** (on older projects, **Project Settings → API**) and copy:

- **Project URL**, e.g. `https://abcdefgh.supabase.co` (it may also be under **Project Settings → Data API**)
- the **anon public** key (newer projects call it the **publishable** key)

Both are meant to be public: the table rules from step 2 are what protect your data.
**Never** share the `service_role` or **secret** key. The two values go in `js/sync-config.js`
(already filled in for the app's own project).

## 8. Keep the project awake (GitHub)

Free Supabase projects **pause after about 7 days with no use**. Daily use prevents that, but a summer break
won't. The app includes a GitHub job (`.github/workflows/keep-supabase-awake.yml`) that asks the database a
tiny question every day. It needs your two values from step 7 as *secrets* in the GitHub repository:

1. Open the repository on github.com. Click **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**. **Name:** `SUPABASE_URL`, **Secret:** the Project URL. Click **Add secret**.
3. Click **New repository secret** again. **Name:** `SUPABASE_ANON_KEY`, **Secret:** the anon / publishable key. Click **Add secret**.
4. Open the **Actions** tab, click **Keep Supabase awake** in the left list, click **Run workflow → Run workflow**,
   and after a few seconds check the run has a green tick.

GitHub can switch scheduled jobs off after 60 days with no activity in the repository; step 8d is there to stop
that from happening.

## 8b. Back up the database (GitHub)

The free Supabase plan makes **no backups of its own**. If the project were deleted or damaged, everyone's synced
data would be gone (each device still has its own copy, but you would rather not rely on that). The app includes a
GitHub job (`.github/workflows/backup.yml`) that copies the database every night and keeps the last 30 copies.
The copy is **encrypted with a password only you know**, so it is safe even if the repository is public.

**What is saved:** the data of the app (decks, cards, progress, settings, people's limits) and the sign-in accounts.
**What is not saved:** pictures and sounds. They live in Supabase Storage, which this job doesn't copy. They are
still on each person's devices and in their **Export backup** files.

**Good to know:** GitHub can switch scheduled jobs off after 60 days with no activity in the repository. Then
backups stop, and the last copies disappear 30 days later. Step 8d is there to stop that from happening; if it ever
did happen, the Actions tab shows a button to turn the job back on. If the repository is private, the backups use part of its free GitHub storage (a few MB a night is fine).

### Turn it on

1. In Supabase, click **Connect** (top of the page). Under **Session pooler**, copy the **URI**. It looks like
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-….pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` (brackets too) with your **database password** (the one you chose in step 1; if you
   forgot it: **Project Settings → Database → Reset database password**). If the password has symbols such as
   `@`, `#`, `/` or `:` in it, the address breaks. The easy fix is to reset the database password to one made only of
   letters and numbers (long, for example 24 characters). The other way is to write each symbol as `%` plus its code
   (`@` is `%40`).
2. On github.com open the repository, then **Settings → Secrets and variables → Actions → New repository secret**.
   **Name:** `SUPABASE_DB_URL`, **Secret:** the address from step 1. Click **Add secret**.
3. Make up a long password for the backup files (for example four random words), and **save it in your password
   manager**. Without it a backup can't be opened. Click **New repository secret** again. **Name:**
   `BACKUP_PASSPHRASE`, **Secret:** that password. Click **Add secret**.
4. Open the **Actions** tab, click **Back up database**, then **Run workflow → Run workflow**. After a minute or
   two it should show a green tick. Until both secrets exist the job does nothing and still shows a green tick;
   click into the run and it says "No backup made yet". If the address is wrong the run turns red and says what to fix.

### Get a backup and open it

1. **Actions** tab → **Back up database** → click a run (newest first). At the bottom, under **Artifacts**, click
   the file named `study-sprint-db-…`. A zip downloads; open it to get a file ending in `.sql.gz.gpg`.
2. You need the free program **GnuPG** once: on Windows install **Gpg4win** (gpg4win.org), on a Mac install
   **GPG Suite** (gpgtools.org) or run `brew install gnupg`, on Linux it is usually there already.
3. Open a terminal in the folder with the file and type (using the real file name):
   `gpg --decrypt study-sprint-db-2026-01-31.sql.gz.gpg > backup.sql.gz`
   Type the backup password when asked. Then unpack it: on a Mac or Linux type `gunzip backup.sql.gz`; on Windows
   right-click `backup.sql.gz` and use 7-Zip (7-zip.org) → **Extract Here**. You now have `backup.sql`, a plain text
   file of SQL commands.

### Restore it

Only needed if the project was lost or damaged. Everyone's data comes back as of the night of the backup.

**Always restore into a NEW, empty Supabase project, never into the old one.** The reason: every device keeps a
bookmark of what it has already synced, and in an old project it would silently miss changes the restore put
back. In a new project people sign in again, which resets that bookmark, and each device then sends anything newer than the backup.

1. Create the new project and do **all** of the setup in it, in order: [1. Create the project](#1-create-the-project),
   [2. Create the sync table](#2-create-the-sync-table), [2b. Storage for pictures and sounds](#2b-storage-for-pictures-and-sounds),
   [2c. Limits and "Delete my account"](#2c-limits-and-delete-my-account) (run `limits.sql`),
   [3. Let people sign up](#3-let-people-sign-up-with-email-confirmation), [4. Send the sign-up emails from a Gmail address](#4-send-the-sign-up-emails-from-a-gmail-address),
   [5. Make the email links open the app](#5-make-the-email-links-open-the-app) and
   [6. Block robots: Cloudflare Turnstile](#6-block-robots-cloudflare-turnstile-optional-but-recommended). Two cautions:
   - **Skip the "Test it" sign-up in step 4** (or delete that test user afterwards under **Authentication → Users**), so the new project has no users before the restore.
   - **Don't publish the new project's values yet.** Do [7. Copy two values for the app](#7-copy-two-values-for-the-app) only to write the two values down, and put them
     in `js/sync-config.js` (and commit) as the very last thing, after step 5 below. Until then people can't reach the new project by accident.
2. Get the new project's **Session pooler** address as in "Turn it on" step 1 (with its database password in it).
3. In a terminal, in the folder with `backup.sql` (`psql` is part of PostgreSQL, free from postgresql.org), type this as one line,
   with the new address between the quotes at the end:

   `psql -v ON_ERROR_STOP=1 --single-transaction -c "SET session_replication_role = replica" -c "TRUNCATE public.global_limits" -f backup.sql "PASTE-THE-NEW-ADDRESS-HERE"`

   It works the same in Windows PowerShell, Mac and Linux. The `SET` switches off the database's own bookkeeping triggers while the
   data goes in, and `TRUNCATE` clears the default limits that step 2c already put there (the backup has them too).
   The whole thing is one all-or-nothing step: **if anything goes wrong, nothing is changed and you can simply run it again.**
   It should end without any `ERROR`. If it says `permission denied` about `session_replication_role`, run the same
   line **without** the `-c "SET session_replication_role = replica"` part; that works too.
4. Fix the counters. In the new project's **SQL Editor → New query** paste and click **Run**:

   ```sql
   select public.recount_sync_usage();    -- also sets the project's exact data total
   select public.recount_media_usage();   -- and the pictures total (it is 0 in a new project)
   select setval('public.sync_seq', greatest(
     coalesce((select max(seq) from public.sync_items), 0),
     (select last_value from public.sync_seq)) + 1000);
   ```
   Also set the app's minimum version again if you had changed it (the backup doesn't contain it; `limits.sql` made it `4.36`):
   `update private.app_config_values set value = '4.40' where key = 'min_client';`
5. Check it. Run `select count(*) from public.sync_items;` (should be about what the old project had) and
   `select user_id, count(*) from public.sync_items group by user_id order by 2 desc;` (one line per person). In **Authentication → Users** you should see everyone.
   When it looks right, put the new values in `js/sync-config.js` and commit them.
6. Tell people to open the app and sign in again (**Settings → Sync**). Their pictures and sounds come back
   from their own devices.

**Test it once, now.** A backup you have never restored is a guess. Make a second, throwaway free project, do the
steps above in it, check the counts, then delete that project (**Project Settings → General → Delete project**).

## 8c. Get a warning when space runs low (GitHub)

The free plan has hard ceilings, and the app has "fuses" that refuse new data before the ceilings are reached (step 2c:
about 300 MB of synced data, 900 MB of pictures and sounds). When a fuse trips, people just see "server full". This job
(`.github/workflows/fuse-watch.yml`) checks every morning and **opens a GitHub issue when anything is at 80% or more**, so you
hear about it first. GitHub emails you about new issues (check **Watch → Custom → Issues** on the repository if you don't get the email).

**What it checks:** the total of everyone's synced data against its fuse, the total of pictures and sounds against its fuse,
and the size of the whole database against the free plan's 500 MB. It counts the same way the fuses do, so the numbers match.
It only reads. The issue holds **totals only**: no emails, no names, nothing about any one person, so it is safe on a public repository.

### Turn it on

1. Make sure the secret `SUPABASE_DB_URL` exists. It is the same one the backup job uses (step 8b, "Turn it on", points 1 and 2).
   If you haven't made it yet, do those two points now. You don't need `BACKUP_PASSPHRASE` for this.
2. Open the **Actions** tab, click **Watch free-plan space**, then **Run workflow → Run workflow**. After a few seconds
   it should show a green tick. Until the secret exists the job does nothing and still shows a green tick (click into
   the run: "No space check yet"). If the address is wrong the run turns red and says what to fix.
3. That's all. It then runs by itself every day. (Same note as the other jobs: GitHub can switch scheduled jobs off after 60 days
   with no activity in the repository; step 8d is there to stop that.)

### What the issue means

The issue is called **Study Sprint: storage is almost full** and has the label `storage-warning`. There is only ever one:
it is updated each day, not repeated. It shows a small table: what is used, its limit, how full it is.

- **Pictures and sounds near the limit, or data near the limit:** a few people are using most of the shared space. Pick one:
  1. **Give each person less.** Lower the default limits (step 2c has the one-line change for the per-person defaults; backlog item 20 in `PLAN.md`
     explains the sums), and give people you know more with the `quotas` table. To see who uses the most, run
     `supabase/owner.sql` (step 9, "Who uses how much").
  2. **Move to the Pro plan** (backlog item 7). Then raise the two fuses by editing the two rows in **Table Editor → global_limits** (step 2c).
- **Whole database near 500 MB:** the same two choices. Nothing is lost at 500 MB, but Supabase makes the project
  read-only for everybody until you free space or upgrade.

When every total is back under 75%, the job closes the issue by itself with a comment. If it fills again, it opens a new one.

### Downloads ("egress"): look by hand now and then

The free plan also allows **5 GB of downloads a month**. Every time someone signs in on a new device, the device downloads all
their cards and pictures, so a few new phones with big picture decks add up. The database can't tell the job about this number,
so check it yourself, say once a month, and the issue reminds you:
open Supabase, then **Project Settings → Usage**, and look at **Egress** (also called Bandwidth) for the current billing month.
If it is over about 4 GB (80%) with weeks to go, treat it like the limits above: fewer or smaller pictures per person, or the Pro plan.
Going over 5 GB on Free can make the project stop serving until the month rolls over, so it is better to act at 80%.

## 8d. Keep the scheduled jobs switched on (GitHub)

**The problem.** The three jobs above run on a timer. GitHub switches timer jobs **off** after **60 days in a row with no
activity in the repository** (no commits and so on), and only in a **public** repository (in a private one this
doesn't happen). A switched-off job never runs again until somebody turns it on, and nothing breaks loudly: the backups
just stop, and the project can pause. GitHub's own words:
[Disabling and enabling a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

**What is already in place.** The job `.github/workflows/keep-workflows-enabled.yml` ("Keep scheduled jobs on") runs
every Monday. It tells GitHub "enable this workflow" for every job in the repository, itself included, and switches
back on any that GitHub had already turned off. It makes no commits, needs no secrets, and does nothing you can see
when all is well. **You have nothing to set up**, except to check it once:

1. Open the repository on github.com and click the **Actions** tab.
2. Click **Keep scheduled jobs on** in the left list, then **Run workflow → Run workflow**.
3. After a few seconds open the run. A green tick means it works. Its log lists your jobs, each with "Enabled".

**What isn't guaranteed.** GitHub's documentation doesn't say that this call restarts the 60-day clock, and it
doesn't define "activity". This is the usual way people solve this problem, but it isn't promised in writing. So
treat the monthly check below as a backup net, and know the sure fix: **any real change you commit and push to the
repository (even a one-line edit) restarts the 60 days**, so in months when you work on the app you are covered anyway.

**How you would notice a problem.**
- **The real alert is a GitHub issue.** If the backup, the space check or Keep scheduled jobs on fails, its last step
  opens ONE issue called **Study Sprint: a scheduled job failed** (label `scheduled-job-failed`, assigned to you), with
  just the job's name and a link to the run. Every further failure adds a comment, so you get an email each time. Close
  the issue once it is fixed. (Check **Watch → Custom → Issues** on the repository if no email arrives.)
- **GitHub's own failure emails are not reliable for timer jobs.** GitHub sends them to whoever created the job or last
  edited its schedule, and after a job is switched off and on again, to whoever switched it on. For a job that the
  automatic job switched on, that is the GitHub robot, so nobody. Don't rely on them.
- **What the issue can't catch:** a job that GitHub switched off and nobody switched back on doesn't run at all, so it
  can't report anything. That is why you look at the **Actions** tab once a month (step 9) as a backup net: if a job
  says it is disabled, or has had no run for days, click it, then **Enable workflow**, then **Run workflow** on
  **Keep scheduled jobs on**. Supabase also usually emails you before it pauses a free project.
- **If a run log of Keep scheduled jobs on shows "had been switched off"**, GitHub did switch a job off and the weekly
  job rescued it. Then do this once yourself on that job (for example **Back up database**): open it in the **Actions**
  tab, click **Disable workflow**, and then **Enable workflow**. That makes sure the failure emails go to you again.
  (GitHub's documentation doesn't promise a warning email before it switches a job off.)

**Do not** switch Keep scheduled jobs on off by hand. If you ever want one of the others off, use **Disable workflow**
on that job: Keep scheduled jobs on leaves jobs that you switched off yourself alone.

**If you make the repository private** the 60-day rule no longer applies, and this job becomes harmless but unneeded.

## 8e. A read-only login for the GitHub jobs (optional)

The backup and the space check use the secret `SUPABASE_DB_URL`. By default that holds the **postgres** password, which can do
anything to your project. If that secret ever leaked, so would the power to change or delete everything. [`supabase/ci-roles.sql`](../supabase/ci-roles.sql)
makes a second login, `study_sprint_ci`, that can **only read**, and only what the two jobs read: every table in `public` (the
backup), `auth.users` and `auth.identities` (the backup), and the size columns of `storage.objects`, `public.sync_usage`
and `public.global_limits` (the space check). It cannot write, delete, truncate or create anything, and it starts every session read-only.
(It can read your data and the sign-in accounts, because the backup does; so keep the password as private as the old one.)

1. Open `supabase/ci-roles.sql` (copy it somewhere private, not into the repository) and, in the line `declare pw text := 'PASTE-A-LONG-PASSWORD-HERE';`, replace the placeholder with a long password
   you make up (at least 20 letters and digits, no symbols; save it in your password manager). The script refuses the placeholder.
2. **SQL Editor → New query**, paste the whole edited script, **Run**. (Running it again is safe and does not change the password; to change it
   later: `alter role study_sprint_ci password 'new-long-password';`.) Do not commit the edited file anywhere, and **afterwards delete the saved query in the SQL Editor** (it contains the password). The last table the script
   shows should say `ok` on every line; a missing right shows as `NO`.
3. Build the new address from the one in step 8b ("Turn it on", point 1): in the Session pooler URI, change the user from `postgres.abcdefgh`
   to `study_sprint_ci.abcdefgh` (the same project code after the dot) and the password to the new one:
   `postgresql://study_sprint_ci.abcdefgh:THE-NEW-PASSWORD@aws-0-….pooler.supabase.com:5432/postgres`
4. On GitHub: **Settings → Secrets and variables → Actions**, click `SUPABASE_DB_URL`, **Update secret**, paste the new address. Then run
   **Back up database** and **Watch free-plan space** once from the Actions tab (**Run workflow**); both should show a green tick.
5. Optional but wise: now change the database password of the **postgres** user (**Project Settings → Database → Reset database password**), since the
   old one was in GitHub. Nothing else uses it.

To go back, put the postgres address in the secret again. To remove the login: `drop owned by study_sprint_ci; drop role study_sprint_ci;`.
It is only for these two jobs; restoring a backup (step 8b) still needs the postgres login.

## 9. Looking after it

- **Look at the Actions tab once a month.** All jobs should be listed without a "disabled" banner and the last
  runs should be recent (step 8d).
- **Watch the space.** Open **Project Settings → Usage** now and then. The free plan has a 500 MB database
  (the project turns read-only above that), 1 GB of files and 5 GB of downloads a month. Roughly: a light
  user takes 7 MB of database a year, a heavy one 100 MB, and a full 50 MB of pictures and sounds is
  about 300 pictures. Step 8c warns you by itself. See [docs/design/scale-and-backend.md](design/scale-and-backend.md) for the numbers
  and when to move to the Pro plan.
- **Abuse.** To stop new accounts quickly, turn off **Allow new users to sign up** (step 3). Existing people
  keep working. To remove someone, ask them to use **Settings → Sync → Delete my account**. If you must do it
  yourself: first open **Storage → media**, open the folder named with their User UID and delete its files
  (with the Storage screen, not with SQL, so the space is really freed), then delete the user in **Authentication → Users**.
- **Counters look wrong?** Run `select public.recount_sync_usage(); select public.recount_media_usage();` in the SQL Editor. It recounts
  from the stored records and files. **Who uses how much** (below) also shows the two project-wide totals against their ceilings.
- **Who uses how much.** Open **SQL Editor → New query**, paste in everything from [`supabase/owner.sql`](../supabase/owner.sql)
  and click **Run** (after `limits.sql` has been run). You get one line per person: email, number of synced
  records, data space and picture/sound space with each limit and how full it is, biggest users first. It only
  reads, and only you can run it here, so nobody signed in to the app can see it. Check it now and then
  against the totals in **Project Settings → Usage**, and use the `quotas` table (step 2c) to give someone
  more or less space.
- **Tell people:** as the project owner you can see everyone's data in the Table Editor.

## Good to know

- **Project paused?** Open the project in Supabase and click **Restore**. The app keeps working offline meanwhile and catches up afterwards.
- **Forgot your password?** On the Sync sign-in form, type your email and tap **Forgot password?**. Open the link in the email: it opens Study Sprint in your browser, where you set a new one. Then sign in with it on your other devices.
- **Friends:** they open the app, tap **Settings → Sync → Create account**, open the link in the confirmation email, and sign in. Everyone's data stays separate.
- **Delete my account** (Settings → Sync) removes the account, everything stored in it and its pictures from the server (the app deletes the pictures through Supabase Storage first; if some can't be deleted the server refuses with `media_left` and nothing is removed). The device keeps its own copy of the cards. **Delete my synced data** removes the data but keeps the account.
- **Space:** a 2,000-card deck with a year of daily reviews uses about 20–30 MB of the free 500 MB database. Pictures are shrunk to about 100–250 KB each and are stored separately (50 MB per account by default).
- **Very large collections:** at 50,000 cards or more in one account the app says so in plain words (once after an import, and under Settings → Your data). Nothing is blocked; syncing just gets slow, and a new device takes a long time to download everything.
- **Big Anki imports:** the app warns before importing a deck whose pictures and sounds are over 200 MB, or that carries more than 50,000 reviews of history.

## SQL changes log

Every script adds a line to a private table, `private.schema_log` (file, version, time), each time it runs, so you can see what ran:
`select * from private.schema_log order by id;` (SQL Editor). The version below is the same number the app sees as `schema` in `app_config()`.
Always run the files in this order: `setup.sql`, `media.sql`, `limits.sql` (then `ci-roles.sql` if you want it). Each is safe to run again.

- **Version 2 (app 4.36; not yet released: you must run the SQL).** Run `setup.sql`, `media.sql` and `limits.sql` again.
  - *Exact space totals.* The project-wide totals were cached for 60 seconds, so a burst of writes could go far past the ceiling. They are now exact
    (`private.usage_totals`, one row per ceiling) and the check is atomic. They are set from what is really stored the first time (and
    checked again every time) the script runs. Deleting records, deleting an account and deleting files all give their bytes back.
    The old cache table `usage_cache` is removed.
  - *Lower defaults:* 50 MB pictures and sounds, 40 MB data per person (were 180 / 80), and the data ceiling 300 MB (was 420). Only
    defaults that were still the old ones change; custom `quotas` rows and numbers you chose yourself are kept.
  - *Record checks:* `data` must be a JSON object unless the record is deleted, and a record that isn't deleted must have data
    (constraint `sync_items_data_object`; if some old stored row breaks it you get a warning and the note in the script says how to fix it).
  - *Delete my account* no longer deletes file records with SQL; it answers `media_left` until the person's files are gone (the app deletes them first).
  - *Locked down:* nothing for visitors who aren't signed in on the data tables, and no TRUNCATE, TRIGGER or REFERENCES for anyone.
  - *New:* `app_config()` (minimum app version), `private.schema_log`, `supabase/ci-roles.sql` (optional read-only login for the GitHub jobs, step 8e).
  - Each script ends with a small **status table** (every line should say `ok` in the last column). If a line says `NO`, tell whoever helps you;
    for example, `NO` for the trigger on `storage.objects` means that table wouldn't let this account add it, so uploads are checked against a live count instead.
  - For the project-wide pictures ceiling an unknown upload size is treated as 3 MB.
  - The sync ceiling is lowered to 300 MB only when the stored data is under 280 MB (the status table says if it was not).
- **Version 1.** The first limits (per-person limits, 60-second cached totals, `delete_my_account()`).

To check the SQL yourself on your own computer (needs PostgreSQL installed; never touches Supabase): `npm run test:sql`.
