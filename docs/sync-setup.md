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

## 3. Send sign-in codes, not links

The app signs you in with a 6-digit code from your email. Links would open in Safari instead of the installed app.

1. In the sidebar, open **Authentication → Emails** (it may be called *Email Templates*).
2. Edit **both** of these templates, **Confirm signup** and **Magic Link**:
   - **Subject:** `Your Study Sprint code`
   - **Body:**
     ```html
     <h2>Your Study Sprint sign-in code</h2>
     <p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p>
     <p>Type it into Study Sprint. It works for one hour.</p>
     ```
3. Save each one.

## 4. Copy two values for the app

Open **Project Settings → API Keys** (on older projects, **Project Settings → API**) and copy:

- **Project URL**, e.g. `https://abcdefgh.supabase.co` (it may also be under **Project Settings → Data API**)
- the **anon public** key (newer projects call it the **publishable** key)

Both are meant to be public: the table rules from step 2 are what protect your data.
**Never** share the `service_role` or **secret** key.

## 5. After you've signed in once

Turn off new sign-ups so nobody else can make an account on your project:
**Authentication → Sign In / Providers → Allow new users to sign up → off**.

## Good to know

- **Free projects pause after 7 days with no use.** If that happens, open the project in Supabase and click **Restore**. The app keeps working offline meanwhile and catches up afterwards.
- Supabase's built-in email sends only a few emails an hour, which is plenty for signing in on your own devices.
- **Space:** a 2,000-card deck with a year of daily reviews uses about 20–30 MB of the free 500 MB.
