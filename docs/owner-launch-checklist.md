# Owner launch checklist

Your single to-do list before you invite other people, and for looking after Study Sprint afterwards. Tick each box as you go. The detailed background for every step is in [sync-setup.md](sync-setup.md); this page is the short, ordered version. Supabase and GitHub move their buttons around now and then, so if a name here is slightly different on your screen, look for the closest one.

You do not need to do it all in one sitting. Do the steps **in order**: some depend on the one before.

> Never paste a password, secret key, database address or app password into a chat, an issue or a file in the repository. Secrets go only into Supabase, GitHub Secrets or your password manager.

## 1. Run the SQL

In Supabase: open your project, then **SQL Editor → New query**. For each file below: open it on GitHub (folder `supabase`), copy everything, paste it into the editor, click **Run**. Running a file twice is safe.

- [ ] Run `supabase/setup.sql`.
- [ ] Run `supabase/media.sql`.
- [ ] Run `supabase/limits.sql`.
- [ ] Run any other `.sql` file in the `supabase` folder on the main branch (for example a CI-role file), **whichever exist**. If a file isn't there yet, skip it and come back later.
- [ ] Check the limits exist. Run `select * from public.global_limits;` (you should see rows) and `select public.default_media_limit(), public.default_data_limit();` (you should see two numbers).
- [ ] Check privacy protection is on for every table. Run:
  `select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r';`
  **Every row must say `true`.** If any says `false`, stop and tell the developer.

## 2. Auth settings

In Supabase: **Authentication**.

- [ ] **Sign In / Providers**: **Allow new users to sign up** is **on**.
- [ ] Click **Email**: **Confirm email** is **on**.
- [ ] Same screen: **Minimum password length** is `8` and **Password requirements** is **Letters and digits**. Save.
- [ ] **Secure email change** is **on** (changing an email must be confirmed).
- [ ] **Secure password change** is **on**. Note: this makes Supabase ask for a recent sign-in (or the current password) before a password change. If the app shows an error when someone changes their password, tell the developer: the app then needs to ask the person to sign in again first.
- [ ] **Project Settings → Data API → Exposed schemas**: the list must **not** include `private`. (`public` is fine.)
- [ ] Same page: turn **off** GraphQL if you don't use it (the app doesn't).

## 3. Email

Supabase's built-in email only reaches your own team and is very limited, so you need your own sender.

- [ ] Create a new Gmail account just for Study Sprint (this is also the contact address people will see).
- [ ] In that Google account: turn on **2-Step Verification**.
- [ ] Create an **app password** (Google account → Security → 2-Step Verification → App passwords). Copy it somewhere safe: Google shows it once.
- [ ] In Supabase: **Authentication → Emails → SMTP Settings** (or **Project Settings → Authentication**, depending on your screen). Turn on **Enable custom SMTP** and fill in: host `smtp.gmail.com`, port `465`, username = the Gmail address, password = the app password, sender email = the Gmail address, **sender name** `Study Sprint`. Save.
- [ ] **Rate limits**: set emails per hour to **30 to 60**. Save.
- [ ] **Authentication → Emails → Templates**: open **Confirm signup**. Make the subject say "Study Sprint" (for example "Confirm your Study Sprint account") and add one friendly line, such as "Thanks for trying Study Sprint. One tap and you're in." Keep the confirmation link in the body. Save.
- [ ] Do the same for **Reset password** (for example "Reset your Study Sprint password").
- [ ] **Tell the developer the new email address.** They put it in `js/sync-config.js` (`SITE.contactEmail`) and publish. Until they do, the privacy page and Settings say "Contact: see the project page".

## 4. URL configuration

- [ ] **Authentication → URL Configuration**: **Site URL** is `https://aayan277.github.io/study-sprint/`.
- [ ] **Redirect URLs** contains exactly `https://aayan277.github.io/study-sprint/`. No `localhost`, no `*` wildcards. Remove anything else. Save.

## 5. Turnstile (the bot check): do these in this order

> **The order matters.** If Captcha is switched on in Supabase **before** the site key is published in the app, nobody can sign in or sign up. If that happens, switch Captcha off again in Supabase (step 5.5) and carry on from 5.2.

1. - [ ] Cloudflare (free account) → **Turnstile → Add widget**. Hostname: `aayan277.github.io`. Mode: **Managed**. Create.
2. - [ ] Cloudflare shows two keys. Give the developer the **SITE key** (it is public by design; it goes in `js/sync-config.js` as `CAPTCHA.siteKey`). Keep the **SECRET key** private: it goes only into Supabase in 5.5.
3. - [ ] Wait until the developer says the new version is **published** (the live site shows it at the bottom of Settings).
4. - [ ] Test on the live site: **Settings → Sync**, sign in with an existing account. It should work (you may briefly see the check).
5. - [ ] **Only now:** Supabase → **Authentication → Attack Protection** → enable **Captcha** → provider **Turnstile** → paste the **SECRET** key → Save.
6. - [ ] Test sign-in once more on the live site. It should still work.

## 6. Storage

- [ ] Supabase → **Storage** → the `media` bucket → **Edit bucket** (the settings icon).
- [ ] **Public bucket** is **off**.
- [ ] **File size limit** is `3 MB`.
- [ ] **Allowed MIME types** do **not** contain `image/svg+xml` or `text/html`. (`media.sql` sets safe values; this is only a check.)

## 7. GitHub

On the repository `aayan277/study-sprint`.

- [ ] **Settings → Secrets and variables → Actions → New repository secret**. Add these four (the values are never shown again, so keep them in your password manager):
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_DB_URL`: the Session pooler address from Supabase (see [sync-setup.md step 8b](sync-setup.md#8b-back-up-the-database-github)). If a read-only CI role file (`ci-roles.sql`) exists in `supabase`, use that role's address instead of the main password: it can only read.
  - `BACKUP_PASSPHRASE`: make up a long passphrase and store it in your password manager. **Without it, backups can't be opened.**
- [ ] **Settings → Actions → General → Workflow permissions**: choose **Read repository contents and packages permissions**. Save.
- [ ] Branch protection on `main` (optional): **Settings → Branches → Add branch ruleset**. Block direct pushes but **allow merging pull requests**, because the helper agents merge pull requests. Don't tick anything that would stop a pull request from being merged.
- [ ] Click **Watch → Custom → Issues** at the top of the repository, so the "storage is almost full" and "backup failed" alerts reach your email.
- [ ] **Actions** tab: run each of these once (click the name, then **Run workflow → Run workflow**) and check it ends with a green tick:
  - [ ] Keep Supabase awake
  - [ ] Back up database
  - [ ] Watch free-plan space
  - [ ] Keep scheduled jobs on
- [ ] Check your **other** GitHub repositories (**Settings → Pages** on each). Any that is published appears under `aayan277.github.io/...`. Unpublish the ones you don't need (**Source: None**) until you have your own domain, so nothing else shares this address.

## 8. End-to-end test with a second email

Use an email address that isn't your main one (a second Gmail works).

- [ ] On the live site: **Settings → Sync → Create account**. Check the line "By creating an account you agree to the Terms and Privacy" is there and both links open.
- [ ] Open the confirmation email (**check spam**) and tap the link. It should open Study Sprint.
- [ ] Sign in on a second device (or a private window) and check the cards match.
- [ ] Reset the password: **Forgot password?**, open the email, set a new one, sign in.
- [ ] Add a picture to a card, sync, then **Settings → Sync → Delete my account**.
- [ ] Supabase → **Storage → media**: there must be **no folder left** for that user. Also check **Authentication → Users**: the user is gone. If a folder is left, delete its files by hand and tell the developer.

## 9. Test a restore, once

A backup you've never restored is only a hope.

- [ ] Download a backup (see [Get a backup and open it](sync-setup.md#get-a-backup-and-open-it)).
- [ ] Create a **throwaway** second Supabase project and restore into it, following [Restore it](sync-setup.md#restore-it). Check the counts match.
- [ ] Delete the throwaway project (**Project Settings → General → Delete project**).

## 10. Later: moving to your own domain

Not needed now. When you buy a domain:

- [ ] Buy the domain, then point GitHub Pages at it (**Settings → Pages → Custom domain**, plus the DNS records GitHub shows; tick **Enforce HTTPS**).
- [ ] Supabase: change the **Site URL** and **Redirect URLs** to the new address.
- [ ] Cloudflare Turnstile: add the new hostname to the widget.
- [ ] Ask the developer to check `start_url` and `scope` in `manifest.webmanifest` (they are relative today, so they probably need no change) and the address in `index.html`.
- [ ] Tell existing users: on the old address, **Export backup**, then on the new address **Import backup**, or just sign in to sync. Browser storage doesn't move between addresses.
- [ ] Move email to a sender on your domain (Resend), and update `contactEmail`.

---

## Monthly routine (10 minutes)

- [ ] GitHub **Actions** tab: all four workflows green, none with a "disabled" banner.
- [ ] Supabase **Project Settings → Usage**: database **under 400 MB**, storage **under 800 MB**, egress (downloads) **under 4 GB**. Over any of these, read "Server full" below.
- [ ] Supabase **SQL Editor**: run everything in `supabase/owner.sql` to see the top users.
- [ ] Download one backup and keep it offline (a USB stick or an external drive).

## Giving a friend a bigger allowance

Everyone gets 180 MB of pictures and sounds and 80 MB of synced data unless they have a row in the `quotas` table.

1. Supabase → **Authentication → Users**: copy the person's **User UID**.
2. **Table Editor → quotas → Insert → Insert row**. Paste the UID into `user_id`. Type the space in **bytes**: `media_bytes_limit` (pictures and sounds) and, if you like, `data_bytes_limit` (synced data). Save.
3. Useful numbers: 500 MB = `524288000`, 1 GB = `1073741824`, 2 GB = `2147483648`. To go back to the default, delete the row.

(More detail in [sync-setup.md step 2c](sync-setup.md#2c-limits-and-delete-my-account).)

---

# Runbooks

Short, step by step. Do the steps in order.

## Supabase is paused or down

Signs: people see sync errors, or the dashboard says "Project paused".

1. Open [status.supabase.com](https://status.supabase.com). If there's an outage, wait; nothing is lost. The app keeps working on every device without sync.
2. If your project is **paused** (free projects pause after a week of no activity): open the project in the dashboard and click **Restore project**. Wait a few minutes.
3. Check the **Keep Supabase awake** workflow in the Actions tab. If it's red or disabled, open it and fix it ([sync-setup.md step 8](sync-setup.md#8-keep-the-project-awake-github)).
4. Open Study Sprint → **Settings → Sync → Sync now**. It should catch up by itself.
5. If the project was deleted or can't come back, go to "A user lost data" and "Restore a backup".

## Server full, or a "storage is almost full" issue was opened

1. Open the issue (**Issues** tab, label `storage-warning`). It tells you which total is high.
2. Run `supabase/owner.sql` in the SQL Editor to see who uses the most.
3. Choose one: ask the biggest users to delete old decks (**Settings → Your data**), lower the default limits ([sync-setup.md step 2c](sync-setup.md#2c-limits-and-delete-my-account)), or upgrade to the Pro plan and raise the two rows in **Table Editor → global_limits**.
4. The job closes the issue by itself once every total is under 75%.

## A user lost data

Try these **in this order**, stopping at the first that works.

1. **Re-upload everything from a device that still has the data.** On that device open Study Sprint → **Settings → Sync → Re-upload everything from this device**. Do not sign out or clear anything on it first.
2. **Their Export file.** If they made one (**Settings → Your data → Export backup**), they open **Import backup** with it. Importing replaces what's on that device, then it syncs.
3. **A backup restore.** Last resort: follow "Restore a backup" below. It brings back **everyone's** data as of the night of the backup, so it's only for a lost or damaged project.

## A user asks to delete their data

1. Ask them to do it themselves if they can: **Settings → Sync → Delete my synced data** (keeps the account) or **Delete my account** (removes everything on the server).
2. If they can't: Supabase → **Authentication → Users**, find their email and copy the **User UID**.
3. **Storage → media**, open the folder named with that UID and delete its files.
4. Back in **Authentication → Users**, delete the user. (That removes their synced rows too.)
5. Reply to say it's done and that copies in nightly backups expire within 30 days.

## Restore a backup

Everyone's data comes back as of the night of the backup. **Always restore into a new, empty Supabase project, never the old one.**

1. Follow [sync-setup.md → Restore it](sync-setup.md#restore-it), start to finish. It covers creating the new project, setting it up, loading the backup and checking the counts.
2. Only when the counts look right, ask the developer to put the new project's two values in `js/sync-config.js` and publish.
3. Update Supabase settings in the new project to match steps 2 to 5 of this checklist (Site URL, Turnstile secret, SMTP).
4. Tell people to open Study Sprint and sign in again. Their pictures and sounds come back from their own devices.

## Someone is abusing sign-ups

1. Stop it at once: Supabase → **Authentication → Sign In / Providers** → turn **Allow new users to sign up** **off**. People who already have accounts keep working.
2. Find the accounts: **Authentication → Users**, sort by **Created at**. Look for a run of similar or nonsense emails created close together. Run `supabase/owner.sql` to see which of them stored data.
3. For each one: **Storage → media**, open the folder named with their User UID and delete the files, then delete the user in **Authentication → Users**.
4. Lower the limits so a repeat does less harm ([sync-setup.md step 2c](sync-setup.md#2c-limits-and-delete-my-account)). Check that the Turnstile check is on (step 5).
5. Turn sign-ups back on once things are calm. Check **Project Settings → Usage** the next day.
