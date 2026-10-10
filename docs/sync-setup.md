# Setting up sync (Supabase)

Sync keeps your decks, cards, schedules, review history and study settings the same on every device.
It uses a free Supabase project that belongs to you. This takes about 10 minutes, once.

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

## 3. Turn off email confirmation

The app signs you in with your email and a password, so Supabase doesn't need to send any emails.
(The free plan can't change its email templates, and its emails contain links that would open Safari
instead of the installed app.)

1. In the sidebar, open **Authentication → Sign In / Providers** and click **Email**.
2. Make sure **Enable Email provider** is on.
3. Turn **Confirm email** **off**, then click **Save**.

## 3b. Let password reset emails open the app

"Forgot password?" in the app has Supabase email a reset link. For that link to open Study Sprint
(and not a page that doesn't exist):

1. Open **Authentication → URL Configuration**.
2. Set **Site URL** to `https://aayan277.github.io/study-sprint/` and click **Save**.
3. Under **Redirect URLs**, click **Add URL**, add `https://aayan277.github.io/study-sprint/` and save.

## 4. Copy two values for the app

Open **Project Settings → API Keys** (on older projects, **Project Settings → API**) and copy:

- **Project URL**, e.g. `https://abcdefgh.supabase.co` (it may also be under **Project Settings → Data API**)
- the **anon public** key (newer projects call it the **publishable** key)

Both are meant to be public: the table rules from step 2 are what protect your data.
**Never** share the `service_role` or **secret** key.

## 5. After you've signed in once

After creating your account in the app (Settings → Sync → Create account), turn off new sign-ups
so nobody else can make an account on your project:
**Authentication → Sign In / Providers → Allow new users to sign up → off**.

You can then sign in with the same email and password on every other device.

## Good to know

- **Free projects pause after 7 days with no use.** If that happens, open the project in Supabase and click **Restore**. The app keeps working offline meanwhile and catches up afterwards.
- **Forgot your password?** On the Sync sign-in form, type your email and tap **Forgot password?**. Open the link in the email: it opens Study Sprint in your browser, where you set a new one. Then sign in with it on your other devices. (Supabase's free email sends only a few emails an hour.)
- **Friends:** each person signs in with their own account and only ever sees their own data. With sign-ups off, add them in **Authentication → Users → Add user → Create new user** (tick **Auto Confirm User**), and give them the email and starting password; they can change it in Settings → Sync. As the project owner, you can see everyone's data in the Table Editor, so tell them.
- **Removing an account:** Settings → Sync → **Delete my synced data** clears what's stored on the server. To remove the account itself, delete the user in **Authentication → Users** (that deletes their synced data too; their devices keep their own copy).
- **Space:** a 2,000-card deck with a year of daily reviews uses about 20–30 MB of the free 500 MB.
