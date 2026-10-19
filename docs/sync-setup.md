# Setting up sync (Supabase)

Sync keeps your decks, cards, schedules, review history and study settings the same on every device.
It uses a free Supabase project that belongs to you. Anyone can make an account on it (each account only
ever sees its own data), so it also needs a few protections. This takes about an hour, once. Steps 1 to 4
are the basics; steps 5 to 9 are what makes it safe to let other people in.

**Already set up before the limits update?** Do steps 2, 2b and 2c again (they are safe to repeat: run
`setup.sql`, then `media.sql`, then `limits.sql`), then steps 3 to 9.

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

> **Read this if anyone can sign up.** The free plan has 1 GB of files and a 500 MB database for the whole
> project, and when either is full the project stops working for everybody. Out of the box each account may
> use **180 MB of pictures and sounds** and **80 MB of synced data**, and the project as a whole stops taking
> new pictures at 900 MB and new data at 420 MB (so it never reaches the free plan's own limits). Five people
> at full size fill the project. **If you will let strangers in, lower the default first** (one line, below)
> and give more space by hand to the people you know.
> To make 50 MB the default for pictures and sounds, run this once in the SQL Editor (**New query**, paste, **Run**):
>
> ```sql
> create or replace function public.default_media_limit() returns bigint
> language sql immutable as 'select 52428800::bigint';
> ```
>
> (For synced data it is `default_data_limit()`. Running `limits.sql` again does not undo either.)

It adds:

- **Space for pictures and sounds: 180 MB per account.** A new picture or sound is accepted only if it fits.
  When an account is full, its new pictures and sounds wait on the person's device and **everything else keeps
  syncing**. The app tells them. (If Supabase doesn't tell the server a file's size until after it is stored,
  the check falls back to "is the account under its limit", which can let one 3 MB file over.)
- **Space for synced data (cards, reviews, settings): 80 MB per account.** Going over is refused, and the app
  keeps the changes on the device and says so. Deleting is always allowed.
- **Project-wide ceilings** (table `global_limits`: 900 MB of files, 420 MB of data; totals re-counted at most
  once a minute). When one is hit, everybody's new files or data wait, and the app says "The sync server is full
  right now. Everything is safe on this device and will sync when there's room." On the Pro plan, raise them.
- **3 MB per file** and **64 KB per card or other record**.
- The check behind the picture rule lives in its own `private` schema so it can't be called from outside the app's rules. Please don't add `private` to the API's "Exposed schemas" in the Supabase settings.
- A **usage line** in the app (Settings → Your data → *In your account: …*).
- The **Delete my account** button in Settings → Sync (it needs this script).

**Giving one person more (or less) space.** Everyone gets 180 MB unless they have a row in the `quotas` table:

1. Open **Authentication → Users** and copy the person's **User UID**.
2. Open **Table Editor → quotas → Insert → Insert row**. Paste the UID into `user_id`, and type the space in
   **bytes** into `media_bytes_limit` (pictures and sounds) and, if you like, `data_bytes_limit` (synced data,
   default 83886080 = 80 MB). Click **Save**. Useful numbers:

   | Space | Bytes |
   |---|---|
   | 180 MB (the default) | 188743680 |
   | 500 MB | 524288000 |
   | 1 GB | 1073741824 |
   | 2 GB (a sensible limit if you move to the Pro plan) | 2147483648 |

3. To go back to the default, delete that row.

**If you move to the Pro plan** ($25 a month: 100 GB of files, 8 GB database), run this once in the SQL
Editor (**New query**, paste, **Run**) to make 2 GB everyone's new default, and raise the project-wide
ceilings in `global_limits` to match your plan (Table Editor → global_limits):

```sql
create or replace function public.default_media_limit() returns bigint
language sql immutable as 'select 2147483648::bigint';
```

Running `limits.sql` again later does not undo this. (Anyone who has a row in `quotas` keeps their own number.)

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
   select public.recount_sync_usage();
   select setval('public.sync_seq', greatest(
     coalesce((select max(seq) from public.sync_items), 0),
     (select last_value from public.sync_seq)) + 1000);
   ```
5. Check it. Run `select count(*) from public.sync_items;` (should be about what the old project had) and
   `select user_id, count(*) from public.sync_items group by user_id order by 2 desc;` (one line per person). In **Authentication → Users** you should see everyone.
   When it looks right, put the new values in `js/sync-config.js` and commit them.
6. Tell people to open the app and sign in again (**Settings → Sync**). Their pictures and sounds come back
   from their own devices.

**Test it once, now.** A backup you have never restored is a guess. Make a second, throwaway free project, do the
steps above in it, check the counts, then delete that project (**Project Settings → General → Delete project**).

## 8c. Get a warning when space runs low (GitHub)

The free plan has hard ceilings, and the app has "fuses" that refuse new data before the ceilings are reached (step 2c:
about 420 MB of synced data, 900 MB of pictures and sounds). When a fuse trips, people just see "server full". This job
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

## 8e. Make very old copies of the app update (optional, "min_client")

The server can name the oldest version of the app that may sync, in the `app_config()` function (its `min_client` value). A copy older than that looks for an update and, if there is none, shows "Study Sprint needs an update to keep syncing safely" with two buttons: Update now, or Keep using offline (studying works; nothing syncs until the app has updated). If the function does not exist, or the answer is missing or an error, there is no minimum.

Two rules when you raise it:

1. **Deploy the new build first, then raise `min_client`.** If you raise it before the new version is on the website, everyone sees the screen and "Update now" has nothing to update to.
2. **Write it with the same number of digits as the app's version: `'4.40'`, not `'4.4'`.** Versions are compared as numbers part by part, so 4.9 is older than 4.36, and `'4.4'` means "4, then 4", which is older than 4.36 (it would let nearly everyone through). `tests/app-config.test.js` also fails if the app's own version (`APP_VERSION` in `js/app.js`) falls behind the newest release in `PLAN.md`, so a release can't ship with an old number.

## 9. Looking after it

- **Look at the Actions tab once a month.** All jobs should be listed without a "disabled" banner and the last
  runs should be recent (step 8d).
- **Watch the space.** Open **Project Settings → Usage** now and then. The free plan has a 500 MB database
  (the project turns read-only above that), 1 GB of files and 5 GB of downloads a month. Roughly: a light
  user takes 7 MB of database a year, a heavy one 100 MB, and a full 180 MB of pictures and sounds is
  about 1,000 pictures. Step 8c warns you by itself. See [docs/design/scale-and-backend.md](design/scale-and-backend.md) for the numbers
  and when to move to the Pro plan.
- **Abuse.** To stop new accounts quickly, turn off **Allow new users to sign up** (step 3). Existing people
  keep working. To remove someone, ask them to use **Settings → Sync → Delete my account**. If you must do it
  yourself: first open **Storage → media**, open the folder named with their User UID and delete its files,
  then delete the user in **Authentication → Users**.
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
- **Delete my account** (Settings → Sync) removes the account, everything stored in it and its pictures from the server. The device keeps its own copy of the cards. **Delete my synced data** removes the data but keeps the account.
- **Space:** a 2,000-card deck with a year of daily reviews uses about 20–30 MB of the free 500 MB database. Pictures are shrunk to about 100–250 KB each and are stored separately (180 MB per account).
- **Very large collections:** at 50,000 cards or more in one account the app says so in plain words (once after an import, and under Settings → Your data). Nothing is blocked; syncing just gets slow, and a new device takes a long time to download everything.
- **Big Anki imports:** the app warns before importing a deck whose pictures and sounds are over 200 MB, or that carries more than 50,000 reviews of history.
