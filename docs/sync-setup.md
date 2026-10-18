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

GitHub switches scheduled jobs off after 60 days with no activity in the repository. If that happens, the
Actions tab shows a button to turn it back on.

## 9. Looking after it

- **Watch the space.** Open **Project Settings → Usage** now and then. The free plan has a 500 MB database
  (the project turns read-only above that), 1 GB of files and 5 GB of downloads a month. Roughly: a light
  user takes 7 MB of database a year, a heavy one 100 MB, and a full 180 MB of pictures and sounds is
  about 1,000 pictures. See [docs/design/scale-and-backend.md](design/scale-and-backend.md) for the numbers
  and when to move to the Pro plan.
- **Abuse.** To stop new accounts quickly, turn off **Allow new users to sign up** (step 3). Existing people
  keep working. To remove someone, ask them to use **Settings → Sync → Delete my account**. If you must do it
  yourself: first open **Storage → media**, open the folder named with their User UID and delete its files,
  then delete the user in **Authentication → Users**.
- **Tell people:** as the project owner you can see everyone's data in the Table Editor.

## Good to know

- **Project paused?** Open the project in Supabase and click **Restore**. The app keeps working offline meanwhile and catches up afterwards.
- **Forgot your password?** On the Sync sign-in form, type your email and tap **Forgot password?**. Open the link in the email: it opens Study Sprint in your browser, where you set a new one. Then sign in with it on your other devices.
- **Friends:** they open the app, tap **Settings → Sync → Create account**, open the link in the confirmation email, and sign in. Everyone's data stays separate.
- **Delete my account** (Settings → Sync) removes the account, everything stored in it and its pictures from the server. The device keeps its own copy of the cards. **Delete my synced data** removes the data but keeps the account.
- **Space:** a 2,000-card deck with a year of daily reviews uses about 20–30 MB of the free 500 MB database. Pictures are shrunk to about 100–250 KB each and are stored separately (180 MB per account).
- **Big Anki imports:** the app warns before importing a deck whose pictures and sounds are over 200 MB, or that carries more than 50,000 reviews of history.
