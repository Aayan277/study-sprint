# Study Sprint ⚡

A mobile-first flashcard app for university courses. It combines real spaced repetition (FSRS-6, like modern Anki) with timed game rounds for cramming, and your game answers feed the review schedule automatically.

**Use it:** [aayan277.github.io/study-sprint](https://aayan277.github.io/study-sprint/)

<p>
  <img src="docs/screenshots/decks.png" width="200" alt="Deck library with due and new counts">
  <img src="docs/screenshots/review.png" width="200" alt="Review: a card flipped, with Again, Hard, Good and Easy buttons showing the next interval">
  <img src="docs/screenshots/play.png" width="200" alt="Play: Lightning round, pick the term that matches a definition">
  <img src="docs/screenshots/stats.png" width="200" alt="Stats: day streak and retention">
</p>

## Features

- **Decks:** create, rename, recolor and delete decks. Each shows its cards, how many are due and new, and a mastery bar. A deck can have its own new-cards-per-day limit (Edit), inside the overall one.
- **Formatting:** **bold**, *italics* and bullet lists on cards. On a phone, the B / I / • buttons add simple marks (`**bold**`, `*italic*`, `- item`) with a live preview; on a computer, the box shows formatting as you type (Ctrl/⌘+B, Ctrl/⌘+I). Typed answers and Play use the plain text. Anki imports keep bold, italics and lists, and Anki exports turn them back into formatting.
- **Pictures:** one picture on each side of a card (the picture button next to B / I / •). Photos are shrunk automatically (longest side 1280px), shown in Review and Play, synced between devices (Supabase Storage: run `supabase/media.sql`), kept in backups, and brought along by Anki imports and exports.
- **Exam date mode** (Edit deck → Exam date): until the exam, no card in the deck is scheduled past it (cards already scheduled later are brought forward), retention rises to 95% over the last two weeks, and **Exam prep** goes over every card you haven't seen in 3 days, weakest first. A countdown shows on the deck; after the exam it goes back to normal.
- **Export** (a deck's page → Export): save a deck as a spreadsheet (.csv) or an Anki deck (.apkg), with tags. Re-exporting updates the cards in Anki instead of duplicating them.
- **Card list** (each deck's page, or Decks → Browse all cards):
  - Search, filter (new, learning, due, suspended, buried, flags, leeches) and sort (date added, due, most forgotten, hardest, A–Z).
  - Tap a card to edit it, suspend it, bury it until tomorrow, flag it, move it, reset it to new, set its due date, delete it, or see its full history (Card info).
  - Select several cards to do any of these to all of them at once, and add single cards with + Add card.
  - **Tools:** a Duplicates filter (same front, written differently), **Find and replace** across selected cards, and **Tags** to rename or remove a tag everywhere.
  - Suspended and buried cards are left out of Review and Play.
- **Import** (the fastest way in):
  - Paste notes in almost any format: `term - definition`, tabs, `|`, `:`, `=`, commas, numbered or bulleted lists, Notion and markdown tables, **bold** terms, Quizlet exports, or term and definition on separate lines. The format is detected for you.
  - Upload .csv, .tsv, .txt or Excel (.xlsx) files, or load a shared Google Sheet.
  - **Anki decks** (.apkg, from Anki's File → Export, or shared decks from AnkiWeb): old and new Anki formats. Pick one Anki deck or all of them; tags come along, cloze notes become one card per blank, and formatting, images and sounds are left out.
  - **Anki progress:** if the deck was exported with “Include scheduling information”, a switch brings over each card's review history (shown as Anki in Card info and counted in Stats) and rebuilds its due date by replaying those reviews through FSRS. Off, or with no history, cards start as new.
  - Check everything in an editable preview first: fix cells, delete rows, swap front and back, pick columns, and see duplicates flagged.
  - **Make cards with Claude** copies a ready-made prompt with your notes, to paste into Claude.
- **Review:** daily spaced repetition with FSRS-6.
  - Flip a card (tap or Space) or type the answer, then rate it Again / Hard / Good / Easy. Each button shows when the card comes back.
  - Undo, keyboard shortcuts (Space flip, 1–4 rate, E edit, I card info, - bury, @ suspend, R read aloud), and a summary at the end.
  - **Read aloud:** 🔊 (or R) reads the card with your device's voices; each deck picks a language (or works it out from the text) and can read cards out automatically.
  - The ⋯ button opens the card's panel mid-review: edit, flag, suspend, bury, move, reset, set due date, delete or see its info.
  - **Custom study** (on the Review screen): add extra new cards for today, review ahead (cards due in the next day to 2 weeks), or go over the cards you forgot today.
  - **Leeches:** a card you forget 8 times (changeable in Settings) is tagged “leech” and suspended (or just tagged), like Anki.
  - Advanced scheduling in Settings: learning and relearning steps, a maximum interval (handy before exams), spreading due dates onto the least busy days, and **easy days** (Normal / Reduced / Minimum per weekday).
  - **Reviews per day** (optional; no limit by default), overall and per deck.
  - **Per-deck settings** (Edit deck → Study options): a deck can have its own retention, steps, maximum interval, and new and review limits, or use the overall ones.
- **Play:** timed rounds.
  - **Classic** (10/20/40 questions), **Survival** (3 lives, shrinking timer) and **Lightning** (60 seconds).
  - Front → back, back → front, or typing. Definition-style decks start on back → front (read the definition, pick the term), and your own pick is remembered per deck.
  - **Hard** mode (6 lookalike options) and **Flash** (the question vanishes).
  - Streak scoring, an S–D grade and best scores.
  - **Card ⋯** after each answer opens the same card panel (pauses the round).
- **Auto-grading:** a Play answer on a due card counts as its review (fast, normal, slow or wrong becomes Easy, Good, Hard or Again). A miss on any studied card brings it back.
- **Works on phones and computers:** on a computer (1024px and wider) the tabs become a sidebar, lists and Stats use the full width, a card's panel opens beside the card list (1200px+), and Review shows a bigger card with its keyboard shortcuts. Phones keep the bottom tabs and pop-up sheets.
- **Sync** (Settings → Sync): sign in with the same email and password on each device, and your decks, cards, progress, review history and study settings stay the same everywhere. Works offline and catches up when you're back online; the newest change wins, and a delete on one device deletes everywhere. Theme stays per device. Forgot password, change password, sign out (keep or remove this device's copy) and delete your synced data are all in Settings → Sync. Setup: [docs/sync-setup.md](docs/sync-setup.md).
- **Stats:**
  - day streak and retention
  - a study calendar: a year of study days as squares (darker = more answers), with your best streak
  - reviews per day for 30 days, and cards due over the next 7 days
  - hardest cards, with a **Drill these** button
  - answer buttons (how often you press Again / Hard / Good / Easy), the time of day you remember best, and how FSRS difficulty is spread across your cards
  - a mastery grid you can tap card by card
- **Backups:** export everything to one file and restore it on any device (Settings → Your data).
- **Starter decks:** optional JLPT N5 and N4 kanji decks (Decks tab → Starter decks).
- **Themes:** 6 color themes (Ink, Blossom, Sage, Cobalt, Neon, Onyx), most with light and dark versions.
- **Works offline,** installs on your phone, and keeps your data on your device.

## Install it on your phone

1. Open the link above in **Safari** (iPhone) or **Chrome** (Android).
2. iPhone: tap **Share → Add to Home Screen**. Android: tap **⋮ → Install app**.
3. It opens full screen from its own icon and works without internet.

On a computer, open the link in Chrome or Edge and use the install button in the address bar.

## Your data

Everything is saved in your browser (IndexedDB), on your device only. There are no accounts and no servers.

- The home-screen app and a browser tab can have **separate** storage (especially on iPhone), so pick one and stick with it.
- **Export a backup now and then** (Settings → Back up). To move to a new phone or computer, export there and choose **Import backup** on the new device.

## How it's built

Plain HTML, CSS and JavaScript modules. There's no build step, so GitHub Pages serves the files exactly as they are. Libraries come from a CDN at pinned versions: [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) 5.4.2 for scheduling, SheetJS, loaded only when you import an Excel file, and fflate, fzstd and sql.js, loaded only when you import an Anki deck.

| File | What it does |
| --- | --- |
| `index.html` | Page frame: header, screen area, bottom tab bar |
| `css/styles.css` | All styles. The theme colors are at the top |
| `js/app.js` | Starts the app, switches screens, Settings and backups |
| `js/db.js` | Saving and loading (IndexedDB), backup export and restore |
| `js/decks.js` | Deck list, deck page, create/edit/delete, starter decks |
| `js/browse.js`, `js/browse-logic.js` | The card list: search, filters, sorting, and every card action |
| `js/import.js` | Format detection for pasted text, files and sheets |
| `js/import-screen.js` | The Import screen and its preview |
| `js/anki.js` | Turns Anki notes into cards (HTML to text, cloze, decks, tags) |
| `js/anki-read.js` | Opens .apkg files (unzip, decompress, read the SQLite database) |
| `js/sync-data.js` | Sync groundwork: change times, review ids and deleted markers on every save |
| `js/sync.js`, `js/sync-merge.js`, `js/supa.js`, `js/sync-config.js` | Syncing: when to sync, which version wins, the small Supabase client, and which project |
| `js/password.js` | Password rules for new passwords (8+ characters, a letter and a number) |
| `js/export.js` | Exporting a deck as CSV or an Anki deck |
| `js/exam.js` | Exam date mode: limits, pulling cards in, Exam prep |
| `js/format.js`, `js/card-editor.js` | Card formatting: marks ↔ HTML, and the B / I / • editor |
| `js/media.js` | Pictures: shrinking, saving and showing them |
| `js/speech.js` | Reading cards aloud |
| `js/balance.js` | Evening out reviews across days, and easy days |
| `supabase/setup.sql`, `supabase/media.sql`, `docs/sync-setup.md` | Setting up a Supabase project for sync |
| `js/review.js` | The Review screen |
| `js/srs.js` | FSRS-6 scheduling (wraps ts-fsrs) |
| `js/sched-settings.js` | Checking and applying the advanced scheduling settings |
| `js/queue.js`, `js/days.js` | Which cards are due today (a study day starts at 4am) |
| `js/match.js` | Checking typed answers (typos, alternates, articles, spaces) |
| `js/play.js` | The Play screen |
| `js/game.js` | Game rules: scoring, timers, wrong-answer options |
| `js/autograde.js` | Turning Play answers into review ratings |
| `js/stats.js`, `js/stats-calc.js` | The Stats screen and the numbers behind it |
| `js/jlpt.js` | The optional JLPT kanji starter decks |
| `js/themes.js`, `js/sample.js`, `js/ui.js` | Themes, the sample deck, shared helpers |
| `tests/*.test.js` | Tests for every rule above that doesn't need a browser |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installing as an app |

The full plan, including what's planned next, is in [PLAN.md](PLAN.md).

## Running it on your computer

ES modules don't load from a `file://` address, so use a tiny local server:

```
npx http-server -c-1
```

Then open the address it prints.

## Running the tests

```
node --test
```

To run one file, use for example `node tests/import.test.js`. No install is needed: it uses Node's built-in test runner. `package.json` only tells Node the files are modules.
